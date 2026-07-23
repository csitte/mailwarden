import type { Gmail } from "./gmail.js";

/**
 * Snooze is not part of the Gmail API — mailwarden implements it itself.
 * A snoozed thread is archived and tagged with a dated label `MCP/Snoozed/<YYYY-MM-DD>`.
 * `sweepSnoozed` returns due threads to the inbox. Run it on demand, via cron, or a daemon timer.
 */
const PARENT = "MCP/Snoozed";
const datedLabel = (isoDate: string) => `${PARENT}/${isoDate}`;

/**
 * Local calendar date as YYYY-MM-DD — deliberately NOT `toISOString()` (UTC):
 * east of Greenwich a sweep shortly after local midnight would still see
 * yesterday's date and wake today's snoozes hours late.
 */
export const todayIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** True when `s` is a real YYYY-MM-DD calendar date (`2026-99-99` is not). */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; // Date rolls over on overflow
}

/** The YYYY-MM-DD suffix of a dated snooze label, or undefined for anything else. */
function snoozeDate(labelName: string): string | undefined {
  if (!labelName.startsWith(`${PARENT}/`)) return undefined;
  const date = labelName.slice(PARENT.length + 1);
  // Only real dated labels are sweepable — a manual sub-label like
  // `MCP/Snoozed/Archiv` must never be swept (and then deleted).
  return isValidIsoDate(date) ? date : undefined;
}

/**
 * Safety cap on re-list rounds per dated label. listThreadIdsByLabel paginates
 * a full live listing per round, so one round normally drains the label; the
 * cap only guards against a pathological modify/list race.
 */
const MAX_SWEEP_ITERATIONS = 10;

/**
 * A dated snooze label `MCP/Snoozed/<YYYY-MM-DD>` is due when its date is
 * on or before the cutoff (today). ISO date strings compare lexicographically,
 * so a plain `<=` is a valid "due" check. Returns false for non-dated labels.
 */
export function isDue(labelName: string, cutoffIso: string): boolean {
  const date = snoozeDate(labelName);
  return date !== undefined && date <= cutoffIso;
}

export async function snooze(gmail: Gmail, threadId: string, until: string) {
  if (!isValidIsoDate(until)) throw new Error(`Invalid snooze date "${until}" — use YYYY-MM-DD.`);
  const parentId = await gmail.ensureLabel(PARENT);
  const dueId = await gmail.ensureLabel(datedLabel(until));
  await gmail.modifyLabels(threadId, [parentId, dueId], ["INBOX"]);
  return { threadId, snoozedUntil: until };
}

export async function unsnooze(gmail: Gmail, threadId: string) {
  const remove = (await gmail.listLabels())
    .filter((l) => l.name === PARENT || l.name.startsWith(`${PARENT}/`))
    .map((l) => l.id);
  // No UNREAD here (unlike sweepSnoozed): unsnooze is user-initiated, the user
  // is already looking at the thread — no resurface signal needed.
  await gmail.modifyLabels(threadId, ["INBOX"], remove);
  return { threadId, unsnoozed: true };
}

export async function listSnoozed(gmail: Gmail) {
  const labels = await gmail.listLabels();
  const out: { threadId: string; subject: string; snoozedUntil: string }[] = [];
  for (const label of labels) {
    const due = snoozeDate(label.name);
    if (!due) continue;
    for (const threadId of await gmail.listThreadIdsByLabel(label.id)) {
      out.push({ threadId, subject: await gmail.getThreadSubject(threadId), snoozedUntil: due });
    }
  }
  return out.sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil));
}

/** Messages listed per sweep round — the drain loop covers anything beyond it. */
const SWEEP_LIST_CAP = 5000;

export async function sweepSnoozed(gmail: Gmail, today = new Date()) {
  const cutoff = todayIso(today);
  const labels = await gmail.listLabels();
  const parent = labels.find((l) => l.name === PARENT);
  const dueLabels = labels.filter((l) => isDue(l.name, cutoff));

  const woken = new Set<string>();
  const errors: string[] = [];
  let failedCount = 0;
  for (const label of dueLabels) {
    const remove = [label.id, ...(parent ? [parent.id] : [])];
    // listMessageRefs filters by the exact labelIds param (live, not the
    // lag-prone search index); batchModify wakes up to 1000 messages per
    // request instead of one modify per thread. Re-list to confirm the label
    // drained, bounded by MAX_SWEEP_ITERATIONS.
    let drained = false;
    for (let i = 0; i < MAX_SWEEP_ITERATIONS && !drained; i++) {
      const refs = await gmail.listMessageRefs({ labelIds: [label.id], max: SWEEP_LIST_CAP });
      if (refs.length === 0) {
        drained = true;
        break;
      }
      // UNREAD is deliberate: a resurfaced thread is marked unread so it
      // stands out in the inbox again, like Gmail's own snooze highlight.
      const res = await gmail.batchModifyMessages(refs, ["INBOX", "UNREAD"], remove);
      for (const t of res.modifiedThreads) woken.add(t);
      if (res.failed.length > 0) {
        // A failing chunk won't drain — stop this label; it stays for the next
        // sweep instead of burning the iteration budget on repeat failures.
        failedCount += res.failed.reduce((n, f) => n + f.messageIds.length, 0);
        errors.push(...res.failed.map((f) => f.error));
        break;
      }
    }
    // Only delete a label proven empty — a label deleted while messages still
    // carry it would silently lose those snoozes (archived, never resurfaced).
    if (drained) {
      try {
        await gmail.deleteLabel(label.id);
      } catch {
        /* ignore */
      }
    }
  }
  return { date: cutoff, wokenCount: woken.size, woken: [...woken], failedCount, errors };
}

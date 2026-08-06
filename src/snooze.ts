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

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** A local-calendar date `n` days after `from` (midnight-anchored, DST-safe). */
function addDays(from: Date, n: number): Date {
  const r = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * The next occurrence of weekday `target` (0=Sun..6=Sat) STRICTLY after `from`.
 * "Snooze until monday" on a Monday means *next* Monday — you never snooze to now.
 */
function nextWeekday(from: Date, target: number): Date {
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getDay();
  const delta = (target - cur + 7) % 7 || 7;
  return addDays(from, delta);
}

/**
 * Resolve a snooze value to a concrete `YYYY-MM-DD`. Accepts either an explicit
 * ISO date or a natural preset — resolving presets server-side spares the caller
 * date arithmetic (a common source of off-by-one / wrong-timezone snoozes).
 * Presets (case/separator-insensitive): today, tomorrow, weekend (next Saturday),
 * next week (next Monday), a weekday name (monday–sunday, next occurrence), or
 * "in N days". Throws with an actionable message on anything else or a past date.
 */
export function resolveSnoozeDate(input: string, today: Date = new Date()): string {
  const raw = input.trim();
  const cutoff = todayIso(today);

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (!isValidIsoDate(raw)) throw new Error(`Invalid snooze date "${raw}" — use YYYY-MM-DD.`);
    if (raw < cutoff) throw new Error(`Snooze date "${raw}" is in the past — pick today or later.`);
    return raw;
  }

  const norm = raw.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (norm === "today") return todayIso(today);
  if (norm === "tomorrow") return todayIso(addDays(today, 1));
  if (norm === "weekend") return todayIso(nextWeekday(today, 6)); // next Saturday
  if (norm === "next week") return todayIso(nextWeekday(today, 1)); // next Monday
  if (norm in WEEKDAYS) return todayIso(nextWeekday(today, WEEKDAYS[norm]));
  const inDays = norm.match(/^in (\d+) days?$/);
  if (inDays) return todayIso(addDays(today, Number(inDays[1])));

  throw new Error(
    `Invalid snooze value "${raw}" — use a date (YYYY-MM-DD) or a preset: ` +
      `today, tomorrow, weekend, next week, a weekday name (monday–sunday), or "in N days".`,
  );
}

export async function snooze(gmail: Gmail, threadId: string, until: string, today = new Date()) {
  const date = resolveSnoozeDate(until, today);
  const parentId = await gmail.ensureLabel(PARENT);
  const dueId = await gmail.ensureLabel(datedLabel(date));
  await gmail.modifyLabels(threadId, [parentId, dueId], ["INBOX"]);
  return { threadId, snoozedUntil: date };
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

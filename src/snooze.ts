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

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local wall-clock as a sortable `YYYY-MM-DDTHHMM` stamp (minute precision). */
export const localStamp = (d = new Date()) =>
  `${todayIso(d)}T${pad2(d.getHours())}${pad2(d.getMinutes())}`;

/**
 * A snooze key is either a bare date `YYYY-MM-DD` (due any time that day) or a
 * dated timestamp `YYYY-MM-DDTHHMM` (due at that local minute). Both sort
 * lexicographically against a `localStamp` cutoff: a bare date is a prefix of any
 * same-day timestamp, so `<=` treats it as due from the start of that day.
 */
export function isValidSnoozeKey(s: string): boolean {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2})(\d{2}))?$/);
  if (!m || !isValidIsoDate(m[1])) return false;
  if (m[2] === undefined) return true;
  return Number(m[2]) <= 23 && Number(m[3]) <= 59;
}

/** The snooze-key suffix of a snooze label, or undefined for anything else. */
function snoozeKey(labelName: string): string | undefined {
  if (!labelName.startsWith(`${PARENT}/`)) return undefined;
  const key = labelName.slice(PARENT.length + 1);
  // Only real dated labels are sweepable — a manual sub-label like
  // `MCP/Snoozed/Archiv` must never be swept (and then deleted).
  return isValidSnoozeKey(key) ? key : undefined;
}

/** Human form of a snooze key: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. */
function formatSnoozeKey(key: string): string {
  const m = key.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})$/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : key;
}

/**
 * Safety cap on re-list rounds per dated label. listThreadIdsByLabel paginates
 * a full live listing per round, so one round normally drains the label; the
 * cap only guards against a pathological modify/list race.
 */
const MAX_SWEEP_ITERATIONS = 10;

/**
 * A snooze label is due when its key is on or before the cutoff. Keys and the
 * `localStamp` cutoff both sort lexicographically (`YYYY-MM-DD`[`THHMM`]), so a
 * plain `<=` is a valid "due" check for bare-date and timestamped labels alike.
 * Returns false for non-snooze labels.
 */
export function isDue(labelName: string, cutoff: string): boolean {
  const key = snoozeKey(labelName);
  return key !== undefined && key <= cutoff;
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

/** Parse a clock token (`9am`, `9:30pm`, `17:00`, `8`) to 24h {h,m}, or undefined. */
function parseTime(s: string): { h: number; m: number } | undefined {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return undefined;
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = m[3] === "am" ? h % 12 : (h % 12) + 12; // 12am→0, 12pm→12
  } else if (h > 23) {
    return undefined;
  }
  return { h, m: min };
}

const stampKey = (date: string, t: { h: number; m: number }) =>
  `${date}T${pad2(t.h)}${pad2(t.m)}`;

/** Resolve a bare date phrase (no time) to a local-midnight Date, or undefined. */
function resolveDatePreset(phrase: string, today: Date): Date | undefined {
  if (phrase === "today") return addDays(today, 0);
  if (phrase === "tomorrow") return addDays(today, 1);
  if (phrase === "weekend") return nextWeekday(today, 6); // next Saturday
  if (phrase === "next week") return nextWeekday(today, 1); // next Monday
  if (phrase in WEEKDAYS) return nextWeekday(today, WEEKDAYS[phrase]);
  const inDays = phrase.match(/^in (\d+) days?$/);
  if (inDays) return addDays(today, Number(inDays[1]));
  return undefined;
}

/** Peel an optional trailing clock token off a normalized preset phrase. */
function peelTime(norm: string): { phrase: string; time?: { h: number; m: number } } {
  const toks = norm.split(" ");
  if (toks.length >= 2) {
    const last = toks[toks.length - 1];
    // "9 am" / "9:30 pm" arrive as two tokens — try the last two joined first.
    if (last === "am" || last === "pm") {
      const t = parseTime(toks.slice(-2).join(""));
      if (t) return { phrase: toks.slice(0, -2).join(" "), time: t };
    }
    const t = parseTime(last);
    if (t) return { phrase: toks.slice(0, -1).join(" "), time: t };
  }
  return { phrase: norm };
}

/**
 * Resolve a snooze value to a concrete key — a bare date `YYYY-MM-DD` or a dated
 * timestamp `YYYY-MM-DDTHHMM`. Resolving presets and clock times server-side
 * spares the caller date/time arithmetic (a common source of off-by-one and
 * wrong-timezone snoozes). Accepts (case/separator-insensitive):
 *   - an explicit date `2026-06-20`, optionally with a time `2026-06-20 9am` / `…T17:00`;
 *   - a date preset — today, tomorrow, weekend (next Saturday), next week (next Monday),
 *     a weekday name (monday–sunday, next occurrence) — optionally with a trailing
 *     time (`tomorrow 9am`, `monday 8:30`);
 *   - a relative offset `in N days` or `in N hours`.
 * A time is stored to minute precision; the actual wake happens at the next sweep.
 * Throws an actionable error on anything unrecognized or already in the past.
 */
export function resolveSnoozeDate(input: string, today: Date = new Date()): string {
  const raw = input.trim();
  const cutoff = todayIso(today);
  const now = localStamp(today);
  const past = (label: string) =>
    new Error(`Snooze target "${label}" is in the past — pick a later time.`);

  // Explicit date, optionally with a time.
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]\s*(.+))?$/i);
  if (iso) {
    if (!isValidIsoDate(iso[1])) throw new Error(`Invalid snooze date "${iso[1]}" — use YYYY-MM-DD.`);
    if (iso[2] === undefined) {
      if (iso[1] < cutoff) throw past(iso[1]);
      return iso[1];
    }
    const t = parseTime(iso[2].toLowerCase().replace(/\s+/g, ""));
    if (!t) throw new Error(`Invalid time in "${raw}" — use HH:MM or e.g. 9am.`);
    const key = stampKey(iso[1], t);
    if (key < now) throw past(formatSnoozeKey(key));
    return key;
  }

  // A loose date (single-digit month/day, e.g. 2026-2-3) misses the strict ISO
  // regex above; point the user at the zero-padded form rather than letting it
  // fall into the negative-offset guard below (whose "-2" would misfire).
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(raw)) {
    throw new Error(`Invalid snooze date "${raw}" — use zero-padded YYYY-MM-DD (e.g. 2026-06-01).`);
  }

  // Presets carry no signed numbers; ISO dates already returned above, so a
  // leftover "-<digit>" is a negative offset. Reject it — normalization below
  // folds "-" into a space, which would otherwise silently flip "in -1 days"
  // into "in 1 days" (tomorrow) instead of erroring.
  if (/-\d/.test(raw)) {
    throw new Error(`Invalid snooze value "${raw}" — offsets must be positive, e.g. "in 3 days".`);
  }

  const norm = raw.toLowerCase().replace(/[\s_-]+/g, " ").trim();

  // An absurd offset ("in 999999999 days/hours") overflows Date arithmetic into a
  // "NaN…" / year-100000 key that would never come due — silently stranding the
  // archived thread. Validate every resolved key and reject the out-of-range ones.
  const tooFar = () => new Error(`Snooze target "${raw}" is too far in the future.`);

  // "in N hours" resolves relative to the current minute (a timestamped key).
  const inHours = norm.match(/^in (\d+) hours?$/);
  if (inHours) {
    const key = localStamp(new Date(today.getTime() + Number(inHours[1]) * 3600_000));
    if (!isValidSnoozeKey(key)) throw tooFar();
    return key;
  }

  const { phrase, time } = peelTime(norm);
  const base = resolveDatePreset(phrase, today);
  if (base) {
    const key = time ? stampKey(todayIso(base), time) : todayIso(base);
    if (!isValidSnoozeKey(key)) throw tooFar();
    if (time && key < now) throw past(formatSnoozeKey(key));
    return key;
  }

  throw new Error(
    `Invalid snooze value "${raw}" — use a date/time (YYYY-MM-DD, "tomorrow 9am") or a preset: ` +
      `today, tomorrow, weekend, next week, a weekday name (monday–sunday), "in N days", or "in N hours".`,
  );
}

export async function snooze(gmail: Gmail, threadId: string, until: string, today = new Date()) {
  const key = resolveSnoozeDate(until, today);
  const parentId = await gmail.ensureLabel(PARENT);
  const dueId = await gmail.ensureLabel(datedLabel(key));
  await gmail.modifyLabels(threadId, [parentId, dueId], ["INBOX"]);
  return { threadId, snoozedUntil: formatSnoozeKey(key) };
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
  const out: { threadId: string; subject: string; key: string }[] = [];
  for (const label of labels) {
    const key = snoozeKey(label.name);
    if (!key) continue;
    for (const threadId of await gmail.listThreadIdsByLabel(label.id)) {
      out.push({ threadId, subject: await gmail.getThreadSubject(threadId), key });
    }
  }
  // Sort on the raw key (chronological), then present the human-readable form.
  // Codepoint `<`, not localeCompare — same ordering the dueness check relies on.
  return out
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ threadId, subject, key }) => ({ threadId, subject, snoozedUntil: formatSnoozeKey(key) }));
}

/** Messages listed per sweep round — the drain loop covers anything beyond it. */
const SWEEP_LIST_CAP = 5000;

export async function sweepSnoozed(gmail: Gmail, today = new Date()) {
  // Minute-precision cutoff so timestamped snoozes fire at their local time;
  // bare-date labels stay due for the whole day via the prefix-sort rule.
  const cutoff = localStamp(today);
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
  return { date: todayIso(today), wokenCount: woken.size, woken: [...woken], failedCount, errors };
}

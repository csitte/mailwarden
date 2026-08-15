import type { ThreadSummary } from "./gmail.js";
import { ALL_SIGNALS, type Signal } from "./signals.js";

/**
 * Triage digest — a structured overview of a mailbox slice so an agent can
 * *decide* (bulk-archive, snooze, label) instead of scrolling a raw thread list.
 * Built purely from ThreadSummary rows already fetched by `search`, so it adds no
 * API calls of its own and is unit-testable without a mock.
 */

export interface SenderStat {
  /** Lowercased email address (the grouping key), or "(unknown)". */
  sender: string;
  /** Best display name seen for this sender, or "" if only a bare address. */
  name: string;
  count: number;
  unread: number;
  /** Union of the signals this sender's threads carry (see signals.ts), stable order. */
  signals: Signal[];
}

export type SignalCounts = Record<Signal, number>;

export interface LabelStat {
  label: string;
  count: number;
}

export interface AgeBuckets {
  last24h: number;
  last7d: number;
  last30d: number;
  older: number;
  undated: number;
}

export interface Digest {
  sampled: number;
  unread: number;
  withAttachments: number;
  byAge: AgeBuckets;
  /** How many sampled threads carry each signal (a thread can carry several). */
  signals: SignalCounts;
  topSenders: SenderStat[];
  topLabels: LabelStat[];
}

export interface DigestOptions {
  /** Max entries in topSenders / topLabels. */
  topN?: number;
}

/** Split a `From` header into a lowercased address + a best-effort display name. */
export function parseSender(from: string): { email: string; name: string } {
  const m = /<([^>]+)>/.exec(from);
  const email = (m ? m[1] : from).trim().toLowerCase();
  // The display name is whatever precedes the <angle-addr>, unquoted.
  const name = (m ? from.slice(0, m.index) : "").trim().replace(/^"|"$/g, "").trim();
  return { email, name };
}

/** Age bucket of an RFC-2822 `Date` header relative to `now`. Unparseable → "undated". */
export function ageBucket(dateStr: string, now: Date): keyof AgeBuckets {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return "undated";
  const days = (now.getTime() - t) / 86_400_000;
  if (days < 1) return "last24h";
  if (days < 7) return "last7d";
  if (days < 30) return "last30d";
  return "older";
}

/** Friendly display name for a label id: known system/category names, else the user label name. */
export function friendlyLabelName(id: string, nameById: Map<string, string>): string {
  const known: Record<string, string> = {
    CATEGORY_PERSONAL: "Primary",
    CATEGORY_SOCIAL: "Social",
    CATEGORY_PROMOTIONS: "Promotions",
    CATEGORY_UPDATES: "Updates",
    CATEGORY_FORUMS: "Forums",
    IMPORTANT: "Important",
    STARRED: "Starred",
  };
  return known[id] ?? nameById.get(id) ?? id;
}

/** Labels that carry no triage signal here (all rows are inbox/known read-state). */
const SKIP_LABELS = new Set(["INBOX", "UNREAD", "SENT", "DRAFT", "TRASH", "SPAM", "CHAT"]);

export function buildDigest(
  threads: ThreadSummary[],
  labelName: (id: string) => string,
  now: Date,
  opts: DigestOptions = {},
): Digest {
  const topN = opts.topN ?? 10;
  const byAge: AgeBuckets = { last24h: 0, last7d: 0, last30d: 0, older: 0, undated: 0 };
  const senders = new Map<string, { name: string; count: number; unread: number; signals: Set<Signal> }>();
  const signals = Object.fromEntries(ALL_SIGNALS.map((k) => [k, 0])) as SignalCounts;
  const labels = new Map<string, number>();
  let unread = 0;
  let withAttachments = 0;

  for (const t of threads) {
    const isUnread = t.labelIds.includes("UNREAD");
    if (isUnread) unread++;
    if (t.hasAttachments) withAttachments++;
    byAge[ageBucket(t.date, now)]++;
    for (const sig of t.signals) signals[sig]++;

    const { email, name } = parseSender(t.from);
    const key = email || "(unknown)";
    const s = senders.get(key) ?? { name: "", count: 0, unread: 0, signals: new Set<Signal>() };
    s.count++;
    if (isUnread) s.unread++;
    for (const sig of t.signals) s.signals.add(sig);
    if (!s.name && name) s.name = name; // keep the first non-empty display name
    senders.set(key, s);

    for (const id of t.labelIds) {
      if (SKIP_LABELS.has(id)) continue;
      // Count by resolved display name so two ids that render the same (e.g. a
      // user label "Important" and the system IMPORTANT) merge into one row.
      const labelDisplay = labelName(id);
      labels.set(labelDisplay, (labels.get(labelDisplay) ?? 0) + 1);
    }
  }

  const topSenders = [...senders.entries()]
    .map(([sender, v]) => ({
      sender,
      name: v.name,
      count: v.count,
      unread: v.unread,
      signals: ALL_SIGNALS.filter((k) => v.signals.has(k)),
    }))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender))
    .slice(0, topN);

  const topLabels = [...labels.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, topN);

  return { sampled: threads.length, unread, withAttachments, byAge, signals, topSenders, topLabels };
}

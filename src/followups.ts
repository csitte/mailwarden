/**
 * Who is waiting on whom: threads whose last word is yours and has gone unanswered, and
 * threads whose last word is someone else's and is still in the inbox.
 *
 * The decision is made on the LAST message of each thread and on its live labels, never on
 * the search index. The index only proposes candidates: `in:sent` and `in:inbox` are label
 * predicates, and the thread view of a label can lag (see the drift report). So a thread is
 * "waiting on them" only when its newest message carries `SENT` as fetched, and "waiting on
 * me" only when some message still carries `INBOX` and the newest one does not carry `SENT`.
 *
 * Mail a machine wrote is left out of "waiting on me": a newsletter or a no-reply notice
 * does not wait for anyone. That uses the same header signals as `search`; a message whose
 * headers say nothing about it is treated as a person's.
 *
 * Pure, so the classification can be held by tests.
 */

import type { Signal } from "./signals.js";

/** One message of a thread, as far as this classification needs it. */
export interface TailMessage {
  labelIds: string[];
  from: string;
  to: string;
  /** Gmail's internal date in epoch milliseconds; `undefined` when absent. */
  dateMs?: number;
  signals: Signal[];
}

export interface ThreadTail {
  threadId: string;
  subject: string;
  /** Oldest first, as Gmail returns them. */
  messages: TailMessage[];
}

export interface WaitingOnThem {
  threadId: string;
  subject: string;
  /** Who the last message went to. */
  to: string;
  lastSentAt: string;
  daysWaiting: number;
}

export interface WaitingOnMe {
  threadId: string;
  subject: string;
  /** Who wrote the last message. */
  from: string;
  lastReceivedAt: string;
  daysWaiting: number;
  unread: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Labels that make a message not part of the conversation as it stands. */
const NOT_IN_CONVERSATION = new Set(["DRAFT", "TRASH", "SPAM"]);

/** The newest message that is part of the conversation, or undefined. */
function lastMessage(t: ThreadTail): TailMessage | undefined {
  const live = t.messages.filter((m) => !m.labelIds.some((l) => NOT_IN_CONVERSATION.has(l)));
  return live.at(-1);
}

function daysSince(dateMs: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dateMs) / DAY_MS));
}

/**
 * Threads whose last message is yours and at least `nudgeAfterDays` old. Without a date the
 * age cannot be judged, and the thread is left out rather than shown with a made-up one.
 */
export function waitingOnThem(threads: ThreadTail[], now: Date, nudgeAfterDays: number): WaitingOnThem[] {
  const out: WaitingOnThem[] = [];
  for (const t of threads) {
    const last = lastMessage(t);
    if (!last || !last.labelIds.includes("SENT") || last.dateMs === undefined) continue;
    const days = daysSince(last.dateMs, now);
    if (days < nudgeAfterDays) continue;
    out.push({
      threadId: t.threadId,
      subject: t.subject,
      to: last.to,
      lastSentAt: new Date(last.dateMs).toISOString(),
      daysWaiting: days,
    });
  }
  return out.sort((a, b) => b.daysWaiting - a.daysWaiting);
}

/**
 * Threads still in the inbox whose last message came from someone else, and a person
 * rather than a machine by its own headers.
 */
export function waitingOnMe(threads: ThreadTail[], now: Date): WaitingOnMe[] {
  const out: WaitingOnMe[] = [];
  for (const t of threads) {
    if (!t.messages.some((m) => m.labelIds.includes("INBOX"))) continue; // index proposed it, labels say no
    const last = lastMessage(t);
    if (!last || last.labelIds.includes("SENT") || last.dateMs === undefined) continue;
    if (last.signals.includes("newsletter") || last.signals.includes("automated")) continue;
    out.push({
      threadId: t.threadId,
      subject: t.subject,
      from: last.from,
      lastReceivedAt: new Date(last.dateMs).toISOString(),
      daysWaiting: daysSince(last.dateMs, now),
      unread: last.labelIds.includes("UNREAD"),
    });
  }
  return out.sort((a, b) => b.daysWaiting - a.daysWaiting);
}

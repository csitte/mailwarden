/**
 * "What changed since I last looked" — folding Gmail's history records into an answer.
 *
 * **Why this is not a cache.** Every other way to answer that question means keeping a copy of the
 * mailbox and diffing it, which this project does not do. Gmail's own history feed makes the copy
 * unnecessary: the mailbox has a monotonic `historyId`, and asking for everything after a given
 * one is a live call like any other. The only thing that has to persist between calls is that
 * single number, and it persists **in the caller**, not here. mailwarden still stores nothing
 * about the mailbox.
 *
 * **What the feed is, and is not.** It reports mailbox events — a message arrived, a label went on
 * or came off — not the current state of anything. A message that gained and lost `UNREAD` between
 * two calls appears in both lists, and neither entry is wrong: both happened. So this summarises
 * events and never claims to describe how the mailbox looks now; `search` and `get_thread` answer
 * that, live.
 *
 * **The seven-day edge.** Gmail keeps history for about a week and refuses a `startHistoryId`
 * older than it holds. That refusal is the important one to pass on correctly: it does not mean
 * nothing changed, it means the question can no longer be answered incrementally and the caller
 * has to fall back to a search. Reporting it as "no changes" would be the worst possible answer,
 * and it is the one a careless catch produces.
 */

/** One message named by a history record. Ids only — the feed carries no headers. */
export interface HistoryMessage {
  id: string;
  threadId: string;
}

/** A label that went on or came off messages, with how many and which threads. */
export interface HistoryLabelChange {
  labelId: string;
  messages: number;
  threadIds: string[];
}

export interface HistorySummary {
  /** The mailbox's history id after these records — hand it back as `sinceHistoryId` next time. */
  historyId: string;
  /** Messages that arrived in the mailbox. */
  added: HistoryMessage[];
  /** Messages that left it (expunged from the mailbox, not merely trashed). */
  deleted: HistoryMessage[];
  /** Labels applied, busiest first. */
  labelsAdded: HistoryLabelChange[];
  /** Labels removed, busiest first. */
  labelsRemoved: HistoryLabelChange[];
  /** How many history records were folded into this. */
  records: number;
  /** True when the id lists were cut to `limit` — the counts above still describe everything seen. */
  truncated: boolean;
}

/** Minimal shape of Gmail's history records, so the fold is testable without the API types. */
export interface RawHistoryRecord {
  id?: string | null;
  messagesAdded?: { message?: { id?: string | null; threadId?: string | null } | null }[] | null;
  messagesDeleted?: { message?: { id?: string | null; threadId?: string | null } | null }[] | null;
  labelsAdded?:
    | {
        message?: { id?: string | null; threadId?: string | null } | null;
        labelIds?: string[] | null;
      }[]
    | null;
  labelsRemoved?:
    | {
        message?: { id?: string | null; threadId?: string | null } | null;
        labelIds?: string[] | null;
      }[]
    | null;
}

/** How many ids any one list carries back. A quiet week still has to fit in a model's context. */
export const HISTORY_ID_LIMIT = 200;

/**
 * Fold history records into a summary. Pure — no API, no clock, no state.
 *
 * `historyId` is passed in rather than read off the last record: Gmail returns the mailbox's
 * current id alongside the records, and that is the one to resume from. Taking the last record's
 * id instead would re-deliver everything that happened after it on the next call.
 */
export function summarizeHistory(
  records: RawHistoryRecord[],
  historyId: string,
  limit = HISTORY_ID_LIMIT,
): HistorySummary {
  const added = new Map<string, HistoryMessage>();
  const deleted = new Map<string, HistoryMessage>();
  const labelsAdded = new Map<string, Map<string, string>>(); // labelId -> messageId -> threadId
  const labelsRemoved = new Map<string, Map<string, string>>();

  const messageOf = (m?: { id?: string | null; threadId?: string | null } | null) =>
    m?.id ? { id: m.id, threadId: m.threadId ?? "" } : undefined;

  for (const rec of records) {
    for (const e of rec.messagesAdded ?? []) {
      const m = messageOf(e.message);
      if (m) added.set(m.id, m);
    }
    for (const e of rec.messagesDeleted ?? []) {
      const m = messageOf(e.message);
      if (m) deleted.set(m.id, m);
    }
    for (const [src, dst] of [
      [rec.labelsAdded, labelsAdded],
      [rec.labelsRemoved, labelsRemoved],
    ] as const) {
      for (const e of src ?? []) {
        const m = messageOf(e.message);
        if (!m) continue;
        for (const labelId of e.labelIds ?? []) {
          let byMessage = dst.get(labelId);
          if (!byMessage) dst.set(labelId, (byMessage = new Map()));
          byMessage.set(m.id, m.threadId);
        }
      }
    }
  }

  /** Busiest label first: a caller scanning the top of the list sees what moved most. */
  let labelIdsCut = false;
  const foldLabels = (src: Map<string, Map<string, string>>): HistoryLabelChange[] =>
    [...src.entries()]
      .map(([labelId, byMessage]) => {
        const threads = [...new Set(byMessage.values())].filter(Boolean);
        if (threads.length > limit) labelIdsCut = true;
        return { labelId, messages: byMessage.size, threadIds: threads.slice(0, limit) };
      })
      .sort((a, b) => b.messages - a.messages || a.labelId.localeCompare(b.labelId));

  const addedList = [...added.values()];
  const deletedList = [...deleted.values()];
  const labelsAddedList = foldLabels(labelsAdded);
  const labelsRemovedList = foldLabels(labelsRemoved);

  return {
    historyId,
    added: addedList.slice(0, limit),
    deleted: deletedList.slice(0, limit),
    labelsAdded: labelsAddedList,
    labelsRemoved: labelsRemovedList,
    records: records.length,
    // Counts stay complete when a list is cut; only the ids are shortened, and `messages` is
    // what a caller should trust for "how much moved".
    truncated: addedList.length > limit || deletedList.length > limit || labelIdsCut,
  };
}

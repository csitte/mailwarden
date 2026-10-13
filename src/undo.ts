/**
 * The exact inverse of a bulk label change, built from each message's labels as they were
 * read just before the change.
 *
 * Why not simply swap `add` and `remove`: a bulk change is a no-op for every message that
 * was already in the target state, and the swapped call is not. Archive a hundred threads,
 * twenty of which were already archived, and "add INBOX back" puts all hundred in the
 * inbox — twenty of them for the first time. The only inverse that restores the mailbox is
 * one per message: add back what this message lost, remove what this message gained.
 *
 * That needs the state before the write, which is why `bulk_modify` reads it live (one
 * `threads.get` per thread) when asked for an undo, and why the plan is capped: the ids
 * travel through the model context, and a plan for ten thousand messages would flood it.
 *
 * Pure, so the grouping can be held by tests.
 */

/** Largest number of messages an undo plan is built for. */
export const UNDO_LIMIT = 500;

/** One batch of messages that need the same inverse change. */
export interface UndoStep {
  /** Label ids to add back — labels these messages lost. */
  add: string[];
  /** Label ids to take off again — labels these messages gained. */
  remove: string[];
  messageIds: string[];
  /** The threads those messages belong to, for verifying the undo afterwards. */
  threadIds: string[];
}

export interface UndoPlan {
  steps: UndoStep[];
  /**
   * Messages changed without a readable prior state (their thread could not be read
   * before the write). No inverse is guessed for them: a guess is exactly what this
   * module exists to avoid.
   */
  unknown: string[];
}

/**
 * Build the per-message inverse of `add`/`remove` applied to `refs`.
 *
 * `before` maps message id to its label ids before the change. A message that was
 * already in the target state needs no inverse and appears in no step.
 */
export function buildUndo(
  refs: { id: string; threadId: string }[],
  addIds: string[],
  removeIds: string[],
  before: Map<string, string[]>,
): UndoPlan {
  const groups = new Map<string, UndoStep>();
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const labels = before.get(ref.id);
    if (!labels) {
      unknown.push(ref.id);
      continue;
    }
    const had = new Set(labels);
    // Lost: removed by the change and present before. Gained: added and absent before.
    const add = [...new Set(removeIds.filter((l) => had.has(l)))].sort();
    const remove = [...new Set(addIds.filter((l) => !had.has(l)))].sort();
    if (add.length === 0 && remove.length === 0) continue;
    const key = JSON.stringify([add, remove]);
    let step = groups.get(key);
    if (!step) {
      step = { add, remove, messageIds: [], threadIds: [] };
      groups.set(key, step);
    }
    step.messageIds.push(ref.id);
    if (!step.threadIds.includes(ref.threadId)) step.threadIds.push(ref.threadId);
  }
  return { steps: [...groups.values()], unknown };
}

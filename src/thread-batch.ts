/**
 * One label change applied to an explicit list of threads.
 *
 * `bulk_modify` works from a query; what a triage run has after the user's approval is a LIST —
 * "archive exactly these seven" — and that took seven `modify_labels` calls (reported 2026-10-26).
 * This applies one change to up to `MAX_THREAD_IDS` named threads and reports, per thread, what
 * happened, because a list call that fails halfway must not read as all-or-nothing:
 *
 *   - `changed`: the change was applied.
 *   - `failed`: this thread could not be changed (gone, an id typo). The others still ran.
 *   - `notAttempted`: the run stopped before reaching these, because the failure was one that
 *     would hit every remaining thread alike — a rate limit, a dead token, a missing scope. Asking
 *     again for each of them would only repeat the wait (or the refusal) once per thread.
 *
 * Labels are resolved ONCE for the whole list, so a name in `add` is created at most once.
 * Lives outside gmail.ts because it classifies errors (errors.ts imports gmail.ts).
 */

import { ToolError, type ToolErrorCode } from "./cli.js";
import { classifyError, type ToolFailure } from "./errors.js";
import type { Gmail } from "./gmail.js";

export const MAX_THREAD_IDS = 100;
const CONCURRENCY = 8;

/** Failures that would repeat for every remaining thread: stop instead of asking again. */
const SYSTEMIC: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "rate_limited",
  "needs_reauth",
  "not_authorized",
  "insufficient_scope",
  "network_error",
  "upstream_unavailable",
]);

export interface ThreadFailure {
  threadId: string;
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface ThreadBatchResult {
  /** True only when every listed thread was changed. */
  ok: boolean;
  changed: string[];
  failed: ThreadFailure[];
  notAttempted: string[];
}

/**
 * The thread ids a call targets: exactly one of `threadId` or `threadIds`. Duplicates are dropped
 * (first occurrence kept), so a list that names a thread twice changes it once and says so once.
 *
 * @throws ToolError `invalid_input` for neither, both, an empty list or one over the cap.
 */
export function resolveThreadTargets(args: { threadId?: string; threadIds?: string[] }): {
  ids: string[];
  many: boolean;
} {
  const hasOne = args.threadId !== undefined;
  const hasMany = args.threadIds !== undefined;
  if (hasOne === hasMany) {
    throw new ToolError(
      "invalid_input",
      hasOne
        ? "Give threadId OR threadIds, not both."
        : "Give threadId (one thread) or threadIds (a list of up to " + MAX_THREAD_IDS + ").",
    );
  }
  if (hasOne) {
    if (args.threadId!.trim() === "") throw new ToolError("invalid_input", "threadId is empty.");
    return { ids: [args.threadId!], many: false };
  }
  const ids = [...new Set(args.threadIds!.map((s) => s.trim()))];
  if (ids.length === 0 || ids.some((s) => s === "")) {
    throw new ToolError("invalid_input", "threadIds must be a non-empty list of non-empty ids.");
  }
  if (ids.length > MAX_THREAD_IDS) {
    throw new ToolError(
      "invalid_input",
      `threadIds lists ${ids.length} threads; the limit is ${MAX_THREAD_IDS}. Split the list, or use bulk_modify with a query.`,
    );
  }
  return { ids, many: true };
}

/** One thread's outcome, as the runner reports it to `foldOutcomes`. */
export type Outcome = { threadId: string; ok: true } | { threadId: string; ok: false; failure: ToolFailure };

/**
 * Fold per-thread outcomes into the result. Pure. `ids` is the full target list in order; any id
 * without an outcome was not attempted.
 */
export function foldOutcomes(ids: string[], outcomes: Outcome[]): ThreadBatchResult {
  const byId = new Map(outcomes.map((o) => [o.threadId, o]));
  const changed: string[] = [];
  const failed: ThreadFailure[] = [];
  const notAttempted: string[] = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) notAttempted.push(id);
    else if (o.ok) changed.push(id);
    else failed.push({ threadId: id, code: o.failure.code, message: o.failure.message, retryable: o.failure.retryable });
  }
  return { ok: failed.length === 0 && notAttempted.length === 0, changed, failed, notAttempted };
}

/**
 * Apply one label change to every thread in `ids`, in chunks, stopping at the first systemic
 * failure. Label resolution happens first and is NOT caught: if the labels cannot even be
 * resolved, nothing was changed, and the error is the whole answer.
 */
export async function modifyThreads(
  gmail: Gmail,
  ids: string[],
  add: string[],
  remove: string[],
): Promise<ThreadBatchResult> {
  const { addLabelIds, removeLabelIds } = await gmail.resolveLabelIds(add, remove);
  const outcomes: Outcome[] = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((id) => gmail.modifyThreadLabelIds(id, addLabelIds, removeLabelIds)),
    );
    let stop = false;
    settled.forEach((s, j) => {
      if (s.status === "fulfilled") outcomes.push({ threadId: chunk[j], ok: true });
      else {
        const failure = classifyError(s.reason);
        outcomes.push({ threadId: chunk[j], ok: false, failure });
        if (SYSTEMIC.has(failure.code)) stop = true;
      }
    });
    if (stop) break;
  }
  return foldOutcomes(ids, outcomes);
}

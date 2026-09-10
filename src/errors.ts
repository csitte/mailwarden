/**
 * Turning a thrown error into something a client can act on.
 *
 * Tool failures used to arrive as prose: `isError: true` and a sentence. A human
 * reads "authorization has expired" and knows to re-authorize; an agent has to
 * guess from wording that may change with the next commit. So every failure now
 * also carries a code and a `retryable` flag, and the sentence stays for the
 * human — the two are not alternatives.
 *
 * The classification is a pure function of the error, so the whole table is
 * testable against real error shapes without a mailbox.
 */
import { ToolError, type ToolErrorCode } from "./cli.js";
import { isInsufficientScope, isInvalidGrant, isRateLimitError, statusOf } from "./gmail.js";

export interface ToolFailure {
  code: ToolErrorCode;
  message: string;
  /** Whether calling again, unchanged, could plausibly succeed. */
  retryable: boolean;
  /**
   * How long to wait before that retry, when the error says so. Only set for a
   * rate limit, where the wait is the whole remedy and guessing it wrong is the
   * difference between succeeding and giving up.
   */
  retryAfterSeconds?: number;
}

const RETRYABLE_NET = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|aborted|timed? ?out/i;

/** True for the transport-level failures where the request never got an answer. */
function isNetworkError(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e?.code === "string" && RETRYABLE_NET.test(e.code)) return true;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  return typeof e?.message === "string" && RETRYABLE_NET.test(e.message);
}

/**
 * Classify one thrown error.
 *
 * Order matters: a `ToolError` was classified where the failure actually
 * happened and always wins. The rest is read off the error's shape — Google's
 * status code, its scope-specific 403, an OAuth `invalid_grant`, a socket that
 * never answered — and anything left over is `internal_error`, which is the
 * honest answer for "we do not know" and the one worth finding in a log.
 */
export function classifyError(err: unknown): ToolFailure {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }

  const message = err instanceof Error ? err.message : String(err);

  if (isInvalidGrant(err)) {
    return { code: "needs_reauth", message, retryable: false };
  }
  if (isInsufficientScope(err)) {
    return { code: "insufficient_scope", message, retryable: false };
  }
  if (isNetworkError(err)) {
    return { code: "network_error", message, retryable: true };
  }

  // Before the status table: Gmail reports a quota overrun as a 403 as readily
  // as a 429, and the row below would file that as `forbidden_operation` with
  // `retryable: false` — telling a caller to give up on a condition that clears
  // within the minute. Keyed on the reason, so a real permission denial (also a
  // 403) still falls through to that row.
  if (isRateLimitError(err)) {
    return { code: "rate_limited", message, retryable: true, retryAfterSeconds: 60 };
  }

  const status = statusOf(err);
  if (status === 429) return { code: "rate_limited", message, retryable: true, retryAfterSeconds: 60 };
  if (status !== undefined && status >= 500) {
    return { code: "upstream_unavailable", message, retryable: true };
  }
  if (status === 404) return { code: "not_found", message, retryable: false };
  if (status === 403) return { code: "forbidden_operation", message, retryable: false };
  if (status === 400) return { code: "invalid_input", message, retryable: false };

  return { code: "internal_error", message, retryable: false };
}

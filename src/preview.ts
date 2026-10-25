import { createHash, randomBytes } from "node:crypto";

/**
 * Held match sets behind a one-use preview token — the bridge between a `dryRun` and the real call.
 *
 * Without it, a dry run and the write that follows are two separate questions to Gmail's index: the
 * user is shown 312 matches, says yes, and the write re-runs the query and acts on whatever matches
 * by then. Mail that arrived in between is changed without anyone having seen it, and a model that
 * rewords the query between the two calls changes something nobody previewed at all. A token closes
 * both: the preview keeps the exact message set on the server, and the write acts on that set and on
 * nothing else — and only for the very change that was previewed.
 *
 * Process memory, not disk: a held set is a list of message ids for at most `ttlMs`, never message
 * content, so it is not a mailbox mirror; a restart simply invalidates every outstanding token.
 * Pure apart from `randomBytes` — the clock is injected, so expiry is testable without waiting.
 */

export interface PreviewRef {
  id: string;
  threadId: string;
}

/** What a token is bound to: the same query and the same label change, or no write. */
export interface PreviewBinding {
  query: string;
  add: string[];
  remove: string[];
}

export type TakeResult =
  | { ok: true; refs: PreviewRef[]; heldAt: number; capped: boolean }
  | { ok: false; reason: "unknown" | "expired" | "mismatch"; message: string };

/** Thirty minutes: long enough to read a preview and answer, short enough that the set is still recent. */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** Outstanding tokens per process. A model that previews in a loop must not grow memory without bound. */
export const MAX_HELD_PREVIEWS = 20;

/**
 * Order-insensitive, case-insensitive for label names — `["INBOX"]` and `["inbox"]` describe the same
 * change, as the tool treats them. The query is compared exactly after trimming: two queries that
 * differ in a single operator are two different sets.
 */
export function bindingDigest(b: PreviewBinding): string {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort();
  const canonical = JSON.stringify({ q: b.query.trim(), add: norm(b.add), remove: norm(b.remove) });
  return createHash("sha256").update(canonical).digest("hex");
}

interface Held {
  digest: string;
  refs: PreviewRef[];
  heldAt: number;
  capped: boolean;
}

export class PreviewStore {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PREVIEW_TTL_MS,
    private readonly maxHeld: number = MAX_HELD_PREVIEWS,
  ) {}

  /**
   * Keep `refs` for this exact change and return the token that releases them once. `capped` records
   * that the preview stopped at its limit, so the write can say the same about the set it acts on.
   */
  hold(binding: PreviewBinding, refs: PreviewRef[], capped = false): string {
    this.prune();
    // Oldest first out: Map iteration order is insertion order.
    while (this.held.size >= this.maxHeld) this.held.delete(this.held.keys().next().value as string);
    const token = randomBytes(18).toString("base64url");
    this.held.set(token, { digest: bindingDigest(binding), refs: refs.map((r) => ({ ...r })), heldAt: this.now(), capped });
    return token;
  }

  /**
   * Release the held set for `binding`. A token is spent by any attempt that names the right change:
   * success or not, it cannot be replayed. A MISMATCH does not spend it — the caller asked for a
   * different change, which says nothing about the one that was previewed, and the user may still
   * confirm that one.
   */
  take(token: string, binding: PreviewBinding): TakeResult {
    this.prune();
    const entry = this.held.get(token);
    if (!entry) {
      return {
        ok: false,
        reason: "unknown",
        message:
          "This previewToken is unknown: it was already used, it expired, or the server restarted since the preview. Run the dry run again.",
      };
    }
    if (this.now() - entry.heldAt > this.ttlMs) {
      this.held.delete(token);
      return { ok: false, reason: "expired", message: "This previewToken has expired. Run the dry run again." };
    }
    if (entry.digest !== bindingDigest(binding)) {
      return {
        ok: false,
        reason: "mismatch",
        message:
          "This previewToken was issued for a different change: the query, `add` and `remove` must be exactly those of the dry run. Nothing was written.",
      };
    }
    this.held.delete(token);
    return { ok: true, refs: entry.refs, heldAt: entry.heldAt, capped: entry.capped };
  }

  get size(): number {
    this.prune();
    return this.held.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.held) if (t - v.heldAt > this.ttlMs) this.held.delete(k);
  }
}

/**
 * How the mailbox moved between the preview and the write, for the write's report. The write acts on
 * the held set regardless; this only says what that set no longer is: messages that match now and were
 * not shown (`newMatches`, left untouched) and shown messages that no longer match (`noLongerMatching`,
 * changed anyway — they were what the user agreed to). `capped` when the current listing hit its own
 * limit: a held message beyond that page counts as no longer matching and a new one beyond it is not
 * counted, so both numbers are then approximate.
 */
export function previewDrift(
  held: PreviewRef[],
  current: PreviewRef[],
  capped: boolean,
): { newMatches: number; noLongerMatching: number; capped: boolean } {
  const heldIds = new Set(held.map((r) => r.id));
  const currentIds = new Set(current.map((r) => r.id));
  let newMatches = 0;
  for (const id of currentIds) if (!heldIds.has(id)) newMatches++;
  let noLongerMatching = 0;
  for (const id of heldIds) if (!currentIds.has(id)) noLongerMatching++;
  return { newMatches, noLongerMatching, capped };
}

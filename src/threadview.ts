/**
 * Shaping a fetched thread before it is returned: which messages, and how much of each body.
 *
 * Gmail's `threads.get` has no way to ask for part of a thread or for a body without its HTML
 * twin; the whole thread arrives at the same quota cost whatever is kept. What this module
 * decides is therefore the SIZE of the answer, never its price — and it exists because three
 * live deployments reported the same thing in one evening (2026-10-25): a seven-message GitHub
 * thread came back as 67,376 characters, most of it HTML and quoted history, and a weekly report
 * mail had to be read in slices by a helper agent. The reader wanted the last two messages, or
 * the text without the markup. Neither needs a different fetch.
 *
 * Pure, so the selection and trimming rules can be held by tests without a Gmail client.
 */

import { ToolError } from "./cli.js";
import { htmlToText } from "./export.js";
import type { ParsedMessage } from "./gmail.js";
import { stripQuotedHtml, stripQuotedText } from "./quoted.js";

/**
 * How much of each message body to return. `new` is `text` without the quoted history at the
 * end of a reply (see quoted.ts).
 */
export type BodyMode = "full" | "text" | "new" | "none";

export interface MessageSelection {
  /** Keep only the last N messages (after `afterMessageId`, when both are given). */
  lastN?: number;
  /** Keep only the messages that follow this one in thread order; the message itself is dropped. */
  afterMessageId?: string;
}

/**
 * A message with its bodies trimmed by a `BodyMode` other than `full`. `htmlBody` is gone in
 * both; `plaintextBody` survives `text` and is gone in `none`. `bodyFromHtml` marks a text that
 * was reduced from HTML because the message carried no plaintext part — the reader should know
 * that what they see is a rendering, not what the sender typed.
 */
export type TrimmedMessage = Omit<ParsedMessage, "plaintextBody" | "htmlBody"> & {
  plaintextBody?: string;
  bodyFromHtml?: true;
  /** Set by `new` when quoted history was cut off — what is shown is not the whole body. */
  quotedStripped?: true;
};

/**
 * Reject option combinations that cannot all be honoured, before anything is fetched.
 *
 * `full: false` is Gmail's metadata format: no payload parts, so there is no body to trim and no
 * attachment list to keep. Any `bodies` value next to it asks for something that request cannot
 * deliver. It used to be ignored silently, and a caller who asked for `bodies: "text"` got
 * `metadataOnly: true` and no text (reported 2026-10-26). An error is the only answer that cannot
 * be mistaken for the content.
 *
 * @throws ToolError `invalid_input` for `full: false` together with any `bodies`.
 */
export function checkThreadOptions(o: { full?: boolean; bodies?: BodyMode }): void {
  if (o.full === false && o.bodies !== undefined) {
    throw new ToolError(
      "invalid_input",
      `full: false fetches headers and labels only, so bodies: "${o.bodies}" cannot be honoured. ` +
        `Drop full: false (use bodies: "none" for headers plus the real attachment list, at the same quota cost), ` +
        `or drop bodies.`,
    );
  }
}

/**
 * Pick the messages to return. Thread order is Gmail's: oldest first. `afterMessageId` applies
 * first, `lastN` to what remains, so "the last two since the one I already read" composes.
 *
 * @throws ToolError `invalid_input` when `afterMessageId` names a message the thread does not
 *   contain — a silent "all messages" there would hand the caller the very history they asked
 *   to skip, and a silent "nothing" would read as "no news".
 */
export function selectMessages<T extends { id: string }>(
  messages: T[],
  selection: MessageSelection,
): { messages: T[]; omitted: number } {
  let kept = messages;
  if (selection.afterMessageId !== undefined) {
    const at = kept.findIndex((m) => m.id === selection.afterMessageId);
    if (at < 0) {
      throw new ToolError(
        "invalid_input",
        `afterMessageId ${selection.afterMessageId} is not a message of this thread — ` +
          `it has ${messages.length}: ${messages.map((m) => m.id).join(", ")}.`,
      );
    }
    kept = kept.slice(at + 1);
  }
  if (selection.lastN !== undefined && selection.lastN < kept.length) {
    kept = kept.slice(kept.length - selection.lastN);
  }
  return { messages: kept, omitted: messages.length - kept.length };
}

/**
 * Trim one message's bodies. `full` returns the message untouched (same object), so a caller
 * that passes the default pays nothing.
 */
export function trimBodies(message: ParsedMessage, mode: "full"): ParsedMessage;
export function trimBodies(message: ParsedMessage, mode: "text" | "new" | "none"): TrimmedMessage;
export function trimBodies(message: ParsedMessage, mode: BodyMode): ParsedMessage | TrimmedMessage;
export function trimBodies(message: ParsedMessage, mode: BodyMode): ParsedMessage | TrimmedMessage {
  if (mode === "full") return message;
  const { plaintextBody, htmlBody, ...rest } = message;
  if (mode === "none") return rest;
  const fresh = mode === "new";
  if (plaintextBody.trim() !== "") {
    if (!fresh) return { ...rest, plaintextBody };
    const s = stripQuotedText(plaintextBody);
    return s.stripped ? { ...rest, plaintextBody: s.text, quotedStripped: true } : { ...rest, plaintextBody };
  }
  // HTML-only: cut the quote in the markup, where the clients mark it, then render; a `>` block
  // that survives as text (a client that quotes in plain style inside HTML) is cut after.
  const h = fresh ? stripQuotedHtml(htmlBody) : { html: htmlBody, stripped: false };
  let fromHtml = htmlToText(h.html);
  let cut = h.stripped;
  if (fresh) {
    const s = stripQuotedText(fromHtml);
    if (s.stripped) {
      fromHtml = s.text;
      cut = true;
    }
  }
  // An HTML-only mail whose markup reduces to nothing is reported as empty text, not as
  // "no body": the field stays, so the shape does not change with the sender's choices.
  if (fromHtml === "") return { ...rest, plaintextBody: "" };
  return { ...rest, plaintextBody: fromHtml, bodyFromHtml: true, ...(cut ? { quotedStripped: true as const } : {}) };
}

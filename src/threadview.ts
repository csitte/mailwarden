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

/** How much of each message body to return. */
export type BodyMode = "full" | "text" | "none";

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
};

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
export function trimBodies(message: ParsedMessage, mode: "text" | "none"): TrimmedMessage;
export function trimBodies(message: ParsedMessage, mode: BodyMode): ParsedMessage | TrimmedMessage;
export function trimBodies(message: ParsedMessage, mode: BodyMode): ParsedMessage | TrimmedMessage {
  if (mode === "full") return message;
  const { plaintextBody, htmlBody, ...rest } = message;
  if (mode === "none") return rest;
  if (plaintextBody.trim() !== "") return { ...rest, plaintextBody };
  const fromHtml = htmlToText(htmlBody);
  // An HTML-only mail whose markup reduces to nothing is reported as empty text, not as
  // "no body": the field stays, so the shape does not change with the sender's choices.
  return fromHtml === "" ? { ...rest, plaintextBody: "" } : { ...rest, plaintextBody: fromHtml, bodyFromHtml: true };
}

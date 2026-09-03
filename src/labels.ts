/**
 * Label colours: the part that needs no mailbox.
 *
 * Gmail's `Label.color` is two hex strings that must be set together, and Gmail accepts only
 * colours from its own palette — an arbitrary `#123456` comes back as a 400. So there are two
 * questions before a request is worth making, and only one of them has a trustworthy answer here.
 *
 * **What is checked:** the shape (`#rrggbb`) and the pairing. Both are documented, stable, and
 * cheap to get wrong by hand — sending half a colour is the mistake a caller makes first.
 *
 * **What is deliberately NOT checked: membership in the palette.** Two lists of that palette exist
 * and they disagree. Google's `users.labels` reference enumerates 102 values; the constant in
 * `taylorwilsdon/google_workspace_mcp` (read at a5204035 on 2026-09-03) holds 113, and the
 * documented 102 are a strict subset of them — eleven colours are in one list and not the other,
 * among them `#007286` and `#d93025`. One of those lists is wrong and this project cannot tell
 * which without a mailbox to try them in. A hard filter built on the shorter list would refuse
 * colours Gmail accepts; one built on the longer would promise colours Gmail may refuse. Either
 * way the failure is silent from here and lands on the caller.
 *
 * So Gmail decides, because Gmail is the only party that knows: an unpalettable colour comes back
 * as its own 400, and {@link labelColorHint} is what turns that into a sentence naming the cause.
 * The rule this follows is the one the comparison table follows — do not encode a claim about
 * someone else's software that nobody here has verified.
 */
import { ToolError } from "./cli.js";

/** `#rrggbb`, the only shape Gmail's `backgroundColor`/`textColor` take. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Where a caller finds the colours Gmail actually accepts. */
export const PALETTE_DOC =
  "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels";

export interface LabelColor {
  backgroundColor: string;
  textColor: string;
}

/**
 * Appended to Gmail's own rejection so the caller learns *why* a well-formed colour was refused.
 *
 * Gmail answers an off-palette colour with a generic invalid-argument 400, which reads like a bug
 * in the request shape. It is not: the shape was right and the value was not on the list.
 */
export function labelColorHint(): string {
  return (
    `Gmail accepts only colours from its own label palette, so a well-formed hex value can still ` +
    `be refused. The accepted values are listed under Label.color at ${PALETTE_DOC}.`
  );
}

/**
 * Build the `color` object for a label, or `undefined` when no colour was asked for.
 *
 * Hex is normalised to lower case: the palette is documented in lower case and a caller who types
 * `#FB4C2F` means the same colour Gmail lists as `#fb4c2f`. Case is the one difference here that
 * is safe to erase, because hex digits carry no meaning beyond their value.
 *
 * @throws ToolError `invalid_input` when only one half is given, or a half is not `#rrggbb`.
 */
export function resolveLabelColor(
  backgroundColor?: string,
  textColor?: string,
): LabelColor | undefined {
  if (backgroundColor === undefined && textColor === undefined) return undefined;
  if (backgroundColor === undefined || textColor === undefined) {
    throw new ToolError(
      "invalid_input",
      "backgroundColor and textColor must be given together — Gmail rejects a label colour with " +
        "only one half set. " +
        labelColorHint(),
    );
  }
  for (const [field, value] of [
    ["backgroundColor", backgroundColor],
    ["textColor", textColor],
  ] as const) {
    if (!HEX.test(value)) {
      throw new ToolError(
        "invalid_input",
        `${field} must be a hex colour like '#fb4c2f', not '${value}'. ` + labelColorHint(),
      );
    }
  }
  return {
    backgroundColor: backgroundColor.toLowerCase(),
    textColor: textColor.toLowerCase(),
  };
}

/**
 * Whether a label may carry a colour at all.
 *
 * Gmail allows colours only on labels of type `user`; the system labels (INBOX, UNREAD, the
 * CATEGORY_* set) refuse them. Worth answering before the request, because the refusal Gmail
 * sends back does not name this as the reason.
 */
export function canCarryColor(type: string | null | undefined): boolean {
  return type === undefined || type === null || type === "user";
}

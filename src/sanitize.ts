/**
 * Prompt-injection hardening for tool output. Mail content is attacker-supplied
 * text that flows straight into the model's context — two soft defenses apply:
 *
 * 1. Strip characters that can hide or reorder text for the model/UI:
 *    C1 controls, zero-width characters, BiDi overrides/isolates. (C0 controls
 *    never survive JSON.stringify as raw bytes, so they need no handling here.)
 * 2. Wrap every tool result in an `<untrusted-tool-output>` fence so the model
 *    can tell quoted mail content from instructions. Any literal fence tag
 *    inside the content is neutralized first — otherwise a mail could close
 *    the fence early and smuggle text outside it.
 *
 * This is a soft signal, not a guarantee: a model can still be tricked by
 * fenced content. It raises the bar; it does not replace read-then-confirm.
 */

const HIDDEN_CHARS = new RegExp(
  "[" +
    "\\u0080-\\u009F" + // C1 controls
    "\\u200B-\\u200F" + // zero-width space/joiners, LRM/RLM
    "\\u2028\\u2029" + // line / paragraph separator
    "\\u202A-\\u202E" + // BiDi embed/override
    "\\u2060-\\u2064" + // word joiner + invisible operators
    "\\u2066-\\u2069" + // BiDi isolates
    "\\uFEFF" + // BOM / zero-width no-break space
    "]",
  "g",
);

/** Remove invisible/reordering characters an email could use to hide content. */
export function stripHiddenChars(s: string): string {
  return s.replace(HIDDEN_CHARS, "");
}

const FENCE_TAG = "untrusted-tool-output";
const FENCE_BREAKOUT = new RegExp(`<(/?)(${FENCE_TAG})`, "gi");

/**
 * Wrap tool output in an untrusted-content fence. A literal `<untrusted-tool-output`
 * or `</untrusted-tool-output` inside the content is defanged (`<` → `&lt;`) so the
 * fence cannot be closed from inside.
 */
export function fenceOutput(s: string): string {
  const safe = stripHiddenChars(s).replace(FENCE_BREAKOUT, "&lt;$1$2");
  return `<${FENCE_TAG}>\n${safe}\n</${FENCE_TAG}>`;
}

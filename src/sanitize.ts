/**
 * Prompt-injection hardening for tool output. Mail content is attacker-supplied
 * text that flows straight into the model's context — two soft defenses apply:
 *
 * 1. Strip characters that can hide or reorder text for the model/UI:
 *    C1 controls, zero-width characters, BiDi overrides/isolates, and the two
 *    blocks used to smuggle whole ASCII payloads past a human reader (Unicode
 *    tag characters, variation selectors supplement). (C0 controls never survive
 *    JSON.stringify as raw bytes, so they need no handling here.)
 * 2. Wrap every tool result in an `<untrusted-tool-output>` fence so the model
 *    can tell quoted mail content from instructions. Any literal fence tag
 *    inside the content is neutralized first — otherwise a mail could close
 *    the fence early and smuggle text outside it.
 *
 * The rule for (1) is narrow on purpose: **only characters that render as
 * nothing** are removed, so stripping can never change what a human sees. That
 * is why VS15/VS16 (U+FE00-U+FE0F) stay — they carry no text of their own, but
 * they do decide whether a legitimate emoji renders as text or as an emoji.
 *
 * This is a soft signal, not a guarantee: a model can still be tricked by
 * fenced content. It raises the bar; it does not replace read-then-confirm.
 */

const HIDDEN_CHARS = new RegExp(
  "[" +
    "\u00AD" + // soft hyphen
    "\u0080-\u009F" + // C1 controls
    "\u061C" + // Arabic letter mark (BiDi)
    "\u115F\u1160" + // Hangul choseong/jungseong filler
    "\u180E" + // Mongolian vowel separator
    "\u200B-\u200F" + // zero-width space/joiners, LRM/RLM
    "\u2028\u2029" + // line / paragraph separator
    "\u202A-\u202E" + // BiDi embed/override
    "\u2060-\u2064" + // word joiner + invisible operators
    "\u2066-\u2069" + // BiDi isolates
    "\u3164" + // Hangul filler
    "\uFEFF" + // BOM / zero-width no-break space
    "\uFFA0" + // halfwidth Hangul filler
    "\uFFF9-\uFFFB" + // interlinear annotation anchors
    "\u{E0000}-\u{E007F}" + // Unicode tag block — invisible ASCII smuggling
    "\u{E0100}-\u{E01EF}" + // variation selectors supplement
    "]",
  "gu",
);

/** Remove invisible/reordering characters an email could use to hide content. */
export function stripHiddenChars(s: string): string {
  return s.replace(HIDDEN_CHARS, "");
}

/**
 * Deep-strip hidden characters from a structured tool result.
 *
 * `structuredContent` is the machine-readable half of every result and never
 * passes through the text fence, so without this the sanitizer would cover only
 * one of the two copies a client receives — and a client that declares support
 * for `outputSchema` reads the structured one by preference.
 *
 * Values only: no output schema uses attacker-supplied object keys (there is no
 * `z.record` in the tool layer), so keys are server-owned and left untouched.
 */
export function sanitizeStructured<T>(value: T): T {
  if (typeof value === "string") return stripHiddenChars(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeStructured(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeStructured(v);
    return out as T;
  }
  return value;
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

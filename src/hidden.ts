/**
 * How much text an HTML mail keeps from its reader: counted, reported, never removed.
 *
 * A mail can carry text a person never sees in a mail client — in an element styled
 * `display:none`, `visibility:hidden`, `font-size:0`, `opacity:0` or a zero height with overflow
 * hidden, or marked `hidden` — and an AI reader gets it all the same. That is the place to hide
 * instructions meant only for the AI. `hiddenTextLength` says how much of it there is, so a reader
 * of `get_thread` can weigh it.
 *
 * Counted rather than removed, and the reason is measured (24 Nov 2026, 107 HTML mails of one
 * mailbox): a first version removed such elements from the text renderings and took visible text
 * with them. Templates hide blocks inline and show them on a phone through an `@media` rule in their
 * `<style>` block (Google Ads mails: 42 % of the text); a `<p>` ends where a browser ends it, not
 * where its closing tag is; a column's font size comes back through a class. A count that is
 * sometimes too high costs a second look; text removed from what a person sees costs the reader
 * the mail. So nothing here changes what is returned.
 *
 * Not counted: a block that an `@media` rule shows again — a rule whose declarations un-hide
 * (display other than none, a height or max-height, visibility:visible, a font size, an opacity)
 * selecting the block's class or id, `[class=...]` included — together with everything inside it,
 * because such a rule also reaches the block's descendants (`.desktop_hide table`); and a
 * `font-size:0` or `visibility:hidden` element with an inline style, a `font` shorthand or a
 * `<font size>` inside that sets the size or visibility back (an email layout's column wrapper).
 * Not seen: styles from a class outside `@media`, and text coloured like its background. The count
 * is a fact to weigh, not a verdict: a newsletter's preview text ("preheader") is hidden the same way
 * and for an honest reason, usually under 150 characters.
 *
 * Pure, and linear in the length of the body: tags are read once by `tagsOf`.
 */

import { attributesOf, decodeCharacterReferences, shownMarkup, tagsOf, tidyRenderedText, type Tag } from "./export.js";

/** Elements with no content and no closing tag: hiding one hides nothing but itself. */
const VOID_ELEMENTS = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

/** Start tags that end an open `<p>` in a browser: a paragraph cannot hold a block. */
const CLOSES_P = new Set(
  (
    "address article aside blockquote details dialog div dl fieldset figcaption figure footer form " +
    "h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul"
  ).split(" "),
);

/**
 * CSS with its comments removed, an unclosed one running to the end as in a browser. A forward walk:
 * the regex it replaces rescanned to the end at every unclosed `/*`, and 1 MB of them took 89 s
 * (review 24 Nov 2026) in a function every `get_thread` runs.
 */
function withoutComments(css: string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const open = css.indexOf("/*", pos);
    if (open < 0) break;
    out.push(css.slice(pos, open));
    const close = css.indexOf("*/", open + 2);
    if (close < 0) return out.join("");
    pos = close + 2;
  }
  out.push(css.slice(pos));
  return out.join("");
}

/** Declarations of one style attribute or rule body: lower-case, no spaces or comments. */
function declarations(css: string): string[] {
  return withoutComments(css)
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(";");
}

/** The value of the last declaration of `prop` — the one that wins. */
function cssValue(decls: string[], prop: string): string | undefined {
  let value: string | undefined;
  for (const d of decls) {
    const i = d.indexOf(":");
    if (i > 0 && d.slice(0, i) === prop) value = d.slice(i + 1).replace(/!important$/, "");
  }
  return value;
}

/** `0`, `0px`, `0.0em`, `.0`, `0%`: a length or number that is zero. */
function isZero(v: string | undefined): boolean {
  return v !== undefined && /^(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/.test(v);
}

/** The size inside a `font` shorthand (`bold 14px/20px Arial`), or undefined when it names none. */
function shorthandSize(font: string | undefined): string | undefined {
  return font === undefined ? undefined : /(?:^|[^\w.-])((?:\d+(?:\.\d*)?|\.\d+)(?:[a-z]+|%)?)(?=\/|$|[^\w.%])/.exec(font)?.[1];
}

/** Whether declarations set a non-zero font size, by `font-size` or by the `font` shorthand. */
function setsFontSize(decls: string[]): boolean {
  const size = cssValue(decls, "font-size") ?? shorthandSize(cssValue(decls, "font"));
  return size !== undefined && size !== "" && !isZero(size);
}

/**
 * How an element hides its content. `always`: display:none, the `hidden` attribute, opacity:0, or a
 * zero height with overflow hidden — nothing inside can undo those. `font` / `visibility`:
 * font-size:0 and visibility:hidden, which a style inside can set back.
 */
type Hiding = { always: true } | { always: false; font: boolean; visibility: boolean };

function hiding(attrs: Map<string, string>): Hiding | undefined {
  if (attrs.has("hidden")) return { always: true };
  const style = attrs.get("style");
  if (style === undefined) return undefined;
  const css = declarations(style);
  const height = isZero(cssValue(css, "height")) || isZero(cssValue(css, "max-height"));
  const clipped = ["overflow", "overflow-y"].some((p) => cssValue(css, p) === "hidden");
  if (cssValue(css, "display") === "none" || isZero(cssValue(css, "opacity")) || (height && clipped)) {
    return { always: true };
  }
  const v = cssValue(css, "visibility");
  const visibility = v === "hidden" || v === "collapse";
  const font = isZero(cssValue(css, "font-size") ?? shorthandSize(cssValue(css, "font")));
  return visibility || font ? { always: false, font, visibility } : undefined;
}

/** Whether a rule body shows what an inline style hid. */
function unhides(body: string): boolean {
  const d = declarations(body);
  const display = cssValue(d, "display");
  const maxHeight = cssValue(d, "max-height");
  const height = cssValue(d, "height");
  const opacity = cssValue(d, "opacity");
  return (
    (display !== undefined && display !== "none") ||
    (maxHeight !== undefined && !isZero(maxHeight)) ||
    (height !== undefined && !isZero(height)) ||
    cssValue(d, "visibility") === "visible" ||
    (opacity !== undefined && !isZero(opacity)) ||
    setsFontSize(d)
  );
}

/**
 * The class names and ids that an `@media` rule in the mail's `<style>` blocks shows again: from
 * `.name`, `#name` and `[class=name]`-style selectors of rules whose declarations un-hide. A rule
 * only for print is no screen a reader looks at and is skipped.
 */
function shownByMedia(html: string): Set<string> {
  const names = new Set<string>();
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  for (let open = lower.indexOf("<style"); open >= 0; ) {
    const start = lower.indexOf(">", open);
    if (start < 0) break;
    const close = lower.indexOf("</style", start);
    const css = withoutComments(html.slice(start + 1, close < 0 ? html.length : close));
    const cssLower = css.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    for (let at = cssLower.indexOf("@media"); at >= 0; at = cssLower.indexOf("@media", at + 1)) {
      const brace = css.indexOf("{", at);
      if (brace < 0) break;
      const printOnly = /^\s*print\s*$/.test(cssLower.slice(at + 6, brace));
      let depth = 1;
      let i = brace + 1;
      let selector = i;
      let bodyStart = -1;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === "{") {
          if (depth === 1) bodyStart = i + 1;
          depth++;
        } else if (css[i] === "}") {
          depth--;
          if (depth === 1 && bodyStart >= 0 && !printOnly && unhides(css.slice(bodyStart, i))) {
            const sel = css.slice(selector, bodyStart - 1);
            for (const m of sel.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
            for (const m of sel.matchAll(/\[\s*(?:class|id)\s*[~|^$*]?=\s*["']?([^"'\]\s]+)/gi)) names.add(m[1]);
          }
          if (depth === 1) {
            selector = i + 1;
            bodyStart = -1;
          }
        }
      }
      at = i - 1;
    }
    if (close < 0) break;
    open = lower.indexOf("<style", close);
  }
  return names;
}

/** Whether an element's class list or id names something an `@media` rule shows again. */
function shownAgain(attrs: Map<string, string>, shown: Set<string>): boolean {
  const id = attrs.get("id");
  if (id !== undefined && shown.has(id)) return true;
  return (attrs.get("class") ?? "").split(/\s+/).some((c) => c !== "" && shown.has(c));
}

/**
 * Where every element ends (the index after its closing tag), keyed by where it starts, in one
 * pass: a closing tag ends the most recent open element of its name, and a block start tag ends an
 * open `<p>` there, as in a browser. An element with no end found is absent from the map.
 */
function elementEnds(tags: Tag[]): Map<number, number> {
  const open = new Map<string, number[]>();
  const ends = new Map<number, number>();
  for (const t of tags) {
    if (!t.closing && CLOSES_P.has(t.name)) {
      const p = open.get("p");
      if (p !== undefined && p.length > 0) ends.set(p.pop()!, t.start);
    }
    if (VOID_ELEMENTS.has(t.name)) continue;
    let stack = open.get(t.name);
    if (stack === undefined) {
      stack = [];
      open.set(t.name, stack);
    }
    if (!t.closing) stack.push(t.start);
    else if (stack.length > 0) ends.set(stack.pop()!, t.end);
  }
  return ends;
}

/** Whether a sorted list holds a position in `[from, to)`. */
function anyWithin(sorted: number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] < to;
}

/**
 * The text of a stretch of markup: tags out (as `tagsOf` reads them, so a quoted `>` is not text),
 * entities decoded, tidied, invisible characters gone.
 */
function textLength(markup: string): number {
  const parts: string[] = [];
  let pos = 0;
  for (const t of tagsOf(markup)) {
    parts.push(markup.slice(pos, t.start), " ");
    pos = t.end;
  }
  parts.push(markup.slice(pos));
  return tidyRenderedText(decodeCharacterReferences(parts.join(""))).length;
}

/**
 * How many characters of text an HTML body keeps from its reader; 0 for none. See the module
 * comment for what counts and what does not.
 */
export function hiddenTextLength(html: string): number {
  if (html === "") return 0;
  const shown = shownByMedia(html);
  const markup = shownMarkup(html);
  const tags = [...tagsOf(markup)];
  const ends = elementEnds(tags);
  // Where inline styles inside an element set back a hidden size or visibility, by position.
  const fontBack: number[] = [];
  const visibleBack: number[] = [];
  for (const t of tags) {
    if (t.closing) continue;
    if (t.name === "font") {
      const size = attributesOf(t.raw).get("size");
      if (size !== undefined && size.trim() !== "" && !/^[+-]?0*$/.test(size.trim())) fontBack.push(t.start);
    }
    if (!/style/i.test(t.raw)) continue;
    const d = declarations(attributesOf(t.raw).get("style") ?? "");
    if (setsFontSize(d)) fontBack.push(t.start);
    if (cssValue(d, "visibility") === "visible") visibleBack.push(t.start);
  }
  let hidden = 0;
  let skipUntil = 0;
  for (const t of tags) {
    if (t.closing || t.start < skipUntil || VOID_ELEMENTS.has(t.name)) continue;
    // Cheap test first: most tags carry none of these words.
    if (!/hidden|style|class|id/i.test(t.raw)) continue;
    const end = ends.get(t.start);
    if (end === undefined) continue;
    const attrs = attributesOf(t.raw);
    if (shown.size > 0 && shownAgain(attrs, shown)) {
      // What a phone shows, it shows with its content: a rule like `.desktop_hide table` re-shows
      // the hidden tables inside too (a template seen in real mail, 24 Nov 2026).
      skipUntil = end;
      continue;
    }
    const how = hiding(attrs);
    if (how === undefined) continue;
    if (!how.always) {
      const font = !how.font || anyWithin(fontBack, t.end, end);
      const visible = !how.visibility || anyWithin(visibleBack, t.end, end);
      if (font && visible) continue;
    }
    hidden += textLength(markup.slice(t.start, end));
    // Nested hidden elements are inside this one and counted with it.
    skipUntil = end;
  }
  return hidden;
}

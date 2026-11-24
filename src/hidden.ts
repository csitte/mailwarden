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
 * What is not counted: an element whose class or id appears in an `@media` rule (a responsive block
 * a phone shows), and a `font-size:0` or `visibility:hidden` element with an inline style inside it
 * that sets the size or visibility back (an email layout's column wrapper). What is not seen: styles
 * from a class outside `@media`, text coloured like its background, and an element whose closing
 * tag is missing. The count is a fact to weigh, not a verdict: a newsletter's preview text
 * ("preheader") is hidden the same way and for an honest reason, usually under 150 characters.
 *
 * Pure, and linear in the length of the body: every search walks forward once.
 */

import { attributesOf, decodeCharacterReferences, shownMarkup, tidyRenderedText } from "./export.js";

/** Elements with no content and no closing tag: hiding one hides nothing but itself. */
const VOID_ELEMENTS = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

/** The value of the last declaration of `prop` in a style attribute — the one that wins. */
function cssValue(declarations: string[], prop: string): string | undefined {
  let value: string | undefined;
  for (const d of declarations) {
    const i = d.indexOf(":");
    if (i > 0 && d.slice(0, i) === prop) value = d.slice(i + 1).replace(/!important$/, "");
  }
  return value;
}

/** `0`, `0px`, `0.0em`, `.0`, `0%`: a length or number that is zero. */
function isZero(v: string | undefined): boolean {
  return v !== undefined && /^(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/.test(v);
}

/**
 * How an element hides its content. `always`: display:none, the `hidden` attribute, opacity:0, or a
 * zero height with overflow hidden — nothing inside can undo those. `font` / `visibility`:
 * font-size:0 and visibility:hidden, which an inline style inside can set back.
 */
type Hiding = { always: true } | { always: false; font: boolean; visibility: boolean };

function hiding(attrs: Map<string, string>): Hiding | undefined {
  if (attrs.has("hidden")) return { always: true };
  const style = attrs.get("style");
  if (style === undefined) return undefined;
  const css = style
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .split(";");
  const height = isZero(cssValue(css, "height")) || isZero(cssValue(css, "max-height"));
  const clipped = ["overflow", "overflow-y"].some((p) => cssValue(css, p) === "hidden");
  if (cssValue(css, "display") === "none" || isZero(cssValue(css, "opacity")) || (height && clipped)) {
    return { always: true };
  }
  const v = cssValue(css, "visibility");
  const visibility = v === "hidden" || v === "collapse";
  const font = isZero(cssValue(css, "font-size"));
  return visibility || font ? { always: false, font, visibility } : undefined;
}

/**
 * The class names and ids an `@media` rule in the mail's `<style>` blocks selects. An element
 * carrying one is a responsive block: hidden inline, shown on a screen the rule matches.
 */
function mediaSelected(html: string): Set<string> {
  const names = new Set<string>();
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  for (let open = lower.indexOf("<style"); open >= 0; ) {
    const start = lower.indexOf(">", open);
    if (start < 0) break;
    const close = lower.indexOf("</style", start);
    const css = html.slice(start + 1, close < 0 ? html.length : close);
    for (let at = css.indexOf("@media"); at >= 0; at = css.indexOf("@media", at + 1)) {
      const brace = css.indexOf("{", at);
      if (brace < 0) break;
      // The rules inside the block: selectors are what stands before each inner `{`.
      let depth = 1;
      let i = brace + 1;
      let selector = i;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === "{") {
          if (depth === 1) {
            for (const m of css.slice(selector, i).matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
          }
          depth++;
        } else if (css[i] === "}") {
          depth--;
          selector = i + 1;
        }
      }
      at = i - 1;
    }
    if (close < 0) break;
    open = lower.indexOf("<style", close);
  }
  return names;
}

/** Whether an element's class list or id names something an `@media` rule selects. */
function isResponsive(attrs: Map<string, string>, selected: Set<string>): boolean {
  if (selected.size === 0) return false;
  const id = attrs.get("id");
  if (id !== undefined && selected.has(id)) return true;
  return (attrs.get("class") ?? "").split(/\s+/).some((c) => c !== "" && selected.has(c));
}

/**
 * The positions of every inline style inside the body that sets a non-zero font-size, and of every
 * one that sets visibility:visible, in order — read from `style` attributes only, so the same words
 * in the mail's text do not count.
 */
interface SetBacks {
  font: number[];
  visible: number[];
}

function findSetBacks(markup: string, tagPattern: RegExp): SetBacks {
  const font: number[] = [];
  const visible: number[] = [];
  const tags = new RegExp(tagPattern.source, "g");
  for (let m = tags.exec(markup); m; m = tags.exec(markup)) {
    if (!/style/i.test(m[0])) continue;
    const css = (attributesOf(m[0]).get("style") ?? "").toLowerCase().replace(/\s+/g, "").split(";");
    const size = cssValue(css, "font-size");
    if (size !== undefined && size !== "" && !isZero(size)) font.push(m.index);
    if (cssValue(css, "visibility") === "visible") visible.push(m.index);
  }
  return { font, visible };
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
 * A bound on the walk, so hostile markup costs at most a fixed multiple of its length: separate
 * stack-matching passes for this many tag names. Past it, an element is not counted.
 */
const MAX_HIDDEN_NAMES = 24;

/**
 * For each opening tag of `name`, where its element ends (the index after its closing tag), by
 * stack matching over the whole string: a closing tag ends the most recent open one. An opening
 * tag with no closing tag is absent from the map. One pass per name.
 */
function closesOf(s: string, name: string): Map<number, number> {
  const tags = new RegExp(`<(/?)${name}(?=[\\t\\n\\f\\r />])[^<>]*>`, "gi");
  const open: number[] = [];
  const ends = new Map<number, number>();
  for (let m = tags.exec(s); m; m = tags.exec(s)) {
    if (m[1] === "") open.push(m.index);
    else if (open.length > 0) ends.set(open.pop()!, m.index + m[0].length);
  }
  return ends;
}

/** The text of a stretch of markup: tags out, entities decoded, tidied, invisible characters gone. */
function textLength(markup: string): number {
  return tidyRenderedText(decodeCharacterReferences(markup.replace(/<[^<>]*>/g, " "))).length;
}

const OPENING_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\t\n\f\r />])[^<>]*>/g;

/**
 * How many characters of text an HTML body keeps from its reader; 0 for none. See the module
 * comment for what counts and what does not.
 */
export function hiddenTextLength(html: string): number {
  if (html === "") return 0;
  const selected = mediaSelected(html);
  const markup = shownMarkup(html);
  const tags = new RegExp(OPENING_TAG.source, "g");
  const matched = new Map<string, Map<number, number>>();
  let setBacks: SetBacks | undefined;
  let hidden = 0;
  for (let m = tags.exec(markup); m; m = tags.exec(markup)) {
    const name = m[1].toLowerCase();
    if (VOID_ELEMENTS.has(name)) continue;
    // Cheap test first: most tags carry neither word.
    if (!/hidden|style/i.test(m[0])) continue;
    const attrs = attributesOf(m[0]);
    const how = hiding(attrs);
    if (how === undefined || isResponsive(attrs, selected)) continue;
    let ends = matched.get(name);
    if (ends === undefined) {
      if (matched.size >= MAX_HIDDEN_NAMES) continue;
      ends = closesOf(markup, name);
      matched.set(name, ends);
    }
    const end = ends.get(m.index);
    if (end === undefined) continue;
    if (!how.always) {
      setBacks ??= findSetBacks(markup, OPENING_TAG);
      const from = m.index + m[0].length;
      const fontBack = !how.font || anyWithin(setBacks.font, from, end);
      const visibleBack = !how.visibility || anyWithin(setBacks.visible, from, end);
      if (fontBack && visibleBack) continue;
    }
    hidden += textLength(markup.slice(m.index, end));
    // Nested hidden elements are inside this one and counted with it.
    tags.lastIndex = end;
  }
  return hidden;
}

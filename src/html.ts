/**
 * What an HTML mail shows its reader, read from the tree a browser builds: the links it offers and
 * how much text it hides.
 *
 * Both used to be read with hand-written scanners over the markup, and three review rounds on
 * 24 Nov 2026 found a new way each time to make them disagree with a browser — a quote, a `>` or a
 * comment opener inside an attribute value, a bogus comment, a raw-text element — and every
 * disagreement about a link was a way to show one target while the browser opens another. So the
 * markup is parsed by parse5, which implements the HTML standard's tokenizer and tree construction:
 * attributes, duplicates, comments, raw text and implied end tags are what the standard says they
 * are, not what a regex guesses.
 *
 * Links are returned as a list the server builds, never written into the mail's text: a marker in
 * the text is something the mail's own text can spell out too. A target is resolved with the URL
 * standard (`new URL`), the parser a browser uses, so tabs, line breaks, backslashes and `@` end up
 * where they really lead, and the `url` shown is the address that opens.
 *
 * Hidden text is counted, never removed (see `hiddenTextLength`). Pure: the parse is the only work,
 * and the tree walks are iterative, so no nesting depth exhausts the stack.
 */

import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { tidyRenderedText } from "./export.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/**
 * Elements whose content a reader does not see as text: scripts, styles, the head, templates, and
 * the fallback content of embeds and frames. Their text is neither a link's label nor hidden text.
 */
const NOT_SHOWN = new Set(["script", "style", "head", "title", "template", "noscript", "noembed", "noframes", "iframe", "object"]);

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

/** An attribute's value; parse5 already keeps only the first of a repeated name, as the standard says. */
function attr(e: Element, name: string): string | undefined {
  return e.attrs.find((a) => a.name === name)?.value;
}

/** The child nodes of `n`, the content of a `<template>` excluded (it is not shown). */
function childrenOf(n: Node): Node[] {
  return "childNodes" in n ? (n as ParentNode).childNodes : [];
}

/** The text nodes under `root`, in order, skipping what is not shown. Iterative. */
function textOf(root: Node): string[] {
  const out: string[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.nodeName === "#text") {
      out.push((n as DefaultTreeAdapterTypes.TextNode).value);
      continue;
    }
    if (isElement(n) && NOT_SHOWN.has(n.tagName)) continue;
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Links

/** One link of a mail, as the server read it: the text a reader sees and the address that opens. */
export interface MailLink {
  text: string;
  url: string;
}

/** At most this many links per message; `linksOf` says how many more there were. */
export const MAX_LINKS = 100;
/** A link's text longer than this is cut: a whole paragraph wrapped in one link says nothing more. */
const MAX_LINK_TEXT = 200;

const SHOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The address a browser opens for `href`, or undefined when it is not a web, mail or phone address
 * or is relative (a mail has no base address to resolve it against). Resolved by the URL standard,
 * which strips what a browser strips and decides the host the way a browser does.
 */
export function browserTarget(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  return SHOWN_PROTOCOLS.has(url.protocol) ? url.href : undefined;
}

function oneLine(texts: string[]): string {
  const s = tidyRenderedText(texts.join("")).replace(/\s+/g, " ").trim();
  return s.length > MAX_LINK_TEXT ? s.slice(0, MAX_LINK_TEXT - 3) + "..." : s;
}

/** The first non-empty `alt` of an image inside a link: a button built from a spacer and an image. */
function imageAlt(a: Element): string {
  const stack: Node[] = [a];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isElement(n)) {
      if (n.tagName === "img") {
        const alt = tidyRenderedText(attr(n, "alt") ?? "").trim();
        if (alt !== "") return alt;
      }
      if (NOT_SHOWN.has(n.tagName)) continue;
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return "";
}

/**
 * The links of an HTML body, in document order: each web, mail or phone address once, with the
 * text of its first link that shows any (an image's `alt` text where the link has no text). A link
 * that shows nothing — a tracking pixel, a spacer — is left out and does not use up its address.
 * At most `MAX_LINKS`; `omitted` counts the rest.
 */
export function linksOf(html: string): { links: MailLink[]; omitted: number } {
  const links: MailLink[] = [];
  if (html === "") return { links, omitted: 0 };
  const seen = new Set<string>();
  let omitted = 0;
  const stack: Node[] = [parse(html)];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isElement(n)) {
      if (NOT_SHOWN.has(n.tagName)) continue;
      if (n.tagName === "a" && n.namespaceURI === "http://www.w3.org/1999/xhtml") {
        const href = attr(n, "href");
        const url = href === undefined ? undefined : browserTarget(href);
        if (url !== undefined && !seen.has(url)) {
          const text = oneLine(textOf(n)) || imageAlt(n);
          if (text !== "") {
            seen.add(url);
            if (links.length < MAX_LINKS) links.push({ text, url });
            else omitted++;
          }
        }
      }
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { links, omitted };
}

// ---------------------------------------------------------------------------------------------
// Hidden text

/**
 * CSS with its comments removed, an unclosed one running to the end as in a browser. A forward walk:
 * a lazy regex rescanned to the end at every unclosed comment opener, and 1 MB of them took 96 s
 * (review 24 Nov 2026).
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
  return withoutComments(css).toLowerCase().replace(/\s+/g, "").split(";");
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

/** The font size declarations set, by `font-size` or the `font` shorthand; undefined when none. */
function fontSize(decls: string[]): string | undefined {
  const size = cssValue(decls, "font-size") ?? shorthandSize(cssValue(decls, "font"));
  return size === "" ? undefined : size;
}

/** Whether a rule body shows what an inline style hid. */
function unhides(body: string): boolean {
  const d = declarations(body);
  const display = cssValue(d, "display");
  const maxHeight = cssValue(d, "max-height");
  const height = cssValue(d, "height");
  const opacity = cssValue(d, "opacity");
  const size = fontSize(d);
  return (
    (display !== undefined && display !== "none") ||
    (maxHeight !== undefined && !isZero(maxHeight)) ||
    (height !== undefined && !isZero(height)) ||
    cssValue(d, "visibility") === "visible" ||
    (opacity !== undefined && !isZero(opacity)) ||
    (size !== undefined && !isZero(size))
  );
}

/**
 * The class names and ids that an `@media` rule shows again: from `.name`, `#name` and
 * `[class=name]`-style selectors of rules whose declarations un-hide. A rule only for print is no
 * screen a reader looks at and is skipped.
 */
function shownByMedia(styleTexts: string[]): Set<string> {
  const names = new Set<string>();
  for (const text of styleTexts) {
    const css = withoutComments(text);
    const lower = css.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    for (let at = lower.indexOf("@media"); at >= 0; at = lower.indexOf("@media", at + 1)) {
      const brace = css.indexOf("{", at);
      if (brace < 0) break;
      const printOnly = /^\s*print\s*$/.test(lower.slice(at + 6, brace));
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
  }
  return names;
}

/** The text of every `<style>` element, wherever the parser put it. */
function styleTexts(doc: Node): string[] {
  const out: string[] = [];
  const stack: Node[] = [doc];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (isElement(n) && n.tagName === "style") {
      out.push(n.childNodes.map((c) => (c.nodeName === "#text" ? (c as DefaultTreeAdapterTypes.TextNode).value : "")).join(""));
      continue;
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** What hides a node's text, inherited down the tree. */
interface Hidden {
  /** display:none, the `hidden` attribute, opacity:0 or a zero height with overflow hidden above. */
  block: boolean;
  /** The nearest font size declared above is zero. */
  font: boolean;
  /** The nearest visibility declared above is hidden or collapse. */
  visibility: boolean;
  /** A block above is one an `@media` rule shows again: nothing below it is hidden. */
  shownAgain: boolean;
}

const NONE: Hidden = { block: false, font: false, visibility: false, shownAgain: false };
const SHOWN_AGAIN: Hidden = { block: false, font: false, visibility: false, shownAgain: true };

/** The state below `e`, given the state above it. */
function below(e: Element, above: Hidden, shown: Set<string>): Hidden {
  if (above.shownAgain) return above;
  const id = attr(e, "id");
  const classes = (attr(e, "class") ?? "").split(/\s+/);
  // A block an @media rule shows again shows its content with it: `.desktop_hide table` re-shows
  // the tables inside too (a template seen in real mail, 24 Nov 2026).
  if ((id !== undefined && shown.has(id)) || classes.some((c) => c !== "" && shown.has(c))) return SHOWN_AGAIN;
  let { block, font, visibility } = above;
  if (e.tagName === "font") {
    const size = (attr(e, "size") ?? "").trim();
    if (size !== "") font = false;
  }
  if (attr(e, "hidden") !== undefined) block = true;
  const style = attr(e, "style");
  if (style !== undefined) {
    const d = declarations(style);
    const height = isZero(cssValue(d, "height")) || isZero(cssValue(d, "max-height"));
    const clipped = ["overflow", "overflow-y"].some((p) => cssValue(d, p) === "hidden");
    if (cssValue(d, "display") === "none" || isZero(cssValue(d, "opacity")) || (height && clipped)) block = true;
    const size = fontSize(d);
    if (size !== undefined) font = isZero(size);
    const v = cssValue(d, "visibility");
    if (v === "hidden" || v === "collapse") visibility = true;
    else if (v === "visible") visibility = false;
  }
  return { block, font, visibility, shownAgain: false };
}

/**
 * How many characters of text an HTML body keeps from its reader; 0 for none.
 *
 * Counted, never removed, and the reason is measured (24 Nov 2026, 107 HTML mails of one mailbox):
 * a version that removed such text from the renderings took visible text with it — templates hide
 * blocks inline and show them on a phone through an `@media` rule (42 % of a Google Ads mail's
 * text). A count that is sometimes wrong costs a second look; text missing from what a person sees
 * costs the mail.
 *
 * Hidden: text under an element styled `display:none`, `opacity:0` or a zero height with overflow
 * hidden, or marked `hidden`; text whose nearest declared font size is zero, or whose nearest
 * declared visibility is hidden — inherited down the tree as CSS inherits them, so a column that
 * sets its size back inside a `font-size:0` wrapper is visible. Not hidden: a block whose class or id
 * an `@media` rule shows again (`.name`, `#name`, `[class=name]`; not a print rule), with everything
 * inside it. Not seen: styles from a class outside `@media`, text coloured like its background,
 * positioning off screen. A newsletter's preview text is hidden the same way for an honest reason,
 * usually under 150 characters: the count is a fact to weigh, not a verdict.
 */
export function hiddenTextLength(html: string): number {
  if (html === "") return 0;
  const doc = parse(html);
  const shown = shownByMedia(styleTexts(doc));
  let hidden = 0;
  const stack: Array<[Node, Hidden]> = [[doc, NONE]];
  while (stack.length > 0) {
    const [n, above] = stack.pop()!;
    if (n.nodeName === "#text") {
      if (above.block || above.font || above.visibility) {
        hidden += tidyRenderedText((n as DefaultTreeAdapterTypes.TextNode).value).length;
      }
      continue;
    }
    let state = above;
    if (isElement(n)) {
      if (NOT_SHOWN.has(n.tagName)) continue;
      state = below(n, above, shown);
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], state]);
  }
  return hidden;
}

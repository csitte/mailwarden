/**
 * What an HTML mail shows its reader, read from the tree a browser builds: the links it offers and
 * how much text it hides.
 *
 * Both used to be read with hand-written scanners over the markup, and three review rounds on
 * 24 Nov 2026 found a new way each time to make them disagree with a browser — a quote, a `>` or a
 * comment opener inside an attribute value, a bogus comment, a raw-text element — and every
 * disagreement about a link was a way to show one target while the browser opens another. So the
 * markup is parsed by parse5, which implements the HTML standard's tokenizer and tree construction,
 * with scripting off as in a mail client (so `<noscript>` content is content).
 *
 * Which text a reader sees is a question of CSS, and this module answers it from inline styles only,
 * with inheritance (`visibleBelow`): display:none, the `hidden` attribute, opacity:0, a zero height or
 * width with overflow hidden, a zero or relative-to-zero font size, visibility:hidden and
 * color:transparent. A fourth review round showed why that matters for links: text hidden inside a
 * link made `paypal<hidden>-secure-evil</hidden>.com` read as the address it pointed to. So a link's
 * text is its visible text, and a link that hides some says so.
 *
 * Links are returned as a list the server builds, never written into the mail's text: a marker in
 * the text is something the mail's own text can spell out too. A target is resolved with the URL
 * standard (`new URL`), the parser a browser uses, and `host` is the host that opens.
 *
 * Pure. One parse per call and one iterative walk over the tree, so neither nesting depth nor
 * link count makes it quadratic or exhausts the stack.
 */

import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { tidyRenderedText } from "./export.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * Elements whose content a reader does not see as text: scripts, styles, the head, templates, and
 * the fallback content of embeds and frames. Their text is neither a link's text nor hidden text.
 */
const NOT_SHOWN = new Set(["script", "style", "head", "title", "template", "noembed", "noframes", "iframe", "object"]);

/** Elements that start a new line: their text is not glued to the text before it. */
const BLOCKS = new Set(
  "address article aside blockquote br dd div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul".split(" "),
);

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

/** An attribute's value; parse5 keeps only the first of a repeated name, as the standard says. */
function attr(e: Element, name: string, namespace?: string): string | undefined {
  return e.attrs.find((a) => a.name === name && (namespace === undefined || a.namespace === namespace))?.value;
}

/** The child nodes of `n` (a `<template>`'s content is not among them: it is not shown). */
function childrenOf(n: Node): Node[] {
  return "childNodes" in n ? (n as ParentNode).childNodes : [];
}

/** Parse as a mail client renders: no scripts, so `<noscript>` is ordinary content. */
function parseMail(html: string): DefaultTreeAdapterTypes.Document {
  return parse(html, { scriptingEnabled: false });
}

// ---------------------------------------------------------------------------------------------
// CSS, from inline styles

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

/** One declaration: property, value (single-spaced, lower-case) and whether it is `!important`. */
interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

/** The declarations of a style attribute or rule body, in order. */
function declarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of withoutComments(css).toLowerCase().split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    let value = part.slice(i + 1).replace(/\s+/g, " ").trim();
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/\s*!\s*important$/, "");
    out.push({ prop: part.slice(0, i).trim(), value, important });
  }
  return out;
}

/** The value of the last declaration of `prop` — the one that wins. */
function cssValue(decls: Declaration[], prop: string): string | undefined {
  let value: string | undefined;
  for (const d of decls) if (d.prop === prop) value = d.value;
  return value;
}

/** `0`, `0px`, `0.0em`, `.0`, `0%`: a length or number that is zero. */
function isZero(v: string | undefined): boolean {
  return v !== undefined && /^(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/.test(v);
}

/** The size inside a `font` shorthand (`bold 14px/20px arial`), or undefined when it names none. */
function shorthandSize(font: string | undefined): string | undefined {
  if (font === undefined) return undefined;
  for (const token of font.split(" ")) {
    const size = token.split("/")[0];
    if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:[a-z]+|%)?$/.test(size) && !/^\d+$/.test(size)) return size;
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(size) && isZero(size)) return size;
  }
  return undefined;
}

/** The font size declarations set, by `font-size` or the `font` shorthand; undefined when none. */
function fontSize(decls: Declaration[]): string | undefined {
  const size = cssValue(decls, "font-size") ?? shorthandSize(cssValue(decls, "font"));
  return size === "" ? undefined : size;
}

/** A size relative to the parent's: zero under a zero parent, whatever its factor. */
function isRelative(size: string): boolean {
  return size === "inherit" || size === "smaller" || /(?:em|ex|ch|%)$/.test(size);
}

/** `transparent`, or an rgba/hsla colour with alpha zero. */
function isTransparent(color: string | undefined): boolean {
  if (color === undefined) return false;
  if (color === "transparent") return true;
  const m = /^(?:rgba|hsla)\((.*)\)$/.exec(color.replace(/\s+/g, ""));
  if (!m) return false;
  const parts = m[1].split(/[,/]/);
  return parts.length === 4 && isZero(parts[3]);
}

/**
 * Whether a stylesheet rule body shows what an inline style hid. Only an `!important` declaration
 * can: an inline style beats any stylesheet rule that is not important, so a rule without it cannot
 * undo an inline `display:none` (review 24 Nov 2026, round four).
 */
function unhides(body: string): boolean {
  return declarations(body).some((d) => {
    if (!d.important) return false;
    switch (d.prop) {
      case "display":
        return d.value !== "none";
      case "max-height":
      case "height":
      case "max-width":
      case "width":
      case "opacity":
      case "font-size":
        return !isZero(d.value);
      case "visibility":
        return d.value === "visible";
      default:
        return false;
    }
  });
}

/** Whether an `@media` query can match a screen: not one for print alone. */
function screenQuery(query: string): boolean {
  return !/\bprint\b/.test(query) || /\b(?:screen|all)\b/.test(query);
}

/**
 * The class names and ids that an `@media` rule shows again: from `.name`, `#name` and
 * `[class=name]`-style selectors of rules whose declarations un-hide with `!important`, in a query
 * a screen can match.
 */
function shownByMedia(styleTexts: string[]): Set<string> {
  const names = new Set<string>();
  for (const text of styleTexts) {
    const css = withoutComments(text);
    const lower = css.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    for (let at = lower.indexOf("@media"); at >= 0; at = lower.indexOf("@media", at + 1)) {
      const brace = css.indexOf("{", at);
      if (brace < 0) break;
      const screen = screenQuery(lower.slice(at + 6, brace));
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
          if (depth === 1 && bodyStart >= 0 && screen && unhides(css.slice(bodyStart, i))) {
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

// ---------------------------------------------------------------------------------------------
// Visibility, inherited down the tree

/** What hides a node's text, inherited down the tree. */
interface Visibility {
  /** An element above is display:none, `hidden`, opacity:0, or zero-sized with overflow hidden. */
  block: boolean;
  /** The font size in effect is zero. */
  font: boolean;
  /** The visibility in effect is hidden or collapse. */
  visibility: boolean;
  /** The text colour in effect is transparent. */
  transparent: boolean;
  /** A block above is one an `@media` rule shows again: nothing below it is hidden. */
  shownAgain: boolean;
}

const VISIBLE: Visibility = { block: false, font: false, visibility: false, transparent: false, shownAgain: false };
const SHOWN_AGAIN: Visibility = { ...VISIBLE, shownAgain: true };

function hides(v: Visibility): boolean {
  return v.block || v.font || v.visibility || v.transparent;
}

/** The visibility below `e`, given the one above it. */
function visibleBelow(e: Element, above: Visibility, shown: Set<string>): Visibility {
  if (above.shownAgain) return above;
  const id = attr(e, "id");
  const classes = (attr(e, "class") ?? "").split(/\s+/);
  // A block an @media rule shows again shows its content with it: `.desktop_hide table` re-shows
  // the tables inside too (a template seen in real mail, 24 Nov 2026).
  if ((id !== undefined && shown.has(id)) || classes.some((c) => c !== "" && shown.has(c))) return SHOWN_AGAIN;
  let { block, font, visibility, transparent } = above;
  if (e.tagName === "font" && (attr(e, "size") ?? "").trim() !== "") font = false;
  const style = attr(e, "style");
  const d = style === undefined ? [] : declarations(style);
  const display = cssValue(d, "display");
  // The `hidden` attribute is a default display:none, which an inline display overrides.
  if (attr(e, "hidden") !== undefined && (display === undefined || display === "none")) block = true;
  if (style !== undefined) {
    const clipped = ["overflow", "overflow-x", "overflow-y"].some((p) => cssValue(d, p) === "hidden");
    const zeroBox = ["height", "max-height", "width", "max-width"].some((p) => isZero(cssValue(d, p)));
    if (display === "none" || isZero(cssValue(d, "opacity")) || (zeroBox && clipped)) block = true;
    const size = fontSize(d);
    if (size !== undefined && !(font && isRelative(size))) font = isZero(size);
    const v = cssValue(d, "visibility");
    if (v === "hidden" || v === "collapse") visibility = true;
    else if (v === "visible") visibility = false;
    const color = cssValue(d, "color");
    if (color !== undefined) transparent = isTransparent(color);
  }
  return { block, font, visibility, transparent, shownAgain: false };
}

// ---------------------------------------------------------------------------------------------
// The walk

/** One link of a mail, as the server read it. */
export interface MailLink {
  /** The link's visible text, or its image's alt text; empty for an image link without alt. */
  text: string;
  /** The address that opens, resolved by the URL standard. */
  url: string;
  /** The host that opens: compare `text` with this, not with `url`, which can carry `name@` before it. */
  host: string;
  /** The link shows an image. */
  image?: true;
  /** Text inside the link is hidden from the reader and left out of `text` — itself a warning sign. */
  hiddenText?: true;
}

/** At most this many links per message; `omitted` counts the rest. */
export const MAX_LINKS = 100;
/** A link's text longer than this is cut: a whole paragraph wrapped in one link says nothing more. */
const MAX_LINK_TEXT = 200;

const SHOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The address a browser opens for `href`, or undefined when it is not a web, mail or phone address
 * or is relative (a mail has no base address to resolve it against; a `<base>` element is not
 * applied). Resolved by the URL standard, which strips what a browser strips and decides the host
 * the way a browser does.
 */
export function browserTarget(href: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  return SHOWN_PROTOCOLS.has(url.protocol) ? url : undefined;
}

/** A link being read: its target and what the walk found inside it. */
interface OpenLink {
  url: URL;
  visible: boolean;
  parts: string[];
  alt: string;
  image: boolean;
  hiddenText: boolean;
}

/** The target of a link element, or undefined for an element that is not a link. */
function linkTargetOf(e: Element): string | undefined {
  if (e.namespaceURI === HTML_NS && (e.tagName === "a" || e.tagName === "area")) return attr(e, "href");
  if (e.namespaceURI === SVG_NS && e.tagName === "a") return attr(e, "href") ?? attr(e, "href", XLINK_NS);
  return undefined;
}

/** Text cut to `max` characters by code point, never inside a surrogate pair. */
function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 3).join("") + "..." : s;
}

interface WalkResult {
  hiddenChars: number;
  links: OpenLink[];
}

/** One walk over the parsed mail: hidden text counted, links collected with their visible text. */
function walk(html: string, collectLinks: boolean): WalkResult {
  const doc = parseMail(html);
  const shown = shownByMedia(styleTexts(doc));
  const links: OpenLink[] = [];
  let hiddenChars = 0;
  // Each entry: node, visibility above it, the innermost link it is inside (index or -1).
  const stack: Array<[Node, Visibility, number]> = [[doc, VISIBLE, -1]];
  while (stack.length > 0) {
    const [n, above, link] = stack.pop()!;
    if (n.nodeName === "#text") {
      const text = (n as DefaultTreeAdapterTypes.TextNode).value;
      if (hides(above)) {
        const length = tidyRenderedText(text).length;
        hiddenChars += length;
        if (link >= 0 && length > 0) links[link].hiddenText = true;
      } else if (link >= 0) {
        links[link].parts.push(text);
      }
      continue;
    }
    let state = above;
    let inside = link;
    if (isElement(n)) {
      if (NOT_SHOWN.has(n.tagName)) continue;
      state = visibleBelow(n, above, shown);
      if (link >= 0 && BLOCKS.has(n.tagName)) links[link].parts.push(" ");
      if (link >= 0 && n.tagName === "img" && !hides(state)) {
        links[link].image = true;
        if (links[link].alt === "") links[link].alt = tidyRenderedText(attr(n, "alt") ?? "").trim();
      }
      const href = collectLinks ? linkTargetOf(n) : undefined;
      const url = href === undefined ? undefined : browserTarget(href);
      if (url !== undefined) {
        links.push({ url, visible: !hides(state), parts: [], alt: "", image: false, hiddenText: false });
        inside = links.length - 1;
        if (n.tagName === "area") links[inside].alt = tidyRenderedText(attr(n, "alt") ?? "").trim();
      }
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], state, inside]);
  }
  return { hiddenChars, links };
}

/**
 * The links of an HTML body a reader can see, in document order, each as `{text, url, host}`:
 * web, mail and phone addresses; an `<a>`, an image map's `<area>`, or an SVG link. `text` is the
 * link's visible text (or its image's alt text); a link with text hidden inside says `hiddenText`. A
 * link that is itself hidden, or shows neither text nor an image, is left out. Each pair of text and
 * address once. At most `MAX_LINKS`; `omitted` counts the rest.
 */
export function linksOf(html: string): { links: MailLink[]; omitted: number } {
  const out: MailLink[] = [];
  if (html === "") return { links: out, omitted: 0 };
  const seen = new Set<string>();
  let omitted = 0;
  for (const l of walk(html, true).links) {
    if (!l.visible) continue;
    const text = cut(tidyRenderedText(l.parts.join("")).replace(/\s+/g, " ").trim(), MAX_LINK_TEXT) || l.alt;
    if (text === "" && !l.image) continue;
    const key = `${l.url.href} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= MAX_LINKS) {
      omitted++;
      continue;
    }
    out.push({
      text,
      url: l.url.href,
      host: l.url.hostname,
      ...(l.image ? { image: true as const } : {}),
      ...(l.hiddenText ? { hiddenText: true as const } : {}),
    });
  }
  return { links: out, omitted };
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
 * Hidden is what `visibleBelow` says from inline styles. Not hidden: a block whose class or id an
 * `@media` rule for a screen shows again with `!important` (`.name`, `#name`, `[class=name]`), with
 * everything inside it. Not seen: styles from a class outside such a rule, text coloured like its
 * background, positioning off screen, CSS escapes. A newsletter's preview text is hidden the same way
 * for an honest reason, usually under 150 characters: the count is a fact to weigh, not a verdict.
 */
export function hiddenTextLength(html: string): number {
  return html === "" ? 0 : walk(html, false).hiddenChars;
}

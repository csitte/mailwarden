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
 * The parse runs under a node budget (`NODE_BUDGET`). The standard's tree construction rebuilds
 * every open formatting element at each new block, so a few kilobytes of unclosed `<b a=1><b a=2>`
 * followed by many blocks build millions of nodes: 87 KB took 13 s and 4.2 GB (review round five).
 * Past the budget the parse stops and the message is reported as too complex to read, rather than
 * read at any price; `parseMessage` runs this on every message of every thread.
 *
 * Which text a reader sees is a question of CSS, answered here from inline styles only, with
 * inheritance (`visibleBelow`) and CSS's own rules for what it drops: an invalid value is ignored,
 * the later of two declarations wins unless the earlier is `!important`. A fourth review round
 * showed why that matters for links: text hidden inside a link made
 * `paypal<hidden>-secure-evil</hidden>.com` read as the address it pointed to. So a link's text is its
 * visible text, a link that hides some says so, and a link shows only if something in it does.
 *
 * Links are returned as a list the server builds, never written into the mail's text: a marker in
 * the text is something the mail's own text can spell out too. A target is resolved with the URL
 * standard (`new URL`), the parser a browser uses, and `host` is the host that opens.
 *
 * Pure. One bounded parse per call and one iterative walk, so neither nesting depth nor link count
 * makes it quadratic or exhausts the stack.
 */

import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type TreeAdapter } from "parse5";
import { tidyRenderedText } from "./export.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * At most this many nodes per parse. Counted are nodes the parser creates — elements, comments and
 * new text nodes; text appended to an existing text node is not a node. A 1 MB newsletter of tables
 * builds well under half of it, 1 MB of plain paragraphs about a tenth (review round six measured
 * both, after a first count that took every word for a node).
 */
export const NODE_BUDGET = 250_000;

/**
 * At most this long per parse, in milliseconds. A real 1 MB mail parses in 115 to 182 ms (measured
 * by grok-mailwarden for 0.33.0); the limit leaves room for a slower machine and stops markup built
 * to make the parser's own bookkeeping quadratic.
 */
export const TIME_BUDGET_MS = 1000;

class TooComplex extends Error {}

/** The budgets a parse runs under; tests pass smaller ones to pin the boundaries exactly. */
export interface ParseLimits {
  nodes: number;
  ms: number;
}

const LIMITS: ParseLimits = { nodes: NODE_BUDGET, ms: TIME_BUDGET_MS };

/** parse5's own tree adapter, counting every node it creates and stopping at `NODE_BUDGET`. */
function budgetedAdapter(limits: ParseLimits): TreeAdapter<DefaultTreeAdapterMap> {
  let made = 0;
  const started = performance.now();
  const count = () => {
    if (++made > limits.nodes) throw new TooComplex();
    // Nodes alone do not bound the time: parse5 indexes open formatting elements, and with
    // thousands of them each new node costs time in proportion (grok-mailwarden, 0.33.0 round: 1 MB
    // took 38 s at a linear node count). So the clock is read every 256 nodes as well; a real
    // 1 MB mail parses in under 0.2 s.
    if ((made & 0xff) === 0 && performance.now() - started > limits.ms) throw new TooComplex();
  };
  const isText = (n: Node | undefined) => n !== undefined && defaultTreeAdapter.isTextNode(n);
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      count();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    createTextNode(value) {
      count();
      return defaultTreeAdapter.createTextNode(value);
    },
    createCommentNode(data) {
      count();
      return defaultTreeAdapter.createCommentNode(data);
    },
    // The default adapter appends to a text node already there and creates one otherwise; only the
    // second is a node.
    insertText(parentNode, text) {
      if (!isText(parentNode.childNodes[parentNode.childNodes.length - 1])) count();
      defaultTreeAdapter.insertText(parentNode, text);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      // The same lookup parse5 makes, last child first: a plain indexOf here made foster-parented
      // text quadratic (0.6 MB took 4 s, review round seven).
      const kids = parentNode.childNodes;
      const at = kids[kids.length - 1] === referenceNode ? kids.length - 1 : kids.indexOf(referenceNode);
      if (!isText(kids[at - 1])) count();
      defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
    },
  };
}

/** Parse as a mail client renders — no scripts — within the node budget; undefined past it. */
function parseMail(html: string, limits: ParseLimits): DefaultTreeAdapterTypes.Document | undefined {
  try {
    return parse(html, { scriptingEnabled: false, treeAdapter: budgetedAdapter(limits) });
  } catch (e) {
    if (e instanceof TooComplex) return undefined;
    throw e;
  }
}

/**
 * Elements whose content a reader does not see as text: scripts, styles, the head, templates, the
 * fallback content of embeds, frames and media, ruby's fallback parentheses, a datalist's options,
 * and SVG's descriptions. An `<object>` with `data` shows the object, without it its content.
 */
const NOT_SHOWN = new Set([
  "script", "style", "head", "title", "template", "noembed", "noframes", "iframe",
  "video", "audio", "rp", "datalist", "desc", "metadata",
]);

/** SVG elements whose text SVG renders; text anywhere else in an SVG is not drawn. */
const SVG_TEXT = new Set(["text", "tspan", "textPath"]);

/** Elements that start a new line: their text is not glued to the text before it. */
const BLOCKS = new Set(
  "address article aside blockquote br dd div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul".split(" "),
);

/** Elements that are inline or table parts unless a style says otherwise: no box to size or scale. */
const INLINE_BY_DEFAULT = new Set(
  "a abbr b bdi bdo big cite code data dfn em font i kbd label mark q s samp small span strike strong sub sup time tt u var td th tr tbody thead tfoot".split(" "),
);

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

/** An attribute without a namespace; parse5 keeps only the first of a repeated name, as the standard says. */
function attr(e: Element, name: string): string | undefined {
  return e.attrs.find((a) => a.name === name && !a.namespace)?.value;
}

/** The child nodes of `n` (a `<template>`'s content is not among them: it is not shown). */
function childrenOf(n: Node): Node[] {
  return "childNodes" in n ? (n as ParentNode).childNodes : [];
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

/** `css` split at semicolons outside quoted strings and parentheses, as CSS splits declarations. */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

const GLOBAL_VALUES = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const LENGTH = new RegExp(`^(?:${NUMBER}(?:px|pt|pc|cm|mm|in|q|em|rem|ex|ch|vw|vh|vmin|vmax|%)|[+-]?0+(?:\\.0*)?)$`);
const NUMBER_OR_PERCENT = new RegExp(`^${NUMBER}%?$`);
const FONT_SIZE_WORDS = new Set("xx-small x-small small medium large x-large xx-large xxx-large larger smaller math".split(" "));
const DISPLAY_VALUES = new Set(
  ("none block inline inline-block flex inline-flex grid inline-grid flow-root contents list-item table " +
    "inline-table table-row table-cell table-row-group table-header-group table-footer-group table-column " +
    "table-column-group table-caption ruby run-in").split(" "),
);
/** CSS's named colours, so that a word that is not one is dropped as CSS drops it. */
const NAMED_COLORS = new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen transparent currentcolor canvastext linktext visitedtext activetext buttontext " +
    "fieldtext graytext highlighttext marktext accentcolortext canvas buttonface field highlight mark accentcolor"
  ).split(" "),
);

/**
 * Whether a value is one a browser would keep for `prop`. An invalid one is dropped, as CSS drops it:
 * `opacity:0px` or `font-size:0zz` hide nothing (review round six), `display:none;display:bogus`
 * stays none. Properties this module does not read are kept as written.
 */
function valid(prop: string, value: string): boolean {
  if (GLOBAL_VALUES.has(value)) return true;
  switch (prop) {
    case "display":
      return DISPLAY_VALUES.has(value) || /^(?:block|inline) (?:flow|flow-root|flex|grid|table)$/.test(value);
    case "opacity":
      return NUMBER_OR_PERCENT.test(value);
    case "font-size":
      return LENGTH.test(value) || FONT_SIZE_WORDS.has(value) || /^(?:calc|min|max|clamp)\(.*\)$/.test(value);
    case "height":
    case "max-height":
    case "width":
    case "max-width":
    case "min-height":
    case "min-width":
      return LENGTH.test(value) || /^(?:auto|none|fit-content|min-content|max-content)$/.test(value) || /^(?:calc|min|max|clamp)\(.*\)$/.test(value);
    case "visibility":
      return value === "visible" || value === "hidden" || value === "collapse";
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      return /^(?:visible|hidden|clip|scroll|auto)(?: (?:visible|hidden|clip|scroll|auto))?$/.test(value);
    case "color":
      return NAMED_COLORS.has(value) || /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value) || /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(.*\)$/.test(value);
    default:
      return true;
  }
}

/** The declarations of a style attribute or rule body, in order, the invalid ones dropped. */
function declarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitDeclarations(withoutComments(css).toLowerCase())) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    let value = part.slice(i + 1).replace(/\s+/g, " ").trim();
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/\s*!\s*important$/, "");
    const prop = part.slice(0, i).trim();
    if (valid(prop, value)) out.push({ prop, value, important });
  }
  return out;
}

/** The declaration among `props` that wins: the last `!important` one, else the last one. */
function winning(decls: Declaration[], ...props: string[]): Declaration | undefined {
  let normal: Declaration | undefined;
  let important: Declaration | undefined;
  for (const d of decls) {
    if (!props.includes(d.prop)) continue;
    if (d.important) important = d;
    else normal = d;
  }
  return important ?? normal;
}

/** The value of `prop` that wins. */
function cssValue(decls: Declaration[], prop: string): string | undefined {
  return winning(decls, prop)?.value;
}

/** `0`, `0px`, `0.0em`, `.0`, `0%`: a length or number that is zero. */
function isZero(v: string | undefined): boolean {
  return v !== undefined && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/.test(v);
}

/** An opacity a browser clamps to zero: zero or negative. */
function noOpacity(v: string | undefined): boolean {
  if (v === undefined || GLOBAL_VALUES.has(v)) return false;
  const n = v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  return !Number.isNaN(n) && n <= 0;
}

/** The size inside a `font` shorthand (`bold 14px/20px arial`), or undefined when it names none. */
function shorthandSize(font: string): string | undefined {
  for (const token of font.split(" ")) {
    const size = token.split("/")[0];
    if (LENGTH.test(size) || FONT_SIZE_WORDS.has(size)) return size;
  }
  return undefined;
}

/**
 * The font size the winning declaration sets — `font-size` or the `font` shorthand, whichever
 * comes last (or is `!important`) — or undefined when none does.
 */
function fontSize(decls: Declaration[]): string | undefined {
  const d = winning(decls, "font-size", "font");
  if (d === undefined) return undefined;
  return d.prop === "font-size" ? d.value : shorthandSize(d.value);
}

/** Whether a font size leaves a zero size above it at zero: anything relative to the parent's. */
function keepsParentZero(size: string): boolean {
  return (
    size === "inherit" || size === "unset" || size === "larger" || size === "smaller" ||
    /(?:em|ex|ch|%)$/.test(size) || (/^(?:calc|min|max|clamp)\(/.test(size) && /em|%|ex|ch/.test(size))
  );
}

/** `transparent`, a hex colour with alpha zero, or an rgb/rgba/hsl/hsla colour with alpha zero. */
function isTransparent(color: string): boolean {
  if (color === "transparent") return true;
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(color);
  if (hex) return /^0+$/.test(hex[1].length === 4 ? hex[1].slice(3) : hex[1].slice(6));
  const fn = /^(?:rgba?|hsla?)\((.*)\)$/.exec(color);
  if (!fn) return false;
  const parts = fn[1].split(/[\s,/]+/).filter((p) => p !== "");
  return parts.length === 4 && isZero(parts[3]);
}

/** A transform that scales to nothing (boxes only), a clip path that leaves nothing, or the visually-hidden clip. */
function clipsAway(d: Declaration[], box: boolean): boolean {
  const transform = cssValue(d, "transform") ?? "";
  if (box && /scale[xy]?\(\s*0(?:\.0*)?\s*(?:[,)])/.test(transform)) return true;
  const clipPath = cssValue(d, "clip-path") ?? "";
  if (/inset\(\s*50%/.test(clipPath) || /circle\(\s*0/.test(clipPath)) return true;
  const clip = (cssValue(d, "clip") ?? "").replace(/\s+/g, "");
  return /^rect\(0(?:px)?,?0(?:px)?,?0(?:px)?,?0(?:px)?\)$/.test(clip) && /absolute|fixed/.test(cssValue(d, "position") ?? "");
}

/**
 * Whether a stylesheet rule body shows what an inline style hid. Only an `!important` declaration
 * can: an inline style beats any stylesheet rule that is not important, so a rule without it cannot
 * undo an inline `display:none` (review round four).
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
  const not = /^\s*not\s+(\w+)/.exec(query);
  if (not) return not[1] !== "screen" && not[1] !== "all";
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

/** What hides a node, inherited down the tree. */
interface Visibility {
  /** An element above is not rendered at all, or rendered with nothing to see. Hides images too. */
  block: boolean;
  /** The visibility in effect is hidden or collapse. Hides images too; a child can set it back. */
  visibility: boolean;
  /** The font size in effect is zero. Hides text only. */
  font: boolean;
  /** The text colour in effect is transparent. Hides text only. */
  transparent: boolean;
  /** Inside SVG but outside `<text>`: SVG draws no text here. */
  svgNoText: boolean;
  /** A block above is one an `@media` rule shows again: nothing below it is hidden by its inline style. */
  shownAgain: boolean;
}

const VISIBLE: Visibility = { block: false, visibility: false, font: false, transparent: false, svgNoText: false, shownAgain: false };

/** Whether text under this state is hidden. */
function hidesText(v: Visibility): boolean {
  return v.block || v.visibility || v.font || v.transparent || v.svgNoText;
}

/** Whether an image under this state is hidden: font size and colour do not hide an image. */
function hidesImage(v: Visibility): boolean {
  return v.block || v.visibility;
}

/** The visibility below `e`, given the one above it. */
function visibleBelow(e: Element, above: Visibility, shown: Set<string>): Visibility {
  // Where SVG draws text, and where HTML content inside it (foreignObject) starts again.
  // An <svg> draws no text of its own; a <text> (and what is inside it) does; HTML inside an SVG
  // (<foreignObject>) is HTML again.
  let svgNoText = above.svgNoText;
  if (e.namespaceURI === SVG_NS) {
    if (SVG_TEXT.has(e.tagName)) svgNoText = false;
    else if (e.tagName === "svg") svgNoText = true;
  } else if (e.namespaceURI === HTML_NS) {
    svgNoText = false;
  }
  if (above.shownAgain) return { ...above, svgNoText };
  const id = attr(e, "id");
  const classes = (attr(e, "class") ?? "").split(/\s+/);
  // A block an @media rule shows again shows its content with it: `.desktop_hide table` re-shows
  // the tables inside too (a template seen in real mail, 24 Nov 2026). It cannot show what an
  // ancestor does not render, so a hidden ancestor still hides it (review round five).
  if (!above.block && ((id !== undefined && shown.has(id)) || classes.some((c) => c !== "" && shown.has(c)))) {
    return { ...VISIBLE, svgNoText, shownAgain: true };
  }
  let { block, font, visibility, transparent } = above;
  const style = attr(e, "style");
  const d = style === undefined ? [] : declarations(style);
  const display = cssValue(d, "display");
  const html = e.namespaceURI === HTML_NS;
  if (html) {
    if (e.tagName === "font" && (attr(e, "size") ?? "").trim() !== "") font = false;
    // A link has a colour of its own in every browser's default style.
    if ((e.tagName === "a" || e.tagName === "area") && attr(e, "href") !== undefined) transparent = false;
  }
  // The `hidden` attribute and a closed <dialog> are a default display:none, which an inline
  // display overrides.
  const hiddenByDefault = attr(e, "hidden") !== undefined || (html && e.tagName === "dialog" && attr(e, "open") === undefined);
  if (hiddenByDefault && (display === undefined || display === "none")) block = true;
  if (style !== undefined && display !== "contents") {
    // A width, height or transform acts on a box, not on an inline element or a table part, unless
    // the style makes one (`display:block`, `inline-block`, ...).
    const effective = display ?? (INLINE_BY_DEFAULT.has(e.tagName) ? "inline" : "block");
    const box = !/^(?:inline|table-cell|table-row|table-row-group|table-header-group|table-footer-group)$/.test(effective);
    const clipped = ["overflow", "overflow-x", "overflow-y"].some((p) => /hidden|clip/.test(cssValue(d, p) ?? ""));
    const minimum = ["min-height", "min-width"].some((p) => {
      const v = cssValue(d, p);
      return v !== undefined && !isZero(v) && v !== "auto" && !GLOBAL_VALUES.has(v);
    });
    const zeroBox = box && !minimum && ["height", "max-height", "width", "max-width"].some((p) => isZero(cssValue(d, p)));
    if (display === "none" || noOpacity(cssValue(d, "opacity")) || (zeroBox && clipped) || clipsAway(d, box)) block = true;
  } else if (display === "none") {
    block = true;
  }
  const size = fontSize(d);
  if (size !== undefined && !(font && keepsParentZero(size))) font = isZero(size);
  const v = cssValue(d, "visibility");
  if (v === "hidden" || v === "collapse") visibility = true;
  else if (v === "visible") visibility = false;
  const color = cssValue(d, "color");
  // A colour that takes the parent's (inherit, currentcolor, unset) takes it even on a link, whose
  // own default colour it replaces (review round seven).
  if (color !== undefined) {
    transparent = /^(?:inherit|currentcolor|unset)$/.test(color) ? above.transparent : isTransparent(color);
  }
  return { block, font, visibility, transparent, svgNoText, shownAgain: false };
}

// ---------------------------------------------------------------------------------------------
// The walk

/** One link of a mail, as the server read it. */
export interface MailLink {
  /** The link's visible text, or its image's alt text; empty for an image link without alt. */
  text: string;
  /** The address that opens, resolved by the URL standard. */
  url: string;
  /**
   * What to compare `text` with: the host that opens for a web address, the domain of the address
   * for `mailto:`, empty for `tel:` (compare with `url`). Not `url`, which can carry `name@` before
   * the host.
   */
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
  // `https:/x` or `https:x` names a host only without a base address; a page served over the same
  // scheme — Gmail's web client is one — resolves it against its own host. Relative, so not listed
  // (grok-mailwarden, 0.33.0 round, N10).
  const scheme = /^[\s\x00-\x1f]*h[\t\n\r]*t[\t\n\r]*t[\t\n\r]*p[\t\n\r]*s?[\t\n\r]*:([\s\S]*)$/i.exec(href);
  if (scheme && !/^[\t\n\r]*[/\\][\t\n\r]*[/\\]/.test(scheme[1])) return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  return SHOWN_PROTOCOLS.has(url.protocol) ? url : undefined;
}

/**
 * The host of a target, or for `mailto:` the domain of its first address — decoded before the
 * addresses are split, as a mail client reads them, and taken from `?to=` when the path names none.
 */
function hostOf(url: URL): string {
  if (url.protocol !== "mailto:") return url.hostname;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v; // A malformed escape is left as written (review round six).
    }
  };
  let addresses = decode(url.pathname);
  if (addresses.trim() === "") addresses = url.searchParams.get("to") ?? "";
  const first = addresses.split(",")[0] ?? "";
  const at = first.lastIndexOf("@");
  if (at < 0) return "";
  // The domain ends where characters a domain cannot hold begin: `evil.example>` is evil.example.
  return (/^[a-z0-9.[\]:-]*/.exec(first.slice(at + 1).trim().toLowerCase())?.[0] ?? "").replace(/\.$/, "");
}

/** Domain-like words in a link's text: `paypal.com`, `www.bank.example`, `https://x.example/`. */
const DOMAIN_WORD = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;

/**
 * Whether a link deserves to be seen first: hidden text inside it, or text that names a domain the
 * link does not go to (`www.paypal.com` over evil.example). Ordering only; nothing is judged.
 */
function standsOut(link: MailLink): boolean {
  if (link.hiddenText) return true;
  if (link.host === "") return false;
  const bare = (d: string) => d.toLowerCase().replace(/^www\./, "");
  const host = bare(link.host);
  return [...link.text.matchAll(DOMAIN_WORD)].some((m) => {
    const named = bare(m[0]);
    return named !== host && !host.endsWith("." + named) && !named.endsWith("." + host);
  });
}

/** A link being read: its target and what the walk found inside it. */
interface OpenLink {
  url: URL;
  parts: string[];
  shownText: boolean;
  alt: string;
  image: boolean;
  hiddenText: boolean;
  /** For an image map's area: the map it belongs to, which a visible image has to use. */
  map?: string;
}

/** The target of a link element, or undefined for an element that is not a link. */
function linkTargetOf(e: Element): string | undefined {
  if (e.namespaceURI === HTML_NS && (e.tagName === "a" || e.tagName === "area")) return attr(e, "href");
  if (e.namespaceURI === SVG_NS && e.tagName === "a") {
    // SVG 2: a plain href wins over the older xlink:href.
    return attr(e, "href") ?? e.attrs.find((a) => a.name === "href" && a.namespace === XLINK_NS)?.value;
  }
  return undefined;
}

/** The name a `usemap` refers to: it must start with `#`, as the standard's hash-name reference does. */
function usemapName(usemap: string | undefined): string | undefined {
  const v = usemap?.trim();
  return v !== undefined && v.startsWith("#") && v.length > 1 ? v.slice(1) : undefined;
}

/** Text cut to `max` characters by code point, never inside a surrogate pair. */
function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 3).join("") + "..." : s;
}

interface WalkResult {
  hiddenChars: number;
  links: OpenLink[];
  /** Image maps a visible image uses, by name. */
  shownMaps: Set<string>;
}

/** One walk over the parsed mail: hidden text counted, links collected with their visible content. */
function walk(html: string, collectLinks: boolean, limits: ParseLimits): WalkResult | undefined {
  const doc = parseMail(html, limits);
  if (doc === undefined) return undefined;
  const shown = shownByMedia(styleTexts(doc));
  const links: OpenLink[] = [];
  const shownMaps = new Set<string>();
  let hiddenChars = 0;
  // Each entry: node, visibility above it, the innermost link it is inside (index or -1), and the
  // name of the image map it is inside.
  const stack: Array<[Node, Visibility, number, string | undefined]> = [[doc, VISIBLE, -1, undefined]];
  while (stack.length > 0) {
    const [n, above, link, map] = stack.pop()!;
    if (n.nodeName === "#text") {
      const text = (n as DefaultTreeAdapterTypes.TextNode).value;
      const length = tidyRenderedText(text).length;
      if (hidesText(above)) {
        hiddenChars += length;
        if (link >= 0 && length > 0) links[link].hiddenText = true;
      } else if (link >= 0) {
        links[link].parts.push(text);
        if (length > 0) links[link].shownText = true;
      }
      continue;
    }
    let state = above;
    let inside = link;
    let inMap = map;
    if (isElement(n)) {
      if (NOT_SHOWN.has(n.tagName)) continue;
      if (n.tagName === "object" && attr(n, "data") !== undefined) continue;
      state = visibleBelow(n, above, shown);
      if (n.namespaceURI === HTML_NS && n.tagName === "map") inMap = attr(n, "name") ?? attr(n, "id");
      if (n.namespaceURI === HTML_NS && n.tagName === "img" && !hidesImage(state)) {
        const used = usemapName(attr(n, "usemap"));
        if (used !== undefined) shownMaps.add(used);
        if (link >= 0) {
          links[link].image = true;
          if (links[link].alt === "") links[link].alt = tidyRenderedText(attr(n, "alt") ?? "").trim();
        }
      }
      if (link >= 0 && BLOCKS.has(n.tagName)) links[link].parts.push(" ");
      const href = collectLinks ? linkTargetOf(n) : undefined;
      const url = href === undefined ? undefined : browserTarget(href);
      if (url !== undefined) {
        const open: OpenLink = { url, parts: [], shownText: false, alt: "", image: false, hiddenText: false };
        // An image map's area is as visible as an image that uses its map; checked after the walk.
        if (n.tagName === "area") {
          open.map = inMap ?? "";
          if (!hidesImage(state)) {
            open.image = true;
            open.alt = tidyRenderedText(attr(n, "alt") ?? "").trim();
          }
        }
        links.push(open);
        inside = links.length - 1;
      }
      // A closed <details> shows its first <summary> and nothing else.
      if (n.tagName === "details" && n.namespaceURI === HTML_NS && attr(n, "open") === undefined) {
        const kids = childrenOf(n);
        const summary = kids.find((k) => isElement(k) && k.tagName === "summary");
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push([kids[i], kids[i] === summary ? state : { ...state, block: true, shownAgain: false }, inside, inMap]);
        }
        continue;
      }
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], state, inside, inMap]);
  }
  return { hiddenChars, links, shownMaps };
}

/**
 * The links of an HTML body a reader can see, each as `{text, url, host}`, in document order except
 * that links that stand out (`standsOut`) come first:
 * web, mail and phone addresses; an `<a>`, an image map's `<area>` (when a visible image uses the
 * map), or an SVG link. A link shows when visible text or a visible image inside it does; `text` is
 * that text (or the image's alt text), and a link with hidden text inside says `hiddenText`. Each pair
 * of text and address once. At most `MAX_LINKS`; `omitted` counts the rest. `tooComplex` when the
 * parse ran past `NODE_BUDGET`.
 */
export function linksOf(html: string, limits: ParseLimits = LIMITS): { links: MailLink[]; omitted: number; tooComplex?: true } {
  const out: MailLink[] = [];
  if (html === "") return { links: out, omitted: 0 };
  const result = walk(html, true, limits);
  if (result === undefined) return { links: out, omitted: 0, tooComplex: true };
  const seen = new Set<string>();
  const all: MailLink[] = [];
  for (const l of result.links) {
    if (l.map !== undefined && !result.shownMaps.has(l.map)) continue;
    if (!l.shownText && !l.image) continue;
    const text = (l.shownText ? cut(tidyRenderedText(l.parts.join("")).replace(/\s+/g, " ").trim(), MAX_LINK_TEXT) : "") || l.alt;
    const key = `${l.url.href} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({
      text,
      url: l.url.href,
      host: hostOf(l.url),
      ...(l.image ? { image: true as const } : {}),
      ...(l.hiddenText ? { hiddenText: true as const } : {}),
    });
  }
  // The links that stand out come first, so a hundred harmless ones cannot push the one that
  // matters past the cap (grok-mailwarden, 0.33.0 round, M3); each group keeps document order.
  const ordered = [...all.filter(standsOut), ...all.filter((l) => !standsOut(l))];
  return { links: ordered.slice(0, MAX_LINKS), omitted: Math.max(0, ordered.length - MAX_LINKS) };
}

/**
 * How many characters of text an HTML body keeps from its reader; 0 for none, undefined when the
 * body is too complex to read within `NODE_BUDGET`.
 *
 * Counted, never removed, and the reason is measured (24 Nov 2026, 107 HTML mails of one mailbox):
 * a version that removed such text from the renderings took visible text with it — templates hide
 * blocks inline and show them on a phone through an `@media` rule (42 % of a Google Ads mail's
 * text). A count that is sometimes wrong costs a second look; text missing from what a person sees
 * costs the mail.
 *
 * Hidden is what `visibleBelow` says from inline styles. Not hidden: a block whose class or id an
 * `@media` rule for a screen shows again with `!important` (`.name`, `#name`, `[class=name]`), with
 * everything inside it, unless an ancestor is hidden. Not seen: styles from a class outside such a
 * rule, text coloured like its background, positioning off screen, CSS escapes. A newsletter's
 * preview text is hidden the same way for an honest reason, usually under 150 characters: the count
 * is a fact to weigh, not a verdict.
 */
export function hiddenTextLength(html: string, limits: ParseLimits = LIMITS): number | undefined {
  return html === "" ? 0 : walk(html, false, limits)?.hiddenChars;
}

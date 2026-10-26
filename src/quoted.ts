/**
 * Cut the quoted history off a reply, so `get_thread` with `bodies: "new"` returns what the sender
 * actually wrote this time.
 *
 * Asked for on 2026-10-26: with `lastN: 1` a session got only the newest message, and three
 * quarters of its text was the conversation it had just skipped, quoted back underneath ("> ...",
 * "Am ... schrieb ..."). A thread view already has those messages; the quote is redundant there.
 *
 * The rule is conservative on purpose, because a wrong cut silently drops what someone wrote:
 *
 *   - Only TRAILING quoted material is removed. A reply written between quoted lines (an inline
 *     answer) keeps every line that is not itself quoted; only a quoted block at the very end goes.
 *   - The attribution line above that block ("On ... wrote:", "Am ... schrieb ...:", and the same
 *     in a few more languages, also when the client wrapped it over two or three lines) goes with it.
 *   - An Outlook-style history ("-----Original Message-----", or a From/Sent/Subject header block
 *     after an underscore rule) is cut from there, but only when something was written above it.
 *   - A FORWARDED message is content, not history: nothing is cut at or after a "Forwarded
 *     message" marker, in plain text or HTML, even though forwards use the same header blocks.
 *     Outlook writes no such marker, so `trimBodies` also skips the cut for a forward by its
 *     subject (`isForwardSubject`).
 *   - In HTML only a TRAILING quote goes: text after a closed quote, or between its parts, keeps
 *     the whole message.
 *
 * For HTML-only mail the quote is found by the markers the common clients put around it
 * (Gmail's `gmail_quote`, Apple's and Thunderbird's `blockquote type="cite"`, Outlook's
 * `divRplyFwdMsg`/`appendonsend`, Yahoo's `yahoo_quoted`) and cut before the text is rendered.
 *
 * Pure, so a corpus of real reply shapes can hold it.
 */

import { htmlToText } from "./export.js";

export interface Stripped {
  text: string;
  /** True when anything that is not whitespace was removed. */
  stripped: boolean;
}

const FORWARD_MARKER =
  /forwarded message|weitergeleitete nachricht|begin forwarded message|nachricht weitergeleitet|message transf[ée]r[ée]|mensaje reenviado|messaggio inoltrato|doorgestuurd bericht/i;

/**
 * Prefixes that make a subject a forward, by language: Fwd/Fw, WG (German), TR (French), RV
 * (Spanish), ENC (Portuguese), I (Italian), VS/VL (Nordic), Doorst (Dutch), VB.
 */
const FORWARD_PREFIX = /^(fwd?|wg|tr|rv|enc|i|vs|vl|vb|doorst)\s*:/i;

/**
 * Is this message a forward, by the OUTERMOST prefix of its subject? Outlook writes the header of
 * a forward exactly like the header of a reply (an underscore rule and From/Sent/To/Subject, or
 * "Original Message", or `divRplyFwdMsg` in HTML), with no "Forwarded message" line, so the body
 * cannot tell them apart; the subject can (review grok-mailwarden, 26 Oct). "WG: AW: x" forwards a
 * reply and is a forward; "AW: WG: x" answers a forward, whose content is already in the thread.
 * Leading tags such as "[EXT]" are skipped.
 */
export function isForwardSubject(subject: string): boolean {
  return FORWARD_PREFIX.test(subject.replace(/^\s*(\[[^\]]*\]\s*)*/, ""));
}

/**
 * Attribution lines, matched against up to three lines joined with a space. A real one names a
 * date, a time or an address; a sentence of one's own that happens to start with "Am" and end in
 * "schrieb ...:" usually names neither, and it must not go with the quote below it.
 */
const ATTRIBUTION_FACT = /\d|@/;
const ATTRIBUTION = [
  /^On\b.{4,300}\bwrote:$/i, // English (Gmail, Apple Mail, Thunderbird)
  /^Am\b.{4,300}\bschrieb\b.{0,300}:$/i, // German
  /^Le\b.{4,300}\ba [ée]crit ?:$/i, // French
  /^El\b.{4,300}\bescribi[óo]:$/i, // Spanish
  /^Il\b.{4,300}\bha scritto:$/i, // Italian
  /^Op\b.{4,300}\bschreef\b.{0,300}:$/i, // Dutch
];

const ORIGINAL_SEPARATOR =
  /^-{2,}\s*(original message|urspr[üu]ngliche nachricht|message d'origine|mensaje original|messaggio originale|oorspronkelijk bericht)\s*-{2,}$/i;

const HEADER_FROM = /^\*?(from|von|de|da|van)\*?:\s*\S/i;
const HEADER_DATE = /^\*?(sent|gesendet|date|datum|envoy[ée]|enviado|inviato|verzonden)\*?:/i;
const HEADER_SUBJECT = /^\*?(subject|betreff|objet|asunto|oggetto|onderwerp)\*?:/i;

const isQuoted = (line: string) => /^\s*>/.test(line);
const isBlank = (line: string) => line.trim() === "";

/** Is there a forward marker on this line or the three before it? */
function nearForward(lines: string[], i: number): boolean {
  for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 1); k++) {
    if (FORWARD_MARKER.test(lines[k])) return true;
  }
  return false;
}

/** A From/Sent/Subject header block starting at `i` (Outlook's history, also after a rule). */
function headerBlockAt(lines: string[], i: number): boolean {
  if (!HEADER_FROM.test(lines[i].trim())) return false;
  const next = lines.slice(i + 1, i + 7).map((l) => l.trim());
  return next.some((l) => HEADER_DATE.test(l)) && next.some((l) => HEADER_SUBJECT.test(l));
}

/** The first line of an Outlook-style history, or -1. Never at a forward, never with nothing above. */
function outlookCut(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let start = -1;
    if (ORIGINAL_SEPARATOR.test(t)) start = i;
    else if (/^_{10,}$/.test(t)) {
      const j = lines.findIndex((l, k) => k > i && !isBlank(l));
      if (j > 0 && j <= i + 2 && headerBlockAt(lines, j)) start = i;
    } else if (headerBlockAt(lines, i) && (i === 0 || isBlank(lines[i - 1]))) start = i;
    if (start < 0) continue;
    if (nearForward(lines, start)) return -1; // a forward from here on: content, keep all
    if (lines.slice(0, start).every(isBlank)) return -1; // nothing written above it
    return start;
  }
  return -1;
}

/** The start of the trailing `>` block plus its attribution, or -1. */
function trailingQuoteCut(lines: string[]): number {
  let end = lines.length - 1;
  while (end >= 0 && isBlank(lines[end])) end--;
  if (end < 0 || !isQuoted(lines[end])) return -1;
  let start = end;
  while (start > 0 && (isQuoted(lines[start - 1]) || isBlank(lines[start - 1]))) start--;
  // The attribution may be wrapped over up to three lines just above the block.
  let above = start - 1;
  while (above >= 0 && isBlank(lines[above])) above--;
  for (let n = 1; n <= 3 && above - n + 1 >= 0; n++) {
    const joined = lines
      .slice(above - n + 1, above + 1)
      .map((l) => l.trim())
      .join(" ");
    if (ATTRIBUTION_FACT.test(joined) && ATTRIBUTION.some((re) => re.test(joined))) {
      start = above - n + 1;
      break;
    }
  }
  if (nearForward(lines, start)) return -1;
  return start;
}

/** Cut the quoted history off a plain-text reply. */
export function stripQuotedText(text: string): Stripped {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cuts = [outlookCut(lines), trailingQuoteCut(lines)].filter((c) => c >= 0);
  if (cuts.length === 0) return { text, stripped: false };
  const cut = Math.min(...cuts);
  const removed = lines.slice(cut);
  if (removed.every(isBlank)) return { text, stripped: false };
  // A message that is nothing BUT a quote has no "new" part to return; keep it whole rather than
  // answer with an empty body.
  if (lines.slice(0, cut).every(isBlank)) return { text, stripped: false };
  return { text: lines.slice(0, cut).join("\n").trimEnd(), stripped: true };
}

/**
 * Above this size an HTML body is not cut at all: the model gets more text, which is the safe
 * direction, and no single mail can make the walk below expensive.
 */
export const MAX_HTML_CUT = 512 * 1024;

/** Longest tag looked into; a longer one is passed over as markup without meaning here. */
const MAX_TAG = 4096;

/** One tag of an HTML body, found by a single forward walk. */
interface Tag {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
}

/**
 * Every tag of `html` in order, in ONE pass: each `<` is looked at once and the walk only moves
 * forward, so the cost is linear in the body whatever the sender writes. Comments and CDATA are
 * skipped whole, so a `<blockquote>` inside one is not a tag (review grok-mailwarden, 26 Oct).
 * The first version cut with regular expressions that searched from the start again after every
 * removal, and a tag without its `>` made `[^>]*` scan to the end at every position: 19 s for one
 * 1.8 MB mail, blocking every other tool meanwhile.
 */
function* tags(html: string): Generator<Tag> {
  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) return;
    const special = html.startsWith("<!--", lt) ? "-->" : html.startsWith("<![CDATA[", lt) ? "]]>" : null;
    if (special) {
      const close = html.indexOf(special, lt + 4);
      if (close < 0) return;
      pos = close + 3;
      yield { start: lt, end: pos, name: "#comment", closing: false, selfClosing: true, attrs: "" };
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) return; // no tag closes any more: the rest is text
    pos = gt + 1;
    const inner = html.slice(lt + 1, gt);
    // A tag too long to look into is still a tag: markup, and never a quote marker.
    const m = inner.length > MAX_TAG ? null : /^(\/?)([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(inner);
    if (!m) {
      yield { start: lt, end: pos, name: "#other", closing: false, selfClosing: true, attrs: "" };
      continue;
    }
    yield {
      start: lt,
      end: gt + 1,
      name: m[2].toLowerCase(),
      closing: m[1] === "/",
      selfClosing: /\/\s*$/.test(m[3]),
      attrs: m[3],
    };
  }
}

const hasClass = (attrs: string, re: RegExp) => {
  const m = /\bclass\s*=\s*(["'])([^"']*)\1/i.exec(attrs);
  return m !== null && re.test(m[2]);
};

/**
 * Is this tag where a client's quoted history starts? `delimited` says the client closes the
 * quote, so text after it can be told apart from it; Outlook does not: after its header block the
 * old message simply follows, to the end.
 */
function quoteStart(t: Tag): { delimited: boolean } | null {
  if (t.closing) return null;
  if (t.name === "div" && hasClass(t.attrs, /\bgmail_quote\b/)) return { delimited: true };
  if (t.name === "blockquote" && /\btype\s*=\s*["']?cite\b/i.test(t.attrs)) return { delimited: true };
  if (t.name === "div" && /\bid\s*=\s*["']?(divRplyFwdMsg|appendonsend)\b/i.test(t.attrs)) return { delimited: false };
  if (t.name === "div" && hasClass(t.attrs, /\b(yahoo_quoted|moz-cite-prefix)\b/)) return { delimited: true };
  return null;
}

/** Divs that hold only quote: Gmail's and Thunderbird's attribution lines, Yahoo's whole quote. */
const isQuoteDiv = (t: Tag) => t.name === "div" && hasClass(t.attrs, /\b(gmail_attr|moz-cite-prefix|yahoo_quoted)\b/);

/**
 * The visible text of `tail` (the HTML from the quote marker on) outside the quoted parts: cited
 * blocks, attribution lines and a Yahoo quote left out. Text left over was written after or
 * between the quoted parts. `null` when a quoted part is never closed: then where the quote ends
 * cannot be told, and the caller does not cut. Linear, like `tags`.
 *
 * Known limit: Yahoo does not put its quote in a blockquote, so an answer written INSIDE
 * `yahoo_quoted` cannot be told from the quote and goes with it.
 */
function textOutsideQuotes(tail: string): string | null {
  const kept: string[] = [];
  let pos = 0;
  let quote = 0; // open blockquotes and quote divs
  const divs: boolean[] = []; // for each open div: is it a quote div?
  for (const t of tags(tail)) {
    if (quote === 0) kept.push(tail.slice(pos, t.start));
    pos = t.end;
    if (t.name === "#comment") continue;
    if (t.selfClosing) {
      if (quote === 0) kept.push(tail.slice(t.start, t.end));
      continue;
    }
    if (t.name === "blockquote") {
      if (!t.closing) quote++;
      else if (quote > 0) quote--;
    } else if (t.name === "div") {
      if (!t.closing) {
        const q = isQuoteDiv(t);
        divs.push(q);
        if (q) quote++;
      } else if (divs.length > 0 && divs.pop() && quote > 0) quote--;
    } else if (quote === 0) kept.push(tail.slice(t.start, t.end));
  }
  if (quote > 0) return null;
  kept.push(tail.slice(pos));
  return htmlToText(kept.join(""));
}

/** The visible characters of `html`, tags dropped, without a regex that can backtrack. */
function visibleText(html: string): string {
  const out: string[] = [];
  let pos = 0;
  for (const t of tags(html)) {
    out.push(html.slice(pos, t.start));
    pos = t.end;
  }
  out.push(html.slice(pos));
  return out.join(" ").trim();
}

/**
 * Cut the quoted history off an HTML reply, before it is rendered to text. Only a TRAILING quote
 * goes, as in plain text: where the client closes its quote and something visible follows it or
 * sits between its parts (a bottom post, an answer inside Gmail's opened quote, Apple Mail with
 * answers between cited blocks), nothing is cut (review grok-mailwarden, 26 Oct). Outlook does
 * not close its history, so there everything from the marker on goes. A forward marker close
 * behind the quote marker keeps the whole message too, and so does a body over MAX_HTML_CUT.
 */
export function stripQuotedHtml(html: string): { html: string; stripped: boolean } {
  if (html.length > MAX_HTML_CUT) return { html, stripped: false };
  let at = -1;
  let delimited = true;
  for (const t of tags(html)) {
    const q = quoteStart(t);
    if (q) {
      at = t.start;
      delimited = q.delimited;
      break;
    }
  }
  if (at < 0) return { html, stripped: false };
  if (delimited) {
    const outside = textOutsideQuotes(html.slice(at));
    if (outside === null || outside !== "") return { html, stripped: false };
  }
  // Gmail wraps a forward in gmail_quote too; its "---------- Forwarded message ---------" line
  // follows within the first few hundred characters, and above it there is often nothing at all.
  if (FORWARD_MARKER.test(visibleText(html.slice(at, at + 800)))) return { html, stripped: false };
  if (visibleText(html.slice(at)) === "") return { html, stripped: false };
  if (htmlToText(html.slice(0, at)) === "") {
    return { html, stripped: false }; // nothing written above the quote
  }
  return { html: html.slice(0, at), stripped: true };
}

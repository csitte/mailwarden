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
 * Opening tags the common clients put around quoted history in HTML mail. `delimited` says the
 * client closes the quote, so text after it can be told apart from it; Outlook does not: after
 * its header block the old message simply follows, to the end.
 */
const HTML_QUOTE_START: { re: RegExp; delimited: boolean }[] = [
  { re: /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/i, delimited: true },
  { re: /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b[^>]*>/i, delimited: true },
  { re: /<div\b[^>]*\bid\s*=\s*["']?(divRplyFwdMsg|appendonsend)\b[^>]*>/i, delimited: false },
  { re: /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(yahoo_quoted|moz-cite-prefix)\b[^"']*["'][^>]*>/i, delimited: true },
];

/** Index just past the element whose opening tag starts at `start`, or the end if never closed. */
function elementEnd(html: string, start: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

/** Remove every element whose opening tag `open` matches, with all it contains. */
function removeElements(html: string, open: RegExp, tag: string): string {
  const re = new RegExp(open.source, "i");
  for (let m = re.exec(html); m; m = re.exec(html)) {
    html = html.slice(0, m.index) + html.slice(elementEnd(html, m.index, tag));
  }
  return html;
}

/**
 * What of `tail` (the HTML from the quote marker on) is not quote: cited blocks, Gmail's and
 * Thunderbird's attribution lines and a Yahoo quote taken out. Text left over was written after
 * or between the quoted parts.
 */
function textOutsideQuotes(tail: string): string {
  let rest = removeElements(tail, /<blockquote\b[^>]*>/, "blockquote");
  rest = removeElements(rest, /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(gmail_attr|moz-cite-prefix|yahoo_quoted)\b[^"']*["'][^>]*>/, "div");
  return htmlToText(rest);
}

/**
 * Cut the quoted history off an HTML reply, before it is rendered to text. Only a TRAILING quote
 * goes, as in plain text: where the client closes its quote and something visible follows it or
 * sits between its parts (a bottom post, an answer inside Gmail's opened quote, Apple Mail with
 * answers between cited blocks), nothing is cut (review grok-mailwarden, 26 Oct). Outlook does
 * not close its history, so there everything from the marker on goes. A forward marker close
 * behind the quote marker keeps the whole message too.
 */
export function stripQuotedHtml(html: string): { html: string; stripped: boolean } {
  let at = -1;
  let delimited = true;
  for (const q of HTML_QUOTE_START) {
    const m = q.re.exec(html);
    if (m && (at < 0 || m.index < at)) {
      at = m.index;
      delimited = q.delimited;
    }
  }
  if (at < 0) return { html, stripped: false };
  if (delimited && textOutsideQuotes(html.slice(at)) !== "") return { html, stripped: false };
  // Gmail wraps a forward in gmail_quote too; its "---------- Forwarded message ---------" line
  // follows within the first few hundred characters, and above it there is often nothing at all.
  const ahead = html.slice(at, at + 800).replace(/<[^>]*>/g, " ");
  if (FORWARD_MARKER.test(ahead)) return { html, stripped: false };
  const rest = html.slice(at).replace(/<[^>]*>/g, "").trim();
  if (rest === "") return { html, stripped: false };
  if (htmlToText(html.slice(0, at)) === "") {
    return { html, stripped: false }; // nothing written above the quote
  }
  return { html: html.slice(0, at), stripped: true };
}

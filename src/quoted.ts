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

/** Attribution lines, matched against up to three lines joined with a space. */
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
    if (ATTRIBUTION.some((re) => re.test(joined))) {
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

/** Opening tags the common clients put around quoted history in HTML mail. */
const HTML_QUOTE_START = [
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/i,
  /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b[^>]*>/i,
  /<div\b[^>]*\bid\s*=\s*["']?(divRplyFwdMsg|appendonsend)\b[^>]*>/i,
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(yahoo_quoted|moz-cite-prefix)\b[^"']*["'][^>]*>/i,
];

/**
 * Cut the quoted history off an HTML reply, before it is rendered to text. Everything from the
 * first quote marker on is removed — clients put the history at the end — unless a forward marker
 * follows it closely, in which case the "quote" is the forwarded message and stays.
 */
export function stripQuotedHtml(html: string): { html: string; stripped: boolean } {
  let at = -1;
  for (const re of HTML_QUOTE_START) {
    const m = re.exec(html);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) return { html, stripped: false };
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

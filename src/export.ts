/**
 * A thread rendered to a file, so a long conversation can be kept, shared or read in pieces
 * without passing through the model context.
 *
 * Two formats. `markdown` is for people: one section per message with its headers (each in an
 * inline code span, see `codeSpan`), its sender authentication and its attachment list, and
 * the body in a code fence. The fence is
 * chosen longer than any backtick run inside the body, so text the sender wrote — which may
 * contain Markdown, or a fence of its own — cannot close it and render as part of the
 * document. `json` is for programs: the parsed messages as `get_thread` returns them.
 *
 * A message with no plain-text part gets its HTML reduced to text. That reduction is for
 * reading, not for fidelity: it drops markup, scripts and styles, keeps line structure and
 * decodes the common entities, and the JSON export keeps the HTML untouched.
 *
 * Pure, so the rendering can be held by tests.
 */

import type { ParsedMessage } from "./gmail.js";
import { stripHiddenChars } from "./sanitize.js";

export type ExportFormat = "markdown" | "json";

/**
 * The named character references a mail body is likely to carry, as code points. Before 10 Nov
 * 2026 only the six basic ones were decoded, and an HTML-only mail kept `&copy;`, `&euro;` or
 * `f&uuml;r` as written in quotes, forwards and get_thread (seen in a TripLog report). Covered:
 * all of Latin-1 (`&nbsp;` to `&yuml;`, U+00A0 to U+00FF, listed in code point order), the
 * Windows-1252 extras HTML names (dashes, typographic quotes, `&euro;`, `&trade;`, ...) and a few
 * arrows and math signs. Names are case-sensitive, as in HTML (`&Auml;` is not `&auml;`). Code
 * points instead of characters, so the source stays ASCII and no tool can rewrite an escape.
 */
const LATIN1_NAMES = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr " +
  "deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
  "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");
const NAMED_ENTITIES: ReadonlyMap<string, number> = new Map<string, number>([
  ...LATIN1_NAMES.map((name, i): [string, number] => [name, 0xa0 + i]),
  ["OElig", 0x152], ["oelig", 0x153], ["Scaron", 0x160], ["scaron", 0x161], ["Yuml", 0x178],
  ["Zcaron", 0x17d], ["zcaron", 0x17e],
  ["fnof", 0x192], ["circ", 0x2c6], ["tilde", 0x2dc],
  ["ensp", 0x2002], ["emsp", 0x2003], ["thinsp", 0x2009],
  ["zwnj", 0x200c], ["zwj", 0x200d], ["lrm", 0x200e], ["rlm", 0x200f],
  ["ndash", 0x2013], ["mdash", 0x2014], ["lsquo", 0x2018], ["rsquo", 0x2019], ["sbquo", 0x201a],
  ["ldquo", 0x201c], ["rdquo", 0x201d], ["bdquo", 0x201e], ["dagger", 0x2020], ["Dagger", 0x2021],
  ["bull", 0x2022], ["hellip", 0x2026], ["permil", 0x2030], ["prime", 0x2032], ["Prime", 0x2033],
  ["lsaquo", 0x2039], ["rsaquo", 0x203a], ["euro", 0x20ac], ["trade", 0x2122],
  ["larr", 0x2190], ["uarr", 0x2191], ["rarr", 0x2192], ["darr", 0x2193], ["harr", 0x2194],
  ["minus", 0x2212], ["infin", 0x221e], ["asymp", 0x2248], ["ne", 0x2260], ["le", 0x2264], ["ge", 0x2265],
  // HTML also names these two in upper case; AMP, LT, GT and QUOT come from the basic six.
  ["COPY", 0xa9], ["REG", 0xae],
]);

/** The six basic names, decoded in any case as before (`&AMP;`, `&NBSP;`); `&nbsp;` as a plain space. */
const BASIC_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The names a browser decodes without the closing `;`, also as the longest prefix of a longer
 * run of letters (`&copy 2011`, `f&uumlr`, `&notit` -> not-sign + "it"): HTML's legacy set, all of
 * Latin-1 plus amp, lt, gt, quot and their upper-case forms with COPY and REG.
 */
const LEGACY_NAMES: ReadonlySet<string> = new Set([...LATIN1_NAMES, "amp", "lt", "gt", "quot", "AMP", "LT", "GT", "QUOT", "COPY", "REG"]);
const LEGACY_MAX = Math.max(...[...LEGACY_NAMES].map((n) => n.length));

/**
 * A numeric reference to 0x80..0x9F means the Windows-1252 character there, as HTML specifies:
 * `&#150;` is an en dash, `&#128;` the euro sign. Read as code points they are C1 controls, which
 * the hidden-character filter removes, so dashes, typographic quotes and euro signs from older
 * Windows mail simply vanished. The five positions Windows-1252 leaves empty stay as they are.
 */
const WINDOWS_1252: ReadonlyMap<number, number> = new Map<number, number>([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020],
  [0x87, 0x2021], [0x88, 0x2c6], [0x89, 0x2030], [0x8a, 0x160], [0x8b, 0x2039], [0x8c, 0x152],
  [0x8e, 0x17d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022],
  [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x2dc], [0x99, 0x2122], [0x9a, 0x161], [0x9b, 0x203a],
  [0x9c, 0x153], [0x9e, 0x17e], [0x9f, 0x178],
]);

/** One named reference, exactly as written; undefined for a name HTML does not have. */
function namedCharacter(name: string): string | undefined {
  // Own keys only: an object literal would answer `&constructor;` from its prototype, and did,
  // as "function Object() { [native code] }" (review grok-mailwarden, 10 Nov).
  const basic = name.toLowerCase();
  if (Object.hasOwn(BASIC_ENTITIES, basic)) return BASIC_ENTITIES[basic];
  const code = NAMED_ENTITIES.get(name);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/**
 * Decode character references in text the way a browser renders them, in one pass (an escaped
 * `&amp;copy;` stays the text "&copy;"). Numeric ones with or without `;`; 0x80..0x9F through
 * Windows-1252; a surrogate as U+FFFD; zero and anything past U+10FFFF stay as written. Named
 * ones with `;` only by their exact name in the table above; a name it lacks stays as written,
 * since HTML has some two thousand and a prefix match would garble the rest (`&notin;` is not
 * not-sign + "in;", review round 2 for 0.31.1). Without `;` a browser decodes only the legacy
 * names, also as a prefix, and so does this. Pure, linear.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, ref: string, semi: string) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!(code > 0 && code <= 0x10ffff)) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return String.fromCodePoint(0xfffd);
      return String.fromCodePoint(WINDOWS_1252.get(code) ?? code);
    }
    if (semi) return namedCharacter(ref) ?? whole;
    for (let n = Math.min(ref.length, LEGACY_MAX); n >= 2; n--) {
      const head = ref.slice(0, n);
      if (LEGACY_NAMES.has(head)) return (namedCharacter(head) ?? "") + ref.slice(n);
    }
    return whole;
  });
}

/** Reduce an HTML body to readable text. Not a sanitizer: the output is never rendered. */
export function htmlToText(html: string): string {
  // Repeat until nothing changes, so a removal cannot assemble the next block from its
  // remains (`<scr<script></script>ipt>…</script>`). Text after a script's first `</script>`
  // stays, as a browser shows it. The passes are capped: each is linear, and what a deeper
  // nesting leaves is text for a model, never markup a browser runs.
  let s = html;
  for (let pass = 0, prev = ""; prev !== s && pass < 8; pass++) {
    prev = s;
    s = removeBlocks(s, ["script", "style", "head"]);
  }
  // Every scan below stops at the next `<` or at what closes it, never at the end of the body:
  // `[^>]*` and `[\s\S]*?` searched to the end at every unclosed tag, and one mail of tags that
  // never close held get_thread for seconds (review grok-mailwarden, 26 Oct: 9 s for 480 KB).
  // A comment that never closes hides the rest of the body in a browser, so it does here.
  s = cutBetween(s, "<!--", "-->", () => "", true);
  s = cutBetween(s, "<![CDATA[", "]]>", (inner) => inner);
  const text = s
    .replace(/<br\b[^<>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    // Cells of a row apart: without it a booking form read "TypeGuestsBudget" (5 Nov 2026).
    // The cleanup below collapses the space a cell before a row end leaves.
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(/<li\b[^<>]*>/gi, "- ")
    // A tag starts with a letter, `/` or `!`; `a < b and c > d` is text, not a tag.
    .replace(/<[/!]?[a-zA-Z][^<>]*>/g, "");
  return tidyRenderedText(decodeCharacterReferences(text));
}

/**
 * Remove `<name ...>...</name>` blocks for each name, case-insensitively, in one forward walk.
 * A block closes where a browser closes it: at `</name` followed by whitespace, `/` or `>`, so
 * `</scriptx>` inside a script is still script (review grok-mailwarden, round 3: the first
 * version closed there and showed the model what a browser hides). A script or style that never
 * closes runs to the end, as in a browser; a head that never closes is left in place, because a
 * browser closes it implicitly and shows the body that follows, and the walk goes on after it.
 * Known limit: the double-escaped form `<script><!--<script></script>...</script>`, which a
 * browser keeps as one script, is closed at the first `</script>` here, as it was in 0.23.0.
 */
function removeBlocks(s: string, names: string[]): string {
  // ASCII only: a full toLowerCase can change the length ("İ" becomes two characters), and
  // the indices found in `lower` must hold in `s`.
  const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const out: string[] = [];
  let pos = 0;
  // The next opening of each name, looked up again only once the walk has passed it: searching
  // every name from `pos` on each step would re-scan the same gap once per block.
  const next = names.map(() => -2);
  for (;;) {
    let open = -1;
    let name = "";
    names.forEach((n, k) => {
      if (next[k] !== -1 && next[k] < pos) {
        let i = lower.indexOf("<" + n, pos);
        // `<scripts>` is not `<script>`: the name must end there.
        while (i >= 0 && /[a-z0-9]/.test(lower[i + 1 + n.length] ?? "")) i = lower.indexOf("<" + n, i + 1);
        next[k] = i;
      }
      if (next[k] >= 0 && (open < 0 || next[k] < open)) {
        open = next[k];
        name = n;
      }
    });
    if (open < 0) break;
    let close = lower.indexOf("</" + name, open);
    while (close >= 0 && !/[\t\n\f\r />]/.test(lower[close + 2 + name.length] ?? "")) {
      close = lower.indexOf("</" + name, close + 1);
    }
    const end = close < 0 ? -1 : lower.indexOf(">", close);
    if (end < 0) {
      // Give up on the head only, not on the walk: a script after it is still a script
      // (round 4, M5). No later head can close either, there is no `</head` after this one.
      if (name === "head") {
        next[names.indexOf("head")] = -1;
        continue;
      }
      out.push(s.slice(pos, open));
      pos = s.length;
      break;
    }
    out.push(s.slice(pos, open));
    pos = end + 1;
  }
  out.push(s.slice(pos));
  return out.join("");
}

/**
 * Replace each `start ... end` span by `keep(inner)`, in one forward walk. An unclosed one stays,
 * or with `dropUnclosed` takes the rest of the string with it.
 */
function cutBetween(s: string, start: string, end: string, keep: (inner: string) => string, dropUnclosed = false): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const i = s.indexOf(start, pos);
    if (i < 0) break;
    const j = s.indexOf(end, i + start.length);
    if (j < 0) {
      if (dropUnclosed) {
        out.push(s.slice(pos, i));
        return out.join("");
      }
      break;
    }
    out.push(s.slice(pos, i), keep(s.slice(i + start.length, j)));
    pos = j + end.length;
  }
  out.push(s.slice(pos));
  return out.join("");
}

/**
 * Collapse the layout whitespace a rendering inherits from its HTML source. Newsletters and
 * report mails are nested tables indented with tabs, saved with CRLF and padded with invisible
 * characters; reduced to text, a report of two dozen lines arrived as mostly tab runs and empty
 * lines (reported 2026-10-26 for a TripLog weekly mail: the old cleanup matched `[ \t]+\n` and
 * `\n{3,}`, neither of which sees a line ending in `\r\n`). A browser collapses that whitespace
 * when it displays the mail, so collapsing it here loses nothing a reader would have seen.
 *
 * Applied ONLY to text reduced from HTML. A real text/plain part is what the sender typed, and
 * its spacing — an aligned table, an indented quote — is content.
 */
export function tidyRenderedText(s: string): string {
  return stripHiddenChars(s)
    .replace(/͏/g, "") // combining grapheme joiner: preheader padding, invisible on its own
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v  -   　]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A backtick fence longer than any run of backticks in `text`, and at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** One line per header value: a newline in a header must not start a new Markdown line. */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/**
 * A header value as an inline code span: rendered as written, never as a link, an image or
 * emphasis. The sender writes From, Subject and attachment names, and a Markdown preview
 * would otherwise turn `![x](https://tracker/p.png)` in a subject into a remote image that
 * loads when the file is opened. The delimiter is longer than any backtick run inside, and
 * the padding spaces are the ones CommonMark strips, so the value shows unchanged.
 */
export function codeSpan(v: string): string {
  const s = oneLine(v);
  if (s === "") return "";
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = "`".repeat(longest + 1);
  return `${tick} ${s} ${tick}`;
}

function authLine(m: ParsedMessage): string {
  const a = m.authentication;
  if (a.unchecked) return "unchecked (no report from Gmail)";
  const parts = (["spf", "dkim", "dmarc"] as const).filter((k) => a[k]).map((k) => `${k}=${a[k]}`);
  if (a.dkimAligned !== undefined) parts.push(`dkimAligned=${a.dkimAligned}`);
  return parts.length > 0 ? parts.join(", ") : "report present, no result read";
}

/** Render a full thread. `exportedAt` is passed in so the output is reproducible. */
export function renderThread(
  threadId: string,
  messages: ParsedMessage[],
  format: ExportFormat,
  exportedAt: Date,
): string {
  if (format === "json") {
    return JSON.stringify({ threadId, exportedAt: exportedAt.toISOString(), messages }, null, 2) + "\n";
  }
  const subject = codeSpan(messages[0]?.subject ?? "") || "(no subject)";
  const out: string[] = [
    `# ${subject}`,
    "",
    `Thread \`${threadId}\`, ${messages.length} message${messages.length === 1 ? "" : "s"}, exported ${exportedAt.toISOString()}.`,
  ];
  messages.forEach((m, i) => {
    const body = m.plaintextBody.trim() !== "" ? m.plaintextBody.trim() : htmlToText(m.htmlBody);
    const fence = fenceFor(body);
    out.push(
      "",
      "---",
      "",
      `## ${i + 1}. ${codeSpan(m.from) || "(unknown sender)"}`,
      "",
      `- **From:** ${codeSpan(m.from)}`,
      `- **To:** ${codeSpan(m.to)}`,
      `- **Date:** ${codeSpan(m.date)}`,
      `- **Subject:** ${codeSpan(m.subject)}`,
      `- **Sender authentication:** ${authLine(m)}`,
    );
    if (m.attachments.length > 0) {
      out.push(
        `- **Attachments:** ${m.attachments
          .map((a) => `${codeSpan(a.filename)} (${codeSpan(a.mimeType)}, ${a.size} bytes)`)
          .join("; ")}`,
      );
    }
    out.push("", fence + "text", body, fence);
  });
  return out.join("\n") + "\n";
}

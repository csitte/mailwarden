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

/** Reduce an HTML body to readable text. Not a sanitizer: the output is never rendered. */
export function htmlToText(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
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
    .replace(/<li\b[^<>]*>/gi, "- ")
    // A tag starts with a letter, `/` or `!`; `a < b and c > d` is text, not a tag.
    .replace(/<[/!]?[a-zA-Z][^<>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return named[e.toLowerCase()] ?? m;
    });
  return tidyRenderedText(text);
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

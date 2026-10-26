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
  // stays, as a browser shows it.
  let s = html;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  }
  const text = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    // A tag starts with a letter, `/` or `!`; `a < b and c > d` is text, not a tag.
    .replace(/<[/!]?[a-zA-Z][^>]*>/g, "")
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

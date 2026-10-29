/**
 * Drafts — the pure half. Building the MIME message, deriving a reply's recipients from its
 * thread, and deciding when a person has to confirm. No IO here; `gmail.ts` and `tools.ts`
 * call these.
 *
 * What a draft may and may not do follows from one fact: only a person pressing Send in Gmail
 * sends it. So the risk is not that mail leaves, but that a prompt-injected instruction puts
 * something into a draft that the person then sends without reading. Two places matter most:
 *
 *   1. Recipients. An address the thread did not already contain is where an injected mail
 *      could aim a draft at a stranger. Every such address makes the draft need a confirmation
 *      through elicitation, whatever `MAILWARDEN_CONFIRM` says (`needsConfirmation`).
 *   2. Header syntax. A subject or address carrying a line break would add header lines of its
 *      own — a hidden `Bcc:` among them, which would pass point 1 unseen. Every header value is
 *      checked before a byte is built (`checkHeaderValue`), and recipients are re-emitted as bare
 *      addr-specs rather than copied from the thread.
 */

import { domainToASCII } from "node:url";
import { addressesOf } from "./signals.js";
import { ToolError } from "./cli.js";
import { dialogText } from "./confirm.js";

/** The label that marks a draft mailwarden wrote. Only such drafts can be changed later. */
export const DRAFT_LABEL = "MCP/Drafts";

/** Upper bounds: a draft is a message a person reads before sending, not a bulk payload. */
export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_CHARS = 998;
export const MAX_BODY_CHARS = 200_000;

/** A header line terminator, NUL, or any other control character a header value must not carry. */
const HEADER_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/;

/** Refuse a header value that could end its line early. Tabs are folding whitespace and allowed. */
export function checkHeaderValue(field: string, value: string): void {
  if (HEADER_UNSAFE.test(value)) {
    throw new ToolError(
      "invalid_input",
      `${field} contains a line break or control character. A header value must be a single line; nothing was written.`,
    );
  }
}

/** A conservative addr-spec: dot-atom local part, a host of letters, digits and hyphens. */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

/**
 * One recipient as the caller wrote it — `jane@example.com`, or `Jane <jane@example.com>` —
 * reduced to a lowercased bare address. The display name is dropped on purpose: it is free text
 * a dialog would have to show and a header would have to encode, and the address is what decides
 * where the mail goes. An internationalised domain is converted to its ASCII form.
 */
export function normalizeRecipient(input: string): string {
  checkHeaderValue("A recipient", input);
  const trimmed = input.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  const spec = (angle ? angle[1] : trimmed).trim();
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) throw badAddress(input);
  const local = spec.slice(0, at);
  const host = domainToASCII(spec.slice(at + 1).toLowerCase());
  if (!LOCAL.test(local) || local.length > 64 || !host || !HOST.test(host)) throw badAddress(input);
  return `${local}@${host}`.toLowerCase();
}

function badAddress(input: string): ToolError {
  return new ToolError(
    "invalid_input",
    `"${dialogText(input, 80)}" is not an email address mailwarden accepts (name@example.com, optionally as Name <name@example.com>).`,
  );
}

/** Normalise a list, dropping duplicates while keeping the first position of each. */
export function normalizeRecipients(inputs: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const s of inputs ?? []) {
    const a = normalizeRecipient(s);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** The headers of the message being answered — only what a reply needs. */
export interface ReplySource {
  from?: string;
  replyTo?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  references?: string;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Who a reply goes to, read off the message it answers — the same rule a mail client follows:
 * to `Reply-To` if set, else to `From`; when that message is the user's own, to its original
 * `To` instead. `all` adds the other `To`/`Cc` addresses as `Cc`. The user's own addresses are
 * never a recipient. Addresses that do not parse are dropped, never guessed at.
 */
export function replyRecipients(src: ReplySource, own: readonly string[], all: boolean): Recipients {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const parse = (v?: string) => safeAddresses(v).filter((a) => !mine.has(a));
  const fromMe = safeAddresses(src.from).some((a) => mine.has(a));
  const to = fromMe ? parse(src.to) : parse(src.replyTo).length ? parse(src.replyTo) : parse(src.from);
  const cc = all
    ? [...parse(fromMe ? undefined : src.to), ...parse(src.cc)].filter((a) => !to.includes(a))
    : [];
  return { to: dedupe(to), cc: dedupe(cc), bcc: [] };
}

/** `addressesOf`, then the same acceptance check a caller's own address goes through. */
function safeAddresses(value: string | undefined): string[] {
  const out: string[] = [];
  for (const a of addressesOf(value)) {
    try {
      out.push(normalizeRecipient(a));
    } catch {
      // A thread header that does not parse as an address is left out, never repaired.
    }
  }
  return out;
}

const dedupe = (xs: string[]) => [...new Set(xs)];

/** `Re: ` once, the way mail clients do it — not `Re: Re: Re:`. */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").replace(HEADER_UNSAFE_GLOBAL, " ").trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`.trimEnd();
}
const HEADER_UNSAFE_GLOBAL = new RegExp(HEADER_UNSAFE.source, "g");

/**
 * `References` for a reply: the parent's references plus its own Message-ID, as RFC 5322 §3.6.4
 * asks. Only tokens shaped like a msg-id survive, so a hostile header cannot smuggle text in.
 */
export function replyThreading(src: ReplySource): { inReplyTo?: string; references?: string } {
  const ids = (v?: string) => (v ?? "").match(/<[^<>\s]{1,250}@[^<>\s]{1,250}>/g) ?? [];
  const parent = ids(src.messageId)[0];
  if (!parent) return {};
  const refs = dedupe([...ids(src.references), parent]).slice(-20);
  return { inReplyTo: parent, references: refs.join(" ") };
}

/**
 * Whether this draft needs a person's yes regardless of `MAILWARDEN_CONFIRM`: yes as soon as
 * one recipient is not in `known` — the addresses the thread itself supplied for a reply, or the
 * ones the draft already had for an update. A new message has no known addresses, so it always
 * asks. Returns the addresses that triggered it, which is also what the dialog names first.
 */
export function unknownRecipients(r: Recipients, known: readonly string[]): string[] {
  const k = new Set(known.map((a) => a.toLowerCase()));
  return dedupe([...r.to, ...r.cc, ...r.bcc]).filter((a) => !k.has(a));
}

export function checkRecipients(r: Recipients): void {
  const n = r.to.length + r.cc.length + r.bcc.length;
  if (n === 0) {
    throw new ToolError("invalid_input", "A draft needs at least one recipient; nothing was written.");
  }
  if (n > MAX_RECIPIENTS) {
    throw new ToolError(
      "invalid_input",
      `A draft may have at most ${MAX_RECIPIENTS} recipients (got ${n}); nothing was written.`,
    );
  }
}

export function checkContent(subject: string, body: string): void {
  checkHeaderValue("The subject", subject);
  if (subject.length > MAX_SUBJECT_CHARS) {
    throw new ToolError("invalid_input", `The subject is longer than ${MAX_SUBJECT_CHARS} characters.`);
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new ToolError("invalid_input", `The body is longer than ${MAX_BODY_CHARS} characters.`);
  }
}

/** RFC 2047 B-encoding for a non-ASCII header value, in words short enough for one line each. */
export function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  // Split on code points, never inside one, and keep each word's payload under 45 bytes
  // (60 base64 characters) so `=?UTF-8?B?…?=` stays inside the 75-character limit.
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export interface DraftContent extends Recipients {
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * The RFC 5322 message, ready to be base64url-encoded into `raw`. Plain text only, the body
 * base64-encoded so no line of it can be read as anything but body. Every header value has been
 * checked or built here; nothing the caller wrote reaches a header unchecked.
 */
export function buildMime(d: DraftContent): string {
  checkContent(d.subject, d.body);
  checkRecipients(d);
  const lines: string[] = [];
  if (d.to.length) lines.push(`To: ${d.to.join(", ")}`);
  if (d.cc.length) lines.push(`Cc: ${d.cc.join(", ")}`);
  if (d.bcc.length) lines.push(`Bcc: ${d.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderText(d.subject)}`);
  if (d.inReplyTo) {
    checkHeaderValue("In-Reply-To", d.inReplyTo);
    lines.push(`In-Reply-To: ${d.inReplyTo}`);
  }
  if (d.references) {
    checkHeaderValue("References", d.references);
    lines.push(`References: ${d.references}`);
  }
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const body = Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  return [...lines, "", ...(body.match(/.{1,76}/g) ?? [])].join("\r\n") + "\r\n";
}

/** What the confirmation dialog says: the recipients first, new ones marked, then the content. */
export function draftDialog(kind: "reply" | "new" | "update", d: DraftContent, unknown: readonly string[]): string {
  const mark = (a: string) => (unknown.includes(a) ? `${a} (new)` : a);
  const list = (label: string, xs: string[]) => (xs.length ? [`${label}: ${xs.map(mark).join(", ")}`] : []);
  const head =
    kind === "reply"
      ? "mailwarden wants to save a reply draft."
      : kind === "new"
        ? "mailwarden wants to save a draft of a new message."
        : "mailwarden wants to change a draft it wrote.";
  return [
    `${head} It is not sent; you send it yourself from Gmail.`,
    ...list("To", d.to),
    ...list("Cc", d.cc),
    ...list("Bcc", d.bcc),
    `Subject: ${dialogText(d.subject, 120)}`,
    `Text: ${dialogText(d.body, 300)}`,
  ].join("\n");
}

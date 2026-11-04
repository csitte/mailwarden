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

import { randomBytes } from "node:crypto";
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

/**
 * Whether every address in `unknown` is one of the mailbox owner's own (`own`: the authenticated
 * profile's address, compared lower-cased and bare). False for an empty `unknown`, and an `own`
 * entry that is blank or does not parse is ignored, never matched. Exact match only: no
 * `+tag` stripping, no Gmail dot folding — an address that merely looks like the owner's is a
 * stranger. This is all `MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG` looks at (see `selfOnly` in
 * draft-flow.ts): a draft whose only new recipients are the owner's own cannot reach anyone
 * else, so a prompt-injected instruction gains nothing by aiming it there.
 */
export function onlyOwnAddresses(unknown: readonly string[], own: readonly string[]): boolean {
  const mine = new Set<string>();
  for (const a of own) {
    try {
      mine.add(normalizeRecipient(a));
    } catch {
      // not an address: never matches
    }
  }
  return unknown.length > 0 && unknown.every((a) => mine.has(a.toLowerCase()));
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

/** Upper bounds for attachments: Gmail's own limit on what a mail may carry, and a count to match. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_FILENAME_CHARS = 255;

/** Where an attachment came from: a file in MAILWARDEN_ATTACH_DIR, a message in the thread, or the draft itself. */
export type AttachmentSource = "file" | "message" | "kept";

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  source: AttachmentSource;
  /** For a file: its path inside MAILWARDEN_ATTACH_DIR, so the dialog names the real file. */
  origin?: string;
}

/**
 * Extensions Gmail refuses to send (support.google.com/mail/answer/6590). Gmail stores a draft
 * carrying one and only refuses at Send, so they are turned away here, where the reason can still
 * be told. A convenience, not a security boundary: the boundary is the directory.
 */
const BLOCKED_EXTENSIONS = new Set(
  (
    "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex_ exe hta img ins iso isp " +
    "jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd " +
    "wsc wsf wsh xll"
  ).split(" "),
);

/** The type a recipient's client is told, by extension. It decides nothing here; unknown is octet-stream. */
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  json: "application/json",
  ics: "text/calendar",
  vcf: "text/vcard",
  eml: "message/rfc822",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** A bare `type/subtype`, nothing a header line could be bent with. */
export function isMimeType(value: string): boolean {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

export function mimeTypeFor(filename: string): string {
  const ext = extensionOf(filename);
  // Own keys only: `x.constructor` must not find Object's.
  return Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : "application/octet-stream";
}

/**
 * Characters a name must not carry although they encode cleanly: C1 controls, zero-width
 * characters, bidi controls and the BOM. A right-to-left override shows `Rechnung<RLO>fdp.exe`
 * as `Rechnungexe.pdf` in the dialog and in the recipient's client.
 */
/** Half of a UTF-16 pair without its other half: it encodes as U+FFFD, so the name would change. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NAME_INVISIBLE = /[\u0080-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * Refuse a filename that could not be written as a single header parameter or would name a path:
 * empty, a line break or control character, a slash or backslash, `.`/`..`, too long, or a type
 * Gmail will not send. Nothing is repaired — the caller learns what to change.
 */
export function checkFilename(filename: string): void {
  const bad = (why: string) =>
    new ToolError("invalid_input", `The attachment name "${dialogText(filename, 80)}" ${why}; nothing was written.`);
  if (!filename.trim()) throw bad("is empty");
  if (HEADER_UNSAFE.test(filename) || NAME_INVISIBLE.test(filename)) {
    throw bad("contains a line break, a control character or an invisible or direction-changing character");
  }
  if (LONE_SURROGATE.test(filename)) throw bad("contains a broken character (a lone surrogate)");
  // A client that decodes an encoded word inside a parameter would show another name than the dialog.
  if (/=\?[^?]*\?[bq]\?/i.test(filename)) throw bad("looks like an encoded header word (=?…?=)");
  if (/[\\/]/.test(filename)) throw bad("contains a slash; give the name without a path");
  if (filename === "." || filename === "..") throw bad("is not a file name");
  // Windows drops trailing dots and spaces, so `a.exe.` would arrive as `a.exe`.
  if (/[. ]$/.test(filename)) throw bad("ends in a dot or a space");
  if ([...filename].length > MAX_FILENAME_CHARS) throw bad(`is longer than ${MAX_FILENAME_CHARS} characters`);
  if (BLOCKED_EXTENSIONS.has(extensionOf(filename))) {
    throw bad("has a file type Gmail refuses to send (.exe, .js, .bat and similar)");
  }
}

/** The count, the names and the total size, checked before a byte of the message is built. */
export function checkAttachments(list: readonly DraftAttachment[]): void {
  if (list.length > MAX_ATTACHMENTS) {
    throw new ToolError(
      "invalid_input",
      `A draft may carry at most ${MAX_ATTACHMENTS} attachments (got ${list.length}); nothing was written.`,
    );
  }
  for (const a of list) checkFilename(a.filename);
  const total = attachmentBytes(list);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new ToolError(
      "invalid_input",
      `The attachments add up to ${total} bytes, more than Gmail's limit of ${MAX_ATTACHMENT_BYTES} bytes (${formatBytes(MAX_ATTACHMENT_BYTES)}); nothing was written.`,
    );
  }
}

export function attachmentBytes(list: readonly DraftAttachment[]): number {
  return list.reduce((n, a) => n + a.data.length, 0);
}

/** `1.4 MB`, `820 KB`, `12 bytes` — for dialogs and messages, in binary units. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** RFC 5987 attr-char: what may stand unencoded in an extended parameter value. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * A filename as a MIME parameter: quoted when it is plain printable ASCII, otherwise as RFC 2231
 * continuations of UTF-8 percent-encoding, cut into short pieces so no header line grows long and
 * no `%XX` is split. Pure ASCII is the common case and stays readable in the raw message.
 */
export function fileParameter(param: string, filename: string): string[] {
  if (/^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename) && filename.length <= 60) {
    return [`${param}="${filename}"`];
  }
  const tokens: string[] = [];
  for (const byte of Buffer.from(filename, "utf8")) {
    const ch = String.fromCharCode(byte);
    tokens.push(byte < 0x80 && ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  const pieces: string[] = [];
  let piece = "";
  for (const t of tokens) {
    if (piece.length + t.length > 60) {
      pieces.push(piece);
      piece = "";
    }
    piece += t;
  }
  if (piece) pieces.push(piece);
  return pieces.map((p, i) => `${param}*${i}*=${i === 0 ? "UTF-8''" : ""}${p}`);
}

export interface DraftContent extends Recipients {
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  /** Omitted or empty: a plain-text message, byte for byte what it was before attachments existed. */
  attachments?: DraftAttachment[];
}

const base64Lines = (data: Buffer) => data.toString("base64").match(/.{1,76}/g) ?? [];

/**
 * The RFC 5322 message, ready to be base64url-encoded into `raw`. The body is plain text,
 * base64-encoded so no line of it can be read as anything but body. Every header value has been
 * checked or built here; nothing the caller wrote reaches a header unchecked.
 *
 * With attachments the message becomes `multipart/mixed`: the same text part first, then one
 * base64 part per file. The boundary contains `=_`, which no base64 line can — so no part's
 * content can end its part early, whatever the file holds.
 */
export function buildMime(d: DraftContent, boundary = `mailwarden=_${randomBytes(12).toString("hex")}`): string {
  checkContent(d.subject, d.body);
  checkRecipients(d);
  const attachments = d.attachments ?? [];
  checkAttachments(attachments);
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
  lines.push("MIME-Version: 1.0");
  const text = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...base64Lines(Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8")),
  ];
  if (!attachments.length) return [...lines, ...text].join("\r\n") + "\r\n";
  const parts = attachments.map((a) => {
    if (!isMimeType(a.mimeType)) {
      throw new ToolError("invalid_input", `"${dialogText(a.mimeType, 80)}" is not a MIME type; nothing was written.`);
    }
    return [
      `Content-Type: ${a.mimeType};\r\n ${fileParameter("name", a.filename).join(";\r\n ")}`,
      `Content-Disposition: attachment;\r\n ${fileParameter("filename", a.filename).join(";\r\n ")}`,
      "Content-Transfer-Encoding: base64",
      "",
      ...base64Lines(a.data),
    ];
  });
  return (
    [
      ...lines,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...text,
      ...parts.flatMap((p) => [`--${boundary}`, ...p]),
      `--${boundary}--`,
    ].join("\r\n") + "\r\n"
  );
}

/** What the confirmation dialog says: the recipients first, new ones marked, the attachments, then the content. */
export function draftDialog(kind: "reply" | "new" | "update", d: DraftContent, unknown: readonly string[]): string {
  const origin = (a: DraftAttachment) =>
    a.source === "file"
      ? `new, from the file ${dialogText(a.origin ?? a.filename, 120)} on this computer`
      : a.source === "message"
        ? "from a mail in the thread"
        : "already in the draft";
  const files = (d.attachments ?? []).map((a) => `${dialogText(a.filename, 80)} (${formatBytes(a.data.length)}, ${origin(a)})`);
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
    ...(files.length ? [`Attachments: ${files.join("; ")}`] : []),
    `Subject: ${dialogText(d.subject, 120)}`,
    `Text: ${dialogText(d.body, 300)}`,
  ].join("\n");
}

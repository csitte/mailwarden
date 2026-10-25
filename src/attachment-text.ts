import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * The text inside an attachment, for reading it without saving it — pure, so a corpus of crafted
 * archives can hold it.
 *
 * What it reads is decided by the bytes, never by the filename or the declared MIME type a sender
 * wrote: a ZIP signature is a ZIP, a gzip signature is gzip, anything else is text if it decodes as
 * text, and refused otherwise. Archives are the reason this exists — DMARC aggregate reports arrive
 * as XML inside `.zip` or `.gz` — and also the reason for the limits: an attacker controls every
 * byte, so every size here is checked BEFORE it is spent. Declared sizes are not trusted either;
 * decompression is capped by `maxOutputLength`, which stops zlib itself at the limit.
 *
 * Nothing is written to disk and no entry name is ever used as a path, so the usual archive
 * attacks (path traversal, symlinks) have nothing to act on. Archives inside archives are listed,
 * not opened.
 */

export interface AttachmentTextLimits {
  /** Decompressed bytes allowed per entry. */
  maxEntryBytes: number;
  /** Decompressed bytes allowed across one archive. */
  maxTotalBytes: number;
  /** Characters of text returned per entry; the rest is cut and `truncated` set. */
  maxChars: number;
  /** ZIP entries looked at; the rest are counted, not read. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: AttachmentTextLimits = {
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxChars: 100_000,
  maxEntries: 50,
};

export type SkipReason =
  | "binary"
  | "encrypted"
  | "too large"
  | "nested archive"
  | "unsupported compression"
  | "corrupt";

export interface TextEntry {
  name: string;
  /** Decompressed size, when it was read; the declared size otherwise. */
  bytes: number;
  text?: string;
  truncated?: boolean;
  skipped?: SkipReason;
}

export interface AttachmentText {
  format: "text" | "gzip" | "zip";
  entries: TextEntry[];
  /** Entries in the archive that were not looked at because of `maxEntries`. */
  notListed: number;
}

export class AttachmentTextError extends Error {}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

function isZip(b: Buffer): boolean {
  return b.length >= 4 && b.readUInt32LE(0) === ZIP_LOCAL;
}

function isGzip(b: Buffer): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * Decode bytes as text, or return undefined for binary. UTF-16 is recognised by its byte-order
 * mark only; everything else is read as UTF-8 (invalid sequences become U+FFFD). Binary is a NUL
 * byte, or more than one control character in a hundred outside tab, newline, CR, form feed and
 * escape — PDFs, images and Office files all fail this within their first bytes.
 */
export function decodeText(b: Buffer): string | undefined {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  let control = 0;
  for (const byte of body) {
    if (byte === 0) return undefined;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) control++;
  }
  if (body.length > 0 && control * 100 > body.length) return undefined;
  return new TextDecoder("utf-8").decode(body);
}

function textEntry(name: string, data: Buffer, limits: AttachmentTextLimits): TextEntry {
  if (isZip(data) || isGzip(data)) return { name, bytes: data.length, skipped: "nested archive" };
  const text = decodeText(data);
  if (text === undefined) return { name, bytes: data.length, skipped: "binary" };
  if (text.length > limits.maxChars) return { name, bytes: data.length, text: text.slice(0, limits.maxChars), truncated: true };
  return { name, bytes: data.length, text };
}

/** Inflate with zlib stopping at `max` — a RangeError from zlib means the entry is larger than allowed. */
function capped(fn: () => Buffer): Buffer | "too large" | "corrupt" {
  try {
    return fn();
  } catch (e) {
    return e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "too large" : "corrupt";
  }
}

function readZip(b: Buffer, limits: AttachmentTextLimits): AttachmentText {
  // The end-of-central-directory record sits in the last 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new AttachmentTextError("The attachment starts like a ZIP archive but has no central directory.");
  const total = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const entries: TextEntry[] = [];
  let spent = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== ZIP_CENTRAL) {
      throw new AttachmentTextError("The ZIP archive's central directory is damaged.");
    }
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // a directory
    if (entries.length >= limits.maxEntries) {
      return { format: "zip", entries, notListed: total - n };
    }
    const skip = (skipped: SkipReason) => entries.push({ name, bytes: size, skipped });
    if (flags & 0x1) {
      skip("encrypted");
      continue;
    }
    // ZIP64 marks sizes as 0xFFFFFFFF; such an entry is over every limit here anyway.
    if (size === 0xffffffff || compSize === 0xffffffff || size > limits.maxEntryBytes || spent + size > limits.maxTotalBytes) {
      skip("too large");
      continue;
    }
    if (local + 30 > b.length || b.readUInt32LE(local) !== ZIP_LOCAL) {
      skip("corrupt");
      continue;
    }
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + compSize > b.length) {
      skip("corrupt");
      continue;
    }
    const raw = b.subarray(start, start + compSize);
    // The declared size is the attacker's number: the inflate cap is what actually holds.
    const remaining = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - spent);
    const data =
      method === 0
        ? raw.length > remaining
          ? "too large"
          : raw
        : method === 8
          ? capped(() => inflateRawSync(raw, { maxOutputLength: remaining }))
          : undefined;
    if (data === undefined) {
      skip("unsupported compression");
      continue;
    }
    if (typeof data === "string") {
      skip(data);
      continue;
    }
    spent += data.length;
    entries.push(textEntry(name, data, limits));
  }
  return { format: "zip", entries, notListed: 0 };
}

/**
 * Read an attachment's bytes as text: plain text, one gzip member, or the text entries of a ZIP
 * archive. Throws `AttachmentTextError` for an attachment with no text in it at all (binary, or an
 * archive whose structure cannot be read); an archive with some unreadable entries is returned with
 * those entries marked `skipped`.
 */
export function attachmentText(
  bytes: Buffer,
  name: string,
  limits: AttachmentTextLimits = DEFAULT_LIMITS,
): AttachmentText {
  if (isZip(bytes)) return readZip(bytes, limits);
  if (isGzip(bytes)) {
    const data = capped(() => gunzipSync(bytes, { maxOutputLength: limits.maxEntryBytes }));
    if (data === "too large") {
      throw new AttachmentTextError(`The gzip attachment unpacks to more than ${limits.maxEntryBytes} bytes; save it with download_attachment instead.`);
    }
    if (data === "corrupt") throw new AttachmentTextError("The attachment starts like gzip but does not decompress.");
    const inner = name.replace(/\.gz$/i, "") || name;
    return { format: "gzip", entries: [textEntry(inner, data, limits)], notListed: 0 };
  }
  const entry = textEntry(name, bytes, limits);
  if (entry.skipped) {
    throw new AttachmentTextError(
      "This attachment is not text (a PDF, image, Office file or other binary format); save it with download_attachment instead.",
    );
  }
  return { format: "text", entries: [entry], notListed: 0 };
}

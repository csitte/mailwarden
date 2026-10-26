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
  /**
   * Characters of text returned in ONE answer, across all entries; the rest is cut, `truncated`
   * set and `nextOffset` named. A whole-answer budget, not a per-entry one: a per-entry cap of
   * 100,000 let a single entry overflow the client (2026-10-26, a 96 KB HTML report beside the
   * 3 KB CSV that was wanted), and two entries at the cap doubled it.
   */
  maxChars: number;
  /** ZIP entries looked at; the rest are counted, not read. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: AttachmentTextLimits = {
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxChars: 50_000,
  maxEntries: 50,
};

/** The most `maxChars` a caller may ask for. */
export const MAX_CHARS_CEILING = 100_000;

/** What the caller asked to see. All optional; the default is every entry's text within the budget. */
export interface ReadOptions {
  /**
   * Only the ZIP entries whose name matches: an exact name, or a pattern with `*` and `?`, matched
   * case-insensitively against the full path and against the bare file name, so `*.csv` finds
   * `export/trips.csv`. Entries that do not match are counted in `notSelected` and never inflated.
   */
  entry?: string;
  /** Names, sizes and text lengths only — what is inside, before choosing what to read. */
  list?: boolean;
  /** Character budget for this answer (see `AttachmentTextLimits.maxChars`). */
  maxChars?: number;
  /** Continue ONE entry's text from this character, as `nextOffset` named it. */
  offset?: number;
}

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
  /** Length of the entry's whole text, whatever part of it this answer carries. */
  chars?: number;
  text?: string;
  truncated?: boolean;
  /** Where to continue with `offset` (and this entry selected) when `truncated`. */
  nextOffset?: number;
  skipped?: SkipReason;
}

export interface AttachmentText {
  format: "text" | "gzip" | "zip";
  entries: TextEntry[];
  /** Entries in the archive that were not looked at because of `maxEntries`. */
  notListed: number;
  /** Entries that did not match `entry`; present only when `entry` was given. */
  notSelected?: number;
  /** Present when the answer is a listing without text. */
  list?: true;
}

/** An entry as read, before the answer is cut to its budget. */
type RawEntry = { name: string; bytes: number; text?: string; skipped?: SkipReason };

/**
 * Compile an `entry` selector. Exact names compare case-insensitively; `*` matches any run of
 * characters except `/`, `?` exactly one. Either way the full path OR the bare file name may
 * match. Exported for tests.
 */
export function entryMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim().toLowerCase();
  const base = (n: string) => n.slice(n.lastIndexOf("/") + 1);
  if (!/[*?]/.test(p)) return (n) => n.toLowerCase() === p || base(n).toLowerCase() === p;
  const re = new RegExp(
    "^" +
      [...p]
        .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );
  return (n) => re.test(n.toLowerCase()) || re.test(base(n).toLowerCase());
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

function textEntry(name: string, data: Buffer): RawEntry {
  if (isZip(data) || isGzip(data)) return { name, bytes: data.length, skipped: "nested archive" };
  const text = decodeText(data);
  if (text === undefined) return { name, bytes: data.length, skipped: "binary" };
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

function readZip(
  b: Buffer,
  limits: AttachmentTextLimits,
  selected: (name: string) => boolean,
): { entries: RawEntry[]; notListed: number; notSelected: number } {
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
  const entries: RawEntry[] = [];
  let spent = 0;
  let notSelected = 0;
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
    if (!selected(name)) {
      notSelected++; // not inflated, not counted against any budget
      continue;
    }
    if (entries.length >= limits.maxEntries) {
      return { entries, notListed: total - n, notSelected };
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
    entries.push(textEntry(name, data));
  }
  return { entries, notListed: 0, notSelected };
}

/**
 * Cut the read entries to what one answer carries. Pure. `offset` applies to the single text
 * entry it continues; the budget is shared across entries in archive order.
 */
function shape(entries: RawEntry[], opts: ReadOptions, budget: number): TextEntry[] {
  const offset = opts.offset ?? 0;
  let left = budget;
  return entries.map((e) => {
    if (e.text === undefined) return { name: e.name, bytes: e.bytes, skipped: e.skipped };
    const chars = e.text.length;
    if (opts.list) return { name: e.name, bytes: e.bytes, chars };
    if (offset > chars) {
      throw new AttachmentTextError(`offset ${offset} is past the end of ${e.name}, which has ${chars} characters.`);
    }
    const text = e.text.slice(offset, offset + left);
    left -= text.length;
    const end = offset + text.length;
    return end < chars
      ? { name: e.name, bytes: e.bytes, chars, text, truncated: true, nextOffset: end }
      : { name: e.name, bytes: e.bytes, chars, text };
  });
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
  opts: ReadOptions = {},
): AttachmentText {
  const budget = Math.min(opts.maxChars ?? limits.maxChars, MAX_CHARS_CEILING);
  const raw = readRaw(bytes, name, limits, opts);
  if (opts.entry !== undefined && raw.entries.length === 0) {
    throw new AttachmentTextError(
      `No entry of this archive matches "${opts.entry}". Call again with list: true to see its entries.`,
    );
  }
  if ((opts.offset ?? 0) > 0 && raw.entries.filter((e) => e.text !== undefined).length !== 1) {
    throw new AttachmentTextError(
      "offset continues ONE entry's text. Select that entry with `entry` (its name, as listed) and pass the nextOffset it returned.",
    );
  }
  return {
    format: raw.format,
    entries: shape(raw.entries, opts, budget),
    notListed: raw.notListed,
    ...(opts.entry !== undefined ? { notSelected: raw.notSelected } : {}),
    ...(opts.list ? { list: true as const } : {}),
  };
}

function readRaw(
  bytes: Buffer,
  name: string,
  limits: AttachmentTextLimits,
  opts: ReadOptions,
): { format: AttachmentText["format"]; entries: RawEntry[]; notListed: number; notSelected: number } {
  if (isZip(bytes)) {
    const sel = opts.entry !== undefined ? entryMatcher(opts.entry) : () => true;
    return { format: "zip", ...readZip(bytes, limits, sel) };
  }
  // A plain or gzip file has one entry. `entry` names a member of an archive; asked of a file that
  // is not one, it is an error rather than silently ignored.
  if (opts.entry !== undefined) {
    throw new AttachmentTextError(
      `entry selects inside a ZIP archive, and this attachment is ${isGzip(bytes) ? "a single gzip file" : "not an archive"}. Call again without entry.`,
    );
  }
  if (isGzip(bytes)) {
    const data = capped(() => gunzipSync(bytes, { maxOutputLength: limits.maxEntryBytes }));
    if (data === "too large") {
      throw new AttachmentTextError(`The gzip attachment unpacks to more than ${limits.maxEntryBytes} bytes; save it with download_attachment instead.`);
    }
    if (data === "corrupt") throw new AttachmentTextError("The attachment starts like gzip but does not decompress.");
    const inner = name.replace(/\.gz$/i, "") || name;
    return { format: "gzip", entries: [textEntry(inner, data)], notListed: 0, notSelected: 0 };
  }
  const entry = textEntry(name, bytes);
  if (entry.skipped) {
    throw new AttachmentTextError(
      "This attachment is not text (a PDF, image, Office file or other binary format); save it with download_attachment instead.",
    );
  }
  return { format: "text", entries: [entry], notListed: 0, notSelected: 0 };
}

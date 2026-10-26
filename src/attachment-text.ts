import { isUtf8 } from "node:buffer";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { decodeCharset } from "./charset.js";

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
   * 3 KB CSV that was wanted), and two entries at the cap doubled it. The default is 30,000, not
   * 50,000: a 50,000-character answer of HTML came to 50.6 KB as JSON and Claude Code put it in a
   * file instead of the conversation (xorino-product, 26 Oct). Only that one point is measured, and
   * escapes and multi-byte letters make the JSON larger than the text, hence the margin.
   */
  maxChars: number;
  /** ZIP entries looked at; the rest are counted, not read. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: AttachmentTextLimits = {
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxChars: 30_000,
  maxEntries: 50,
};

/**
 * Longest entry name an answer carries. A ZIP name may be 65,535 bytes and the sender picks it;
 * a hundred of them (entries plus notSelectedNames) made an answer of 6.5 million characters while
 * `maxChars` held, because the budget counts text only (review grok-mailwarden, 26 Oct). Longer
 * names are cut, marked `nameTruncated` with their `nameLength`, and still match by pattern.
 */
export const MAX_NAME_CHARS = 256;

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
  /** Set when the bytes were not UTF-8 and were read as windows-1252 instead (a guess). */
  guessedCharset?: "windows-1252";
  /** Set when `name` was cut to MAX_NAME_CHARS; `nameLength` is the whole name's length. */
  nameTruncated?: true;
  nameLength?: number;
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
  /** Their names, the first `maxEntries` of them; present when `notSelected` is above zero. */
  notSelectedNames?: string[];
  /** Present when the answer is a listing without text. */
  list?: true;
}

/** An entry as read, before the answer is cut to its budget. */
type RawEntry = { name: string; bytes: number; text?: string; skipped?: SkipReason; guessedCharset?: "windows-1252" };

/**
 * Compile an `entry` selector. Exact names compare case-insensitively; `*` matches any run of
 * characters except `/`, `?` exactly one. Either way the full path OR the bare file name may
 * match. Exported for tests.
 */
export function entryMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim().toLowerCase();
  const base = (n: string) => n.slice(n.lastIndexOf("/") + 1);
  if (!/[*?]/.test(p)) return (n) => n.toLowerCase() === p || base(n).toLowerCase() === p;
  return (n) => globMatch(p, n.toLowerCase()) || globMatch(p, base(n).toLowerCase());
}

/**
 * `*` and `?` never cross a `/`, so a pattern matches only a name with the same number of path
 * segments, segment by segment. Within a segment the usual two-pointer walk with a return to the
 * last star: no regex, because a regex of several `[^/]*` backtracks cubically on a long near-miss
 * name, and the sender chooses the name (review grok-mailwarden, 26 Oct: 130 s for one 8 KB name).
 */
function globMatch(pattern: string, name: string): boolean {
  const ps = pattern.split("/");
  const ns = name.split("/");
  return ps.length === ns.length && ps.every((seg, i) => segmentMatch(seg, ns[i]));
}

function segmentMatch(p: string, s: string): boolean {
  let i = 0; // into s
  let j = 0; // into p
  let star = -1; // position in p of the last star
  let mark = 0; // position in s where that star started matching
  while (i < s.length) {
    if (j < p.length && (p[j] === "?" || p[j] === s[i])) {
      i++;
      j++;
    } else if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

/** An entry name as an answer carries it: whole, or cut to MAX_NAME_CHARS and marked. */
function shownName(name: string): { name: string; nameTruncated?: true; nameLength?: number } {
  return name.length <= MAX_NAME_CHARS
    ? { name }
    : { name: name.slice(0, MAX_NAME_CHARS - 1) + "…", nameTruncated: true, nameLength: name.length };
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
 * mark only; everything else is read as UTF-8, and bytes that are not valid UTF-8 as windows-1252
 * (see `guessesWindows1252`): a CSV that Excel exports on Windows is the common case, and read as
 * UTF-8 every umlaut in it became U+FFFD without a word (review grok-mailwarden, 26 Oct). Binary is a NUL
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
  return isUtf8(body) ? new TextDecoder("utf-8").decode(body) : decodeCharset(body, "windows-1252");
}

/** Would `decodeText` read these bytes as windows-1252: no UTF-16 byte-order mark, not valid UTF-8? */
export function guessesWindows1252(b: Buffer): boolean {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return false;
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  return !isUtf8(body);
}

function textEntry(name: string, data: Buffer): RawEntry {
  if (isZip(data) || isGzip(data)) return { name, bytes: data.length, skipped: "nested archive" };
  const text = decodeText(data);
  if (text === undefined) return { name, bytes: data.length, skipped: "binary" };
  return guessesWindows1252(data) ? { name, bytes: data.length, text, guessedCharset: "windows-1252" } : { name, bytes: data.length, text };
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
): { entries: RawEntry[]; notListed: number; notSelected: number; notSelectedNames: string[] } {
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
  let notListed = 0;
  const notSelectedNames: string[] = [];
  // Central headers may all point at one local header: one bomb, inflated once per header.
  const localsRead = new Set<number>();
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== ZIP_CENTRAL) {
      // Past the limit only the counts are at stake: keep the entries read and count the rest of
      // the directory as unseen. An upper bound: what lies there cannot be told apart any more.
      if (entries.length >= limits.maxEntries) {
        notListed += total - n;
        break;
      }
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
    // A directory has no data. A "directory" that has some is listed as corrupt, so that `list`
    // shows everything the archive holds. Two compressed bytes are an empty deflate stream.
    if (name.endsWith("/") && size === 0 && compSize <= 2) continue;
    if (!selected(name)) {
      notSelected++; // not inflated, not counted against any budget
      if (notSelectedNames.length < limits.maxEntries) notSelectedNames.push(name);
      continue;
    }
    // Past the limit the rest of the directory is still walked, header by header and never
    // inflated, so that notListed counts only selected files and notSelected stays exact.
    if (entries.length >= limits.maxEntries) {
      notListed++;
      continue;
    }
    const skip = (skipped: SkipReason) => entries.push({ name, bytes: size, skipped });
    if (name.endsWith("/")) {
      skip("corrupt");
      continue;
    }
    if (flags & 0x1) {
      skip("encrypted");
      continue;
    }
    // ZIP64 marks sizes as 0xFFFFFFFF; such an entry is over every limit here anyway.
    if (size === 0xffffffff || compSize === 0xffffffff || size > limits.maxEntryBytes || spent + size > limits.maxTotalBytes) {
      skip("too large");
      continue;
    }
    if (local + 30 > b.length || b.readUInt32LE(local) !== ZIP_LOCAL || localsRead.has(local)) {
      skip("corrupt");
      continue;
    }
    localsRead.add(local);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + compSize > b.length) {
      skip("corrupt");
      continue;
    }
    const raw = b.subarray(start, start + compSize);
    // The declared size is the attacker's number: the inflate cap is what actually holds.
    const remaining = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - spent);
    if (remaining <= 0) {
      skip("too large");
      continue;
    }
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
      // An inflate stopped at the cap did that much work; it counts like a read, or a run of
      // oversized entries would each inflate up to the entry cap for free.
      if (data === "too large" && method === 8) spent += remaining;
      skip(data);
      continue;
    }
    spent += data.length;
    entries.push(textEntry(name, data));
  }
  return { entries, notListed, notSelected, notSelectedNames };
}

/**
 * Cut the read entries to what one answer carries. Pure. `offset` applies to the single text
 * entry it continues; the budget is shared across entries in archive order.
 */
function shape(entries: RawEntry[], opts: ReadOptions, budget: number): TextEntry[] {
  const offset = opts.offset ?? 0;
  let left = budget;
  return entries.map((e) => {
    const named = { ...shownName(e.name), bytes: e.bytes, ...(e.guessedCharset ? { guessedCharset: e.guessedCharset } : {}) };
    if (e.text === undefined) return { ...named, skipped: e.skipped };
    const chars = e.text.length;
    if (opts.list) return { ...named, chars };
    if (offset > chars) {
      throw new AttachmentTextError(`offset ${offset} is past the end of ${named.name}, which has ${chars} characters.`);
    }
    const text = e.text.slice(offset, offset + left);
    left -= text.length;
    const end = offset + text.length;
    return end < chars ? { ...named, chars, text, truncated: true, nextOffset: end } : { ...named, chars, text };
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
    ...(opts.entry !== undefined && raw.notSelected > 0 ? { notSelectedNames: raw.notSelectedNames.map((n) => shownName(n).name) } : {}),
    ...(opts.list ? { list: true as const } : {}),
  };
}

function readRaw(
  bytes: Buffer,
  name: string,
  limits: AttachmentTextLimits,
  opts: ReadOptions,
): {
  format: AttachmentText["format"];
  entries: RawEntry[];
  notListed: number;
  notSelected: number;
  notSelectedNames: string[];
} {
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
    return { format: "gzip", entries: [textEntry(inner, data)], notListed: 0, notSelected: 0, notSelectedNames: [] };
  }
  const entry = textEntry(name, bytes);
  if (entry.skipped) {
    throw new AttachmentTextError(
      "This attachment is not text (a PDF, image, Office file or other binary format); save it with download_attachment instead.",
    );
  }
  return { format: "text", entries: [entry], notListed: 0, notSelected: 0, notSelectedNames: [] };
}

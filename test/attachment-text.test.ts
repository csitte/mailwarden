import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { fenceOutput, sanitizeStructured } from "../src/sanitize.js";
import {
  attachmentText,
  decodeText,
  guessesWindows1252,
  entryMatcher,
  AttachmentTextError,
  MAX_NAME_CHARS,
  DEFAULT_LIMITS,
  MAX_CHARS_CEILING,
  type AttachmentTextLimits,
} from "../src/attachment-text.js";

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8 | 12;
  encrypted?: boolean;
  /** Lie about the uncompressed size in the central directory. */
  declaredSize?: number;
  utf8Name?: boolean;
}

/** A minimal ZIP writer: local headers, central directory, end record — enough to craft hostile archives. */
function zip(entries: ZipEntry[], opts: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, e.utf8Name ? "utf8" : "latin1");
    const flags = (e.encrypted ? 0x1 : 0) | (e.utf8Name ? 0x800 : 0);
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}

const DMARC = '<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name></report_metadata></feedback>';
const small: AttachmentTextLimits = { maxEntryBytes: 1000, maxTotalBytes: 1500, maxChars: 50, maxEntries: 3 };

describe("decodeText — text or not, by the bytes", () => {
  it.each<[string, Buffer, string | undefined]>([
    ["UTF-8", Buffer.from("Grüße für März"), "Grüße für März"],
    ["UTF-8 with BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2")]), "a,b\n1,2"],
    ["UTF-16LE with BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]), "hi"],
    ["UTF-16BE with BOM", Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), "hi"],
    ["tabs, CR, form feed and ESC are text", Buffer.from("a\tb\r\n\f\x1b[0m"), "a\tb\r\n\f\x1b[0m"],
    ["empty", Buffer.alloc(0), ""],
    ["a NUL byte is binary", Buffer.from("PDF\x00data"), undefined],
    ["a PDF header is binary", Buffer.from("%PDF-1.7\n\x01\x02\x03\x04\x05binary"), undefined],
    ["PNG signature", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), undefined],
  ])("%s", (_n, b, exp) => expect(decodeText(b)).toBe(exp));

  // Review grok-mailwarden, 26 Oct (N1): an Excel CSV exported on Windows is windows-1252.
  it("reads bytes that are not UTF-8 as windows-1252, and says it guessed", () => {
    const cp1252 = Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x3b, 0x38, 0x30, 0x20, 0x80]); // "Müller;80 €"
    expect(decodeText(cp1252)).toBe("Müller;80 €");
    expect(guessesWindows1252(cp1252)).toBe(true);
    const r = attachmentText(cp1252, "export.csv");
    expect(r.entries[0]).toMatchObject({ text: "Müller;80 €", guessedCharset: "windows-1252" });
    // UTF-8, with or without a BOM, and UTF-16 with its mark are no guess.
    for (const b of [Buffer.from("Müller"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Müller")]), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Müller", "utf16le")])]) {
      expect(guessesWindows1252(b)).toBe(false);
      expect(attachmentText(b, "x.csv").entries[0]).not.toHaveProperty("guessedCharset");
    }
  });

  // Review round 2 (N10): one broken byte must not turn a UTF-8 file into mojibake.
  it("keeps UTF-8 with a single broken byte as UTF-8, and guesses nothing", () => {
    const b = Buffer.concat([Buffer.from("Müller;Größe;Straße\n"), Buffer.from([0xff])]);
    expect(guessesWindows1252(b)).toBe(false);
    const text = decodeText(b)!;
    expect(text.startsWith("Müller;Größe;Straße")).toBe(true);
    expect(attachmentText(b, "x.csv").entries[0]).not.toHaveProperty("guessedCharset");
  });

  it("a windows-1252 entry inside a ZIP is guessed the same way", () => {
    const r = attachmentText(zip([{ name: "a.csv", data: Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]) }]), "a.zip");
    expect(r.entries[0]).toMatchObject({ text: "Grüße", guessedCharset: "windows-1252" });
  });

  it("lets an odd control character through in a long text, but not many", () => {
    expect(decodeText(Buffer.from("x".repeat(200) + "\x07"))).toBeDefined();
    expect(decodeText(Buffer.from("x".repeat(20) + "\x07\x07\x07"))).toBeUndefined();
  });
});

describe("attachmentText — plain and gzip", () => {
  it("reads plain text, whatever the declared name", () => {
    expect(attachmentText(Buffer.from("a,b\n1,2\n"), "report.pdf")).toEqual({
      format: "text",
      entries: [{ name: "report.pdf", bytes: 8, chars: 8, text: "a,b\n1,2\n" }],
      notListed: 0,
    });
  });

  it("refuses binary with a pointer to download_attachment", () => {
    expect(() => attachmentText(Buffer.from("%PDF\x00"), "x.txt")).toThrow(AttachmentTextError);
    expect(() => attachmentText(Buffer.from("%PDF\x00"), "x.txt")).toThrow(/download_attachment/);
  });

  it("truncates long text and says so", () => {
    const r = attachmentText(Buffer.from("y".repeat(80)), "log.txt", small);
    expect(r.entries[0]).toMatchObject({ truncated: true, bytes: 80 });
    expect(r.entries[0].text).toHaveLength(50);
  });

  it("unpacks a gzip DMARC report and names it without the .gz", () => {
    const r = attachmentText(gzipSync(DMARC), "google.com!x.example!1!2.xml.gz");
    expect(r.format).toBe("gzip");
    expect(r.entries[0]).toMatchObject({ name: "google.com!x.example!1!2.xml", text: DMARC });
  });

  it("stops a gzip bomb at the limit instead of unpacking it", () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x61));
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => attachmentText(bomb, "bomb.gz")).toThrow(/more than/);
  });

  it("says a broken gzip is broken", () => {
    expect(() => attachmentText(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]), "x.gz")).toThrow(/does not decompress/);
  });
});

describe("attachmentText — ZIP", () => {
  it("reads every text entry, deflated or stored, and skips directories", () => {
    const r = attachmentText(
      zip([
        { name: "reports/", data: Buffer.alloc(0), method: 0 },
        { name: "reports/a.xml", data: Buffer.from(DMARC) },
        { name: "notes.txt", data: Buffer.from("stored"), method: 0 },
      ]),
      "dmarc.zip",
    );
    expect(r.format).toBe("zip");
    expect(r.entries.map((e) => [e.name, e.text])).toEqual([
      ["reports/a.xml", DMARC],
      ["notes.txt", "stored"],
    ]);
  });

  it("decodes a UTF-8 entry name when the archive says it is UTF-8", () => {
    const r = attachmentText(zip([{ name: "Bericht März.csv", data: Buffer.from("x"), utf8Name: true }]), "a.zip");
    expect(r.entries[0].name).toBe("Bericht März.csv");
  });

  it("finds the central directory behind an archive comment", () => {
    const r = attachmentText(zip([{ name: "a.txt", data: Buffer.from("ok") }], { comment: "c".repeat(1000) }), "a.zip");
    expect(r.entries[0].text).toBe("ok");
  });

  it("marks binary, encrypted, nested and unsupported entries instead of opening them", () => {
    const r = attachmentText(
      zip([
        { name: "a.pdf", data: Buffer.from("%PDF\x00") },
        { name: "secret.txt", data: Buffer.from("x"), encrypted: true },
        { name: "inner.zip", data: zip([{ name: "x.txt", data: Buffer.from("x") }]) },
        { name: "inner.gz", data: gzipSync("x") },
        { name: "b.txt", data: Buffer.from("bzip2"), method: 12 },
      ]),
      "a.zip",
    );
    expect(r.entries.map((e) => [e.name, e.skipped])).toEqual([
      ["a.pdf", "binary"],
      ["secret.txt", "encrypted"],
      ["inner.zip", "nested archive"],
      ["inner.gz", "nested archive"],
      ["b.txt", "unsupported compression"],
    ]);
  });

  it("skips an entry that declares more than the limit without inflating it", () => {
    const r = attachmentText(zip([{ name: "big.txt", data: Buffer.from("x"), declaredSize: 2000 }]), "a.zip", small);
    expect(r.entries[0]).toEqual({ name: "big.txt", bytes: 2000, skipped: "too large" });
  });

  it("does not trust a declared size: an entry that lies small is stopped at the cap", () => {
    // 5 MB of 'a' that claims to be 10 bytes.
    const r = attachmentText(zip([{ name: "liar.txt", data: Buffer.alloc(5 * 1024 * 1024, 0x61), declaredSize: 10 }]), "a.zip", small);
    expect(r.entries[0]).toMatchObject({ name: "liar.txt", skipped: "too large" });
  });

  it("holds the per-archive budget across entries", () => {
    const part = Buffer.from("z".repeat(900));
    const r = attachmentText(zip([{ name: "1.txt", data: part }, { name: "2.txt", data: part }]), "a.zip", small);
    expect(r.entries.map((e) => e.skipped)).toEqual([undefined, "too large"]);
  });

  it("looks at maxEntries entries and counts the rest", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, data: Buffer.from(String(i)) }));
    const r = attachmentText(zip(many), "a.zip", small);
    expect(r.entries).toHaveLength(3);
    expect(r.notListed).toBe(2);
  });

  it("past maxEntries, notListed counts only selected entries and notSelected keeps counting", () => {
    // Five that match, then a directory and two that do not. The walk used to stop at the limit:
    // notListed was total minus position (directory and non-matches included) and the two
    // non-matches behind it were never counted in notSelected.
    const r = attachmentText(
      zip([
        ...Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, data: Buffer.from(String(i)) })),
        { name: "sub/", data: Buffer.alloc(0) },
        { name: "a.csv", data: Buffer.from("a") },
        { name: "b.csv", data: Buffer.from("b") },
      ]),
      "a.zip",
      small,
      { entry: "*.txt" },
    );
    expect(r.entries.map((e) => e.name)).toEqual(["0.txt", "1.txt", "2.txt"]);
    expect(r.notListed).toBe(2);
    expect(r.notSelected).toBe(2);
    expect(r.notSelectedNames).toEqual(["a.csv", "b.csv"]);
  });

  it("without entry, notListed past the limit leaves directories out", () => {
    const r = attachmentText(
      zip([
        ...Array.from({ length: 4 }, (_, i) => ({ name: `${i}.txt`, data: Buffer.from(String(i)) })),
        { name: "sub/", data: Buffer.alloc(0) },
        { name: "sub/9.txt", data: Buffer.from("9") },
      ]),
      "a.zip",
      small,
    );
    expect(r.entries).toHaveLength(3);
    expect(r.notListed).toBe(2);
  });

  it("marks an entry whose data runs past the end of the file as corrupt", () => {
    const z = zip([{ name: "a.txt", data: Buffer.from("hello world") }]);
    // Point the entry's local header offset somewhere that is no local header.
    const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt32LE(5, cd + 42);
    expect(attachmentText(z, "a.zip").entries[0]).toMatchObject({ skipped: "corrupt" });
  });

  it("refuses an archive with no central directory, or a damaged one", () => {
    const z = zip([{ name: "a.txt", data: Buffer.from("x") }]);
    expect(() => attachmentText(z.subarray(0, z.length - 22), "a.zip")).toThrow(/central directory/);
    const broken = Buffer.from(z);
    broken.writeUInt32LE(broken.length - 30, broken.length - 6); // central directory offset into nowhere
    expect(() => attachmentText(broken, "a.zip")).toThrow(/damaged/);
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({ maxEntryBytes: 5242880, maxTotalBytes: 20971520, maxChars: 30000, maxEntries: 50 });
  });
});

describe("entryMatcher", () => {
  it.each<[string, string, boolean]>([
    ["trips.csv", "trips.csv", true],
    ["TRIPS.CSV", "trips.csv", true], // case-insensitive
    ["trips.csv", "export/trips.csv", true], // bare file name
    ["export/trips.csv", "export/trips.csv", true], // full path
    ["trips.csv", "export/trips.csv.bak", false],
    ["*.csv", "export/trips.csv", true],
    ["*.csv", "report.html", false],
    ["export/*.csv", "export/trips.csv", true],
    ["*.csv", "a/b/c.csv", true], // via the bare name
    ["export/*", "export/sub/x.csv", false], // * does not cross /
    ["trip?.csv", "trips.csv", true],
    ["trip?.csv", "trip.csv", false],
    ["a+b(1).txt", "a+b(1).txt", true], // regex characters are literal
    ["a.txt", "abtxt", false], // . is literal in an exact name
    ["*.t.t", "x.txt", false], // . is literal in a pattern too
    ["[x]*.txt", "[x]1.txt", true],
  ])("%s vs %s -> %s", (pattern, name, expected) => {
    expect(entryMatcher(pattern)(name)).toBe(expected);
  });
});

describe("attachmentText — choosing what to read (2026-10-26: a 97 KB report beside a 3 KB CSV)", () => {
  const csv = "date;km;amount\n" + "2026-10-20;12,4;4,96 €\n".repeat(120);
  const html = "<html>" + "<td>layout</td>".repeat(6000) + "</html>";
  const triplog = () =>
    zip([
      { name: "TripLog/trips.csv", data: Buffer.from(csv, "utf8") },
      { name: "TripLog/report.html", data: Buffer.from(html) },
      { name: "TripLog/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
    ]);

  it("list: names, sizes and text lengths, and not one character of text", () => {
    const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { list: true });
    expect(r.list).toBe(true);
    expect(r.entries).toEqual([
      { name: "TripLog/trips.csv", bytes: Buffer.byteLength(csv), chars: csv.length },
      { name: "TripLog/report.html", bytes: html.length, chars: html.length },
      { name: "TripLog/logo.png", bytes: 7, skipped: "binary" },
    ]);
    expect(JSON.stringify(r)).not.toContain("layout");
  });

  it("entry: only the CSV is read, the HTML is counted and never unpacked", () => {
    const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "*.csv" });
    expect(r.entries).toEqual([{ name: "TripLog/trips.csv", bytes: Buffer.byteLength(csv), chars: csv.length, text: csv }]);
    expect(r.notSelected).toBe(2);
    expect(r.notSelectedNames).toEqual(["TripLog/report.html", "TripLog/logo.png"]);
    expect(JSON.stringify(r).length).toBeLessThan(csv.length + 500); // the answer is the CSV, not the report
    expect(r.entries[0].text).toContain("4,96 €"); // UTF-8 intact
  });

  it("notSelectedNames is absent without entry, and when every entry matched", () => {
    expect(attachmentText(triplog(), "export.zip")).not.toHaveProperty("notSelectedNames");
    const all = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "TripLog/*" });
    expect(all.notSelected).toBe(0);
    expect(all).not.toHaveProperty("notSelectedNames");
  });

  it("entry by exact bare name works too", () => {
    const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "report.html" });
    expect(r.entries.map((e) => e.name)).toEqual(["TripLog/report.html"]);
  });

  it("a non-matching entry is an error that points at list, not an empty answer", () => {
    expect(() => attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "*.xlsx" })).toThrow(
      /No entry .* matches "\*\.xlsx".*list: true/,
    );
  });

  it("entry on a file that is not an archive is an error, not silently ignored", () => {
    expect(() => attachmentText(Buffer.from("a,b"), "x.csv", DEFAULT_LIMITS, { entry: "x.csv" })).toThrow(/not an archive/);
    expect(() => attachmentText(gzipSync("a,b"), "x.csv.gz", DEFAULT_LIMITS, { entry: "x.csv" })).toThrow(/single gzip file/);
  });

  it("the character budget covers the WHOLE answer, shared in archive order", () => {
    const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { maxChars: csv.length + 100 });
    const [c, h] = r.entries;
    expect(c).toMatchObject({ text: csv, chars: csv.length });
    expect(c.truncated).toBeUndefined();
    expect(h).toMatchObject({ chars: html.length, truncated: true, nextOffset: 100 });
    expect(h.text).toHaveLength(100);
    const total = r.entries.reduce((n, e) => n + (e.text?.length ?? 0), 0);
    expect(total).toBe(csv.length + 100);
  });

  it("by default one answer stays within the default budget even with two large entries", () => {
    const big = "x".repeat(20_000);
    const r = attachmentText(
      zip([
        { name: "a.txt", data: Buffer.from(big) },
        { name: "b.txt", data: Buffer.from(big) },
      ]),
      "two.zip",
    );
    expect(r.entries.reduce((n, e) => n + (e.text?.length ?? 0), 0)).toBe(DEFAULT_LIMITS.maxChars);
    expect(r.entries[1]).toMatchObject({ truncated: true, nextOffset: 10_000, chars: 20_000 });
  });

  it("an entry the budget has run out on still says how long it is and where to start", () => {
    const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { maxChars: 10 });
    expect(r.entries[1]).toEqual({
      name: "TripLog/report.html",
      bytes: html.length,
      chars: html.length,
      text: "",
      truncated: true,
      nextOffset: 0,
    });
  });

  it("offset continues one entry until it is complete, and the pieces add up to the whole", () => {
    let offset = 0;
    let read = "";
    for (let i = 0; i < 100; i++) {
      const r = attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "report.html", maxChars: 30_000, offset });
      const e = r.entries[0];
      read += e.text ?? "";
      if (!e.truncated) break;
      expect(e.nextOffset).toBe(offset + 30_000);
      offset = e.nextOffset!;
    }
    expect(read).toBe(html);
  });

  it("offset works on a plain text attachment too", () => {
    const r = attachmentText(Buffer.from("0123456789"), "n.txt", DEFAULT_LIMITS, { offset: 4, maxChars: 3 });
    expect(r.entries[0]).toMatchObject({ text: "456", truncated: true, nextOffset: 7, chars: 10 });
  });

  it("offset without exactly one text entry selected is an error", () => {
    expect(() => attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { offset: 5 })).toThrow(/ONE entry/);
    expect(() => attachmentText(triplog(), "export.zip", DEFAULT_LIMITS, { entry: "TripLog/*", offset: 5 })).toThrow(/ONE entry/);
  });

  it("offset past the end is an error, not an empty success", () => {
    expect(() => attachmentText(Buffer.from("abc"), "n.txt", DEFAULT_LIMITS, { offset: 4 })).toThrow(/past the end/);
    // Exactly at the end is the empty remainder of a finished read: allowed.
    expect(attachmentText(Buffer.from("abc"), "n.txt", DEFAULT_LIMITS, { offset: 3 }).entries[0]).toMatchObject({ text: "" });
  });

  it("a default answer of HTML with umlauts stays below the 50.6 KB that Claude Code moved to a file", () => {
    // The measured point (xorino-product, 26 Oct): 50,000 characters of an HTML report were
    // 50.6 KB as JSON and did not reach the conversation. Quotes, newlines and multi-byte
    // letters all make the JSON larger than the text; the default has to leave room for that.
    const row = '<tr class="r"><td>Gewerbestraße</td><td>4,96 €</td></tr>\n';
    const report = row.repeat(Math.ceil(100_000 / row.length));
    const r = attachmentText(zip([{ name: "report.html", data: Buffer.from(report) }]), "x.zip");
    expect(r.entries[0]).toMatchObject({ truncated: true, nextOffset: DEFAULT_LIMITS.maxChars });
    // Measured as it goes out: tools.ts `ok()` sends pretty-printed JSON inside the fence.
    const wire = fenceOutput(JSON.stringify(sanitizeStructured(r), null, 2));
    expect(Buffer.byteLength(wire)).toBeLessThan(50_000);
  });

  it("maxChars is capped at the ceiling, whatever is asked", () => {
    const big = "y".repeat(MAX_CHARS_CEILING + 5000);
    const r = attachmentText(Buffer.from(big), "big.txt", DEFAULT_LIMITS, { maxChars: 10 ** 9 });
    expect(r.entries[0].text).toHaveLength(MAX_CHARS_CEILING);
  });

  it("entry selection happens before maxEntries: a match beyond the first 50 entries is still found", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `noise-${i}.txt`, data: Buffer.from("n") }));
    const r = attachmentText(zip([...many, { name: "wanted.csv", data: Buffer.from("a;b") }]), "m.zip", DEFAULT_LIMITS, {
      entry: "wanted.csv",
    });
    expect(r.entries).toEqual([{ name: "wanted.csv", bytes: 3, chars: 3, text: "a;b" }]);
    expect(r.notSelected).toBe(60);
    // names are capped like entries: the count stays exact, the list stops at maxEntries
    expect(r.notSelectedNames).toHaveLength(DEFAULT_LIMITS.maxEntries);
    expect(r.notSelectedNames?.[0]).toBe("noise-0.txt");
    expect(r.notListed).toBe(0);
  });

  it("unselected entries cost no unpacking: an oversized entry beside the wanted one is never touched", () => {
    const huge = { name: "huge.txt", data: Buffer.alloc(4000, 0x61) }; // over small.maxEntryBytes
    const r = attachmentText(zip([huge, { name: "ok.txt", data: Buffer.from("fine") }]), "b.zip", small, { entry: "ok.txt" });
    expect(r.entries).toEqual([{ name: "ok.txt", bytes: 4, chars: 4, text: "fine" }]);
    // Without selection the same entry is reported, proving it would otherwise have been looked at.
    expect(attachmentText(zip([huge]), "b.zip", small).entries[0].skipped).toBe("too large");
  });
});

// Review grok-mailwarden, 26 Oct 2026 (Bridge 595): findings M1, M2, L1, N4 on hostile archives.
describe("attachmentText — hostile names and overlapping entries (review 26 Oct)", () => {
  /** The same matcher as a regex, as it was before: the reference for what a pattern means. */
  const reference = (pattern: string) => {
    const p = pattern.trim().toLowerCase();
    const re = new RegExp(
      "^" +
        [...p].map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") +
        "$",
    );
    return (n: string) => re.test(n.toLowerCase()) || re.test(n.slice(n.lastIndexOf("/") + 1).toLowerCase());
  };

  it("M1: a pattern with several stars against a long near-miss name takes no time", () => {
    // Measured before the fix: 353 ms at 1,024 characters, cubic; grok measured 130 s at 8,192.
    const t = performance.now();
    expect(entryMatcher("*a*a*.csv")("a".repeat(65_535))).toBe(false);
    expect(entryMatcher("*report*.csv")("report".repeat(10_922))).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("M1: the matcher means what the regex meant, over a corpus of patterns and names", () => {
    const patterns = ["*.csv", "*report*.csv", "t?ip*.CSV", "TripLog/*.csv", "*/*.html", "*", "?", "a*b*c", "**.txt", "a/*/c", "*a*a*", "x.y", "[x].csv", "a+b?.txt", "*/"];
    const names = ["trips.csv", "TripLog/trips.csv", "TripLog/report.html", "a/b/c", "a/bb/c", "abc", "aXbYc", "a/c", "x.y", "xay", "[x].csv", "a+bc.txt", "report-2026.csv", "reportreport.csv.bak", "sub/", "", "a", "dir/a"];
    for (const p of patterns) {
      const a = entryMatcher(p);
      const b = reference(p);
      for (const n of names) expect([p, n, a(n)]).toEqual([p, n, b(n)]);
    }
  });

  it("M2: a name is shortened in the answer, marked, and still selects by pattern", () => {
    const long = "A".repeat(65_000) + ".txt";
    const r = attachmentText(zip([{ name: long, data: Buffer.from("x") }, { name: "ok.csv", data: Buffer.from("y") }]), "n.zip", DEFAULT_LIMITS, {
      list: true,
    });
    expect(r.entries[0].name.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    expect(r.entries[0]).toMatchObject({ nameTruncated: true, nameLength: long.length });
    expect(r.entries[1]).not.toHaveProperty("nameTruncated");
    // A pattern still reaches the long entry: matching uses the whole name.
    const sel = attachmentText(zip([{ name: long, data: Buffer.from("x") }]), "n.zip", DEFAULT_LIMITS, { entry: "a*.txt" });
    expect(sel.entries[0]).toMatchObject({ text: "x", nameTruncated: true });
  });

  it("M2: sixty 65 KB names cannot make the answer megabytes long", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: "A".repeat(65_000) + i + ".txt", data: Buffer.from("x"), method: 0 as const }));
    const z = zip([...many, { name: "wanted.csv", data: Buffer.from("a;b") }]);
    const sel = attachmentText(z, "n.zip", DEFAULT_LIMITS, { entry: "wanted.csv" });
    expect(sel.notSelected).toBe(60);
    expect(sel.notSelectedNames?.every((n) => n.length <= MAX_NAME_CHARS)).toBe(true);
    const wire = (o: unknown) => Buffer.byteLength(fenceOutput(JSON.stringify(sanitizeStructured(o), null, 2)));
    expect(wire(sel)).toBeLessThan(50_000);
    expect(wire(attachmentText(z, "n.zip", DEFAULT_LIMITS, { list: true }))).toBeLessThan(50_000);
  });

  it("N8: a name is never cut inside a surrogate pair", () => {
    const name = "a".repeat(MAX_NAME_CHARS - 2) + String.fromCodePoint(0x1f600).repeat(4) + ".txt";
    const r = attachmentText(zip([{ name, data: Buffer.from("x"), utf8Name: true }]), "e.zip", DEFAULT_LIMITS, { list: true });
    expect(r.entries[0].name.isWellFormed()).toBe(true);
    expect(r.entries[0]).toMatchObject({ nameTruncated: true });
  });

  it("N12: an entry pattern longer than 512 characters is refused", () => {
    expect(() => attachmentText(zip([{ name: "a.txt", data: Buffer.from("x") }]), "p.zip", DEFAULT_LIMITS, { entry: "*".repeat(513) })).toThrow(
      AttachmentTextError,
    );
  });

  it("N11: a broken deflate stream counts against the archive budget too", () => {
    // A stream cut short inflates some bytes, then fails: "corrupt". Each such attempt now spends
    // the share it was allowed, so a run of them cannot inflate for free.
    const noisy = randomBytes(5000); // does not compress, so a cut stream really breaks
    const broken = deflateRawSync(noisy).subarray(0, 600);
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `${i}.txt`, data: broken, method: 0 as const, declaredSize: 10 }));
    const z = zip(entries);
    // Mark the stored entries as deflated so the reader inflates the cut stream.
    for (let i = 0; i + 4 <= z.length; i++) {
      const sig = z.readUInt32LE(i);
      if (sig === 0x04034b50) z.writeUInt16LE(8, i + 8);
      if (sig === 0x02014b50) z.writeUInt16LE(8, i + 10);
    }
    const r = attachmentText(Buffer.concat([z]), "k.zip", { ...small, maxEntries: 10 });
    expect(r.entries[0].skipped).toBe("corrupt");
    // The second may fail either way, depending on how much it inflated before the cut.
    expect(["corrupt", "too large"]).toContain(r.entries[1].skipped);
    // By then the budget is spent: the third is refused without inflating.
    expect(r.entries[2].skipped).toBe("too large");
  });

  it("M2: an error message names a long entry by its shortened name", () => {
    const long = "B".repeat(65_000) + ".txt";
    try {
      attachmentText(zip([{ name: long, data: Buffer.from("x") }]), "n.zip", DEFAULT_LIMITS, { entry: "b*", offset: 5 });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(MAX_NAME_CHARS + 200);
    }
  });

  it("N4: a 'directory' that carries data is listed as corrupt, not hidden", () => {
    const r = attachmentText(zip([{ name: "hidden/", data: Buffer.from("secret payload") }, { name: "a.txt", data: Buffer.from("a") }]), "d.zip");
    expect(r.entries).toEqual([
      { name: "hidden/", bytes: 14, skipped: "corrupt" },
      { name: "a.txt", bytes: 1, chars: 1, text: "a" },
    ]);
    // A real directory (no data) still stays out of the answer.
    expect(attachmentText(zip([{ name: "sub/", data: Buffer.alloc(0) }, { name: "a.txt", data: Buffer.from("a") }]), "d.zip").entries).toHaveLength(1);
  });

  /** Point every central header after the first at the first local header: one body, many entries. */
  function overlapping(body: Buffer, copies: number, declaredSize: number): Buffer {
    const z = zip(Array.from({ length: copies }, (_, i) => ({ name: `${i}.txt`, data: body, declaredSize })));
    for (let i = 0, seen = 0; i + 4 <= z.length; i++) {
      if (z.readUInt32LE(i) === 0x02014b50 && seen++ > 0) z.writeUInt32LE(0, i + 42);
    }
    return z;
  }

  it("L1: entries that share one local header are read once, the rest are corrupt", () => {
    const r = attachmentText(overlapping(Buffer.from("hello"), 3, 5), "o.zip");
    expect(r.entries.map((e) => e.skipped)).toEqual([undefined, "corrupt", "corrupt"]);
  });

  it("L1: an inflate stopped at the cap still counts against the archive budget", () => {
    // small: 1,000 bytes per entry, 1,500 per archive. Each body inflates past the entry cap
    // while declaring 10 bytes. Before, every attempt was free; now the first spends 1,000, the
    // second the 500 left, and the third is refused without inflating at all.
    const bomb = Buffer.alloc(5000, 0x61);
    const r = attachmentText(
      zip([
        { name: "1.txt", data: bomb, declaredSize: 10 },
        { name: "2.txt", data: bomb, declaredSize: 10 },
        { name: "3.txt", data: bomb, declaredSize: 10 },
        { name: "4.txt", data: Buffer.from("tiny"), declaredSize: 4 },
      ]),
      "b.zip",
      { ...small, maxEntries: 10 },
    );
    expect(r.entries.map((e) => e.skipped)).toEqual(["too large", "too large", "too large", "too large"]);
    // Without the bombs the same small entry is read: it was the spent budget that refused it.
    expect(attachmentText(zip([{ name: "4.txt", data: Buffer.from("tiny") }]), "c.zip", small).entries[0]).toMatchObject({ text: "tiny" });
  });
});

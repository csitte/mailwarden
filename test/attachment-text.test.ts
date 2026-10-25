import { describe, it, expect } from "vitest";
import { deflateRawSync, gzipSync } from "node:zlib";
import { attachmentText, decodeText, AttachmentTextError, DEFAULT_LIMITS, type AttachmentTextLimits } from "../src/attachment-text.js";

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

  it("lets an odd control character through in a long text, but not many", () => {
    expect(decodeText(Buffer.from("x".repeat(200) + "\x07"))).toBeDefined();
    expect(decodeText(Buffer.from("x".repeat(20) + "\x07\x07\x07"))).toBeUndefined();
  });
});

describe("attachmentText — plain and gzip", () => {
  it("reads plain text, whatever the declared name", () => {
    expect(attachmentText(Buffer.from("a,b\n1,2\n"), "report.pdf")).toEqual({
      format: "text",
      entries: [{ name: "report.pdf", bytes: 8, text: "a,b\n1,2\n" }],
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
    expect(DEFAULT_LIMITS).toEqual({ maxEntryBytes: 5242880, maxTotalBytes: 20971520, maxChars: 100000, maxEntries: 50 });
  });
});

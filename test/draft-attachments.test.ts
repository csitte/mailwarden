import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  buildMime,
  checkAttachments,
  checkFilename,
  draftDialog,
  fileParameter,
  isMimeType,
  mimeTypeFor,
  type DraftAttachment,
  type DraftContent,
} from "../src/draft.js";
import { reviseDraft, saveNewDraft, saveReplyDraft, type DraftGmail, type ReadFile } from "../src/draft-flow.js";
import { attachDirProblem, readAttachmentFile, resolveAttachDir } from "../src/attach.js";
import type { Attachment, DraftInfo } from "../src/gmail.js";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const file = (filename: string, data: Buffer | string, source: DraftAttachment["source"] = "file"): DraftAttachment => ({
  filename,
  mimeType: mimeTypeFor(filename),
  data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  source,
});

/** Split a multipart message into its parts: [headers, body] each, boundary from the top header. */
function partsOf(mime: string): Array<{ head: string; body: string }> {
  const boundary = /boundary="([^"]+)"/.exec(mime)![1];
  return mime
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const [head, ...rest] = p.replace(/^\r\n/, "").split("\r\n\r\n");
      return { head, body: rest.join("\r\n\r\n") };
    });
}
const decode = (b: string) => Buffer.from(b.replace(/\r\n/g, ""), "base64");

/** RFC 2231 continuations back to the name, the way a mail client reads them. */
function readParameter(head: string, param: string): string {
  const quoted = new RegExp(`${param}="([^"]*)"`).exec(head);
  if (quoted) return quoted[1];
  const pieces = [...head.matchAll(new RegExp(`${param}\\*(\\d+)\\*=([^;\\r\\n]*)`, "g"))]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[2]);
  return decodeURIComponent(pieces.join("").replace(/^UTF-8''/, ""));
}

describe("buildMime with attachments", () => {
  const base: DraftContent = { to: ["a@example.com"], cc: [], bcc: [], subject: "Fotos", body: "Anbei zwei Fotos.\nGrüße" };

  it("leaves a message without attachments exactly as before", () => {
    expect(buildMime({ ...base, attachments: [] })).toBe(buildMime(base));
    expect(buildMime(base)).not.toMatch(/multipart/);
  });

  it("writes multipart/mixed: the same text part first, then each file in base64", () => {
    const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const m = buildMime({ ...base, attachments: [file("a.jpg", photo), file("b.pdf", "%PDF-1.7")] }, "mailwarden=_test");
    expect(m.split("\r\n\r\n")[0]).toContain('Content-Type: multipart/mixed; boundary="mailwarden=_test"');
    const parts = partsOf(m);
    expect(parts).toHaveLength(3);
    expect(parts[0].head).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decode(parts[0].body).toString("utf8")).toBe("Anbei zwei Fotos.\r\nGrüße");
    expect(parts[1].head).toMatch(/^Content-Type: image\/jpeg;\r\n name="a.jpg"\r\nContent-Disposition: attachment;\r\n filename="a.jpg"/);
    expect(decode(parts[1].body).equals(photo)).toBe(true);
    expect(parts[2].head).toContain("application/pdf");
    expect(decode(parts[2].body).toString()).toBe("%PDF-1.7");
    expect(m.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });

  it("uses a boundary no base64 line can contain, so no file can close its part early", () => {
    const m = buildMime({ ...base, attachments: [file("x.txt", `--mailwarden=_x${CR}${LF}Bcc: evil@example.net`)] });
    const boundary = /boundary="([^"]+)"/.exec(m)![1];
    expect(boundary).toMatch(/^mailwarden=_[0-9a-f]{24}$/);
    const bodyLines = m.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l));
    expect(bodyLines.length).toBeGreaterThan(0);
    expect(m.split("\r\n\r\n")[0]).not.toMatch(/evil/);
  });

  it("refuses a type that is not a bare type/subtype", () => {
    for (const bad of [`text/plain${CR}${LF}Bcc: x@example.net`, "text/plain; charset=x", "plain"]) {
      expect(() => buildMime({ ...base, attachments: [{ ...file("a.txt", "x"), mimeType: bad }] })).toThrow(/not a MIME type/);
    }
  });

  it("checks names, count and size before building", () => {
    expect(() => buildMime({ ...base, attachments: [file("a/b.txt", "x")] })).toThrow(/slash/);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${i}.txt`, "x"));
    expect(() => buildMime({ ...base, attachments: many })).toThrow(/at most 10 attachments/);
  });
});

describe("fileParameter — a filename as a MIME parameter", () => {
  it("quotes plain ASCII", () => {
    expect(fileParameter("filename", "Rechnung 2026.pdf")).toEqual(['filename="Rechnung 2026.pdf"']);
  });
  it.each(["Grüße aus München.pdf", 'say "hi".txt', "back\\slash.txt", "照片.jpg", "ä".repeat(120) + ".pdf"])(
    "writes %j as RFC 2231 continuations that read back exactly",
    (name) => {
      const pieces = fileParameter("filename", name);
      expect(pieces[0]).toMatch(/^filename\*0\*=UTF-8''/);
      for (const p of pieces) {
        expect(p.length).toBeLessThanOrEqual(80);
        expect(p).toMatch(/^filename\*\d+\*=[A-Za-z0-9!#$&+\-.^_`|~%']*$/);
      }
      expect(readParameter(pieces.join(";\r\n "), "filename")).toBe(name);
    },
  );
});

describe("checkFilename / checkAttachments", () => {
  it.each([
    ["", /empty/],
    ["   ", /empty/],
    [`a${CR}${LF}Bcc: x.pdf`, /line break/],
    ["../a.pdf", /slash/],
    ["a\\b.pdf", /slash/],
    ["..", /not a file name/],
    ["x".repeat(256), /longer than 255/],
    ["setup.exe", /refuses to send/],
    ["Invoice.PDF.js", /refuses to send/],
  ])("refuses %j", (name, why) => {
    expect(() => checkFilename(name)).toThrow(why);
  });
  it("accepts ordinary names, umlauts and names without an extension", () => {
    for (const ok of ["Foto 1.jpg", "Grüße.pdf", "README", ".profile.txt"]) expect(() => checkFilename(ok)).not.toThrow();
  });
  it("refuses more than 25 MB together, and says how much", () => {
    const half = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1);
    expect(() => checkAttachments([file("a.bin", half), file("b.bin", half)])).toThrow(/add up to 25\.0 MB, more than Gmail's limit of 25\.0 MB/);
    expect(() => checkAttachments([file("a.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES))])).not.toThrow();
  });
});

describe("mimeTypeFor / isMimeType", () => {
  it("goes by the extension, case-insensitive, and falls back to octet-stream", () => {
    expect(mimeTypeFor("a.PDF")).toBe("application/pdf");
    expect(mimeTypeFor("IMG_1.JPG")).toBe("image/jpeg");
    expect(mimeTypeFor("a.unknownext")).toBe("application/octet-stream");
    expect(mimeTypeFor("Makefile")).toBe("application/octet-stream");
  });
  it("accepts only a bare type/subtype", () => {
    expect(isMimeType("image/heic")).toBe(true);
    expect(isMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isMimeType("text/plain; charset=utf-8")).toBe(false);
    expect(isMimeType("text")).toBe(false);
  });
});

describe("draftDialog with attachments", () => {
  it("names each file with size and origin, after the recipients", () => {
    const d = draftDialog(
      "reply",
      {
        to: ["ann@example.org"],
        cc: [],
        bcc: [],
        subject: "Re: x",
        body: "y",
        attachments: [file("a.jpg", Buffer.alloc(1536 * 1024)), file("b.pdf", "x", "message"), file("c.txt", "xy", "kept")],
      },
      [],
    );
    const lines = d.split("\n");
    expect(lines[2]).toBe(
      "Attachments: a.jpg (1.5 MB, new, from a file on this computer); b.pdf (1 bytes, from a mail in the thread); c.txt (2 bytes, already in the draft)",
    );
  });
});

// ---- the flow, against a fake mailbox ----

const THREAD_FILES: Attachment[] = [
  { messageId: "m1", attachmentId: "fresh-1", filename: "Foto.jpg", mimeType: "image/jpeg", size: 3 },
  { messageId: "m1", attachmentId: "fresh-2", filename: "dup.pdf", mimeType: "application/pdf", size: 1 },
  { messageId: "m1", attachmentId: "fresh-3", filename: "dup.pdf", mimeType: "application/pdf", size: 1 },
  { messageId: "m2", attachmentId: "fresh-4", filename: "odd.bin", mimeType: "not a type", size: 1 },
];

function fake(over: Partial<DraftGmail> & { draft?: Partial<DraftInfo> } = {}) {
  const created: Array<{ raw: string; threadId?: string }> = [];
  const updated: Array<{ raw: string; threadId?: string }> = [];
  const fetched: string[] = [];
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m1",
      source: { from: "Ann <ann@example.org>", to: "me@example.com", subject: "Reklamation", messageId: "<m1@example.org>" },
    }),
    createDraft: async (raw, threadId) => (created.push({ raw, threadId }), { draftId: "r1", messageId: "dm1", threadId: threadId ?? "tn", marked: true }),
    updateDraft: async (draftId, raw, threadId) => (updated.push({ raw, threadId }), { draftId, messageId: "dm2", threadId: threadId ?? "tn", marked: true }),
    getDraft: async (draftId) => ({
      draftId,
      messageId: "dm1",
      threadId: "t1",
      ownedByMailwarden: true,
      trashed: false,
      to: "ann@example.org",
      subject: "Re: Reklamation",
      inReplyTo: "<m1@example.org>",
      references: "<m1@example.org>",
      attachments: [
        { messageId: "dm1", attachmentId: "d-1", filename: "old.pdf", mimeType: "application/pdf", size: 3 },
        { messageId: "dm1", attachmentId: "d-2", filename: "old.jpg", mimeType: "image/jpeg", size: 2 },
      ],
      ...over.draft,
    }),
    threadAttachments: async () => THREAD_FILES,
    attachmentBytes: async (messageId, attachmentId) => (fetched.push(`${messageId}/${attachmentId}`), Buffer.from(attachmentId)),
    ...over,
  };
  return { gmail, created, updated, fetched };
}

const files: Record<string, string> = { "foto1.jpg": "JPEGDATA", "scan.pdf": "%PDF" };
const readFile: ReadFile = async (p) => {
  if (!(p in files)) throw new Error(`no ${p}`);
  return { filename: p, data: Buffer.from(files[p]) };
};

describe("saveReplyDraft with attachments", () => {
  it("a file from the disk needs the dialog even with MAILWARDEN_CONFIRM off, and the result lists it", async () => {
    const { gmail, created } = fake();
    const confirm = vi.fn(async () => true);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Anbei", attachments: [{ path: "foto1.jpg" }] }, "off", confirm, false, readFile);
    expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("foto1.jpg (8 bytes, new, from a file on this computer)"));
    expect(r.attachments).toEqual([{ filename: "foto1.jpg", mimeType: "image/jpeg", bytes: 8, source: "file" }]);
    expect(r.attachmentBytes).toBe(8);
    expect(r.newRecipients).toEqual([]);
    const parts = partsOf(created[0].raw);
    expect(decode(parts[1].body).toString()).toBe("JPEGDATA");
  });

  it("renames a file with `filename`, and checks the new name", async () => {
    const { gmail } = fake();
    const r = await saveReplyDraft(
      gmail,
      { threadId: "t1", body: "x", attachments: [{ path: "scan.pdf", filename: "Rechnung März.pdf" }] },
      "off",
      vi.fn(async () => true),
      false,
      readFile,
    );
    expect(r.attachments[0]).toMatchObject({ filename: "Rechnung März.pdf", mimeType: "application/pdf" });
    await expect(
      saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [{ path: "scan.pdf", filename: "x.exe" }] }, "off", vi.fn(async () => true), false, readFile),
    ).rejects.toThrow(/refuses to send/);
  });

  it("an attachment from the thread follows MAILWARDEN_CONFIRM, and is fetched by the id of this read", async () => {
    const { gmail, fetched } = fake();
    const confirm = vi.fn(async () => false);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [{ fromMessage: "m1", filename: "Foto.jpg" }] }, "off", confirm);
    expect(confirm).toHaveBeenCalledWith("off", expect.stringContaining("Foto.jpg (7 bytes, from a mail in the thread)"));
    expect(fetched).toEqual(["m1/fresh-1"]);
    expect(r.attachments).toEqual([{ filename: "Foto.jpg", mimeType: "image/jpeg", bytes: 7, source: "message" }]);
  });

  it("replaces a type the sender wrote that is not a bare type/subtype", async () => {
    const { gmail } = fake();
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [{ fromMessage: "m2", filename: "odd.bin" }] }, "off", vi.fn(async () => false));
    expect(r.attachments[0].mimeType).toBe("application/octet-stream");
  });

  it.each([
    [{ fromMessage: "m9", filename: "Foto.jpg" }, /not in this draft's thread, or has no attachments/],
    [{ fromMessage: "m1", filename: "nope.jpg" }, /no attachment named "nope.jpg"; it has: "Foto.jpg", "dup.pdf", "dup.pdf"/],
    [{ fromMessage: "m1", filename: "dup.pdf" }, /carries 2 attachments named "dup.pdf"/],
  ])("refuses %j without writing", async (input, why) => {
    const { gmail, created } = fake();
    const confirm = vi.fn(async () => true);
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [input] }, "off", confirm)).rejects.toThrow(why);
    expect(confirm).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("refuses a file when no directory is configured, before asking or writing", async () => {
    const { gmail, created } = fake();
    const confirm = vi.fn(async () => true);
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [{ path: "foto1.jpg" }] }, "off", confirm)).rejects.toThrow(
      /MAILWARDEN_ATTACH_DIR/,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("refuses more than ten before reading a single file", async () => {
    const { gmail } = fake();
    const read = vi.fn(readFile);
    const eleven = Array.from({ length: 11 }, () => ({ path: "foto1.jpg" }));
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: eleven }, "off", vi.fn(async () => true), false, read)).rejects.toThrow(
      /at most 10/,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("the self opt-in does not cover a file to a known correspondent", async () => {
    const { gmail } = fake();
    const confirm = vi.fn(async () => true);
    await saveReplyDraft(gmail, { threadId: "t1", body: "x", attachments: [{ path: "foto1.jpg" }] }, "off", confirm, true, readFile);
    expect(confirm).toHaveBeenCalledWith("require", expect.any(String));
  });
});

describe("saveNewDraft with attachments", () => {
  it("refuses an attachment from a mail: a new message has no thread", async () => {
    const { gmail } = fake();
    await expect(
      saveNewDraft(gmail, { to: ["zoe@example.com"], subject: "s", body: "x", attachments: [{ fromMessage: "m1", filename: "Foto.jpg" }] }, vi.fn(async () => true)),
    ).rejects.toThrow(/only go into a reply/);
  });

  it("a file to the owner alone is saved unasked with the opt-in, and asked about without it", async () => {
    for (const [optIn, mode] of [
      [true, "off"],
      [false, "require"],
    ] as const) {
      const { gmail } = fake();
      const confirm = vi.fn(async () => false);
      await saveNewDraft(gmail, { to: ["me@example.com"], subject: "s", body: "x", attachments: [{ path: "scan.pdf" }] }, confirm, {
        selfWithoutDialog: optIn,
        readFile,
      });
      expect(confirm, String(optIn)).toHaveBeenCalledWith(mode, expect.any(String));
    }
  });

  it("keeps require with the opt-in when the owner is not the only recipient", async () => {
    const { gmail } = fake();
    const confirm = vi.fn(async () => true);
    await saveNewDraft(gmail, { to: ["me@example.com"], bcc: ["zoe@example.com"], subject: "s", body: "x", attachments: [{ path: "scan.pdf" }] }, confirm, {
      selfWithoutDialog: true,
      readFile,
    });
    expect(confirm).toHaveBeenCalledWith("require", expect.any(String));
  });

  it("refuses `kept` outside update_draft", async () => {
    const { gmail } = fake();
    await expect(
      saveNewDraft(gmail, { to: ["zoe@example.com"], subject: "s", body: "x", attachments: [{ kept: "old.pdf" }] }, vi.fn(async () => true)),
    ).rejects.toThrow(/only applies to update_draft/);
  });
});

describe("reviseDraft with attachments — omitted keeps, a list replaces", () => {
  it("omitted: every attachment of the draft is written again, and nothing is asked for them", async () => {
    const { gmail, updated, fetched } = fake();
    const confirm = vi.fn(async () => false);
    const r = await reviseDraft(gmail, { draftId: "r1", body: "Neuer Text" }, "off", confirm);
    expect(confirm).toHaveBeenCalledWith("off", expect.stringContaining("old.pdf (3 bytes, already in the draft)"));
    expect(fetched).toEqual(["dm1/d-1", "dm1/d-2"]);
    expect(r.attachments.map((a) => [a.filename, a.source])).toEqual([
      ["old.pdf", "kept"],
      ["old.jpg", "kept"],
    ]);
    expect(partsOf(updated[0].raw)).toHaveLength(3);
  });

  it("[] removes them all and writes a plain message", async () => {
    const { gmail, updated, fetched } = fake();
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x", attachments: [] }, "off", vi.fn(async () => false));
    expect(r.attachments).toEqual([]);
    expect(fetched).toEqual([]);
    expect(updated[0].raw).not.toMatch(/multipart/);
  });

  it("a list replaces them: `kept` keeps one by name, a new file is asked about", async () => {
    const { gmail, fetched } = fake();
    const confirm = vi.fn(async () => true);
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x", attachments: [{ kept: "old.jpg" }, { path: "scan.pdf" }] }, "off", confirm, false, readFile);
    expect(fetched).toEqual(["dm1/d-2"]);
    expect(r.attachments.map((a) => [a.filename, a.source])).toEqual([
      ["old.jpg", "kept"],
      ["scan.pdf", "file"],
    ]);
    expect(confirm).toHaveBeenCalledWith("require", expect.any(String));
  });

  it("takes an attachment from the draft's own thread for a reply draft", async () => {
    const { gmail } = fake();
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x", attachments: [{ fromMessage: "m1", filename: "Foto.jpg" }] }, "off", vi.fn(async () => false));
    expect(r.attachments[0].source).toBe("message");
  });

  it("refuses an unknown `kept` name and lists what the draft has", async () => {
    const { gmail, updated } = fake();
    await expect(reviseDraft(gmail, { draftId: "r1", body: "x", attachments: [{ kept: "nope" }] }, "off", vi.fn(async () => true))).rejects.toThrow(
      /no attachment named "nope"; it has: "old.pdf", "old.jpg"/,
    );
    expect(updated).toEqual([]);
  });

  it("refuses an attachment from a mail for a draft of a new message", async () => {
    const { gmail } = fake({ draft: { inReplyTo: undefined, references: undefined } });
    await expect(
      reviseDraft(gmail, { draftId: "r1", body: "x", attachments: [{ fromMessage: "m1", filename: "Foto.jpg" }] }, "off", vi.fn(async () => true)),
    ).rejects.toThrow(/only go into a reply/);
  });
});

// ---- MAILWARDEN_ATTACH_DIR on a real filesystem ----

describe("attachDirProblem / resolveAttachDir", () => {
  const home = path.resolve(os.homedir());
  it("refuses a relative path, a filesystem root and the home directory itself", () => {
    expect(attachDirProblem("attach", home)).toMatch(/not an absolute path/);
    expect(attachDirProblem(path.parse(home).root, home)).toMatch(/root/);
    expect(attachDirProblem(home, home)).toMatch(/home directory itself/);
    expect(attachDirProblem(home + path.sep, home)).toMatch(/home directory itself/);
  });
  it("accepts a folder below home", () => {
    expect(attachDirProblem(path.join(home, "Scanbot", "_Anhang-Ausgang"), home)).toBeNull();
  });
  it("is off when unset and stops the start when unusable", () => {
    expect(resolveAttachDir({})).toBeUndefined();
    expect(resolveAttachDir({ MAILWARDEN_ATTACH_DIR: "  " })).toBeUndefined();
    expect(() => resolveAttachDir({ MAILWARDEN_ATTACH_DIR: "relative/dir" })).toThrow(/MAILWARDEN_ATTACH_DIR is not usable/);
    expect(() => resolveAttachDir({ MAILWARDEN_ATTACH_DIR: home }, home)).toThrow(/home directory itself/);
  });
});

describe("readAttachmentFile — only files inside the folder", () => {
  let base: string;
  let root: string;
  let outsideFile: string;
  let fileLink = false;
  let dirLink = false;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "mw-attach-"));
    root = path.join(base, "out");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "Foto 1.jpg"), "JPEG");
    await fs.writeFile(path.join(root, "sub", "Grüße.pdf"), "PDF");
    outsideFile = path.join(base, "secret.txt");
    await fs.writeFile(outsideFile, "SECRET");
    // A file symlink needs a privilege on Windows without developer mode, a junction does not;
    // whichever cannot be made here is skipped below (CI on Linux makes both).
    try {
      await fs.symlink(outsideFile, path.join(root, "link.txt"), "file");
      fileLink = true;
    } catch {
      // skipped below
    }
    try {
      await fs.symlink(base, path.join(root, "updir"), "junction");
      dirLink = true;
    } catch {
      // skipped below
    }
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("reads a relative path and an absolute path inside the folder", async () => {
    expect(await readAttachmentFile(root, "Foto 1.jpg")).toEqual({ filename: "Foto 1.jpg", data: Buffer.from("JPEG") });
    const abs = await readAttachmentFile(root, path.join(root, "sub", "Grüße.pdf"));
    expect(abs).toEqual({ filename: "Grüße.pdf", data: Buffer.from("PDF") });
  });

  it.each([["../secret.txt"], ["sub/../../secret.txt"]])("refuses %j, which leads out of the folder", async (p) => {
    await expect(readAttachmentFile(root, p)).rejects.toThrow(/outside MAILWARDEN_ATTACH_DIR/);
  });

  it("refuses an absolute path outside the folder", async () => {
    await expect(readAttachmentFile(root, outsideFile)).rejects.toThrow(/outside MAILWARDEN_ATTACH_DIR/);
  });

  it("refuses a file symlink inside the folder that points out of it", async (ctx) => {
    if (!fileLink) ctx.skip();
    await expect(readAttachmentFile(root, "link.txt")).rejects.toThrow(/outside MAILWARDEN_ATTACH_DIR/);
  });

  it("refuses a path through a linked directory that leads out of the folder", async (ctx) => {
    if (!dirLink) ctx.skip();
    await expect(readAttachmentFile(root, "updir/secret.txt")).rejects.toThrow(/outside MAILWARDEN_ATTACH_DIR/);
  });

  it("refuses the folder itself, a directory, and a missing file", async () => {
    await expect(readAttachmentFile(root, ".")).rejects.toThrow(/outside MAILWARDEN_ATTACH_DIR/);
    await expect(readAttachmentFile(root, "sub")).rejects.toThrow(/not a regular file/);
    await expect(readAttachmentFile(root, "nope.pdf")).rejects.toThrow(/no file "nope.pdf"/);
  });

  it("refuses a file above the limit without reading it", async () => {
    const big = path.join(root, "big.bin");
    const h = await fs.open(big, "w");
    await h.truncate(MAX_ATTACHMENT_BYTES + 1);
    await h.close();
    await expect(readAttachmentFile(root, "big.bin")).rejects.toThrow(/more than Gmail's limit/);
    await fs.rm(big);
  });

  it("refuses everything when no folder is configured, and says so", async () => {
    await expect(readAttachmentFile(undefined, "Foto 1.jpg")).rejects.toThrow(/MAILWARDEN_ATTACH_DIR/);
  });

  it("reports a configured folder that does not exist", async () => {
    await expect(readAttachmentFile(path.join(base, "missing"), "a.pdf")).rejects.toThrow(/does not exist/);
  });
});

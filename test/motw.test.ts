import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "@googleapis/gmail";
import { markAsDownloaded, ZONE_IDENTIFIER } from "../src/motw.js";
import { Gmail } from "../src/gmail.js";

const CRLF = String.fromCharCode(13, 10);

describe("markAsDownloaded", () => {
  it("writes the Internet zone into the Zone.Identifier stream on Windows", async () => {
    const writes: [string, string][] = [];
    const ok = await markAsDownloaded("C:\\dl\\invoice.pdf", "win32", async (t, d) => {
      writes.push([t, d]);
    });
    expect(ok).toBe(true);
    expect(writes).toEqual([["C:\\dl\\invoice.pdf:Zone.Identifier", "[ZoneTransfer]" + CRLF + "ZoneId=3" + CRLF]]);
  });

  it("reports false, and does not throw, where the file system has no streams", async () => {
    const refused = await markAsDownloaded("E:\\usb\\a.exe", "win32", async () => {
      throw Object.assign(new Error("not supported"), { code: "EINVAL" });
    });
    expect(refused).toBe(false);
  });

  it("writes nothing and reports nothing on macOS and Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      let called = false;
      expect(await markAsDownloaded("/tmp/a.pdf", platform, async () => void (called = true))).toBeUndefined();
      expect(called).toBe(false);
    }
  });
});

describe("Gmail.downloadAttachment marks what it saves", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });
  const api = {
    users: { messages: { attachments: { get: async () => ({ data: { data: Buffer.from("MZ").toString("base64url") } }) } } },
  } as unknown as gmail_v1.Gmail;

  // Real NTFS: the stream is read back from disk, not from a stub.
  it.runIf(process.platform === "win32")("on Windows the saved file carries the mark", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-motw-"));
    const out = await new Gmail(api).downloadAttachment("m1", "a1", path.join(tmp, "setup.exe"));
    expect(out.markedAsDownloaded).toBe(true);
    expect(await fs.readFile(`${out.saved}:Zone.Identifier`, "utf8")).toBe(ZONE_IDENTIFIER);
    expect(await fs.readFile(out.saved, "utf8")).toBe("MZ");
  });

  it.runIf(process.platform !== "win32")("elsewhere the answer has no mark field", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-motw-"));
    const out = await new Gmail(api).downloadAttachment("m1", "a1", path.join(tmp, "setup.exe"));
    expect("markedAsDownloaded" in out).toBe(false);
  });
});

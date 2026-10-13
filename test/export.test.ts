import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fenceFor, htmlToText, renderThread } from "../src/export.js";
import { Gmail, type ParsedMessage } from "../src/gmail.js";

const AT = new Date("2026-10-13T12:00:00Z");
const m = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  from: "Ann <ann@x.example>",
  to: "me@y.example",
  subject: "Quarterly numbers",
  date: "Mon, 12 Oct 2026 09:00:00 +0200",
  snippet: "",
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass", authservId: "mx.google.com", dkimAligned: true },
  plaintextBody: "Hello,\nthe numbers are attached.",
  htmlBody: "",
  attachments: [],
  ...over,
});

describe("fenceFor", () => {
  it("is three backticks for ordinary text, and longer than any run inside", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("x `````` y")).toBe("```````");
  });
});

describe("htmlToText", () => {
  it("keeps line structure, drops markup, scripts and styles, decodes entities", () => {
    const html =
      "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there</p><script>alert(1)</script>" +
      "<ul><li>one</li><li>two &amp; three</li></ul>line<br>break &#x263A; &#9731;</body></html>";
    expect(htmlToText(html)).toBe("Hi there\n- one\n- two & three\nline\nbreak \u263A \u2603");
  });

  it("leaves an unknown or out-of-range entity as written", () => {
    expect(htmlToText("&bogus; &#99999999;")).toBe("&bogus; &#99999999;");
  });
});

describe("renderThread", () => {
  it("renders markdown: title, one section per message, authentication and attachments", () => {
    const out = renderThread(
      "t1",
      [
        m(),
        m({
          id: "m2",
          from: "me@y.example",
          plaintextBody: "Thanks!",
          authentication: { unchecked: true },
          attachments: [{ messageId: "m2", attachmentId: "a", filename: "q3.pdf", mimeType: "application/pdf", size: 1024 }],
        }),
      ],
      "markdown",
      AT,
    );
    expect(out).toContain("# Quarterly numbers\n");
    expect(out).toContain("Thread `t1`, 2 messages, exported 2026-10-13T12:00:00.000Z.");
    expect(out).toContain("## 1. Ann <ann@x.example>");
    expect(out).toContain("- **Sender authentication:** spf=pass, dkim=pass, dmarc=pass, dkimAligned=true");
    expect(out).toContain("- **Sender authentication:** unchecked (no report from Gmail)");
    expect(out).toContain("- **Attachments:** q3.pdf (application/pdf, 1024 bytes)");
    expect(out).toContain("```text\nHello,\nthe numbers are attached.\n```");
  });

  it("puts a body that carries its own fence inside a longer one, so it cannot break out", () => {
    const body = "```\n# Injected heading\n```";
    const out = renderThread("t1", [m({ plaintextBody: body })], "markdown", AT);
    expect(out).toContain("````text\n" + body + "\n````");
  });

  it("keeps a header newline from starting a new markdown line", () => {
    const out = renderThread("t1", [m({ subject: "a\n# b", from: "x\n- **To:** forged" })], "markdown", AT);
    expect(out).toContain("# a # b\n");
    expect(out).not.toMatch(/^- \*\*To:\*\* forged/m);
  });

  it("falls back to the HTML reduced to text when there is no plain part", () => {
    const out = renderThread("t1", [m({ plaintextBody: "", htmlBody: "<p>Only&nbsp;HTML</p>" })], "markdown", AT);
    expect(out).toContain("```text\nOnly HTML\n```");
  });

  it("renders json as get_thread's messages, HTML untouched", () => {
    const msg = m({ htmlBody: "<b>x</b>" });
    expect(JSON.parse(renderThread("t1", [msg], "json", AT))).toEqual({
      threadId: "t1",
      exportedAt: "2026-10-13T12:00:00.000Z",
      messages: [msg],
    });
  });
});

describe("Gmail.exportThread writes under the download fence", () => {
  let dir: string;
  const api = {
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: [
              {
                id: "m1",
                threadId: "t1",
                labelIds: ["INBOX"],
                payload: {
                  headers: [{ name: "From", value: "a@x.example" }, { name: "Subject", value: "S" }],
                  mimeType: "text/plain",
                  body: { data: Buffer.from("body").toString("base64url") },
                },
              },
            ],
          },
        }),
      },
    },
  };
  const gmail = () => {
    const g = new Gmail({} as never);
    (g as unknown as { api: unknown }).api = api;
    return g;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-export-"));
    vi.stubEnv("MAILWARDEN_DOWNLOAD_DIR", dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes inside the fence and never overwrites", async () => {
    const first = await gmail().exportThread("t1", "t1.md", "markdown");
    const second = await gmail().exportThread("t1", "t1.md", "markdown");
    expect(path.dirname(first.saved)).toBe(await fs.realpath(dir));
    expect(path.basename(second.saved)).toBe("t1-1.md");
    expect(first.messageCount).toBe(1);
    expect((await fs.readFile(first.saved, "utf8")).length).toBeGreaterThan(0);
    expect(first.bytes).toBe((await fs.readFile(first.saved)).length);
  });

  it("refuses a path that escapes the fence", async () => {
    await expect(gmail().exportThread("t1", "../outside.md", "markdown")).rejects.toThrow(/escapes MAILWARDEN_DOWNLOAD_DIR/);
  });
});

import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import {
  collectAttachments,
  collectBodies,
  isRealAttachment,
  looksLikeLabelId,
  Gmail,
} from "../src/gmail.js";

// node Buffer base64url helper for building test fixtures
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("collectAttachments — Bug 1: inline images must not count", () => {
  const inlineLogo: gmail_v1.Schema$MessagePart = {
    filename: "logo.png",
    mimeType: "image/png",
    headers: [
      { name: "Content-Disposition", value: "inline; filename=logo.png" },
      { name: "Content-ID", value: "<logo123>" },
    ],
    body: { attachmentId: "att-inline", size: 1234 },
  };

  const realPdf: gmail_v1.Schema$MessagePart = {
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    headers: [{ name: "Content-Disposition", value: "attachment; filename=invoice.pdf" }],
    body: { attachmentId: "att-pdf", size: 9999 },
  };

  const message: gmail_v1.Schema$Message = {
    id: "msg-1",
    threadId: "th-1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/html", body: { data: b64url("<p>hi</p>") } }, inlineLogo, realPdf],
    },
  };

  it("excludes the inline image", () => {
    expect(isRealAttachment(inlineLogo)).toBe(false);
  });

  it("includes the real PDF attachment", () => {
    expect(isRealAttachment(realPdf)).toBe(true);
  });

  it("collects only the real attachment from the full message", () => {
    const atts = collectAttachments(message);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      messageId: "msg-1",
      attachmentId: "att-pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 9999,
    });
  });

  it("treats an attachment with no Content-Disposition header as real", () => {
    const noDisposition: gmail_v1.Schema$MessagePart = {
      filename: "scan.pdf",
      mimeType: "application/pdf",
      body: { attachmentId: "att-nd", size: 5 },
    };
    expect(isRealAttachment(noDisposition)).toBe(true);
  });
});

describe("collectBodies — Bug 4: base64url decode", () => {
  it("decodes text/plain and text/html from base64url", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain body") } },
        { mimeType: "text/html", body: { data: b64url("<b>html body</b>") } },
      ],
    };
    const { text, html } = collectBodies(payload);
    expect(text).toBe("plain body");
    expect(html).toBe("<b>html body</b>");
  });

  it("decodes content whose base64url contains '-' or '_' (would corrupt under plain base64)", () => {
    // Pick a string whose standard base64 contains '+' or '/', so its base64url
    // form contains '-' or '_'. "subjects??" -> base64 "c3ViamVjdHM/Pw==" (has '/'),
    // base64url "c3ViamVjdHM_Pw". If decoded as plain base64, '_' is invalid.
    const original = "subjects??";
    const encoded = Buffer.from(original, "utf8").toString("base64url");
    expect(encoded).toMatch(/[-_]/); // sanity: fixture actually exercises the url alphabet

    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: encoded },
    };
    expect(collectBodies(payload).text).toBe(original);
  });
});

describe("looksLikeLabelId", () => {
  it("recognises system label ids and Label_* / CATEGORY_* as ids", () => {
    for (const id of ["INBOX", "UNREAD", "TRASH", "CATEGORY_PROMOTIONS", "Label_21"]) {
      expect(looksLikeLabelId(id)).toBe(true);
    }
  });
  it("treats human-readable names as non-ids", () => {
    for (const name of ["ToDo", "MCP/Snoozed", "Scanbot/zu-löschen"]) {
      expect(looksLikeLabelId(name)).toBe(false);
    }
  });
});

describe("modifyLabels — Bug 3: name → id resolution", () => {
  // Minimal fake gmail_v1.Gmail capturing the modify request body.
  function fakeApi() {
    const calls: { modify: any[]; create: any[] } = { modify: [], create: [] };
    const api: any = {
      users: {
        labels: {
          list: async () => ({
            data: {
              labels: [
                { id: "Label_21", name: "ToDo", type: "user" },
                { id: "Label_7", name: "Scanbot/abgelegt", type: "user" },
              ],
            },
          }),
          create: async (req: any) => {
            calls.create.push(req);
            return { data: { id: "Label_NEW" } };
          },
        },
        threads: {
          modify: async (req: any) => {
            calls.modify.push(req);
            return { data: {} };
          },
        },
      },
    };
    return { api, calls };
  }

  it("translates a known name to its id and passes ids through unchanged", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["ToDo"], ["INBOX"]);

    expect(calls.modify).toHaveLength(1);
    const body = calls.modify[0].requestBody;
    expect(body.addLabelIds).toEqual(["Label_21"]); // name → id
    expect(body.removeLabelIds).toEqual(["INBOX"]); // id passes through
    expect(calls.create).toHaveLength(0); // existing name → no create
  });

  it("creates an unknown name in `add` via ensureLabel", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["BrandNew"], []);

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].requestBody.name).toBe("BrandNew");
    expect(calls.modify[0].requestBody.addLabelIds).toEqual(["Label_NEW"]);
  });

  it("skips an unknown name in `remove`", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", [], ["DoesNotExist"]);

    expect(calls.modify[0].requestBody.removeLabelIds).toEqual([]);
    expect(calls.create).toHaveLength(0);
  });

  it("skips listLabels() when only ids are passed (no name lookup needed)", async () => {
    const { api } = fakeApi();
    let listCalled = false;
    api.users.labels.list = async () => {
      listCalled = true;
      return { data: { labels: [] } };
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["INBOX"], ["UNREAD"]);
    expect(listCalled).toBe(false);
  });
});

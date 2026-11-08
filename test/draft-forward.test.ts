import { describe, it, expect, vi } from "vitest";
import { MAX_BODY_CHARS, forwardHeader, forwardSubject, withForward, type ForwardSource } from "../src/draft.js";
import { reviseDraft, saveForwardDraft, type DraftGmail } from "../src/draft-flow.js";
import { ToolError } from "../src/cli.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const AT = new Date("2026-11-05T08:56:03Z");
const mail: ForwardSource = {
  name: "Ann",
  address: "ann@partner.example",
  date: AT,
  text: ["Hi,", "", "<b>the invoice</b> is attached."].join(CR + LF),
  subject: "Invoice 42",
  to: "me@example.com",
  cc: "bob@partner.example",
};

describe("forwardSubject", () => {
  it.each([
    ["Invoice 42", "Fwd: Invoice 42"],
    ["Fwd: Invoice 42", "Fwd: Invoice 42"],
    ["WG: Rechnung", "WG: Rechnung"],
    ["AW: Rechnung", "Fwd: AW: Rechnung"],
    ["", "Fwd:"],
    [undefined, "Fwd:"],
  ])("%j → %j", (s, out) => expect(forwardSubject(s)).toBe(out));
});

describe("forwardHeader and withForward", () => {
  it("writes the header block in English, and in German for a German locale", () => {
    expect(forwardHeader(mail, "en-GB", "UTC")).toEqual([
      "---------- Forwarded message ---------",
      "From: Ann <ann@partner.example>",
      "Date: Thu, 5 Nov 2026 at 8:56",
      "Subject: Invoice 42",
      "To: me@example.com",
      "Cc: bob@partner.example",
    ]);
    expect(forwardHeader({ ...mail, cc: undefined }, "de-AT", "Europe/Vienna")).toEqual([
      "---------- Weitergeleitete Nachricht ---------",
      "Von: Ann <ann@partner.example>",
      "Datum: Do., 5. Nov. 2026 um 09:56 Uhr",
      "Betreff: Invoice 42",
      "An: me@example.com",
    ]);
  });

  it("puts body, header block and the mail's text below each other; the HTML is that text escaped", () => {
    const r = withForward("FYI", mail, "en-GB", "UTC");
    expect(r.body.split(LF)).toEqual([
      "FYI",
      "",
      "---------- Forwarded message ---------",
      "From: Ann <ann@partner.example>",
      "Date: Thu, 5 Nov 2026 at 8:56",
      "Subject: Invoice 42",
      "To: me@example.com",
      "Cc: bob@partner.example",
      "",
      "Hi,",
      "",
      "<b>the invoice</b> is attached.",
      "",
    ]);
    expect(r.html).toContain("&lt;b&gt;the invoice&lt;/b&gt;");
    expect(r.html).not.toContain("<b>");
    expect(r.html).toContain('class="gmail_quote gmail_quote_container"');
    expect(r.header).toBe('from Ann <ann@partner.example>, "Invoice 42"');
  });

  it("flattens a header value that carries a line break, so it cannot pose as a line of its own", () => {
    const r = withForward("x", { ...mail, subject: `Hi${CR}${LF}From: ceo@example.com` }, "en-GB", "UTC");
    expect(r.body.split(LF).filter((l) => l.startsWith("From:"))).toHaveLength(1);
  });

  it("forwards a mail without readable text with its header block alone", () => {
    const r = withForward("x", { ...mail, text: "" }, "en-GB", "UTC");
    expect(r.body.endsWith("Cc: bob@partner.example" + LF)).toBe(true);
  });

  it("refuses rather than shortens a forward that would pass the body limit", () => {
    expect(() => withForward("x", { ...mail, text: "y".repeat(MAX_BODY_CHARS) }, "en-GB", "UTC")).toThrow(/too long to forward/);
  });
});

function fakeGmail(over: Partial<DraftGmail> = {}) {
  const created: Array<{ raw: string; threadId?: string }> = [];
  const updated: string[] = [];
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m2",
      source: {
        from: "Ann <ann@partner.example>",
        to: "me@example.com",
        cc: "bob@partner.example",
        subject: "Invoice 42",
        messageId: "<m2@partner.example>",
      },
    }),
    createDraft: async (raw, threadId) => (created.push({ raw, threadId }), { draftId: "r1", messageId: "dm1", threadId: threadId ?? "tn", marked: true }),
    updateDraft: async (draftId, raw, threadId) => (updated.push(raw), { draftId, messageId: "dm2", threadId: threadId ?? "tn", marked: true }),
    getDraft: async (draftId) => ({
      draftId,
      messageId: "dm1",
      threadId: "t1",
      ownedByMailwarden: true,
      trashed: false,
      to: "carl@else.example",
      subject: "Fwd: Invoice 42",
      inReplyTo: "<m2@partner.example>",
      references: "<m2@partner.example>",
      attachments: [],
    }),
    threadAttachments: async () => [
      { messageId: "m2", attachmentId: "a1", filename: "invoice.pdf", mimeType: "application/pdf", size: 3, from: "ann@partner.example", to: "me@example.com" },
      { messageId: "m1", attachmentId: "a0", filename: "older.pdf", mimeType: "application/pdf", size: 3, from: "ann@partner.example", to: "me@example.com" },
    ],
    attachmentBytes: async () => Buffer.from("pdf"),
    sendAsAddresses: async () => [{ address: "me@example.com", primary: true }],
    quoteSource: async () => ({
      name: "Ann",
      address: "ann@partner.example",
      date: AT,
      plaintextBody: "the invoice is attached.",
      htmlBody: "",
      subject: "Invoice 42",
      to: "me@example.com",
    }),
    ...over,
  };
  return { gmail, created, updated };
}

describe("saveForwardDraft", () => {
  it("forwards the mail with its attachments into its thread, asks about the new recipient and the file", async () => {
    const { gmail, created } = fakeGmail();
    const confirm = vi.fn(async () => true);
    const r = await saveForwardDraft(gmail, { threadId: "t1", to: ["carl@else.example"], body: "FYI" }, "off", confirm);
    expect(r).toMatchObject({ kind: "forward", subject: "Fwd: Invoice 42", to: ["carl@else.example"], newRecipients: ["carl@else.example"] });
    expect(r.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", bytes: 3, source: "message" }]);
    expect(created[0].threadId).toBe("t1");
    expect(created[0].raw).toContain("In-Reply-To: <m2@partner.example>");
    expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("save a draft that forwards a mail"));
    const dialog = confirm.mock.calls[0][1];
    expect(dialog).toContain("carl@else.example (new");
    expect(dialog).toContain("invoice.pdf (3 bytes, from a mail in the thread that never went to carl@else.example)");
    expect(dialog).toContain('Forwarded below the text: the mail from Ann <ann@partner.example>, "Invoice 42"');
  });

  it("forwardAttachments: false carries none; a forward to someone the mail went to is not new", async () => {
    const { gmail } = fakeGmail();
    const confirm = vi.fn(async () => true);
    const r = await saveForwardDraft(
      gmail,
      { threadId: "t1", to: ["bob@partner.example"], body: "FYI", forwardAttachments: false },
      "off",
      confirm,
    );
    expect(r.attachments).toEqual([]);
    expect(r.newRecipients).toEqual([]);
    expect(confirm).toHaveBeenCalledWith("off", expect.any(String));
  });

  it("a declined dialog writes nothing", async () => {
    const { gmail, created } = fakeGmail();
    const confirm = vi.fn(async () => {
      throw new ToolError("declined_by_user", "no");
    });
    await expect(saveForwardDraft(gmail, { threadId: "t1", to: ["carl@else.example"], body: "x" }, "off", confirm)).rejects.toThrow("no");
    expect(created).toEqual([]);
  });

  it("refuses a mail with more attachments than a draft may carry, before fetching any", async () => {
    const attachmentBytes = vi.fn(async () => Buffer.from("x"));
    const many = Array.from({ length: 11 }, (_, i) => ({ messageId: "m2", attachmentId: `a${i}`, filename: `f${i}.pdf`, mimeType: "application/pdf", size: 1 }));
    const { gmail } = fakeGmail({ threadAttachments: async () => many, attachmentBytes });
    await expect(saveForwardDraft(gmail, { threadId: "t1", to: ["carl@else.example"], body: "x" }, "off", vi.fn(async () => true))).rejects.toThrow(
      /forwardAttachments: false/,
    );
    expect(attachmentBytes).not.toHaveBeenCalled();
  });

  it("refuses when the mail is gone by the time its text is read", async () => {
    const { gmail } = fakeGmail({ quoteSource: async () => undefined });
    await expect(saveForwardDraft(gmail, { threadId: "t1", to: ["carl@else.example"], body: "x" }, "off", vi.fn(async () => true))).rejects.toThrow(
      /no longer in the thread/,
    );
  });
});

describe("reviseDraft — forward: true", () => {
  it("forwards the mail the draft refers to below the new body again", async () => {
    const { gmail, updated } = fakeGmail();
    const r = await reviseDraft(gmail, { draftId: "r1", messageId: "dm1", body: "Neu", forward: true }, "off", vi.fn(async () => true));
    expect(r.kind).toBe("forward");
    expect(updated[0]).toContain("multipart/alternative");
  });

  it("refuses quote and forward together, and forward on a new message", async () => {
    const { gmail } = fakeGmail();
    await expect(
      reviseDraft(gmail, { draftId: "r1", messageId: "dm1", body: "x", forward: true, quote: true }, "off", vi.fn(async () => true)),
    ).rejects.toThrow(/exclude each other/);
    const plain = fakeGmail({
      getDraft: async (draftId) => ({ draftId, messageId: "dm1", threadId: "t9", ownedByMailwarden: true, trashed: false, to: "x@else.example", subject: "s", attachments: [] }),
    });
    await expect(reviseDraft(plain.gmail, { draftId: "r1", messageId: "dm1", body: "x", forward: true }, "off", vi.fn(async () => true))).rejects.toThrow(
      /nothing to forward/,
    );
  });
});

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import { MAX_BODY_CHARS, quoteAttribution, quotedText, withQuote, type QuoteSource } from "../src/draft.js";
import { reviseDraft, saveReplyDraft, type DraftGmail } from "../src/draft-flow.js";
import { htmlToText } from "../src/export.js";
import { Gmail } from "../src/gmail.js";
import { ToolError } from "../src/cli.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
// 5 Nov 2026, 08:56 UTC: 09:56 in Vienna.
const AT = new Date("2026-11-05T08:56:03Z");
const ann: QuoteSource = { name: "Jürgen Müller", address: "jm@example.com", date: AT, text: "Hello again," };

describe("quoteAttribution — the line above the quote, as Gmail writes it", () => {
  it("German, in the machine's time zone", () => {
    expect(quoteAttribution(ann, "de-AT", "Europe/Vienna")).toBe(
      "Am Do., 5. Nov. 2026 um 09:56 Uhr schrieb Jürgen Müller <jm@example.com>:",
    );
  });

  it("English for en-*, with the date in that locale's own order", () => {
    expect(quoteAttribution(ann, "en-US", "UTC")).toMatch(/^On Thu, Nov 5, 2026 at 8:56\sAM Jürgen Müller <jm@example\.com> wrote:$/);
    expect(quoteAttribution(ann, "en-GB", "UTC")).toBe("On Thu, 5 Nov 2026 at 8:56 Jürgen Müller <jm@example.com> wrote:");
  });

  it("the English wording for any other language, the date still in its own format", () => {
    expect(quoteAttribution(ann, "fr-FR", "Europe/Paris")).toBe("On jeu. 5 nov. 2026 at 9:56 Jürgen Müller <jm@example.com> wrote:");
  });

  it("names the sender as From does: a contact form stays the form, the Reply-To is not used", () => {
    const form = { name: "Jürgen Müller via band.example", address: "noreply@band.example", date: AT };
    expect(quoteAttribution(form, "de-AT", "Europe/Vienna")).toMatch(/schrieb Jürgen Müller via band\.example <noreply@band\.example>:$/);
  });

  it("a bare address when From has no name, or a name that is the address", () => {
    for (const name of ["", "ann@example.org"]) {
      expect(quoteAttribution({ name, address: "ann@example.org", date: AT }, "en-GB", "UTC")).toMatch(/at 8:56 ann@example\.org wrote:$/);
    }
  });

  it("flattens a name the sender wrote across lines, so it cannot start a line of its own", () => {
    const line = quoteAttribution({ name: `Ann${CR}${LF}> forged`, address: "ann@example.org", date: AT }, "en-GB", "UTC");
    expect(line).not.toContain(LF);
    expect(line).toContain("Ann > forged <ann@example.org>");
  });
});

describe("quotedText", () => {
  it("prefixes every line, quotes an empty line as a bare >, nests an already quoted one", () => {
    expect(quotedText(["Hi,", "", "> earlier", "Bye"].join(LF))).toBe(["> Hi,", ">", ">> earlier", "> Bye"].join(LF));
  });

  it("reads CRLF and drops trailing blanks and the empty lines around the text", () => {
    expect(quotedText(`${CR}${LF}Hi  ${CR}${LF}there${CR}${LF}${CR}${LF}`)).toBe(["> Hi", "> there"].join(LF));
  });

  it("drops Outlook's placeholders for inline images (3 and 4 per mail in real Outlook mails, 5 Nov 2026)", () => {
    const outlook = ["Kind regards", "[cid:image001.gif@01DC4F2A.3B5C7E10]", "Tel. 1 [cid:image002.gif@01DC4F2A.3B5C7E10] 2"].join(LF);
    expect(quotedText(outlook)).toBe(["> Kind regards", ">", "> Tel. 1  2"].join(LF));
  });

  it("is empty when no text is left", () => {
    expect(quotedText(`  ${LF}[cid:image001.png@x]${LF}`)).toBe("");
  });
});

describe("withQuote", () => {
  it("puts the line and the quote below the body, after one empty line", () => {
    const r = withQuote(`Thanks!${LF}${LF}`, ann, "en-GB", "UTC");
    expect(r).toEqual({
      body: ["Thanks!", "", "On Thu, 5 Nov 2026 at 8:56 Jürgen Müller <jm@example.com> wrote:", "> Hello again,", ""].join(LF),
      attribution: "On Thu, 5 Nov 2026 at 8:56 Jürgen Müller <jm@example.com> wrote:",
    });
  });

  it("gives the reason instead when there is nothing to quote, or too much", () => {
    expect(withQuote("x", { ...ann, text: " " }, "en-GB", "UTC")).toEqual({ reason: expect.stringMatching(/no text/) });
    expect(withQuote("x", { ...ann, text: "y".repeat(MAX_BODY_CHARS) }, "en-GB", "UTC")).toEqual({
      reason: expect.stringMatching(/too long to quote/),
    });
  });
});

describe("htmlToText — table cells", () => {
  it("keeps the cells of a row apart (a booking form read TypeGuestsBudget)", () => {
    const html = "<table><tr><th>Type</th><th>Guests</th></tr><tr><td>Carnival</td><td>200</td></tr></table>";
    expect(htmlToText(html)).toBe(["Type Guests", "Carnival 200"].join(LF));
  });
});

// ---- the flow, against a fake mailbox ----

function fakeGmail(over: Partial<DraftGmail> = {}) {
  const created: string[] = [];
  const updated: string[] = [];
  const quoteSource = vi.fn<DraftGmail["quoteSource"]>(async () => ({
    name: "Ann",
    address: "ann@example.org",
    date: AT,
    plaintextBody: ["Can you play on the 13th?", "", "Ann"].join(CR + LF),
    htmlBody: "",
  }));
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m2",
      source: { from: "Ann <ann@example.org>", to: "me@example.com", subject: "Gig", messageId: "<m2@example.org>" },
    }),
    createDraft: async (raw, threadId) => (created.push(raw), { draftId: "r1", messageId: "dm1", threadId: threadId ?? "tn", marked: true }),
    updateDraft: async (draftId, raw, threadId) => (updated.push(raw), { draftId, messageId: "dm2", threadId: threadId ?? "tn", marked: true }),
    getDraft: async (draftId) => ({
      draftId,
      messageId: "dm1",
      threadId: "t1",
      ownedByMailwarden: true,
      trashed: false,
      to: "ann@example.org",
      subject: "Re: Gig",
      inReplyTo: "<m2@example.org>",
      references: "<m2@example.org>",
      attachments: [],
    }),
    threadAttachments: async () => [],
    attachmentBytes: async () => Buffer.alloc(0),
    sendAsAddresses: async () => [{ address: "me@example.com", primary: true }],
    quoteSource,
    ...over,
  };
  return { gmail, created, updated, quoteSource };
}

const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, LF);

describe("saveReplyDraft — quote", () => {
  it("quotes the message it answers below the body, and the dialog says so", async () => {
    const { gmail, created, quoteSource } = fakeGmail();
    const confirm = vi.fn(async () => true);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Yes, we can.", quote: true }, "ask", confirm);
    expect(quoteSource).toHaveBeenCalledWith("t1", { messageId: "m2" });
    const body = bodyOf(created[0]);
    expect(body).toMatch(/^Yes, we can\.\n\n.*Ann <ann@example\.org>.*:\n> Can you play on the 13th\?\n>\n> Ann\n$/);
    expect(confirm).toHaveBeenCalledWith("ask", expect.stringMatching(/Quoted below the text: .*Ann <ann@example\.org>/));
    expect(r.quoted).toBe(true);
  });

  it("reduces an HTML-only message to text for the quote", async () => {
    const { gmail, created } = fakeGmail({
      quoteSource: async () => ({ name: "", address: "a@example.org", date: AT, plaintextBody: "", htmlBody: "<p>Hallo</p><table><tr><td>A</td><td>B</td></tr></table>" }),
    });
    await saveReplyDraft(gmail, { threadId: "t1", body: "x", quote: true }, "off", vi.fn(async () => false));
    expect(bodyOf(created[0])).toMatch(/\n> Hallo\n> A B\n$/);
  });

  it("saves the reply without a quote, and says why, when the message has no text", async () => {
    const { gmail, created } = fakeGmail({
      quoteSource: async () => ({ name: "", address: "a@example.org", date: AT, plaintextBody: "", htmlBody: "<img src=x>" }),
    });
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x", quote: true }, "off", vi.fn(async () => false));
    expect(bodyOf(created[0])).toBe("x");
    expect(r.quoted).toBe(false);
    expect(r.note).toMatch(/No quote was added: the answered message has no text/);
  });

  it("reads nothing more and reports nothing about a quote when none is asked for", async () => {
    const { gmail, created, quoteSource } = fakeGmail();
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", vi.fn(async () => false));
    expect(quoteSource).not.toHaveBeenCalled();
    expect(bodyOf(created[0])).toBe("x");
    expect(r).not.toHaveProperty("quoted");
  });
});

describe("reviseDraft — quote", () => {
  it("quotes again the message the draft answers, found by its In-Reply-To", async () => {
    const { gmail, updated, quoteSource } = fakeGmail();
    const r = await reviseDraft(gmail, { draftId: "r1", body: "Better text.", quote: true }, "off", vi.fn(async () => false));
    expect(quoteSource).toHaveBeenCalledWith("t1", { rfcMessageId: "<m2@example.org>" });
    expect(bodyOf(updated[0])).toMatch(/^Better text\.\n\n.*\n> Can you play on the 13th\?/);
    expect(r.quoted).toBe(true);
  });

  it("says so when the answered message is gone from the thread", async () => {
    const { gmail, updated } = fakeGmail({ quoteSource: async () => undefined });
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x", quote: true }, "off", vi.fn(async () => false));
    expect(bodyOf(updated[0])).toBe("x");
    expect(r).toMatchObject({ quoted: false, note: expect.stringMatching(/no longer in the thread/) });
  });

  it("refuses a quote for a draft of a new message, before anything is read or written", async () => {
    const { gmail, updated, quoteSource } = fakeGmail({
      getDraft: async (draftId) => ({ draftId, messageId: "dm1", threadId: "t9", ownedByMailwarden: true, trashed: false, to: "a@example.org", subject: "Hi", attachments: [] }),
    });
    const err = await reviseDraft(gmail, { draftId: "r1", body: "x", quote: true }, "off", vi.fn(async () => true)).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/nothing to quote/);
    expect(quoteSource).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
  });
});

describe("Gmail.quoteSource", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const message = (id: string, from: string, text: string, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message => ({
    id,
    threadId: "t1",
    internalDate: String(AT.getTime()),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "Message-ID", value: `<${id}@example.org>` },
        { name: "Content-Type", value: "text/plain; charset=UTF-8" },
      ],
      body: { data: b64(text) },
    },
    ...extra,
  });
  const api = (messages: gmail_v1.Schema$Message[]) => {
    const get = vi.fn(async () => ({ data: { messages } }));
    return { get, gmail: new Gmail({ users: { threads: { get } } } as unknown as gmail_v1.Gmail) };
  };

  it("reads the newest message that is not a draft, in full, with the From name decoded", async () => {
    const { get, gmail } = api([
      message("m1", "=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <jm@example.com>", "Hello again,"),
      message("d1", "me@example.com", "draft", { labelIds: ["DRAFT"] }),
    ]);
    const q = await gmail.quoteSource("t1", {});
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", format: "full" }));
    expect(q).toEqual({ name: "Jürgen Müller", address: "jm@example.com", date: AT, plaintextBody: "Hello again,", htmlBody: "" });
  });

  it("picks by Gmail id or by Message-ID, and is undefined when neither is there", async () => {
    const { gmail } = api([message("m1", "a@example.org", "one"), message("m2", "b@example.org", "two")]);
    expect((await gmail.quoteSource("t1", { messageId: "m1" }))?.plaintextBody).toBe("one");
    expect((await gmail.quoteSource("t1", { rfcMessageId: "<m1@example.org>" }))?.plaintextBody).toBe("one");
    expect(await gmail.quoteSource("t1", { rfcMessageId: "<gone@example.org>" })).toBeUndefined();
  });
});

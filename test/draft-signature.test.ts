import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import { MAX_BODY_CHARS, MAX_SIGNATURE_CHARS, signatureOf, unsigned, withQuote, withSignature, draftDialog } from "../src/draft.js";
import { reviseDraft, saveNewDraft, saveReplyDraft, type DraftGmail, type SendAs } from "../src/draft-flow.js";
import { Gmail } from "../src/gmail.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const AT = new Date("2026-11-05T08:56:03Z");
const SIG_HTML = '<div dir="ltr">Chris Sitte<br>Softwaretechnik<br><a href="https://example.com">example.com</a></div>';

describe("signatureOf — the signature Gmail's settings hold, as HTML and as text", () => {
  it("reduces the HTML to text, line breaks kept", () => {
    expect(signatureOf(SIG_HTML)).toEqual({ text: ["Chris Sitte", "Softwaretechnik", "example.com"].join(LF), html: SIG_HTML });
  });

  it("none for an empty signature, one that is only an image, or one longer than Gmail allows", () => {
    expect(signatureOf(undefined)).toBeUndefined();
    expect(signatureOf("")).toBeUndefined();
    expect(signatureOf('<div><img src="https://example.com/logo.png"></div>')).toBeUndefined();
    expect(signatureOf("x".repeat(MAX_SIGNATURE_CHARS + 1))).toBeUndefined();
  });
});

describe("withSignature and unsigned", () => {
  const sig = signatureOf(SIG_HTML)!;

  it("puts the signature below the body after a '-- ' line, and the same in Gmail's signature block", () => {
    const r = withSignature(`Hallo Ann,${LF}${LF}bis Freitag.${LF}${LF}`, sig);
    if ("reason" in r) throw new Error(r.reason);
    expect(r.body).toBe(["Hallo Ann,", "", "bis Freitag.", "", "-- ", "Chris Sitte", "Softwaretechnik", "example.com", ""].join(LF));
    expect(r.html).toBe(
      '<div dir="auto">Hallo Ann,<br><br>bis Freitag.</div>' +
        '<br><span class="gmail_signature_prefix">-- </span><br>' +
        `<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${SIG_HTML}</div>`,
    );
  });

  it("escapes the body in the HTML, carries the signature's HTML as Gmail stores it", () => {
    const r = withSignature("1 < 2 & <b>no</b>", sig);
    if ("reason" in r) throw new Error(r.reason);
    expect(r.html).toContain("1 &lt; 2 &amp; &lt;b&gt;no&lt;/b&gt;");
    expect(r.html).toContain('<a href="https://example.com">');
  });

  it("does not sign twice a body that already ends with the signature, with or without the '-- ' line", () => {
    for (const body of [
      `Hi${LF}${LF}-- ${LF}${sig.text}`,
      `Hi${CR}${LF}${CR}${LF}--${CR}${LF}${sig.text}${CR}${LF}`,
      `Hi${LF}${LF}${sig.text}  ${LF}`,
    ]) {
      expect(unsigned(body, sig)).toBe("Hi");
      const r = withSignature(body, sig);
      if ("reason" in r) throw new Error(r.reason);
      expect(r.body.split(sig.text)).toHaveLength(2);
    }
  });

  it("leaves a body alone that merely mentions the signature's text, or ends with part of a line", () => {
    expect(unsigned(`${sig.text}${LF}${LF}Hi`, sig)).toBe(`${sig.text}${LF}${LF}Hi`);
    expect(unsigned(`Mr ${sig.text}`, sig)).toBe(`Mr ${sig.text}`);
  });

  it("gives a reason instead of passing the body limit", () => {
    const r = withSignature("x".repeat(MAX_BODY_CHARS - 5), sig);
    expect(r).toEqual({ reason: expect.stringMatching(/body and signature together pass/) });
  });

  it("in a quoted reply the signature sits between the body and the quote, in both parts", () => {
    const r = withQuote("Ja.", { name: "Ann", address: "ann@example.org", date: AT, text: "Kannst du?" }, "en-GB", "UTC", sig);
    if ("reason" in r) throw new Error(r.reason);
    const lines = r.body.split(LF);
    expect(lines.slice(0, 7)).toEqual(["Ja.", "", "-- ", "Chris Sitte", "Softwaretechnik", "example.com", ""]);
    expect(lines[7]).toMatch(/^On .* Ann <ann@example\.org> wrote:$/);
    expect(lines[8]).toBe("> Kannst du?");
    expect(r.html.indexOf("gmail_signature")).toBeGreaterThan(0);
    expect(r.html.indexOf("gmail_signature")).toBeLessThan(r.html.indexOf("gmail_quote"));
  });

  it("the dialog shows the signature's text", () => {
    const d = draftDialog("new", { to: ["a@example.org"], cc: [], bcc: [], subject: "s", body: "b", signature: sig.text }, ["a@example.org"]);
    expect(d).toContain("Signature from Gmail's settings: Chris Sitte Softwaretechnik example.com");
  });
});

// ---- the flow ----

function fakeGmail(sendAs: SendAs[], over: Partial<DraftGmail> = {}) {
  const created: string[] = [];
  const updated: string[] = [];
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m2",
      source: { from: "Ann <ann@example.org>", to: "me@example.com, band@example.com", subject: "Gig", messageId: "<m2@example.org>" },
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
    sendAsAddresses: async () => sendAs,
    quoteSource: async () => ({ name: "Ann", address: "ann@example.org", date: AT, plaintextBody: "Kannst du?", htmlBody: "" }),
    ...over,
  };
  return { gmail, created, updated };
}

const partOf = (raw: string, type: string) => {
  const m = new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]*)`).exec(raw);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, LF) : undefined;
};

const ACCOUNT: SendAs[] = [
  { address: "me@example.com", primary: true, signature: "<div>Chris</div>" },
  { address: "band@example.com", primary: false, signature: "<div>The Band</div>" },
];

describe("drafts carry the sender's signature", () => {
  it("a new message gets the main address's signature by default, as text and HTML", async () => {
    const { gmail, created } = fakeGmail(ACCOUNT);
    const confirm = vi.fn(async () => true);
    const r = await saveNewDraft(gmail, { to: ["x@example.net"], subject: "Hi", body: "Hallo" }, confirm);
    expect(r.signed).toBe(true);
    expect(partOf(created[0], "text/plain")).toBe(["Hallo", "", "-- ", "Chris", ""].join(LF));
    expect(partOf(created[0], "text/html")).toContain('data-smartmail="gmail_signature"><div>Chris</div>');
    expect(confirm.mock.calls[0][1]).toContain("Signature from Gmail's settings: Chris");
  });

  it("an alias gets the alias's own signature", async () => {
    const { gmail, created } = fakeGmail(ACCOUNT);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Ja", from: "band@example.com" }, "off", vi.fn(async () => true));
    expect(r.signed).toBe(true);
    expect(partOf(created[0], "text/plain")).toContain(`-- ${LF}The Band`);
    expect(partOf(created[0], "text/plain")).not.toContain("Chris");
  });

  it("signature: false, or an account without one: plain text as before, signed: false", async () => {
    for (const [sendAs, signature] of [
      [ACCOUNT, false],
      [[{ address: "me@example.com", primary: true }], undefined],
    ] as const) {
      const { gmail, created } = fakeGmail([...sendAs]);
      const r = await saveNewDraft(gmail, { to: ["x@example.net"], subject: "Hi", body: "Hallo", signature }, vi.fn(async () => true));
      expect(r.signed).toBe(false);
      expect(created[0]).not.toContain("multipart/alternative");
      expect(partOf(created[0], "text/plain")).toBe("Hallo");
    }
  });

  it("a quoted reply has the signature between body and quote", async () => {
    const { gmail, created } = fakeGmail(ACCOUNT);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Ja", quote: true }, "off", vi.fn(async () => true));
    expect(r).toMatchObject({ signed: true, quoted: true });
    const text = partOf(created[0], "text/plain")!;
    expect(text.indexOf("-- ")).toBeLessThan(text.indexOf("> Kannst du?"));
  });

  it("a quote that cannot be made still leaves the draft signed", async () => {
    const { gmail, created } = fakeGmail(ACCOUNT, {
      quoteSource: async () => ({ name: "Ann", address: "ann@example.org", date: AT, plaintextBody: "", htmlBody: "" }),
    });
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Ja", quote: true }, "off", vi.fn(async () => true));
    expect(r).toMatchObject({ signed: true, quoted: false });
    expect(partOf(created[0], "text/plain")).toBe(["Ja", "", "-- ", "Chris", ""].join(LF));
  });

  it("update_draft signs the new body again, and not twice when the body was read back with its signature", async () => {
    const { gmail, updated } = fakeGmail(ACCOUNT);
    await reviseDraft(gmail, { draftId: "r1", messageId: "dm1", body: `Neu${LF}${LF}-- ${LF}Chris` }, "off", vi.fn(async () => true));
    expect(partOf(updated[0], "text/plain")).toBe(["Neu", "", "-- ", "Chris", ""].join(LF));
  });

  it("a body too long to take the signature is saved without it, and the note says so", async () => {
    const { gmail, created } = fakeGmail(ACCOUNT);
    const r = await saveNewDraft(gmail, { to: ["x@example.net"], subject: "Hi", body: "x".repeat(MAX_BODY_CHARS - 3) }, vi.fn(async () => true));
    expect(r.signed).toBe(false);
    expect(r.note).toMatch(/No signature was added: body and signature together pass/);
    expect(created[0]).not.toContain("multipart/alternative");
  });
});

describe("Gmail.sendAsAddresses — the signature comes along", () => {
  it("passes each verified address's signature through, and none for an empty one", async () => {
    const api: any = {
      users: {
        settings: {
          sendAs: {
            list: async () => ({
              data: {
                sendAs: [
                  { sendAsEmail: "Me@example.com", isPrimary: true, signature: "<b>Me</b>" },
                  { sendAsEmail: "band@example.com", verificationStatus: "accepted", signature: "" },
                  { sendAsEmail: "pending@example.com", verificationStatus: "pending", signature: "<b>P</b>" },
                ],
              },
            }),
          },
        },
      },
    };
    expect(await new Gmail(api as gmail_v1.Gmail).sendAsAddresses()).toEqual([
      { address: "me@example.com", primary: true, signature: "<b>Me</b>" },
      { address: "band@example.com", primary: false },
    ]);
  });
});

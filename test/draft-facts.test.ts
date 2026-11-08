import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import { describeFacts, editDistance, lookalikeOf, searchableAddress, staticFacts } from "../src/draft.js";
import { saveNewDraft, saveReplyDraft, type DraftGmail } from "../src/draft-flow.js";
import { Gmail } from "../src/gmail.js";

describe("editDistance and lookalikeOf", () => {
  it("counts edits up to the cap and gives up past it", () => {
    expect(editDistance("example.com", "example.com", 2)).toBe(0);
    expect(editDistance("example.com", "examp1e.com", 2)).toBe(1);
    expect(editDistance("example.com", "exampel.com", 2)).toBe(2);
    expect(editDistance("example.com", "elsewhere.org", 2)).toBe(3);
  });

  it("names a near miss of a known domain, never the domain itself", () => {
    expect(lookalikeOf("examp1e.com", ["example.com"])).toBe("example.com");
    expect(lookalikeOf("example.co", ["example.com"])).toBe("example.com");
    expect(lookalikeOf("example-partner.com", ["example-partners.com"])).toBe("example-partners.com");
    expect(lookalikeOf("example.com", ["example.com"])).toBeUndefined();
    expect(lookalikeOf("example.com", [""])).toBeUndefined();
  });

  it("one edit only for a short domain: gmx.at is not a lookalike of gmx.de", () => {
    expect(lookalikeOf("gmx.at", ["gmx.de"])).toBeUndefined();
    expect(lookalikeOf("gmx.de", ["gmx.de", "gmz.de"])).toBe("gmz.de");
  });
});

describe("staticFacts and describeFacts", () => {
  it("marks a lookalike, an international domain and an address only Reply-To names", () => {
    const f = staticFacts(
      ["ann@examp1e.com", "bob@xn--exmple-cua.com", "pay@elsewhere.org"],
      ["ann@example.com", "me@mine.example"],
      ["pay@elsewhere.org"],
    );
    expect(describeFacts(f["ann@examp1e.com"])).toEqual(["looks like example.com"]);
    expect(describeFacts(f["bob@xn--exmple-cua.com"])).toEqual(["international domain"]);
    expect(describeFacts(f["pay@elsewhere.org"])).toEqual(["only in the answered mail's Reply-To"]);
  });

  it("says written to or never only when that was looked up", () => {
    expect(describeFacts({ writtenTo: false })).toEqual(["never written to"]);
    expect(describeFacts({ writtenTo: true })).toEqual(["written to before"]);
    expect(describeFacts({})).toEqual([]);
    expect(describeFacts(undefined)).toEqual([]);
  });
});

function fakeGmail(over: Partial<DraftGmail> = {}) {
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m2",
      source: {
        from: "Ann <ann@partner.example>",
        replyTo: "billing@partnerr.example",
        to: "me@example.com",
        subject: "Invoice",
        messageId: "<m2@partner.example>",
      },
    }),
    createDraft: async (_raw, threadId) => ({ draftId: "r1", messageId: "dm1", threadId: threadId ?? "tn", marked: true }),
    updateDraft: async (draftId, _raw, threadId) => ({ draftId, messageId: "dm2", threadId: threadId ?? "tn", marked: true }),
    getDraft: async () => {
      throw new Error("not used");
    },
    threadAttachments: async () => [],
    attachmentBytes: async () => Buffer.alloc(0),
    sendAsAddresses: async () => [{ address: "me@example.com", primary: true }],
    quoteSource: async () => undefined,
    ...over,
  };
  return gmail;
}

describe("the dialog and the result say what is known about a new recipient", () => {
  it("a reply to a Reply-To that looks like the sender's domain and was never written to", async () => {
    const sentTo = vi.fn(async () => false);
    const confirm = vi.fn(async () => true);
    const r = await saveReplyDraft(fakeGmail({ sentTo }), { threadId: "t1", body: "ok" }, "off", confirm);
    expect(sentTo).toHaveBeenCalledWith("billing@partnerr.example");
    expect(confirm.mock.calls[0][1]).toContain(
      "To: billing@partnerr.example (new: never written to, only in the answered mail's Reply-To, looks like partner.example)",
    );
    expect(r.recipientNotes).toEqual([
      "billing@partnerr.example: never written to, only in the answered mail's Reply-To, looks like partner.example",
    ]);
  });

  it("a new message to someone written to before says so; a failed lookup says nothing and does not stop the draft", async () => {
    const confirm = vi.fn(async () => true);
    const r1 = await saveNewDraft(fakeGmail({ sentTo: async () => true }), { to: ["bob@else.example"], subject: "s", body: "b" }, confirm);
    expect(confirm.mock.calls[0][1]).toContain("To: bob@else.example (new: written to before)");
    expect(r1.recipientNotes).toEqual(["bob@else.example: written to before"]);
    const r2 = await saveNewDraft(
      fakeGmail({ sentTo: async () => Promise.reject(new Error("quota")) }),
      { to: ["bob@else.example"], subject: "s", body: "b" },
      confirm,
    );
    expect(confirm.mock.calls[1][1]).toContain("To: bob@else.example (new)");
    expect(r2.recipientNotes).toBeUndefined();
    expect(r2.draftId).toBe("r1");
  });

  it("does not look up an address the sent-mail search would read as syntax (N38)", async () => {
    const sentTo = vi.fn(async () => true);
    const odd = "a}b{c@else.example";
    const r = await saveNewDraft(fakeGmail({ sentTo }), { to: [odd, "bob@else.example"], subject: "s", body: "b" }, vi.fn(async () => true));
    expect(sentTo.mock.calls).toEqual([["bob@else.example"]]);
    expect(r.recipientNotes).toEqual(["bob@else.example: written to before"]);
    expect(searchableAddress("x.y+tag%z-1@xn--mnchen-3ya.example")).toBe(true);
    for (const a of ["a}b@x.example", 'a"b@x.example', "a(b)@x.example", "a b@x.example", "a:b@x.example"]) {
      expect(searchableAddress(a)).toBe(false);
    }
  });

  it("looks up at most ten new recipients", async () => {
    const sentTo = vi.fn(async () => false);
    const to = Array.from({ length: 12 }, (_, i) => `p${i}@else.example`);
    await saveNewDraft(fakeGmail({ sentTo }), { to, subject: "s", body: "b" }, vi.fn(async () => true));
    expect(sentTo).toHaveBeenCalledTimes(10);
  });

  it("a known recipient gets no lookup and no note", async () => {
    const sentTo = vi.fn(async () => false);
    const r = await saveReplyDraft(
      fakeGmail({
        sentTo,
        replySource: async () => ({ messageId: "m2", source: { from: "ann@partner.example", to: "me@example.com", subject: "x" } }),
      }),
      { threadId: "t1", body: "ok" },
      "off",
      vi.fn(async () => true),
    );
    expect(sentTo).not.toHaveBeenCalled();
    expect(r.recipientNotes).toBeUndefined();
  });
});

describe("Gmail.sentTo", () => {
  it("asks messages.list for one sent mail to, cc or bcc the address", async () => {
    const asked: any[] = [];
    const api: any = {
      users: {
        messages: {
          list: async (r: any) => (asked.push(r), { data: r.q.includes("known@") ? { messages: [{ id: "x" }] } : {} }),
        },
      },
    };
    const g = new Gmail(api as gmail_v1.Gmail);
    expect(await g.sentTo("known@example.org")).toBe(true);
    expect(await g.sentTo("new@example.org")).toBe(false);
    expect(asked[0]).toEqual({ userId: "me", q: "in:sent {to:known@example.org cc:known@example.org bcc:known@example.org}", maxResults: 1 });
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  buildMime,
  checkHeaderValue,
  draftDialog,
  encodeHeaderText,
  normalizeRecipient,
  normalizeRecipients,
  replyRecipients,
  replySubject,
  replyThreading,
  unknownRecipients,
  MAX_RECIPIENTS,
  type DraftContent,
} from "../src/draft.js";
import { reviseDraft, saveNewDraft, saveReplyDraft, type DraftGmail } from "../src/draft-flow.js";
import { decodeRfc2047 } from "../src/rfc2047.js";
import { ToolError } from "../src/cli.js";
import type { DraftInfo } from "../src/gmail.js";

// Characters that would end a header line, built from code points so no tool between this
// file and the test runner can turn an escape into the real thing (or the real thing away).
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NUL = String.fromCharCode(0);

describe("normalizeRecipient — the only way an address reaches a header", () => {
  it.each([
    ["jane@example.com", "jane@example.com"],
    ["  Jane@Example.COM ", "jane@example.com"],
    ["Jane Doe <jane@example.com>", "jane@example.com"],
    ['"Doe, Jane" <jane.doe+news@sub.example.co.uk>', "jane.doe+news@sub.example.co.uk"],
    ["info@münchen.example", "info@xn--mnchen-3ya.example"],
  ])("%j → %s", (input, out) => expect(normalizeRecipient(input)).toBe(out));

  it.each([
    ["no at sign", "jane.example.com"],
    ["empty local part", "@example.com"],
    ["empty host", "jane@"],
    ["single-label host", "jane@localhost"],
    ["two addresses in one", "a@example.com, b@example.com"],
    ["quoted local part", '"jane doe"@example.com'],
    ["double dot", "jane..doe@example.com"],
    ["ip literal", "jane@[127.0.0.1]"],
    ["header injection by CRLF", `a@example.com${CR}${LF}Bcc: evil@example.net`],
    ["header injection by LF", `a@example.com${LF}Bcc: evil@example.net`],
    ["NUL", `a@example.com${NUL}`],
    ["unicode line separator", `a@example.com${LS}Bcc: evil@example.net`],
    ["local part over 64", `${"a".repeat(65)}@example.com`],
  ])("refuses %s", (_why, input) => {
    expect(() => normalizeRecipient(input)).toThrow(ToolError);
  });

  it("drops duplicates, keeping the first position", () => {
    expect(normalizeRecipients(["b@example.com", "A@example.com", "a@example.com", "Bee <b@example.com>"])).toEqual([
      "b@example.com",
      "a@example.com",
    ]);
    expect(normalizeRecipients(undefined)).toEqual([]);
  });
});

describe("checkHeaderValue", () => {
  it.each([
    ["CR", CR],
    ["LF", LF],
    ["NEL", NEL],
    ["LS", LS],
    ["PS", PS],
    ["NUL", NUL],
    ["ESC", String.fromCharCode(27)],
    ["DEL", String.fromCharCode(127)],
  ])("refuses %s", (_n, c) => {
    expect(() => checkHeaderValue("The subject", `Hello${c}Bcc: x@example.net`)).toThrow(/line break or control/);
  });

  it("allows a tab and ordinary non-ASCII", () => {
    expect(() => checkHeaderValue("The subject", "Grüße\tfür März")).not.toThrow();
  });
});

describe("replyRecipients — who a reply goes to", () => {
  const me = ["me@example.com"];

  it("answers From when there is no Reply-To", () => {
    expect(replyRecipients({ from: "Ann <ann@example.org>", to: "me@example.com" }, me, false)).toEqual({
      to: ["ann@example.org"],
      cc: [],
      bcc: [],
    });
  });

  it("prefers Reply-To over From", () => {
    const r = replyRecipients({ from: "list@example.org", replyTo: "Ann <ann@example.org>", to: "me@example.com" }, me, false);
    expect(r.to).toEqual(["ann@example.org"]);
  });

  it("answers the original To when the message is the user's own, matching case-insensitively", () => {
    const r = replyRecipients({ from: "Me <ME@Example.com>", to: "bob@example.net, carl@example.net", cc: "dora@example.net" }, me, false);
    expect(r).toEqual({ to: ["bob@example.net", "carl@example.net"], cc: [], bcc: [] });
    const all = replyRecipients({ from: "me@example.com", to: "bob@example.net", cc: "dora@example.net" }, me, true);
    expect(all).toEqual({ to: ["bob@example.net"], cc: ["dora@example.net"], bcc: [] });
  });

  it("reply-all adds the other To and Cc, never the user and never a To twice", () => {
    const r = replyRecipients(
      { from: "ann@example.org", to: "me@example.com, bob@example.net, ann@example.org", cc: '"Doe, Carl" <carl@example.net>, me@example.com' },
      me,
      true,
    );
    expect(r).toEqual({ to: ["ann@example.org"], cc: ["bob@example.net", "carl@example.net"], bcc: [] });
  });

  it("reads the address off quoted display names that contain address syntax", () => {
    const r = replyRecipients({ from: '"support@bank.example <x>" <attacker@evil.example>' }, me, false);
    expect(r.to).toEqual(["attacker@evil.example"]);
  });

  it("drops what does not parse instead of guessing", () => {
    expect(replyRecipients({ from: "undisclosed-recipients:;" }, me, false).to).toEqual([]);
    expect(replyRecipients({ from: "Ann <ann@[10.0.0.1]>" }, me, false).to).toEqual([]);
  });

  it("returns nobody when the only address is the user's own", () => {
    expect(replyRecipients({ from: "me@example.com", to: "me@example.com" }, me, false).to).toEqual([]);
  });
});

describe("replySubject and replyThreading", () => {
  it.each([
    ["Lunch", "Re: Lunch"],
    ["Re: Lunch", "Re: Lunch"],
    ["RE: Lunch", "RE: Lunch"],
    ["re:Lunch", "re:Lunch"],
    ["", "Re:"],
    [undefined, "Re:"],
    ["AW: Termin", "Re: AW: Termin"],
  ])("%j → %j", (s, out) => expect(replySubject(s)).toBe(out));

  it("folds a line break in a thread subject instead of carrying it into the header", () => {
    expect(replySubject(`Hi${CR}${LF}Bcc: evil@example.net`)).toBe("Re: Hi  Bcc: evil@example.net");
  });

  it("appends the parent's Message-ID to its References", () => {
    expect(replyThreading({ messageId: "<p@example.org>", references: "<a@example.org> <b@example.org>" })).toEqual({
      inReplyTo: "<p@example.org>",
      references: "<a@example.org> <b@example.org> <p@example.org>",
    });
  });

  it("keeps only msg-id shaped tokens, so a hostile References cannot inject text", () => {
    const t = replyThreading({ messageId: "<p@example.org>", references: `junk <a@example.org>${CR}${LF}Bcc: x@evil.example <b c@d>` });
    expect(t.references).toBe("<a@example.org> <p@example.org>");
  });

  it("sets nothing when the parent has no usable Message-ID", () => {
    expect(replyThreading({})).toEqual({});
    expect(replyThreading({ messageId: "no brackets@example.org" })).toEqual({});
  });

  it("keeps the newest twenty references", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@example.org>`).join(" ");
    const t = replyThreading({ messageId: "<p@example.org>", references: refs });
    expect(t.references!.split(" ")).toHaveLength(20);
    expect(t.references!.endsWith("<p@example.org>")).toBe(true);
  });
});

describe("unknownRecipients", () => {
  it("names every address the known set lacks, across to/cc/bcc", () => {
    expect(
      unknownRecipients({ to: ["a@x.example"], cc: ["b@x.example"], bcc: ["c@x.example"] }, ["A@x.example", "b@x.example"]),
    ).toEqual(["c@x.example"]);
    expect(unknownRecipients({ to: ["a@x.example"], cc: [], bcc: [] }, [])).toEqual(["a@x.example"]);
  });
});

describe("encodeHeaderText", () => {
  it("leaves printable ASCII alone", () => {
    expect(encodeHeaderText("Re: Lunch at 12")).toBe("Re: Lunch at 12");
  });

  it("round-trips non-ASCII through the decoder the rest of mailwarden uses", () => {
    const s = "Grüße für März";
    expect(encodeHeaderText(s)).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeRfc2047(encodeHeaderText(s).replace(/\r\n /g, " "))).toBe(s);
  });

  it("splits a long value into words of at most 75 characters, never inside a code point", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const s = `Résumé ${emoji.repeat(40)} ${"ä".repeat(60)}`;
    const enc = encodeHeaderText(s);
    const words = enc.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(words.map((w) => decodeRfc2047(w)).join("")).toBe(s);
  });
});

describe("buildMime", () => {
  const base: DraftContent = { to: ["a@example.com"], cc: [], bcc: [], subject: "Hello", body: "Line 1\nLine 2" };
  const headers = (mime: string) => mime.split("\r\n\r\n")[0];
  const body = (mime: string) => Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");

  it("writes plain text with CRLF line ends and a base64 body", () => {
    const m = buildMime(base);
    expect(headers(m)).toBe(
      ["To: a@example.com", "Subject: Hello", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"].join("\r\n"),
    );
    expect(body(m)).toBe("Line 1\r\nLine 2");
    expect(m.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });

  it("writes Cc, Bcc and threading only when present", () => {
    const m = buildMime({ ...base, cc: ["c@example.com"], bcc: ["b@example.com"], inReplyTo: "<p@x.example>", references: "<p@x.example>" });
    expect(headers(m)).toContain("Cc: c@example.com");
    expect(headers(m)).toContain("Bcc: b@example.com");
    expect(headers(m)).toContain("In-Reply-To: <p@x.example>");
    expect(headers(m)).toContain("References: <p@x.example>");
    expect(headers(buildMime(base))).not.toMatch(/Bcc|Cc|In-Reply-To/);
  });

  it("cannot be talked into an extra header line, whatever the subject or body holds", () => {
    expect(() => buildMime({ ...base, subject: `Hi${CR}${LF}Bcc: evil@example.net` })).toThrow(/line break/);
    const m = buildMime({ ...base, body: `${CR}${LF}Bcc: evil@example.net${CR}${LF}${CR}${LF}x` });
    expect(headers(m)).not.toMatch(/evil/);
  });

  it("refuses no recipients and too many", () => {
    expect(() => buildMime({ ...base, to: [] })).toThrow(/at least one recipient/);
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `r${i}@example.com`);
    expect(() => buildMime({ ...base, to: many })).toThrow(/at most/);
  });

  it("encodes a non-ASCII subject", () => {
    expect(headers(buildMime({ ...base, subject: "Grüße" }))).toContain("Subject: =?UTF-8?B?");
  });
});

describe("draftDialog", () => {
  it("lists recipients first, marks new ones, and folds sender-shaped text to one line", () => {
    const d = draftDialog(
      "reply",
      { to: ["ann@example.org"], cc: ["new@example.net"], bcc: [], subject: `Re: x${LS}mailwarden checked this`, body: `Hi${LF}${LF}see you` },
      ["new@example.net"],
    );
    const lines = d.split("\n");
    expect(lines[0]).toMatch(/reply draft.*not sent/);
    expect(lines[1]).toBe("To: ann@example.org");
    expect(lines[2]).toBe("Cc: new@example.net (new)");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("Text: Hi see you");
  });
});

// ---- the flow, against a fake mailbox ----

function fakeGmail(over: Partial<DraftGmail> & { draft?: Partial<DraftInfo> } = {}) {
  const created: Array<{ raw: string; threadId?: string }> = [];
  const updated: Array<{ draftId: string; raw: string; threadId?: string }> = [];
  const gmail: DraftGmail = {
    getProfile: async () => ({ emailAddress: "me@example.com" }),
    replySource: async () => ({
      messageId: "m2",
      source: {
        from: "Ann <ann@example.org>",
        to: "me@example.com, bob@example.net",
        cc: "carl@example.net",
        subject: "Plans",
        messageId: "<m2@example.org>",
        references: "<m1@example.org>",
      },
    }),
    createDraft: async (raw, threadId) => {
      created.push({ raw, threadId });
      return { draftId: "r1", messageId: "dm1", threadId: threadId ?? "tnew", marked: true };
    },
    updateDraft: async (draftId, raw, threadId) => {
      updated.push({ draftId, raw, threadId });
      return { draftId, messageId: "dm2", threadId: threadId ?? "tnew2", marked: true };
    },
    getDraft: async (draftId) => ({
      draftId,
      messageId: "dm1",
      threadId: "t1",
      ownedByMailwarden: true,
      trashed: false,
      to: "ann@example.org",
      cc: "",
      subject: "Re: Plans",
      inReplyTo: "<m2@example.org>",
      references: "<m1@example.org> <m2@example.org>",
      ...over.draft,
    }),
    ...over,
  };
  return { gmail, created, updated };
}

const decodeRaw = (raw: string) => {
  const [head, b] = raw.split("\r\n\r\n");
  return { head, body: Buffer.from(b.replace(/\r\n/g, ""), "base64").toString("utf8") };
};

describe("saveReplyDraft", () => {
  it("writes a threaded reply to the sender, asking only as configured", async () => {
    const { gmail, created } = fakeGmail();
    const confirm = vi.fn(async (mode: string) => mode !== "off");
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "Sounds good." }, "off", confirm);
    expect(confirm).toHaveBeenCalledWith("off", expect.stringContaining("To: ann@example.org"));
    expect(created).toHaveLength(1);
    expect(created[0].threadId).toBe("t1");
    const { head, body } = decodeRaw(created[0].raw);
    expect(head).toContain("To: ann@example.org");
    expect(head).toContain("Subject: Re: Plans");
    expect(head).toContain("In-Reply-To: <m2@example.org>");
    expect(head).toContain("References: <m1@example.org> <m2@example.org>");
    expect(body).toBe("Sounds good.");
    expect(r).toMatchObject({ kind: "reply", to: ["ann@example.org"], newRecipients: [], confirmedByUser: false, sent: false, marked: true });
  });

  it("follows MAILWARDEN_CONFIRM=ask for a reply within the thread", async () => {
    const { gmail } = fakeGmail();
    const confirm = vi.fn(async () => true);
    const r = await saveReplyDraft(gmail, { threadId: "t1", replyAll: true, body: "x" }, "ask", confirm);
    expect(confirm).toHaveBeenCalledWith("ask", expect.any(String));
    expect(r.cc).toEqual(["bob@example.net", "carl@example.net"]);
    expect(r.confirmedByUser).toBe(true);
  });

  it("forces a confirmation as soon as cc or bcc names someone the thread did not contain", async () => {
    for (const extra of [{ cc: ["stranger@evil.example"] }, { bcc: ["stranger@evil.example"] }]) {
      const { gmail } = fakeGmail();
      const confirm = vi.fn(async () => true);
      const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x", ...extra }, "off", confirm);
      expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("stranger@evil.example (new)"));
      expect(r.newRecipients).toEqual(["stranger@evil.example"]);
    }
  });

  describe("a Reply-To the sender chose is not an address the thread vouches for", () => {
    const withReplyTo = (replyTo: string, from = "Boss <boss@corp.example>") =>
      fakeGmail({
        replySource: async () => ({
          messageId: "m2",
          source: { from, replyTo, to: "me@example.com", subject: "Wire", messageId: "<m2@corp.example>" },
        }),
      });

    it("forces a confirmation when the reply goes to a Reply-To that is not From/To/Cc", async () => {
      const { gmail, created } = withReplyTo("attacker@evil.example");
      const confirm = vi.fn(async () => true);
      const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", confirm);
      expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("attacker@evil.example (new)"));
      expect(r).toMatchObject({ to: ["attacker@evil.example"], newRecipients: ["attacker@evil.example"], confirmedByUser: true });
      expect(created).toHaveLength(1);
    });

    it("writes nothing when that confirmation is declined", async () => {
      const { gmail, created } = withReplyTo("attacker@evil.example");
      // Declines whenever it is actually asked; under the configured "off" it would wave it through.
      const confirm = vi.fn(async (mode: string) => {
        if (mode === "require") throw new ToolError("declined_by_user", "no");
        return false;
      });
      await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", confirm)).rejects.toThrow(/no/);
      expect(created).toEqual([]);
    });

    it("does not let cc or bcc smuggle in the Reply-To address unasked either", async () => {
      for (const extra of [{ cc: ["attacker@evil.example"] }, { bcc: ["attacker@evil.example"] }]) {
        const { gmail } = withReplyTo("attacker@evil.example");
        const confirm = vi.fn(async () => true);
        await saveReplyDraft(gmail, { threadId: "t1", body: "x", ...extra }, "off", confirm);
        expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("(new)"));
      }
    });

    it.each([
      ["the same address as From", "boss@corp.example", "Boss <boss@corp.example>"],
      ["also the From address with a display name", "Boss <BOSS@corp.example>", "boss@corp.example"],
    ])("still follows MAILWARDEN_CONFIRM when Reply-To is %s", async (_n, replyTo, from) => {
      const { gmail } = withReplyTo(replyTo, from);
      const confirm = vi.fn(async () => false);
      const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", confirm);
      expect(confirm).toHaveBeenCalledWith("off", expect.any(String));
      expect(r.newRecipients).toEqual([]);
    });

    it("still follows MAILWARDEN_CONFIRM when Reply-To is also named in To or Cc", async () => {
      for (const field of ["to", "cc"] as const) {
        const { gmail } = fakeGmail({
          replySource: async () => ({
            messageId: "m2",
            source: { from: "list@example.org", replyTo: "ann@example.org", to: "me@example.com", [field]: "me@example.com, ann@example.org" },
          }),
        });
        const confirm = vi.fn(async () => false);
        const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", confirm);
        expect(confirm).toHaveBeenCalledWith("off", expect.any(String));
        expect(r).toMatchObject({ to: ["ann@example.org"], newRecipients: [] });
      }
    });
  });

  it("does not ask for a cc that is already in the thread", async () => {
    const { gmail } = fakeGmail();
    const confirm = vi.fn(async () => false);
    const r = await saveReplyDraft(gmail, { threadId: "t1", body: "x", cc: ["Bob <BOB@example.net>"] }, "off", confirm);
    expect(confirm).toHaveBeenCalledWith("off", expect.any(String));
    expect(r.cc).toEqual(["bob@example.net"]);
  });

  it("writes nothing when the person declines", async () => {
    const { gmail, created } = fakeGmail();
    const confirm = vi.fn(async () => {
      throw new ToolError("declined_by_user", "no");
    });
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x", cc: ["s@evil.example"] }, "off", confirm)).rejects.toThrow(
      /no/,
    );
    expect(created).toEqual([]);
  });

  it("refuses a reply with nobody to reply to, before asking anyone", async () => {
    const { gmail, created } = fakeGmail({
      replySource: async () => ({ messageId: "m1", source: { from: "me@example.com", to: "me@example.com" } }),
    });
    const confirm = vi.fn(async () => true);
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x" }, "off", confirm)).rejects.toThrow(/no address/);
    expect(confirm).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("validates the content before asking, so a dialog never shows something that cannot be saved", async () => {
    const { gmail } = fakeGmail();
    const confirm = vi.fn(async () => true);
    await expect(saveReplyDraft(gmail, { threadId: "t1", body: "x", subject: `a${LF}b` }, "ask", confirm)).rejects.toThrow(
      /line break/,
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("saveNewDraft", () => {
  it("always asks with require, whatever is configured, and writes no thread", async () => {
    const { gmail, created } = fakeGmail();
    const confirm = vi.fn(async () => true);
    const r = await saveNewDraft(gmail, { to: ["Zoe <zoe@example.com>"], subject: "Hi", body: "Hello" }, confirm);
    expect(confirm).toHaveBeenCalledWith("require", expect.stringContaining("zoe@example.com (new)"));
    expect(created[0].threadId).toBeUndefined();
    expect(r).toMatchObject({ kind: "new", to: ["zoe@example.com"], newRecipients: ["zoe@example.com"], confirmedByUser: true });
  });
});

describe("reviseDraft", () => {
  it("refuses a draft mailwarden did not write, without asking or writing", async () => {
    const { gmail, updated } = fakeGmail({ draft: { ownedByMailwarden: false } });
    const confirm = vi.fn(async () => true);
    await expect(reviseDraft(gmail, { draftId: "r9", body: "x" }, "off", confirm)).rejects.toThrow(/not written by mailwarden/);
    expect(confirm).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
  });

  it("refuses a trashed draft", async () => {
    const { gmail } = fakeGmail({ draft: { trashed: true } });
    await expect(reviseDraft(gmail, { draftId: "r1", body: "x" }, "off", vi.fn(async () => true))).rejects.toThrow(/trash/);
  });

  it("keeps recipients, subject, threading and the thread of a reply draft", async () => {
    const { gmail, updated } = fakeGmail();
    const confirm = vi.fn(async () => false);
    const r = await reviseDraft(gmail, { draftId: "r1", body: "New text" }, "off", confirm);
    expect(confirm).toHaveBeenCalledWith("off", expect.any(String));
    expect(updated[0].threadId).toBe("t1");
    const { head, body } = decodeRaw(updated[0].raw);
    expect(head).toContain("To: ann@example.org");
    expect(head).toContain("Subject: Re: Plans");
    expect(head).toContain("In-Reply-To: <m2@example.org>");
    expect(body).toBe("New text");
    expect(r).toMatchObject({ kind: "reply", messageId: "dm2", newRecipients: [] });
  });

  it("does not pass a thread for a draft of a new message", async () => {
    const { gmail, updated } = fakeGmail({ draft: { inReplyTo: undefined, references: undefined, subject: "Hi" } });
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x" }, "off", vi.fn(async () => false));
    expect(updated[0].threadId).toBeUndefined();
    expect(r.kind).toBe("new");
  });

  it("forces a confirmation for an address the draft did not have; dropping one does not", async () => {
    const { gmail } = fakeGmail({ draft: { to: "ann@example.org, bob@example.net" } });
    const add = vi.fn(async () => true);
    await reviseDraft(gmail, { draftId: "r1", body: "x", cc: ["new@example.net"] }, "off", add);
    expect(add).toHaveBeenCalledWith("require", expect.stringContaining("new@example.net (new)"));
    const drop = vi.fn(async () => false);
    await reviseDraft(gmail, { draftId: "r1", body: "x", to: ["bob@example.net"] }, "off", drop);
    expect(drop).toHaveBeenCalledWith("off", expect.any(String));
  });

  it("reports a draft whose mark could not be set again", async () => {
    const { gmail } = fakeGmail({
      updateDraft: async (draftId) => ({ draftId, messageId: "dm3", threadId: "t1", marked: false }),
    });
    const r = await reviseDraft(gmail, { draftId: "r1", body: "x" }, "off", vi.fn(async () => false));
    expect(r.marked).toBe(false);
    expect(r.note).toMatch(/update_draft will refuse/);
  });
});

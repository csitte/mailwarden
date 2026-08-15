import { describe, it, expect } from "vitest";
import { deriveSignals, addressOf, ALL_SIGNALS, type SignalInput } from "../src/signals.js";
import { messageSignals } from "../src/gmail.js";
import { buildDigest } from "../src/digest.js";
import type { ThreadSummary } from "../src/gmail.js";

const H = (h: Record<string, string>): SignalInput["headers"] =>
  Object.entries(h).map(([name, value]) => ({ name, value }));
const sig = (headers: Record<string, string>, parts: SignalInput["parts"] = []) =>
  deriveSignals({ headers: H(headers), parts });

describe("deriveSignals — a header corpus, one row per real-world shape", () => {
  // Each row: what the mail looks like on the wire → what an agent should be told.
  const corpus: [string, Record<string, string>, SignalInput["parts"], string[]][] = [
    ["personal mail: nothing declared", { From: "Alice <alice@example.com>", Subject: "Lunch?" }, [], []],
    [
      "Mailchimp-style newsletter: List-Unsubscribe + Precedence bulk",
      {
        From: "The Weekly <hello@news.example.com>",
        "List-Unsubscribe": "<https://news.example.com/u/1>",
        Precedence: "bulk",
      },
      [],
      ["newsletter"],
    ],
    [
      "mailing list: List-Id + Precedence list, human sender",
      { From: "Bob <bob@example.org>", "List-Id": "Dev talk <dev.lists.example.org>", Precedence: "list" },
      [],
      ["newsletter"],
    ],
    [
      "GitHub notification: List-Id + noreply local-part → newsletter AND automated",
      {
        From: "octo <notifications@github.com>",
        "List-Id": "<repo.github.com>",
        "List-Unsubscribe": "<https://github.com/notifications/unsubscribe/x>",
      },
      [],
      ["newsletter", "automated"],
    ],
    [
      "out-of-office: Auto-Submitted auto-replied",
      { From: "Carol <carol@example.com>", "Auto-Submitted": "auto-replied" },
      [],
      ["automated"],
    ],
    [
      "bounce: mailer-daemon local-part",
      { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Auto-Submitted": "auto-generated" },
      [],
      ["automated"],
    ],
    [
      "bank alert: no-reply with a hyphen, nothing else",
      { From: "My Bank <no-reply@bank.example>" },
      [],
      ["automated"],
    ],
    [
      "Exchange auto-response suppression header",
      { From: "it@corp.example", "X-Auto-Response-Suppress": "All" },
      [],
      ["automated"],
    ],
    [
      "calendar invite: text/calendar part (with method param, as some senders send it)",
      { From: "Dana <dana@example.com>" },
      [{ mimeType: "multipart/alternative" }, { mimeType: "text/plain" }, { mimeType: "text/calendar; method=REQUEST" }],
      ["calendar"],
    ],
    [
      "calendar invite as an .ICS attachment only (uppercase extension)",
      { From: "Dana <dana@example.com>" },
      [{ mimeType: "application/octet-stream", filename: "invite.ICS" }],
      ["calendar"],
    ],
    [
      "reply-to on another domain: flagged",
      { From: "Support <support@shop.example>", "Reply-To": "help@shop-tickets.example" },
      [],
      ["replyToMismatch"],
    ],
    [
      "reply-to on the SAME domain, different local part: routine, not flagged",
      { From: "Shop <hello@shop.example>", "Reply-To": "support@shop.example" },
      [],
      [],
    ],
    [
      "phishing shape: brand from-name, reply-to elsewhere, plus bulk precedence",
      { From: "PayPa1 Security <alerts@paypa1-mail.example>", "Reply-To": "verify@evil.example", Precedence: "bulk" },
      [],
      ["newsletter", "automated", "replyToMismatch"],
    ],
  ];

  for (const [name, headers, parts, expected] of corpus) {
    it(name, () => {
      expect(sig(headers, parts)).toEqual(expected);
    });
  }
});

describe("deriveSignals — the edges that must NOT fire", () => {
  it("Auto-Submitted: no is the RFC 3834 way of saying 'a human sent this'", () => {
    expect(sig({ From: "a@x.example", "Auto-Submitted": "no" })).toEqual([]);
  });

  it("does not flag a person whose NAME contains 'reply' — only the address local-part counts", () => {
    expect(sig({ From: "Noreen Reply <noreen@x.example>" })).toEqual([]);
    expect(sig({ From: "Nora <no-reply-nora@x.example>" })).toEqual([]); // not an exact spelling
  });

  it("Precedence values other than bulk/list/auto_reply mean nothing here", () => {
    expect(sig({ From: "a@x.example", Precedence: "first-class" })).toEqual([]);
    expect(sig({ From: "a@x.example", Precedence: "junk" })).toEqual([]);
  });

  it("a Reply-To without a From to compare against, or without an @, is not a mismatch", () => {
    expect(sig({ "Reply-To": "help@elsewhere.example" })).toEqual([]);
    expect(sig({ From: "a@x.example", "Reply-To": "Just A Name" })).toEqual([]);
  });

  it("header names match case-insensitively (Gmail preserves the sender's casing)", () => {
    expect(sig({ from: "a@x.example", "list-id": "<l.x.example>", precedence: "BULK" })).toEqual(["newsletter"]);
  });

  it("returns signals in the fixed ALL_SIGNALS order regardless of which header came first", () => {
    const s = sig(
      { "Reply-To": "z@other.example", From: "no-reply@x.example", "List-Id": "<l>" },
      [{ mimeType: "text/calendar" }],
    );
    expect(s).toEqual([...ALL_SIGNALS]);
  });
});

describe("addressOf", () => {
  it("extracts and lowercases the angle-addr, or the bare address", () => {
    expect(addressOf("Alice <Alice@Example.COM>")).toBe("alice@example.com");
    expect(addressOf("bob@example.com")).toBe("bob@example.com");
  });
  it("is empty for a bare display name or nothing", () => {
    expect(addressOf("Just Alice")).toBe("");
    expect(addressOf(undefined)).toBe("");
  });
});

describe("messageSignals — from a raw Gmail message, walking nested MIME parts", () => {
  it("finds a text/calendar part nested two levels down", () => {
    const s = messageSignals({
      id: "m",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "Dana <dana@example.com>" }],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain" }, { mimeType: "text/calendar" }],
          },
        ],
      },
    });
    expect(s).toEqual(["calendar"]);
  });
  it("is empty for a missing message", () => {
    expect(messageSignals(undefined)).toEqual([]);
  });
});

describe("buildDigest — signal counts overall and per sender", () => {
  const thread = (p: Partial<ThreadSummary>): ThreadSummary => ({
    threadId: "t",
    messageCount: 1,
    from: "",
    subject: "",
    date: "",
    labelIds: [],
    snippet: "",
    hasAttachments: false,
    signals: [],
    ...p,
  });

  it("counts each signal across the sample and unions them per sender in stable order", () => {
    const d = buildDigest(
      [
        thread({ from: "News <news@x.com>", signals: ["newsletter"] }),
        thread({ from: "news@x.com", signals: ["newsletter", "replyToMismatch"] }),
        thread({ from: "cal@y.com", signals: ["calendar"] }),
        thread({ from: "friend@z.com", signals: [] }),
      ],
      (id) => id,
      new Date(),
    );
    expect(d.signals).toEqual({ newsletter: 2, automated: 0, calendar: 1, replyToMismatch: 1 });
    expect(d.topSenders[0]).toMatchObject({ sender: "news@x.com", count: 2, signals: ["newsletter", "replyToMismatch"] });
    expect(d.topSenders.find((s) => s.sender === "friend@z.com")?.signals).toEqual([]);
  });

  it("reports all four keys with zero when nothing fires", () => {
    const d = buildDigest([thread({ from: "a@x.com" })], (id) => id, new Date());
    expect(d.signals).toEqual({ newsletter: 0, automated: 0, calendar: 0, replyToMismatch: 0 });
  });
});

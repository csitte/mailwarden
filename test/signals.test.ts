import { describe, it, expect } from "vitest";
import { deriveSignals, addressOf, addressesOf, mailboxOf, ALL_SIGNALS, type SignalInput } from "../src/signals.js";
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

// ---------------------------------------------------------------------------------------
// Input corpus (release check round 1): the value range of every header the signals read,
// walked from its defining source — RFC 3834 (Auto-Submitted grammar: token, optional
// comments, `;` parameters), Precedence conventions, RFC 2919/2369 (List-*), Microsoft's
// X-Auto-Response-Suppress, RFC 5545 / MIME text/calendar, and RFC 5322 address syntax for
// From/Reply-To (name-addr vs addr-spec, quoted display names, comments, folding, groups,
// several mailboxes, obs-route, IDN/Punycode, trailing dot). Each row: what is on the wire →
// what the tool description promises. Rows the docs leave open are in the "design questions"
// block below with the conservative reading pinned.
// ---------------------------------------------------------------------------------------
type Row = [string, Record<string, string>, SignalInput["parts"], string[]];
const F = { From: "a@x.example" };
const cal = (mimeType: string, filename?: string): SignalInput["parts"] => [{ mimeType, filename }];

describe("deriveSignals corpus — Auto-Submitted (RFC 3834 §5: field, then optional CFWS and `;` parameters)", () => {
  it.each<Row>([
    ["no", { ...F, "Auto-Submitted": "no" }, [], []],
    ["No (case)", { ...F, "Auto-Submitted": "No" }, [], []],
    ["padded no", { ...F, "Auto-Submitted": "  no  " }, [], []],
    ["no + comment", { ...F, "Auto-Submitted": "no (human)" }, [], []],
    ["comment + no", { ...F, "Auto-Submitted": "(c) no" }, [], []],
    ["no + parameter", { ...F, "Auto-Submitted": "no; owner-token=abc" }, [], []],
    ["auto-generated", { ...F, "Auto-Submitted": "auto-generated" }, [], ["automated"]],
    ["AUTO-REPLIED", { ...F, "Auto-Submitted": "AUTO-REPLIED" }, [], ["automated"]],
    ["auto-notified", { ...F, "Auto-Submitted": "auto-notified" }, [], ["automated"]],
    ["auto-replied + comment", { ...F, "Auto-Submitted": "auto-replied (vacation)" }, [], ["automated"]],
    ["auto-generated + parameter", { ...F, "Auto-Submitted": "auto-generated; owner-token=x" }, [], ["automated"]],
    ["extension token", { ...F, "Auto-Submitted": "x-foo" }, [], ["automated"]],
    ["'none' is not 'no'", { ...F, "Auto-Submitted": "none" }, [], ["automated"]],
    ["'no-reply' is not 'no'", { ...F, "Auto-Submitted": "no-reply" }, [], ["automated"]],
    ["'yes'", { ...F, "Auto-Submitted": "yes" }, [], ["automated"]],
    ["empty value declares nothing", { ...F, "Auto-Submitted": "" }, [], []],
    ["blank value declares nothing", { ...F, "Auto-Submitted": "   " }, [], []],
    ["header name lowercase", { ...F, "auto-submitted": "auto-replied" }, [], ["automated"]],
    ["header name upper", { ...F, "AUTO-SUBMITTED": "auto-replied" }, [], ["automated"]],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));
});

describe("deriveSignals corpus — Precedence", () => {
  it.each<Row>([
    ["bulk", { ...F, Precedence: "bulk" }, [], ["newsletter"]],
    ["BULK", { ...F, Precedence: "BULK" }, [], ["newsletter"]],
    ["padded list", { ...F, Precedence: " list " }, [], ["newsletter"]],
    ["bulk + comment", { ...F, Precedence: "bulk (mailer)" }, [], ["newsletter"]],
    ["auto_reply", { ...F, Precedence: "auto_reply" }, [], ["automated"]],
    ["Auto_Reply", { ...F, Precedence: "Auto_Reply" }, [], ["automated"]],
    ["junk", { ...F, Precedence: "junk" }, [], []],
    ["first-class", { ...F, Precedence: "first-class" }, [], []],
    ["bulky (not a value)", { ...F, Precedence: "bulky" }, [], []],
    ["empty", { ...F, Precedence: "" }, [], []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));

  it("a second Precedence header is ignored — the first one wins", () => {
    expect(
      deriveSignals({
        headers: [
          { name: "From", value: F.From },
          { name: "Precedence", value: "junk" },
          { name: "Precedence", value: "bulk" },
        ],
        parts: [],
      }),
    ).toEqual([]);
  });
});

describe("deriveSignals corpus — List-* (RFC 2919 / 2369) and X-Auto-Response-Suppress: presence of a non-blank value", () => {
  it.each<Row>([
    ["List-Id", { ...F, "List-Id": "<l.x.example>" }, [], ["newsletter"]],
    ["LIST-ID (name casing)", { ...F, "LIST-ID": "<l.x.example>" }, [], ["newsletter"]],
    ["List-Id blank", { ...F, "List-Id": "   " }, [], []],
    ["List-Unsubscribe mailto only", { ...F, "List-Unsubscribe": "<mailto:u@x.example>" }, [], ["newsletter"]],
    ["List-Unsubscribe-Post alone", { ...F, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, [], []],
    ["List-Post alone", { ...F, "List-Post": "<mailto:l@x.example>" }, [], []],
    ["a header just called List", { ...F, List: "x" }, [], []],
    ["X-Auto-Response-Suppress All", { ...F, "X-Auto-Response-Suppress": "All" }, [], ["automated"]],
    ["X-Auto-Response-Suppress DR, OOF, AutoReply", { ...F, "X-Auto-Response-Suppress": "DR, OOF, AutoReply" }, [], ["automated"]],
    ["X-Auto-Response-Suppress blank", { ...F, "X-Auto-Response-Suppress": "" }, [], []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));

  it("a header whose value is null counts as absent", () => {
    expect(deriveSignals({ headers: [{ name: "From", value: F.From }, { name: "List-Id", value: null }], parts: [] })).toEqual([]);
    expect(deriveSignals({ headers: [{ name: null, value: "x" }, { name: "From", value: F.From }], parts: [] })).toEqual([]);
  });
});

describe("deriveSignals corpus — machine local-parts: exact spellings, hyphen or underscore, local-part only", () => {
  it.each<Row>([
    ["noreply", { From: "noreply@x.example" }, [], ["automated"]],
    ["no-reply", { From: "no-reply@x.example" }, [], ["automated"]],
    ["no_reply (Apple's spelling)", { From: "Apple <no_reply@email.apple.com>" }, [], ["automated"]],
    ["NoReply", { From: "NoReply@x.example" }, [], ["automated"]],
    ["NO-REPLY in angle-addr", { From: "X <NO-REPLY@X.EXAMPLE>" }, [], ["automated"]],
    ["do-not-reply", { From: "do-not-reply@x.example" }, [], ["automated"]],
    ["donotreply", { From: "donotreply@x.example" }, [], ["automated"]],
    ["do_not_reply", { From: "do_not_reply@x.example" }, [], ["automated"]],
    ["MAILER-DAEMON", { From: "MAILER-DAEMON@x.example" }, [], ["automated"]],
    ["postmaster", { From: "postmaster@x.example" }, [], ["automated"]],
    ["notification", { From: "notification@x.example" }, [], ["automated"]],
    ["notifications", { From: "notifications@x.example" }, [], ["automated"]],
    ["alerts", { From: "alerts@x.example" }, [], ["automated"]],
    ["bounces", { From: "bounces@x.example" }, [], ["automated"]],
    ["quoted local-part (RFC 5322 quoted-string)", { From: '"no-reply"@x.example' }, [], ["automated"]],
    ["quoted local-part inside angle-addr", { From: 'X <"noreply"@x.example>' }, [], ["automated"]],
    ["addr-spec + comment (cron style)", { From: "noreply@x.example (No Reply)" }, [], ["automated"]],
    ["folded display name", { From: "Some Long\r\n Name <noreply@x.example>" }, [], ["automated"]],
    ["RFC 2047 display name", { From: "=?UTF-8?B?Tm9yZWVu?= <noreply@x.example>" }, [], ["automated"]],
    // must NOT fire
    ["Noreen Reply <noreen@…>", { From: "Noreen Reply <noreen@x.example>" }, [], []],
    ["no-reply-nora (prefix, not exact)", { From: "no-reply-nora@x.example" }, [], []],
    ["noreplyx", { From: "noreplyx@x.example" }, [], []],
    ["xnoreply", { From: "xnoreply@x.example" }, [], []],
    ["noreply only in the domain", { From: "alice@noreply.example" }, [], []],
    ["noreply only in the display name", { From: "noreply <alice@x.example>" }, [], []],
    ["RFC 2047 name reading noreply, real address alice", { From: "=?UTF-8?Q?noreply?= <alice@x.example>" }, [], []],
    ["root@host (Cron Daemon)", { From: "root@host.example (Cron Daemon)" }, [], []],
    ["no From", {}, [], []],
    ["display name only", { From: "Just A Name" }, [], []],
    ["empty angle-addr", { From: "Mail System <>" }, [], []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));
});

describe("deriveSignals corpus — calendar: text/calendar (RFC 5545) or an .ics attachment", () => {
  it.each<Row>([
    ["text/calendar as the root part", F, cal("text/calendar"), ["calendar"]],
    ["TEXT/CALENDAR", F, cal("TEXT/CALENDAR"), ["calendar"]],
    ["with method param", F, cal("text/calendar; method=REQUEST"), ["calendar"]],
    ["with charset + method", F, cal('text/calendar; charset="utf-8"; method=REPLY'), ["calendar"]],
    ["padded type", F, cal(" text/calendar "), ["calendar"]],
    [".ics on an octet-stream part", F, cal("application/octet-stream", "invite.ics"), ["calendar"]],
    [".ICS", F, cal("application/octet-stream", "invite.ICS"), ["calendar"]],
    ["Outlook's application/ics WITH its file name", F, cal("application/ics", "invite.ics"), ["calendar"]],
    ["file named just .ics", F, cal("application/octet-stream", ".ics"), ["calendar"]],
    ["file named ics (no dot)", F, cal("application/octet-stream", "ics"), []],
    ["invite.ics.txt", F, cal("text/plain", "invite.ics.txt"), []],
    ["text/calendarfoo is not text/calendar", F, cal("text/calendarfoo"), []],
    ["text/plain named calendar.txt", F, cal("text/plain", "calendar.txt"), []],
    ["null type and name", F, [{ mimeType: null, filename: null }], []],
    ["no parts", F, [], []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));
});

describe("deriveSignals corpus — replyToMismatch: RFC 5322 address syntax, every spelling of 'the same domain'", () => {
  it.each<Row>([
    ["other domain", { ...F, "Reply-To": "b@y.example" }, [], ["replyToMismatch"]],
    ["same domain, other local-part", { ...F, "Reply-To": "b@x.example" }, [], []],
    ["identical", { ...F, "Reply-To": "a@x.example" }, [], []],
    ["domain case differs", { ...F, "Reply-To": "a@X.EXAMPLE" }, [], []],
    ["local-part case differs", { ...F, "Reply-To": "A@x.example" }, [], []],
    ["name-addr vs addr-spec", { From: "A <a@x.example>", "Reply-To": "b@x.example" }, [], []],
    ["quoted display name with a comma", { From: "A <a@x.example>", "Reply-To": '"Support, Team" <b@x.example>' }, [], []],
    ["quoted display name containing a literal <addr>", { From: "A <a@x.example>", "Reply-To": '"<evil@y.example>" <b@x.example>' }, [], []],
    ["From's quoted name mimics its own address (evasion, no mismatch)", { From: '"<a@x.example>" <a@evil.example>', "Reply-To": "b@evil.example" }, [], []],
    ["From's quoted name mimics a foreign address (evasion, real mismatch)", { From: '"<a@evil.example>" <a@x.example>', "Reply-To": "b@evil.example" }, [], ["replyToMismatch"]],
    ["addr-spec + trailing comment", { ...F, "Reply-To": "b@x.example (Support)" }, [], []],
    ["comment + addr-spec", { ...F, "Reply-To": "(Support) b@x.example" }, [], []],
    ["From with comment", { From: "a@x.example (Alice)", "Reply-To": "b@x.example" }, [], []],
    ["spaces inside the angle brackets", { ...F, "Reply-To": "< b@x.example >" }, [], []],
    ["folded", { ...F, "Reply-To": "Support\r\n <b@x.example>" }, [], []],
    ["obsolete whitespace around @", { ...F, "Reply-To": "b @ x.example" }, [], []],
    ["trailing dot on Reply-To domain", { ...F, "Reply-To": "b@x.example." }, [], []],
    ["trailing dot on From domain", { From: "a@x.example.", "Reply-To": "b@x.example" }, [], []],
    ["IDN vs Punycode", { From: "a@münchen.example", "Reply-To": "b@xn--mnchen-3ya.example" }, [], []],
    ["Punycode vs IDN", { From: "a@xn--mnchen-3ya.example", "Reply-To": "b@münchen.example" }, [], []],
    ["IDN NFC vs NFD", { From: "a@münchen.example", "Reply-To": "b@münchen.example" }, [], []],
    ["IDN case", { From: "a@münchen.example", "Reply-To": "b@MÜNCHEN.example" }, [], []],
    ["two different IDNs", { From: "a@münchen.example", "Reply-To": "b@münster.example" }, [], ["replyToMismatch"]],
    ["lookalike suffix is a different domain", { From: "a@brand.example", "Reply-To": "b@notbrand.example" }, [], ["replyToMismatch"]],
    ["several mailboxes, all same domain", { ...F, "Reply-To": "b@x.example, c@x.example" }, [], []],
    ["several name-addrs, all same domain", { ...F, "Reply-To": "B <b@x.example>, C <c@x.example>" }, [], []],
    ["several mailboxes, first foreign", { ...F, "Reply-To": "b@y.example, c@x.example" }, [], ["replyToMismatch"]],
    ["several mailboxes, last foreign", { ...F, "Reply-To": "b@x.example, c@y.example" }, [], ["replyToMismatch"]],
    ["trailing comma", { ...F, "Reply-To": "b@x.example," }, [], []],
    ["group syntax, same domain", { ...F, "Reply-To": "Team: b@x.example, c@x.example;" }, [], []],
    ["group syntax, foreign", { ...F, "Reply-To": "Team: b@y.example;" }, [], ["replyToMismatch"]],
    ["empty group", { ...F, "Reply-To": "undisclosed-recipients:;" }, [], []],
    ["empty value", { ...F, "Reply-To": "" }, [], []],
    ["empty angle-addr", { ...F, "Reply-To": "X <>" }, [], []],
    ["display name only", { ...F, "Reply-To": "Just A Name" }, [], []],
    ["domain literal, same", { From: "a@[192.0.2.1]", "Reply-To": "b@[192.0.2.1]" }, [], []],
    ["domain literal, different", { From: "a@[192.0.2.1]", "Reply-To": "b@[192.0.2.2]" }, [], ["replyToMismatch"]],
    ["obsolete source route", { ...F, "Reply-To": "<@relay.example:b@x.example>" }, [], []],
    ["quoted local-part containing @", { ...F, "Reply-To": '"b@y.example"@x.example' }, [], []],
    ["no From to compare against", { "Reply-To": "b@y.example" }, [], []],
    ["From is a bare display name", { From: "Alice", "Reply-To": "b@y.example" }, [], []],
    ["Reply-To entirely RFC 2047-encoded (broken sender)", { ...F, "Reply-To": "=?utf-8?B?YkB5LmV4YW1wbGU=?=" }, [], []],
    ["RFC 2047 display name with an encoded @", { ...F, "Reply-To": "=?UTF-8?Q?Sup=40y.example?= <b@x.example>" }, [], []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));
});

describe("deriveSignals corpus — design questions, conservative reading pinned (change deliberately, not by accident)", () => {
  it.each<Row>([
    // "Different domain" is decided at label boundaries: a subdomain of the sender's domain
    // (either direction) is the SAME domain — that is how marketing mail is routinely built,
    // and a phisher gets no subdomain of the domain he spoofs. Siblings share no such relation.
    ["subdomain vs apex → silent (same domain)", { From: "news@e.brand.example", "Reply-To": "help@brand.example" }, [], []],
    ["apex vs subdomain → silent (same domain)", { From: "news@brand.example", "Reply-To": "help@e.brand.example" }, [], []],
    ["sibling subdomains → fires", { From: "news@e.brand.example", "Reply-To": "help@m.brand.example" }, [], ["replyToMismatch"]],
    ["look-alike suffix without label boundary → fires", { From: "a@brand.example", "Reply-To": "b@notbrand.example" }, [], ["replyToMismatch"]],
    ["sender's domain as a prefix of a foreign one → fires", { From: "a@brand.example", "Reply-To": "b@brand.example.evil" }, [], ["replyToMismatch"]],
    ["one of several Reply-To on a subdomain, another foreign → fires", { From: "a@brand.example", "Reply-To": "b@e.brand.example, c@evil.example" }, [], ["replyToMismatch"]],
    // Only the documented spellings; sub-addressing and affixes are not "exact".
    ["noreply+tag (sub-addressing) → silent", { From: "noreply+abc@x.example" }, [], []],
    ["messages-noreply (LinkedIn) → silent", { From: "messages-noreply@linkedin.com" }, [], []],
    // Only the documented Precedence values.
    ["Precedence auto-reply (hyphen) → silent", { ...F, Precedence: "auto-reply" }, [], []],
    // X-Auto-Response-Suppress: `None` means "suppress nothing" and declares no automation;
    // every other value list does (Exchange: All, DR, NDR, RN, NRN, OOF, AutoReply).
    ["X-Auto-Response-Suppress None → silent", { ...F, "X-Auto-Response-Suppress": "None" }, [], []],
    ["X-Auto-Response-Suppress none, NONE (case, list) → silent", { ...F, "X-Auto-Response-Suppress": "none, NONE" }, [], []],
    ["X-Auto-Response-Suppress All → fires", { ...F, "X-Auto-Response-Suppress": "All" }, [], ["automated"]],
    ["X-Auto-Response-Suppress OOF, AutoReply → fires", { ...F, "X-Auto-Response-Suppress": "OOF, AutoReply" }, [], ["automated"]],
    ["X-Auto-Response-Suppress None, OOF (mixed) → fires", { ...F, "X-Auto-Response-Suppress": "None, OOF" }, [], ["automated"]],
    ["X-Auto-Response-Suppress All (comment) → fires", { ...F, "X-Auto-Response-Suppress": "All (exchange)" }, [], ["automated"]],
    // Only text/calendar and .ics; unregistered/legacy types are not.
    ["application/ics without a file name → silent", F, cal("application/ics"), []],
    ["text/x-vcalendar (vCalendar 1.0) → silent", F, cal("text/x-vcalendar"), []],
  ])("%s", (_n, h, p, exp) => expect(sig(h, p)).toEqual(exp));
});

describe("mailboxOf — first mailbox with its display name", () => {
  it.each([
    ["Doe, Jane <j@x.example>", "j@x.example", "Doe, Jane"],
    ["Acme, Inc. <news@acme.example>", "news@acme.example", "Acme, Inc."],
    ["Smith, John, Jr. <js@x.example>", "js@x.example", "Smith, John, Jr."],
    ['"Doe, Jane" <j@x.example>', "j@x.example", "Doe, Jane"],
    ["Alice <>, Bob <b@y.example>", "b@y.example", "Bob"],
    ["a@x.example, Bob <b@y.example>", "a@x.example", ""],
    ["Alice (Sales) <a@x.example>", "a@x.example", "Alice"],
    ['"<legit@news.example>" <evil@x.example>', "evil@x.example", "<legit@news.example>"],
    ["Alice <a@x.example>", "a@x.example", "Alice"],
    ["Alice <a @ x.example>", "a@x.example", "Alice"],
    ["a@x.example", "a@x.example", ""],
    ["Just A Name", "", ""],
    ["", "", ""],
  ])("%s → %s / %s", (v, address, name) => {
    expect(mailboxOf(v)).toEqual({ address, name });
  });
  it("is linear: a 100 KB header of separators and quotes parses in milliseconds", () => {
    const inputs = [
      '"' + ",".repeat(100_000) + '" <a@x.example>',
      ",".repeat(100_000) + " <a@x.example>",
      "(".repeat(50_000) + ")".repeat(50_000) + " <a@x.example>",
      '"(<a@b>,;'.repeat(12_000) + " <a@x.example>",
    ];
    const t0 = performance.now();
    for (const v of inputs) {
      mailboxOf(v);
      addressesOf(v);
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("addressOf / addressesOf", () => {
  it("extracts and lowercases the angle-addr, or the bare address", () => {
    expect(addressOf("Alice <Alice@Example.COM>")).toBe("alice@example.com");
    expect(addressOf("bob@example.com")).toBe("bob@example.com");
  });
  it("is empty for a bare display name or nothing", () => {
    expect(addressOf("Just Alice")).toBe("");
    expect(addressOf(undefined)).toBe("");
  });
  it.each<[string, string[]]>([
    ["a@x.example, B <b@y.example>", ["a@x.example", "b@y.example"]],
    ['"Doe, Jane" <j@x.example>, k@y.example', ["j@x.example", "k@y.example"]],
    ['"<fake@evil.example>" <real@x.example>', ["real@x.example"]],
    ["a@x.example (comment, with comma)", ["a@x.example"]],
    ["Team: a@x.example, b@x.example;", ["a@x.example", "b@x.example"]],
    ["undisclosed-recipients:;", []],
    ["<@relay.example:a@x.example>", ["a@x.example"]],
    ['"quoted local"@x.example', ['"quoted local"@x.example']],
    ["<>", []],
    ["", []],
    // Malformed (outside the RFC 5322 value range): degrade to the obvious address, never to junk.
    ['"Alice <a@x.example>', ["a@x.example"]],
    ['O"Brien <a@x.example>', ["a@x.example"]],
    ["Alice (Smith <a@x.example>", ["a@x.example"]],
    ["a@x.example (unclosed", ["a@x.example"]],
    ["a@x.example)", ["a@x.example"]],
    ["Alice a@x.example", ["a@x.example"]],
    ["me @ home", ["me@home"]],
    ['"unterminated', []],
  ])("splits %j into its addr-specs", (v, exp) => expect(addressesOf(v)).toEqual(exp));
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

import { describe, it, expect } from "vitest";
import { stripQuotedHtml, stripQuotedText } from "../src/quoted.js";
import { trimBodies } from "../src/threadview.js";
import type { ParsedMessage } from "../src/gmail.js";

const lines = (...xs: string[]) => xs.join("\n");

/**
 * Each case: the body as a client wrote it, and the part that must remain. `null` means nothing may
 * be cut. The corpus is the test; the rules in quoted.ts are only as good as these shapes.
 */
const CUT: [string, string, string][] = [
  [
    "Gmail, English, one-line attribution",
    lines("Thanks, booked for Friday.", "", "On Sat, 25 Oct 2026 at 11:41, Pullman Hotel <res@pullman.example> wrote:", "> Dear guest,", "> your room is ready.", ">", "> Kind regards"),
    "Thanks, booked for Friday.",
  ],
  [
    "Gmail, German, attribution wrapped over two lines",
    lines("Passt, danke!", "", "Am Sa., 25. Okt. 2026 um 11:41 Uhr schrieb Max Mustermann <", "max@example.de>:", "> Hallo Chris,", "> anbei die Unterlagen."),
    "Passt, danke!",
  ],
  [
    "Apple Mail, attribution and blank line before the quote",
    lines("Sounds good.", "", "Sent from my iPhone", "", "On 25. Oct 2026, at 09:12, Anna <anna@example.org> wrote:", "", "> Shall we meet at ten?"),
    lines("Sounds good.", "", "Sent from my iPhone"),
  ],
  [
    "Thunderbird, German, nested quote levels",
    lines("Erledigt.", "", "Am 24.10.26 um 18:03 schrieb Bob:", "> Kannst du das prüfen?", ">", "> Am 24.10.26 um 17:00 schrieb Chris:", ">> Hier die Liste."),
    "Erledigt.",
  ],
  [
    "French",
    lines("Merci !", "", "Le sam. 25 oct. 2026 à 10:00, Claire <c@example.fr> a écrit :", "> Bonjour"),
    "Merci !",
  ],
  [
    "Spanish",
    lines("Gracias.", "", "El sáb, 25 oct 2026 a las 10:00, Luis <l@example.es> escribió:", "> Hola"),
    "Gracias.",
  ],
  [
    "Italian",
    lines("Grazie.", "", "Il giorno sab 25 ott 2026 alle ore 10:00 Marco <m@example.it> ha scritto:", "> Ciao"),
    "Grazie.",
  ],
  [
    "Dutch",
    lines("Dank je.", "", "Op za 25 okt 2026 om 10:00 schreef Eva <e@example.nl>:", "> Hoi"),
    "Dank je.",
  ],
  [
    "a quote block without any attribution",
    lines("See below.", "", "> earlier text", "> more"),
    "See below.",
  ],
  [
    "Outlook, English, Original Message separator",
    lines("Approved.", "", "Regards,", "Chris", "", "-----Original Message-----", "From: Finance <fin@example.com>", "Sent: Friday, October 24, 2026 4:12 PM", "To: Chris", "Subject: Invoice 4711", "", "Please approve."),
    lines("Approved.", "", "Regards,", "Chris"),
  ],
  [
    "Outlook, German, Ursprüngliche Nachricht",
    lines("Freigegeben.", "", "-----Ursprüngliche Nachricht-----", "Von: Buchhaltung <bh@example.de>", "Gesendet: Freitag, 24. Oktober 2026 16:12", "An: Chris", "Betreff: Rechnung 4711", "", "Bitte freigeben."),
    "Freigegeben.",
  ],
  [
    "new Outlook: underscore rule, then a bold header block",
    lines("Yes, Thursday works.", "", "________________________________", "*From:* Dana <dana@example.com>", "*Sent:* Thursday, October 23, 2026 9:00 AM", "*To:* Chris", "*Subject:* Meeting", "", "Does Thursday work?"),
    "Yes, Thursday works.",
  ],
  [
    "Outlook header block with no separator, after a blank line",
    lines("Done.", "", "From: Ops <ops@example.com>", "Sent: Monday, October 20, 2026 8:00", "To: Chris", "Subject: Ticket 12", "", "Please close."),
    "Done.",
  ],
  [
    "CRLF line endings",
    "Ok.\r\n\r\nOn Mon, Oct 20, 2026 at 8:00 AM X <x@example.com> wrote:\r\n> hi\r\n",
    "Ok.",
  ],
  [
    "an inline answer keeps every answer; only the trailing quoted question goes",
    lines("On Mon, X wrote:", "> Can you come?", "Yes.", "> Bring the slides?", "Will do.", "> Anything else?"),
    lines("On Mon, X wrote:", "> Can you come?", "Yes.", "> Bring the slides?", "Will do."),
  ],
];

const KEEP: [string, string][] = [
  ["a reply with no quote at all", lines("Hi,", "", "see you tomorrow.", "", "Chris")],
  [
    "a Gmail forward: the forwarded header block is CONTENT",
    lines("FYI", "", "---------- Forwarded message ---------", "From: Bank <info@bank.example>", "Date: Fri, 24 Oct 2026 at 10:00", "Subject: Statement", "To: <me@example.com>", "", "Your statement is ready."),
  ],
  [
    "a German Outlook forward",
    lines("Zur Info.", "", "-----Weitergeleitete Nachricht-----", "Von: Bank <info@bank.example>", "Gesendet: Freitag, 24. Oktober 2026 10:00", "Betreff: Kontoauszug", "", "Ihr Auszug ist da."),
  ],
  ["Apple Mail forward", lines("Look at this:", "", "Begin forwarded message:", "", "> From: A <a@example.com>", "> Subject: Hi", "> Date: 24 October 2026", "> ", "> text")],
  [
    "a mail that is nothing but a quote has no new part — kept whole, not emptied",
    lines("> just the old text", "> again"),
  ],
  ["an Outlook block with nothing written above it", lines("-----Original Message-----", "From: A <a@example.com>", "Sent: Monday", "Subject: x", "", "body")],
  ["a '>' in the middle of a sentence is not a quote", lines("Temperature > 30 today.", "Price: 5 > 4")],
  ["a From: line in running text without Sent/Subject is not a header block", lines("Hi,", "", "From: what I hear, the meeting moved.", "", "Chris")],
  ["'On ... wrote:' in running text without a quote below it", lines("On Monday the team wrote:", "the plan is final.")],
  ["only blank lines after the text", lines("Thanks", "", "", "")],
];

describe("stripQuotedText — cuts", () => {
  it.each(CUT)("%s", (_name, input, kept) => {
    const r = stripQuotedText(input);
    expect(r.text).toBe(kept);
    expect(r.stripped).toBe(true);
  });
});

describe("stripQuotedText — must not cut", () => {
  it.each(KEEP)("%s", (_name, input) => {
    expect(stripQuotedText(input)).toEqual({ text: input, stripped: false });
  });
});

describe("stripQuotedText — invariants over the whole corpus", () => {
  const all = [...CUT.map(([, i]) => i), ...KEEP.map(([, i]) => i)];

  it("the kept text is always a prefix of the input (nothing reordered, nothing invented)", () => {
    for (const input of all) {
      const normalized = input.replace(/\r\n?/g, "\n");
      expect(normalized.startsWith(stripQuotedText(input).text)).toBe(true);
    }
  });

  it("every non-quoted line of an inline reply survives", () => {
    const input = CUT[CUT.length - 1][1];
    const out = stripQuotedText(input).text;
    for (const l of input.split("\n").filter((x) => !x.startsWith(">"))) expect(out).toContain(l);
  });

  it("is idempotent", () => {
    for (const input of all) {
      const once = stripQuotedText(input).text;
      expect(stripQuotedText(once).text).toBe(once);
    }
  });

  it("never returns an empty text for input that had something to say", () => {
    for (const input of all) if (input.trim()) expect(stripQuotedText(input).text.trim()).not.toBe("");
  });
});

describe("stripQuotedHtml", () => {
  it.each<[string, string, string]>([
    [
      "Gmail",
      '<div dir="ltr">Booked.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Sat, X wrote:<br></div><blockquote class="gmail_quote">old</blockquote></div>',
      '<div dir="ltr">Booked.</div><br>',
    ],
    [
      "Gmail with gmail_quote_container (newer markup)",
      '<div>Ok</div><div class="gmail_quote gmail_quote_container"><blockquote>old</blockquote></div>',
      "<div>Ok</div>",
    ],
    ["Apple Mail", '<div>Sure.</div><div><br><blockquote type="cite">On 25 Oct, A wrote:<br>old</blockquote></div>', "<div>Sure.</div><div><br>"],
    ["Thunderbird", '<p>Fine.</p><div class="moz-cite-prefix">Am 24.10.26 schrieb B:</div><blockquote type="cite">old</blockquote>', "<p>Fine.</p>"],
    [
      "Outlook",
      '<div>Approved.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> F</div><div>old</div>',
      "<div>Approved.</div>",
    ],
    ["Yahoo", '<div>Yes</div><div class="yahoo_quoted"><div>On Friday, Z wrote:</div>old</div>', "<div>Yes</div>"],
  ])("%s", (_n, html, kept) => {
    expect(stripQuotedHtml(html)).toEqual({ html: kept, stripped: true });
  });

  it.each<[string, string]>([
    ["no quote markers", "<p>Hello</p><blockquote>a real quotation in a newsletter</blockquote>"],
    [
      "a Gmail forward wrapped in gmail_quote",
      '<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Bank</div>text</div>',
    ],
    ["a German forward", '<div class="gmail_quote"><div>---------- Weitergeleitete Nachricht ---------</div>text</div>'],
    ["nothing written above the quote", '<div class="gmail_quote"><blockquote>only old text</blockquote></div>'],
    ["an empty quote container", '<p>Hi</p><div class="gmail_quote"></div>'],
  ])("keeps: %s", (_n, html) => {
    expect(stripQuotedHtml(html)).toEqual({ html, stripped: false });
  });
});

function msg(over: Partial<ParsedMessage>): ParsedMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    from: "a@example.com",
    to: "b@example.com",
    cc: "",
    subject: "s",
    date: "d",
    snippet: "",
    plaintextBody: "",
    htmlBody: "",
    attachments: [],
    authentication: { unchecked: true },
    ...over,
  } as ParsedMessage;
}

describe("trimBodies — bodies: new", () => {
  it("cuts a plaintext reply and says so; htmlBody is gone as with text", () => {
    const out = trimBodies(msg({ plaintextBody: CUT[0][1], htmlBody: "<p>x</p>" }), "new") as Record<string, unknown>;
    expect(out.plaintextBody).toBe("Thanks, booked for Friday.");
    expect(out.quotedStripped).toBe(true);
    expect("htmlBody" in out).toBe(false);
    expect("bodyFromHtml" in out).toBe(false);
  });

  it("leaves a reply without a quote alone and sets no flag", () => {
    const out = trimBodies(msg({ plaintextBody: "Just this." }), "new") as Record<string, unknown>;
    expect(out.plaintextBody).toBe("Just this.");
    expect("quotedStripped" in out).toBe(false);
  });

  it("cuts an HTML-only reply in the markup, then renders it", () => {
    const html = '<div dir="ltr">Booked.</div><div class="gmail_quote"><div class="gmail_attr">On Sat, X wrote:</div><blockquote class="gmail_quote">old text</blockquote></div>';
    const out = trimBodies(msg({ htmlBody: html }), "new");
    expect(out).toMatchObject({ plaintextBody: "Booked.", bodyFromHtml: true, quotedStripped: true });
  });

  it("an HTML-only forward stays whole", () => {
    const html = '<div>FYI</div><div class="gmail_quote"><div>---------- Forwarded message ---------</div><p>statement</p></div>';
    const out = trimBodies(msg({ htmlBody: html }), "new") as Record<string, unknown>;
    expect(out.plaintextBody).toContain("statement");
    expect("quotedStripped" in out).toBe(false);
  });

  it("text never cuts anything — new is the only mode that does", () => {
    const out = trimBodies(msg({ plaintextBody: CUT[0][1] }), "text") as Record<string, unknown>;
    expect(out.plaintextBody).toBe(CUT[0][1]);
    expect("quotedStripped" in out).toBe(false);
  });
});

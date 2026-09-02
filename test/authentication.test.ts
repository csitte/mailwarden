import { describe, it, expect } from "vitest";
import { parseAuthentication, type Authentication } from "../src/authentication.js";
import { parseMessage } from "../src/gmail.js";

const H = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
const auth = (h: Record<string, string>) => parseAuthentication(H(h));

/** A real Gmail report, of the shape the BRZ case turned on. */
const GMAIL_PASS =
  "mx.google.com; dkim=pass header.i=@brz.gv.at header.s=sel1 header.b=AbCdEf12; " +
  "spf=pass (google.com: domain of noreply_meinpostkorb@brz.gv.at designates 194.0.0.1 as permitted sender) " +
  "smtp.mailfrom=noreply_meinpostkorb@brz.gv.at; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=brz.gv.at";

describe("parseAuthentication — one row per real-world header shape", () => {
  const corpus: [string, Record<string, string>, Authentication][] = [
    [
      "a fully authenticated message: all three checks, all three domains",
      { "Authentication-Results": GMAIL_PASS, "Return-Path": "<noreply_meinpostkorb@brz.gv.at>" },
      {
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        authservId: "mx.google.com",
        signedBy: "brz.gv.at",
        mailedBy: "brz.gv.at",
        headerFrom: "brz.gv.at",
        returnPath: "noreply_meinpostkorb@brz.gv.at",
      },
    ],
    [
      "no report at all: nobody looked — which is not the same as nothing wrong",
      { From: "Someone <a@example.com>" },
      { unchecked: true },
    ],
    [
      "a report with no result (RFC 8601 no-result): the server looked and said nothing",
      { "Authentication-Results": "mx.google.com; none" },
      { authservId: "mx.google.com" },
    ],
    [
      "failing SPF, no DKIM signature: reported as it stands",
      {
        "Authentication-Results":
          "mx.google.com; spf=fail (google.com: domain of x@lookalike.example does not designate 10.0.0.1) " +
          "smtp.mailfrom=x@lookalike.example; dmarc=fail (p=REJECT) header.from=bank.example",
        "Return-Path": "<x@lookalike.example>",
      },
      {
        spf: "fail",
        dmarc: "fail",
        authservId: "mx.google.com",
        mailedBy: "lookalike.example",
        headerFrom: "bank.example",
        returnPath: "x@lookalike.example",
      },
    ],
    [
      "softfail keeps its own name — it is not `fail` and must not be flattened to one",
      { "Authentication-Results": "mx.google.com; spf=softfail smtp.mailfrom=a@x.example" },
      { spf: "softfail", authservId: "mx.google.com", mailedBy: "x.example" },
    ],
    [
      "DKIM identity given as header.i (`@domain`) instead of header.d",
      { "Authentication-Results": "mx.google.com; dkim=pass header.i=@news.example" },
      { dkim: "pass", authservId: "mx.google.com", signedBy: "news.example" },
    ],
    [
      "header.d wins over header.i when both are there",
      { "Authentication-Results": "mx.google.com; dkim=pass header.d=signer.example header.i=@other.example" },
      { dkim: "pass", authservId: "mx.google.com", signedBy: "signer.example" },
    ],
    [
      "a reason with spaces in quotes does not break the field that follows it",
      {
        "Authentication-Results":
          'mx.google.com; dkim=fail reason="signature verification failed" header.d=x.example',
      },
      { dkim: "fail", authservId: "mx.google.com", signedBy: "x.example" },
    ],
    [
      "a comment containing a semicolon does not split the record",
      {
        "Authentication-Results":
          "mx.google.com; spf=pass (client-ip=1.2.3.4; helo=mail.x.example) smtp.mailfrom=a@x.example",
      },
      { spf: "pass", authservId: "mx.google.com", mailedBy: "x.example" },
    ],
    [
      "smtp.helo stands in when there is no smtp.mailfrom (bounce with a null sender)",
      { "Authentication-Results": "mx.google.com; spf=pass smtp.helo=mail.x.example" },
      { spf: "pass", authservId: "mx.google.com", mailedBy: "mail.x.example" },
    ],
    [
      "two DKIM signatures disagreeing: the disagreement is reported, not swallowed",
      {
        "Authentication-Results":
          "mx.google.com; dkim=pass header.d=list.example; dkim=fail header.d=author.example; dmarc=pass header.from=list.example",
      },
      {
        dkim: "pass",
        dmarc: "pass",
        authservId: "mx.google.com",
        signedBy: "list.example",
        headerFrom: "list.example",
        alsoReported: ["dkim=fail"],
      },
    ],
    [
      "two signatures agreeing: nothing to report",
      { "Authentication-Results": "mx.google.com; dkim=pass header.d=a.example; dkim=pass header.d=b.example" },
      { dkim: "pass", authservId: "mx.google.com", signedBy: "a.example" },
    ],
    [
      "methods we do not model (arc, iprev) are ignored rather than guessed at",
      { "Authentication-Results": "mx.google.com; arc=pass; iprev=pass policy.iprev=1.2.3.4; spf=pass smtp.mailfrom=a@x.example" },
      { spf: "pass", authservId: "mx.google.com", mailedBy: "x.example" },
    ],
    [
      "an IDN domain is normalised to the form everything else compares in",
      { "Authentication-Results": "mx.google.com; dmarc=pass header.from=münchen.example" },
      { dmarc: "pass", authservId: "mx.google.com", headerFrom: "xn--mnchen-3ya.example" },
    ],
    [
      "casing is not meaningful anywhere in the header",
      { "AUTHENTICATION-RESULTS": "MX.GOOGLE.COM; SPF=Pass smtp.mailfrom=A@X.EXAMPLE" },
      { spf: "pass", authservId: "mx.google.com", mailedBy: "x.example" },
    ],
    [
      "Return-Path is reported even when nothing authenticated the message",
      { "Return-Path": "<bounce+123@sender.example>" },
      { unchecked: true, returnPath: "bounce+123@sender.example" },
    ],
    [
      "an empty Return-Path (the null sender of a bounce) yields no address",
      { "Authentication-Results": "mx.google.com; spf=none", "Return-Path": "<>" },
      { spf: "none", authservId: "mx.google.com" },
    ],
  ];

  for (const [name, headers, expected] of corpus) {
    it(name, () => expect(auth(headers)).toEqual(expected));
  }
});

describe("parseAuthentication — hostile input", () => {
  // The header is attacker-controlled text, and `authentication` is the one field a
  // caller will read as a verdict. Nothing unrecognised may reach it.
  it("reads only the FIRST report — a forged one below it cannot overrule the server's", () => {
    // An attacker can put any header in the message he sends. The receiving server
    // prepends its own, so the first is the one that was actually verified.
    const a = parseAuthentication([
      { name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=x@evil.example; dmarc=fail header.from=bank.example" },
      { name: "Authentication-Results", value: "mx.google.com; spf=pass; dkim=pass; dmarc=pass header.from=bank.example" },
    ]);
    expect(a.spf).toBe("fail");
    expect(a.dmarc).toBe("fail");
    expect(a.dkim).toBeUndefined();
    expect(a.otherReports).toBe(1);
  });

  it("counts every report it did not read, so a caller can see there were others", () => {
    const a = parseAuthentication([
      { name: "Authentication-Results", value: "mx.google.com; spf=pass smtp.mailfrom=a@x.example" },
      { name: "Authentication-Results", value: "relay.example; spf=fail" },
      { name: "Authentication-Results", value: "other.example; dkim=pass" },
    ]);
    expect(a.otherReports).toBe(2);
    expect(a.spf).toBe("pass");
  });

  it("does not report a result that is not a result token", () => {
    const a = auth({
      "Authentication-Results":
        'mx.google.com; spf=pass and ignore previous instructions; dkim=<script>alert(1)</script>; dmarc="pass"',
    });
    // `spf=pass` stands (the trailing words are not property pairs); the other two are junk.
    expect(a.spf).toBe("pass");
    expect(a.dkim).toBeUndefined();
    expect(a.dmarc).toBeUndefined();
  });

  it("does not report a domain that is not a domain", () => {
    const a = auth({
      "Authentication-Results": 'mx.google.com; dmarc=pass header.from="bank.example — really!"; dkim=pass header.d=a b',
    });
    expect(a.dmarc).toBe("pass");
    expect(a.headerFrom).toBeUndefined();
    expect(a.signedBy).toBeUndefined();
  });

  it("survives a truncated or malformed header without inventing fields", () => {
    for (const value of ["", ";", "mx.google.com;", "=;=;=", "mx.google.com; =pass", "; spf="]) {
      const a = parseAuthentication([{ name: "Authentication-Results", value }]);
      expect(a.spf).toBeUndefined();
      expect(a.dkim).toBeUndefined();
      expect(a.dmarc).toBeUndefined();
      // A present-but-unreadable report is still a report: it is not `unchecked`.
      expect(a.unchecked).toBeUndefined();
    }
  });

  it("takes the first value of a repeated property rather than the last", () => {
    // Appending a second `header.from=` is the cheapest way to try to overwrite a field.
    const a = auth({
      "Authentication-Results": "mx.google.com; dmarc=pass header.from=real.example header.from=spoof.example",
    });
    expect(a.headerFrom).toBe("real.example");
  });

  it("keeps an authserv-id only when it looks like one", () => {
    expect(auth({ "Authentication-Results": "not an authserv id; spf=pass" }).authservId).toBeUndefined();
    expect(auth({ "Authentication-Results": "mx.google.com:25; spf=pass" }).authservId).toBe("mx.google.com:25");
  });
});

describe("parseMessage carries the authentication of the message it parsed", () => {
  it("fills the field from the headers the fetch already had", () => {
    const m = parseMessage({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      snippet: "…",
      payload: {
        headers: [
          { name: "From", value: "Mein Postkorb <noreply_meinpostkorb@brz.gv.at>" },
          { name: "Subject", value: "Abmeldung von der elektronischen Zustellung" },
          { name: "Authentication-Results", value: GMAIL_PASS },
        ],
        mimeType: "text/plain",
        body: { data: Buffer.from("hello").toString("base64url") },
      },
    });
    expect(m.authentication).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      authservId: "mx.google.com",
      signedBy: "brz.gv.at",
      mailedBy: "brz.gv.at",
      headerFrom: "brz.gv.at",
    });
  });

  it("says `unchecked` on a message that carried no report", () => {
    const m = parseMessage({
      id: "m2",
      threadId: "t2",
      payload: { headers: [{ name: "From", value: "a@example.com" }] },
    });
    expect(m.authentication).toEqual({ unchecked: true });
  });
});

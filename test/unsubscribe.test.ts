import { describe, it, expect, vi } from "vitest";
import {
  parseListUnsubscribe,
  validateUnsubscribeUrl,
  isBlockedAddress,
  oneClickUnsubscribe,
  inspectUnsubscribe,
  unsubscribeThread,
  type UnsubscribeDeps,
} from "../src/unsubscribe.js";
import { Gmail } from "../src/gmail.js";

// ---- Pure parsing ----

describe("parseListUnsubscribe", () => {
  const POST = "List-Unsubscribe=One-Click";

  it("splits a bracketed URI list and classifies by scheme", () => {
    const o = parseListUnsubscribe(
      "<https://list.example.com/u/abc>, <mailto:unsub@example.com?subject=off>",
      POST,
    );
    expect(o.httpsUrls).toEqual(["https://list.example.com/u/abc"]);
    expect(o.mailtos).toEqual(["mailto:unsub@example.com?subject=off"]);
    expect(o.oneClick).toBe(true);
  });

  it("tolerates header folding inside the brackets", () => {
    const o = parseListUnsubscribe("<https://list.example.com/\n u/abc>", POST);
    expect(o.httpsUrls).toEqual(["https://list.example.com/u/abc"]);
  });

  it("accepts a comma-separated list without angle brackets", () => {
    const o = parseListUnsubscribe("https://a.example/u , mailto:x@example.com");
    expect(o.httpsUrls).toEqual(["https://a.example/u"]);
    expect(o.mailtos).toEqual(["mailto:x@example.com"]);
  });

  it("drops plain http — an opt-out is not worth downgrading to cleartext", () => {
    const o = parseListUnsubscribe("<http://list.example.com/u/abc>", POST);
    expect(o.httpsUrls).toEqual([]);
    expect(o.oneClick).toBe(false);
  });

  it("is not one-click without the List-Unsubscribe-Post header", () => {
    const o = parseListUnsubscribe("<https://list.example.com/u/abc>");
    expect(o.httpsUrls).toHaveLength(1);
    expect(o.oneClick).toBe(false);
  });

  it("is not one-click when only a mailto is offered, even with the Post header", () => {
    expect(parseListUnsubscribe("<mailto:unsub@example.com>", POST).oneClick).toBe(false);
  });

  it("matches the Post header case-insensitively and among other parameters", () => {
    expect(parseListUnsubscribe("<https://a.example/u>", "list-unsubscribe=one-click").oneClick).toBe(
      true,
    );
    expect(
      parseListUnsubscribe("<https://a.example/u>", "Foo=bar; List-Unsubscribe=One-Click").oneClick,
    ).toBe(true);
  });

  it("does not treat a lookalike parameter value as one-click", () => {
    expect(parseListUnsubscribe("<https://a.example/u>", "List-Unsubscribe=One-Clickish").oneClick)
      .toBe(false);
    expect(parseListUnsubscribe("<https://a.example/u>", "XList-Unsubscribe=One-Click").oneClick)
      .toBe(false);
  });

  it("returns empty options for a missing or empty header", () => {
    // Note the Post header is set in every case: a `List-Unsubscribe-Post` with no
    // `List-Unsubscribe` beside it is RFC-wise nonsense, but it does occur in the
    // field (observed on transactional mail via Adobe Campaign). It must not
    // produce oneClick:true — there is no URI to click.
    for (const v of [undefined, "", "   ", "<>"]) {
      const o = parseListUnsubscribe(v, POST);
      expect(o).toEqual({ oneClick: false, httpsUrls: [], mailtos: [] });
    }
  });

  // The shapes real senders actually emit, as a table — same reasoning as the
  // address corpus below: the risk is a form nobody thought to write down.
  const FORMS: [string, string | undefined, string[], string[], boolean, string][] = [
    ["<mailto:u@a.example>, <https://a.example/u>", POST, ["https://a.example/u"], ["mailto:u@a.example"], true, "mailto listed first"],
    ["<https://a.example/u>,\r\n\t<mailto:u@a.example>", POST, ["https://a.example/u"], ["mailto:u@a.example"], true, "CRLF + tab folding"],
    ["<HTTPS://A.EXAMPLE/U>", POST, ["HTTPS://A.EXAMPLE/U"], [], true, "uppercase scheme"],
    ["<https://a.example/u><https://b.example/u>", undefined, ["https://a.example/u", "https://b.example/u"], [], false, "no separator between URIs"],
    ["<https://a.example/u?a=1&b=2>", undefined, ["https://a.example/u?a=1&b=2"], [], false, "query string survives"],
    ["<https://a.example/u?q=a%20b>", undefined, ["https://a.example/u?q=a%20b"], [], false, "percent-encoding survives"],
    ["<ftp://a.example/u>", POST, [], [], false, "unknown scheme dropped"],
    ["<https://a.example/u>", "list-unsubscribe = one-click", ["https://a.example/u"], [], true, "spaces around ="],
    ["<https://a.example/u>", "List-Unsubscribe=One-Click\r\n", ["https://a.example/u"], [], true, "trailing CRLF on the Post header"],
    ["<https://a.example/u>", "One-Click", ["https://a.example/u"], [], false, "Post value without its key"],
  ];

  it.each(FORMS)("handles %s / %s (%#)", (lu, post, httpsUrls, mailtos, oneClick) => {
    expect(parseListUnsubscribe(lu, post)).toEqual({ oneClick, httpsUrls, mailtos });
  });

  it("strips whitespace inside a URI — folding artefact, not a raw space", () => {
    // A folded header leaves whitespace mid-URI and there is no way to tell it
    // from a (already invalid) raw space, so both are removed. Documented because
    // it is a real behaviour, not an accident.
    expect(parseListUnsubscribe("<https://a.example/u?q=a b>").httpsUrls).toEqual([
      "https://a.example/u?q=ab",
    ]);
  });
});

// ---- URL vetting ----

describe("validateUnsubscribeUrl", () => {
  it("accepts a plain https URL", () => {
    expect(validateUnsubscribeUrl("https://a.example/u?t=1").hostname).toBe("a.example");
  });
  it("rejects non-https schemes", () => {
    expect(() => validateUnsubscribeUrl("http://a.example/u")).toThrow(/must be https/);
    expect(() => validateUnsubscribeUrl("file:///etc/passwd")).toThrow(/must be https/);
  });
  it("rejects embedded credentials", () => {
    expect(() => validateUnsubscribeUrl("https://u:p@a.example/u")).toThrow(/credentials/);
  });
  it("rejects a non-default port — a public host can still front an internal service", () => {
    expect(() => validateUnsubscribeUrl("https://a.example:8080/u")).toThrow(/default https port/);
    expect(validateUnsubscribeUrl("https://a.example:443/u").port).toBe("");
  });
  it("rejects garbage", () => {
    expect(() => validateUnsubscribeUrl("not a url")).toThrow(/not a valid URL/);
  });
});

/**
 * Table-driven on purpose. The two defects this guard has already had were both
 * *spelling* bugs — an address form nobody had thought to write down — so the unit
 * of coverage is the IANA special-purpose registry crossed with every notation the
 * same address can be written in, not a handful of illustrative examples.
 */
const BLOCKED: [string, string][] = [
  // IPv4 special-purpose registry
  ["0.0.0.0", "this host on this network"],
  ["0.1.2.3", "0.0.0.0/8"],
  ["10.0.0.1", "private"],
  ["100.64.0.1", "CGNAT lower bound"],
  ["100.127.255.255", "CGNAT upper bound"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback upper bound"],
  ["169.254.169.254", "cloud metadata"],
  ["172.16.0.1", "private lower bound"],
  ["172.31.255.255", "private upper bound"],
  ["192.0.0.1", "IETF protocol assignments"],
  ["192.0.2.1", "TEST-NET-1"],
  ["192.88.99.1", "6to4 relay anycast"],
  ["192.168.1.1", "private"],
  ["198.18.0.1", "benchmarking lower bound"],
  ["198.19.255.255", "benchmarking upper bound"],
  ["198.51.100.1", "TEST-NET-2"],
  ["203.0.113.1", "TEST-NET-3"],
  ["224.0.0.1", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "broadcast"],
  // Notations that must fail closed rather than be decoded
  ["localhost", "not an address at all"],
  ["2130706433", "127.0.0.1 as a decimal integer"],
  ["0177.0.0.1", "octal octet"],
  ["0x7f.0.0.1", "hex octet"],
  ["127.1", "short form"],
  ["999.1.1.1", "octet out of range"],
  ["", "empty"],
  // IPv6 special-purpose registry
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["64:ff9b:1::1", "local-use translation"],
  ["100::1", "discard-only"],
  ["2001::1", "Teredo"],
  ["2001:2::1", "benchmarking"],
  ["2001:db8::1", "documentation — the v6 twin of TEST-NET"],
  ["2002:7f00:1::1", "6to4 embedding 127.0.0.1"],
  ["2002:a00:1::1", "6to4 embedding 10.0.0.1"],
  ["fc00::1", "unique local"],
  ["fd12:3456::1", "unique local"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local upper bound"],
  ["ff02::1", "multicast"],
  // The SAME addresses, spelled differently — where both past defects lived
  ["0:0:0:0:0:0:0:1", "loopback, unabbreviated"],
  ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback, fully padded"],
  ["0:0:0:0:0:0:0:0", "unspecified, unabbreviated"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex"],
  ["0:0:0:0:0:ffff:7f00:1", "IPv4-mapped loopback, unabbreviated hex"],
  ["0000:0000:0000:0000:0000:ffff:127.0.0.1", "IPv4-mapped loopback, unabbreviated dotted"],
  ["::ffff:0:127.0.0.1", "IPv4-translated (RFC 2765)"],
  ["::ffff:a9fe:a9fe", "IPv4-mapped metadata, hex"],
  ["::10.0.0.1", "IPv4-compatible, dotted"],
  ["::a00:1", "IPv4-compatible, hex"],
  ["0:0:0:0:0:0:0a00:0001", "IPv4-compatible, unabbreviated"],
  ["64:ff9b::127.0.0.1", "NAT64, dotted"],
  ["64:ff9b::7f00:1", "NAT64, hex"],
  ["FE80::1", "link-local, uppercase"],
  ["fe80::1%eth0", "link-local with a zone id"],
  ["[::1]", "bracketed"],
  // A public IPv4 inside a private IPv6 must NOT excuse the outer prefix
  ["fd00::8.8.8.8", "unique local wrapping a public IPv4"],
  ["fe80::8.8.8.8", "link-local wrapping a public IPv4"],
];

const ALLOWED: [string, string][] = [
  ["1.1.1.1", "public"],
  ["8.8.8.8", "public"],
  ["93.184.216.34", "public"],
  ["100.63.255.255", "just below CGNAT"],
  ["100.128.0.1", "just above CGNAT"],
  ["172.15.255.255", "just below private"],
  ["172.32.0.1", "just above private"],
  ["192.167.255.255", "just below 192.168/16"],
  ["192.169.0.1", "just above 192.168/16"],
  ["198.17.255.255", "just below benchmarking"],
  ["198.20.0.1", "just above benchmarking"],
  ["223.255.255.255", "just below multicast"],
  ["2606:4700:4700::1111", "public IPv6"],
  ["2a00:1450:4001::200e", "public IPv6"],
  ["::ffff:8.8.8.8", "IPv4-mapped public address"],
  ["::ffff:808:808", "IPv4-mapped public address, hex"],
];

describe("isBlockedAddress", () => {
  it.each(BLOCKED)("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(ALLOWED)("allows %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("collapses every spelling of one address to the same verdict", () => {
    // The invariant the table above is really asserting, stated once.
    const loopback = ["::1", "0:0:0:0:0:0:0:1", "[::1]", " ::1 ", "::0:0:1"];
    expect(loopback.map(isBlockedAddress)).toEqual(loopback.map(() => true));
  });
});

// ---- The one-click request ----

/** A deps double: records calls, answers from a scripted queue. */
function fakeDeps(
  responses: { status: number; location?: string }[],
  addresses: string[] = ["93.184.216.34"],
) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const cancel = vi.fn().mockResolvedValue(undefined);
  const deps: UnsubscribeDeps = {
    resolveHost: vi.fn().mockResolvedValue(addresses),
    fetch: vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      const r = responses.shift() ?? { status: 200 };
      return {
        status: r.status,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? r.location ?? null : null) },
        body: { cancel },
      } as any;
    }) as unknown as typeof globalThis.fetch,
  };
  return { deps, calls, cancel };
}

describe("oneClickUnsubscribe", () => {
  it("POSTs the fixed RFC 8058 body and reports the status", async () => {
    const { deps, calls, cancel } = fakeDeps([{ status: 200 }]);
    const res = await oneClickUnsubscribe("https://list.example.com/u/abc", deps);
    expect(res).toEqual({ url: "https://list.example.com/u/abc", status: 200, ok: true, redirects: 0 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe("List-Unsubscribe=One-Click");
    // The response body is discarded, never read into the model's context.
    expect(cancel).toHaveBeenCalled();
  });

  it("reports a non-2xx answer as not-ok rather than throwing", async () => {
    const { deps } = fakeDeps([{ status: 404 }]);
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).resolves.toMatchObject({
      status: 404,
      ok: false,
    });
  });

  it("follows a 302 as GET and a 308 as POST, re-checking every hop", async () => {
    const { deps, calls } = fakeDeps([
      { status: 302, location: "https://a.example/step2" },
      { status: 308, location: "https://a.example/step3" },
      { status: 200 },
    ]);
    const res = await oneClickUnsubscribe("https://a.example/u", deps);
    expect(res).toMatchObject({ url: "https://a.example/step3", status: 200, redirects: 2 });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(deps.resolveHost).toHaveBeenCalledTimes(3);
  });

  it("refuses a redirect that leaves https or the default port", async () => {
    const { deps } = fakeDeps([{ status: 302, location: "http://a.example/u" }]);
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).rejects.toThrow(/must be https/);
  });

  it("refuses a redirect to a host that resolves internally (SSRF)", async () => {
    // Second hop points at a name that resolves to loopback.
    const calls: string[] = [];
    const deps: UnsubscribeDeps = {
      resolveHost: async (h) => {
        calls.push(h);
        return h === "internal.example" ? ["127.0.0.1"] : ["93.184.216.34"];
      },
      fetch: (async () => ({
        status: 302,
        headers: { get: () => "https://internal.example/admin" },
        body: { cancel: async () => {} },
      })) as unknown as typeof globalThis.fetch,
    };
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).rejects.toThrow(
      /non-public address/,
    );
    expect(calls).toEqual(["a.example", "internal.example"]);
  });

  it("refuses when ANY resolved address is non-public", async () => {
    const { deps } = fakeDeps([{ status: 200 }], ["93.184.216.34", "10.0.0.5"]);
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).rejects.toThrow(
      /non-public address \(10\.0\.0\.5\)/,
    );
  });

  it("refuses a host that resolves to nothing", async () => {
    const { deps } = fakeDeps([{ status: 200 }], []);
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).rejects.toThrow(/no address/);
  });

  it("gives up after too many redirects instead of looping", async () => {
    const { deps } = fakeDeps(
      Array.from({ length: 6 }, () => ({ status: 302, location: "https://a.example/next" })),
    );
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).rejects.toThrow(
      /redirected more than 3 times/,
    );
  });

  it("gives up on a stalled resolver instead of holding the call open", async () => {
    // A hostile endpoint can also attack by never answering DNS. The request
    // deadline has to cover resolution, not just the fetch.
    const deps: UnsubscribeDeps = {
      resolveHost: () => new Promise(() => {}), // never settles
      fetch: (async () => {
        throw new Error("must not be reached");
      }) as unknown as typeof globalThis.fetch,
    };
    await expect(oneClickUnsubscribe("https://a.example/u", deps, 20)).rejects.toThrow(/timed out/);
  });

  it("stops at a 3xx without a Location header", async () => {
    const { deps } = fakeDeps([{ status: 304 }]);
    await expect(oneClickUnsubscribe("https://a.example/u", deps)).resolves.toMatchObject({
      status: 304,
      ok: false,
    });
  });
});

// ---- IO layer against a fake Gmail API ----

/** A gmail_v1-shaped double over an explicit list of messages (oldest first, m1…mN). */
function gmailThread(messages: Record<string, string>[]) {
  const api: any = {
    users: {
      threads: {
        get: vi.fn(async () => ({
          data: {
            messages: messages.map((h, i) => ({
              id: `m${i + 1}`,
              payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) },
            })),
          },
        })),
      },
    },
  };
  return { gmail: new Gmail(api), api };
}

/** The common shape: an older message with a stale endpoint, then `headers`, then `extra`. */
function gmailWith(headers: Record<string, string>, extra: Record<string, string>[] = []) {
  // m1's endpoint must never be the one picked — it belongs to an earlier mailing.
  return gmailThread([{ "List-Unsubscribe": "<https://old.example/u>" }, headers, ...extra]);
}

describe("inspectUnsubscribe", () => {
  it("reads the NEWEST message's headers and makes no request", async () => {
    const { gmail } = gmailWith({
      From: "Newsletter <news@example.com>",
      Subject: "Weekly",
      "List-Unsubscribe": "<https://new.example/u/xyz>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const info = await inspectUnsubscribe(gmail, "t1");
    expect(info).toEqual({
      threadId: "t1",
      messageId: "m2",
      from: "Newsletter <news@example.com>",
      subject: "Weekly",
      oneClick: true,
      httpsUrls: ["https://new.example/u/xyz"],
      mailtos: [],
      hasUnsubscribe: true,
    });
  });

  it("decodes RFC 2047 in From/Subject but leaves the URI headers raw", async () => {
    const { gmail } = gmailWith({
      From: "=?utf-8?q?Gr=C3=BC=C3=9Fe?= <news@example.com>",
      Subject: "=?utf-8?q?Caf=C3=A9?=",
      "List-Unsubscribe": "<https://new.example/u/=?x?>",
    });
    const info = await inspectUnsubscribe(gmail, "t1");
    expect(info.from).toBe("Grüße <news@example.com>");
    expect(info.subject).toBe("Café");
    expect(info.httpsUrls).toEqual(["https://new.example/u/=?x?"]);
  });

  it("skips a newer message that advertises nothing — e.g. your own reply", async () => {
    // Gmail threads a reply onto the newsletter; taking the literal last message
    // would report "this list has no opt-out".
    const { gmail } = gmailWith(
      {
        From: "Newsletter <news@example.com>",
        "List-Unsubscribe": "<https://new.example/u/xyz>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      [{ From: "me@example.com", Subject: "Re: Weekly" }],
    );
    const info = await inspectUnsubscribe(gmail, "t1");
    expect(info.messageId).toBe("m2");
    expect(info.httpsUrls).toEqual(["https://new.example/u/xyz"]);
    expect(info.oneClick).toBe(true);
  });

  it("falls back to the newest message when nothing in the thread advertises", async () => {
    const { gmail } = gmailThread([
      { From: "a@b.c", Subject: "hi" },
      { From: "me@example.com", Subject: "Re: hi" },
    ]);
    const info = await inspectUnsubscribe(gmail, "t1");
    expect(info.messageId).toBe("m2"); // the literal last one, so From/Subject still fit
    expect(info.subject).toBe("Re: hi");
    expect(info.hasUnsubscribe).toBe(false);
    expect(info.oneClick).toBe(false);
  });

  it("throws on an empty thread", async () => {
    const api: any = { users: { threads: { get: async () => ({ data: { messages: [] } }) } } };
    await expect(inspectUnsubscribe(new Gmail(api), "t1")).rejects.toThrow(/no messages/);
  });
});

describe("unsubscribeThread", () => {
  it("performs the one-click opt-out and reports success", async () => {
    const { gmail } = gmailWith({
      From: "Newsletter <news@example.com>",
      "List-Unsubscribe": "<https://new.example/u/xyz>, <mailto:u@example.com>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const { deps, calls } = fakeDeps([{ status: 202 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res).toMatchObject({
      threadId: "t1",
      messageId: "m2",
      unsubscribed: true,
      url: "https://new.example/u/xyz",
      status: 202,
    });
    expect(res.reason).toBeUndefined();
    // The endpoint came from the header — nothing else was contacted.
    expect(calls.map((c) => c.url)).toEqual(["https://new.example/u/xyz"]);
  });

  it("skips an unusable URI and takes the next one the vetting accepts", async () => {
    const { gmail } = gmailWith({
      "List-Unsubscribe": "<https://new.example:8080/u>, <https://new.example/u/ok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const { deps, calls } = fakeDeps([{ status: 200 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res.unsubscribed).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://new.example/u/ok"]);
  });

  it("refuses (not throws) when every advertised URI fails vetting", async () => {
    const { gmail } = gmailWith({
      "List-Unsubscribe": "<https://new.example:8080/u>, <https://u:p@new.example/u>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const { deps, calls } = fakeDeps([{ status: 200 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res.unsubscribed).toBe(false);
    expect(res.reason).toMatch(/did not pass vetting/);
    expect(res.options.httpsUrls).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it("refuses a link-only sender and hands the link back instead", async () => {
    const { gmail } = gmailWith({ "List-Unsubscribe": "<https://new.example/u/xyz>" });
    const { deps, calls } = fakeDeps([{ status: 200 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res.unsubscribed).toBe(false);
    expect(res.reason).toMatch(/one-click/);
    expect(res.options.httpsUrls).toEqual(["https://new.example/u/xyz"]);
    expect(calls).toHaveLength(0); // nothing was contacted
  });

  it("never acts on a mailto: opt-out — mailwarden cannot send", async () => {
    const { gmail } = gmailWith({
      "List-Unsubscribe": "<mailto:unsub@example.com>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const { deps, calls } = fakeDeps([{ status: 200 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res.unsubscribed).toBe(false);
    expect(res.reason).toMatch(/cannot send/);
    expect(res.options.mailtos).toEqual(["mailto:unsub@example.com"]);
    expect(calls).toHaveLength(0);
  });

  it("reports 'nothing advertised' rather than failing", async () => {
    const { gmail } = gmailThread([{ From: "a@b.c", Subject: "hi" }]);
    const { deps, calls } = fakeDeps([{ status: 200 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res).toMatchObject({ unsubscribed: false });
    expect(res.reason).toMatch(/no List-Unsubscribe option/);
    expect(calls).toHaveLength(0);
  });

  it("marks a rejected opt-out as unsuccessful and says why", async () => {
    const { gmail } = gmailWith({
      "List-Unsubscribe": "<https://new.example/u/xyz>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const { deps } = fakeDeps([{ status: 500 }]);
    const res = await unsubscribeThread(gmail, "t1", deps);
    expect(res.unsubscribed).toBe(false);
    expect(res.status).toBe(500);
    expect(res.reason).toMatch(/answered 500/);
  });
});

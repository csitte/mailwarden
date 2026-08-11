/**
 * List-Unsubscribe (RFC 2369 / RFC 8058) — inspecting a mailing list's opt-out
 * options, and performing the one-click HTTPS opt-out.
 *
 * This is mailwarden's ONLY outbound request to a host other than Google, so the
 * rules around it are deliberately tight:
 *
 *  - **The URL is never a tool parameter.** It is read from the `List-Unsubscribe`
 *    header of the addressed message and nothing else. If the model could pass a
 *    URL, an injected mail could turn this into an exfiltration channel (mailbox
 *    content in the query string) — the same reasoning that keeps the account out
 *    of the tool schema (see SECURITY.md).
 *  - **The request body is fixed** (`List-Unsubscribe=One-Click`) and the response
 *    body is discarded: only the status code flows back into the model's context,
 *    so the endpoint cannot answer with instructions.
 *  - **Only RFC 8058 one-click** is automated, i.e. the sender must have opted in
 *    via `List-Unsubscribe-Post`. A plain `https:` link is meant for a human in a
 *    browser and is surfaced, not fetched.
 *  - **`mailto:` opt-outs are never performed** — they would require sending mail,
 *    which mailwarden cannot do (no send scope). They are reported for the human.
 *  - **SSRF guards:** https only, default port, no credentials in the URL, and
 *    every hop (including redirects) must resolve exclusively to public addresses.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { Gmail } from "./gmail.js";

/** What a message's List-Unsubscribe headers offer. */
export interface UnsubscribeOptions {
  /** Sender opted into RFC 8058 one-click AND provided an https URL — automatable. */
  oneClick: boolean;
  /** `https:` opt-out URLs, in header order. */
  httpsUrls: string[];
  /** `mailto:` opt-out targets, in header order. mailwarden never sends to these. */
  mailtos: string[];
}

/** Values other than https/mailto (e.g. plain http) are dropped, not surfaced. */
const URI_LIST = /<([^<>]*)>/g;
const ONE_CLICK_POST = /(^|[;,\s])List-Unsubscribe\s*=\s*One-Click([;,\s]|$)/i;

/**
 * Parse `List-Unsubscribe` (+ `List-Unsubscribe-Post`) into the opt-out options.
 * Tolerates folded headers and missing angle brackets around a lone URI, which
 * real senders both produce. Bare `http:` URLs are ignored — downgrading an
 * opt-out to cleartext is not worth automating, and one-click requires https.
 */
export function parseListUnsubscribe(
  listUnsubscribe: string | undefined,
  listUnsubscribePost?: string,
): UnsubscribeOptions {
  const raw = (listUnsubscribe ?? "").trim();
  const candidates: string[] = [];
  const bracketed = raw.match(URI_LIST);
  if (bracketed?.length) {
    for (const m of bracketed) candidates.push(m.slice(1, -1).trim());
  } else if (raw) {
    // No angle brackets at all: treat the whole value as a comma-separated list.
    for (const part of raw.split(",")) candidates.push(part.trim());
  }

  const httpsUrls: string[] = [];
  const mailtos: string[] = [];
  for (const c of candidates) {
    // Header folding can leave newlines inside the brackets.
    const uri = c.replace(/\s+/g, "");
    if (!uri) continue;
    if (/^https:\/\//i.test(uri)) httpsUrls.push(uri);
    else if (/^mailto:/i.test(uri)) mailtos.push(uri);
  }

  return {
    oneClick: httpsUrls.length > 0 && ONE_CLICK_POST.test(listUnsubscribePost ?? ""),
    httpsUrls,
    mailtos,
  };
}

/**
 * Parse and vet an opt-out URL: https, default port, no embedded credentials.
 * A non-default port would let a redirect reach an internal service on a host
 * whose address is public; the address check alone would pass it.
 */
export function validateUnsubscribeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Unsubscribe URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Unsubscribe URL must be https (got ${url.protocol.replace(":", "")}).`);
  }
  if (url.username || url.password) {
    throw new Error("Unsubscribe URL must not carry credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new Error(`Unsubscribe URL must use the default https port (got ${url.port}).`);
  }
  return url;
}

/**
 * IPv4 dotted quad → its 4 bytes, or null. Deliberately strict: octal (`0177.0.0.1`),
 * hex (`0x7f.0.0.1`), integer (`2130706433`) and short (`127.1`) notations all return
 * null and therefore fail closed at the caller, rather than being decoded into an
 * address we might then mis-classify.
 */
function parseIpv4Bytes(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * IPv6 literal → its 16 bytes, or null. Handles `::` elision anywhere and a
 * trailing dotted quad (`::ffff:127.0.0.1`).
 *
 * Parsing to bytes is the whole point: matching prefixes as *text* only works for
 * whatever spelling the resolver happens to emit, and `0:0:0:0:0:0:0:1` is the same
 * address as `::1`. Every spelling collapses to the same 16 bytes here.
 */
function parseIpv6Bytes(s: string): number[] | null {
  if (!s.includes(":")) return null;
  let text = s;
  // Fold a trailing dotted quad into the two hex groups it stands for.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = parseIpv4Bytes(dotted[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = text.slice(0, -dotted[1].length) + `${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null; // `::` may appear at most once
  const toGroups = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...left, ...right].some(Number.isNaN)) return null;
  const missing = 8 - left.length - right.length;
  // Without `::` the address must already be complete; with it, at least one group elided.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...right];
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  return bytes;
}

/** True when `bytes` falls inside the CIDR block `prefix`/`bits`. */
function inCidr(bytes: number[], prefix: number[], bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (bytes[i] !== prefix[i]) return false;
  const rest = bits & 7;
  if (rest) {
    const mask = (0xff << (8 - rest)) & 0xff;
    if ((bytes[whole] & mask) !== (prefix[whole] & mask)) return false;
  }
  return true;
}

const cidrs = (v4: boolean, list: [string, number][]) =>
  list.map(([addr, bits]) => {
    const bytes = v4 ? parseIpv4Bytes(addr) : parseIpv6Bytes(addr);
    if (!bytes) throw new Error(`mailwarden: unparsable blocked CIDR ${addr}`); // build-time typo guard
    return [bytes, bits] as const;
  });

/** IPv4 blocks that are not globally reachable (IANA IPv4 Special-Purpose registry). */
const BLOCKED_V4 = cidrs(true, [
  ["0.0.0.0", 8], // "this host on this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT / shared address space
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — includes 169.254.169.254 (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255 broadcast
]);

/** IPv6 blocks that are not globally reachable (IANA IPv6 Special-Purpose registry). */
const BLOCKED_V6 = cidrs(false, [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use IPv4/IPv6 translation
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID (deprecated)
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation — the v6 twin of TEST-NET
  ["2002::", 16], // 6to4 (deprecated), and it embeds an arbitrary IPv4
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
]);

/** IPv6 blocks carrying an IPv4 address in their last 4 bytes — judge that too. */
const V4_IN_V6 = cidrs(false, [
  ["::", 96], // IPv4-compatible (deprecated) + the unspecified/loopback corner
  ["::ffff:0:0", 96], // IPv4-mapped
  ["::ffff:0:0:0", 96], // IPv4-translated (RFC 2765, deprecated — still spells out an IPv4)
  ["64:ff9b::", 96], // NAT64
]);

/**
 * True for addresses an unsubscribe request must never reach: loopback, private
 * and shared ranges, link-local (incl. the cloud metadata address), multicast,
 * documentation and reserved space — in either family, in any spelling.
 *
 * Anything that does not parse as an address is blocked: the input is a resolver's
 * answer, so an unparsable one means we cannot reason about where the request would
 * go, and that is not a reason to let it through.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();

  const v4 = parseIpv4Bytes(addr);
  if (v4) return BLOCKED_V4.some(([prefix, bits]) => inCidr(v4, prefix, bits));

  const v6 = parseIpv6Bytes(addr);
  if (!v6) return true;
  if (BLOCKED_V6.some(([prefix, bits]) => inCidr(v6, prefix, bits))) return true;
  // An embedded IPv4 must clear the IPv4 rules as well — but only ever to BLOCK.
  // A public inner address does not excuse the outer prefix (`fd00::8.8.8.8`).
  if (V4_IN_V6.some(([prefix, bits]) => inCidr(v6, prefix, bits))) {
    const inner = v6.slice(12);
    if (BLOCKED_V4.some(([prefix, bits]) => inCidr(inner, prefix, bits))) return true;
  }
  return false;
}

/** Injection seams: the network and the resolver, so tests never touch either. */
export interface UnsubscribeDeps {
  fetch: typeof globalThis.fetch;
  /** Resolve a hostname to every address it maps to. */
  resolveHost: (hostname: string) => Promise<string[]>;
}

export const defaultUnsubscribeDeps: UnsubscribeDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  resolveHost: async (hostname) => {
    const entries = await dnsLookup(hostname, { all: true });
    return entries.map((e) => e.address);
  },
};

/**
 * Reject a hop whose host resolves to anything non-public (all answers must pass).
 *
 * Known residual: `fetch` resolves the name again when it connects, so a resolver
 * that answers differently the second time (DNS rebinding) is not caught here.
 * Closing that would mean pinning the checked address through a custom connector,
 * which `fetch` does not expose. What survives the gap is a *blind* POST with a
 * fixed body whose response is never read — see SECURITY.md.
 */
async function assertPublicHost(url: URL, deps: UnsubscribeDeps, deadline?: AbortSignal): Promise<void> {
  // `url.hostname` is already punycode for an IDN, so a homograph domain resolves
  // as the name it really is — the check sees what the connection will see.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    // The deadline covers resolution too. `AbortSignal` cannot cancel a
    // `dns.lookup` in flight, but racing it means a stalled resolver returns
    // control on time instead of holding the tool call open indefinitely.
    addresses = await (deadline
      ? Promise.race([
          deps.resolveHost(host),
          new Promise<never>((_, reject) => {
            if (deadline.aborted) reject(new Error("timed out"));
            deadline.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
          }),
        ])
      : deps.resolveHost(host));
  } catch (err) {
    throw new Error(
      `Could not resolve the unsubscribe host ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!addresses.length) throw new Error(`The unsubscribe host ${host} resolved to no address.`);
  const blocked = addresses.filter((a) => isBlockedAddress(a));
  if (blocked.length) {
    throw new Error(
      `The unsubscribe host ${host} resolves to a non-public address (${blocked.join(", ")}) — refusing to call it.`,
    );
  }
}

export interface OneClickResult {
  /** The URL actually called last (after any redirects). */
  url: string;
  status: number;
  ok: boolean;
  /** How many redirects were followed. */
  redirects: number;
}

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "mailwarden (+https://github.com/csitte/mailwarden)";

/**
 * Perform the RFC 8058 one-click opt-out: POST `List-Unsubscribe=One-Click` to
 * the sender's https endpoint. Redirects are followed manually (up to
 * MAX_REDIRECTS) so every hop is re-validated — a permissive endpoint must not
 * be able to bounce the request onto an internal host. 301/302/303 switch to GET
 * per the usual rules; 307/308 repeat the POST.
 *
 * The response body is never read: only the status code is returned.
 */
export async function oneClickUnsubscribe(
  rawUrl: string,
  deps: UnsubscribeDeps = defaultUnsubscribeDeps,
  timeoutMs = TIMEOUT_MS,
): Promise<OneClickResult> {
  let url = validateUnsubscribeUrl(rawUrl);
  let method: "POST" | "GET" = "POST";
  // ONE budget for the whole chain, not per hop — a per-hop timeout would let a
  // redirecting endpoint stall the tool call for MAX_REDIRECTS × TIMEOUT_MS.
  const deadline = AbortSignal.timeout(timeoutMs);

  for (let redirects = 0; ; redirects++) {
    await assertPublicHost(url, deps, deadline);
    const res = await deps.fetch(url.toString(), {
      method,
      redirect: "manual",
      headers:
        method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT }
          : { "user-agent": USER_AGENT },
      body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
      signal: deadline,
    });
    // Discard the body unread — it must not reach the model, and an unconsumed
    // stream would keep the socket open.
    try {
      await res.body?.cancel();
    } catch {
      /* body already consumed or not a real stream (tests) */
    }

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      return { url: url.toString(), status: res.status, ok: res.status >= 200 && res.status < 300, redirects };
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`The unsubscribe endpoint redirected more than ${MAX_REDIRECTS} times.`);
    }
    url = validateUnsubscribeUrl(new URL(location, url).toString());
    if (res.status !== 307 && res.status !== 308) method = "GET";
  }
}

// ---- IO layer: the two operations the tools expose ----

/** What a thread offers, without touching the network. */
export interface UnsubscribeInfo extends UnsubscribeOptions {
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  /** Any opt-out option at all was advertised. */
  hasUnsubscribe: boolean;
}

/** Read-only: report a thread's opt-out options. Makes no outbound request. */
export async function inspectUnsubscribe(gmail: Gmail, threadId: string): Promise<UnsubscribeInfo> {
  const h = await gmail.getUnsubscribeHeaders(threadId);
  const options = parseListUnsubscribe(h.listUnsubscribe, h.listUnsubscribePost);
  return {
    threadId,
    messageId: h.messageId,
    from: h.from,
    subject: h.subject,
    ...options,
    hasUnsubscribe: options.httpsUrls.length > 0 || options.mailtos.length > 0,
  };
}

export interface UnsubscribeResult {
  threadId: string;
  messageId: string;
  from: string;
  /** True only when the one-click POST was made AND the endpoint accepted it. */
  unsubscribed: boolean;
  /** The endpoint called, if one was. */
  url?: string;
  status?: number;
  /** Why nothing was sent, or why the endpoint's answer was not a success. */
  reason?: string;
  /** Everything the message advertised, so a human can finish what we won't do. */
  options: UnsubscribeOptions;
}

/**
 * Perform the one-click opt-out for a thread, if the sender supports it.
 * Returns a structured refusal (rather than throwing) when the message offers no
 * automatable option — the caller needs the alternatives, not an error.
 */
export async function unsubscribeThread(
  gmail: Gmail,
  threadId: string,
  deps: UnsubscribeDeps = defaultUnsubscribeDeps,
): Promise<UnsubscribeResult> {
  const info = await inspectUnsubscribe(gmail, threadId);
  const base = {
    threadId,
    messageId: info.messageId,
    from: info.from,
    options: { oneClick: info.oneClick, httpsUrls: info.httpsUrls, mailtos: info.mailtos },
  };

  if (!info.hasUnsubscribe) {
    return { ...base, unsubscribed: false, reason: "The message advertises no List-Unsubscribe option." };
  }
  if (!info.oneClick) {
    const reason = info.httpsUrls.length
      ? "The sender offers an unsubscribe link but did not opt into RFC 8058 one-click " +
        "(no List-Unsubscribe-Post header) — the link is meant to be opened by a human in a browser. " +
        "It is listed in `options.httpsUrls`."
      : "The only opt-out offered is a mailto: address, which would require sending mail — " +
        "mailwarden cannot send. It is listed in `options.mailtos`.";
    return { ...base, unsubscribed: false, reason };
  }

  // A header may list several https URIs. Take the first the vetting accepts —
  // throwing because URI #1 has a stray port while #2 is fine would strand a
  // perfectly good opt-out. All of them unusable is a refusal, not an error.
  const usable = info.httpsUrls.find((u) => {
    try {
      validateUnsubscribeUrl(u);
      return true;
    } catch {
      return false;
    }
  });
  if (!usable) {
    return {
      ...base,
      unsubscribed: false,
      reason:
        "The sender's one-click endpoint did not pass vetting (https and the default port only, " +
        "no credentials in the URL). The advertised URLs are listed in `options.httpsUrls`.",
    };
  }

  const res = await oneClickUnsubscribe(usable, deps);
  return {
    ...base,
    unsubscribed: res.ok,
    url: res.url,
    status: res.status,
    ...(res.ok ? {} : { reason: `The unsubscribe endpoint answered ${res.status}.` }),
  };
}

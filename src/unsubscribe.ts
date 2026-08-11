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

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * True for addresses an unsubscribe request must never reach: loopback, private
 * and shared ranges, link-local (incl. the cloud metadata address), multicast,
 * and reserved space. Both families; IPv4-mapped/NAT64 IPv6 is unwrapped first
 * so `::ffff:127.0.0.1` cannot slip through.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();

  const v4 = parseIpv4(addr);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 192 && b === 0 && v4[2] <= 2) return true; // IETF protocol assignments … TEST-NET-1
    if (a === 198 && b === 51 && v4[2] === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && v4[2] === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  if (!addr.includes(":")) return true; // not an address we can reason about
  // Unwrap IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) forms.
  const embedded = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded && (addr.startsWith("::ffff:") || addr.startsWith("64:ff9b:") || addr.startsWith("::"))) {
    return isBlockedAddress(embedded[1]);
  }
  if (addr === "::" || addr === "::1") return true;
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^ff/.test(addr)) return true; // ff00::/8 multicast
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

/** Reject a hop whose host resolves to anything non-public (all answers must pass). */
async function assertPublicHost(url: URL, deps: UnsubscribeDeps): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = await deps.resolveHost(host);
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
): Promise<OneClickResult> {
  let url = validateUnsubscribeUrl(rawUrl);
  let method: "POST" | "GET" = "POST";

  for (let redirects = 0; ; redirects++) {
    await assertPublicHost(url, deps);
    const res = await deps.fetch(url.toString(), {
      method,
      redirect: "manual",
      headers:
        method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT }
          : { "user-agent": USER_AGENT },
      body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

  const res = await oneClickUnsubscribe(info.httpsUrls[0], deps);
  return {
    ...base,
    unsubscribed: res.ok,
    url: res.url,
    status: res.status,
    ...(res.ok ? {} : { reason: `The unsubscribe endpoint answered ${res.status}.` }),
  };
}

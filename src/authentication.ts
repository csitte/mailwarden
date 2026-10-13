/**
 * Sender authentication as the receiving server reported it — SPF, DKIM and DMARC read
 * off the `Authentication-Results` header (RFC 8601), plus the envelope sender.
 *
 * Why this exists: "is this mail really from my bank / the tax office?" is a routine
 * question about a message that is already open, and the answer is sitting in a header
 * every `format=full` fetch already carries. Without it a caller is left with domain
 * spelling and gut feeling — which is exactly how a good phish gets through.
 *
 * Four things this module is careful about, because the input is attacker-supplied:
 *
 * 1. **Only Gmail's own report is read — the topmost one whose authserv-id is
 *    `mx.google.com`.** RFC 8601 §7.1 tells a reader to trust only the reports its own
 *    trust boundary added, and for a Gmail mailbox that boundary is Gmail. Trace headers
 *    are prepended by each hop, so Gmail's report sits above anything the message already
 *    carried when it arrived — including a header an attacker put there. A report from any
 *    other id is never read, however convincing; `otherReports` counts every report that
 *    was not read, and a message with no report from Gmail is `unchecked`.
 *
 *    Through 0.22.1 this read the FIRST report whatever its id. That was right wherever
 *    Gmail had written one, and wrong exactly where it had not: a message with no Gmail
 *    report but a forged one of its own had that forgery read as the verdict, with only
 *    `authservId` to give it away. Measured on 13 October 2026 in two mailboxes before
 *    the change: every received message's first report came from `mx.google.com`, and the
 *    only messages without one were sent mail — so pinning the id drops no real verdict.
 *
 *    This rests on one assumption worth stating rather than burying: that Gmail hands
 *    `payload.headers` back in the order the message carries them. That is how the API
 *    behaves and how every trace-header convention is built, but it is not a documented
 *    guarantee — which is why `otherReports` travels with the result.
 * 2. **Nothing unrecognised is passed through.** A result is a short lowercase token or
 *    it is dropped; a domain must look like a domain. A header is free text, and a field
 *    that reads as a verdict must never be able to carry a sentence.
 * 3. **A missing check is not a passing check.** No `Authentication-Results` header from
 *    Gmail yields `unchecked: true` rather than an empty object, so "nobody looked" cannot
 *    be misread as "nothing wrong".
 * 4. **Alignment is reported, not left to the caller.** `dkimAligned` says whether a
 *    passing DKIM signature was made by the `From` domain (or a parent or child of it) —
 *    the question a reader actually has about a signature, since anyone can sign mail with
 *    a key for a domain they own. Without a public-suffix list this approximates the
 *    relaxed alignment of RFC 7489 by the domain tree, and says nothing where the tree
 *    cannot decide:
 *    - same domain, or one under the other: `true` — sound, because a signing domain has
 *      to publish its key in its own DNS, and no one publishes one at a public suffix;
 *    - siblings sharing two or more trailing labels (`news.bank.example` and
 *      `mail.bank.example`, but equally `a.co.uk` and `b.co.uk`): absent — the first pair
 *      is aligned and the second is not, and only a public-suffix list tells them apart;
 *    - anything else: `false`.
 *    A `false` on an aligned pair would read as suspicious, and that is the error to avoid.
 *
 * What this cannot do: tell Gmail's report from a forged one that claims Gmail's id on a
 * message Gmail never stamped. Mail received over SMTP always carries Gmail's own report
 * on top, so a forgery below it is never read. Mail that reached the mailbox another way —
 * fetched from another account over POP, or inserted by an app — may carry no report from
 * Gmail at all, and there a forged `mx.google.com` report is the only one and is read.
 * Unmeasured, and stated here rather than assumed away.
 *
 * Pure, so a header corpus can hold it.
 */

import { domainToASCII } from "node:url";
import { addressOf, stripComments } from "./signals.js";

/** Header list as Gmail returns it. */
type Headers = { name?: string | null; value?: string | null }[];

export interface Authentication {
  /** SPF result for the envelope sender, e.g. `pass`, `fail`, `softfail`, `none`. */
  spf?: string;
  /** DKIM result for the reported signature, e.g. `pass`, `fail`, `none`. */
  dkim?: string;
  /**
   * DMARC result. The one that ties either check to the visible `From` domain — an
   * `spf=pass` on its own only says the *envelope* sender was authorised, which a
   * lookalike domain achieves trivially.
   */
  dmarc?: string;
  /** Who asserts all of the above (the authserv-id, e.g. `mx.google.com`). */
  authservId?: string;
  /** Domain whose DKIM key signed the message (`header.d`, else the `header.i` domain). */
  signedBy?: string;
  /** Envelope sender domain SPF was evaluated against (`smtp.mailfrom`, else `smtp.helo`). */
  mailedBy?: string;
  /** The `From` domain DMARC evaluated (`header.from`). */
  headerFrom?: string;
  /** `Return-Path` address — where bounces go, often revealing for forwarded or spoofed mail. */
  returnPath?: string;
  /**
   * Further results for a method that DISAGREE with the reported one, as `method=result`
   * (e.g. a second DKIM signature that failed). Without this, reporting only the first
   * result would quietly hide the disagreement.
   */
  alsoReported?: string[];
  /**
   * Whether a PASSING DKIM signature was made by the `From` domain or a parent or child of
   * it. Absent when DKIM did not pass, when either domain is unknown, or when the two are
   * sibling subdomains that only a public-suffix list could judge.
   */
  dkimAligned?: boolean;
  /**
   * How many `Authentication-Results` headers were present and NOT read — every one beyond
   * Gmail's own, including all of them when Gmail wrote none.
   */
  otherReports?: number;
  /** The message carried no `Authentication-Results` header from Gmail — nobody checked. */
  unchecked?: true;
}

/** A result token: short, lowercase, no spaces. Anything else is not a result. */
const RESULT_TOKEN = /^[a-z][a-z0-9-]{0,19}$/;

/**
 * A domain after normalisation: dotted, no leading/trailing separator, length-capped.
 * The dot is required on purpose. `header.d=a b` parses as the value `a` followed by
 * junk, and reporting `signedBy: "a"` would turn a malformed header into a field that
 * reads like a finding — every domain a report names (`header.d`, `smtp.mailfrom`,
 * `header.from`) is a fully qualified one.
 */
const DOMAIN_TOKEN = /^[a-z0-9_](?:[a-z0-9.\-_]{0,251}[a-z0-9_])?$/;

/** An authserv-id may carry a port, so it allows one more character than a domain. */
const AUTHSERV_TOKEN = /^[a-z0-9_](?:[a-z0-9.\-_:]{0,251}[a-z0-9_])?$/;

/** Remove whitespace on either side of each `=` that sits outside double quotes. */
function foldAroundEquals(v: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      out += c;
      if (c === "\\" && i + 1 < v.length) out += v[++i];
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      out += c;
    } else if (c === "=") {
      out = out.replace(/\s+$/, "") + "=";
      while (i + 1 < v.length && /\s/.test(v[i + 1])) i++;
    } else out += c;
  }
  return out;
}

/** Split at `sep` characters that sit outside double quotes. */
function splitOutsideQuotes(v: string, sep: RegExp): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < v.length) cur += v[++i];
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      cur += c;
    } else if (sep.test(c)) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * A domain as a comparison key: case-folded, IDN/Punycode brought to one form, trailing
 * dot dropped. Accepts a bare domain, an `@domain` (as `header.i` is written) or a full
 * address (as `smtp.mailfrom` is written). `undefined` when it does not look like one.
 */
function domainValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let v = raw.trim().replace(/^[<"]+|[>",;]+$/g, "");
  if (v.includes("@")) v = v.slice(v.lastIndexOf("@") + 1);
  v = v.replace(/\.+$/, "").toLowerCase();
  if (v === "") return undefined;
  const ascii = (domainToASCII(v) || v).toLowerCase();
  return ascii.includes(".") && DOMAIN_TOKEN.test(ascii) ? ascii : undefined;
}

/** One `method=result` block with its `ptype.property=pvalue` pairs. */
interface ResInfo {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** Parse the resinfo segments of one Authentication-Results value. */
function parseResInfos(value: string): { authservId?: string; infos: ResInfo[] } {
  const segments = splitOutsideQuotes(stripComments(value), /;/);
  // RFC 8601: the first segment is `authserv-id [ CFWS version ]` — an id, optionally
  // followed by a version number, and nothing else. Anything else there means the field
  // is malformed, and then its first word is not an authserv-id just because it parses
  // as one: `"not an authserv id"` would otherwise be reported as `not`.
  const head = (segments.shift() ?? "").trim().split(/\s+/).filter((t) => t !== "");
  const id = (head[0] ?? "").toLowerCase();
  const wellFormed =
    head.length === 1 || (head.length === 2 && /^\d+$/.test(head[1]));
  const authservId = wellFormed && id.includes(".") && AUTHSERV_TOKEN.test(id) ? id : undefined;

  const infos: ResInfo[] = [];
  for (const seg of segments) {
    // RFC 8601 allows whitespace around "=" (`dkim = fail`). Without folding it the method
    // would be skipped, and a second result for the same method would stand in for it.
    const tokens = splitOutsideQuotes(foldAroundEquals(seg.trim()), /\s/).filter((t) => t !== "");
    if (tokens.length === 0) continue;
    const [methodPart, ...rest] = tokens;
    const eq = methodPart.indexOf("=");
    if (eq === -1) continue; // `none` (RFC 8601 no-result), or junk
    const method = methodPart.slice(0, eq).toLowerCase();
    const result = methodPart.slice(eq + 1).toLowerCase();
    if (!RESULT_TOKEN.test(method) || !RESULT_TOKEN.test(result)) continue;
    const props = new Map<string, string>();
    for (const t of rest) {
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const key = t.slice(0, i).toLowerCase();
      if (!props.has(key)) props.set(key, t.slice(i + 1));
    }
    infos.push({ method, result, props });
  }
  return { authservId, infos };
}

/**
 * The one authserv-id whose reports are read. Gmail stamps every message it receives
 * with it; a report under any other id was written before Gmail saw the message, by a
 * server — or a sender — this mailbox has no reason to trust.
 */
export const TRUSTED_AUTHSERV_ID = "mx.google.com";

/** `mx.google.com:25` is the same server as `mx.google.com`. */
function isTrusted(authservId: string | undefined): boolean {
  return authservId !== undefined && authservId.replace(/:\d+$/, "") === TRUSTED_AUTHSERV_ID;
}

/**
 * Relaxed DKIM alignment as far as the domain tree can tell it: `true` for the same
 * domain or a parent/child pair, `undefined` for siblings that share two or more trailing
 * labels (an organisational domain or a public suffix — undecidable without a list),
 * `false` otherwise.
 */
export function dkimAlignment(signerIn: string, fromIn: string): boolean | undefined {
  const norm = (d: string) => d.trim().toLowerCase().replace(/\.+$/, "");
  const signer = norm(signerIn);
  const from = norm(fromIn);
  if (signer === "" || from === "") return undefined;
  if (signer === from || signer.endsWith("." + from) || from.endsWith("." + signer)) return true;
  const a = signer.split(".").reverse();
  const b = from.split(".").reverse();
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= 2 ? undefined : false;
}

/** The value of the first header with this name, trimmed; `undefined` when absent or blank. */
function headerValue(headers: Headers, name: string): string | undefined {
  const n = name.toLowerCase();
  const v = (headers.find((h) => (h.name ?? "").toLowerCase() === n)?.value ?? "").trim();
  return v === "" ? undefined : v;
}

/**
 * What the receiving server said about this message's authenticity.
 *
 * Reads the topmost `Authentication-Results` header written by Gmail only — see the
 * module comment for why that is the security-relevant one — plus the `Return-Path` and
 * the `From` domain for alignment. Never throws: a malformed or hostile header yields
 * fewer fields, never a wrong one.
 */
export function parseAuthentication(headers: Headers): Authentication {
  const out: Authentication = {};

  const returnPath = addressOf(headerValue(headers, "Return-Path"));
  if (returnPath) out.returnPath = returnPath;

  const reports = headers
    .filter((h) => (h.name ?? "").toLowerCase() === "authentication-results")
    .map((h) => parseResInfos(h.value ?? ""));
  const mine = reports.findIndex((r) => isTrusted(r.authservId));
  const notRead = mine === -1 ? reports.length : reports.length - 1;
  if (notRead > 0) out.otherReports = notRead;
  if (mine === -1) {
    out.unchecked = true;
    return out;
  }

  const { authservId, infos } = reports[mine];
  out.authservId = authservId;

  const disagreeing: string[] = [];
  for (const method of ["spf", "dkim", "dmarc"] as const) {
    const all = infos.filter((i) => i.method === method);
    const first = all[0];
    if (!first) continue;
    out[method] = first.result;

    // A second signature or check that says something else is exactly what a caller
    // must not have hidden from them — `pass` alongside `fail` is not a `pass`.
    for (const other of all.slice(1)) {
      if (other.result !== first.result) disagreeing.push(`${method}=${other.result}`);
    }

    if (method === "dkim") {
      out.signedBy = domainValue(first.props.get("header.d") ?? first.props.get("header.i"));
    } else if (method === "spf") {
      out.mailedBy = domainValue(first.props.get("smtp.mailfrom") ?? first.props.get("smtp.helo"));
    } else {
      out.headerFrom = domainValue(first.props.get("header.from"));
    }
  }

  const unique = [...new Set(disagreeing)];
  if (unique.length > 0) out.alsoReported = unique;

  const fromDomain = domainValue(addressOf(headerValue(headers, "From")));
  if (out.dkim === "pass" && out.signedBy && fromDomain) {
    const aligned = dkimAlignment(out.signedBy, fromDomain);
    if (aligned !== undefined) out.dkimAligned = aligned;
  }

  // Drop the keys that came back undefined, so the object carries only what was found.
  for (const k of Object.keys(out) as (keyof Authentication)[]) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

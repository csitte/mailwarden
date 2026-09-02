/**
 * Sender authentication as the receiving server reported it — SPF, DKIM and DMARC read
 * off the `Authentication-Results` header (RFC 8601), plus the envelope sender.
 *
 * Why this exists: "is this mail really from my bank / the tax office?" is a routine
 * question about a message that is already open, and the answer is sitting in a header
 * every `format=full` fetch already carries. Without it a caller is left with domain
 * spelling and gut feeling — which is exactly how a good phish gets through.
 *
 * Three things this module is careful about, because the input is attacker-supplied:
 *
 * 1. **Only the first report is read.** Trace headers are prepended by each hop, so the
 *    first `Authentication-Results` is the one the *receiving* server wrote. Anything
 *    below it was already in the message when it arrived — including a header an attacker
 *    put there. RFC 8601 §5 tells a receiver to strip forged reports carrying its own
 *    authserv-id, but that is the receiver's job, not ours to assume: `authservId` is
 *    reported alongside so a caller can see WHO is asserting the result, and
 *    `otherReports` counts the ones not read.
 * 2. **Nothing unrecognised is passed through.** A result is a short lowercase token or
 *    it is dropped; a domain must look like a domain. A header is free text, and a field
 *    that reads as a verdict must never be able to carry a sentence.
 * 3. **A missing check is not a passing check.** No `Authentication-Results` header at
 *    all yields `unchecked: true` rather than an empty object, so "nobody looked" cannot
 *    be misread as "nothing wrong".
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
  /** How many `Authentication-Results` headers were present beyond the one read. */
  otherReports?: number;
  /** The message carried no `Authentication-Results` header at all — nobody checked. */
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
    const tokens = splitOutsideQuotes(seg.trim(), /\s/).filter((t) => t !== "");
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

/** The value of the first header with this name, trimmed; `undefined` when absent or blank. */
function headerValue(headers: Headers, name: string): string | undefined {
  const n = name.toLowerCase();
  const v = (headers.find((h) => (h.name ?? "").toLowerCase() === n)?.value ?? "").trim();
  return v === "" ? undefined : v;
}

/**
 * What the receiving server said about this message's authenticity.
 *
 * Reads the FIRST `Authentication-Results` header only — see the module comment for why
 * that is the security-relevant one — and the `Return-Path`. Never throws: a malformed
 * or hostile header yields fewer fields, never a wrong one.
 */
export function parseAuthentication(headers: Headers): Authentication {
  const out: Authentication = {};

  const returnPath = addressOf(headerValue(headers, "Return-Path"));
  if (returnPath) out.returnPath = returnPath;

  const reports = headers.filter((h) => (h.name ?? "").toLowerCase() === "authentication-results");
  if (reports.length === 0) {
    out.unchecked = true;
    return out;
  }
  if (reports.length > 1) out.otherReports = reports.length - 1;

  const { authservId, infos } = parseResInfos(reports[0].value ?? "");
  if (authservId) out.authservId = authservId;

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

  // Drop the keys that came back undefined, so the object carries only what was found.
  for (const k of Object.keys(out) as (keyof Authentication)[]) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

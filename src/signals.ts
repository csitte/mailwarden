/**
 * Triage signals — per-thread flags an agent can act on WITHOUT opening the mail,
 * derived from headers and MIME structure the `search` fetch already has in hand
 * (format=full), so they cost no extra API call.
 *
 * Deliberately conservative: every signal is a documented header convention or MIME
 * fact, never a guess from subject/body wording. A missing signal means "nothing
 * declared", not "definitely personal mail". Pure, so a header corpus can hold it.
 */

import { domainToASCII } from "node:url";

export type Signal = "newsletter" | "automated" | "calendar" | "replyToMismatch";

/** Fixed order for stable output — a thread's signals are always listed in this order. */
export const ALL_SIGNALS: readonly Signal[] = ["newsletter", "automated", "calendar", "replyToMismatch"];

export interface SignalInput {
  /** Raw headers of the message (name/value, any casing, as Gmail returns them). */
  headers: { name?: string | null; value?: string | null }[];
  /** Every MIME part's type + filename, flattened (root part included). */
  parts: { mimeType?: string | null; filename?: string | null }[];
}

/**
 * Local-parts that by convention mark a sender as a machine, not a person. Matched
 * on the local-part only (before `@`) and only in these spellings — a person named
 * "Noreen Reply" must not be flagged, so no substring matching. Hyphen and underscore
 * are the two separators the same words are written with (`no-reply`, `no_reply`).
 */
const MACHINE_LOCAL_PARTS =
  /^(no[-_]?reply|do[-_]?not[-_]?reply|mailer-daemon|postmaster|notifications?|alerts?|bounces?)$/i;

/**
 * A header's value, trimmed; `undefined` when the header is absent OR blank — a header
 * with nothing in it declares nothing, so presence-only signals do not fire on it.
 */
function header(input: SignalInput, name: string): string | undefined {
  const n = name.toLowerCase();
  const h = input.headers.find((x) => (x.name ?? "").toLowerCase() === n);
  const v = (h?.value ?? "").trim();
  return v === "" ? undefined : v;
}

/**
 * Remove RFC 5322 comments — parenthesised, nestable, only outside quoted strings —
 * so `bulk (mailer)` reads as `bulk` and `a@x.example (Alice)` as `a@x.example`.
 */
function stripComments(v: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      out += c;
      if (c === "\\" && i + 1 < v.length) out += v[++i];
      else if (c === '"') quoted = false;
    } else if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    } else if (c === "(") depth++;
    else if (c === ")") continue; // stray closer outside any comment: junk, dropped
    else if (c === '"') {
      quoted = true;
      out += c;
    } else out += c;
  }
  // An unclosed comment would swallow the rest of the value — malformed input, so
  // rather than lose the address, leave the value as it came.
  return depth > 0 ? v : out;
}

/**
 * True when the value's double quotes do not pair up (an unescaped `"` left open) —
 * malformed per RFC 5322; the quotes are then treated as ordinary characters.
 */
function unbalancedQuotes(v: string): boolean {
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
  }
  return quoted;
}

/** The first token of a structured value — comments, parameters (`;…`) and folding gone. */
function firstToken(value: string | undefined): string {
  if (!value) return "";
  return (stripComments(value).trim().split(/[\s;]/)[0] ?? "").toLowerCase();
}

/** Quotes made sane (an unbalanced `"` demotes all of them to text) and comments removed. */
function normalizeAddressList(value: string): string {
  return stripComments(unbalancedQuotes(value) ? value.replace(/"/g, "") : value);
}

/**
 * Split an address-list into its mailboxes at `,`/`;` outside quotes and outside `<…>`,
 * keeping each item's offset into the input. Linear — one pass, no lookahead.
 */
function splitMailboxes(v: string): Array<{ text: string; start: number }> {
  const items: Array<{ text: string; start: number }> = [];
  let cur = "";
  let start = 0;
  let quoted = false;
  let angle = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < v.length) cur += v[++i];
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      cur += c;
    } else if (c === "<") {
      angle = true;
      cur += c;
    } else if (c === ">") {
      angle = false;
      cur += c;
    } else if ((c === "," || c === ";") && !angle) {
      items.push({ text: cur, start });
      cur = "";
      start = i + 1;
    } else cur += c;
  }
  items.push({ text: cur, start });
  return items;
}

/** Index of the mailbox's own angle-addr in an item — the LAST `<` outside quotes — or -1. */
function angleIndex(item: string): number {
  return unquoted(item).lastIndexOf("<");
}

/** The lowercased addr-spec of one mailbox item, "" when there is none. */
function addrSpecOf(item: string): string {
  let raw: string;
  // The addr-spec is the LAST angle-addr outside quotes: a quoted display name may
  // contain a literal `<…>`, and the mailbox's own angle-addr is what ends it.
  const lt = angleIndex(item);
  const gt = lt === -1 ? -1 : unquoted(item).indexOf(">", lt);
  if (lt !== -1 && gt !== -1) {
    raw = item.slice(lt + 1, gt);
    // Obsolete source route: `<@relay.example:user@host>` — the mailbox is after the colon.
    if (raw.trim().startsWith("@") && raw.includes(":")) raw = raw.slice(raw.indexOf(":") + 1);
    // Obsolete whitespace around `@`, folded the same way as in the bare form below.
    if (!raw.includes('"')) raw = raw.replace(/\s*@\s*/, "@");
  } else {
    raw = item;
    // Group syntax without angle-addrs: `Team: user@host` — drop the group name.
    const at = raw.indexOf("@");
    const colon = raw.indexOf(":");
    if (colon !== -1 && (at === -1 || colon < at) && !raw.slice(0, colon).includes('"')) {
      raw = raw.slice(colon + 1);
    }
    // Bare form: obsolete whitespace around `@` is folded away; anything else that is
    // whitespace-separated from the addr-spec (an unbracketed name, junk) is not it.
    if (!raw.includes('"')) {
      raw = raw.replace(/\s*@\s*/, "@").trim();
      if (/\s/.test(raw)) raw = raw.split(/\s+/).find((w) => w.includes("@")) ?? "";
    }
  }
  raw = raw.trim().toLowerCase();
  return raw.includes("@") ? raw : "";
}

/**
 * The addr-specs of an address-list header (From, Reply-To), lowercased, in order.
 * Understands what a scanner needs to get the *right* address out of hostile input:
 * quoted display names (a `<` or `@` inside quotes is text, not an address), comments,
 * folding whitespace, groups (`Team: a@x, b@x;`), several mailboxes, and the obsolete
 * source route (`<@relay:a@x>`). A mailbox with no `@` in it is not an address.
 */
export function addressesOf(value: string | undefined): string[] {
  if (!value) return [];
  return splitMailboxes(normalizeAddressList(value))
    .map((it) => addrSpecOf(it.text))
    .filter((a) => a !== "");
}

/** Quoted strings replaced by a placeholder of the same length, so scanning ignores their content. */
function unquoted(v: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      if (c === "\\" && i + 1 < v.length) {
        out += "__";
        i++;
      } else if (c === '"') {
        quoted = false;
        out += c;
      } else out += "_";
    } else {
      if (c === '"') quoted = true;
      out += c;
    }
  }
  return out;
}

/** Lowercased address out of a From/Reply-To value (the first, if several); "" when none. */
export function addressOf(value: string | undefined): string {
  return addressesOf(value)[0] ?? "";
}

/**
 * The first mailbox of a From/Reply-To value as `{ address, name }`: the first item that
 * carries an addr-spec, and its display name — what precedes the mailbox's own angle-addr
 * (the LAST `<` outside quotes — a quoted name may contain a literal `<…>`), comments
 * removed, an enclosing quoted-string unquoted. A name that was written with unquoted
 * commas (`Doe, Jane <j@x>`) is kept whole: the earlier comma-split pieces belong to it
 * as long as they carry no address syntax of their own. Linear in the input.
 * `address` is "" when nothing recognisable is there — callers keep their own fallback.
 */
export function mailboxOf(value: string | undefined): { address: string; name: string } {
  if (!value) return { address: "", name: "" };
  const v = normalizeAddressList(value);
  const items = splitMailboxes(v);
  for (const it of items) {
    const address = addrSpecOf(it.text);
    if (!address) continue;
    const lt = angleIndex(it.text);
    if (lt === -1) return { address, name: "" };
    const whole = v.slice(0, it.start + lt);
    const own = it.text.slice(0, lt);
    const name = /[<>@]/.test(unquoted(whole)) ? own : whole;
    return { address, name: unquotePhrase(name) };
  }
  return { address: "", name: "" };
}

/** A display-name phrase: trimmed, an enclosing quoted-string unquoted and unescaped. */
function unquotePhrase(phrase: string): string {
  const t = phrase.trim();
  const m = /^"(.*)"$/s.exec(t);
  return (m ? m[1].replace(/\\(.)/g, "$1") : t).trim();
}

/** The local-part of an addr-spec, with a quoted local-part (`"no-reply"@x`) unquoted. */
function localPartOf(address: string): string {
  const at = address.lastIndexOf("@");
  const lp = at === -1 ? "" : address.slice(0, at).trim();
  const m = /^"(.*)"$/.exec(lp);
  return m ? m[1].replace(/\\(.)/g, "$1") : lp;
}

/** Same domain, or one is a subdomain of the other — compared at label boundaries. */
function sameOrSubdomain(a: string, b: string): boolean {
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/**
 * `X-Auto-Response-Suppress` (Exchange) marks a message whose sender wants no automatic
 * replies — bulk/system mail. Its value `None` means "suppress nothing" and is the one
 * value that declares no such thing; any other value list (`All`, `OOF, AutoReply`, …) does.
 */
function autoResponseSuppressed(value: string | undefined): boolean {
  if (value === undefined) return false;
  const tokens = stripComments(value).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return tokens.length > 0 && !tokens.every((t) => t === "none");
}

/**
 * The domain of an addr-spec as a COMPARISON key: case-folded, IDN and Punycode brought
 * to the same (ASCII) form, Unicode normalized, trailing dot dropped — so `münchen.de`,
 * `MÜNCHEN.de.` and `xn--mnchen-3ya.de` compare equal. "" when there is no domain.
 */
function domainKeyOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) return "";
  const raw = address.slice(at + 1).trim().replace(/\.+$/, "");
  if (raw === "") return "";
  return (domainToASCII(raw) || raw).toLowerCase().replace(/\.+$/, "");
}

/**
 * The signals a message declares. See the module comment for what each one means:
 *
 * - `newsletter` — mailing-list / bulk machinery: `List-Id`, `List-Unsubscribe`, or
 *   `Precedence: bulk|list`. (RFC 2919 / 2369; Precedence is the de-facto convention.)
 * - `automated` — the sender says a machine wrote it: `Auto-Submitted` other than `no`
 *   (RFC 3834), `Precedence: auto_reply`, an `X-Auto-Response-Suppress` header, or a
 *   From local-part in the no-reply / mailer-daemon family.
 * - `calendar` — a `text/calendar` MIME part or an `.ics` attachment: an invitation,
 *   update or reply the user may need to answer.
 * - `replyToMismatch` — `Reply-To` names a *different domain* than `From`. Same-domain
 *   differences (`hello@` vs `support@`) are routine and not flagged. Common in phishing
 *   and in some legitimate marketing; a reason to look, not a verdict.
 */
export function deriveSignals(input: SignalInput): Signal[] {
  const out = new Set<Signal>();

  const precedence = firstToken(header(input, "Precedence"));
  if (
    header(input, "List-Id") !== undefined ||
    header(input, "List-Unsubscribe") !== undefined ||
    precedence === "bulk" ||
    precedence === "list"
  ) {
    out.add("newsletter");
  }

  const from = addressOf(header(input, "From"));
  // RFC 3834: `no` (with optional comments/parameters) means a human sent it; any other
  // value, including extension tokens, means a machine did.
  const autoSubmitted = firstToken(header(input, "Auto-Submitted"));
  if (
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    precedence === "auto_reply" ||
    autoResponseSuppressed(header(input, "X-Auto-Response-Suppress")) ||
    MACHINE_LOCAL_PARTS.test(localPartOf(from))
  ) {
    out.add("automated");
  }

  if (
    input.parts.some(
      (p) =>
        /^text\/calendar\s*(;|$)/i.test((p.mimeType ?? "").trim()) ||
        /\.ics$/i.test(p.filename ?? ""),
    )
  ) {
    out.add("calendar");
  }

  const fromDomain = domainKeyOf(from);
  if (fromDomain) {
    // Every Reply-To mailbox counts: a reply goes to all of them, so one foreign
    // domain among several is still a reply leaving the sender's domain. A subdomain
    // of the sender's domain (or the sender's domain being one of the Reply-To's) is
    // NOT foreign — `news@e.brand.example` → `help@brand.example` is how marketing
    // mail is routinely built, and a phisher gets no subdomain of the domain he spoofs.
    const foreign = addressesOf(header(input, "Reply-To"))
      .map(domainKeyOf)
      .some((d) => d !== "" && !sameOrSubdomain(d, fromDomain));
    if (foreign) out.add("replyToMismatch");
  }

  return ALL_SIGNALS.filter((s) => out.has(s));
}

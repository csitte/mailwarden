import { CliError } from "./cli.js";
import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import path from "node:path";
import { deriveSignals, mailboxOf, type Signal } from "./signals.js";

export interface ThreadSummary {
  threadId: string;
  messageCount: number;
  from: string;
  subject: string;
  date: string;
  labelIds: string[];
  snippet: string;
  hasAttachments: boolean;
  /**
   * Header/MIME-derived triage flags of the thread's FIRST message (its origin — a
   * newsletter stays a newsletter after the user replies to it). Empty = nothing declared.
   */
  signals: Signal[];
}

export interface Attachment {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  plaintextBody: string;
  htmlBody: string;
  attachments: Attachment[];
}

export interface LabelInfo {
  id: string;
  name: string;
  type?: string | null;
}

/** The raw headers needed to evaluate a mailing list's opt-out options. */
export interface UnsubscribeHeaders {
  messageId: string;
  from: string;
  subject: string;
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

/** Minimal handle on a message: its id plus the thread it belongs to. */
export interface MessageRef {
  id: string;
  threadId: string;
}

/** Outcome of a chunked batch-modify — partial success is reported, not hidden. */
export interface BatchModifyResult {
  modifiedMessages: number;
  modifiedThreads: string[];
  failed: { messageIds: string[]; error: string }[];
}

/** A Gmail filter's match conditions — the subset mailwarden accepts/surfaces. */
export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "smaller" | "larger";
}

/**
 * A filter as returned by the API. `forward` is surfaced so existing forwarding
 * filters can be audited — but mailwarden never *creates* one (see createFilter):
 * a forwarding filter would hand prompt-injected mail an exfiltration path, the
 * exact thing the no-send design closes.
 */
export interface FilterSummary {
  id: string;
  criteria: FilterCriteria;
  addLabelIds: string[];
  removeLabelIds: string[];
  forward?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported & API-free so they're unit-testable without a mock).
// The Gmail class methods are thin wrappers around these.
// ---------------------------------------------------------------------------

/** Decode the byte payload of one RFC 2047 encoded-word (B = base64, Q = quoted-printable-ish). */
function encodedWordBytes(encoding: string, data: string): Uint8Array {
  if (/b/i.test(encoding)) return Buffer.from(data, "base64");
  // Q encoding: `_` is space, `=XX` is a hex byte, everything else is literal ASCII.
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9a-f]{2}$/i.test(data.slice(i + 1, i + 3))) {
      out.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(data.charCodeAt(i));
  }
  return Uint8Array.from(out);
}

/**
 * Decode RFC 2047 encoded-words in a header value: `=?charset?B|Q?data?=`.
 * Non-ASCII Subject/From/To headers arrive from the Gmail API in this raw form —
 * without decoding, the model sees `=?UTF-8?B?...?=` gibberish instead of text.
 * An undecodable word (unknown charset, malformed data) is left as-is.
 */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  // Whitespace between two adjacent encoded-words is ignored (RFC 2047 §6.2).
  const joined = value.replace(/(\?=)[ \t\r\n]+(=\?)/g, "$1$2");
  // `charset*lang` (RFC 2231 language suffix) is allowed — strip the suffix.
  return joined.replace(
    /=\?([^?*\s]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g,
    (whole, charset: string, enc: string, data: string) => {
      try {
        return new TextDecoder(charset).decode(encodedWordBytes(enc, data));
      } catch {
        return whole;
      }
    },
  );
}

/**
 * Decode a `From` header for display WITHOUT letting the decoded text gain structure.
 * RFC 2047 §6.2: a decoded encoded-word is text, never syntax — yet a display name that
 * decodes to `<legit@news.example>,` would read as a second mailbox to anything that
 * parses the DECODED string, and `parseSender` does (it is the sender key that groups
 * `triage_digest` / `list_subscriptions` and dedupes `bulk_unsubscribe`): a crafted mail
 * could take a legitimate newsletter's key. So the structure is read off the RAW value
 * (`mailboxOf`), only the display name is decoded, and it is re-emitted QUOTED whenever
 * it contains address syntax. Nothing recognisable as a mailbox → plain decoded text.
 */
export function decodeAddressHeader(raw: string): string {
  const { address, name } = mailboxOf(raw);
  if (!address) return decodeRfc2047(raw);
  const shown = decodeRfc2047(name).trim();
  if (!shown) return address;
  const needsQuoting = /[()<>@,;:\\"[\]]/.test(shown);
  return `${needsQuoting ? `"${shown.replace(/[\\"]/g, "\\$&")}"` : shown} <${address}>`;
}

/**
 * True when an error is Google's `invalid_grant` — the stored refresh token is
 * expired or revoked (e.g. the 7-day expiry of a "Testing" OAuth consent screen).
 * It surfaces only when a request actually tries to refresh, so it's detected
 * here at the API layer rather than eagerly at token load (which would cost a
 * network round-trip on every startup).
 */
export function isInvalidGrant(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown };
  return (
    e?.response?.data?.error === "invalid_grant" ||
    (typeof e?.message === "string" && /invalid_grant/.test(e.message))
  );
}

/** HTTP statuses worth retrying: rate limits and transient server errors. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Transient network failures that carry NO HTTP status (the request never got a
 * response) but are still worth retrying — a dropped socket, a timed-out
 * connection, a flaky DNS lookup. Without this, a single `ECONNRESET` mid-sweep
 * (the exact signature seen against flaky upstream infra) fails immediately
 * instead of riding out a blip.
 */
const RETRYABLE_NET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function isRetryableNetworkError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e?.code === "string" && RETRYABLE_NET_CODES.has(e.code)) return true;
  // Some layers surface the reset only in the message (e.g. "socket hang up").
  return typeof e?.message === "string" && /socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(e.message);
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const s of [e?.status, e?.code, e?.response?.status]) {
    if (typeof s === "number") return s;
    // googleapis error shapes vary by version — the status also appears as "429".
    if (typeof s === "string" && /^\d{3}$/.test(s)) return Number(s);
  }
  return undefined;
}

/**
 * True when a 403 is specifically Google's "the access token lacks the required
 * scope" — NOT a genuine permission denial (e.g. a Workspace admin policy). This
 * distinction matters: a scope shortfall is fixed by re-auth, an admin denial is
 * not, so we key only on the scope-specific signals and deliberately do NOT treat
 * the umbrella `PERMISSION_DENIED` status as sufficient on its own. It surfaces
 * when a token granted before `gmail.settings.basic` was added is used for a filter.
 */
export function isInsufficientScope(err: unknown): boolean {
  if (statusOf(err) !== 403) return false;
  const e = err as {
    errors?: { reason?: unknown }[];
    response?: { data?: { error?: { errors?: { reason?: unknown }[] } } };
    message?: unknown;
  };
  // googleapis surfaces the reason array either at the top level (`err.errors`)
  // or nested under `err.response.data.error.errors`, depending on version.
  const reasons = [...(e?.errors ?? []), ...(e?.response?.data?.error?.errors ?? [])];
  return (
    reasons.some((x) => x?.reason === "insufficientPermissions") ||
    (typeof e?.message === "string" &&
      /insufficient (authentication|permission|scope)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(
        e.message,
      ))
  );
}

/** Map mailwarden's FilterCriteria to the API's criteria shape, omitting empty fields. */
export function filterCriteriaToApi(c: FilterCriteria): gmail_v1.Schema$FilterCriteria {
  const out: gmail_v1.Schema$FilterCriteria = {};
  if (c.from) out.from = c.from;
  if (c.to) out.to = c.to;
  if (c.subject) out.subject = c.subject;
  if (c.query) out.query = c.query;
  if (c.negatedQuery) out.negatedQuery = c.negatedQuery;
  if (c.hasAttachment != null) out.hasAttachment = c.hasAttachment;
  if (c.excludeChats != null) out.excludeChats = c.excludeChats;
  if (c.size != null) {
    out.size = c.size;
    out.sizeComparison = c.sizeComparison ?? "larger";
  }
  return out;
}

/** Map the API's criteria shape back to mailwarden's FilterCriteria, omitting empty fields. */
export function filterCriteriaFromApi(c: gmail_v1.Schema$FilterCriteria | undefined): FilterCriteria {
  const out: FilterCriteria = {};
  if (!c) return out;
  if (c.from) out.from = c.from;
  if (c.to) out.to = c.to;
  if (c.subject) out.subject = c.subject;
  if (c.query) out.query = c.query;
  if (c.negatedQuery) out.negatedQuery = c.negatedQuery;
  if (c.hasAttachment != null) out.hasAttachment = c.hasAttachment;
  if (c.excludeChats != null) out.excludeChats = c.excludeChats;
  if (c.size != null) out.size = c.size;
  if (c.sizeComparison === "smaller" || c.sizeComparison === "larger")
    out.sizeComparison = c.sizeComparison;
  return out;
}

/**
 * Translate filter criteria into a Gmail search query, so a newly-created filter
 * can also be applied to mail that already arrived (a filter itself only affects
 * future mail). This is a best-effort mapping onto Gmail's search operators —
 * matching parity with the filter engine is not guaranteed (the search index is
 * looser, same caveat as bulk_modify). `query` is already search syntax and is
 * passed through; the size comparison maps to Gmail's `larger:`/`smaller:` (bytes).
 */
export function filterCriteriaToQuery(c: FilterCriteria): string {
  // Plain values (from/to/subject) are double-quoted so a stray ')' or an operator
  // in the value can't break out of the grouping and broaden the match. Gmail has
  // no quote-escaping, so internal double quotes are stripped. `query`/`negatedQuery`
  // are search syntax by contract and pass through as operator expressions.
  const phrase = (v: string) => `"${v.replace(/"/g, "")}"`;
  const parts: string[] = [];
  if (c.from) parts.push(`from:${phrase(c.from)}`);
  if (c.to) parts.push(`to:${phrase(c.to)}`);
  if (c.subject) parts.push(`subject:${phrase(c.subject)}`);
  if (c.query) parts.push(`(${c.query})`);
  if (c.negatedQuery) parts.push(`-(${c.negatedQuery})`);
  if (c.hasAttachment === true) parts.push("has:attachment");
  else if (c.hasAttachment === false) parts.push("-has:attachment");
  if (c.excludeChats) parts.push("-in:chats");
  if (c.size != null && c.sizeComparison) parts.push(`${c.sizeComparison}:${c.size}`);
  return parts.join(" ");
}

/**
 * Run `fn`, retrying 429/5xx responses with exponential backoff + jitter.
 * Anything else (4xx, network errors, non-HTTP failures) is thrown immediately.
 * `sleep` is injectable so tests don't have to wait real time.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const retryable =
        (status !== undefined && RETRYABLE_STATUS.has(status)) || isRetryableNetworkError(err);
      if (attempt >= retries || !retryable) throw err;
      await sleep(baseMs * 2 ** attempt + Math.random() * 100);
    }
  }
}

/** Read a part header value (case-insensitive name match). */
function partHeader(p: gmail_v1.Schema$MessagePart, name: string): string | undefined {
  return p.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

/** Normalize a Content-ID header value: strip surrounding `<>`, trim, lowercase. */
function normalizeCid(v?: string): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return s || undefined;
}

/**
 * Collect every Content-ID actually referenced as `cid:<id>` in the message
 * bodies (html / plain text). Only a *referenced* Content-ID marks a part as a
 * genuinely inline asset (logo, tracking pixel). An unreferenced Content-ID is
 * not inline — some mailers tag real attachments with one (e.g. maut1 invoices
 * carry the PDF with a Content-ID but no `Content-Disposition`).
 */
export function referencedCids(...bodies: string[]): Set<string> {
  const ids = new Set<string>();
  const re = /cid:([^"'\s)>\]]+)/gi;
  const hay = bodies.join("\n");
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay)) !== null) ids.add(m[1].trim().toLowerCase());
  return ids;
}

/** Walk every nested MIME part of a payload, applying `fn`. */
function walkParts(
  p: gmail_v1.Schema$MessagePart | undefined,
  fn: (p: gmail_v1.Schema$MessagePart) => void,
): void {
  if (!p) return;
  fn(p);
  (p.parts ?? []).forEach((child) => walkParts(child, fn));
}

/**
 * True when a part carries a downloadable file rather than an inline asset
 * (logo / tracking pixel). A real attachment needs a filename + attachmentId.
 *
 * Disposition decides when explicit: `attachment` → keep, `inline` → drop.
 * When the part has no `Content-Disposition` header (common — many mailers omit
 * it), it counts as inline ONLY if its `Content-ID` is actually referenced via
 * `cid:<id>` in the message body (`refCids`). An unreferenced Content-ID — or no
 * Content-ID at all — means a real attachment. This is why maut1 invoice PDFs
 * (Content-ID present, never referenced, no disposition) were previously, and
 * wrongly, dropped.
 *
 * `refCids` defaults to empty for isolated/unit use; callers that have the
 * message body (collectAttachments) pass the real referenced-cid set.
 */
export function isRealAttachment(
  p: gmail_v1.Schema$MessagePart,
  refCids: Set<string> = new Set(),
): boolean {
  if (!p.filename || !p.body?.attachmentId) return false;
  const disposition = partHeader(p, "Content-Disposition")?.trim().toLowerCase();
  if (disposition?.startsWith("attachment")) return true;
  if (disposition?.startsWith("inline")) return false;
  // No explicit disposition → inline only if its Content-ID is referenced in the body.
  const cid = normalizeCid(partHeader(p, "Content-ID"));
  if (cid && refCids.has(cid)) return false;
  return true;
}

/** Charset of a part, from the `charset=` parameter of its Content-Type header. */
function partCharset(p: gmail_v1.Schema$MessagePart): string {
  const ct = partHeader(p, "Content-Type");
  const m = ct ? /charset\s*=\s*"?([\w.:-]+)"?/i.exec(ct) : null;
  return m?.[1] ?? "utf-8";
}

/** Decode + concatenate the text/plain and text/html bodies of a message payload. */
export function collectBodies(payload?: gmail_v1.Schema$MessagePart): { text: string; html: string } {
  let text = "";
  let html = "";
  // `body.data` holds the part's raw bytes in its declared charset — decoding
  // everything as UTF-8 turns ISO-8859-1 / windows-1252 mail into mojibake.
  const decode = (p: gmail_v1.Schema$MessagePart): string => {
    const d = p.body?.data;
    if (!d) return "";
    const buf = Buffer.from(d, "base64url");
    try {
      return new TextDecoder(partCharset(p)).decode(buf);
    } catch {
      return buf.toString("utf8"); // unknown charset label → best-effort UTF-8
    }
  };
  walkParts(payload, (p) => {
    if (p.mimeType === "text/plain") text += decode(p);
    else if (p.mimeType === "text/html") html += decode(p);
  });
  return { text, html };
}

/** Collect the real (non-inline) attachments of a message. */
export function collectAttachments(m: gmail_v1.Schema$Message): Attachment[] {
  const { text, html } = collectBodies(m.payload ?? undefined);
  const refCids = referencedCids(html, text);
  const out: Attachment[] = [];
  walkParts(m.payload ?? undefined, (p) => {
    if (isRealAttachment(p, refCids)) {
      out.push({
        messageId: m.id!,
        attachmentId: p.body!.attachmentId!,
        filename: p.filename!,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body?.size ?? 0,
      });
    }
  });
  return out;
}

/** Triage signals of one message: its headers plus a flat list of its MIME parts. */
export function messageSignals(m: gmail_v1.Schema$Message | undefined): Signal[] {
  if (!m) return [];
  const parts: { mimeType?: string | null; filename?: string | null }[] = [];
  walkParts(m.payload ?? undefined, (p) => parts.push({ mimeType: p.mimeType, filename: p.filename }));
  return deriveSignals({ headers: m.payload?.headers ?? [], parts });
}

/** Parse a raw Gmail message into the flat ParsedMessage shape. */
export function parseMessage(m: gmail_v1.Schema$Message): ParsedMessage {
  const headers = m.payload?.headers ?? [];
  const raw = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
  const h = (n: string) => decodeRfc2047(raw(n));
  const { text, html } = collectBodies(m.payload ?? undefined);
  return {
    id: m.id!,
    threadId: m.threadId!,
    labelIds: m.labelIds ?? [],
    from: decodeAddressHeader(raw("From")),
    to: h("To"),
    subject: h("Subject"),
    date: h("Date"),
    snippet: m.snippet ?? "",
    plaintextBody: text,
    htmlBody: html,
    attachments: collectAttachments(m),
  };
}

/** System-label ids and `Label_*` ids pass through modifyLabels unresolved. */
const SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "TRASH",
  "SPAM",
  "IMPORTANT",
  "SENT",
  "DRAFT",
]);

/** True when a string is already a Gmail label *id* (vs. a human-readable name). */
export function looksLikeLabelId(s: string): boolean {
  return SYSTEM_LABEL_IDS.has(s) || s.startsWith("CATEGORY_") || /^Label_/.test(s);
}

/** `category:` query values → their Gmail label id. `primary` is `CATEGORY_PERSONAL`. */
const CATEGORY_IDS: Record<string, string> = {
  primary: "CATEGORY_PERSONAL",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

/** A single label predicate to re-verify against a thread's live labels. */
export interface LabelFilter {
  labelId: string;
  /** true = thread must carry this label; false = must NOT carry it. */
  present: boolean;
}

/**
 * Derive label predicates from a Gmail query so search hits can be re-checked
 * against each thread's *live* labels.
 *
 * Why: Gmail's `threads.list` search index is sometimes loose for read-state
 * operators — notably `is:unread` is silently dropped in some operator
 * combinations (e.g. `category:updates is:unread -in:inbox`), so the index
 * returns read mail too. Because `search()` already fetches every hit live, we
 * can drop those false positives by comparing the predicates that map 1:1 to a
 * system/category label.
 *
 * Only unambiguous predicates are translated. Anything else (free text,
 * `label:NAME`, `from:`, `newer_than:`, …) yields no filter for that token, and
 * an `OR` / parenthesised / braced / quoted query disables filtering entirely —
 * so the raw index result always passes through unchanged. We only ever ADD
 * precision, never drop a thread the user's boolean logic meant to keep.
 */
export function deriveLabelFilters(query: string): LabelFilter[] {
  // Boolean grouping makes a flat AND post-filter unsafe → don't filter at all.
  // Quotes too: the whitespace tokenizer below would read a literal `is:unread`
  // inside a quoted phrase as a predicate and wrongly drop read hits.
  if (/\bOR\b|["(){}]/.test(query)) return [];

  const filters: LabelFilter[] = [];
  const add = (labelId: string, present: boolean) => filters.push({ labelId, present });

  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    const neg = raw.startsWith("-");
    const tok = (neg ? raw.slice(1) : raw).toLowerCase();
    switch (tok) {
      case "is:unread": add("UNREAD", !neg); break;
      case "is:read": add("UNREAD", neg); break;
      case "is:starred": add("STARRED", !neg); break;
      case "is:unstarred": add("STARRED", neg); break;
      case "is:important": add("IMPORTANT", !neg); break;
      case "is:unimportant": add("IMPORTANT", neg); break;
      case "in:inbox": add("INBOX", !neg); break;
      case "in:trash": add("TRASH", !neg); break;
      case "in:spam": add("SPAM", !neg); break;
      default: {
        const cat = /^category:(\w+)$/.exec(tok);
        if (cat && CATEGORY_IDS[cat[1]]) add(CATEGORY_IDS[cat[1]], !neg);
      }
    }
  }
  return filters;
}

/** True when a thread's (union) live labels satisfy every derived predicate. */
export function threadMatchesFilters(labelIds: string[], filters: LabelFilter[]): boolean {
  return filters.every((f) => labelIds.includes(f.labelId) === f.present);
}

/** Upper bound on candidate threads scanned when re-verifying labels. */
const FILTER_SCAN_CAP = 100;

/** Max concurrent threads.get calls while resolving search candidates. */
const GET_CONCURRENCY = 8;

export interface SearchResult {
  threads: ThreadSummary[];
  /** Present when more results exist — pass back to `search` to fetch the next page. */
  nextPageToken?: string;
}

/** Thin wrapper over the native Gmail API. Every call is live — no cache. */
export class Gmail {
  private api: gmail_v1.Gmail;

  /**
   * Pass an OAuth2 client (normal runtime) or a ready-made gmail_v1.Gmail
   * (tests / injection). The auth-client signature stays backward compatible.
   */
  constructor(authOrApi: OAuth2Client | gmail_v1.Gmail) {
    this.api = isGmailApi(authOrApi)
      ? authOrApi
      : google.gmail({ version: "v1", auth: authOrApi });
  }

  /** Every API call goes through here: 429/5xx are retried with backoff. */
  private async req<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withBackoff(fn);
    } catch (err) {
      // Turn a dead/revoked refresh token into an actionable message instead of
      // a cryptic OAuth error on the first Gmail call.
      if (isInvalidGrant(err)) {
        throw new CliError(
          "mailwarden's saved authorization has expired or been revoked. Run `mailwarden --auth` to re-authorize.",
        );
      }
      // A token authorized before the settings scope was added can't manage
      // filters — tell the user exactly which scope is missing and how to fix it,
      // rather than surfacing a raw 403 "insufficient authentication scopes".
      if (isInsufficientScope(err)) {
        throw new CliError(
          "mailwarden's saved authorization is missing a Gmail scope this operation needs. " +
            "Filter management (list_filters/create_filter/delete_filter) needs 'gmail.settings.basic'; " +
            "a write action (label/archive/trash/snooze/sweep) needs 'gmail.modify', which a read-only grant lacks. " +
            "Re-run `mailwarden --auth` with the tiers you need enabled (MAILWARDEN_TOOLS), then retry.",
        );
      }
      throw err;
    }
  }

  async search(query: string, maxResults = 25, pageToken?: string): Promise<SearchResult> {
    // Re-verify read-state/category predicates against live labels (the index is
    // loose for `is:unread` & co). When filtering, the index may return false
    // positives, so scan a full page of candidates and stop once enough genuinely
    // match — keeping `maxResults` meaningful instead of silently short.
    const filters = deriveLabelFilters(query);
    const scanCap = filters.length ? FILTER_SCAN_CAP : maxResults;

    // A single list page may return fewer threads than requested even when more
    // exist — follow pageTokens until the scan cap is reached or pages run out.
    const candidates: gmail_v1.Schema$Thread[] = [];
    let nextToken: string | undefined = pageToken;
    do {
      const token = nextToken;
      const list = await this.req(() =>
        this.api.users.threads.list({
          userId: "me",
          q: query,
          maxResults: scanCap - candidates.length,
          ...(token ? { pageToken: token } : {}),
        }),
      );
      candidates.push(...(list.data.threads ?? []));
      nextToken = list.data.nextPageToken ?? undefined;
    } while (nextToken && candidates.length < scanCap);

    // 'full' (not 'metadata') so the MIME parts are present — otherwise attachment
    // detection always returns false (metadata format omits payload.parts). The
    // gets run in small parallel chunks; the early break past maxResults can
    // overshoot by at most one chunk.
    const out: ThreadSummary[] = [];
    for (let i = 0; i < candidates.length && out.length < maxResults; i += GET_CONCURRENCY) {
      const chunk = candidates.slice(i, i + GET_CONCURRENCY);
      // A single hit that vanished between the list and this get (deleted/moved —
      // e.g. by another client or an auto-trashing filter) must not sink the whole
      // search: the list call already proved auth works, so a per-thread failure is
      // local. Swallow it and drop that one candidate. (`threads.list` above is NOT
      // wrapped this way, so a systemic auth/network failure still surfaces.)
      const metas = await Promise.all(
        chunk.map((t) =>
          this.req(() => this.api.users.threads.get({ userId: "me", id: t.id!, format: "full" }))
            .catch(() => null),
        ),
      );
      for (let j = 0; j < chunk.length && out.length < maxResults; j++) {
        const meta = metas[j];
        if (!meta) continue; // thread vanished or errored after retries — skip it
        const t = chunk[j];
        const msgs = meta.data.messages ?? [];
        const labelIds = [...new Set(msgs.flatMap((m) => m.labelIds ?? []))];
        if (!threadMatchesFilters(labelIds, filters)) continue; // drop index false positives
        const headers = msgs[0]?.payload?.headers ?? [];
        const raw = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
        const h = (n: string) => decodeRfc2047(raw(n));
        out.push({
          threadId: t.id!,
          messageCount: msgs.length,
          from: decodeAddressHeader(raw("From")),
          subject: h("Subject"),
          date: h("Date"),
          labelIds,
          snippet: t.snippet ?? msgs[0]?.snippet ?? "",
          hasAttachments: msgs.some((m) => collectAttachments(m).length > 0),
          signals: messageSignals(msgs[0]),
        });
      }
    }
    // The token resumes AFTER the last list page fetched. Exact for unfiltered
    // queries (scanCap == maxResults, every candidate is consumed). With active
    // filters the scan window (FILTER_SCAN_CAP) may hold more true matches than
    // maxResults — resuming then skips those between-window threads. Documented
    // approximation; narrow the query or raise maxResults for exhaustive sweeps.
    return { threads: out, ...(nextToken ? { nextPageToken: nextToken } : {}) };
  }

  /**
   * All thread ids currently carrying a label. Filters via the exact `labelIds`
   * parameter — not the search index, which can lag behind recent label changes —
   * and needs only cheap list pages, no per-thread fetch.
   */
  async listThreadIdsByLabel(labelId: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const res = await this.req(() =>
        this.api.users.threads.list({
          userId: "me",
          labelIds: [labelId],
          maxResults: 100,
          ...(token ? { pageToken: token } : {}),
        }),
      );
      for (const t of res.data.threads ?? []) ids.push(t.id!);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  /** Subject of a thread's first message, via a metadata-only fetch. */
  async getThreadSubject(threadId: string): Promise<string> {
    const res = await this.req(() =>
      this.api.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["Subject"],
      }),
    );
    const headers = res.data.messages?.[0]?.payload?.headers ?? [];
    return decodeRfc2047(headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "");
  }

  /**
   * The List-Unsubscribe headers of a thread's most recent message that actually
   * carries one, via a metadata-only fetch. Newest-first because opt-out endpoints
   * are per-mailing and older ones may already be dead — but skipping messages
   * without the header matters: a reply you sent sits at the end of the thread and
   * advertises nothing, which would otherwise read as "this list has no opt-out".
   * With no such message anywhere, the newest one is used so From/Subject still
   * describe the thread.
   */
  async getUnsubscribeHeaders(threadId: string): Promise<UnsubscribeHeaders> {
    const res = await this.req(() =>
      this.api.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject"],
      }),
    );
    const messages = res.data.messages ?? [];
    if (!messages.length) throw new Error(`Thread ${threadId} has no messages.`);
    const headerOf = (m: gmail_v1.Schema$Message, n: string) =>
      m.payload?.headers?.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
    // Newest first, preferring one that advertises an opt-out at all.
    const last =
      [...messages].reverse().find((m) => headerOf(m, "List-Unsubscribe").trim() !== "") ??
      messages[messages.length - 1];
    // Raw for the two List-* headers: they carry URIs, not RFC 2047 encoded words.
    const raw = (n: string) => headerOf(last, n);
    return {
      messageId: last.id!,
      from: decodeAddressHeader(raw("From")),
      subject: decodeRfc2047(raw("Subject")),
      listUnsubscribe: raw("List-Unsubscribe"),
      listUnsubscribePost: raw("List-Unsubscribe-Post"),
    };
  }

  async getThread(threadId: string, full = true): Promise<{ threadId: string; messages: ParsedMessage[] }> {
    const res = await this.req(() =>
      this.api.users.threads.get({
        userId: "me",
        id: threadId,
        format: full ? "full" : "metadata",
      }),
    );
    return { threadId, messages: (res.data.messages ?? []).map((m) => parseMessage(m)) };
  }

  /**
   * Add/remove labels on a thread. Accepts label *ids* (INBOX, Label_7, …) or
   * human-readable *names* ("ToDo", "MCP/Snoozed"). Names are resolved to ids via
   * listLabels(); an unknown name in `add` is created (ensureLabel), an unknown
   * name in `remove` is skipped. listLabels() is only fetched when a non-id
   * string is present.
   */
  async modifyLabels(threadId: string, add: string[] = [], remove: string[] = []): Promise<void> {
    const { addLabelIds, removeLabelIds } = await this.resolveLabelIds(add, remove);
    await this.req(() =>
      this.api.users.threads.modify({
        userId: "me",
        id: threadId,
        requestBody: { addLabelIds, removeLabelIds },
      }),
    );
  }

  /**
   * Which of `names` a modify call's `add` would have to CREATE — label names (not ids)
   * that don't exist yet, case-insensitively, as resolveLabelIds decides it. Read-only:
   * this is the dry-run counterpart of the auto-create, so a rehearsal can say "would
   * create label X" without creating it. Order and duplicates as given.
   */
  async unknownLabelNames(names: string[]): Promise<string[]> {
    const candidates = names.filter((s) => !looksLikeLabelId(s));
    if (candidates.length === 0) return [];
    const existing = new Set((await this.listLabels()).map((l) => l.name.toLowerCase()));
    return candidates.filter((s) => !existing.has(s.toLowerCase()));
  }

  /** Resolve label ids/names for modify calls (names created in `add`, skipped in `remove`). */
  private async resolveLabelIds(
    add: string[],
    remove: string[],
  ): Promise<{ addLabelIds: string[]; removeLabelIds: string[] }> {
    const needsLookup = [...add, ...remove].some((s) => !looksLikeLabelId(s));
    // Keyed lowercase: Gmail label names are unique case-insensitively, and a
    // case-sensitive miss would send `add` into ensureLabel, whose create the
    // API then rejects as a name conflict.
    const byName = new Map<string, string>();
    if (needsLookup) {
      for (const l of await this.listLabels()) byName.set(l.name.toLowerCase(), l.id);
    }

    const addLabelIds: string[] = [];
    for (const s of add) {
      if (looksLikeLabelId(s)) addLabelIds.push(s);
      else addLabelIds.push(byName.get(s.toLowerCase()) ?? (await this.ensureLabel(s)));
    }

    const removeLabelIds: string[] = [];
    for (const s of remove) {
      if (looksLikeLabelId(s)) removeLabelIds.push(s);
      else {
        const id = byName.get(s.toLowerCase());
        if (id) removeLabelIds.push(id); // unknown name → nothing to remove, skip
      }
    }
    return { addLabelIds, removeLabelIds };
  }

  /**
   * Message refs matching a query and/or label filter, paginated up to `max`.
   * Cheap: one list page covers up to 500 messages, no per-message fetch.
   */
  async listMessageRefs(
    opts: { query?: string; labelIds?: string[]; max?: number } = {},
  ): Promise<MessageRef[]> {
    const max = opts.max ?? 1000;
    const refs: MessageRef[] = [];
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const res = await this.req(() =>
        this.api.users.messages.list({
          userId: "me",
          ...(opts.query ? { q: opts.query } : {}),
          ...(opts.labelIds?.length ? { labelIds: opts.labelIds } : {}),
          maxResults: Math.min(500, max - refs.length),
          ...(token ? { pageToken: token } : {}),
        }),
      );
      for (const m of res.data.messages ?? []) refs.push({ id: m.id!, threadId: m.threadId! });
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && refs.length < max);
    return refs;
  }

  /** Max ids per messages.batchModify request (Gmail API limit). */
  static readonly BATCH_MODIFY_CHUNK = 1000;

  /**
   * Batch label changes via `messages.batchModify` — one request per 1000
   * messages instead of one modify per thread. A failed chunk is reported in
   * `failed` and does NOT abort the remaining chunks (partial success).
   */
  async batchModifyMessages(
    refs: MessageRef[],
    add: string[] = [],
    remove: string[] = [],
  ): Promise<BatchModifyResult> {
    const { addLabelIds, removeLabelIds } = await this.resolveLabelIds(add, remove);
    const modifiedThreads = new Set<string>();
    let modifiedMessages = 0;
    const failed: BatchModifyResult["failed"] = [];
    for (let i = 0; i < refs.length; i += Gmail.BATCH_MODIFY_CHUNK) {
      const chunk = refs.slice(i, i + Gmail.BATCH_MODIFY_CHUNK);
      try {
        await this.req(() =>
          this.api.users.messages.batchModify({
            userId: "me",
            requestBody: { ids: chunk.map((r) => r.id), addLabelIds, removeLabelIds },
          }),
        );
        modifiedMessages += chunk.length;
        for (const r of chunk) modifiedThreads.add(r.threadId);
      } catch (err) {
        failed.push({
          messageIds: chunk.map((r) => r.id),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { modifiedMessages, modifiedThreads: [...modifiedThreads], failed };
  }

  async trash(threadId: string): Promise<void> {
    await this.req(() => this.api.users.threads.trash({ userId: "me", id: threadId }));
  }

  async untrash(threadId: string): Promise<void> {
    await this.req(() => this.api.users.threads.untrash({ userId: "me", id: threadId }));
  }

  /**
   * The authorized account's identity + mailbox totals — a cheap authenticated call,
   * doubling as the post-auth smoke test (callers that only need the address destructure it).
   * historyId is deliberately NOT surfaced: it is the incremental-sync cursor, and syncing
   * is a hard non-goal (every call stays live against the API).
   */
  async getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
  }> {
    const res = await this.req(() => this.api.users.getProfile({ userId: "me" }));
    return {
      emailAddress: res.data.emailAddress ?? "",
      messagesTotal: res.data.messagesTotal ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
    };
  }

  async listLabels(): Promise<LabelInfo[]> {
    const res = await this.req(() => this.api.users.labels.list({ userId: "me" }));
    return (res.data.labels ?? []).map((l) => ({ id: l.id!, name: l.name!, type: l.type }));
  }

  /** Returns the id of an existing label by name, creating it (and any parent path) if missing. */
  async ensureLabel(name: string): Promise<string> {
    const existing = (await this.listLabels()).find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing.id;
    const res = await this.req(() =>
      this.api.users.labels.create({
        userId: "me",
        requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      }),
    );
    return res.data.id!;
  }

  async deleteLabel(id: string): Promise<void> {
    await this.req(() => this.api.users.labels.delete({ userId: "me", id }));
  }

  async listFilters(): Promise<FilterSummary[]> {
    const res = await this.req(() => this.api.users.settings.filters.list({ userId: "me" }));
    return (res.data.filter ?? []).map((f) => {
      const a = f.action ?? {};
      return {
        id: f.id!,
        criteria: filterCriteriaFromApi(f.criteria ?? undefined),
        addLabelIds: a.addLabelIds ?? [],
        removeLabelIds: a.removeLabelIds ?? [],
        ...(a.forward ? { forward: a.forward } : {}),
      };
    });
  }

  /**
   * Create a filter with label actions only. Label names in the actions are
   * resolved (and unknown names in `addLabels` auto-created) exactly as
   * modify_labels does. The `forward` action is intentionally unsupported — a
   * forwarding filter is a send/exfiltration path, which this server does not offer.
   */
  async createFilter(
    criteria: FilterCriteria,
    action: { addLabels?: string[]; removeLabels?: string[] },
  ): Promise<FilterSummary> {
    // Guard with the SAME mapping the request uses, so the "is it empty?" question
    // can't be answered one way here and another way when the body is built (an
    // empty-string field, e.g. from:"", is dropped by filterCriteriaToApi and would
    // otherwise reach Gmail as empty criteria → a cryptic 400).
    const apiCriteria = filterCriteriaToApi(criteria);
    if (Object.keys(apiCriteria).length === 0) {
      throw new Error(
        "create_filter has no usable match criteria — provide at least one of " +
          "from/to/subject/query/negatedQuery/hasAttachment/size.",
      );
    }
    const { addLabelIds, removeLabelIds } = await this.resolveLabelIds(
      action.addLabels ?? [],
      action.removeLabels ?? [],
    );
    // An unknown name in removeLabels is dropped (nothing to remove), so the input
    // action count can be non-zero yet the EFFECTIVE action set empty — Gmail rejects
    // an action-less filter. Catch it here with a name-pointing message.
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      throw new Error(
        "create_filter resolved to no label action: addLabels was empty and the names in " +
          "removeLabels don't exist (nothing to remove). Check the label names with list_labels.",
      );
    }
    const res = await this.req(() =>
      this.api.users.settings.filters.create({
        userId: "me",
        requestBody: {
          criteria: apiCriteria,
          action: { addLabelIds, removeLabelIds },
        },
      }),
    );
    const a = res.data.action ?? {};
    return {
      id: res.data.id!,
      criteria: filterCriteriaFromApi(res.data.criteria ?? undefined),
      addLabelIds: a.addLabelIds ?? addLabelIds,
      removeLabelIds: a.removeLabelIds ?? removeLabelIds,
    };
  }

  async deleteFilter(id: string): Promise<void> {
    await this.req(() => this.api.users.settings.filters.delete({ userId: "me", id }));
  }

  async downloadAttachment(messageId: string, attachmentId: string, destPath: string): Promise<string> {
    // destPath is MCP-client-controlled. With MAILWARDEN_DOWNLOAD_DIR set,
    // relative paths resolve inside it and the result must stay inside it —
    // without the fence, an HTTP-hosted deployment would hand every client an
    // arbitrary file write on the server.
    const root = process.env.MAILWARDEN_DOWNLOAD_DIR;
    let dest: string;
    if (root) {
      await fs.mkdir(root, { recursive: true });
      // realpath-canonicalize the fence so `..`/symlinks in the ROOT itself
      // can't shift the boundary. Containment is checked as a relative path —
      // against the root as configured AND its canonical form, so an absolute
      // destPath under either spelling passes (e.g. /tmp/dl/x when /tmp is a
      // symlink to /private/tmp) while anything outside both is rejected.
      const givenRoot = path.resolve(root);
      const fence = await fs.realpath(root);
      const escapes = (rel: string) => rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
      let rel = path.relative(givenRoot, path.resolve(givenRoot, destPath));
      if (escapes(rel)) rel = path.relative(fence, path.resolve(fence, destPath));
      if (escapes(rel)) {
        throw new Error(`destPath escapes MAILWARDEN_DOWNLOAD_DIR (${fence}).`);
      }
      dest = path.join(fence, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // …and again against the REAL parent directory: a symlinked subdirectory
      // inside the fence pointing outside would pass the lexical check above.
      const realDir = await fs.realpath(path.dirname(dest));
      if (realDir !== fence && !realDir.startsWith(fence + path.sep)) {
        throw new Error(`destPath escapes MAILWARDEN_DOWNLOAD_DIR via a symlink (${fence}).`);
      }
      dest = path.join(realDir, path.basename(dest));
    } else {
      dest = path.resolve(destPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
    }
    const res = await this.req(() =>
      this.api.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId }),
    );
    if (!res.data.data) throw new Error("Attachment has no data.");
    return writeUnique(dest, Buffer.from(res.data.data, "base64url"));
  }
}

/**
 * Write `buf` to `dest` without ever overwriting: `wx` fails on any existing
 * file (or symlink — so a planted link can't redirect the write either), and a
 * collision falls back to `name-1.ext`, `name-2.ext`, … Returns the path used.
 */
async function writeUnique(dest: string, buf: Buffer): Promise<string> {
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? dest : path.join(dir, `${stem}-${i}${ext}`);
    try {
      await fs.writeFile(candidate, buf, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`No free filename for ${dest} after 100 attempts.`);
}

/** Heuristic: a ready-made gmail_v1.Gmail exposes a `users` resource; an OAuth2Client doesn't. */
function isGmailApi(x: OAuth2Client | gmail_v1.Gmail): x is gmail_v1.Gmail {
  return typeof (x as gmail_v1.Gmail).users === "object" && (x as gmail_v1.Gmail).users !== null;
}

import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import path from "node:path";

export interface ThreadSummary {
  threadId: string;
  messageCount: number;
  from: string;
  subject: string;
  date: string;
  labelIds: string[];
  snippet: string;
  hasAttachments: boolean;
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

// ---------------------------------------------------------------------------
// Pure helpers (exported & API-free so they're unit-testable without a mock).
// The Gmail class methods are thin wrappers around these.
// ---------------------------------------------------------------------------

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

/** Parse a raw Gmail message into the flat ParsedMessage shape. */
export function parseMessage(m: gmail_v1.Schema$Message): ParsedMessage {
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
  const { text, html } = collectBodies(m.payload ?? undefined);
  return {
    id: m.id!,
    threadId: m.threadId!,
    labelIds: m.labelIds ?? [],
    from: h("From"),
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

  async search(query: string, maxResults = 25): Promise<ThreadSummary[]> {
    // Re-verify read-state/category predicates against live labels (the index is
    // loose for `is:unread` & co). When filtering, the index may return false
    // positives, so scan a full page of candidates and stop once enough genuinely
    // match — keeping `maxResults` meaningful instead of silently short.
    const filters = deriveLabelFilters(query);
    const scanCap = filters.length ? FILTER_SCAN_CAP : maxResults;

    // A single list page may return fewer threads than requested even when more
    // exist — follow pageTokens until the scan cap is reached or pages run out.
    const candidates: gmail_v1.Schema$Thread[] = [];
    let pageToken: string | undefined;
    do {
      const list = await this.api.users.threads.list({
        userId: "me",
        q: query,
        maxResults: scanCap - candidates.length,
        ...(pageToken ? { pageToken } : {}),
      });
      candidates.push(...(list.data.threads ?? []));
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken && candidates.length < scanCap);

    // 'full' (not 'metadata') so the MIME parts are present — otherwise attachment
    // detection always returns false (metadata format omits payload.parts). The
    // gets run in small parallel chunks; the early break past maxResults can
    // overshoot by at most one chunk.
    const out: ThreadSummary[] = [];
    for (let i = 0; i < candidates.length && out.length < maxResults; i += GET_CONCURRENCY) {
      const chunk = candidates.slice(i, i + GET_CONCURRENCY);
      const metas = await Promise.all(
        chunk.map((t) => this.api.users.threads.get({ userId: "me", id: t.id!, format: "full" })),
      );
      for (let j = 0; j < chunk.length && out.length < maxResults; j++) {
        const t = chunk[j];
        const msgs = metas[j].data.messages ?? [];
        const labelIds = [...new Set(msgs.flatMap((m) => m.labelIds ?? []))];
        if (!threadMatchesFilters(labelIds, filters)) continue; // drop index false positives
        const headers = msgs[0]?.payload?.headers ?? [];
        const h = (n: string) =>
          headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
        out.push({
          threadId: t.id!,
          messageCount: msgs.length,
          from: h("From"),
          subject: h("Subject"),
          date: h("Date"),
          labelIds,
          snippet: t.snippet ?? msgs[0]?.snippet ?? "",
          hasAttachments: msgs.some((m) => collectAttachments(m).length > 0),
        });
      }
    }
    return out;
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
      const res = await this.api.users.threads.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const t of res.data.threads ?? []) ids.push(t.id!);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  /** Subject of a thread's first message, via a metadata-only fetch. */
  async getThreadSubject(threadId: string): Promise<string> {
    const res = await this.api.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["Subject"],
    });
    const headers = res.data.messages?.[0]?.payload?.headers ?? [];
    return headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
  }

  async getThread(threadId: string, full = true): Promise<{ threadId: string; messages: ParsedMessage[] }> {
    const res = await this.api.users.threads.get({
      userId: "me",
      id: threadId,
      format: full ? "full" : "metadata",
    });
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

    await this.api.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: { addLabelIds, removeLabelIds },
    });
  }

  async trash(threadId: string): Promise<void> {
    await this.api.users.threads.trash({ userId: "me", id: threadId });
  }

  async untrash(threadId: string): Promise<void> {
    await this.api.users.threads.untrash({ userId: "me", id: threadId });
  }

  async listLabels(): Promise<LabelInfo[]> {
    const res = await this.api.users.labels.list({ userId: "me" });
    return (res.data.labels ?? []).map((l) => ({ id: l.id!, name: l.name!, type: l.type }));
  }

  /** Returns the id of an existing label by name, creating it (and any parent path) if missing. */
  async ensureLabel(name: string): Promise<string> {
    const existing = (await this.listLabels()).find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing.id;
    const res = await this.api.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return res.data.id!;
  }

  async deleteLabel(id: string): Promise<void> {
    await this.api.users.labels.delete({ userId: "me", id });
  }

  async downloadAttachment(messageId: string, attachmentId: string, destPath: string): Promise<string> {
    // destPath is MCP-client-controlled. With MAILWARDEN_DOWNLOAD_DIR set,
    // relative paths resolve inside it and the result must stay inside it —
    // without the fence, an HTTP-hosted deployment would hand every client an
    // arbitrary file write on the server.
    const root = process.env.MAILWARDEN_DOWNLOAD_DIR;
    const dest = root ? path.resolve(root, destPath) : path.resolve(destPath);
    if (root) {
      const fence = path.resolve(root);
      if (dest !== fence && !dest.startsWith(fence + path.sep)) {
        throw new Error(`destPath escapes MAILWARDEN_DOWNLOAD_DIR (${fence}).`);
      }
    }
    const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    if (!res.data.data) throw new Error("Attachment has no data.");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(res.data.data, "base64url"));
    return dest;
  }
}

/** Heuristic: a ready-made gmail_v1.Gmail exposes a `users` resource; an OAuth2Client doesn't. */
function isGmailApi(x: OAuth2Client | gmail_v1.Gmail): x is gmail_v1.Gmail {
  return typeof (x as gmail_v1.Gmail).users === "object" && (x as gmail_v1.Gmail).users !== null;
}

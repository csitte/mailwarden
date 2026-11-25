/**
 * A Gmail API over the demo mailbox, in memory: the object `--demo` hands the `Gmail` class in
 * place of Google's client, so every tool runs its real code path against fictional mail.
 *
 * It implements exactly the endpoints mailwarden calls (the ones `src/egress.ts` allows, plus the
 * drafts ones the drafts tier adds) and nothing else — there is no send, import or insert here to
 * reach, and no network: an answer is built from the state below and nothing else. Changes the
 * tools make (labels, archive, trash, drafts, filters) change that state and are gone when the
 * process ends.
 *
 * What it imitates, because the tools depend on it: Gmail's response shapes for `threads.get` in
 * `minimal`, `metadata` and `full`; trash and spam left out of a search unless the query names
 * them; a 404 for an unknown id and a 409 for a label name that exists; `history.list` records for
 * every change; and the thread-level read-state drift of `threads.list` for the threads the
 * mailbox marks `staleUnread` — the reason `search` re-verifies. What it does not: Gmail's ranking,
 * word-boundary matching, or quotas.
 */
import type { gmail_v1 } from "@googleapis/gmail";
import { asksForTrashOrSpam, matchesQuery, type QueryContext, type Searchable } from "./demo-query.js";
import { demoMailboxSpec, type DemoMailboxSpec } from "./demo-mailbox.js";
import type { UnsubscribeDeps } from "./unsubscribe.js";

type Header = { name: string; value: string };

interface StoredAttachment {
  id: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: Header[];
  text?: string;
  html?: string;
  attachments: StoredAttachment[];
}

interface StoredLabel {
  id: string;
  name: string;
  type: "system" | "user";
  color?: { textColor?: string; backgroundColor?: string };
}

interface HistoryEntry {
  id: number;
  messagesAdded?: string[];
  labelsAdded?: { messageId: string; labelIds: string[] }[];
  labelsRemoved?: { messageId: string; labelIds: string[] }[];
}

const SYSTEM_LABELS = [
  "INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];

/** The first history id; anything before it is history Gmail "no longer holds". */
const FIRST_HISTORY_ID = 400_000;

/** An error shaped like the ones googleapis throws, so `statusOf` and the classifier read it. */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    status,
    response: { status, data: { error: { code: status, message } } },
  });
}

const b64url = (b: Buffer) => b.toString("base64url");
const header = (m: { headers: Header[] }, name: string) =>
  m.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function rfc2822(ms: number): string {
  // "Tue, 24 Nov 2026 10:00:00 +0000" — what a Date header looks like.
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
}

function snippetOf(m: StoredMessage): string {
  const body = m.text ?? (m.html ? stripTags(m.html) : "");
  return body.replace(/\s+/g, " ").trim().slice(0, 140);
}

function sizeOf(m: StoredMessage): number {
  const headers = m.headers.reduce((n, h) => n + h.name.length + h.value.length + 4, 0);
  const parts = Buffer.byteLength(m.text ?? "") + Buffer.byteLength(m.html ?? "");
  return headers + parts + m.attachments.reduce((n, a) => n + Math.ceil((a.data.length * 4) / 3), 0);
}

// ---- MIME, for drafts: the raw message create_draft builds, read back into the same shape ------

function unfoldHeaders(block: string): Header[] {
  const out: Header[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].value += " " + line.trim();
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  return out;
}

function decodeBody(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (enc === "quoted-printable") {
    const soft = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
        bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(soft[i], "utf8"));
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, "utf8");
}

function param(value: string, name: string): string | undefined {
  const ext = new RegExp(`${name}\\*=(?:UTF-8|utf-8)''([^;]+)`).exec(value);
  if (ext) {
    try {
      return decodeURIComponent(ext[1]);
    } catch {
      return ext[1]; // a broken percent sequence: the name as written
    }
  }
  const m = new RegExp(`${name}=("([^"]*)"|[^;\\s]+)`, "i").exec(value);
  return m ? (m[2] ?? m[1]) : undefined;
}

interface ParsedMime {
  headers: Header[];
  text?: string;
  html?: string;
  attachments: { filename: string; mimeType: string; data: Buffer }[];
}

/** Read a raw RFC 5322 message: headers, the first text and HTML parts, and attachments. */
export function parseRawMessage(raw: string): ParsedMime {
  const out: ParsedMime = { headers: [], attachments: [] };
  const walk = (entity: string, top: boolean) => {
    const split = /\r?\n\r?\n/.exec(entity);
    const head = split ? entity.slice(0, split.index) : entity;
    const body = split ? entity.slice(split.index + split[0].length) : "";
    const headers = unfoldHeaders(head);
    if (top) out.headers = headers;
    const type = header({ headers }, "Content-Type") || "text/plain";
    const mime = type.split(";")[0].trim().toLowerCase();
    if (mime.startsWith("multipart/")) {
      const boundary = param(type, "boundary");
      if (!boundary) return;
      const pieces = body.split(`--${boundary}`);
      for (const piece of pieces.slice(1)) {
        if (piece.startsWith("--")) break;
        // The line break before a delimiter belongs to the delimiter (RFC 2046 5.1.1), not the part.
        walk(piece.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), false);
      }
      return;
    }
    const data = decodeBody(body, header({ headers }, "Content-Transfer-Encoding"));
    const disposition = header({ headers }, "Content-Disposition");
    const filename = param(disposition, "filename") ?? param(type, "name");
    if (!filename && mime === "text/plain" && out.text === undefined) out.text = data.toString("utf8");
    else if (!filename && mime === "text/html" && out.html === undefined) out.html = data.toString("utf8");
    else out.attachments.push({ filename: filename ?? "attachment", mimeType: mime, data });
  };
  walk(raw, true);
  return out;
}

// ---- The mailbox ---------------------------------------------------------------------------

export class DemoMailbox {
  readonly self: string;
  readonly now: number;
  private messages = new Map<string, StoredMessage>();
  private threads = new Map<string, string[]>();
  private labels = new Map<string, StoredLabel>();
  private filters = new Map<string, gmail_v1.Schema$Filter>();
  private drafts = new Map<string, string>();
  private staleUnread = new Set<string>();
  private history: HistoryEntry[] = [];
  private historyId = FIRST_HISTORY_ID;
  private seq = 0;

  constructor(spec: DemoMailboxSpec, now: number) {
    this.self = spec.self;
    this.now = now;
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
    spec.labels.forEach((name, i) => this.labels.set(`Label_${i + 1}`, { id: `Label_${i + 1}`, name, type: "user" }));
    const idOf = (label: string) =>
      this.labels.has(label) ? label : [...this.labels.values()].find((l) => l.name === label)?.id;
    for (const t of spec.threads) {
      const ids: string[] = [];
      t.messages.forEach((m, i) => {
        const id = `${t.id}-m${i + 1}`;
        const labelIds = m.labels.map((l) => {
          const found = idOf(l);
          if (!found) throw new Error(`demo mailbox: unknown label ${l}`);
          return found;
        });
        const at = Math.round(now - m.daysAgo * 86_400_000);
        const headers: Header[] = [
          { name: "From", value: m.from },
          { name: "To", value: m.to },
          ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
          { name: "Subject", value: m.subject },
          { name: "Date", value: rfc2822(at) },
          { name: "Message-ID", value: `<${id}@mail.example>` },
          ...(i > 0 ? [{ name: "In-Reply-To", value: `<${t.id}-m${i}@mail.example>` }] : []),
          ...(m.headers ?? []).map(([name, value]) => ({ name, value })),
        ];
        this.messages.set(id, {
          id,
          threadId: t.id,
          labelIds,
          internalDate: at,
          headers,
          text: m.text,
          html: m.html,
          attachments: (m.attachments ?? []).map((a, j) => ({ id: `${id}-a${j + 1}`, ...a })),
        });
        ids.push(id);
      });
      this.threads.set(t.id, ids);
      if (t.staleUnread) this.staleUnread.add(t.id);
    }
    spec.filters.forEach((f, i) => {
      const id = `demo-filter-${++this.seq}`;
      this.filters.set(id, {
        id,
        criteria: { from: f.from },
        action: { addLabelIds: f.addLabels.map((n) => idOf(n)!), removeLabelIds: f.removeLabelIds },
      });
    });
  }

  // ---- reading ----

  private threadMessages(threadId: string): StoredMessage[] {
    const ids = this.threads.get(threadId);
    if (!ids) throw httpError(404, "Requested entity was not found.");
    return ids.map((id) => this.messages.get(id)!).sort((a, b) => a.internalDate - b.internalDate);
  }

  private context(): QueryContext {
    return {
      now: this.now,
      self: this.self,
      labelIdsNamed: (name) => {
        const norm = (s: string) => s.toLowerCase().replace(/[\s/_-]+/g, "-");
        const want = norm(name);
        return [...this.labels.values()].filter((l) => norm(l.name) === want || l.id.toLowerCase() === want).map((l) => l.id);
      },
      isUserLabel: (id) => this.labels.get(id)?.type === "user",
    };
  }

  /** The searchable view of a message; `stale` lets the thread index answer UNREAD as it lags. */
  private searchable(m: StoredMessage, stale: boolean): Searchable {
    const labelIds = stale && !m.labelIds.includes("UNREAD") ? [...m.labelIds, "UNREAD"] : m.labelIds;
    return {
      labelIds,
      from: header(m, "From"),
      to: header(m, "To"),
      cc: header(m, "Cc"),
      bcc: header(m, "Bcc"),
      subject: header(m, "Subject"),
      listId: header(m, "List-Id"),
      messageId: header(m, "Message-ID"),
      text: `${m.text ?? ""} ${m.html ? stripTags(m.html) : ""}`,
      filenames: m.attachments.map((a) => a.filename),
      date: m.internalDate,
      size: sizeOf(m),
    };
  }

  private matching(
    q: string | undefined,
    labelIds: string[] | undefined,
    includeSpamTrash: boolean | undefined,
    threadIndex: boolean,
  ): StoredMessage[] {
    const ctx = this.context();
    const keepTrash = includeSpamTrash === true || asksForTrashOrSpam(q ?? "") || (labelIds ?? []).some((l) => l === "TRASH" || l === "SPAM");
    return [...this.messages.values()].filter((m) => {
      if (!keepTrash && (m.labelIds.includes("TRASH") || m.labelIds.includes("SPAM"))) return false;
      if (labelIds?.length && !labelIds.every((l) => m.labelIds.includes(l))) return false;
      return !q || matchesQuery(q, this.searchable(m, threadIndex && this.staleUnread.has(m.threadId)), ctx);
    });
  }

  private part(partId: string, mimeType: string, body: Buffer, filename = "", attachmentId?: string): gmail_v1.Schema$MessagePart {
    const ct = filename ? `${mimeType}; name="${filename}"` : `${mimeType}; charset="UTF-8"`;
    return {
      partId,
      mimeType,
      filename,
      headers: [
        { name: "Content-Type", value: ct },
        ...(filename ? [{ name: "Content-Disposition", value: `attachment; filename="${filename}"` }] : []),
      ],
      body: attachmentId ? { attachmentId, size: body.length } : { size: body.length, data: b64url(body) },
    };
  }

  private payload(m: StoredMessage): gmail_v1.Schema$MessagePart {
    const text = m.text !== undefined ? Buffer.from(m.text, "utf8") : undefined;
    const html = m.html !== undefined ? Buffer.from(m.html, "utf8") : undefined;
    const bodyPrefix = m.attachments.length ? "0" : "";
    const id = (i: number) => (bodyPrefix ? `${bodyPrefix}.${i}` : String(i));
    let body: gmail_v1.Schema$MessagePart;
    if (text && html) {
      body = {
        partId: bodyPrefix,
        mimeType: "multipart/alternative",
        filename: "",
        headers: [{ name: "Content-Type", value: 'multipart/alternative; boundary="alt"' }],
        body: { size: 0 },
        parts: [this.part(id(0), "text/plain", text), this.part(id(1), "text/html", html)],
      };
    } else {
      body = this.part(bodyPrefix, html ? "text/html" : "text/plain", html ?? text ?? Buffer.alloc(0));
    }
    if (!m.attachments.length) return { ...body, partId: "", headers: [...m.headers, ...(body.headers ?? [])] };
    return {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [...m.headers, { name: "Content-Type", value: 'multipart/mixed; boundary="mixed"' }],
      body: { size: 0 },
      parts: [body, ...m.attachments.map((a, i) => this.part(String(i + 1), a.mimeType, a.data, a.filename, a.id))],
    };
  }

  private apiMessage(m: StoredMessage, format: string | undefined, metadataHeaders?: string[]): gmail_v1.Schema$Message {
    const base: gmail_v1.Schema$Message = {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labelIds],
      snippet: snippetOf(m),
      historyId: String(this.historyId),
      internalDate: String(m.internalDate),
      sizeEstimate: sizeOf(m),
    };
    if (format === "minimal") return base;
    if (format === "metadata") {
      const want = metadataHeaders?.map((h) => h.toLowerCase());
      const headers = want?.length ? m.headers.filter((h) => want.includes(h.name.toLowerCase())) : m.headers;
      return { ...base, payload: { mimeType: m.attachments.length ? "multipart/mixed" : "text/plain", headers } };
    }
    return { ...base, payload: this.payload(m) };
  }

  // ---- writing ----

  private record(entry: Omit<HistoryEntry, "id">): void {
    this.history.push({ id: ++this.historyId, ...entry });
  }

  private assertLabels(ids: string[]): void {
    for (const id of ids) if (!this.labels.has(id)) throw httpError(400, `Invalid label: ${id}`);
  }

  private relabel(m: StoredMessage, add: string[], remove: string[]): void {
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = remove.filter((l) => m.labelIds.includes(l));
    m.labelIds = [...m.labelIds.filter((l) => !removed.includes(l)), ...added];
    if (added.length) this.record({ labelsAdded: [{ messageId: m.id, labelIds: added }] });
    if (removed.length) this.record({ labelsRemoved: [{ messageId: m.id, labelIds: removed }] });
    // A change to the thread brings its index entry up to date — the drift lasts until then.
    if (added.length || removed.length) this.staleUnread.delete(m.threadId);
  }

  private storeDraft(raw: string | null | undefined, threadId: string | null | undefined): StoredMessage {
    if (!raw) throw httpError(400, "Missing draft message");
    if (threadId && !this.threads.has(threadId)) throw httpError(404, "Requested entity was not found.");
    const parsed = parseRawMessage(Buffer.from(raw, "base64url").toString("utf8"));
    const id = `draft-msg-${++this.seq}`;
    const thread = threadId || `draft-thread-${this.seq}`;
    const m: StoredMessage = {
      id,
      threadId: thread,
      labelIds: ["DRAFT"],
      internalDate: Date.now(),
      headers: parsed.headers,
      text: parsed.text,
      html: parsed.html,
      attachments: parsed.attachments.map((a, i) => ({ id: `${id}-a${i + 1}`, ...a })),
    };
    this.messages.set(id, m);
    this.threads.set(thread, [...(this.threads.get(thread) ?? []), id]);
    this.record({ messagesAdded: [id] });
    return m;
  }

  private dropMessage(id: string): void {
    const m = this.messages.get(id);
    if (!m) return;
    this.messages.delete(id);
    const rest = (this.threads.get(m.threadId) ?? []).filter((x) => x !== id);
    if (rest.length) this.threads.set(m.threadId, rest);
    else this.threads.delete(m.threadId);
  }

  /** The object the `Gmail` class takes in place of googleapis' client. */
  api(): gmail_v1.Gmail {
    const ok = <T>(data: T) => Promise.resolve({ data, status: 200 });
    const page = <T>(items: T[], max: number | null | undefined, token: string | null | undefined) => {
      if (token && !/^\d+$/.test(token)) throw httpError(400, "Invalid pageToken");
      const start = token ? Number(token) : 0;
      const size = Math.max(1, Math.min(max ?? 100, 500));
      const slice = items.slice(start, start + size);
      return { slice, next: start + size < items.length ? String(start + size) : undefined };
    };
    const latest = (threadId: string) => Math.max(...this.threadMessages(threadId).map((m) => m.internalDate));
    const users = {
      getProfile: () =>
        ok({
          emailAddress: this.self,
          messagesTotal: [...this.messages.values()].filter((m) => !m.labelIds.includes("DRAFT")).length,
          threadsTotal: this.threads.size,
          historyId: String(this.historyId),
        }),
      threads: {
        list: (p: gmail_v1.Params$Resource$Users$Threads$List) => {
          const ids = [...new Set(this.matching(p.q ?? undefined, p.labelIds ?? undefined, p.includeSpamTrash ?? undefined, true).map((m) => m.threadId))];
          ids.sort((a, b) => latest(b) - latest(a));
          const { slice, next } = page(ids, p.maxResults, p.pageToken);
          return ok({
            threads: slice.map((id) => ({ id, snippet: snippetOf(this.threadMessages(id).at(-1)!), historyId: String(this.historyId) })),
            resultSizeEstimate: ids.length,
            ...(next ? { nextPageToken: next } : {}),
          });
        },
        get: (p: gmail_v1.Params$Resource$Users$Threads$Get) => {
          const messages = this.threadMessages(p.id!);
          return ok({
            id: p.id,
            historyId: String(this.historyId),
            messages: messages.map((m) => this.apiMessage(m, p.format ?? "full", p.metadataHeaders ?? undefined)),
          });
        },
        modify: (p: gmail_v1.Params$Resource$Users$Threads$Modify) => {
          const messages = this.threadMessages(p.id!);
          const add = p.requestBody?.addLabelIds ?? [];
          const remove = p.requestBody?.removeLabelIds ?? [];
          this.assertLabels([...add, ...remove]);
          for (const m of messages) this.relabel(m, add, remove);
          return ok({ id: p.id, messages: messages.map((m) => this.apiMessage(m, "minimal")) });
        },
        trash: (p: gmail_v1.Params$Resource$Users$Threads$Trash) => {
          for (const m of this.threadMessages(p.id!)) {
            if (m.labelIds.includes("TRASH")) continue;
            this.relabel(m, ["TRASH"], ["INBOX"]);
          }
          return ok({ id: p.id });
        },
        // As Gmail does (measured 2026-11-25 on a live thread): trash drops INBOX, untrash takes
        // TRASH off and does not put INBOX back.
        untrash: (p: gmail_v1.Params$Resource$Users$Threads$Untrash) => {
          for (const m of this.threadMessages(p.id!)) {
            if (!m.labelIds.includes("TRASH")) continue;
            this.relabel(m, [], ["TRASH"]);
          }
          return ok({ id: p.id });
        },
      },
      messages: {
        list: (p: gmail_v1.Params$Resource$Users$Messages$List) => {
          const found = this.matching(p.q ?? undefined, p.labelIds ?? undefined, p.includeSpamTrash ?? undefined, false);
          found.sort((a, b) => b.internalDate - a.internalDate);
          const { slice, next } = page(found, p.maxResults, p.pageToken);
          return ok({
            messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
            resultSizeEstimate: found.length,
            ...(next ? { nextPageToken: next } : {}),
          });
        },
        batchModify: (p: gmail_v1.Params$Resource$Users$Messages$Batchmodify) => {
          const add = p.requestBody?.addLabelIds ?? [];
          const remove = p.requestBody?.removeLabelIds ?? [];
          this.assertLabels([...add, ...remove]);
          // Gmail's limit, which gmail.ts chunks for (BATCH_MODIFY_CHUNK): a demo that took more
          // would hide a chunking fault.
          if ((p.requestBody?.ids ?? []).length > 1000) throw httpError(400, "Too many ids: at most 1000 per request");
          for (const id of p.requestBody?.ids ?? []) {
            const m = this.messages.get(id);
            if (m) this.relabel(m, add, remove);
          }
          return ok("");
        },
        attachments: {
          get: (p: gmail_v1.Params$Resource$Users$Messages$Attachments$Get) => {
            const a = this.messages.get(p.messageId!)?.attachments.find((x) => x.id === p.id);
            if (!a) return Promise.reject(httpError(404, "Requested entity was not found."));
            return ok({ attachmentId: a.id, size: a.data.length, data: b64url(a.data) });
          },
        },
      },
      history: {
        list: (p: gmail_v1.Params$Resource$Users$History$List) => {
          const start = Number(p.startHistoryId);
          if (!Number.isFinite(start) || start < FIRST_HISTORY_ID) {
            return Promise.reject(httpError(404, "Requested entity was not found."));
          }
          const msg = (id: string) => {
            const m = this.messages.get(id);
            return { id, threadId: m?.threadId ?? "", labelIds: m ? [...m.labelIds] : [] };
          };
          const touches = (e: HistoryEntry) =>
            !p.labelId ||
            [...(e.labelsAdded ?? []), ...(e.labelsRemoved ?? [])].some((x) => x.labelIds.includes(p.labelId!)) ||
            (e.messagesAdded ?? []).some((id) => this.messages.get(id)?.labelIds.includes(p.labelId!));
          const entries = this.history.filter((e) => e.id > start && touches(e));
          const { slice, next } = page(entries, p.maxResults, p.pageToken);
          return ok({
            history: slice.map((e) => {
              const ids = [...(e.messagesAdded ?? []), ...[...(e.labelsAdded ?? []), ...(e.labelsRemoved ?? [])].map((x) => x.messageId)];
              return {
                id: String(e.id),
                messages: ids.map(msg),
                ...(e.messagesAdded ? { messagesAdded: e.messagesAdded.map((id) => ({ message: msg(id) })) } : {}),
                ...(e.labelsAdded ? { labelsAdded: e.labelsAdded.map((x) => ({ message: msg(x.messageId), labelIds: x.labelIds })) } : {}),
                ...(e.labelsRemoved ? { labelsRemoved: e.labelsRemoved.map((x) => ({ message: msg(x.messageId), labelIds: x.labelIds })) } : {}),
              };
            }),
            historyId: String(this.historyId),
            ...(next ? { nextPageToken: next } : {}),
          });
        },
      },
      labels: {
        list: () => ok({ labels: [...this.labels.values()].map((l) => ({ ...l })) }),
        create: (p: gmail_v1.Params$Resource$Users$Labels$Create) => {
          const name = p.requestBody?.name ?? "";
          if (!name) return Promise.reject(httpError(400, "Invalid label name"));
          if ([...this.labels.values()].some((l) => l.name.toLowerCase() === name.toLowerCase())) {
            return Promise.reject(httpError(409, "Label name exists or conflicts"));
          }
          const id = `Label_${100 + ++this.seq}`;
          const label: StoredLabel = { id, name, type: "user", ...(p.requestBody?.color ? { color: p.requestBody.color as StoredLabel["color"] } : {}) };
          this.labels.set(id, label);
          return ok({ ...label });
        },
        patch: (p: gmail_v1.Params$Resource$Users$Labels$Patch) => {
          const l = this.labels.get(p.id!);
          if (!l) return Promise.reject(httpError(404, "Requested entity was not found."));
          if (l.type === "system") return Promise.reject(httpError(400, "Invalid label"));
          if (p.requestBody?.color) l.color = p.requestBody.color as StoredLabel["color"];
          return ok({ ...l });
        },
        delete: (p: gmail_v1.Params$Resource$Users$Labels$Delete) => {
          const l = this.labels.get(p.id!);
          if (!l) return Promise.reject(httpError(404, "Requested entity was not found."));
          if (l.type === "system") return Promise.reject(httpError(400, "Invalid delete request"));
          for (const m of this.messages.values()) if (m.labelIds.includes(l.id)) this.relabel(m, [], [l.id]);
          this.labels.delete(l.id);
          return ok("");
        },
      },
      settings: {
        filters: {
          list: () => ok({ filter: [...this.filters.values()].map((f) => structuredClone(f)) }),
          create: (p: gmail_v1.Params$Resource$Users$Settings$Filters$Create) => {
            const id = `demo-filter-${++this.seq}`;
            const f = { id, criteria: p.requestBody?.criteria ?? {}, action: p.requestBody?.action ?? {} };
            this.filters.set(id, f);
            return ok(structuredClone(f));
          },
          delete: (p: gmail_v1.Params$Resource$Users$Settings$Filters$Delete) => {
            if (!this.filters.delete(p.id!)) return Promise.reject(httpError(404, "Filter not found"));
            return ok("");
          },
        },
        sendAs: {
          list: () =>
            ok({
              sendAs: [{ sendAsEmail: this.self, displayName: "Alex Morgan", isPrimary: true, isDefault: true, verificationStatus: "accepted", signature: "" }],
            }),
        },
      },
      drafts: {
        create: (p: gmail_v1.Params$Resource$Users$Drafts$Create) => {
          const m = this.storeDraft(p.requestBody?.message?.raw, p.requestBody?.message?.threadId);
          const id = `r-${++this.seq}`;
          this.drafts.set(id, m.id);
          return ok({ id, message: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] } });
        },
        update: (p: gmail_v1.Params$Resource$Users$Drafts$Update) => {
          const old = this.drafts.get(p.id!);
          if (!old) return Promise.reject(httpError(404, "Requested entity was not found."));
          // Gmail gives an updated draft a new message id and drops it from its thread unless the
          // thread is named again (measured 29 Oct 2026); the demo does the same.
          this.dropMessage(old);
          const m = this.storeDraft(p.requestBody?.message?.raw, p.requestBody?.message?.threadId);
          this.drafts.set(p.id!, m.id);
          return ok({ id: p.id, message: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] } });
        },
        get: (p: gmail_v1.Params$Resource$Users$Drafts$Get) => {
          const id = this.drafts.get(p.id!);
          const m = id ? this.messages.get(id) : undefined;
          if (!m) return Promise.reject(httpError(404, "Requested entity was not found."));
          return ok({ id: p.id, message: this.apiMessage(m, p.format ?? "full") });
        },
      },
    };
    // Every method answers with a promise, also when it fails: googleapis rejects, it never
    // throws, and a caller that chains `.catch()` on the call depends on that.
    const asPromises = (o: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          typeof v === "function"
            ? (...a: unknown[]) => Promise.resolve().then(() => (v as (...x: unknown[]) => unknown)(...a))
            : asPromises(v as Record<string, unknown>),
        ]),
      );
    return { users: asPromises(users) } as unknown as gmail_v1.Gmail;
  }
}

/** A fresh demo mailbox, dated from `now`. */
export function createDemoMailbox(now: number = Date.now()): DemoMailbox {
  return new DemoMailbox(demoMailboxSpec(now), now);
}

/**
 * The unsubscribe network in demo mode: nothing leaves the process. The resolver answers with a
 * public address so the SSRF check passes as it would for the real host, and the "request" is a
 * 200 built here; the address is example.com's and is never connected to.
 */
export const demoUnsubscribeDeps: UnsubscribeDeps = {
  fetch: async () => new Response(null, { status: 200 }),
  resolveHost: async () => ["93.184.215.14"],
  now: () => Date.now(),
};

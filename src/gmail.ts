import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";

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
  attachments: { messageId: string; attachmentId: string; filename: string; mimeType: string; size: number }[];
}

export interface LabelInfo {
  id: string;
  name: string;
  type?: string | null;
}

/** Thin wrapper over the native Gmail API. Every call is live — no cache. */
export class Gmail {
  private api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = google.gmail({ version: "v1", auth });
  }

  async search(query: string, maxResults = 25): Promise<ThreadSummary[]> {
    const list = await this.api.users.threads.list({ userId: "me", q: query, maxResults });
    const out: ThreadSummary[] = [];
    for (const t of list.data.threads ?? []) {
      // 'full' (not 'metadata') so the MIME parts are present — otherwise attachment
      // detection always returns false (metadata format omits payload.parts).
      const meta = await this.api.users.threads.get({
        userId: "me",
        id: t.id!,
        format: "full",
      });
      const msgs = meta.data.messages ?? [];
      const headers = msgs[0]?.payload?.headers ?? [];
      const h = (n: string) =>
        headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
      out.push({
        threadId: t.id!,
        messageCount: msgs.length,
        from: h("From"),
        subject: h("Subject"),
        date: h("Date"),
        labelIds: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
        snippet: t.snippet ?? msgs[0]?.snippet ?? "",
        hasAttachments: msgs.some((m) => this.collectAttachments(m).length > 0),
      });
    }
    return out;
  }

  async getThread(threadId: string, full = true): Promise<{ threadId: string; messages: ParsedMessage[] }> {
    const res = await this.api.users.threads.get({
      userId: "me",
      id: threadId,
      format: full ? "full" : "metadata",
    });
    return { threadId, messages: (res.data.messages ?? []).map((m) => this.parseMessage(m)) };
  }

  private parseMessage(m: gmail_v1.Schema$Message): ParsedMessage {
    const headers = m.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
    const { text, html } = this.collectBodies(m.payload);
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
      attachments: this.collectAttachments(m),
    };
  }

  private collectBodies(payload?: gmail_v1.Schema$MessagePart): { text: string; html: string } {
    let text = "";
    let html = "";
    const decode = (d?: string | null) => (d ? Buffer.from(d, "base64").toString("utf8") : "");
    const visit = (p?: gmail_v1.Schema$MessagePart) => {
      if (!p) return;
      if (p.mimeType === "text/plain") text += decode(p.body?.data);
      else if (p.mimeType === "text/html") html += decode(p.body?.data);
      (p.parts ?? []).forEach(visit);
    };
    visit(payload);
    return { text, html };
  }

  private collectAttachments(m: gmail_v1.Schema$Message): ParsedMessage["attachments"] {
    const out: ParsedMessage["attachments"] = [];
    const visit = (p?: gmail_v1.Schema$MessagePart) => {
      if (!p) return;
      if (p.filename && p.body?.attachmentId) {
        out.push({
          messageId: m.id!,
          attachmentId: p.body.attachmentId,
          filename: p.filename,
          mimeType: p.mimeType ?? "application/octet-stream",
          size: p.body.size ?? 0,
        });
      }
      (p.parts ?? []).forEach(visit);
    };
    visit(m.payload);
    return out;
  }

  async modifyLabels(threadId: string, add: string[] = [], remove: string[] = []): Promise<void> {
    await this.api.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
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
    const existing = (await this.listLabels()).find((l) => l.name === name);
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
    const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    if (!res.data.data) throw new Error("Attachment has no data.");
    await fs.writeFile(destPath, Buffer.from(res.data.data, "base64url"));
    return destPath;
  }
}

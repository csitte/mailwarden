import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Gmail } from "./gmail.js";
import { getAuth } from "./auth.js";
import { snooze, unsnooze, listSnoozed, sweepSnoozed, isValidIsoDate, todayIso } from "./snooze.js";

/** Fresh authed client per call — cheap, and avoids stale auth in long-lived servers. */
async function client(): Promise<Gmail> {
  return new Gmail(await getAuth(false));
}

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

export function registerTools(server: McpServer): void {
  // ---- Read / find ----
  server.registerTool(
    "search",
    {
      description:
        "Search Gmail with native query syntax (e.g. 'in:inbox from:foo@bar.com newer_than:7d'). Returns thread summaries.",
      inputSchema: { query: z.string(), maxResults: z.number().int().min(1).max(100).default(25) },
    },
    async ({ query, maxResults }) => ok(await (await client()).search(query, maxResults)),
  );

  server.registerTool(
    "get_thread",
    {
      description: "Fetch a full thread by ID: headers, plaintext + HTML bodies, and attachment metadata.",
      inputSchema: { threadId: z.string(), full: z.boolean().default(true) },
    },
    async ({ threadId, full }) => ok(await (await client()).getThread(threadId, full)),
  );

  server.registerTool(
    "list_labels",
    { description: "List all Gmail labels (system + user)." },
    async () => ok(await (await client()).listLabels()),
  );

  // ---- Mailbox actions ----
  server.registerTool(
    "modify_labels",
    {
      description: "Add/remove labels on a thread. Archive = remove 'INBOX'; mark read = remove 'UNREAD'.",
      inputSchema: {
        threadId: z.string(),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      },
    },
    async ({ threadId, add, remove }) => {
      await (await client()).modifyLabels(threadId, add, remove);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "archive",
    { description: "Archive a thread (remove it from the inbox).", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, [], ["INBOX"]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "mark_read",
    { description: "Mark a thread as read.", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, [], ["UNREAD"]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "mark_unread",
    { description: "Mark a thread as unread.", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, ["UNREAD"], []);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "trash",
    { description: "Move a thread to Trash.", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => {
      await (await client()).trash(threadId);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "untrash",
    { description: "Restore a thread from Trash.", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => {
      await (await client()).untrash(threadId);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "download_attachment",
    {
      description:
        "Download an attachment to a local file path. If MAILWARDEN_DOWNLOAD_DIR is set, destPath is resolved inside (and restricted to) that directory.",
      inputSchema: { messageId: z.string(), attachmentId: z.string(), destPath: z.string() },
    },
    async ({ messageId, attachmentId, destPath }) =>
      ok({ saved: await (await client()).downloadAttachment(messageId, attachmentId, destPath) }),
  );

  // ---- Snooze (mailwarden's differentiator) ----
  server.registerTool(
    "snooze",
    {
      description:
        "Snooze a thread until a date (YYYY-MM-DD): archives it now, resurfaces on/after that date when sweep_snoozed runs.",
      inputSchema: {
        threadId: z.string(),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
          .refine(isValidIsoDate, "not a real calendar date")
          .refine((s) => s >= todayIso(), "snooze date is in the past"),
      },
    },
    async ({ threadId, until }) => ok(await snooze(await client(), threadId, until)),
  );

  server.registerTool(
    "unsnooze",
    { description: "Cancel a snooze: return the thread to the inbox now.", inputSchema: { threadId: z.string() } },
    async ({ threadId }) => ok(await unsnooze(await client(), threadId)),
  );

  server.registerTool(
    "list_snoozed",
    { description: "List all snoozed threads with their due dates." },
    async () => ok(await listSnoozed(await client())),
  );

  server.registerTool(
    "sweep_snoozed",
    {
      description:
        "Resurface all snoozed threads whose date is due (<= today). Run on demand, via cron, or the daemon timer.",
    },
    async () => ok(await sweepSnoozed(await client())),
  );
}

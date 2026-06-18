import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Gmail } from "./gmail.js";
import { getAuth } from "./auth.js";
import { snooze, unsnooze, listSnoozed, sweepSnoozed } from "./snooze.js";

/** Fresh authed client per call — cheap, and avoids stale auth in long-lived servers. */
async function client(): Promise<Gmail> {
  return new Gmail(await getAuth(false));
}

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

export function registerTools(server: McpServer): void {
  // ---- Read / find ----
  server.tool(
    "search",
    "Search Gmail with native query syntax (e.g. 'in:inbox from:foo@bar.com newer_than:7d'). Returns thread summaries.",
    { query: z.string(), maxResults: z.number().int().min(1).max(100).default(25) },
    async ({ query, maxResults }) => ok(await (await client()).search(query, maxResults)),
  );

  server.tool(
    "get_thread",
    "Fetch a full thread by ID: headers, plaintext + HTML bodies, and attachment metadata.",
    { threadId: z.string(), full: z.boolean().default(true) },
    async ({ threadId, full }) => ok(await (await client()).getThread(threadId, full)),
  );

  server.tool("list_labels", "List all Gmail labels (system + user).", {}, async () =>
    ok(await (await client()).listLabels()),
  );

  // ---- Mailbox actions ----
  server.tool(
    "modify_labels",
    "Add/remove labels on a thread. Archive = remove 'INBOX'; mark read = remove 'UNREAD'.",
    { threadId: z.string(), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) },
    async ({ threadId, add, remove }) => {
      await (await client()).modifyLabels(threadId, add, remove);
      return ok({ ok: true });
    },
  );

  server.tool("archive", "Archive a thread (remove it from the inbox).", { threadId: z.string() }, async ({ threadId }) => {
    await (await client()).modifyLabels(threadId, [], ["INBOX"]);
    return ok({ ok: true });
  });

  server.tool("mark_read", "Mark a thread as read.", { threadId: z.string() }, async ({ threadId }) => {
    await (await client()).modifyLabels(threadId, [], ["UNREAD"]);
    return ok({ ok: true });
  });

  server.tool("mark_unread", "Mark a thread as unread.", { threadId: z.string() }, async ({ threadId }) => {
    await (await client()).modifyLabels(threadId, ["UNREAD"], []);
    return ok({ ok: true });
  });

  server.tool("trash", "Move a thread to Trash.", { threadId: z.string() }, async ({ threadId }) => {
    await (await client()).trash(threadId);
    return ok({ ok: true });
  });

  server.tool("untrash", "Restore a thread from Trash.", { threadId: z.string() }, async ({ threadId }) => {
    await (await client()).untrash(threadId);
    return ok({ ok: true });
  });

  server.tool(
    "download_attachment",
    "Download an attachment to a local file path.",
    { messageId: z.string(), attachmentId: z.string(), destPath: z.string() },
    async ({ messageId, attachmentId, destPath }) =>
      ok({ saved: await (await client()).downloadAttachment(messageId, attachmentId, destPath) }),
  );

  // ---- Snooze (mailwarden's differentiator) ----
  server.tool(
    "snooze",
    "Snooze a thread until a date (YYYY-MM-DD): archives it now, resurfaces on/after that date when sweep_snoozed runs.",
    { threadId: z.string(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD") },
    async ({ threadId, until }) => ok(await snooze(await client(), threadId, until)),
  );

  server.tool("unsnooze", "Cancel a snooze: return the thread to the inbox now.", { threadId: z.string() }, async ({ threadId }) =>
    ok(await unsnooze(await client(), threadId)),
  );

  server.tool("list_snoozed", "List all snoozed threads with their due dates.", {}, async () =>
    ok(await listSnoozed(await client())),
  );

  server.tool(
    "sweep_snoozed",
    "Resurface all snoozed threads whose date is due (<= today). Run on demand, via cron, or the daemon timer.",
    {},
    async () => ok(await sweepSnoozed(await client())),
  );
}

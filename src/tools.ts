import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Gmail } from "./gmail.js";
import { getAuth } from "./auth.js";
import { snooze, unsnooze, listSnoozed, sweepSnoozed, isValidIsoDate, todayIso } from "./snooze.js";
import { fenceOutput } from "./sanitize.js";

/** Fresh authed client per call — cheap, and avoids stale auth in long-lived servers. */
async function client(): Promise<Gmail> {
  return new Gmail(await getAuth(false));
}

/**
 * Every result carries BOTH representations: `structuredContent` (validated
 * against the tool's outputSchema, machine-readable) and a text block with the
 * same JSON fenced as untrusted content — mail bodies are attacker-supplied.
 */
const ok = (obj: object) => ({
  content: [{ type: "text" as const, text: fenceOutput(JSON.stringify(obj, null, 2)) }],
  structuredContent: obj as Record<string, unknown>,
});

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// ---- Output schemas (structured content is validated against these) ----

const attachmentSchema = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

const threadSummarySchema = z.object({
  threadId: z.string(),
  messageCount: z.number(),
  from: z.string(),
  subject: z.string(),
  date: z.string(),
  labelIds: z.array(z.string()),
  snippet: z.string(),
  hasAttachments: z.boolean(),
});

const parsedMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  plaintextBody: z.string(),
  htmlBody: z.string(),
  attachments: z.array(attachmentSchema),
});

const okOutput = { ok: z.boolean() };

export function registerTools(server: McpServer): void {
  // ---- Read / find ----
  server.registerTool(
    "search",
    {
      description:
        "Search Gmail with native query syntax (e.g. 'in:inbox from:foo@bar.com newer_than:7d'). Returns thread summaries; read-state/category predicates are re-verified against each hit's live labels. " +
        "Paginated: when more results exist, the response carries a nextPageToken — pass it back via pageToken to fetch the next page. " +
        "USE WHEN: locating threads by sender, subject, date, label, or read state. " +
        "DO NOT USE: to fetch a thread you already have the ID of (use get_thread). " +
        "SIDE EFFECTS: none.",
      inputSchema: {
        query: z.string(),
        maxResults: z.number().int().min(1).max(100).default(25),
        pageToken: z.string().optional(),
      },
      outputSchema: {
        threads: z.array(threadSummarySchema),
        nextPageToken: z.string().optional(),
      },
      annotations: { title: "Search Gmail", ...readOnly },
    },
    async ({ query, maxResults, pageToken }) =>
      ok(await (await client()).search(query, maxResults, pageToken)),
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "Fetch a full thread by ID: headers, plaintext + HTML bodies, and attachment metadata. " +
        "USE WHEN: reading a thread's content after finding it via search. " +
        "DO NOT USE: with a message ID — this takes thread IDs. " +
        "SIDE EFFECTS: none (does not mark as read).",
      inputSchema: { threadId: z.string(), full: z.boolean().default(true) },
      outputSchema: { threadId: z.string(), messages: z.array(parsedMessageSchema) },
      annotations: { title: "Get thread", ...readOnly },
    },
    async ({ threadId, full }) => ok(await (await client()).getThread(threadId, full)),
  );

  server.registerTool(
    "list_labels",
    {
      description:
        "List all Gmail labels (system + user). " +
        "USE WHEN: you need label IDs/names before modify_labels, or to inspect the mailbox structure. " +
        "SIDE EFFECTS: none.",
      outputSchema: {
        labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().nullish() })),
      },
      annotations: { title: "List labels", ...readOnly },
    },
    async () => ok({ labels: await (await client()).listLabels() }),
  );

  server.registerTool(
    "list_snoozed",
    {
      description:
        "List all snoozed threads with their due dates. SIDE EFFECTS: none.",
      outputSchema: {
        snoozed: z.array(
          z.object({ threadId: z.string(), subject: z.string(), snoozedUntil: z.string() }),
        ),
      },
      annotations: { title: "List snoozed", ...readOnly },
    },
    async () => ok({ snoozed: await listSnoozed(await client()) }),
  );

  // With MAILWARDEN_READONLY=1 only the read tools above exist — nothing that
  // can change the mailbox or write files is even advertised to clients.
  if (process.env.MAILWARDEN_READONLY === "1") return;

  // ---- Mailbox actions ----
  server.registerTool(
    "modify_labels",
    {
      description:
        "Add/remove labels on a thread. Archive = remove 'INBOX'; mark read = remove 'UNREAD'. " +
        "USE WHEN: applying custom labels or label combinations in one call. " +
        "DO NOT USE: for plain archive/read/unread — the dedicated tools are clearer. " +
        "SIDE EFFECTS: changes the thread's labels; reversible by the inverse call.",
      inputSchema: {
        threadId: z.string(),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      },
      outputSchema: okOutput,
      annotations: { title: "Modify labels", ...write },
    },
    async ({ threadId, add, remove }) => {
      await (await client()).modifyLabels(threadId, add, remove);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "bulk_modify",
    {
      description:
        "Bulk-apply label changes to every message matching a Gmail query, batched at 1000 messages per API request. " +
        "Returns matched/modified counts, affected thread IDs (capped at 500 — modifiedThreadCount has the true total), and per-chunk failures (partial success is reported, not hidden). " +
        "Note: the query hits Gmail's search index as-is, WITHOUT the live re-verification search performs — for read-state-precise bulk ops, verify with search first. " +
        "USE WHEN: mass operations — 'archive all newsletters older than 30 days' (query + remove INBOX), bulk labeling, bulk mark-read. " +
        "DO NOT USE: for a single thread (use modify_labels or the dedicated tools), or with neither add nor remove. " +
        "SIDE EFFECTS: modifies up to maxMessages messages in one call; label changes are reversible by the inverse call.",
      inputSchema: {
        query: z.string(),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
        maxMessages: z.number().int().min(1).max(10000).default(1000),
      },
      outputSchema: {
        matchedMessages: z.number(),
        modifiedMessages: z.number(),
        modifiedThreadCount: z.number(),
        modifiedThreads: z.array(z.string()),
        failed: z.array(z.object({ messageIds: z.array(z.string()), error: z.string() })),
      },
      annotations: { title: "Bulk modify by query", ...write },
    },
    async ({ query, add, remove, maxMessages }) => {
      if (add.length === 0 && remove.length === 0) {
        throw new Error("bulk_modify needs at least one label in add or remove — nothing to do.");
      }
      const gmail = await client();
      const refs = await gmail.listMessageRefs({ query, max: maxMessages });
      const res = await gmail.batchModifyMessages(refs, add, remove);
      return ok({
        matchedMessages: refs.length,
        modifiedMessages: res.modifiedMessages,
        modifiedThreadCount: res.modifiedThreads.length,
        // Cap the id list — a 10k-thread sweep must not flood the model context.
        modifiedThreads: res.modifiedThreads.slice(0, 500),
        failed: res.failed,
      });
    },
  );

  server.registerTool(
    "archive",
    {
      description:
        "Archive a thread (remove it from the inbox). " +
        "USE WHEN: inbox triage — the thread is handled and should leave the inbox. " +
        "DO NOT USE: to delete (use trash) or to defer to a date (use snooze). " +
        "SIDE EFFECTS: thread leaves the inbox; reversible via modify_labels add INBOX.",
      inputSchema: { threadId: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Archive thread", ...write },
    },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, [], ["INBOX"]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "mark_read",
    {
      description:
        "Mark a thread as read. SIDE EFFECTS: removes UNREAD; reversible via mark_unread.",
      inputSchema: { threadId: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Mark read", ...write },
    },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, [], ["UNREAD"]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "mark_unread",
    {
      description:
        "Mark a thread as unread. SIDE EFFECTS: adds UNREAD; reversible via mark_read.",
      inputSchema: { threadId: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Mark unread", ...write },
    },
    async ({ threadId }) => {
      await (await client()).modifyLabels(threadId, ["UNREAD"], []);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "trash",
    {
      description:
        "Move a thread to Trash. " +
        "USE WHEN: the thread should be discarded. " +
        "DO NOT USE: for inbox cleanup of mail worth keeping (use archive). " +
        "SIDE EFFECTS: thread moves to Trash; recoverable via untrash for ~30 days, then Gmail deletes it permanently.",
      inputSchema: { threadId: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Trash thread", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ threadId }) => {
      await (await client()).trash(threadId);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "untrash",
    {
      description:
        "Restore a thread from Trash. " +
        "SIDE EFFECTS: removes the TRASH label; user labels are preserved, but INBOX is NOT re-added — use modify_labels (add INBOX) to return it to the inbox.",
      inputSchema: { threadId: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Untrash thread", ...write },
    },
    async ({ threadId }) => {
      await (await client()).untrash(threadId);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "download_attachment",
    {
      description:
        "Download an attachment to a local file path. If MAILWARDEN_DOWNLOAD_DIR is set, destPath is resolved inside (and restricted to) that directory. " +
        "USE WHEN: the user wants an attachment saved to disk (IDs come from get_thread's attachment metadata). " +
        "SIDE EFFECTS: writes a local file; never overwrites — an existing file gets a numeric suffix (file-1.pdf). The response's 'saved' field is the path actually used. Mailbox unchanged.",
      inputSchema: { messageId: z.string(), attachmentId: z.string(), destPath: z.string() },
      outputSchema: { saved: z.string() },
      // Not idempotent: a second call with the same args writes a new file
      // (file-1.pdf) rather than reproducing the first result.
      annotations: { title: "Download attachment", ...write, idempotentHint: false },
    },
    async ({ messageId, attachmentId, destPath }) =>
      ok({ saved: await (await client()).downloadAttachment(messageId, attachmentId, destPath) }),
  );

  // ---- Snooze (mailwarden's differentiator) ----
  server.registerTool(
    "snooze",
    {
      description:
        "Snooze a thread until a date (YYYY-MM-DD): archives it now, resurfaces on/after that date when sweep_snoozed runs. " +
        "USE WHEN: deferring a thread to a later date instead of leaving it in the inbox. " +
        "DO NOT USE: for permanent removal (use archive or trash). " +
        "SIDE EFFECTS: removes INBOX, adds a dated MCP/Snoozed label; reversible via unsnooze.",
      inputSchema: {
        threadId: z.string(),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
          .refine(isValidIsoDate, "not a real calendar date")
          .refine((s) => s >= todayIso(), "snooze date is in the past"),
      },
      outputSchema: { threadId: z.string(), snoozedUntil: z.string() },
      annotations: { title: "Snooze thread", ...write },
    },
    async ({ threadId, until }) => ok(await snooze(await client(), threadId, until)),
  );

  server.registerTool(
    "unsnooze",
    {
      description:
        "Cancel a snooze: return the thread to the inbox now. " +
        "SIDE EFFECTS: removes the snooze label, restores INBOX.",
      inputSchema: { threadId: z.string() },
      outputSchema: { threadId: z.string(), unsnoozed: z.boolean() },
      annotations: { title: "Unsnooze thread", ...write },
    },
    async ({ threadId }) => ok(await unsnooze(await client(), threadId)),
  );

  server.registerTool(
    "sweep_snoozed",
    {
      description:
        "Resurface all snoozed threads whose date is due (<= today), batched at 1000 messages per API request. " +
        "USE WHEN: the user asks to process due snoozes, or as a scheduled maintenance call. " +
        "SIDE EFFECTS: due threads return to the inbox marked unread; safe to run repeatedly. failedCount/errors report messages a batch could not wake (their label is kept for the next sweep).",
      outputSchema: {
        date: z.string(),
        wokenCount: z.number(),
        woken: z.array(z.string()),
        failedCount: z.number(),
        errors: z.array(z.string()),
      },
      annotations: { title: "Sweep snoozed", ...write },
    },
    async () => ok(await sweepSnoozed(await client())),
  );
}

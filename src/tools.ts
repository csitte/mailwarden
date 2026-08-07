import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Gmail, filterCriteriaToQuery } from "./gmail.js";
import { getAuth } from "./auth.js";
import { snooze, unsnooze, listSnoozed, sweepSnoozed } from "./snooze.js";
import { buildDigest, friendlyLabelName } from "./digest.js";
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

const filterCriteriaSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  query: z.string().optional(),
  negatedQuery: z.string().optional(),
  hasAttachment: z.boolean().optional(),
  excludeChats: z.boolean().optional(),
  size: z.number().optional(),
  sizeComparison: z.enum(["smaller", "larger"]).optional(),
});

const filterSummarySchema = z.object({
  id: z.string(),
  criteria: filterCriteriaSchema,
  addLabelIds: z.array(z.string()),
  removeLabelIds: z.array(z.string()),
  // Present only when an existing filter forwards mail — surfaced for auditing;
  // create_filter never sets it (a forwarding filter is an exfiltration path).
  forward: z.string().optional(),
});

// Result of optionally applying a new filter's actions to already-arrived mail.
const filterAppliedSchema = z.object({
  query: z.string(),
  matchedMessages: z.number(),
  modifiedMessages: z.number(),
  modifiedThreadCount: z.number(),
  // True when more messages matched than maxMessages — the rest were left untouched.
  capped: z.boolean(),
  failed: z.array(z.object({ messageIds: z.array(z.string()), error: z.string() })),
  // Set only if the whole backlog pass failed AFTER the filter was created — the
  // filter still stands; retry the sweep via bulk_modify with the same query.
  error: z.string().optional(),
});

const okOutput = { ok: z.boolean() };

/** The tool tiers a deployment can enable independently (progressive disclosure). */
export type ToolTier = "read" | "manage" | "filters";
const ALL_TIERS: readonly ToolTier[] = ["read", "manage", "filters"];

/**
 * Which tool tiers to advertise, from the environment:
 *   - `MAILWARDEN_TOOLS` — comma-separated subset of read/manage/filters, authoritative
 *     whenever the variable is DEFINED (a defined-but-blank value is an error, not "default",
 *     so a misconfigured `MAILWARDEN_TOOLS=${UNSET}` never silently opens the full surface);
 *   - else `MAILWARDEN_READONLY=1` — the original binary switch, = the `read` tier only;
 *   - else all tiers.
 * `read` is the usual base (search/get_thread/…); enabling only manage/filters is allowed
 * but leaves the agent without read tools. Unknown or empty values throw at startup.
 */
export function resolveEnabledTiers(env: NodeJS.ProcessEnv): Set<ToolTier> {
  const configured = env.MAILWARDEN_TOOLS;
  if (configured !== undefined) {
    const requested = configured.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = requested.filter((t) => !ALL_TIERS.includes(t as ToolTier));
    if (requested.length === 0 || unknown.length) {
      throw new Error(
        `MAILWARDEN_TOOLS is invalid (${unknown.length ? `unknown: ${unknown.join(", ")}` : "empty"}). ` +
          `Set it to a comma-separated subset of: ${ALL_TIERS.join(", ")}.`,
      );
    }
    return new Set(requested as ToolTier[]);
  }
  if (env.MAILWARDEN_READONLY === "1") return new Set<ToolTier>(["read"]);
  return new Set(ALL_TIERS);
}

export function registerTools(server: McpServer): void {
  const tiers = resolveEnabledTiers(process.env);
  if (tiers.has("read")) registerReadTools(server);
  if (tiers.has("manage")) registerManageTools(server);
  if (tiers.has("filters")) registerFilterTools(server);
}

function registerReadTools(server: McpServer): void {
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
        "USE WHEN: inspecting the mailbox structure, or to get exact label names/ids — though modify_labels/bulk_modify/create_label all accept a plain label name directly, so a lookup is rarely required. " +
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

  server.registerTool(
    "get_profile",
    {
      description:
        "Return the authorized account: email address plus total message/thread counts. " +
        "USE WHEN: confirming WHICH mailbox is connected before a bulk or filter action, or as a cheap liveness check. " +
        "DO NOT USE: to enumerate messages — this returns only counts, not a listing (use search). " +
        "SIDE EFFECTS: none.",
      outputSchema: {
        emailAddress: z.string(),
        messagesTotal: z.number(),
        threadsTotal: z.number(),
      },
      annotations: { title: "Get profile", ...readOnly },
    },
    async () => ok(await (await client()).getProfile()),
  );

  server.registerTool(
    "triage_digest",
    {
      description:
        "Structured overview of a mailbox slice for triage DECISIONS — sender / label / age buckets plus unread and attachment counts, instead of a raw thread list. " +
        "USE WHEN: deciding what to bulk-archive/snooze/label, or summarizing inbox state ('what's in my inbox?'). " +
        "DO NOT USE: to read a specific thread (use search/get_thread). " +
        "Samples up to `max` most-recent matches; hasMore flags that more matched than were sampled. " +
        "byAge buckets by each thread's FIRST message date (thread age, not last activity). SIDE EFFECTS: none.",
      inputSchema: {
        query: z.string().trim().min(1).default("in:inbox"),
        max: z.number().int().min(1).max(100).default(100),
        topN: z.number().int().min(1).max(50).default(10),
      },
      outputSchema: {
        query: z.string(),
        sampled: z.number(),
        hasMore: z.boolean(),
        unread: z.number(),
        withAttachments: z.number(),
        byAge: z.object({
          last24h: z.number(),
          last7d: z.number(),
          last30d: z.number(),
          older: z.number(),
          undated: z.number(),
        }),
        topSenders: z.array(
          z.object({
            sender: z.string(),
            name: z.string(),
            count: z.number(),
            unread: z.number(),
          }),
        ),
        topLabels: z.array(z.object({ label: z.string(), count: z.number() })),
      },
      annotations: { title: "Triage digest", ...readOnly },
    },
    async ({ query, max, topN }) => {
      const gmail = await client();
      const [result, labels] = await Promise.all([gmail.search(query, max), gmail.listLabels()]);
      const nameById = new Map(labels.map((l) => [l.id, l.name]));
      const digest = buildDigest(
        result.threads,
        (id) => friendlyLabelName(id, nameById),
        new Date(),
        { topN },
      );
      // Honest "there may be more than shown": either the listing had further
      // pages, or we filled the sample cap (search caps filtered queries like
      // in:inbox internally, so nextPageToken alone can miss a max-truncated set).
      // Over-reports only when exactly `max` matched — the safe direction.
      const hasMore = result.nextPageToken != null || result.threads.length >= max;
      return ok({ query, hasMore, ...digest });
    },
  );

}

function registerManageTools(server: McpServer): void {
  // ---- Mailbox actions ---- (the `manage` tier: mutations, snooze, downloads)
  server.registerTool(
    "create_label",
    {
      description:
        "Create a user label and return its id. Idempotent: if the name already exists (case-insensitive), its existing id is returned and nothing is created. " +
        "Nested labels: separate levels with '/' (e.g. 'Clients/Acme') — each missing parent level is created too. " +
        "USE WHEN: you want a label's id up front, or to pre-create a label without applying it to anything. " +
        "DO NOT USE: just to file mail under a new label — modify_labels/bulk_modify already auto-create an unknown name passed in `add`. " +
        "SIDE EFFECTS: creates the label if missing; no mail is changed.",
      inputSchema: { name: z.string().min(1) },
      outputSchema: { id: z.string(), name: z.string() },
      annotations: { title: "Create label", ...write },
    },
    async ({ name }) => ok({ id: await (await client()).ensureLabel(name), name }),
  );

  server.registerTool(
    "modify_labels",
    {
      description:
        "Add/remove labels on a thread. Archive = remove 'INBOX'; mark read = remove 'UNREAD'. " +
        "Labels may be given by name or by id: an unknown name in `add` is created automatically (use '/' for nested labels), an unknown name in `remove` is ignored. " +
        "USE WHEN: applying custom labels or label combinations in one call. " +
        "DO NOT USE: for plain archive/read/unread — the dedicated tools are clearer. " +
        "SIDE EFFECTS: changes the thread's labels (and may create a label named in `add`); reversible by the inverse call.",
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
        "Labels may be given by name or by id: an unknown name in `add` is created automatically (use '/' for nested labels), an unknown name in `remove` is ignored. " +
        "Returns matched/modified counts, affected thread IDs (capped at 500 — modifiedThreadCount has the true total), and per-chunk failures (partial success is reported, not hidden). " +
        "If more messages match than maxMessages, only the first maxMessages are processed and 'capped' is true — raise maxMessages or re-run to finish the rest. " +
        "Note: the query hits Gmail's search index as-is, WITHOUT the live re-verification search performs — for read-state-precise bulk ops, verify with search first. " +
        "USE WHEN: mass operations — 'archive all newsletters older than 30 days' (query + remove INBOX), bulk labeling, bulk mark-read. " +
        "DO NOT USE: for a single thread (use modify_labels or the dedicated tools), or with neither add nor remove. " +
        "SIDE EFFECTS: modifies up to maxMessages messages in one call; label changes are reversible by the inverse call.",
      inputSchema: {
        // Non-empty: an empty query would match the ENTIRE mailbox (listMessageRefs
        // omits `q`), turning a bulk op into a whole-mailbox modify.
        query: z.string().trim().min(1),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
        maxMessages: z.number().int().min(1).max(10000).default(1000),
      },
      outputSchema: {
        matchedMessages: z.number(),
        modifiedMessages: z.number(),
        modifiedThreadCount: z.number(),
        modifiedThreads: z.array(z.string()),
        // True when the match set was truncated at maxMessages — more remain unprocessed.
        capped: z.boolean(),
        failed: z.array(z.object({ messageIds: z.array(z.string()), error: z.string() })),
      },
      // destructive: add:['TRASH'] over a broad query bulk-trashes existing mail.
      annotations: { title: "Bulk modify by query", ...write, destructiveHint: true },
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
        // listMessageRefs stops at maxMessages: a full page means more may match.
        capped: refs.length >= maxMessages,
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
        "Snooze a thread until a date or time: archives it now, resurfaces when it comes due and sweep_snoozed runs. " +
        "`until` accepts an explicit date (YYYY-MM-DD), a date+time (YYYY-MM-DD HH:MM or e.g. '2026-06-20 9am'), " +
        "OR a preset resolved server-side: today, tomorrow, weekend (next Saturday), next week (next Monday), " +
        "a weekday name (monday–sunday, next occurrence), 'in N days', or 'in N hours'. A preset may carry a " +
        "trailing time ('tomorrow 9am', 'monday 8:30'). A timed snooze wakes at the next sweep on/after that minute. " +
        "USE WHEN: deferring a thread to a later date/time instead of leaving it in the inbox. " +
        "DO NOT USE: for permanent removal (use archive or trash). " +
        "SIDE EFFECTS: removes INBOX, adds a dated MCP/Snoozed label; reversible via unsnooze.",
      inputSchema: {
        threadId: z.string(),
        until: z.string().trim().min(1),
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

function registerFilterTools(server: McpServer): void {
  // ---- Filters (server-side auto-triage rules) ----
  // Its own `filters` tier: filter management needs the broader gmail.settings.basic
  // scope, which a read-only or triage-only deployment shouldn't have to grant.
  server.registerTool(
    "list_filters",
    {
      description:
        "List all Gmail filters — the server-side rules that auto-apply label actions to incoming mail. " +
        "Shows each filter's criteria and label actions, and (for auditing) any `forward` address an existing filter carries. " +
        "USE WHEN: reviewing existing automation, or to get a filter's id before delete_filter. " +
        "SIDE EFFECTS: none. Requires the gmail.settings.basic scope — re-run `mailwarden --auth` if you authorized an earlier version.",
      outputSchema: { filters: z.array(filterSummarySchema) },
      annotations: { title: "List filters", ...readOnly },
    },
    async () => ok({ filters: await (await client()).listFilters() }),
  );

  server.registerTool(
    "create_filter",
    {
      description:
        "Create a Gmail filter: matching incoming mail automatically gets the given label actions. " +
        "Give at least one criterion and at least one action. Actions are label add/remove only " +
        "(labels by name or id; an unknown name in addLabels is auto-created). Common recipes: " +
        "skip the inbox → removeLabels ['INBOX']; auto-mark-read → removeLabels ['UNREAD']; " +
        "auto-trash → addLabels ['TRASH']; star → addLabels ['STARRED']; file under a label → addLabels ['Receipts']. " +
        "A filter only affects mail arriving AFTER it's created; set applyToExisting:true to ALSO apply the same " +
        "actions once to mail already in the mailbox (builds a Gmail search from the criteria and runs a bulk modify — " +
        "same loose-index caveat as bulk_modify; up to maxMessages, default 1000). " +
        "USE WHEN: setting up a persistent auto-triage rule (e.g. 'always archive + label newsletters from x'), optionally cleaning up the existing backlog too. " +
        "NOTE: forwarding filters are intentionally not supported — mailwarden creates no send/exfiltration path. " +
        "SIDE EFFECTS: adds a server-side rule affecting future mail (reversible via delete_filter); with applyToExisting also modifies existing messages. Requires gmail.settings.basic.",
      inputSchema: {
        // Text criteria are trimmed and must be non-empty — an empty/whitespace
        // value would otherwise be dropped when building the request and leave
        // Gmail with empty criteria (a cryptic 400).
        from: z.string().trim().min(1).optional(),
        to: z.string().trim().min(1).optional(),
        subject: z.string().trim().min(1).optional(),
        query: z.string().trim().min(1).optional(),
        negatedQuery: z.string().trim().min(1).optional(),
        hasAttachment: z.boolean().optional(),
        excludeChats: z.boolean().optional(),
        size: z.number().int().positive().optional(),
        sizeComparison: z.enum(["smaller", "larger"]).optional(),
        addLabels: z.array(z.string()).default([]),
        removeLabels: z.array(z.string()).default([]),
        // Also apply the actions once to mail that already matches (default: future mail only).
        applyToExisting: z.boolean().default(false),
        maxMessages: z.number().int().min(1).max(10000).default(1000),
      },
      // `applied` is null unless applyToExisting was set.
      outputSchema: { ...filterSummarySchema.shape, applied: filterAppliedSchema.nullable() },
      // destructive: with applyToExisting + addLabels:['TRASH'] this bulk-trashes existing mail.
      annotations: { title: "Create filter", ...write, destructiveHint: true, idempotentHint: false },
    },
    async ({ addLabels, removeLabels, applyToExisting, maxMessages, ...criteria }) => {
      // `sizeComparison` and `excludeChats` only MODIFY an otherwise-matching
      // filter, and `negatedQuery` only EXCLUDES — none is a positive match
      // condition on its own. Split them out so each guard can reason precisely.
      const { size, sizeComparison, excludeChats, hasAttachment, negatedQuery, ...positiveText } =
        criteria;
      // size and its comparison are meaningful only as a pair — check first so a
      // lone `size` or lone `sizeComparison` gets this precise message.
      if ((size === undefined) !== (sizeComparison === undefined)) {
        throw new Error(
          "create_filter: 'size' and 'sizeComparison' (smaller|larger) must be given together.",
        );
      }
      const hasPositive =
        size !== undefined ||
        hasAttachment === true ||
        Object.values(positiveText).some((v) => typeof v === "string" && v !== "");
      // A filter itself may match "everything except X" (negatedQuery / hasAttachment:false
      // only), so creation just needs *some* condition.
      const hasMatch =
        hasPositive ||
        hasAttachment === false ||
        (typeof negatedQuery === "string" && negatedQuery !== "");
      if (!hasMatch) {
        throw new Error(
          "create_filter needs at least one match criterion (from/to/subject/query/negatedQuery/hasAttachment/size).",
        );
      }
      if (addLabels.length === 0 && removeLabels.length === 0) {
        throw new Error(
          "create_filter needs at least one label action in addLabels or removeLabels.",
        );
      }
      // Derive the backlog query BEFORE creating anything, so a refusal has no side
      // effects. Two ways the backlog pass could run away over the whole mailbox:
      //   (1) an empty query → listMessageRefs omits `q` and matches everything;
      //   (2) an exclusion-only rule (negatedQuery / hasAttachment:false, no positive
      //       term) → the derived query is `-(…)`, matching ~all mail.
      // Refuse both for applyToExisting; the filter can still be created without it.
      let query: string | null = null;
      if (applyToExisting) {
        if (!hasPositive) {
          throw new Error(
            "create_filter: applyToExisting needs at least one positive criterion " +
              "(from/to/subject/query/hasAttachment:true/size). A rule that only excludes " +
              "(negatedQuery/hasAttachment:false) would match almost the whole mailbox — " +
              "create the filter without applyToExisting, or add a narrowing criterion.",
          );
        }
        query = filterCriteriaToQuery(criteria);
        if (!query) {
          throw new Error(
            "create_filter: applyToExisting could not derive a non-empty search query from the criteria.",
          );
        }
      }
      const gmail = await client();
      const filter = await gmail.createFilter(criteria, { addLabels, removeLabels });
      let applied: {
        query: string;
        matchedMessages: number;
        modifiedMessages: number;
        modifiedThreadCount: number;
        capped: boolean;
        failed: { messageIds: string[]; error: string }[];
        error?: string;
      } | null = null;
      // Best-effort backlog cleanup: the filter is already created, so ANY failure
      // here (a failed list/label-resolve, or per-chunk modify errors) is reported
      // in `applied` — never raised — so the caller learns the rule still stands.
      if (query) {
        try {
          const refs = await gmail.listMessageRefs({ query, max: maxMessages });
          const res = await gmail.batchModifyMessages(refs, addLabels, removeLabels);
          applied = {
            query,
            matchedMessages: refs.length,
            modifiedMessages: res.modifiedMessages,
            modifiedThreadCount: res.modifiedThreads.length,
            capped: refs.length >= maxMessages,
            failed: res.failed,
          };
        } catch (err) {
          applied = {
            query,
            matchedMessages: 0,
            modifiedMessages: 0,
            modifiedThreadCount: 0,
            capped: false,
            failed: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return ok({ ...filter, applied });
    },
  );

  server.registerTool(
    "delete_filter",
    {
      description:
        "Delete a Gmail filter by id (get ids from list_filters). " +
        "USE WHEN: removing an auto-triage rule. " +
        "SIDE EFFECTS: removes the server-side rule; future mail is no longer auto-processed by it. Requires gmail.settings.basic.",
      inputSchema: { id: z.string() },
      outputSchema: okOutput,
      annotations: { title: "Delete filter", ...write, idempotentHint: false },
    },
    async ({ id }) => {
      await (await client()).deleteFilter(id);
      return ok({ ok: true });
    },
  );
}

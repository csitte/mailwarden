import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Gmail, filterCriteriaToQuery, unverifiedPredicates } from "./gmail.js";
import { getAuth, hasFilterScope } from "./auth.js";
import { snooze, unsnooze, listSnoozed, sweepSnoozed } from "./snooze.js";
import { buildDigest, friendlyLabelName } from "./digest.js";
import {
  bulkUnsubscribe,
  inspectUnsubscribe,
  listSubscriptions,
  unsubscribeThread,
} from "./unsubscribe.js";
import { resolveEnabledTiers } from "./tiers.js";
import { ALL_SIGNALS } from "./signals.js";
import { fenceOutput, sanitizeStructured } from "./sanitize.js";
import { classifyError } from "./errors.js";
import { ToolError } from "./cli.js";
export { resolveEnabledTiers, type ToolTier } from "./tiers.js";

/** Fresh authed client per call — cheap, and avoids stale auth in long-lived servers. */
async function client(): Promise<Gmail> {
  return new Gmail(await getAuth(false));
}

/**
 * Every result carries BOTH representations: `structuredContent` (validated
 * against the tool's outputSchema, machine-readable) and a text block with the
 * same JSON fenced as untrusted content — mail bodies are attacker-supplied.
 *
 * Both are built from ONE sanitized object, so the hidden-character strip covers
 * whichever copy the client actually reads. The fence stays text-only: it is a
 * marker for a model reading prose, and it has no place inside JSON a client
 * parses against the outputSchema.
 */
const ok = (obj: object) => {
  const clean = sanitizeStructured(obj) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: fenceOutput(JSON.stringify(clean, null, 2)) }],
    structuredContent: clean,
  };
};

/**
 * The failure counterpart of `ok`. A tool that throws answers with `isError` and a
 * fenced JSON body naming a `code` and whether a retry could help, so a client can
 * branch on the failure instead of pattern-matching a sentence that may be
 * reworded next commit. The sentence stays — it is what a human reads.
 *
 * No `structuredContent`: the SDK validates that against the tool's outputSchema,
 * which describes a *success*. The SDK skips validation entirely for `isError`
 * results, so the error body belongs in the text block.
 */
const fail = (err: unknown) => ({
  isError: true as const,
  content: [
    { type: "text" as const, text: fenceOutput(JSON.stringify({ error: classifyError(err) }, null, 2)) },
  ],
});

/**
 * `server.registerTool` with the error envelope wrapped around the handler, so no
 * tool can forget it. Returned as the same type it wraps, which keeps every call
 * site (and its schema inference) exactly as it was.
 */
function guarded(server: McpServer): McpServer["registerTool"] {
  const register = server.registerTool.bind(server);
  return ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    register(
      name as never,
      config as never,
      (async (...args: unknown[]) => {
        try {
          return await cb(...args);
        } catch (err) {
          return fail(err);
        }
      }) as never,
    )) as McpServer["registerTool"];
}

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

// Header/MIME-derived triage flags (see signals.ts). Only the ones that fire are listed.
const signalSchema = z.enum(ALL_SIGNALS as [(typeof ALL_SIGNALS)[number], ...(typeof ALL_SIGNALS)[number][]]);

const threadSummarySchema = z.object({
  threadId: z.string(),
  messageCount: z.number(),
  from: z.string(),
  subject: z.string(),
  date: z.string(),
  labelIds: z.array(z.string()),
  snippet: z.string(),
  hasAttachments: z.boolean(),
  signals: z.array(signalSchema),
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

const unsubscribeOptionsSchema = z.object({
  oneClick: z.boolean(),
  httpsUrls: z.array(z.string()),
  mailtos: z.array(z.string()),
});

export function registerTools(server: McpServer): void {
  const tiers = resolveEnabledTiers(process.env);
  if (tiers.has("read")) registerReadTools(server);
  if (tiers.has("manage")) registerManageTools(server);
  if (tiers.has("filters")) {
    // Scope-gate the filters tier: advertise it only when the stored token
    // actually carries gmail.settings.basic. `false` = a token known to lack it
    // (skip + tell the user), `undefined` = unknown (no token yet, an old token
    // without a recorded scope, or an encrypted one) → keep the prior behavior of
    // advertising and letting the runtime insufficient-scope message guide re-auth.
    if (hasFilterScope() === false) {
      console.error(
        "mailwarden: the 'filters' tier is enabled but the stored token lacks the " +
          "gmail.settings.basic scope — filter tools are hidden. Re-run `mailwarden --auth` to grant it.",
      );
    } else {
      registerFilterTools(server);
    }
  }
}

function registerReadTools(server: McpServer): void {
  const registerTool = guarded(server);
  // ---- Read / find ----
  registerTool(
    "search",
    {
      description:
        "Search Gmail with native query syntax (e.g. 'in:inbox from:foo@bar.com newer_than:7d'). Returns thread summaries; read-state/category predicates are re-verified against each hit's live labels. " +
        "Each summary carries `signals` derived from the thread's first message headers/MIME — newsletter (List-Id/List-Unsubscribe/Precedence bulk or list), automated (Auto-Submitted, auto-reply/suppress headers, no-reply-style senders), calendar (text/calendar or .ics part), replyToMismatch (a Reply-To on another domain than From — a subdomain of the same domain counts as the same); empty when nothing is declared. " +
        "Paginated: when more results exist, the response carries a nextPageToken — pass it back via pageToken to fetch the next page. " +
        "A page can come back with FEWER threads than maxResults and still have a nextPageToken: false positives from the index consume the scan window, and on a mailbox whose read state the index has fallen behind on, most candidates for an is:unread query can be already-read mail. A short page is therefore not evidence that the result set is exhausted — only an absent nextPageToken is. " +
        "SPAM AND TRASH ARE EXCLUDED unless the query names them. Gmail leaves both out of any query that does not say `in:spam` / `in:trash`, so a plain `from:someone` returns nothing for a mail that is sitting in spam — measured against a live mailbox, not assumed. Nothing in the result marks the omission, so treat 'no hits' as 'none outside spam and trash'. " +
        "When mail the user expects is missing, retry with `in:spam` before reporting that it does not exist: mail is often filed as spam because of something the user just did — a signup, a password reset, an order confirmation — which is precisely what a spam filter cannot know and the caller often can. " +
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    "triage_digest",
    {
      description:
        "Structured overview of a mailbox slice for triage DECISIONS — sender / label / age buckets, unread and attachment counts, and header-derived signals (newsletter / automated / calendar / replyToMismatch — thread counts overall, and per sender the set of signals its threads carry), instead of a raw thread list. " +
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
        signals: z.object({
          newsletter: z.number(),
          automated: z.number(),
          calendar: z.number(),
          replyToMismatch: z.number(),
        }),
        topSenders: z.array(
          z.object({
            sender: z.string(),
            name: z.string(),
            count: z.number(),
            unread: z.number(),
            signals: z.array(signalSchema),
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

  registerTool(
    "list_unsubscribe",
    {
      description:
        "Report the opt-out options a thread advertises (List-Unsubscribe / RFC 8058), without contacting anyone. " +
        "Reads the newest message that carries the header, so a reply threaded onto a newsletter does not hide it. " +
        "`oneClick` means the sender supports the automatable one-click opt-out — the `unsubscribe` tool can perform it. " +
        "`httpsUrls` without oneClick are links for a human to open in a browser; `mailtos` would require sending mail, which mailwarden never does. " +
        "USE WHEN: checking whether a newsletter can be unsubscribed from, or showing the user the link to click. " +
        "SIDE EFFECTS: none — no request is made to the sender.",
      inputSchema: { threadId: z.string() },
      outputSchema: {
        threadId: z.string(),
        messageId: z.string(),
        from: z.string(),
        subject: z.string(),
        hasUnsubscribe: z.boolean(),
        ...unsubscribeOptionsSchema.shape,
      },
      annotations: { title: "List unsubscribe options", ...readOnly },
    },
    async ({ threadId }) => ok(await inspectUnsubscribe(await client(), threadId)),
  );

  registerTool(
    "list_subscriptions",
    {
      description:
        "Who keeps writing, how often, and whether you can get off the list — a mailbox slice grouped by SENDER, each row carrying its opt-out options. " +
        "Contacts nobody: opt-out options come from the List-Unsubscribe header of each sender's newest thread (one metadata fetch per sender, not per thread). " +
        "`optOut` is 'one-click' (the unsubscribe tool can perform it), 'link' (a human opens it in a browser), 'mailto' (would need sending, which mailwarden never does), 'none', or 'unknown' when that sender's header fetch failed. " +
        "`oldestDate`/`newestDate` bound what the SAMPLE saw of that sender, not the sender's whole history — a query capped at `max` reaches back only as far as those threads go, which on a busy mailbox is days. There is deliberately NO precomputed frequency: judge it from `threads` across that span, with the sampling caveat in view. " +
        "`newestThreadId` is what to hand to unsubscribe or bulk_unsubscribe. " +
        "`sendersFound` is how many DISTINCT senders the sample held — when it exceeds topN, the list is truncated and raising topN shows more. " +
        "USE WHEN: 'what am I subscribed to', 'which newsletters flood me', or picking targets before a bulk unsubscribe. " +
        "DO NOT USE: for a general inbox overview (use triage_digest — it buckets by label and age too), or for one known thread (use list_unsubscribe). " +
        "SIDE EFFECTS: none.",
      inputSchema: {
        // Promotions is where mailing lists land; the caller can widen it.
        query: z.string().trim().min(1).default("category:promotions"),
        max: z.number().int().min(1).max(100).default(100),
        topN: z.number().int().min(1).max(25).default(10),
      },
      outputSchema: {
        query: z.string(),
        sampled: z.number(),
        hasMore: z.boolean(),
        sendersFound: z.number(),
        subscriptions: z.array(
          z.object({
            sender: z.string(),
            name: z.string(),
            threads: z.number(),
            unread: z.number(),
            newestThreadId: z.string(),
            newestDate: z.string(),
            oldestDate: z.string(),
            optOut: z.enum(["one-click", "link", "mailto", "none", "unknown"]),
            options: unsubscribeOptionsSchema,
          }),
        ),
      },
      annotations: { title: "List subscriptions by sender", ...readOnly },
    },
    async ({ query, max, topN }) => {
      const gmail = await client();
      const result = await gmail.search(query, max);
      const { subscriptions, sendersFound } = await listSubscriptions(gmail, result.threads, { topN });
      // Same honest over-reporting rule as triage_digest: a filled sample may hide more.
      const hasMore = result.nextPageToken != null || result.threads.length >= max;
      return ok({ query, sampled: result.threads.length, hasMore, sendersFound, subscriptions });
    },
  );

}

function registerManageTools(server: McpServer): void {
  const registerTool = guarded(server);
  // Unlike the filters tier, manage is NOT scope-gated: gmail.modify is the default
  // grant so almost every token has it, and hasModifyScope() is `undefined` (unknown)
  // for the common encrypted/old-token case — gating here would either do nothing or
  // hide tools from users who can actually write. A genuine mismatch (broader runtime
  // MAILWARDEN_TOOLS than the token was authorized for) fails gracefully at call time
  // via the insufficient-scope message in gmail.ts; the sweep paths warn in index.ts.
  // ---- Mailbox actions ---- (the `manage` tier: mutations, snooze, downloads)
  registerTool(
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

  registerTool(
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

  registerTool(
    "bulk_modify",
    {
      description:
        "Bulk-apply label changes to every message matching a Gmail query, batched at 1000 messages per API request. " +
        "Labels may be given by name or by id: an unknown name in `add` is created automatically (use '/' for nested labels), an unknown name in `remove` is ignored. " +
        "Returns matched/modified counts, matched and modified thread IDs (both lists capped at 500 — matchedThreadCount/modifiedThreadCount hold the true totals), and per-chunk failures (partial success is reported, not hidden). " +
        "If more messages match than maxMessages, only the first maxMessages are processed and 'capped' is true — raise maxMessages or re-run to finish the rest. " +
        "NOTE: the query hits Gmail's search index as-is, WITHOUT the live re-verification search performs. The staleness that makes search re-verify was measured on `threads.list` (132 threads returned, 114 carrying no unread message at all); the same query through the message index this tool uses returned 19 hits, none stale — same mailbox, same minute. So the known drift does not reach this path, but that is one measurement, not a guarantee: `unverifiedPredicates` in the result names the conditions taken on the index's word, and when the outcome must be read-state-precise, resolve the set with search (which verifies against live labels) and act on those thread ids instead. " +
        "Set dryRun:true to rehearse: the same query resolution, matched counts/threads and the labels that would be created — and no message or label is touched. A dry run reads the SAME unverified index, so it confirms the size of the set, never its correctness. " +
        "USE WHEN: mass operations — 'archive all newsletters older than 30 days' (query + remove INBOX), bulk labeling, bulk mark-read; dryRun first when the query is broad or the user should see the set before it changes. " +
        "DO NOT USE: for a single thread (use modify_labels or the dedicated tools), or with neither add nor remove. " +
        "SIDE EFFECTS: modifies up to maxMessages messages in one call (none with dryRun); label changes are reversible by the inverse call.",
      inputSchema: {
        // Non-empty: an empty query would match the ENTIRE mailbox (listMessageRefs
        // omits `q`), turning a bulk op into a whole-mailbox modify.
        query: z.string().trim().min(1),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
        maxMessages: z.number().int().min(1).max(10000).default(1000),
        dryRun: z.boolean().default(false),
      },
      outputSchema: {
        dryRun: z.boolean(),
        matchedMessages: z.number(),
        matchedThreadCount: z.number(),
        matchedThreads: z.array(z.string()),
        modifiedMessages: z.number(),
        modifiedThreadCount: z.number(),
        modifiedThreads: z.array(z.string()),
        // True when the match set was truncated at maxMessages — more remain unprocessed.
        capped: z.boolean(),
        // Conditions in the query that search would have re-verified and this tool did not
        // (`+LABEL` = must be present, `-LABEL` = must be absent). Empty = nothing to distrust.
        unverifiedPredicates: z.array(z.string()),
        // Dry run only: names in `add` that don't exist yet and a real run would create.
        labelsToCreate: z.array(z.string()).optional(),
        failed: z.array(z.object({ messageIds: z.array(z.string()), error: z.string() })),
      },
      // destructive: add:['TRASH'] over a broad query bulk-trashes existing mail.
      annotations: { title: "Bulk modify by query", ...write, destructiveHint: true },
    },
    async ({ query, add, remove, maxMessages, dryRun }) => {
      if (add.length === 0 && remove.length === 0) {
        throw new ToolError("invalid_input", "bulk_modify needs at least one label in add or remove — nothing to do.");
      }
      const gmail = await client();
      const refs = await gmail.listMessageRefs({ query, max: maxMessages });
      const matchedThreads = [...new Set(refs.map((r) => r.threadId))];
      // Both id lists are capped — a 10k-thread sweep must not flood the model context.
      const shared = {
        matchedMessages: refs.length,
        matchedThreadCount: matchedThreads.length,
        matchedThreads: matchedThreads.slice(0, 500),
        // listMessageRefs stops at maxMessages: a full page means more may match.
        capped: refs.length >= maxMessages,
        // Say which conditions rest on the index alone — in the dry run too, so a rehearsal
        // cannot be mistaken for verification (it re-reads the same index).
        unverifiedPredicates: unverifiedPredicates(query),
      };
      if (dryRun) {
        return ok({
          dryRun: true,
          ...shared,
          modifiedMessages: 0,
          modifiedThreadCount: 0,
          modifiedThreads: [],
          labelsToCreate: await gmail.unknownLabelNames(add),
          failed: [],
        });
      }
      const res = await gmail.batchModifyMessages(refs, add, remove);
      return ok({
        dryRun: false,
        ...shared,
        modifiedMessages: res.modifiedMessages,
        modifiedThreadCount: res.modifiedThreads.length,
        modifiedThreads: res.modifiedThreads.slice(0, 500),
        failed: res.failed,
      });
    },
  );

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    "unsubscribe",
    {
      description:
        "Unsubscribe from the mailing list a thread came from, via the sender's RFC 8058 one-click endpoint. " +
        "There is deliberately no URL parameter: the endpoint is taken from the message's own List-Unsubscribe header and nowhere else. " +
        "Only https one-click endpoints are called (fixed request body, response body discarded); a plain link is reported for the user to open, " +
        "and a mailto: opt-out is never performed because mailwarden cannot send mail. " +
        "If the sender offers nothing automatable this returns unsubscribed:false with the alternatives in `options` — it is not an error. " +
        "USE WHEN: the user wants off a newsletter. Pair with archive/trash or create_filter to deal with mail already in the mailbox. " +
        "DO NOT USE: to check whether unsubscribing is possible (use list_unsubscribe — it contacts nobody). " +
        "A sender already contacted in this session is reported with `duplicateOf` and NOT contacted again — safe to retry after a timeout. Pass force:true for a deliberate second attempt (e.g. the endpoint answered 500). " +
        "SIDE EFFECTS: makes an outbound HTTPS request to the sender's unsubscribe endpoint (plus up to 3 redirects) — the only non-Google host mailwarden ever contacts. " +
        "This confirms to the sender that the address is live, and it cannot be undone. The mailbox itself is not changed.",
      inputSchema: { threadId: z.string(), force: z.boolean().default(false) },
      outputSchema: {
        threadId: z.string(),
        messageId: z.string(),
        from: z.string(),
        unsubscribed: z.boolean(),
        url: z.string().optional(),
        status: z.number().optional(),
        reason: z.string().optional(),
        duplicateOf: z.string().optional(),
        options: unsubscribeOptionsSchema,
      },
      // openWorld: this is the one tool that reaches beyond the Gmail account.
      // Idempotent by default: a sender already contacted in this session is
      // refused rather than contacted again, so a retry costs them nothing.
      annotations: {
        title: "Unsubscribe from mailing list",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ threadId, force }) => ok(await unsubscribeThread(await client(), threadId, undefined, { force })),
  );

  registerTool(
    "bulk_unsubscribe",
    {
      description:
        "Unsubscribe from several mailing lists in one call, one thread id per list. " +
        "Threads are processed SEQUENTIALLY, and at most ONE request is made per sender — a second thread from a sender whose request already went out is reported with `duplicateOf` and no request (and says so when it advertises a DIFFERENT endpoint, i.e. is probably a separate list from the same sender). " +
        "The whole call shares a 60-second budget; threads left over when it runs out come back with `skippedOutOfTime` and a reason, so re-running with the remaining ids finishes the job. " +
        "Like unsubscribe, there is no URL parameter: every endpoint comes from that thread's own List-Unsubscribe header. Only RFC 8058 one-click senders are contacted; the rest come back with their alternatives in `options`. " +
        "Partial success is reported, never hidden: a thread that cannot be read or whose endpoint fails becomes an entry with a `reason`, and the remaining threads still run. " +
        "Set dryRun:true to rehearse: same header reads, same per-sender dedupe (as a real run with every request succeeding), and each entry a real run would contact reports the endpoint it `wouldCall`; refusals and duplicates carry none — and nobody is contacted. " +
        "USE WHEN: clearing out several newsletters at once — pair with list_subscriptions, which gives you the sender rows and their newestThreadId; dryRun first to show the user which senders would be contacted. " +
        "DO NOT USE: for one thread (use unsubscribe), or to find candidates (use list_subscriptions — it contacts nobody). " +
        "SIDE EFFECTS: up to one outbound HTTPS request per DISTINCT sender (plus up to 3 redirects each) — the only non-Google hosts mailwarden ever contacts (none with dryRun). " +
        "Each confirms to that sender that the address is live, and none of it can be undone. The mailbox itself is not changed.",
      inputSchema: {
        // Capped low on purpose: every entry is an irreversible outbound request to
        // a third party, so a mistaken call should be small enough to survive.
        threadIds: z.array(z.string().min(1)).min(1).max(25),
        dryRun: z.boolean().default(false),
      },
      outputSchema: {
        dryRun: z.boolean(),
        requested: z.number(),
        attempted: z.number(),
        unsubscribed: z.number(),
        skippedDuplicates: z.number(),
        skippedOutOfTime: z.number(),
        // Requests a real run would make (dry run) / did make (real run).
        requests: z.number(),
        results: z.array(
          z.object({
            threadId: z.string(),
            messageId: z.string(),
            from: z.string(),
            unsubscribed: z.boolean(),
            url: z.string().optional(),
            status: z.number().optional(),
            reason: z.string().optional(),
            duplicateOf: z.string().optional(),
            wouldCall: z.string().optional(),
            options: unsubscribeOptionsSchema,
          }),
        ),
      },
      annotations: {
        title: "Unsubscribe from several lists",
        readOnlyHint: false,
        destructiveHint: false,
        // Idempotent in effect: re-running contacts nobody already contacted.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ threadIds, dryRun }) =>
      ok(await bulkUnsubscribe(await client(), threadIds, undefined, { dryRun })),
  );

  // ---- Snooze (mailwarden's differentiator) ----
  registerTool(
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

  registerTool(
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

  registerTool(
    "sweep_snoozed",
    {
      description:
        "Resurface all snoozed threads whose date is due (<= today), batched at 1000 messages per API request. " +
        "Set dryRun:true to rehearse: reports the due labels and threads (dueLabels/dueThreads) as the sweep would find them (from the live label listing; a single snooze label with more than 5000 messages is under-counted in the rehearsal), and wakes nothing. " +
        "USE WHEN: the user asks to process due snoozes, or as a scheduled maintenance call; dryRun to answer 'what is due right now?' without acting. " +
        "SIDE EFFECTS: due threads return to the inbox marked unread (none with dryRun); safe to run repeatedly. failedCount/errors report messages a batch could not wake (their label is kept for the next sweep).",
      inputSchema: { dryRun: z.boolean().default(false) },
      outputSchema: {
        date: z.string(),
        dryRun: z.boolean(),
        dueLabels: z.array(z.string()),
        dueThreadCount: z.number(),
        dueThreads: z.array(z.string()),
        wokenCount: z.number(),
        woken: z.array(z.string()),
        failedCount: z.number(),
        errors: z.array(z.string()),
      },
      annotations: { title: "Sweep snoozed", ...write },
    },
    async ({ dryRun }) => ok(await sweepSnoozed(await client(), new Date(), { dryRun })),
  );

}

function registerFilterTools(server: McpServer): void {
  const registerTool = guarded(server);
  // ---- Filters (server-side auto-triage rules) ----
  // Its own `filters` tier: filter management needs the broader gmail.settings.basic
  // scope, which a read-only or triage-only deployment shouldn't have to grant.
  registerTool(
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

  registerTool(
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
        "same unverified-index caveat as bulk_modify — the sweep acts on what the index returns, which can be badly stale on read state; up to maxMessages, default 1000). " +
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
        throw new ToolError(
          "invalid_input",
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
        throw new ToolError(
          "invalid_input",
          "create_filter needs at least one match criterion (from/to/subject/query/negatedQuery/hasAttachment/size).",
        );
      }
      if (addLabels.length === 0 && removeLabels.length === 0) {
        throw new ToolError(
          "invalid_input",
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
          throw new ToolError(
            "invalid_input",
            "create_filter: applyToExisting needs at least one positive criterion " +
              "(from/to/subject/query/hasAttachment:true/size). A rule that only excludes " +
              "(negatedQuery/hasAttachment:false) would match almost the whole mailbox — " +
              "create the filter without applyToExisting, or add a narrowing criterion.",
          );
        }
        query = filterCriteriaToQuery(criteria);
        if (!query) {
          throw new ToolError(
            "invalid_input",
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
      // Deliberately NO `unverifiedPredicates` here, unlike bulk_modify — do not "fix" this by
      // adding the field. The query is BUILT from the criteria (filterCriteriaToQuery), which wraps
      // a caller's `query` criterion in parentheses, and parenthesised queries yield no predicates
      // by design (deriveLabelFilters bails on boolean grouping). The field would therefore report
      // `[]` — which means "nothing to distrust" — for criteria that do carry `is:unread` inside
      // those parens. An empty list that actually means "could not tell" is worse than no list at
      // all, so the caveat stays in the tool description, where it holds unconditionally.
      //
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

  registerTool(
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

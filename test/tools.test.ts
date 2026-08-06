import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools.js";
import { getAuth } from "../src/auth.js";

// getAuth is the only seam to the outside world. It may return a ready-made
// gmail_v1.Gmail (anything with a `users` object) — the Gmail class then uses
// it directly, so tools run end-to-end against a fake API.
vi.mock("../src/auth.js", () => ({ getAuth: vi.fn() }));

async function connect() {
  const server = new McpServer({ name: "mailwarden", version: "0.0.0" });
  registerTools(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("registerTools — tool surface", () => {
  it("registers all 21 tools by default, each with annotations and an outputSchema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(21);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBeDefined();
      expect(t.outputSchema, t.name).toBeDefined();
    }
  });

  it("MAILWARDEN_READONLY=1 registers ONLY the read tools", async () => {
    vi.stubEnv("MAILWARDEN_READONLY", "1");
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_profile",
      "get_thread",
      "list_labels",
      "list_snoozed",
      "search",
      "triage_digest",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe("tool results — structured content + fenced text", () => {
  it("list_labels returns validated structuredContent and the same JSON fenced as text", async () => {
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: {
          list: async () => ({
            data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
          }),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "list_labels", arguments: {} });

    expect(res.structuredContent).toEqual({
      labels: [{ id: "INBOX", name: "INBOX", type: "system" }],
    });
    const text = res.content[0].text as string;
    expect(text.startsWith("<untrusted-tool-output>")).toBe(true);
    expect(text).toContain('"name": "INBOX"');
  });

  it("get_profile returns the account address and mailbox totals", async () => {
    (getAuth as Mock).mockResolvedValue({
      users: {
        getProfile: async () => ({
          data: {
            emailAddress: "me@example.com",
            messagesTotal: 1200,
            threadsTotal: 640,
            historyId: "99001", // present on the API response but not surfaced by the tool
          },
        }),
      },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "get_profile", arguments: {} });

    expect(res.structuredContent).toEqual({
      emailAddress: "me@example.com",
      messagesTotal: 1200,
      threadsTotal: 640,
    });
    expect(res.content[0].text.startsWith("<untrusted-tool-output>")).toBe(true);
  });

  it("triage_digest aggregates a search slice into sender/label/age buckets", async () => {
    const messages: Record<string, any> = {
      t1: {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD", "Label_7"],
        snippet: "hi",
        payload: {
          headers: [
            { name: "From", value: "Alice <alice@x.com>" },
            { name: "Subject", value: "Hello" },
            { name: "Date", value: "Mon, 01 Jun 2026 10:00:00 +0000" },
          ],
        },
      },
      t2: {
        id: "m2",
        threadId: "t2",
        labelIds: ["INBOX"],
        snippet: "yo",
        payload: {
          headers: [
            { name: "From", value: "bob@y.com" },
            { name: "Subject", value: "Re: stuff" },
            { name: "Date", value: "Tue, 02 Jun 2026 09:00:00 +0000" },
          ],
        },
      },
    };
    (getAuth as Mock).mockResolvedValue({
      users: {
        threads: {
          list: async () => ({ data: { threads: [{ id: "t1" }, { id: "t2" }] } }),
          get: async (req: any) => ({ data: { messages: [messages[req.id]] } }),
        },
        labels: {
          list: async () => ({
            data: {
              labels: [
                { id: "Label_7", name: "Work", type: "user" },
                { id: "INBOX", name: "INBOX", type: "system" },
              ],
            },
          }),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "triage_digest", arguments: {} });

    const d = res.structuredContent;
    expect(d.query).toBe("in:inbox");
    expect(d.sampled).toBe(2);
    expect(d.hasMore).toBe(false);
    expect(d.unread).toBe(1);
    expect(d.withAttachments).toBe(0);
    // Both senders appear once; tie broken alphabetically by address.
    expect(d.topSenders).toEqual([
      { sender: "alice@x.com", name: "Alice", count: 1, unread: 1 },
      { sender: "bob@y.com", name: "", count: 1, unread: 0 },
    ]);
    // INBOX/UNREAD are skipped; the user label maps to its friendly name.
    expect(d.topLabels).toEqual([{ label: "Work", count: 1 }]);
    expect(Object.values(d.byAge).reduce((a: number, b: any) => a + b, 0)).toBe(2);
  });

  it("triage_digest reports hasMore when the sample cap truncates the matches", async () => {
    const msg = (id: string, thr: string) => ({
      id,
      threadId: thr,
      labelIds: ["INBOX"],
      snippet: "",
      payload: { headers: [{ name: "From", value: `${thr}@x.com` }, { name: "Date", value: "" }] },
    });
    (getAuth as Mock).mockResolvedValue({
      users: {
        threads: {
          // Two inbox threads, single list page (no nextPageToken).
          list: async () => ({ data: { threads: [{ id: "t1" }, { id: "t2" }] } }),
          get: async (req: any) => ({ data: { messages: [msg("m", req.id)] } }),
        },
        labels: { list: async () => ({ data: { labels: [] } }) },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "triage_digest", arguments: { max: 1 } });

    // Only 1 of 2 sampled, and no nextPageToken — hasMore must still be true,
    // not falsely claim the digest covers the whole inbox.
    expect(res.structuredContent.sampled).toBe(1);
    expect(res.structuredContent.hasMore).toBe(true);
  });

  it("create_label creates an unknown name and returns its id + name", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: {
          list: async () => ({ data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] } }),
          create: async (req: any) => (created.push(req), { data: { id: "Label_42" } }),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_label",
      arguments: { name: "Clients/Acme" },
    });

    expect(created).toHaveLength(1);
    expect(created[0].requestBody.name).toBe("Clients/Acme");
    expect(res.structuredContent).toEqual({ id: "Label_42", name: "Clients/Acme" });
  });

  it("create_label is idempotent: an existing name returns its id without creating", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: {
          list: async () => ({ data: { labels: [{ id: "Label_9", name: "ToDo", type: "user" }] } }),
          create: async (req: any) => (created.push(req), { data: { id: "Label_NEW" } }),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_label",
      arguments: { name: "todo" }, // case-insensitive match of the existing "ToDo"
    });

    expect(created).toHaveLength(0);
    expect(res.structuredContent).toEqual({ id: "Label_9", name: "todo" });
  });

  it("bulk_modify lists by query, batches, and reports partial success", async () => {
    const batchBodies: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        messages: {
          list: async () => ({
            data: {
              messages: [
                { id: "m1", threadId: "t1" },
                { id: "m2", threadId: "t1" },
                { id: "m3", threadId: "t2" },
              ],
            },
          }),
          batchModify: async (req: any) => {
            batchBodies.push(req.requestBody);
            return {};
          },
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "bulk_modify",
      arguments: { query: "category:promotions older_than:30d", remove: ["INBOX"] },
    });

    expect(batchBodies[0]).toEqual({ ids: ["m1", "m2", "m3"], addLabelIds: [], removeLabelIds: ["INBOX"] });
    expect(res.structuredContent).toEqual({
      matchedMessages: 3,
      modifiedMessages: 3,
      modifiedThreadCount: 2,
      modifiedThreads: ["t1", "t2"],
      capped: false, // 3 matched, well under the default maxMessages
      failed: [],
    });
  });

  it("bulk_modify flags capped:true when the match set fills maxMessages", async () => {
    (getAuth as Mock).mockResolvedValue({
      users: {
        messages: {
          // Every list page is full and always offers another token → the cap,
          // not exhaustion, stops the scan. maxMessages=2 keeps the fixture tiny.
          list: async (req: any) => ({
            data: {
              messages: Array.from({ length: req.maxResults }, (_, i) => ({
                id: `m${i}`,
                threadId: `t${i}`,
              })),
              nextPageToken: "more",
            },
          }),
          batchModify: async () => ({}),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "bulk_modify",
      arguments: { query: "in:inbox", remove: ["INBOX"], maxMessages: 2 },
    });
    expect(res.structuredContent.matchedMessages).toBe(2);
    expect(res.structuredContent.capped).toBe(true);
  });

  it("list_filters maps criteria + label actions and surfaces an existing forward for auditing", async () => {
    (getAuth as Mock).mockResolvedValue({
      users: {
        settings: {
          filters: {
            list: async () => ({
              data: {
                filter: [
                  {
                    id: "f1",
                    criteria: { from: "news@x.com", hasAttachment: false },
                    action: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] },
                  },
                  {
                    id: "f2",
                    criteria: { subject: "invoice" },
                    action: { forward: "someone@elsewhere.com" },
                  },
                ],
              },
            }),
          },
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "list_filters", arguments: {} });
    expect(res.structuredContent.filters).toEqual([
      {
        id: "f1",
        criteria: { from: "news@x.com", hasAttachment: false },
        addLabelIds: ["Label_7"],
        removeLabelIds: ["INBOX"],
      },
      {
        id: "f2",
        criteria: { subject: "invoice" },
        addLabelIds: [],
        removeLabelIds: [],
        forward: "someone@elsewhere.com", // surfaced so a user can spot/audit it
      },
    ]);
  });

  it("create_filter resolves label names to ids and sends only label actions (never forward)", async () => {
    const bodies: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: {
          list: async () => ({ data: { labels: [{ id: "Label_5", name: "Newsletters", type: "user" }] } }),
          create: async () => ({ data: { id: "SHOULD_NOT_CREATE" } }),
        },
        settings: {
          filters: {
            create: async (req: any) => {
              bodies.push(req.requestBody);
              return { data: { id: "f-new", criteria: req.requestBody.criteria, action: req.requestBody.action } };
            },
          },
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "news@x.com", addLabels: ["Newsletters"], removeLabels: ["INBOX"] },
    });

    expect(bodies[0]).toEqual({
      criteria: { from: "news@x.com" },
      action: { addLabelIds: ["Label_5"], removeLabelIds: ["INBOX"] }, // name → id, no forward key
    });
    expect(bodies[0].action).not.toHaveProperty("forward");
    expect(res.structuredContent.id).toBe("f-new");
  });

  it("create_filter applyToExisting also bulk-modifies matching existing mail and reports it", async () => {
    const created: any[] = [];
    const batched: any[] = [];
    let listQuery: string | undefined;
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: { list: async () => ({ data: { labels: [{ id: "Label_5", name: "Newsletters", type: "user" }] } }) },
        settings: {
          filters: {
            create: async (r: any) => (created.push(r.requestBody), { data: { id: "f-x", ...r.requestBody } }),
          },
        },
        messages: {
          list: async (req: any) => (
            (listQuery = req.q),
            { data: { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] } }
          ),
          batchModify: async (req: any) => (batched.push(req.requestBody), {}),
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: {
        from: "news@x.com",
        addLabels: ["Newsletters"],
        removeLabels: ["INBOX"],
        applyToExisting: true,
      },
    });

    expect(created).toHaveLength(1);
    expect(listQuery).toBe('from:"news@x.com"'); // query derived from the criteria (plain value quoted)
    expect(batched[0]).toEqual({ ids: ["m1", "m2"], addLabelIds: ["Label_5"], removeLabelIds: ["INBOX"] });
    expect(res.structuredContent.id).toBe("f-x");
    expect(res.structuredContent.applied).toMatchObject({
      query: 'from:"news@x.com"',
      matchedMessages: 2,
      modifiedMessages: 2,
      modifiedThreadCount: 2,
      capped: false,
      failed: [],
    });
  });

  it("create_filter refuses applyToExisting for an exclusion-only rule (no whole-mailbox sweep)", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        settings: { filters: { create: async (r: any) => (created.push(r), { data: { id: "f-z" } }) } },
        messages: { list: async () => ({ data: {} }) },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      // negatedQuery-only → derived query would be `-(...)`, matching ~everything
      arguments: { negatedQuery: "unsubscribe", addLabels: ["TRASH"], applyToExisting: true },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/at least one positive criterion/);
    expect(created).toHaveLength(0); // filter not created either — refused before side effects
  });

  it("create_filter reports a backlog failure in applied.error without raising (filter still created)", async () => {
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: { list: async () => ({ data: { labels: [] } }) },
        settings: { filters: { create: async (r: any) => ({ data: { id: "f-e", ...r.requestBody } }) } },
        messages: {
          list: async () => {
            throw new Error("transient list failure");
          },
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "news@x.com", addLabels: ["INBOX"], applyToExisting: true },
    });
    expect(res.isError).toBeFalsy(); // filter was created — the backlog failure must not raise
    expect(res.structuredContent.id).toBe("f-e");
    expect(res.structuredContent.applied.error).toMatch(/transient list failure/);
  });

  it("create_filter leaves applied null when applyToExisting is not set", async () => {
    const listCalls: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: { list: async () => ({ data: { labels: [{ id: "Label_5", name: "Newsletters", type: "user" }] } }) },
        settings: { filters: { create: async (r: any) => ({ data: { id: "f-y", ...r.requestBody } }) } },
        messages: { list: async (req: any) => (listCalls.push(req), { data: {} }) },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "news@x.com", addLabels: ["Newsletters"] },
    });
    expect(res.structuredContent.applied).toBeNull();
    expect(listCalls).toHaveLength(0); // no backlog scan when not requested
  });

  it("create_filter rejects a call with no criterion, and one with no action", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { settings: { filters: { create: async (r: any) => (created.push(r), { data: {} }) } } },
    });
    const client = await connect();

    const noCriterion: any = await client.callTool({
      name: "create_filter",
      arguments: { addLabels: ["INBOX"] },
    });
    expect(noCriterion.isError).toBe(true);
    expect(noCriterion.content[0].text).toMatch(/at least one match criterion/);

    const noAction: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "x@y.com" },
    });
    expect(noAction.isError).toBe(true);
    expect(noAction.content[0].text).toMatch(/at least one label action/);

    expect(created).toHaveLength(0); // neither reached the API
  });

  it("create_filter requires size and sizeComparison together — either one alone is a pairing error", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { settings: { filters: { create: async (r: any) => (created.push(r), { data: {} }) } } },
    });
    const client = await connect();

    // sizeComparison is a modifier, not a criterion — alone it must report the
    // pairing problem, not "no criterion".
    const lonelyComparison: any = await client.callTool({
      name: "create_filter",
      arguments: { sizeComparison: "larger", addLabels: ["INBOX"] },
    });
    expect(lonelyComparison.isError).toBe(true);
    expect(lonelyComparison.content[0].text).toMatch(/must be given together/);

    const sizeNoComparison: any = await client.callTool({
      name: "create_filter",
      arguments: { size: 5_000_000, addLabels: ["INBOX"] },
    });
    expect(sizeNoComparison.isError).toBe(true);
    expect(sizeNoComparison.content[0].text).toMatch(/must be given together/);

    expect(created).toHaveLength(0); // neither reached the API
  });

  it("create_filter rejects an empty/whitespace-only text criterion (never sends empty criteria)", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { settings: { filters: { create: async (r: any) => (created.push(r), { data: {} }) } } },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "   ", addLabels: ["Receipts"] }, // trims to empty → schema rejects
    });
    expect(res.isError).toBe(true);
    expect(created).toHaveLength(0); // rejected at the schema, before any API call
  });

  it("create_filter errors clearly when removeLabels names don't exist (empty effective action)", async () => {
    const created: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: {
        labels: { list: async () => ({ data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] } }) },
        settings: { filters: { create: async (r: any) => (created.push(r), { data: {} }) } },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { from: "x@y.com", removeLabels: ["Nonexistent"] }, // dropped in resolution
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no label action/);
    expect(created).toHaveLength(0); // caught before the create call
  });

  it("create_filter accepts size paired with sizeComparison", async () => {
    let body: any;
    (getAuth as Mock).mockResolvedValue({
      users: {
        settings: {
          filters: {
            create: async (r: any) => ((body = r.requestBody), { data: { id: "fz", ...r.requestBody } }),
          },
        },
      },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "create_filter",
      arguments: { size: 5_000_000, sizeComparison: "larger", removeLabels: ["INBOX"] },
    });
    expect(res.isError).toBeFalsy();
    expect(body.criteria).toEqual({ size: 5_000_000, sizeComparison: "larger" });
  });

  it("delete_filter deletes by id", async () => {
    const deleted: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { settings: { filters: { delete: async (req: any) => (deleted.push(req), {}) } } },
    });
    const client = await connect();
    const res: any = await client.callTool({ name: "delete_filter", arguments: { id: "f1" } });
    expect(deleted[0]).toEqual({ userId: "me", id: "f1" });
    expect(res.structuredContent).toEqual({ ok: true });
  });

  it("bulk_modify rejects an empty/whitespace query (would otherwise match the whole mailbox)", async () => {
    const listCalls: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { messages: { list: async (req: any) => (listCalls.push(req), { data: {} }) } },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "bulk_modify",
      arguments: { query: "   ", remove: ["INBOX"] }, // trims to empty → schema rejects
    });
    expect(res.isError).toBe(true);
    expect(listCalls).toHaveLength(0); // rejected before any API call
  });

  it("bulk_modify rejects a call with neither add nor remove (no wasted API pass)", async () => {
    const listCalls: any[] = [];
    (getAuth as Mock).mockResolvedValue({
      users: { messages: { list: async (req: any) => (listCalls.push(req), { data: {} }) } },
    });
    const client = await connect();
    const res: any = await client.callTool({
      name: "bulk_modify",
      arguments: { query: "in:inbox" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nothing to do/);
    expect(listCalls).toHaveLength(0); // rejected before any API call
  });
});

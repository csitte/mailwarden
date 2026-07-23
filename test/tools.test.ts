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
  it("registers all 15 tools by default, each with annotations and an outputSchema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(15);
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
      "get_thread",
      "list_labels",
      "list_snoozed",
      "search",
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
      failed: [],
    });
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

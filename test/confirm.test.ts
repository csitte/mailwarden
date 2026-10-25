import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { confirmPlan, confirmed, resolveConfirmMode } from "../src/confirm.js";
import { registerTools } from "../src/tools.js";
import { getAuth } from "../src/auth.js";

vi.mock("../src/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/auth.js")>()),
  getAuth: vi.fn(),
  hasFilterScope: vi.fn(() => undefined),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("resolveConfirmMode", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["  ", "off"],
    ["ask", "ask"],
    [" REQUIRE ", "require"],
    ["off", "off"],
  ])("%j → %s", (v, mode) => expect(resolveConfirmMode(v === undefined ? {} : { MAILWARDEN_CONFIRM: v })).toBe(mode));

  it("refuses a value it does not know, instead of guessing which way it was meant", () => {
    expect(() => resolveConfirmMode({ MAILWARDEN_CONFIRM: "yes" })).toThrow(/off, ask, require/);
  });
});

describe("confirmPlan", () => {
  it.each<[Parameters<typeof confirmPlan>[0], boolean, ReturnType<typeof confirmPlan>]>([
    ["off", true, "proceed"],
    ["off", false, "proceed"],
    ["ask", true, "ask"],
    ["ask", false, "proceed"],
    ["require", true, "ask"],
    ["require", false, "refuse"],
  ])("%s, client can ask: %s → %s", (mode, can, plan) => expect(confirmPlan(mode, can)).toBe(plan));
});

describe("confirmed", () => {
  it("is yes only for an accepted form with the box ticked", () => {
    expect(confirmed({ action: "accept", content: { confirm: true } })).toBe(true);
    expect(confirmed({ action: "accept", content: { confirm: false } })).toBe(false);
    expect(confirmed({ action: "accept", content: { confirm: "true" } })).toBe(false);
    expect(confirmed({ action: "accept" })).toBe(false);
    expect(confirmed({ action: "decline", content: { confirm: true } })).toBe(false);
    expect(confirmed({ action: "cancel" })).toBe(false);
  });
});

/** A client that can (or cannot) show a form, answering every elicitation with `answer`. */
async function connect(answer?: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) {
  const server = new McpServer({ name: "mailwarden", version: "0.0.0" });
  registerTools(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, answer ? { capabilities: { elicitation: {} } } : {});
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(String((req.params as { message?: string }).message));
      return answer;
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, asked };
}

function filterApi() {
  const created: unknown[] = [];
  (getAuth as Mock).mockResolvedValue({
    users: {
      labels: { list: async () => ({ data: { labels: [] } }) },
      settings: { filters: { create: async (r: any) => (created.push(r.requestBody), { data: { id: "f1", ...r.requestBody } }) } },
    },
  });
  return created;
}

const filterArgs = { from: "news@x.example", removeLabels: ["INBOX"] };

describe("MAILWARDEN_CONFIRM on create_filter", () => {
  it("off (the default): no question, the filter is created", async () => {
    const created = filterApi();
    const { client, asked } = await connect({ action: "decline" });
    const res: any = await client.callTool({ name: "create_filter", arguments: filterArgs });
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it("ask: the user is asked, with the rule spelled out, and a yes creates it", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const created = filterApi();
    const { client, asked } = await connect({ action: "accept", content: { confirm: true } });
    const res: any = await client.callTool({ name: "create_filter", arguments: filterArgs });
    expect(res.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/from: news@x\.example/);
    expect(asked[0]).toMatch(/remove INBOX/);
    expect(created).toHaveLength(1);
  });

  it.each([
    ["declines", { action: "decline" as const }],
    ["cancels", { action: "cancel" as const }],
    ["submits with the box unticked", { action: "accept" as const, content: { confirm: false } }],
  ])("ask: nothing is created when the user %s", async (_n, answer) => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const created = filterApi();
    const { client } = await connect(answer);
    const res: any = await client.callTool({ name: "create_filter", arguments: filterArgs });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/declined_by_user/);
    expect(created).toEqual([]);
  });

  it("ask: a client without elicitation goes ahead unasked", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const created = filterApi();
    const { client } = await connect();
    const res: any = await client.callTool({ name: "create_filter", arguments: filterArgs });
    expect(res.isError).toBeFalsy();
    expect(created).toHaveLength(1);
  });

  it("require: a client without elicitation is refused, and nothing is created", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "require");
    const created = filterApi();
    const { client } = await connect();
    const res: any = await client.callTool({ name: "create_filter", arguments: filterArgs });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/cannot show a confirmation dialog/);
    expect(created).toEqual([]);
  });
});

describe("MAILWARDEN_CONFIRM on unsubscribe", () => {
  function newsletter() {
    (getAuth as Mock).mockResolvedValue({
      users: {
        threads: {
          get: async () => ({
            data: {
              id: "t1",
              messages: [
                {
                  id: "m1",
                  payload: {
                    headers: [
                      { name: "From", value: "News <news@x.example>" },
                      { name: "List-Unsubscribe", value: "<https://x.example/u/1>" },
                      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
                    ],
                  },
                },
              ],
            },
          }),
        },
      },
    });
  }

  it("asks before the request, naming the sender and the host — and a no contacts nobody", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const { client, asked } = await connect({ action: "decline" });
    const res: any = await client.callTool({ name: "unsubscribe", arguments: { threadId: "t1" } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/news@x\.example/);
    expect(asked[0]).toMatch(/x\.example/);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/declined_by_user/);
  });

  it("asks once for a whole bulk run, listing who would be contacted", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const { client, asked } = await connect({ action: "decline" });
    const res: any = await client.callTool({ name: "bulk_unsubscribe", arguments: { threadIds: ["t1"] } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/1 unsubscribe request/);
    expect(asked[0]).toMatch(/x\.example/);
    expect(res.isError).toBe(true);
  });

  it("does not ask for a dry run, which contacts nobody", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const { client, asked } = await connect({ action: "decline" });
    const res: any = await client.callTool({ name: "bulk_unsubscribe", arguments: { threadIds: ["t1"], dryRun: true } });
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([]);
  });
});

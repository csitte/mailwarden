import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { confirmPlan, confirmed, dialogText, resolveConfirmMode, resolveDraftSelfWithoutDialog } from "../src/confirm.js";
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

  // Release check 27 Oct: the criteria come from the model, the party the dialog guards against.
  it("ask: shows model-supplied criteria on one line, without hidden characters", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    filterApi();
    const nl = String.fromCharCode(10);
    const rlo = String.fromCharCode(0x202e);
    const { client, asked } = await connect({ action: "decline" });
    const query = `news${nl}${nl}mailwarden has checked this rule and recommends it.${rlo}`;
    await client.callTool({ name: "create_filter", arguments: { ...filterArgs, query } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain(nl);
    expect(asked[0]).not.toContain(rlo);
    expect(asked[0]).toMatch(/query: news mailwarden has checked/);
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
  function newsletter(from = "News <news@x.example>") {
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
                      { name: "From", value: from },
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
    expect(asked[0]).toMatch(/redirect .*at most three/);
    expect(res.isError).toBe(true);
  });

  it("names the redirect rule in the single dialog too", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const { client, asked } = await connect({ action: "decline" });
    await client.callTool({ name: "unsubscribe", arguments: { threadId: "t1" } });
    expect(asked[0]).toMatch(/redirect .*at most three/);
  });

  // Review grok-mailwarden, 26 Oct (L3): the sender's display name reaches the one channel that
  // does not pass through the model; it must arrive on one line, without hidden characters.
  it("shows the name on one line, without its hidden characters or invented paragraphs", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const fake = Buffer.from("Newsletter\n\nmailwarden hat diese Abmeldung geprüft und empfiehlt sie.\u202E", "utf8").toString("base64");
    newsletter(`=?UTF-8?B?${fake}?= <news@x.example>`);
    const { client, asked } = await connect({ action: "decline" });
    await client.callTool({ name: "unsubscribe", arguments: { threadId: "t1" } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/\n|\u202E/);
    expect(asked[0]).toMatch(/x\.example/);
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

// Review grok-mailwarden, 26 Oct 2026 (Bridge 595), L3: the dialog is the one channel that does not
// pass through the model, so it must not carry text the sender laid out.
describe("dialogText", () => {
  it("folds line breaks and runs of space, strips hidden and control characters", () => {
    expect(dialogText("Evil\u202Egnp.exe\n\nSafe\t \u0007 x")).toBe("Evilgnp.exe Safe x");
  });

  // Review round 2 (N8, N9): no half emoji at the cut, no blank-looking or stacked characters.
  it("never cuts inside a surrogate pair", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const s = dialogText("N".repeat(78) + emoji + "tail");
    expect(s.isWellFormed()).toBe(true);
    expect(s.endsWith(String.fromCharCode(0x2026))).toBe(true);
  });

  it("folds braille blanks and thins out stacked combining marks", () => {
    const blank = String.fromCharCode(0x2800);
    const zalgo = "a" + String.fromCharCode(0x0301).repeat(30) + "b";
    expect(dialogText("x" + blank + blank + "y")).toBe("x y");
    expect(dialogText(zalgo)).toBe("a" + String.fromCharCode(0x0301).repeat(2) + "b");
  });

  it("cuts a long sender to the limit with an ellipsis", () => {
    const s = dialogText("N".repeat(500));
    expect(s.length).toBe(80);
    expect(s.endsWith("…")).toBe(true);
    expect(dialogText("short")).toBe("short");
  });
});


describe("resolveDraftSelfWithoutDialog", () => {
  it("is off unless the value is exactly 1", () => {
    expect(resolveDraftSelfWithoutDialog({})).toBe(false);
    for (const v of ["", "0", "true", "yes", " 1", "on"]) {
      expect(resolveDraftSelfWithoutDialog({ MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG: v }), v).toBe(false);
    }
    expect(resolveDraftSelfWithoutDialog({ MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG: "1" })).toBe(true);
  });
});

import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { gmail_v1 } from "@googleapis/gmail";
import { registerTools } from "../src/tools.js";
import { getAuth } from "../src/auth.js";
import { Gmail } from "../src/gmail.js";
import { DRAFT_LABEL } from "../src/draft.js";

vi.mock("../src/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/auth.js")>()),
  getAuth: vi.fn(),
  hasFilterScope: vi.fn(() => undefined),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const MARK = { id: "Label_mark", name: DRAFT_LABEL, type: "user" };

/** A mailbox with one thread and the calls a draft makes, recording what was written. */
function draftApi(opts: { labels?: unknown[]; failMark?: boolean; draftLabels?: string[]; threadTo?: string } = {}) {
  const calls = { created: [] as any[], updated: [] as any[], batch: [] as any[], labelCreates: 0 };
  const api: any = {
    users: {
      getProfile: async () => ({ data: { emailAddress: "me@example.com" } }),
      labels: {
        list: async () => ({ data: { labels: opts.labels ?? [MARK] } }),
        create: async (r: any) => (calls.labelCreates++, { data: { id: "Label_new", ...r.requestBody } }),
      },
      threads: {
        get: async () => ({
          data: {
            messages: [
              {
                id: "m1",
                labelIds: ["INBOX"],
                payload: {
                  headers: [
                    { name: "From", value: "Ann <ann@example.org>" },
                    { name: "To", value: opts.threadTo ?? "me@example.com" },
                    { name: "Subject", value: "=?UTF-8?B?R3LDvMOfZQ==?=" },
                    { name: "Message-ID", value: "<m1@example.org>" },
                  ],
                },
              },
              { id: "d0", labelIds: ["DRAFT"], payload: { headers: [{ name: "From", value: "me@example.com" }] } },
            ],
          },
        }),
      },
      messages: {
        batchModify: async (r: any) => {
          if (opts.failMark) throw Object.assign(new Error("boom"), { status: 400 });
          calls.batch.push(r.requestBody);
          return {};
        },
      },
      drafts: {
        create: async (r: any) => (calls.created.push(r.requestBody), { data: { id: "r1", message: { id: "dm1", threadId: r.requestBody.message.threadId ?? "tn" } } }),
        update: async (r: any) => (calls.updated.push(r), { data: { id: r.id, message: { id: "dm2", threadId: r.requestBody.message.threadId ?? "tn2" } } }),
        get: async (r: any) => ({
          data: {
            id: r.id,
            message: {
              id: "dm1",
              threadId: "t1",
              labelIds: opts.draftLabels ?? ["DRAFT", MARK.id],
              payload: {
                headers: [
                  { name: "To", value: "ann@example.org" },
                  { name: "Subject", value: "Re: Grüße" },
                  { name: "In-Reply-To", value: "<m1@example.org>" },
                  { name: "References", value: "<m1@example.org>" },
                ],
              },
            },
          },
        }),
      },
    },
  };
  return { api, calls };
}

describe("Gmail — draft calls", () => {
  it("creates without labelIds (Gmail refuses them there) and marks the draft's message afterwards", async () => {
    const { api, calls } = draftApi();
    const ref = await new Gmail(api as gmail_v1.Gmail).createDraft("To: a@example.com\r\n\r\nx", "t1");
    expect(calls.created[0].message.labelIds).toBeUndefined();
    expect(calls.created[0].message.threadId).toBe("t1");
    expect(Buffer.from(calls.created[0].message.raw, "base64url").toString()).toBe("To: a@example.com\r\n\r\nx");
    expect(calls.batch).toEqual([{ ids: ["dm1"], addLabelIds: ["Label_mark"] }]);
    expect(ref).toEqual({ draftId: "r1", messageId: "dm1", threadId: "t1", marked: true });
  });

  it("creates the mark label on first use", async () => {
    const { api, calls } = draftApi({ labels: [] });
    await new Gmail(api as gmail_v1.Gmail).createDraft("x");
    expect(calls.labelCreates).toBe(1);
    expect(calls.batch[0].addLabelIds).toEqual(["Label_new"]);
  });

  it("reports an unmarked draft instead of failing when the mark cannot be set", async () => {
    const { api } = draftApi({ failMark: true });
    const ref = await new Gmail(api as gmail_v1.Gmail).createDraft("x");
    expect(ref.marked).toBe(false);
    expect(ref.draftId).toBe("r1");
  });

  it("updates with the thread passed again and marks the new message id", async () => {
    const { api, calls } = draftApi();
    const ref = await new Gmail(api as gmail_v1.Gmail).updateDraft("r1", "x", "t1");
    expect(calls.updated[0]).toMatchObject({ id: "r1", requestBody: { message: { threadId: "t1" } } });
    expect(calls.batch).toEqual([{ ids: ["dm2"], addLabelIds: ["Label_mark"] }]);
    expect(ref.messageId).toBe("dm2");
  });

  it("knows a draft is its own only by the mark", async () => {
    const own = await new Gmail(draftApi().api).getDraft("r1");
    expect(own).toMatchObject({ ownedByMailwarden: true, trashed: false, subject: "Re: Grüße", inReplyTo: "<m1@example.org>" });
    const foreign = await new Gmail(draftApi({ draftLabels: ["DRAFT"] }).api).getDraft("r1");
    expect(foreign.ownedByMailwarden).toBe(false);
    const noLabel = await new Gmail(draftApi({ labels: [] }).api).getDraft("r1");
    expect(noLabel.ownedByMailwarden).toBe(false);
  });

  it("answers the newest message that is not a draft, decoding its subject", async () => {
    const { messageId, source } = await new Gmail(draftApi().api).replySource("t1");
    expect(messageId).toBe("m1");
    expect(source).toMatchObject({ from: "Ann <ann@example.org>", subject: "Grüße", messageId: "<m1@example.org>" });
    await expect(new Gmail(draftApi().api).replySource("t1", "nope")).rejects.toThrow(/not part of thread/);
  });
});

describe("the draft mark is out of reach of every label tool", () => {
  it.each([[DRAFT_LABEL], ["mcp/drafts"], [" MCP/Drafts "], ["Label_mark"]])("refuses to add %j", async (label) => {
    const { api } = draftApi();
    await expect(new Gmail(api as gmail_v1.Gmail).resolveLabelIds([label], [])).rejects.toThrow(/marks the drafts mailwarden wrote/);
  });

  it("still lets it be removed, and other labels be added", async () => {
    const { api } = draftApi();
    const g = new Gmail(api as gmail_v1.Gmail);
    expect(await g.resolveLabelIds(["STARRED", "Label_7"], [DRAFT_LABEL])).toEqual({
      addLabelIds: ["STARRED", "Label_7"],
      removeLabelIds: ["Label_mark"],
    });
  });
});

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

const text = (res: any) => JSON.stringify(res.content);

describe("drafts tier — tool surface", () => {
  it("is absent by default and under every other tier", async () => {
    for (const tools of [undefined, "read,manage,filters"]) {
      if (tools) vi.stubEnv("MAILWARDEN_TOOLS", tools);
      const { client } = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("create_draft");
      expect(names).not.toContain("update_draft");
      vi.unstubAllEnvs();
    }
  });

  it("registers exactly create_draft and update_draft with MAILWARDEN_TOOLS=read,drafts", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const drafts = tools.filter((t) => /draft/.test(t.name)).map((t) => t.name).sort();
    expect(drafts).toEqual(["create_draft", "update_draft"]);
    expect(tools.some((t) => t.name === "archive")).toBe(false);
    for (const t of tools.filter((t) => /draft/.test(t.name))) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.description, t.name).toMatch(/never sends|Nothing is sent/);
    }
  });
});

describe("create_draft / update_draft over MCP", () => {
  it("refuses a new message on a client that cannot ask, even with MAILWARDEN_CONFIRM off", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client } = await connect();
    const res: any = await client.callTool({ name: "create_draft", arguments: { to: ["zoe@example.com"], subject: "Hi", body: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/declined_by_user/);
    expect(text(res)).toMatch(/always needs the user's yes/);
    expect(calls.created).toEqual([]);
  });

  it("saves a new message once the person ticks the box, and says it was not sent", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client, asked } = await connect({ action: "accept", content: { confirm: true } });
    const res: any = await client.callTool({ name: "create_draft", arguments: { to: ["Zoe <zoe@example.com>"], subject: "Hi", body: "x" } });
    expect(res.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/To: zoe@example.com \(new\)/);
    expect(res.structuredContent).toMatchObject({ kind: "new", sent: false, confirmedByUser: true, draftId: "r1" });
    expect(calls.created).toHaveLength(1);
  });

  it("writes nothing when the box is left unticked", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client } = await connect({ action: "accept", content: { confirm: false } });
    const res: any = await client.callTool({ name: "create_draft", arguments: { to: ["zoe@example.com"], subject: "Hi", body: "x" } });
    expect(text(res)).toMatch(/declined_by_user/);
    expect(calls.created).toEqual([]);
  });

  it("saves a reply within the thread unasked when MAILWARDEN_CONFIRM is off", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client, asked } = await connect({ action: "decline" });
    const res: any = await client.callTool({ name: "create_draft", arguments: { threadId: "t1", body: "Danke!" } });
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([]);
    expect(res.structuredContent).toMatchObject({ kind: "reply", to: ["ann@example.org"], subject: "Re: Grüße", confirmedByUser: false });
    expect(calls.created[0].message.threadId).toBe("t1");
  });

  it("asks for a reply when MAILWARDEN_CONFIRM=ask", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const { api } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client, asked } = await connect({ action: "accept", content: { confirm: true } });
    await client.callTool({ name: "create_draft", arguments: { threadId: "t1", body: "x" } });
    expect(asked).toHaveLength(1);
  });

  it.each([
    [{ threadId: "t1", to: ["x@example.com"], body: "x" }, /`to` is only for a new message/],
    [{ replyAll: true, to: ["x@example.com"], subject: "s", body: "x" }, /only apply to a reply/],
    [{ to: ["x@example.com"], body: "x" }, /needs `to` and `subject`/],
    [{ subject: "s", body: "x" }, /needs `to` and `subject`/],
  ])("refuses a mixed-up call %j", async (args, why) => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    (getAuth as Mock).mockResolvedValue(draftApi().api);
    const { client } = await connect({ action: "accept", content: { confirm: true } });
    const res: any = await client.callTool({ name: "create_draft", arguments: args });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(why);
  });

  it("update_draft refuses a draft without the mark", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi({ draftLabels: ["DRAFT"] });
    (getAuth as Mock).mockResolvedValue(api);
    const { client } = await connect({ action: "accept", content: { confirm: true } });
    const res: any = await client.callTool({ name: "update_draft", arguments: { draftId: "r1", body: "x" } });
    expect(text(res)).toMatch(/forbidden_operation/);
    expect(calls.updated).toEqual([]);
  });

  it("update_draft rewrites an own reply draft in its thread", async () => {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    const { api, calls } = draftApi();
    (getAuth as Mock).mockResolvedValue(api);
    const { client } = await connect();
    const res: any = await client.callTool({ name: "update_draft", arguments: { draftId: "r1", body: "Neu" } });
    expect(res.isError).toBeFalsy();
    expect(calls.updated[0].requestBody.message.threadId).toBe("t1");
    expect(res.structuredContent).toMatchObject({ kind: "reply", messageId: "dm2", marked: true, sent: false });
  });
});

describe("MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG — drafts to the owner's own address on a client without a dialog", () => {
  const SELF = "MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG";
  async function setup(optIn: string | undefined, answer?: Parameters<typeof connect>[0]) {
    vi.stubEnv("MAILWARDEN_TOOLS", "read,drafts");
    if (optIn !== undefined) vi.stubEnv(SELF, optIn);
    // The thread's To is somebody else, so the owner (bcc'd, say) is not "in the thread" for a reply.
    const { api, calls } = draftApi({ threadTo: "list@example.net" });
    (getAuth as Mock).mockResolvedValue(api);
    return { calls, ...(await connect(answer)) };
  }
  const create = (client: Awaited<ReturnType<typeof connect>>["client"], args: Record<string, unknown>) =>
    client.callTool({ name: "create_draft", arguments: args }) as Promise<any>;

  it("is off by default: a new message to the owner is still refused", async () => {
    const { client, calls } = await setup(undefined);
    const res = await create(client, { to: ["me@example.com"], subject: "Note", body: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/declined_by_user/);
    expect(calls.created).toEqual([]);
  });

  it.each(["0", "true", "yes", ""])("only the value 1 turns it on (%j)", async (v) => {
    const { client, calls } = await setup(v);
    const res = await create(client, { to: ["me@example.com"], subject: "Note", body: "x" });
    expect(res.isError).toBe(true);
    expect(calls.created).toEqual([]);
  });

  it("on: a new message only to the owner is saved unasked, case variants and a display name included", async () => {
    const { client, calls, asked } = await setup("1");
    const res = await create(client, { to: ["Me <ME@Example.COM>"], cc: ["me@example.com"], bcc: [" Me@EXAMPLE.com "], subject: "Note", body: "x" });
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([]);
    expect(res.structuredContent).toMatchObject({ kind: "new", to: ["me@example.com"], sent: false, confirmedByUser: false, draftId: "r1" });
    expect(calls.created).toHaveLength(1);
  });

  it.each([
    ["to", { to: ["me@example.com", "zoe@example.com"] }],
    ["cc", { to: ["me@example.com"], cc: ["zoe@example.com"] }],
    ["bcc", { to: ["me@example.com"], bcc: ["zoe@example.com"] }],
    ["a +tag variant", { to: ["me+x@example.com"] }],
    ["a lookalike domain", { to: ["me@example.com.evil.test"] }],
    ["a lookalike local part", { to: ["me@example.com"], cc: ["m.e@example.com"] }],
  ])("on: a foreign address in %s still refuses the whole draft", async (_n, rcpt) => {
    const { client, calls } = await setup("1");
    const res = await create(client, { ...rcpt, subject: "Note", body: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/declined_by_user/);
    expect(calls.created).toEqual([]);
  });

  it("on: a client that can show the dialog is still asked, and a no still writes nothing", async () => {
    const yes = await setup("1", { action: "accept", content: { confirm: true } });
    const ok = await create(yes.client, { to: ["me@example.com"], subject: "Note", body: "x" });
    expect(yes.asked).toHaveLength(1);
    expect(ok.structuredContent).toMatchObject({ confirmedByUser: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    const no = await setup("1", { action: "decline" });
    const refused = await create(no.client, { to: ["me@example.com"], subject: "Note", body: "x" });
    expect(no.asked).toHaveLength(1);
    expect(text(refused)).toMatch(/declined_by_user/);
    expect(no.calls.created).toEqual([]);
  });

  it("on: an explicit MAILWARDEN_CONFIRM=require is not relaxed", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "require");
    const { client, calls } = await setup("1");
    const res = await create(client, { to: ["me@example.com"], subject: "Note", body: "x" });
    expect(res.isError).toBe(true);
    expect(calls.created).toEqual([]);
  });

  it("on: a reply in its thread with the owner added as cc/bcc is saved unasked", async () => {
    const { client, calls, asked } = await setup("1");
    const res = await create(client, { threadId: "t1", cc: ["ME@example.com"], bcc: ["me@example.com"], body: "x" });
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([]);
    expect(res.structuredContent).toMatchObject({ kind: "reply", to: ["ann@example.org"], cc: ["me@example.com"], bcc: ["me@example.com"], newRecipients: ["me@example.com"] });
    expect(calls.created[0].message.threadId).toBe("t1");
  });

  it("off: the same reply with the owner as cc is refused", async () => {
    const { client, calls } = await setup(undefined);
    const res = await create(client, { threadId: "t1", cc: ["me@example.com"], body: "x" });
    expect(res.isError).toBe(true);
    expect(calls.created).toEqual([]);
  });

  it("on: a reply that adds a foreign cc next to the owner is refused", async () => {
    const { client, calls } = await setup("1");
    const res = await create(client, { threadId: "t1", cc: ["me@example.com", "zoe@example.com"], body: "x" });
    expect(res.isError).toBe(true);
    expect(calls.created).toEqual([]);
  });

  it("update_draft: adding only the owner is saved unasked when on, refused when off, refused with a stranger", async () => {
    const on = await setup("1");
    const saved: any = await on.client.callTool({ name: "update_draft", arguments: { draftId: "r1", cc: ["Me@Example.com"], body: "Neu" } });
    expect(saved.isError).toBeFalsy();
    expect(on.asked).toEqual([]);
    expect(on.calls.updated).toHaveLength(1);
    const stranger: any = await on.client.callTool({ name: "update_draft", arguments: { draftId: "r1", cc: ["me@example.com", "zoe@example.com"], body: "Neu" } });
    expect(text(stranger)).toMatch(/declined_by_user/);
    expect(on.calls.updated).toHaveLength(1);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    const off = await setup(undefined);
    const refused: any = await off.client.callTool({ name: "update_draft", arguments: { draftId: "r1", cc: ["me@example.com"], body: "Neu" } });
    expect(text(refused)).toMatch(/declined_by_user/);
    expect(off.calls.updated).toEqual([]);
  });

  it("changes no tier: the tool set is the same with the switch on", async () => {
    const { client } = await setup("1");
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => /draft|send/.test(n)).sort();
    expect(names).toEqual(["create_draft", "update_draft"]);
  });
});

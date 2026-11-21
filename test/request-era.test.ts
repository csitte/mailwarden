import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import http from "node:http";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/client";
import { requestEraWithoutDialog } from "../src/confirm.js";
import { registerTools } from "../src/tools.js";
import { getAuth } from "../src/auth.js";
import { resetContactedSenders } from "../src/unsubscribe.js";

/**
 * The confirmation dialog on a request that brings its own protocol revision.
 *
 * mailwarden negotiates 2025 only (test/protocol-era.test.ts), but the hand-wired 2025 transports
 * still serve a `tools/call` that arrives with the 2026-07-28 per-request `_meta` envelope and no
 * handshake at all: nothing is negotiated, no capabilities are known, and `ask` used to read that as
 * "this client cannot show a dialog" and go ahead unasked (Grok review of 0.32.0, 21 Nov 2026, M1).
 * These tests send exactly that request over the transports src/index.ts and src/http.ts use.
 */

// The one-click path resolves the endpoint's host first; the hosts asked for are who a real run would contact.
const resolved = vi.hoisted(() => [] as string[]);
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    resolved.push(host);
    throw new Error(`no resolver in tests (${host})`);
  },
}));

vi.mock("../src/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/auth.js")>()),
  getAuth: vi.fn(),
  hasFilterScope: vi.fn(() => undefined),
}));

let closeHttp: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeHttp?.();
  closeHttp = undefined;
  resolved.length = 0;
  resetContactedSenders();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const FILTER_CALL = {
  jsonrpc: "2.0" as const,
  id: "call-1",
  method: "tools/call",
  params: { name: "create_filter", arguments: { from: "news@x.example", removeLabels: ["INBOX"] }, _meta: ENVELOPE },
};

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

/** One newsletter thread with a one-click opt-out at x.example. */
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

function server(): McpServer {
  const s = new McpServer({ name: "mailwarden", version: "0.0.0" });
  registerTools(s);
  return s;
}

/** In memory, no handshake: the request is the first thing the server hears. */
async function overMemory(call: typeof FILTER_CALL = FILTER_CALL): Promise<string> {
  const s = server();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const answers: unknown[] = [];
  ct.onmessage = (m) => answers.push(m);
  await s.connect(st);
  await ct.start();
  await ct.send(call);
  await expect.poll(() => answers.length, { timeout: 5000 }).toBe(1);
  await s.close();
  return JSON.stringify(answers[0]);
}

/** Over the stdio transport src/index.ts connects, on in-process streams. */
async function overStdio(): Promise<string> {
  const s = server();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (c) => (out += c));
  await s.connect(new StdioServerTransport(stdin, stdout));
  stdin.write(JSON.stringify(FILTER_CALL) + "\n");
  await expect.poll(() => out.includes('"id":"call-1"'), { timeout: 5000 }).toBe(true);
  await s.close();
  return out;
}

/** Stateless HTTP, wired the way src/http.ts wires it, with no protocol-version header. */
async function overHttp(): Promise<string> {
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const s = server();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void s.close();
    });
    await s.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closeHttp = () => new Promise((r) => srv.close(() => r()));
  const port = (srv.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve(text));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(FILTER_CALL));
  });
}

describe("requestEraWithoutDialog", () => {
  it("names the negotiated revision when that one rules the dialog out", () => {
    expect(requestEraWithoutDialog("2026-07-28", undefined)).toBe("2026-07-28");
    expect(requestEraWithoutDialog("2027-01-01", {})).toBe("2027-01-01");
  });

  it("names 2026-07-28 for a request that carries any per-request envelope key, whatever it claims", () => {
    expect(requestEraWithoutDialog(undefined, ENVELOPE)).toBe("2026-07-28");
    expect(requestEraWithoutDialog("2025-11-25", { "io.modelcontextprotocol/logLevel": "info" })).toBe("2026-07-28");
    expect(requestEraWithoutDialog(undefined, { "io.modelcontextprotocol/protocolVersion": "2025-11-25" })).toBe("2026-07-28");
  });

  it("is undefined for a 2025 request: nothing negotiated or a 2025 revision, and no envelope", () => {
    expect(requestEraWithoutDialog(undefined, undefined)).toBeUndefined();
    expect(requestEraWithoutDialog("2025-11-25", undefined)).toBeUndefined();
    expect(requestEraWithoutDialog("2025-06-18", {})).toBeUndefined();
  });
});

describe("a tools/call with the 2026-07-28 envelope and no handshake", () => {
  it.each([
    ["in memory", overMemory],
    ["over stdio", overStdio],
    ["over stateless HTTP", overHttp],
  ])("%s: under ask it is refused, and no filter is created", async (_n, send) => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    const created = filterApi();
    const answer = await send();
    expect(answer).toMatch(/declined_by_user/);
    expect(answer).toMatch(/protocol 2026-07-28/);
    expect(created).toEqual([]);
  });

  it.each([
    ["in memory", overMemory],
    ["over stdio", overStdio],
    ["over stateless HTTP", overHttp],
  ])("%s: under off the same request is served and creates the filter, so the refusal above is the dialog's", async (_n, send) => {
    const created = filterApi();
    const answer = await send();
    expect(answer).not.toMatch(/declined_by_user/);
    expect(created).toHaveLength(1);
  });
});

describe("the same envelope request on the tools that contact a sender", () => {
  // Grok's delta review (21 Nov 2026, L1): with only create_filter under test, the call context
  // could be dropped from either unsubscribe path and the suite stayed green.
  it.each([
    ["unsubscribe", { threadId: "t1" }],
    ["bulk_unsubscribe", { threadIds: ["t1"] }],
  ])("%s under ask is refused, and nobody is contacted", async (name, args) => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const answer = await overMemory({ ...FILTER_CALL, params: { name, arguments: args as never, _meta: ENVELOPE } });
    expect(answer).toMatch(/declined_by_user/);
    expect(answer).toMatch(/protocol 2026-07-28/);
    expect(resolved).toEqual([]);
  });

  it("unsubscribe under off is served and reaches the sender's host, so the refusal above is the dialog's", async () => {
    newsletter();
    await overMemory({ ...FILTER_CALL, params: { name: "unsubscribe", arguments: { threadId: "t1" } as never, _meta: ENVELOPE } });
    expect(resolved).toEqual(["x.example"]);
  });
});

describe("a call cancelled while its dialog is open (Grok review of 0.32.0, L1)", () => {

  it("withdraws the question: the sender is free again, and a yes that arrives later contacts nobody", async () => {
    vi.stubEnv("MAILWARDEN_CONFIRM", "ask");
    newsletter();
    const s = server();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
    const pending: ((a: unknown) => void)[] = [];
    client.setRequestHandler("elicitation/create", () => new Promise((r) => pending.push(r)) as never);
    await Promise.all([s.connect(st), client.connect(ct)]);

    const abort = new AbortController();
    const first = client.callTool({ name: "unsubscribe", arguments: { threadId: "t1" } }, { signal: abort.signal });
    await expect.poll(() => pending.length, { timeout: 5000 }).toBe(1);
    abort.abort();
    await expect(first).rejects.toThrow();

    // A retry is asked again instead of being told another call is contacting this sender.
    const second = client.callTool({ name: "unsubscribe", arguments: { threadId: "t1" } });
    await expect.poll(() => pending.length, { timeout: 5000 }).toBe(2);
    pending[1]({ action: "decline" });
    const res: any = await second;
    expect(JSON.stringify(res.content)).toMatch(/did not confirm/);
    expect(JSON.stringify(res.content)).not.toMatch(/right now/);

    // The withdrawn question is answered after all: it answers nothing.
    pending[0]({ action: "accept", content: { confirm: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toEqual([]);
    await s.close();
  });
});

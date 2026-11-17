import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

/**
 * mailwarden serves the 2025 protocol revisions only, on purpose (docs/SDK-2-PLAN.md, step 1).
 *
 * Its confirmation dialogs are push-style server-to-client requests, which the 2026-07-28 revision
 * no longer has. A client that can speak 2026-07-28 opens with `server/discover` (Claude Code
 * 2.1.318 does, measured 17 Nov 2026) and falls back to `initialize` when the server does not know
 * the method. A server wired by hand (`McpServer.connect` on a 2025 transport) answers -32601 and
 * stays on 2025; `serveStdio` or `createMcpHandler` would accept the probe and every dialog would be
 * gone. These tests hold the wiring in place until the dialogs are rebuilt for 2026-07-28.
 */

const DISCOVER = {
  jsonrpc: "2.0" as const,
  id: "probe-1",
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
    },
  },
};

const METHOD_NOT_FOUND = -32601;

let closeHttp: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeHttp?.();
  closeHttp = undefined;
});

describe("protocol era", () => {
  it("a server connected the way src/index.ts connects it refuses server/discover", async () => {
    const server = new McpServer({ name: "mailwarden", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const answers: unknown[] = [];
    ct.onmessage = (m) => answers.push(m);
    await server.connect(st);
    await ct.start();
    await ct.send(DISCOVER);
    await expect.poll(() => answers.length).toBe(1);
    expect(answers[0]).toMatchObject({ id: "probe-1", error: { code: METHOD_NOT_FOUND } });
    await server.close();
  });

  it("the HTTP transport src/http.ts uses refuses server/discover too", async () => {
    const httpServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const server = new McpServer({ name: "mailwarden", version: "0.0.0" });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    closeHttp = () => new Promise((r) => httpServer.close(() => r()));
    const { port } = httpServer.address() as AddressInfo;

    const reply = await new Promise<string>((resolve, reject) => {
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
      req.end(JSON.stringify(DISCOVER));
    });
    // The answer may come as JSON or as one SSE event; the error code is in it either way.
    expect(reply).toMatch(new RegExp(`"code":${METHOD_NOT_FOUND}`));
    expect(reply).not.toMatch(/supportedVersions/);
  });

  it("src/index.ts and src/http.ts keep the hand-wired 2025 transports", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const httpSrc = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");
    const why = "serveStdio/createMcpHandler serve 2026-07-28, where the confirmation dialogs cannot run (docs/SDK-2-PLAN.md)";
    expect(index, why).toMatch(/\.connect\(new StdioServerTransport\(\)\)/);
    expect(httpSrc, why).toMatch(/new NodeStreamableHTTPServerTransport\(/);
    for (const src of [index, httpSrc]) {
      expect(src, why).not.toMatch(/\bserveStdio\b|\bcreateMcpHandler\b/);
    }
  });
});

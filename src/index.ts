#!/usr/bin/env node
import { createRequire } from "node:module";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getAuth } from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

function makeServer(): McpServer {
  const server = new McpServer({ name: "mailwarden", version: VERSION });
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // One-time interactive OAuth consent.
  if (args.includes("--auth")) {
    await getAuth(true);
    console.error("✓ mailwarden authorized — refresh token stored.");
    return;
  }

  // Cron-friendly: resurface due snoozes and exit.
  if (args.includes("--sweep")) {
    const res = await sweepSnoozed(new Gmail(await getAuth(false)));
    const failNote = res.failedCount ? ` (${res.failedCount} message(s) failed — label kept)` : "";
    console.error(`✓ sweep: ${res.wokenCount} thread(s) resurfaced.${failNote}`);
    return;
  }

  if (args.includes("--http")) {
    await startHttp();
    return;
  }

  await makeServer().connect(new StdioServerTransport());
  console.error("mailwarden MCP server running on stdio.");

  // Optional snooze sweep while the (long-lived) server runs: once at startup
  // (the first interval tick would otherwise be an hour away), then hourly.
  if (process.env.MAILWARDEN_AUTO_SWEEP === "1") {
    const sweep = async () => {
      try {
        await sweepSnoozed(new Gmail(await getAuth(false)));
      } catch (err) {
        console.error("auto-sweep error:", err);
      }
    };
    void sweep();
    setInterval(sweep, 60 * 60 * 1000).unref(); // don't keep a closing server alive
  }
}

/**
 * Streamable HTTP transport for remote hosting (VPS / claude.ai custom connector).
 * Stateless mode: a fresh McpServer + transport per request — a single shared
 * McpServer must NOT be connect()ed to concurrent transports, since each
 * connect() replaces the previous transport and cross-wires in-flight requests.
 */
async function startHttp(): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());
  const port = Number(process.env.PORT ?? 8787);
  const bearer = process.env.MAILWARDEN_TOKEN;

  // Constant-time comparison so the token can't be guessed byte-by-byte via timing.
  const authorized = (header: string | undefined): boolean => {
    if (!bearer) return true;
    const expected = Buffer.from(`Bearer ${bearer}`);
    const got = Buffer.from(header ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  app.post("/mcp", async (req, res) => {
    if (!authorized(req.headers.authorization)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => console.error(`mailwarden MCP server (HTTP) on :${port}/mcp`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

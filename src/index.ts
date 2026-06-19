#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getAuth } from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";

const VERSION = "0.1.1";

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
    console.error(`✓ sweep: ${res.wokenCount} thread(s) resurfaced.`);
    return;
  }

  const server = new McpServer({ name: "mailwarden", version: VERSION });
  registerTools(server);

  if (args.includes("--http")) {
    await startHttp(server);
    return;
  }

  await server.connect(new StdioServerTransport());
  console.error("mailwarden MCP server running on stdio.");

  // Optional hourly snooze sweep while the (long-lived) server runs.
  if (process.env.MAILWARDEN_AUTO_SWEEP === "1") {
    setInterval(
      async () => {
        try {
          await sweepSnoozed(new Gmail(await getAuth(false)));
        } catch (err) {
          console.error("auto-sweep error:", err);
        }
      },
      60 * 60 * 1000,
    );
  }
}

/**
 * Streamable HTTP transport for remote hosting (VPS / claude.ai custom connector).
 * NOTE: the exact transport API may differ across @modelcontextprotocol/sdk versions —
 * verify against the version you install. Kept intentionally minimal.
 */
async function startHttp(server: McpServer): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());
  const port = Number(process.env.PORT ?? 8787);
  const bearer = process.env.MAILWARDEN_TOKEN;

  app.post("/mcp", async (req, res) => {
    if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => console.error(`mailwarden MCP server (HTTP) on :${port}/mcp`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

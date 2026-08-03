#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getAuth } from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";
import { startHttp } from "./http.js";

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
    const client = await getAuth(true);
    // Prove the credential works end-to-end before declaring success — catches a
    // consent that completed but can't actually call Gmail (wrong scope, etc.).
    try {
      const { emailAddress } = await new Gmail(client).getProfile();
      console.error(`✓ mailwarden authorized as ${emailAddress} — refresh token stored.`);
    } catch (err) {
      console.error(
        "⚠ Token was stored, but a test call to Gmail failed:",
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    }
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
    await startHttp(makeServer);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

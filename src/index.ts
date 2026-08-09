#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getAuth, hasModifyScope, activeAccount, sanitizeAccount } from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";
import { startHttp } from "./http.js";
import { resolveEnabledTiers } from "./tiers.js";
import { runDoctor } from "./doctor.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

function makeServer(): McpServer {
  const server = new McpServer({ name: "mailwarden", version: VERSION });
  registerTools(server);
  return server;
}

/** Read a `--flag value` / `--flag=value` option from argv, or undefined if absent. */
function readFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i !== -1) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Validate MAILWARDEN_TOOLS + MAILWARDEN_ACCOUNT once at boot so a misconfigured value fails fast
  // and cleanly (via main().catch) in every mode — including --http, where registration otherwise
  // runs per-request and a bad value would hang the first request instead.
  resolveEnabledTiers(process.env);
  activeAccount();

  // Setup doctor: diagnose credentials/token/scopes/live-call and exit.
  if (args.includes("--check") || args.includes("--doctor")) {
    process.exitCode = await runDoctor();
    return;
  }

  // One-time interactive OAuth consent. `--account <name>` stores under a named token file
  // (token.<name>.json) for multi-account setups; otherwise MAILWARDEN_ACCOUNT / the default.
  if (args.includes("--auth")) {
    const accountArg = readFlagValue(args, "--account");
    const account = accountArg !== undefined ? sanitizeAccount(accountArg) : activeAccount();
    const client = await getAuth(true, account);
    // Prove the credential works end-to-end before declaring success — catches a
    // consent that completed but can't actually call Gmail (wrong scope, etc.).
    try {
      const { emailAddress } = await new Gmail(client).getProfile();
      const label = account ? ` (account: ${account})` : "";
      console.error(`✓ mailwarden authorized as ${emailAddress}${label} — refresh token stored.`);
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
    if (hasModifyScope() === false) {
      console.error(
        "mailwarden: the stored token is read-only (no gmail.modify) — snooze sweeping writes labels. " +
          "Re-run `mailwarden --auth` with the manage tier enabled (MAILWARDEN_TOOLS includes 'manage', the default).",
      );
    }
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
    if (hasModifyScope() === false) {
      console.error(
        "mailwarden: MAILWARDEN_AUTO_SWEEP is on but the stored token is read-only (no gmail.modify) — " +
          "the hourly snooze sweep will fail. Re-run `mailwarden --auth` with the manage tier enabled.",
      );
    }
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

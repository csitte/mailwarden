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

/**
 * Read an explicit `--account <name>` / `--account=<name>` from argv (undefined if absent), and
 * validate the name. Throws — rather than silently defaulting — on a value-less `--account` (last
 * arg, or immediately followed by another flag), so a dropped name never lands auth in the wrong
 * token file.
 */
function readAccountArg(args: string[]): string | undefined {
  const i = args.indexOf("--account");
  if (i !== -1) {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("-")) {
      throw new Error("`--account` needs a value, e.g. `--account work`.");
    }
    return sanitizeAccount(v);
  }
  const eq = args.find((a) => a.startsWith("--account="));
  if (eq !== undefined) return sanitizeAccount(eq.slice("--account=".length)); // empty ⇒ sanitizeAccount throws
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Validate MAILWARDEN_TOOLS once at boot so a misconfigured value fails fast in every mode —
  // including --http, where registration otherwise runs per-request and a bad value would hang the
  // first request instead.
  resolveEnabledTiers(process.env);

  // Resolve an explicit `--account <name>` once and make it the account for this WHOLE invocation
  // (so --auth, --check, --sweep and the running server all agree). Setting the env is the single
  // source of truth downstream (activeAccount/tokenPath/getAuth/runDoctor all read it).
  const accountArg = readAccountArg(args);
  if (accountArg !== undefined) process.env.MAILWARDEN_ACCOUNT = accountArg;

  // Setup doctor: diagnose credentials/token/scopes/live-call and exit. Runs BEFORE the account
  // env is validated for other modes, so a malformed MAILWARDEN_ACCOUNT is reported by the doctor
  // (which tolerates it) rather than crashing the very command meant to diagnose it.
  if (args.includes("--check") || args.includes("--doctor")) {
    process.exitCode = await runDoctor();
    return;
  }

  // Validate MAILWARDEN_ACCOUNT for the remaining (non-doctor) modes — fail fast on a bad value.
  const account = activeAccount();

  // One-time interactive OAuth consent. Named accounts go via `--account <name>` (→ token.<name>.json);
  // otherwise MAILWARDEN_ACCOUNT / the default token.json.
  if (args.includes("--auth")) {
    // A bare positional (e.g. `mailwarden --auth work`) is almost certainly a forgotten `--account`;
    // refuse it rather than silently authorizing — and overwriting — the DEFAULT token.
    const stray = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--account");
    if (stray) {
      throw new Error(
        `Unexpected argument '${stray}'. To authorize a named account use: mailwarden --auth --account <name>.`,
      );
    }
    const client = await getAuth(true);
    // Prove the credential works end-to-end before declaring success — catches a
    // consent that completed but can't actually call Gmail (wrong scope, etc.).
    try {
      const { emailAddress } = await new Gmail(client).getProfile();
      const label = account ? ` (account: ${account})` : "";
      console.error(`✓ mailwarden authorized as ${emailAddress}${label} — refresh token stored.`);
      if (account) {
        console.error(
          `  To use this account, start the server with MAILWARDEN_ACCOUNT=${account} ` +
            "(add it to the MCP server's env).",
        );
      }
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

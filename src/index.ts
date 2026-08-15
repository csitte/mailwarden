#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getAuth, hasModifyScope, hasFilterScope, activeAccount } from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";
import { startHttp } from "./http.js";
import { resolveEnabledTiers, serverInstructions } from "./tiers.js";
import { runDoctor } from "./doctor.js";
import { CliError, debugEnabled, findStrayPositional, readAccountArg, resolveMode } from "./cli.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

function makeServer(): McpServer {
  // `instructions` is what a tool-search client reads at session start to decide whether to look
  // for our tools at all — derived from the same tier set that decides which tools get registered,
  // with the same scope gate: a `filters` tier whose token is known to lack gmail.settings.basic
  // registers no filter tools (tools.ts), so it must not advertise them here either.
  const advertised = resolveEnabledTiers(process.env);
  if (advertised.has("filters") && hasFilterScope() === false) advertised.delete("filters");
  const server = new McpServer(
    { name: "mailwarden", version: VERSION },
    { instructions: serverInstructions(advertised) },
  );
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Resolve an explicit `--account <name>` once and make it the account for this WHOLE invocation
  // (so --auth, --check, --sweep and the running server all agree). Setting the env is the single
  // source of truth downstream (activeAccount/tokenPath/getAuth/runDoctor all read it). The value
  // is stored RAW and validated below — the doctor must be able to *report* a malformed name
  // instead of being pre-empted by a throw.
  const accountArg = readAccountArg(args);
  if (accountArg !== undefined) process.env.MAILWARDEN_ACCOUNT = accountArg;

  const mode = resolveMode(args);

  // Setup doctor first: it diagnoses a malformed MAILWARDEN_ACCOUNT / MAILWARDEN_TOOLS itself
  // (with a formatted report) rather than crashing on the misconfiguration it exists to explain.
  if (mode === "check") {
    process.exitCode = await runDoctor();
    return;
  }

  // Every other mode: fail fast on a misconfigured environment. MAILWARDEN_TOOLS must be validated
  // here too — in --http, registration otherwise runs per-request and a bad value would hang the
  // first request instead of failing at boot.
  resolveEnabledTiers(process.env);
  const account = activeAccount();

  // One-time interactive OAuth consent. Named accounts go via `--account <name>` (→ token.<name>.json);
  // otherwise MAILWARDEN_ACCOUNT / the default token.json.
  if (mode === "auth") {
    // A bare positional (e.g. `mailwarden --auth work`) is almost certainly a forgotten `--account`;
    // refuse it rather than silently authorizing — and overwriting — the DEFAULT token.
    // `!== undefined`, not truthiness: an EMPTY positional (`--auth "$UNSET"`) is present
    // and must be refused — the same falsy-empty accident fixed in readAccountArg.
    const stray = findStrayPositional(args);
    if (stray !== undefined) {
      throw new CliError(
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
  if (mode === "sweep") {
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

  if (mode === "http") {
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
  // Errors written for the user (bad flag, bad env, not authorized) print as a plain line; an
  // internal fault keeps its stack, because a bare one-liner is not a usable bug report.
  if (debugEnabled(process.env) || !(err instanceof Error)) {
    console.error(err); // full object + stack
  } else {
    console.error(`mailwarden: ${err.message}`);
    // An unexpected fault needs its stack to be reportable; say how to get it either way.
    console.error(
      err instanceof CliError
        ? "(set MAILWARDEN_DEBUG=1 for the full error)"
        : "(unexpected error — set MAILWARDEN_DEBUG=1 for the stack trace)",
    );
  }
  process.exit(1);
});

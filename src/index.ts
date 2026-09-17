#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, servedTiers } from "./tools.js";
import {
  getAuth,
  hasModifyScope,
  readGrantedScopes,
  activeAccount,
  tokenPath,
} from "./auth.js";
import { Gmail } from "./gmail.js";
import { sweepSnoozed } from "./snooze.js";
import { startHttp } from "./http.js";
import { resolveEnabledTiers, scopeGapMessage, serverInstructions } from "./tiers.js";
import { runDoctor } from "./doctor.js";
import {
  CliError,
  debugEnabled,
  findStrayPositional,
  helpFooter,
  readAccountArg,
  resolveMode,
} from "./cli.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/**
 * Report a gap between the granted scopes and the enabled tiers, once, after the transport is up.
 *
 * Registration cannot do this. `hasFilterScope()` reads the token synchronously and never decrypts,
 * so it returns `undefined` for every encrypted deployment — which then advertises its full tier
 * surface and discovers the gap only when Google refuses a call. This read is asynchronous and can
 * decrypt, so it sees what the token really carries and can say so in advance.
 *
 * Deliberately not awaited by the caller: a client gives the server a fixed window to finish its
 * handshake, and a diagnostic must never compete with it. Never throws, for the same reason a
 * warning must not be able to break a server that works.
 */
async function warnAboutScopeGap(): Promise<void> {
  try {
    const granted = await readGrantedScopes();
    // `known: false` is not a gap — no token, an encrypted one with no passphrase in the
    // environment, or one written before scopes were recorded. `--check` tells those apart and
    // says what to do; guessing here would produce a false alarm on a healthy setup.
    if (!granted.known) return;
    const account = activeAccount();
    const message = scopeGapMessage(
      granted.scopes,
      servedTiers(),
      `mailwarden --auth${account ? ` --account ${account}` : ""}`,
    );
    if (message) console.error(`mailwarden: ${message}`);
  } catch {
    // A diagnostic that fails stays silent; the call it warns about will still report for itself.
  }
}

function makeServer(): McpServer {
  // `instructions` is what a tool-search client reads at session start to decide whether to look
  // for our tools at all — derived from the same tier set that decides which tools get registered.
  const server = new McpServer(
    { name: "mailwarden", version: VERSION },
    { instructions: serverInstructions(servedTiers()) },
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
    // `--force` deliberately replaces a token that belongs to a DIFFERENT mailbox. Without it,
    // that case aborts before anything is written (auth.ts, tokenOverwriteVerdict).
    const force = args.includes("--force");
    const client = await getAuth(true, { force });
    // Prove the credential works end-to-end before declaring success — catches a
    // consent that completed but can't actually call Gmail (wrong scope, etc.).
    try {
      const { emailAddress } = await new Gmail(client).getProfile();
      const label = account ? ` (account: ${account})` : "";
      // Name the file, not just the address. "authorized as X" was formally true even when the
      // token landed in another mailbox's file — the report that could not show the accident.
      console.error(
        `✓ mailwarden authorized as ${emailAddress}${label} — refresh token stored in ${tokenPath(account)}.`,
      );
      if (account) {
        console.error(
          `  To use this account, start the server with MAILWARDEN_ACCOUNT=${account} ` +
            "(add it to the MCP server's env).",
        );
      }
      console.error(helpFooter("ok"));
    } catch (err) {
      console.error(
        "⚠ Token was stored, but a test call to Gmail failed:",
        err instanceof Error ? err.message : err,
      );
      console.error(helpFooter("problem"));
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
    void warnAboutScopeGap();
    await startHttp(makeServer);
    return;
  }

  await makeServer().connect(new StdioServerTransport());
  console.error("mailwarden MCP server running on stdio.");
  void warnAboutScopeGap();

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

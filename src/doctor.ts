/**
 * `mailwarden --check` — a setup doctor. Diagnoses the OAuth setup end to end and
 * prints actionable fixes, so a broken deployment says *what* is wrong instead of
 * failing cryptically on the first Gmail call. Covers the classic traps: missing or
 * wrong credentials.json, no token (never authorized), an encrypted token with no
 * passphrase, granted scopes that don't cover the enabled tiers, and a token that
 * parses but no longer works (the 7-day "Testing" refresh-token expiry).
 *
 * The report is built by a pure function (buildReport) so it is unit-tested without
 * any IO; runDoctor gathers the IO and prints.
 */
import fs from "node:fs/promises";
import {
  CRED_PATH,
  tokenPath,
  activeAccount,
  discoverAccounts,
  checkCredentials,
  readGrantedScopes,
  type ScopeRead,
  tokenFileState,
  getAuth,
  type CredCheck,
} from "./auth.js";
import { Gmail } from "./gmail.js";
import { authScopesForTiers, missingScopes, resolveEnabledTiers, type ToolTier } from "./tiers.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorInputs {
  credPath: string;
  tokenPath: string;
  /** Active account name, or null for the default — so remediation names the right --account. */
  account: string | null;
  cred: CredCheck;
  tokenState: "missing" | "plaintext" | "encrypted" | "invalid";
  /** Whether MAILWARDEN_TOKEN_PASSPHRASE is set (only relevant for an encrypted token). */
  passphraseSet: boolean;
  /** Granted scopes, or the reason they could not be read (see auth.ScopeRead). */
  grantedScopes: ScopeRead;
  enabledTiers: Set<ToolTier>;
  requiredScopes: string[];
  /** Live getProfile result; null when it was not attempted (no usable token). */
  profile: { ok: true; email: string } | { ok: false; error: string } | null;
}

const SCOPE_SHORT = (s: string): string => s.replace("https://www.googleapis.com/auth/", "");

/** Build the diagnostic report from already-gathered inputs. Pure — no IO. */
export function buildReport(i: DoctorInputs): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // Remediation must name the account, or a named-account user runs a bare `--auth` and
  // overwrites the DEFAULT token while the reported problem stays.
  const authCmd = `mailwarden --auth${i.account ? ` --account ${i.account}` : ""}`;

  // 1. Credentials file.
  checks.push(
    i.cred.ok
      ? { name: "Credentials", status: "ok", detail: `OAuth client (${i.cred.kind}) at ${i.credPath}` }
      : { name: "Credentials", status: "fail", detail: i.cred.message },
  );

  // 2. Token file presence / shape.
  switch (i.tokenState) {
    case "missing":
      checks.push({
        name: "Token",
        status: "fail",
        detail: `No token at ${i.tokenPath}. Run \`${authCmd}\` once to authorize.`,
      });
      break;
    case "invalid":
      checks.push({
        name: "Token",
        status: "fail",
        detail: `${i.tokenPath} exists but is not valid JSON. Re-run \`${authCmd}\` to replace it.`,
      });
      break;
    case "encrypted":
      checks.push(
        i.passphraseSet
          ? { name: "Token", status: "ok", detail: "Encrypted at rest (AES-256-GCM); passphrase is set." }
          : {
              name: "Token",
              status: "fail",
              detail:
                "Token is encrypted but MAILWARDEN_TOKEN_PASSPHRASE is not set. Set it to the passphrase used at --auth.",
            },
      );
      break;
    case "plaintext":
      checks.push({
        name: "Token",
        status: i.passphraseSet ? "warn" : "ok",
        detail: i.passphraseSet
          ? `Stored in plaintext while a passphrase is set — re-run \`${authCmd}\` to encrypt it at rest.`
          : `Present (plaintext). Set MAILWARDEN_TOKEN_PASSPHRASE + re-run \`${authCmd}\` to encrypt at rest (optional).`,
      });
      break;
  }

  // 3. Granted scopes vs. what the enabled tiers need.
  const tiers = [...i.enabledTiers].join(", ");
  const need = `Enabled tiers (${tiers}) need: ${i.requiredScopes.map(SCOPE_SHORT).join(", ")}.`;
  if (!i.grantedScopes.known) {
    // Each reason gets its OWN remediation. Telling a merely *locked* token to "re-run --auth to
    // record scopes" is both false and destructive: re-authorizing without the passphrase in the
    // environment replaces the encrypted token with a plaintext one.
    const reason = i.grantedScopes.reason;
    if (reason === "no-token" || reason === "unreadable") {
      // The Token check already reported this with its fix; a second line would just repeat it.
    } else if (reason === "locked") {
      checks.push({
        name: "Scopes",
        status: "warn",
        detail:
          `${need} Recorded inside the encrypted token, which cannot be read without ` +
          "MAILWARDEN_TOKEN_PASSPHRASE — set it and re-run `--check`. " +
          "(Do NOT re-run `--auth` without it: that would replace the encrypted token with a plaintext one.)",
      });
    } else if (reason === "bad-key") {
      checks.push({
        name: "Scopes",
        status: "warn",
        detail: `${need} Cannot verify — MAILWARDEN_TOKEN_PASSPHRASE does not decrypt this token (see the Token check).`,
      });
    } else {
      // "unrecorded": genuinely written before scopes were recorded — here --auth does fix it.
      checks.push({
        name: "Scopes",
        status: "warn",
        detail: `${need} The stored token records no scopes (authorized before scope-recording) — cannot verify; re-run \`${authCmd}\` to record them.`,
      });
    }
  } else {
    // Capability containment, not string equality: gmail.modify covers gmail.readonly, so a
    // full-surface token must not be reported as broken for a read-only deployment.
    const missing = missingScopes(i.grantedScopes.scopes, i.requiredScopes);
    checks.push(
      missing.length === 0
        ? {
            name: "Scopes",
            status: "ok",
            detail: `Granted scopes cover the enabled tiers (${tiers}): ${i.requiredScopes.map(SCOPE_SHORT).join(", ")}.`,
          }
        : {
            name: "Scopes",
            status: "fail",
            detail:
              `Enabled tiers (${tiers}) need ${missing.map(SCOPE_SHORT).join(", ")}, which the token lacks. ` +
              `Re-run \`${authCmd}\` with those tiers enabled (MAILWARDEN_TOOLS).` +
              // The running server gates tools on the SYNC scope read, which cannot decrypt — so
              // for an encrypted token it advertises everything and fails only at call time.
              // Say so, or --check and the live tool list look like they disagree.
              (i.tokenState === "encrypted"
                ? " Note: with an encrypted token the server cannot read scopes at startup, so it still advertises those tools — they will fail when called."
                : ""),
          },
    );
  }

  // 4. Live Gmail call — the ultimate proof the credential actually works.
  if (i.profile !== null) {
    checks.push(
      i.profile.ok
        ? { name: "Live Gmail call", status: "ok", detail: `Authorized as ${i.profile.email}.` }
        : { name: "Live Gmail call", status: "fail", detail: i.profile.error },
    );
  }

  return checks;
}

/**
 * Classify the outcome of reading credentials.json. Pure, so the distinction that matters can be
 * tested: a file that is *absent* needs "download it from Google Cloud", while one that exists but
 * cannot be read (EACCES after a restore, EISDIR from a path pointing at a folder) needs a
 * permissions fix — telling that user to re-download sends them in circles.
 */
export function classifyCredRead(
  outcome: { ok: true; raw: string } | { ok: false; code?: string },
  credPath: string,
): CredCheck {
  if (outcome.ok) return checkCredentials(outcome.raw, credPath);
  if (outcome.code === "ENOENT") return checkCredentials(null, credPath);
  return {
    ok: false,
    message:
      `Cannot read ${credPath} — it exists but could not be read (${outcome.code ?? "unknown error"}). ` +
      "Check file permissions. See docs/SETUP.md.",
  };
}

/**
 * Whether attempting a live Gmail call is worthwhile. Pure. An encrypted token with no passphrase
 * cannot be loaded at all: the Token check already reports that with its fix, so calling anyway
 * would only repeat the same failure as a second ✗ line.
 */
export function shouldLiveCheck(
  tokenState: DoctorInputs["tokenState"],
  passphraseSet: boolean,
): boolean {
  return tokenState === "plaintext" || (tokenState === "encrypted" && passphraseSet);
}

/** Worst status present, which maps to the process exit code (fail → 1). */
export function reportExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Run all checks against the real environment, print the report, return an exit code. */
export async function runDoctor(): Promise<number> {
  console.error("mailwarden --check\n");

  // Resolve the account first, defensively: a malformed MAILWARDEN_ACCOUNT is exactly the kind of
  // misconfiguration --check exists to diagnose, so report it here instead of throwing (which is why
  // index.ts runs --check before validating the account for other modes).
  let account: string | null;
  try {
    account = activeAccount();
  } catch (err) {
    console.error(`  ✗ Account: ${err instanceof Error ? err.message : String(err)}`);
    // Name both knobs: the CLI stores a `--account` value into MAILWARDEN_ACCOUNT, so pointing
    // only at the env var sends a user who typed the flag hunting for a variable they never set.
    console.error("\n✗ Setup has problems — fix the account name (`--account` / MAILWARDEN_ACCOUNT) and re-run.");
    return 1;
  }
  // Compare case-insensitively: on Windows/macOS `token.Work.json` IS the active `work`
  // account, while on Linux it is a different file and stays listed under its real name.
  const others = discoverAccounts().filter((a) => a.toLowerCase() !== account);
  console.error(`  Account: ${account ?? "(default)"}`);
  if (others.length) console.error(`  Other accounts found: ${others.join(", ")}`);
  console.error("");

  // Credentials (reuse the same preflight --auth uses). Distinguish "absent" from "present but
  // unreadable" exactly as getAuth does — reporting an EACCES/EISDIR file as "not found, download
  // it from Google Cloud" sends the user to re-download a file that was there all along.
  let cred: CredCheck;
  try {
    cred = classifyCredRead({ ok: true, raw: await fs.readFile(CRED_PATH, "utf8") }, CRED_PATH);
  } catch (err) {
    cred = classifyCredRead({ ok: false, code: (err as NodeJS.ErrnoException).code }, CRED_PATH);
  }

  const tokenState = tokenFileState();
  const passphraseSet = Boolean(process.env.MAILWARDEN_TOKEN_PASSPHRASE);

  // A bad MAILWARDEN_TOOLS is a misconfiguration --check should *explain*, not crash on.
  let enabledTiers: Set<ToolTier>;
  try {
    enabledTiers = resolveEnabledTiers(process.env);
  } catch (err) {
    console.error(`  ✗ Tool tiers: ${err instanceof Error ? err.message : String(err)}`);
    console.error("\n✗ Setup has problems — fix MAILWARDEN_TOOLS and re-run.");
    return 1;
  }
  const requiredScopes = authScopesForTiers(enabledTiers);

  // Live smoke test — only when the token is plausibly usable (see shouldLiveCheck).
  let profile: DoctorInputs["profile"] = null;
  if (shouldLiveCheck(tokenState, passphraseSet)) {
    try {
      const { emailAddress } = await new Gmail(await getAuth(false)).getProfile();
      profile = { ok: true, email: emailAddress };
    } catch (err) {
      profile = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const checks = buildReport({
    credPath: CRED_PATH,
    tokenPath: tokenPath(),
    account,
    cred,
    tokenState,
    passphraseSet,
    grantedScopes: await readGrantedScopes(),
    enabledTiers,
    requiredScopes,
    profile,
  });

  for (const c of checks) console.error(`  ${ICON[c.status]} ${c.name}: ${c.detail}`);
  const code = reportExitCode(checks);
  console.error(`\n${code === 0 ? "✓ Setup looks good." : "✗ Setup has problems — see the ✗ lines above."}`);
  return code;
}

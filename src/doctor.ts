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
  persistedScopes,
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
  /** Recorded granted scopes, or null when unknown (old/encrypted token). */
  grantedScopes: string[] | null;
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
          ? "Stored in plaintext while a passphrase is set — re-run `mailwarden --auth` to encrypt it at rest."
          : "Present (plaintext). Set MAILWARDEN_TOKEN_PASSPHRASE + re-run --auth to encrypt at rest (optional).",
      });
      break;
  }

  // 3. Granted scopes vs. what the enabled tiers need.
  const tiers = [...i.enabledTiers].join(", ");
  if (i.grantedScopes === null) {
    if (i.tokenState === "encrypted") {
      // Scopes live inside the ciphertext and are deliberately not decrypted here, so they can
      // never be read for an encrypted token. Reporting that as a warning with a "re-run --auth"
      // fix would be permanently unfixable noise — re-authorizing just re-encrypts them.
      checks.push({
        name: "Scopes",
        status: "ok",
        detail:
          `Not recorded for an encrypted token (by design) — cannot verify against the enabled tiers (${tiers}). ` +
          "A genuinely missing scope surfaces as an actionable insufficient-scope error on first use.",
      });
    } else if (i.tokenState === "plaintext") {
      // Old token written before scopes were recorded — here --auth genuinely fixes it.
      checks.push({
        name: "Scopes",
        status: "warn",
        detail:
          `Enabled tiers (${tiers}) need: ${i.requiredScopes.map(SCOPE_SHORT).join(", ")}. ` +
          `The stored token records no scopes (authorized before scope-recording) — cannot verify; ` +
          `re-run \`${authCmd}\` to record them.`,
      });
    }
  } else {
    // Capability containment, not string equality: gmail.modify covers gmail.readonly, so a
    // full-surface token must not be reported as broken for a read-only deployment.
    const missing = missingScopes(i.grantedScopes, i.requiredScopes);
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
              `Re-run \`${authCmd}\` with those tiers enabled (MAILWARDEN_TOOLS).`,
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
    console.error("\n✗ Setup has problems — fix MAILWARDEN_ACCOUNT and re-run.");
    return 1;
  }
  const others = discoverAccounts().filter((a) => a !== account);
  console.error(`  Account: ${account ?? "(default)"}`);
  if (others.length) console.error(`  Other accounts found: ${others.join(", ")}`);
  console.error("");

  // Credentials (reuse the same preflight --auth uses). Distinguish "absent" from "present but
  // unreadable" exactly as getAuth does — reporting an EACCES/EISDIR file as "not found, download
  // it from Google Cloud" sends the user to re-download a file that was there all along.
  let cred: CredCheck;
  try {
    cred = checkCredentials(await fs.readFile(CRED_PATH, "utf8"), CRED_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    cred =
      code === "ENOENT"
        ? checkCredentials(null, CRED_PATH)
        : {
            ok: false,
            message: `Cannot read ${CRED_PATH} — it exists but could not be read (${code}). Check file permissions.`,
          };
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

  // Live smoke test — only when the token is plausibly usable. Skip an encrypted token with no
  // passphrase: the Token check already fails with the fix, and the live call would just repeat it.
  let profile: DoctorInputs["profile"] = null;
  if (tokenState === "plaintext" || (tokenState === "encrypted" && passphraseSet)) {
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
    grantedScopes: persistedScopes(),
    enabledTiers,
    requiredScopes,
    profile,
  });

  for (const c of checks) console.error(`  ${ICON[c.status]} ${c.name}: ${c.detail}`);
  const code = reportExitCode(checks);
  console.error(`\n${code === 0 ? "✓ Setup looks good." : "✗ Setup has problems — see the ✗ lines above."}`);
  return code;
}

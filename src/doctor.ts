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
import { authScopesForTiers, resolveEnabledTiers, type ToolTier } from "./tiers.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorInputs {
  credPath: string;
  tokenPath: string;
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
        detail: `No token at ${i.tokenPath}. Run \`mailwarden --auth\` once to authorize.`,
      });
      break;
    case "invalid":
      checks.push({
        name: "Token",
        status: "fail",
        detail: `${i.tokenPath} exists but is not valid JSON. Re-run \`mailwarden --auth\` to replace it.`,
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
    // Unknown: only warn when there's actually a token to reason about.
    if (i.tokenState === "plaintext" || i.tokenState === "encrypted") {
      checks.push({
        name: "Scopes",
        status: "warn",
        detail:
          `Enabled tiers (${tiers}) need: ${i.requiredScopes.map(SCOPE_SHORT).join(", ")}. ` +
          "The stored token records no scopes (authorized before scope-recording, or encrypted) — cannot verify; " +
          "re-run `mailwarden --auth` to record them.",
      });
    }
  } else {
    const missing = i.requiredScopes.filter((s) => !i.grantedScopes!.includes(s));
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
              "Re-run `mailwarden --auth` with those tiers enabled (MAILWARDEN_TOOLS).",
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
  // Credentials (reuse the same preflight --auth uses).
  let credRaw: string | null;
  try {
    credRaw = await fs.readFile(CRED_PATH, "utf8");
  } catch {
    credRaw = null;
  }
  const cred = checkCredentials(credRaw, CRED_PATH);

  const tokenState = tokenFileState();
  const enabledTiers = resolveEnabledTiers(process.env);
  const requiredScopes = authScopesForTiers(enabledTiers);

  // Live smoke test — only when there is plausibly a usable token to try.
  let profile: DoctorInputs["profile"] = null;
  if (tokenState === "plaintext" || tokenState === "encrypted") {
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
    cred,
    tokenState,
    passphraseSet: Boolean(process.env.MAILWARDEN_TOKEN_PASSPHRASE),
    grantedScopes: persistedScopes(),
    enabledTiers,
    requiredScopes,
    profile,
  });

  const account = activeAccount();
  const others = discoverAccounts().filter((a) => a !== account);
  console.error("mailwarden --check\n");
  console.error(`  Account: ${account ?? "(default)"}`);
  if (others.length) console.error(`  Other accounts found: ${others.join(", ")}`);
  console.error("");
  for (const c of checks) console.error(`  ${ICON[c.status]} ${c.name}: ${c.detail}`);
  const code = reportExitCode(checks);
  console.error(`\n${code === 0 ? "✓ Setup looks good." : "✗ Setup has problems — see the ✗ lines above."}`);
  return code;
}

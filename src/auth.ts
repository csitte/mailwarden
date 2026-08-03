import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** Single scope covers read + write (labels, archive, trash, mark-read, attachments). */
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const CONFIG_DIR = process.env.MAILWARDEN_DIR ?? path.join(os.homedir(), ".mailwarden");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");
const CRED_PATH = process.env.MAILWARDEN_CREDENTIALS ?? path.join(CONFIG_DIR, "credentials.json");

async function loadSavedToken(): Promise<OAuth2Client | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    return google.auth.fromJSON(JSON.parse(raw)) as OAuth2Client;
  } catch {
    return null;
  }
}

/** Validated OAuth client credentials, or an actionable reason they're unusable. */
export type CredCheck =
  | { ok: true; kind: "installed" | "web"; client_id: string; client_secret: string }
  | { ok: false; message: string };

/**
 * `--auth` preflight: validate the credentials.json shape BEFORE the browser
 * consent flow. Without this, local-auth fails deep inside `authenticate()` with
 * cryptic errors — `Cannot find module` (missing file), a raw JSON parse error,
 * or `Cannot read properties of undefined (reading 'redirect_uris')` (not an
 * OAuth *client* file) — none of which tell the user what to actually do.
 *
 * Pure (string in, result out) so it's unit-tested without an OAuth flow.
 * `raw` is null when the file is missing. redirect_uri validation is left to
 * local-auth, whose message for that specific case is already clear.
 */
export function checkCredentials(raw: string | null, credPath: string): CredCheck {
  if (raw === null) {
    return {
      ok: false,
      message: `No OAuth credentials found at ${credPath}. In Google Cloud Console create an OAuth client of type "Desktop app", download its JSON, and save it there. See docs/SETUP.md.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `${credPath} is not valid JSON. Re-download the OAuth client JSON from Google Cloud Console (don't hand-edit it). See docs/SETUP.md.`,
    };
  }
  const obj = parsed as { installed?: unknown; web?: unknown };
  const kind = obj?.installed ? "installed" : obj?.web ? "web" : undefined;
  const key = (kind ? (obj as Record<string, unknown>)[kind] : undefined) as
    | { client_id?: unknown; client_secret?: unknown }
    | undefined;
  if (!kind || !key) {
    return {
      ok: false,
      message: `${credPath} has no "installed" or "web" OAuth client — this isn't an OAuth client credentials file. In Google Cloud Console create an OAuth client of type "Desktop app" and download THAT (not an API key or a service account). See docs/SETUP.md.`,
    };
  }
  if (typeof key.client_id !== "string" || typeof key.client_secret !== "string") {
    return {
      ok: false,
      message: `${credPath} is missing client_id or client_secret. Re-download the OAuth client JSON from Google Cloud Console. See docs/SETUP.md.`,
    };
  }
  return { ok: true, kind, client_id: key.client_id, client_secret: key.client_secret };
}

async function persistToken(client: OAuth2Client, cred: { client_id: string; client_secret: string }): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: cred.client_id,
        client_secret: cred.client_secret,
        refresh_token: client.credentials.refresh_token,
      },
      null,
      2,
    ),
    { mode: 0o600 }, // holds a refresh token + client secret; no-op on Windows
  );
}

/**
 * Process-lifetime cache of the runtime OAuth2 client. A fresh `fromJSON` client
 * carries only the refresh token (no access token), so it must hit Google's token
 * endpoint on its first request. Rebuilding it per tool call (as tools.ts once did)
 * forced that refresh on every single call; caching it means one refresh per
 * process, with google-auth-library transparently refreshing again on expiry.
 */
let cachedClient: OAuth2Client | null = null;

/**
 * Returns an authenticated OAuth2 client.
 * - interactive=false (server runtime): loads the stored refresh token, else throws.
 * - interactive=true (`mailwarden --auth`): runs the browser consent flow once and stores it.
 */
export async function getAuth(interactive = false): Promise<OAuth2Client> {
  if (!interactive) {
    if (cachedClient) return cachedClient;
    // Server runtime: reuse the stored refresh token, or tell the user to run --auth.
    const saved = await loadSavedToken();
    if (saved) return (cachedClient = saved);
    throw new Error(
      "mailwarden is not authorized yet. Run `mailwarden --auth` once to grant Gmail access.",
    );
  }

  // Preflight: validate the credentials file up front, so a missing/malformed
  // one yields an actionable message instead of local-auth's cryptic failure
  // deep inside authenticate(). Only a genuinely absent file (ENOENT) becomes
  // the "download it" path — any other read failure (permissions, it's a
  // directory) is reported as itself, not mislabeled as missing.
  let raw: string | null;
  try {
    raw = await fs.readFile(CRED_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(
        `Cannot read ${CRED_PATH} — it exists but could not be read (${code}). Check file permissions. See docs/SETUP.md.`,
      );
    }
    raw = null;
  }
  const cred = checkCredentials(raw, CRED_PATH);
  if (!cred.ok) throw new Error(cred.message);

  // `mailwarden --auth`: always run the browser consent flow. We deliberately do NOT return a
  // previously saved token here — a stale/expired token.json (e.g. the 7-day refresh-token expiry
  // of a "Testing" OAuth consent screen, which surfaces as invalid_grant) would otherwise make
  // re-auth a silent no-op that never opens the browser and never replaces the dead token.
  const client = (await authenticate({ scopes: SCOPES, keyfilePath: CRED_PATH })) as OAuth2Client;
  if (!client.credentials.refresh_token) {
    throw new Error(
      "Consent completed but Google returned no refresh token — the old token was left untouched. " +
        "Revoke mailwarden's access at https://myaccount.google.com/permissions (or delete token.json), " +
        "then run `mailwarden --auth` again.",
    );
  }
  await persistToken(client, cred);
  cachedClient = null; // a later non-interactive load re-reads the freshly stored token
  return client;
}

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

async function persistToken(client: OAuth2Client): Promise<void> {
  let keys: { installed?: { client_id?: string; client_secret?: string }; web?: { client_id?: string; client_secret?: string } };
  try {
    keys = JSON.parse(await fs.readFile(CRED_PATH, "utf8"));
  } catch {
    throw new Error(
      `Cannot read OAuth credentials at ${CRED_PATH} — download the OAuth client JSON from the Google Cloud Console and place it there (see README).`,
    );
  }
  const key = keys.installed ?? keys.web;
  if (!key?.client_id || !key.client_secret) {
    throw new Error(
      `Unexpected format in ${CRED_PATH} — expected an "installed" or "web" OAuth client with client_id and client_secret.`,
    );
  }
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      },
      null,
      2,
    ),
    { mode: 0o600 }, // holds a refresh token + client secret; no-op on Windows
  );
}

/**
 * Returns an authenticated OAuth2 client.
 * - interactive=false (server runtime): loads the stored refresh token, else throws.
 * - interactive=true (`mailwarden --auth`): runs the browser consent flow once and stores it.
 */
export async function getAuth(interactive = false): Promise<OAuth2Client> {
  if (!interactive) {
    // Server runtime: reuse the stored refresh token, or tell the user to run --auth.
    const saved = await loadSavedToken();
    if (saved) return saved;
    throw new Error(
      "mailwarden is not authorized yet. Run `mailwarden --auth` once to grant Gmail access.",
    );
  }

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
  await persistToken(client);
  return client;
}

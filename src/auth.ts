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
  const keys = JSON.parse(await fs.readFile(CRED_PATH, "utf8"));
  const key = keys.installed ?? keys.web;
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
  );
}

/**
 * Returns an authenticated OAuth2 client.
 * - interactive=false (server runtime): loads the stored refresh token, else throws.
 * - interactive=true (`mailwarden --auth`): runs the browser consent flow once and stores it.
 */
export async function getAuth(interactive = false): Promise<OAuth2Client> {
  const saved = await loadSavedToken();
  if (saved) return saved;

  if (!interactive) {
    throw new Error(
      "mailwarden is not authorized yet. Run `mailwarden --auth` once to grant Gmail access.",
    );
  }

  const client = (await authenticate({ scopes: SCOPES, keyfilePath: CRED_PATH })) as OAuth2Client;
  if (client.credentials.refresh_token) await persistToken(client);
  return client;
}

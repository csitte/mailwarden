import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * `gmail.modify` covers read + write (labels, archive, trash, mark-read, attachments).
 * `gmail.settings.basic` is needed for filter management (list/create/delete_filter);
 * it grants no send capability. Existing users who authorized before this scope was
 * added must re-run `--auth` once — filter calls until then surface an actionable
 * insufficient-scope message (see gmail.ts).
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

const CONFIG_DIR = process.env.MAILWARDEN_DIR ?? path.join(os.homedir(), ".mailwarden");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");
const CRED_PATH = process.env.MAILWARDEN_CREDENTIALS ?? path.join(CONFIG_DIR, "credentials.json");

/**
 * Optional at-rest encryption of token.json.
 *
 * token.json holds a refresh token + client secret (scope `gmail.modify`). On disk it is protected
 * only by `mode 0o600`, which is a no-op on Windows. Setting `MAILWARDEN_TOKEN_PASSPHRASE` to a passphrase
 * turns on AES-256-GCM encryption keyed by scrypt, so a *copy* of the file (a backup, a synced
 * folder, another machine) is useless without the passphrase. It does NOT defend against malware
 * running as the same user — that process can read the passphrase from the environment too. Opt-in,
 * mirroring the `--http` / `MAILWARDEN_TOKEN` pattern; unset means today's plaintext behavior.
 */
const ENC_TYPE = "mailwarden-encrypted";
// These scrypt parameters are pinned to envelope `v: 1`. They are NOT stored in the file, so the
// same values must derive the key on read. If you ever change them, bump `v` and branch on the
// stored version when decrypting — otherwise every existing token.json becomes undecryptable
// (recoverable only by re-running `--auth`).
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32; // AES-256

interface EncryptedToken {
  type: typeof ENC_TYPE;
  v: 1;
  kdf: "scrypt";
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  ciphertext: string; // base64
}

function isEncrypted(o: unknown): o is EncryptedToken {
  return typeof o === "object" && o !== null && (o as { type?: unknown }).type === ENC_TYPE;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEYLEN, SCRYPT);
}

/** Encrypt a token JSON string into the on-disk envelope. Exported for unit tests. */
export function encryptToken(plaintext: string, passphrase: string): EncryptedToken {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    type: ENC_TYPE,
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt an envelope back to the token JSON string. Throws if the passphrase is wrong or the
 * ciphertext was tampered with (GCM auth-tag mismatch surfaces in `decipher.final()`). Exported
 * for unit tests.
 */
export function decryptToken(enc: EncryptedToken, passphrase: string): string {
  const key = deriveKey(passphrase, Buffer.from(enc.salt, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function loadSavedToken(): Promise<OAuth2Client | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null; // missing or malformed → treated as "not authorized"
  }

  if (isEncrypted(parsed)) {
    // An encrypted token is unusable without the key: distinguish a wrong/missing key from
    // "not authorized" so the user fixes the passphrase instead of pointlessly re-running --auth.
    const key = process.env.MAILWARDEN_TOKEN_PASSPHRASE;
    if (!key) {
      throw new Error(
        `${TOKEN_PATH} is encrypted, but MAILWARDEN_TOKEN_PASSPHRASE is not set. Set it to the passphrase ` +
          "you used when authorizing, or re-run `mailwarden --auth` to store a fresh token.",
      );
    }
    // Only a genuine decrypt failure (wrong key / tampered file) is thrown here. Once GCM verifies,
    // the recovered plaintext is fed through the same shape-tolerant path as a plaintext token, so a
    // (deliberately) wrong-shape payload becomes "not authorized" rather than a bogus "wrong key".
    let decrypted: string;
    try {
      decrypted = decryptToken(parsed, key);
    } catch {
      throw new Error(
        `Could not decrypt ${TOKEN_PATH} — MAILWARDEN_TOKEN_PASSPHRASE is wrong or the file is corrupted. ` +
          "Fix the passphrase, or re-run `mailwarden --auth` to store a fresh token.",
      );
    }
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      return null; // authenticated but not JSON — treat as not authorized
    }
  } else if (process.env.MAILWARDEN_TOKEN_PASSPHRASE) {
    // Plaintext token while a key is configured — still usable, but nudge to re-encrypt.
    console.error(
      "mailwarden: MAILWARDEN_TOKEN_PASSPHRASE is set but token.json is stored in plaintext — " +
        "re-run `mailwarden --auth` to encrypt it at rest.",
    );
  }

  try {
    return google.auth.fromJSON(parsed as Parameters<typeof google.auth.fromJSON>[0]) as OAuth2Client;
  } catch {
    return null; // valid JSON but not an authorized_user shape → not authorized
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
  const payload = JSON.stringify(
    {
      type: "authorized_user",
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: client.credentials.refresh_token,
    },
    null,
    2,
  );
  // Encrypt at rest when a passphrase is configured; otherwise store as before. The 0o600 mode
  // still applies to the encrypted file (defense in depth on POSIX; no-op on Windows, which is
  // exactly the gap MAILWARDEN_TOKEN_PASSPHRASE closes for file copies).
  const key = process.env.MAILWARDEN_TOKEN_PASSPHRASE;
  const contents = key ? JSON.stringify(encryptToken(payload, key), null, 2) : payload;
  await fs.writeFile(TOKEN_PATH, contents, { mode: 0o600 });
  if (key) console.error("mailwarden: token stored encrypted at rest (MAILWARDEN_TOKEN_PASSPHRASE).");
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

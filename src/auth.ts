import { auth as googleAuth, gmail as gmailApi } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { runConsentFlow } from "./consent.js";
import { guardEgress } from "./egress.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { authScopesForTiers, resolveEnabledTiers, GMAIL_MODIFY, GMAIL_SETTINGS_BASIC } from "./tiers.js";
import { CliError, ToolError } from "./cli.js";
import {
  ENC_TYPE,
  chooseProtection,
  isKeystoreEnvelope,
  keyEntryName,
  KEYSTORE_SERVICE,
  newKey,
  openWithKey,
  parseKeystoreSetting,
  sealWithKey,
  type KeystoreEnvelope,
} from "./keystore.js";
import { openKeyStore } from "./keystore-io.js";
// gmail.ts does not import this module, so this stays acyclic. The invalid_grant test lives there
// because that is where it is normally raised (the API layer), and the overwrite guard needs the
// same judgement: a token Google rejects is dead, a token that merely timed out is not.
import { isInvalidGrant } from "./gmail.js";

/**
 * The OAuth scopes to request are derived from the enabled tool tiers (see tiers.ts):
 * `gmail.modify` for read+write, `gmail.settings.basic` only when the `filters` tier is on
 * (it grants no send capability). Default (all tiers) = modify + settings.basic, as before.
 * Users who authorized before a scope they now need must re-run `--auth`; until then a call
 * needing the missing scope surfaces an actionable insufficient-scope message (see gmail.ts),
 * and — when the granted scopes were recorded (see persistToken) — the filter tools are
 * hidden up front rather than advertised and failing (see hasFilterScope + tools.ts).
 */

export const CONFIG_DIR = process.env.MAILWARDEN_DIR ?? path.join(os.homedir(), ".mailwarden");
export const CRED_PATH = process.env.MAILWARDEN_CREDENTIALS ?? path.join(CONFIG_DIR, "credentials.json");

/**
 * Multi-account support. One Gmail *app* (credentials.json) can authorize several *users*;
 * each account keeps its own refresh token in a separate file, selected by `MAILWARDEN_ACCOUNT`:
 *   - unset (or empty) → the default account, `token.json` — exactly today's behavior;
 *   - `MAILWARDEN_ACCOUNT=work` → `token.work.json`.
 * credentials.json is shared across accounts (same OAuth client). Run several accounts side by side
 * by registering the server twice with different `MAILWARDEN_ACCOUNT` values — each instance is fully
 * isolated (own token, own granted scopes, own tool surface), which keeps scope-gating intact.
 *
 * The account name goes into a filename, so it is restricted to a safe charset (no path separators).
 */
const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Normalize + validate an account name. **Lower-cased on purpose:** the name becomes a filename,
 * and on Windows/macOS (case-insensitive filesystems) `Work` and `work` would otherwise be two
 * account names mapping to ONE token file — the second `--auth` would silently overwrite the
 * first account's refresh token and the server would then act on the wrong mailbox. Lower-casing
 * makes the name→file mapping injective on every platform.
 */
export function sanitizeAccount(name: string): string {
  const t = name.trim().toLowerCase();
  // ACCOUNT_RE requires an alphanumeric first char, so "", ".", ".." and any path separator
  // ("/", "\") are already rejected — no dot/traversal special-casing needed.
  if (!ACCOUNT_RE.test(t)) {
    throw new CliError(
      `Invalid account name "${name}" — use letters, digits, dot, dash or underscore ` +
        "(must start alphanumeric, no path separators). Names are case-insensitive.",
    );
  }
  return t;
}

/** The selected account name, or null for the default. Throws on a malformed name. */
export function activeAccount(): string | null {
  const raw = process.env.MAILWARDEN_ACCOUNT?.trim();
  return raw ? sanitizeAccount(raw) : null;
}

/** Path to a given account's token file (default account → token.json). */
export function tokenPath(account: string | null = activeAccount()): string {
  return path.join(CONFIG_DIR, account ? `token.${account}.json` : "token.json");
}

/**
 * Account names discovered from token.<name>.json files in CONFIG_DIR (the default token.json is
 * not an "account" and is excluded). Best-effort + synchronous, for `--check`; never throws.
 */
export function discoverAccounts(): string[] {
  try {
    // Names are returned EXACTLY as they appear on disk. Lower-casing them here would hide a
    // real `token.Work.json` on a case-sensitive filesystem (Linux), where it is a genuinely
    // different file from `token.work.json` — and the raw filename is the user's only clue that
    // an unreachable token exists. Callers that need to match the active account compare
    // case-insensitively instead (see runDoctor).
    return readdirSync(CONFIG_DIR)
      .map((f) => /^token\.(.+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * At-rest encryption of token.json.
 *
 * token.json holds a refresh token + client secret (scope `gmail.modify`). On disk it is protected
 * only by `mode 0o600`, which is a no-op on Windows. By default a new token is encrypted with
 * AES-256-GCM under a random key kept in the OS keystore (envelope `v: 2`, see keystore.ts). Setting
 * `MAILWARDEN_TOKEN_PASSPHRASE` instead keys the same cipher by scrypt from a passphrase (`v: 1`,
 * below) — the choice for a host without a keystore. Either way a *copy* of the file (a backup, a
 * synced folder, another machine) is useless on its own. Neither defends against malware running as
 * the same user — that process can query the keystore, or read the passphrase from the environment.
 * Where no keystore is reachable and no passphrase is set, the token is stored in plaintext as before.
 */
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

/**
 * The passphrase envelope (`v: 1`). Anything else carrying our type is treated as one too, so an
 * unknown future version fails as "cannot decrypt" rather than being read as a plaintext token.
 * Callers test `isKeystoreEnvelope` first.
 */
function isEncrypted(o: unknown): o is EncryptedToken {
  return typeof o === "object" && o !== null && (o as { type?: unknown }).type === ENC_TYPE && !isKeystoreEnvelope(o);
}

/**
 * Decrypt a keystore envelope with its key from the OS keystore. Throws a CliError naming the
 * actual cause: no keystore here, a key that is gone (removed, or the file was copied from another
 * machine or user), or a key that does not open the file.
 */
async function unlockKeystoreToken(env: KeystoreEnvelope, tp: string): Promise<string> {
  const reauth = "Re-run `mailwarden --auth` on this machine to store a fresh token.";
  // The id comes from a file anyone with write access could edit: reject it before it names an
  // entry, so an edited file cannot point mailwarden at another application's credential.
  const entry = keyEntryName(env.keyId);
  const opened = await openKeyStore();
  if (!opened.ok) {
    throw new CliError(`${tp} is encrypted with a key in the OS keystore, but ${opened.reason}. ${reauth}`);
  }
  let key: Buffer | null;
  try {
    key = await opened.store.get(env.keyId);
  } catch (err) {
    throw new CliError(
      `Could not read the key for ${tp} from the OS keystore (${err instanceof Error ? err.message : String(err)}). ` +
        "If the keystore is locked, unlock it and retry.",
    );
  }
  if (!key) {
    throw new CliError(
      `${tp} is encrypted with a key that is not in this machine's OS keystore ` +
        `(${KEYSTORE_SERVICE} / ${entry}) — it was removed, or the file was copied ` +
        `from another machine or user. ${reauth}`,
    );
  }
  try {
    return openWithKey(env, key);
  } catch {
    throw new CliError(`Could not decrypt ${tp} with its key from the OS keystore — the file is corrupted or was edited. ${reauth}`);
  }
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

/**
 * The scopes recorded in token.json, or null when unknown — no token yet, an older
 * token written before scopes were recorded, or a passphrase-encrypted token (whose scope lives
 * inside the ciphertext; we deliberately don't decrypt synchronously at registration). A keystore
 * envelope carries its scope in the clear for exactly this reason (see keystore.ts).
 * Synchronous + network-free by design: it runs while the tool surface is being built.
 */
export function persistedScopes(): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(tokenPath(), "utf8"));
    if (isKeystoreEnvelope(parsed)) return scopesOf(parsed);
    if (isEncrypted(parsed)) return null; // passphrase envelope → scope not readable without the key
    return scopesOf(parsed);
  } catch {
    return null; // missing / unreadable / not JSON
  }
}

/** Pull the recorded scopes out of a parsed token payload; null when absent or the wrong shape. */
function scopesOf(parsed: unknown): string[] | null {
  const scope = (parsed as { scope?: unknown } | null)?.scope;
  return typeof scope === "string" && scope.trim() ? scope.trim().split(/\s+/) : null;
}

/**
 * Why the granted scopes could not be read — `--check` must tell these apart. Collapsing them
 * into one "unknown" produced a false "token records no scopes, re-run `--auth`" for a merely
 * locked token, and following that advice re-authorizes WITHOUT the passphrase, replacing an
 * encrypted token with a plaintext one.
 */
export type ScopeRead =
  | { known: true; scopes: string[] } // recorded and readable
  | { known: false; reason: "no-token" | "unrecorded" | "locked" | "bad-key" | "unreadable" };

/**
 * Granted scopes for the active account, decrypting when the passphrase is available. The async
 * counterpart of `persistedScopes`, which stays synchronous and never decrypts because it runs
 * while the tool surface is built. Never throws: every failure is a `reason`, so the doctor can
 * report the real cause instead of crashing or guessing.
 */
export async function readGrantedScopes(): Promise<ScopeRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(tokenPath(), "utf8"));
  } catch (err) {
    return { known: false, reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "no-token" : "unreadable" };
  }
  if (isKeystoreEnvelope(parsed)) {
    // In the clear and authenticated at decryption — no keystore access needed to report it.
    const scopes = scopesOf(parsed);
    return scopes ? { known: true, scopes } : { known: false, reason: "unrecorded" };
  }
  if (isEncrypted(parsed)) {
    const key = process.env.MAILWARDEN_TOKEN_PASSPHRASE;
    if (!key) return { known: false, reason: "locked" };
    try {
      parsed = JSON.parse(decryptToken(parsed, key));
    } catch {
      return { known: false, reason: "bad-key" };
    }
  }
  const scopes = scopesOf(parsed);
  return scopes ? { known: true, scopes } : { known: false, reason: "unrecorded" };
}

/**
 * The on-disk state of token.json, for the `--check` doctor: whether it exists and,
 * if so, whether it is plaintext, a passphrase envelope ("encrypted") or a keystore envelope
 * ("keystore", with the key id the doctor looks up). "invalid" = present but not JSON.
 * Synchronous + network-free; does not attempt to decrypt.
 */
export type TokenFileState =
  | { state: "missing" | "plaintext" | "encrypted" | "invalid" }
  | { state: "keystore"; keyId: string };

export function tokenFileState(): TokenFileState {
  let raw: string;
  try {
    raw = readFileSync(tokenPath(), "utf8");
  } catch {
    return { state: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "invalid" };
  }
  if (isKeystoreEnvelope(parsed)) return { state: "keystore", keyId: parsed.keyId };
  return { state: isEncrypted(parsed) ? "encrypted" : "plaintext" };
}

/**
 * Whether the keystore key of a keystore-encrypted token is there, for `--check`. Never throws.
 * "unavailable" = no keystore on this machine; "missing" = keystore present, key not in it.
 */
export async function keystoreKeyState(
  keyId: string,
): Promise<{ state: "present" | "missing" } | { state: "unavailable" | "error"; reason: string }> {
  const opened = await openKeyStore();
  if (!opened.ok) return { state: "unavailable", reason: opened.reason };
  try {
    return { state: (await opened.store.get(keyId)) ? "present" : "missing" };
  } catch (err) {
    return { state: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * How the NEXT `--auth` would protect the token, for `--check`. Opens the keystore only when the
 * setting allows it to be used, so `MAILWARDEN_KEYSTORE=off` never loads native code.
 */
export async function plannedProtection(env: NodeJS.ProcessEnv = process.env) {
  const setting = parseKeystoreSetting(env.MAILWARDEN_KEYSTORE);
  const passphraseSet = Boolean(env.MAILWARDEN_TOKEN_PASSPHRASE);
  const store = passphraseSet || setting === "off" ? { ok: false as const, reason: "not consulted" } : await openKeyStore();
  return chooseProtection({ passphraseSet, setting, store });
}

/**
 * Whether the stored token carries the filter scope (gmail.settings.basic):
 * true / false when the granted scopes are known, undefined when they aren't
 * (see persistedScopes). tools.ts advertises the filter tier unless this is false.
 */
export function hasFilterScope(): boolean | undefined {
  const scopes = persistedScopes();
  return scopes === null ? undefined : scopes.includes(GMAIL_SETTINGS_BASIC);
}

/**
 * Whether the stored token can write (gmail.modify) — true/false when the granted
 * scopes are known, undefined when they aren't. Snooze sweeping (--sweep /
 * MAILWARDEN_AUTO_SWEEP) writes, so a read-only grant can't sweep; index.ts warns
 * up front instead of failing silently every hour.
 */
export function hasModifyScope(): boolean | undefined {
  const scopes = persistedScopes();
  return scopes === null ? undefined : scopes.includes(GMAIL_MODIFY);
}

async function loadSavedToken(): Promise<OAuth2Client | null> {
  const tp = tokenPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(tp, "utf8"));
  } catch {
    return null; // missing or malformed → treated as "not authorized"
  }

  if (isKeystoreEnvelope(parsed)) {
    // Same rule as the passphrase branch below: only a genuine unlock failure throws; a payload
    // that decrypts but is not JSON reads as "not authorized".
    const decrypted = await unlockKeystoreToken(parsed, tp);
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      return null;
    }
  } else if (isEncrypted(parsed)) {
    // An encrypted token is unusable without the key: distinguish a wrong/missing key from
    // "not authorized" so the user fixes the passphrase instead of pointlessly re-running --auth.
    const key = process.env.MAILWARDEN_TOKEN_PASSPHRASE;
    if (!key) {
      throw new CliError(
        `${tp} is encrypted, but MAILWARDEN_TOKEN_PASSPHRASE is not set. Set it to the passphrase ` +
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
      throw new CliError(
        `Could not decrypt ${tp} — MAILWARDEN_TOKEN_PASSPHRASE is wrong or the file is corrupted. ` +
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
      `mailwarden: MAILWARDEN_TOKEN_PASSPHRASE is set but ${tp} is stored in plaintext — ` +
        "re-run `mailwarden --auth` to encrypt it at rest.",
    );
  }

  try {
    // Guarded here, at the source, rather than by each caller. `getAuth` remembered to wrap
    // its client; `identifyStoredToken` did not, and so the `--auth` mailbox probe ran outside
    // the checkpoint the comment on that client claims covers it. The call it made is on the
    // allowlist, so nothing escaped — but a checkpoint every caller has to remember is one a
    // future caller will forget. Wrapping the only place a stored token becomes a client means
    // there is nothing left to remember. `guardEgress` is idempotent, so the caller that does
    // wrap stays correct.
    return guardEgress(
      googleAuth.fromJSON(parsed as Parameters<typeof googleAuth.fromJSON>[0]) as OAuth2Client,
    );
  } catch {
    return null; // valid JSON but not an authorized_user shape → not authorized
  }
}

/** Validated OAuth client credentials, or an actionable reason they're unusable. */
export type CredCheck =
  | {
      ok: true;
      kind: "installed" | "web";
      client_id: string;
      client_secret: string;
      /** First registered redirect URI — Google matches it exactly, so it is not ours to invent. */
      redirect_uri: string;
    }
  | { ok: false; message: string };

/**
 * `--auth` preflight: validate the credentials.json shape BEFORE the browser
 * consent flow. Without this, local-auth fails deep inside `authenticate()` with
 * cryptic errors — `Cannot find module` (missing file), a raw JSON parse error,
 * or `Cannot read properties of undefined (reading 'redirect_uris')` (not an
 * OAuth *client* file) — none of which tell the user what to actually do.
 *
 * Pure (string in, result out) so it's unit-tested without an OAuth flow.
 * `raw` is null when the file is missing. The redirect URI is validated here too
 * since `@google-cloud/local-auth` was dropped (see consent.ts) — it used to be
 * the one raising that particular error, and it was the one message of its set
 * that was already clear, so its substance is kept.
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
    | { client_id?: unknown; client_secret?: unknown; redirect_uris?: unknown }
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
  // The consent flow redirects here; Google matches the URI against what is registered for the
  // client, so an absent or non-loopback one cannot be worked around — it has to be fixed in the
  // Cloud Console. A "Desktop app" client always ships a loopback URI, which is why the message
  // points at the client type rather than at the field.
  const uris = key.redirect_uris;
  const first = Array.isArray(uris) && typeof uris[0] === "string" ? uris[0] : undefined;
  let host: string | undefined;
  if (first) {
    try {
      host = new URL(first).hostname;
    } catch {
      host = undefined;
    }
  }
  if (!first || (host !== "localhost" && host !== "127.0.0.1")) {
    return {
      ok: false,
      message: `${credPath} has no usable loopback redirect URI (expected a "redirect_uris" entry on localhost, e.g. "http://localhost"). This is what an OAuth client of type "Desktop app" gives you — a "Web application" client redirects somewhere else and cannot complete a local consent flow. Create a Desktop app client in Google Cloud Console and download that. See docs/SETUP.md.`,
    };
  }
  return {
    ok: true,
    kind,
    client_id: key.client_id,
    client_secret: key.client_secret,
    redirect_uri: first,
  };
}

async function persistToken(
  client: OAuth2Client,
  cred: { client_id: string; client_secret: string },
  account: string | null,
  email?: string | null,
): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const payload = JSON.stringify(
    {
      type: "authorized_user",
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: client.credentials.refresh_token,
      // Record the granted scopes so registration can gate scope-dependent tools
      // (filters) without a network round-trip. Optional: google.auth.fromJSON
      // ignores this extra field, and an older token without it reads as "unknown".
      ...(client.credentials.scope ? { scope: client.credentials.scope } : {}),
      // Record WHICH mailbox this token belongs to, so a later `--auth` can tell whether it is
      // about to replace a token for a *different* account (see tokenOverwriteVerdict). Same
      // deal as `scope`: google.auth.fromJSON ignores it, and an older file without it reads
      // as "unknown" rather than as a mismatch.
      ...(email ? { email } : {}),
    },
    null,
    2,
  );
  // Encrypt at rest (see chooseProtection for the order). The 0o600 mode still applies to the
  // encrypted file (defense in depth on POSIX; no-op on Windows, which is exactly the gap the
  // encryption closes for file copies).
  const file = tokenPath(account);
  const passphrase = process.env.MAILWARDEN_TOKEN_PASSPHRASE;
  const setting = parseKeystoreSetting(process.env.MAILWARDEN_KEYSTORE);
  const opened = passphrase || setting === "off" ? null : await openKeyStore();
  const protection = chooseProtection({
    passphraseSet: Boolean(passphrase),
    setting,
    store: opened ?? { ok: false, reason: "not consulted" },
  });
  // The key the file in place was sealed with, removed once the new file is down — re-authorizing
  // would otherwise leave one orphaned keystore entry behind each time.
  const previousKeyId = await keyIdOf(file);

  if (protection.kind === "passphrase") {
    await fs.writeFile(file, JSON.stringify(encryptToken(payload, passphrase!), null, 2), { mode: 0o600 });
    console.error("mailwarden: token stored encrypted at rest (MAILWARDEN_TOKEN_PASSPHRASE).");
  } else if (protection.kind === "keystore" && opened?.ok) {
    const { keyId, key } = newKey();
    let stored = false;
    try {
      await opened.store.set(keyId, key);
      stored = true;
    } catch (err) {
      // A keystore that is present but refuses the write (locked, denied) must not cost the user the
      // consent they just gave: store as before and say why.
      console.error(
        `mailwarden: could not store a key in the OS keystore (${err instanceof Error ? err.message : String(err)}) — ` +
          "token stored in plaintext. Set MAILWARDEN_TOKEN_PASSPHRASE to encrypt it instead.",
      );
    }
    if (stored) {
      try {
        await fs.writeFile(file, JSON.stringify(sealWithKey(payload, key, keyId, client.credentials.scope ?? undefined), null, 2), {
          mode: 0o600,
        });
      } catch (err) {
        await opened.store.delete(keyId).catch(() => false);
        throw err;
      }
      console.error("mailwarden: token stored encrypted at rest (key in the OS keystore).");
    } else {
      await fs.writeFile(file, payload, { mode: 0o600 });
    }
  } else {
    await fs.writeFile(file, payload, { mode: 0o600 });
    if (protection.kind === "plaintext" && protection.why === "unavailable") {
      console.error(
        `mailwarden: token stored in plaintext — ${protection.detail}. ` +
          "Set MAILWARDEN_TOKEN_PASSPHRASE to encrypt it at rest.",
      );
    }
  }

  if (previousKeyId) {
    const current = await keyIdOf(file);
    if (current !== previousKeyId) {
      const store = opened ?? (await openKeyStore());
      if (store.ok) await store.store.delete(previousKeyId).catch(() => false);
    }
  }
}

/** The keystore key id of the token file at `file`, or null (absent, plaintext, passphrase). */
async function keyIdOf(file: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isKeystoreEnvelope(parsed) ? parsed.keyId : null;
  } catch {
    return null;
  }
}

/** Gmail addresses are case-insensitive in practice; compare them that way. */
const sameMailbox = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type OverwriteCheck = { ok: true; note?: string } | { ok: false; message: string };

/**
 * May `--auth` replace the token file that is already there?
 *
 * The accident this exists for (reported 15.08.2026, and proven by Google's own grant mail):
 * the target path is decided by `--account`/`MAILWARDEN_ACCOUNT` ALONE, never by the account
 * clicked in the consent screen. So authorizing a second mailbox from a repo checkout — a bare
 * `npm run auth` — silently replaced the *first* mailbox's token. Nothing failed, and the success
 * line ("authorized as <address>") was formally true, which is exactly why nobody read it as a
 * warning.
 *
 * The rule is therefore: overwrite only what we can positively identify as the SAME mailbox.
 * "Cannot tell" counts as a mismatch, not as permission — a token written before this version
 * records no account, and that is precisely the first run after an update, i.e. the run the check
 * is supposed to catch. Being lenient there would make the whole guard inert exactly once per
 * installation, at the decisive moment. (That correction came from the multi-account session
 * reviewing this design; the first sketch had the blind spot.)
 */
export function tokenOverwriteVerdict(input: {
  tokenFile: string;
  exists: boolean;
  storedEmail: string | null;
  storedDead?: boolean;
  newEmail: string | null;
  force: boolean;
  account: string | null;
}): OverwriteCheck {
  const { tokenFile, exists, storedEmail, storedDead, newEmail, force, account } = input;
  if (!exists) return { ok: true };
  if (storedEmail && newEmail && sameMailbox(storedEmail, newEmail)) return { ok: true };
  // A token Google itself rejects (invalid_grant — revoked, or the 7-day expiry of a "Testing"
  // consent screen) guards nothing: whoever owns it cannot use it either, so replacing it takes
  // nothing away. Note the narrowness — ONLY invalid_grant counts. A timeout or a 5xx also fails
  // to name the account, but says nothing about the token, and waving those through would let a
  // flaky network do exactly the damage this check prevents.
  if (storedDead && !storedEmail) {
    return {
      ok: true,
      note: `Replacing ${tokenFile}: the token stored there is no longer accepted by Google (invalid_grant), so nothing was lost.`,
    };
  }

  const what = storedEmail
    ? `It holds a token for ${storedEmail}`
    : `It could not be identified — a token written before this version records no account, and an ` +
      `expired, encrypted or malformed one cannot be asked either`;
  const granted = newEmail ? `you just authorized ${newEmail}` : `the account you just authorized could not be confirmed`;

  if (force) {
    return { ok: true, note: `Replacing ${tokenFile} as instructed (--force): ${what.toLowerCase()}, ${granted}.` };
  }

  // When an identity is merely UNKNOWN rather than different, the likeliest cause is not a mixed-up
  // mailbox at all — a dropped connection or a Gmail API that was never enabled lands here too. Say
  // so, or the reader goes hunting for a multi-account mistake they never made.
  const whyElse =
    !storedEmail || !newEmail
      ? `\nThis also fires when the check simply could not run — a failed network call, or a Gmail API ` +
        `that is not enabled for this project, leaves an account unidentified.`
      : "";

  return {
    ok: false,
    message:
      `Refusing to overwrite ${tokenFile}. ${what}, and ${granted}.\n` +
      `Replacing it would leave that mailbox without a token — silently, which is the accident this check exists for.${whyElse}\n\n` +
      `  To authorize a SECOND mailbox alongside the first:\n` +
      `      mailwarden --auth --account <name>      (writes token.<name>.json, leaves this file alone)\n` +
      `  To deliberately replace the token in ${tokenFile}:\n` +
      `      mailwarden --auth${account ? ` --account ${account}` : ""} --force\n\n` +
      `Nothing was written. The consent you completed in the browser granted access but stored no ` +
      `token here; revoke it at https://myaccount.google.com/permissions if it was not intended.`,
  };
}

/**
 * Which mailbox does the token at `tokenFile` belong to? `null` when that cannot be established —
 * which this deliberately does NOT paper over: an unidentifiable token is treated as a mismatch
 * above. Tokens written by this version answer from the file (no network); older ones are asked
 * live, so a still-valid token of the SAME account re-authorizes without friction.
 */
async function identifyStoredToken(): Promise<{ exists: boolean; email: string | null; dead: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(tokenPath(), "utf8"));
  } catch (err) {
    // ENOENT = nothing to overwrite. Anything else (unreadable, not JSON) exists but cannot be
    // identified — reported as such rather than as absent, which would wave the write through.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, email: null, dead: false };
    return { exists: true, email: null, dead: false };
  }
  if (isKeystoreEnvelope(parsed)) {
    // The address is inside the ciphertext. A key that is gone leaves the file unidentifiable,
    // which the verdict treats as a mismatch — the same as any other token it cannot read.
    try {
      parsed = JSON.parse(await unlockKeystoreToken(parsed, tokenPath()));
    } catch {
      return { exists: true, email: null, dead: false };
    }
  }
  const recorded = (parsed as { email?: unknown } | null)?.email;
  if (typeof recorded === "string" && recorded.trim()) return { exists: true, email: recorded.trim(), dead: false };

  // No recorded account: ask Gmail with the OLD token. One extra call, only during interactive
  // `--auth`, and only for tokens predating this field — so an existing install is covered on its
  // very first run rather than one auth too late, which is the whole point of the check.
  try {
    const client = await loadSavedToken();
    if (!client) return { exists: true, email: null, dead: false }; // malformed shape: unusable, but unproven
    return { exists: true, ...(await probeEmail(client)) };
  } catch {
    // Encrypted without a passphrase, for instance: exists, cannot be asked, not proven dead.
    return { exists: true, email: null, dead: false };
  }
}

/**
 * The mailbox a client is authorized for. Never throws — `--auth` must not fail over a probe — but
 * it does distinguish the one failure that carries meaning: `invalid_grant` proves the token is
 * expired or revoked, whereas a timeout proves nothing.
 */
async function probeEmail(client: OAuth2Client): Promise<{ email: string | null; dead: boolean }> {
  try {
    const res = await gmailApi({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
    return { email: res.data.emailAddress ?? null, dead: false };
  } catch (err) {
    return { email: null, dead: isInvalidGrant(err) };
  }
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
 * Returns an authenticated OAuth2 client for the account in effect (MAILWARDEN_ACCOUNT, or the
 * default). The CLI sets that env from `--account` up front, so account selection is uniform across
 * load and store — there is no per-call account argument to diverge from it.
 * - interactive=false (server runtime): loads the stored refresh token, else throws.
 * - interactive=true (`mailwarden --auth`): runs the browser consent flow once and stores it.
 */
export async function getAuth(interactive = false, opts: { force?: boolean } = {}): Promise<OAuth2Client> {
  if (!interactive) {
    if (cachedClient) return cachedClient;
    // Server runtime: reuse the stored refresh token, or tell the user to run --auth.
    const saved = await loadSavedToken();
    // Already guarded — `loadSavedToken` wraps every client it hands out. Re-wrapping here would
    // be free (the guard is idempotent) but would teach the wrong rule: that a caller is the one
    // responsible for the checkpoint. That rule is exactly what left the `--auth` probe uncovered.
    if (saved) return (cachedClient = saved);
    // Name the account and the file we looked for, and the exact command that fills THAT file.
    // A bare `mailwarden --auth` writes the DEFAULT token.json — telling a named-account user to
    // run it would overwrite their default account's token and leave this error unchanged.
    const account = activeAccount();
    throw new ToolError(
      "not_authorized",
      `Not authorized yet for ${account ? `account '${account}'` : "the default account"} ` +
        `(no token at ${tokenPath(account)}). Run \`mailwarden --auth${account ? ` --account ${account}` : ""}\` ` +
        "once to grant Gmail access.",
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
      throw new CliError(
        `Cannot read ${CRED_PATH} — it exists but could not be read (${code ?? "unknown error"}). Check file permissions. See docs/SETUP.md.`,
      );
    }
    raw = null;
  }
  const cred = checkCredentials(raw, CRED_PATH);
  if (!cred.ok) throw new CliError(cred.message);

  // `mailwarden --auth`: always run the browser consent flow. We deliberately do NOT return a
  // previously saved token here — a stale/expired token.json (e.g. the 7-day refresh-token expiry
  // of a "Testing" OAuth consent screen, which surfaces as invalid_grant) would otherwise make
  // re-auth a silent no-op that never opens the browser and never replaces the dead token.
  const scopes = authScopesForTiers(resolveEnabledTiers(process.env));
  const account = activeAccount();
  // Name the target BEFORE the browser opens. After the fact it is a report; here it is the last
  // moment a `Ctrl-C` still helps — and the path, not the address, is what tells a multi-account
  // user that this run is about to aim at the wrong file.
  console.error(`mailwarden: authorizing → will write ${tokenPath(account)}`);
  const tokens = await runConsentFlow({
    clientId: cred.client_id,
    clientSecret: cred.client_secret,
    registeredRedirect: cred.redirect_uri,
    kind: cred.kind,
    scopes,
  });
  // Guarded from the moment it exists, so even the probe/persist steps of `--auth`
  // run behind the same egress checkpoint the server does.
  const client = guardEgress(
    new OAuth2Client({
      clientId: cred.client_id,
      clientSecret: cred.client_secret,
    }),
  );
  client.setCredentials(tokens);
  if (!client.credentials.refresh_token) {
    throw new CliError(
      "Consent completed but Google returned no refresh token — the old token was left untouched. " +
        "Revoke mailwarden's access at https://myaccount.google.com/permissions (or delete token.json), " +
        "then run `mailwarden --auth` again.",
    );
  }

  // Never replace one mailbox's token with another's by accident. Both sides are established
  // first: which account the file currently belongs to, and which one the consent screen just
  // authorized. The verdict is a pure function so its rules are testable without a browser.
  const stored = await identifyStoredToken();
  const fresh = await probeEmail(client);
  const verdict = tokenOverwriteVerdict({
    tokenFile: tokenPath(account),
    exists: stored.exists,
    storedEmail: stored.email,
    storedDead: stored.dead,
    newEmail: fresh.email,
    force: opts.force === true,
    account,
  });
  if (!verdict.ok) throw new CliError(verdict.message);
  if (verdict.note) console.error(`mailwarden: ${verdict.note}`);

  await persistToken(client, cred, account, fresh.email);
  cachedClient = null; // a later non-interactive load re-reads the freshly stored token
  return client;
}

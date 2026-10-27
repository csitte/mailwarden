import crypto from "node:crypto";
import { CliError } from "./cli.js";

/**
 * Token encryption with the key held in the OS keystore — Windows Credential Manager, the macOS
 * Keychain, the Secret Service on Linux. The pure half: envelope format, settings, and the choice
 * of protection. The native binding lives in keystore-io.ts, apart from this, so tests replace that
 * one module and never reach a real keystore.
 *
 * The envelope (`v: 2`) holds no key material. `keyId` names the keystore entry that does, so a
 * copy of the file — a backup, a synced folder, another machine or user — cannot be decrypted. What
 * it does NOT defend against is malware running as the same user: it can ask the keystore exactly
 * as mailwarden does. The passphrase envelope (`v: 1`, auth.ts) stays as the explicit choice for a
 * host without a keystore, and wins whenever MAILWARDEN_TOKEN_PASSPHRASE is set.
 *
 * One key per token file, named by a random id rather than by the account: two config dirs
 * (MAILWARDEN_DIR) can both hold a `token.work.json`, and an entry named after the account would
 * let one `--auth` replace the key the other file still needs.
 */

/** Shared with the passphrase envelope in auth.ts; `v` and `kdf` tell the two apart. */
export const ENC_TYPE = "mailwarden-encrypted";
/** The keystore "service" every mailwarden key is filed under. */
export const KEYSTORE_SERVICE = "mailwarden";
const KEYLEN = 32; // AES-256

export interface KeystoreEnvelope {
  type: typeof ENC_TYPE;
  v: 2;
  kdf: "keystore";
  keyId: string;
  /**
   * The granted scopes, in the clear. Registration reads them synchronously to decide which tools
   * to advertise and must not wait on a keystore (or on a dialog it might raise). Not secret, and
   * bound into the GCM tag as additional data, so an edited value fails at the next decryption.
   * Until then it can only change which tools are advertised — Google enforces the real scope.
   */
  scope?: string;
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  ciphertext: string; // base64
}

const KEY_ID_RE = /^[0-9a-f]{24}$/;

export function isKeystoreEnvelope(o: unknown): o is KeystoreEnvelope {
  if (typeof o !== "object" || o === null) return false;
  const e = o as Partial<KeystoreEnvelope>;
  return e.type === ENC_TYPE && e.v === 2 && e.kdf === "keystore" && typeof e.keyId === "string";
}

/** A fresh random key and the id its keystore entry is filed under. */
export function newKey(): { keyId: string; key: Buffer } {
  return { keyId: crypto.randomBytes(12).toString("hex"), key: crypto.randomBytes(KEYLEN) };
}

/**
 * The keystore entry name for a key id. The id is checked here, not trusted: it comes from a file
 * on disk, and an entry name built from an arbitrary string would let an edited file point
 * mailwarden at some other application's credential.
 */
export function keyEntryName(keyId: string): string {
  if (!KEY_ID_RE.test(keyId)) throw new CliError(`Malformed key id in the token file: ${JSON.stringify(keyId)}`);
  return `token-key-${keyId}`;
}

function additionalData(keyId: string, scope: string | undefined): Buffer {
  return Buffer.from(JSON.stringify({ type: ENC_TYPE, v: 2, kdf: "keystore", keyId, scope: scope ?? null }), "utf8");
}

/** Encrypt a token JSON string with a keystore key. Pure; exported for tests. */
export function sealWithKey(plaintext: string, key: Buffer, keyId: string, scope?: string): KeystoreEnvelope {
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(keyId, scope));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    type: ENC_TYPE,
    v: 2,
    kdf: "keystore",
    keyId,
    ...(scope ? { scope } : {}),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decrypt a keystore envelope. Throws on a wrong key, an edited scope, or a tampered ciphertext. */
export function openWithKey(env: KeystoreEnvelope, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAAD(additionalData(env.keyId, env.scope));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * `MAILWARDEN_KEYSTORE`: `auto` (default) encrypts new tokens with a keystore key wherever one is
 * reachable; `off` never stores a key in the keystore (a re-auth still removes the key of the token it
 * replaces, so none is left orphaned). It governs writing only — a token that was stored
 * with a keystore key still needs that key to be read, whatever this says.
 */
export type KeystoreSetting = "auto" | "off";

export function parseKeystoreSetting(raw: string | undefined): KeystoreSetting {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "auto" || v === "on") return "auto";
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  throw new CliError(`Invalid MAILWARDEN_KEYSTORE=${JSON.stringify(raw)} — use "auto" (the default) or "off".`);
}

export type Protection =
  | { kind: "passphrase" }
  | { kind: "keystore" }
  | { kind: "plaintext"; why: "off" | "unavailable"; detail?: string };

/**
 * How a token about to be written is protected. A passphrase is an explicit choice and wins; then
 * the keystore, unless switched off; and where none is reachable, plaintext exactly as before —
 * the caller says so, it does not fail.
 */
export function chooseProtection(i: {
  passphraseSet: boolean;
  setting: KeystoreSetting;
  store: { ok: true } | { ok: false; reason: string };
}): Protection {
  if (i.passphraseSet) return { kind: "passphrase" };
  if (i.setting === "off") return { kind: "plaintext", why: "off" };
  if (i.store.ok) return { kind: "keystore" };
  return { kind: "plaintext", why: "unavailable", detail: i.store.reason };
}

import { createRequire } from "node:module";
import { KEYSTORE_SERVICE, keyEntryName } from "./keystore.js";

/**
 * The one place the native keystore binding (`@napi-rs/keyring`) is loaded. Kept out of keystore.ts
 * so tests mock this module and no test run can write to the developer's real keystore.
 *
 * Loaded lazily and only when a token is written with, or read from, a keystore key: a deployment
 * that never uses one never loads native code, and a platform without a prebuilt binary falls back
 * instead of failing at startup.
 */

export interface KeyStore {
  get(keyId: string): Promise<Buffer | null>;
  set(keyId: string, key: Buffer): Promise<void>;
  delete(keyId: string): Promise<boolean>;
}

export type KeyStoreOpen = { ok: true; store: KeyStore } | { ok: false; reason: string };

type Keyring = typeof import("@napi-rs/keyring");

let opened: Promise<KeyStoreOpen> | undefined;

/** The keystore of this machine and user, or why there is none. Opened once per process. */
export function openKeyStore(): Promise<KeyStoreOpen> {
  return (opened ??= open());
}

async function open(): Promise<KeyStoreOpen> {
  let kr: Keyring;
  try {
    kr = createRequire(import.meta.url)("@napi-rs/keyring") as Keyring;
  } catch (err) {
    return { ok: false, reason: `no native keystore binding for ${process.platform}-${process.arch} (${message(err)})` };
  }
  // Linux: require the Secret Service. Left to itself the binding falls back to the kernel keyring,
  // which lives in memory and does not survive a reboot — a key stored there would leave the token
  // undecryptable after the next restart. With the store pinned, the constructor throws instead,
  // and the caller falls back to an unencrypted token it can say something about.
  const options = process.platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
  const entry = (keyId: string) => new kr.AsyncEntry(KEYSTORE_SERVICE, keyEntryName(keyId), options);
  try {
    entry("0".repeat(24));
  } catch (err) {
    return { ok: false, reason: `no OS keystore reachable (${message(err)})` };
  }
  return {
    ok: true,
    store: {
      async get(keyId) {
        const secret = await entry(keyId).getSecret();
        return secret ? Buffer.from(secret) : null;
      },
      async set(keyId, key) {
        await entry(keyId).setSecret(key);
      },
      async delete(keyId) {
        return entry(keyId).deleteCredential();
      },
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

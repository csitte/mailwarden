import os from "node:os";
import path from "node:path";

// Point mailwarden's config dir at a throwaway path for the whole test run so
// no test can ever fall back to the developer's real ~/.mailwarden token —
// which would make auth.ts's "not authorized" tests pass locally but fail on a
// dev machine that has real credentials (or vice-versa) if an env stub is lost.
// Tests that need specific auth state still override MAILWARDEN_DIR to their own
// temp dir; vi.unstubAllEnvs() then restores it to this empty default, never the
// real home. The path is intentionally not created (no token.json → unauthorized).
// Only MAILWARDEN_DIR is set — CRED_PATH then falls back to <dir>/credentials.json,
// which the interactive auth tests rely on pointing inside their own temp dir.
process.env.MAILWARDEN_DIR = path.join(os.tmpdir(), "mailwarden-tests-empty-home");

// No test may reach the developer's real OS keystore. keystore-io.ts is the only module that loads
// the native binding, so it is replaced for the whole run by an in-memory store whose state lives
// on globalThis (it survives vi.resetModules()). Tests that exercise the keystore path set
// `mode` and inspect `entries`; MAILWARDEN_KEYSTORE=off keeps every other test on the plaintext
// path it was written against.
import { vi } from "vitest";
import type { FakeKeyStore } from "./fake-keystore.js";

const g = globalThis as { __mwKeystore?: FakeKeyStore };
g.__mwKeystore ??= { mode: "ok", entries: new Map(), calls: [] };

vi.mock("../src/keystore-io.js", () => ({
  openKeyStore: async () => {
    const ks = (globalThis as { __mwKeystore?: FakeKeyStore }).__mwKeystore!;
    ks.calls.push("open");
    if (ks.mode === "unavailable") return { ok: false, reason: "no OS keystore reachable (fake)" };
    return {
      ok: true,
      store: {
        async get(id: string) {
          ks.calls.push(`get:${id}`);
          if (ks.mode === "get-fails") throw new Error("keystore locked (fake)");
          return ks.entries.get(id) ?? null;
        },
        async set(id: string, key: Buffer) {
          ks.calls.push(`set:${id}`);
          if (ks.mode === "set-fails") throw new Error("access denied (fake)");
          ks.entries.set(id, Buffer.from(key));
        },
        async delete(id: string) {
          ks.calls.push(`delete:${id}`);
          return ks.entries.delete(id);
        },
      },
    };
  },
}));

process.env.MAILWARDEN_KEYSTORE = "off";

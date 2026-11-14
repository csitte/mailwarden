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
// Every other MAILWARDEN_* variable from the developer's shell is dropped first: tests are written
// against the defaults, and a passphrase, tier list or confirm mode set for daily use turned dozens
// of them red on such a machine while CI stayed green.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("MAILWARDEN_")) delete process.env[name];
}
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

// No test may reach the network either. Every `--auth` path probes the mailbox (`probeEmail`), and
// with the fake client the tests use, that probe used to go out to oauth2.googleapis.com for real:
// 32 requests from 22 tests in auth.test.ts and keystore.test.ts (measured 14.11.2026), each
// waiting on Google's 401. On a CI runner one such round trip outlasted vitest's 5 s timeout and
// turned a test red that has nothing to do with timing. The outcome never depended on Google
// anyway — a 401 `invalid_client` and a dropped connection both leave the account unidentified and
// the token not proven dead — so the tests now get the dropped connection, at once and every time.
// Loopback stays open: the consent-flow tests talk to the redirect server they start themselves.
// `test/no-network.test.ts` checks that the block holds, so removing it turns that file red.
import http from "node:http";
import https from "node:https";

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

function blockedHost(args: unknown[]): string | null {
  let host = "";
  for (const a of args) {
    if (typeof a === "string") host = new URL(a).hostname;
    else if (a instanceof URL) host = a.hostname;
    else if (a && typeof a === "object") {
      const o = a as { hostname?: string | null; host?: string | null };
      host = o.hostname ?? o.host?.replace(/:\d+$/, "") ?? host;
    } else continue;
    if (host) break;
  }
  host ||= "localhost"; // Node's own default when neither is given
  return LOOPBACK.test(host) ? null : host;
}

function networkBlocked(host: string): Error {
  return Object.assign(new Error(`test/setup.ts: no network in tests — blocked a request to ${host}`), {
    code: "ENETUNREACH",
  });
}

const gNet = globalThis as { __mwNetworkBlocked?: boolean };
if (!gNet.__mwNetworkBlocked) {
  gNet.__mwNetworkBlocked = true;
  for (const mod of [http, https] as const) {
    for (const fn of ["request", "get"] as const) {
      const original = mod[fn] as (...args: unknown[]) => http.ClientRequest;
      (mod as Record<string, unknown>)[fn] = function (this: unknown, ...args: unknown[]) {
        const host = blockedHost(args);
        if (host) throw networkBlocked(host);
        return original.apply(this, args);
      };
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.test(url.hostname)) throw new TypeError("fetch failed", { cause: networkBlocked(url.hostname) });
    return originalFetch(input, init);
  };
}

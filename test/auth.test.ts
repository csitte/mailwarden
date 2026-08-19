import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkCredentials, encryptToken, decryptToken, tokenOverwriteVerdict } from "../src/auth.js";
import type { OverwriteCheck } from "../src/auth.js";

// Stable mock instance that survives vi.resetModules() (the factory re-runs,
// but keeps handing out this same vi.fn).
const mocks = vi.hoisted(() => ({ runConsentFlow: vi.fn() }));
vi.mock("../src/consent.js", () => ({ runConsentFlow: mocks.runConsentFlow }));

// auth.ts resolves its config paths from env at module load, so each test
// stubs MAILWARDEN_DIR and imports a fresh module instance.
async function freshAuth(dir: string) {
  vi.resetModules();
  vi.stubEnv("MAILWARDEN_DIR", dir);
  return await import("../src/auth.js");
}

describe("getAuth (non-interactive)", () => {
  let tmp: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("throws with a --auth hint when no token is stored", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(false)).rejects.toThrow(/--auth/);
  });

  it("loads a stored refresh token without any network call", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify({
        type: "authorized_user",
        client_id: "cid",
        client_secret: "cs",
        refresh_token: "rt-123",
      }),
    );
    const { getAuth } = await freshAuth(tmp);
    const client = await getAuth(false);
    expect(client).toBeTruthy();
    const refreshToken = client.credentials.refresh_token ?? (client as any)._refreshToken;
    expect(refreshToken).toBe("rt-123");
  });

  it("caches the client across calls (one refresh per process, not per call)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "cs", refresh_token: "rt-123" }),
    );
    const { getAuth } = await freshAuth(tmp);
    const first = await getAuth(false);
    // Deleting the token would make a fresh load throw — but the cache holds it.
    await fs.rm(path.join(tmp, "token.json"));
    const second = await getAuth(false);
    expect(second).toBe(first); // same instance, no re-read from disk
  });

  it("treats a corrupt token.json as not-authorized (throws instead of crashing)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(path.join(tmp, "token.json"), "{ not json");
    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(false)).rejects.toThrow(/--auth/);
  });
});

describe("getAuth (interactive) — consent flow + token persistence", () => {
  let tmp: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    mocks.runConsentFlow.mockReset();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("runs the consent flow and persists the refresh token", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "fresh-rt" });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored).toEqual({
      type: "authorized_user",
      client_id: "cid",
      client_secret: "cs",
      refresh_token: "fresh-rt",
    });
  });

  it("accepts a 'web' OAuth client shape too", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ web: { client_id: "wcid", client_secret: "wcs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.client_id).toBe("wcid");
  });

  it("throws (and persists nothing) when the flow yields no refresh token", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({});

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/no refresh token/);

    await expect(fs.access(path.join(tmp, "token.json"))).rejects.toThrow();
  });

  /** A previous grant's token sitting on disk, in the pre-`email` shape every existing install has. */
  async function withStaleToken(dir: string) {
    await fs.writeFile(
      path.join(dir, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    await fs.writeFile(
      path.join(dir, "token.json"),
      JSON.stringify({
        type: "authorized_user",
        client_id: "cid",
        client_secret: "cs",
        refresh_token: "stale-rt",
      }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "fresh-rt" });
  }

  it("runs the consent flow even when a token.json already exists (re-auth is not a no-op)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await withStaleToken(tmp);

    const { getAuth } = await freshAuth(tmp);
    // Whatever the overwrite guard decides afterwards, the browser flow must have RUN — the
    // property this test has always defended: a stale token must never make --auth a silent no-op
    // that leaves the dead token in place.
    await getAuth(true).catch(() => undefined);
    expect(mocks.runConsentFlow).toHaveBeenCalledOnce();
  });

  it("refuses to replace a token it cannot identify, and leaves it untouched", async () => {
    // No network here, so neither the stored token nor the fresh client can be resolved to an
    // address — the guard's fail-closed case. The old token must survive the refusal intact.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await withStaleToken(tmp);

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/Refusing to overwrite/);

    const kept = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(kept.refresh_token).toBe("stale-rt");
  });

  it("replaces it when the user says so explicitly (--force)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await withStaleToken(tmp);

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true, { force: true });

    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.refresh_token).toBe("fresh-rt");
  });

  it("writes the first token with no guard in the way", async () => {
    // Nothing to overwrite → the common first-run path must stay frictionless.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "first-rt" });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.refresh_token).toBe("first-rt");
  });

  it("preflights a missing credentials.json before opening the browser", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/No OAuth credentials found/);
    expect(mocks.runConsentFlow).not.toHaveBeenCalled(); // failed before the consent flow
  });

  it("reports an unreadable credentials.json (exists but can't be read) distinctly from missing", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    // A directory at the credentials.json path → readFile fails with EISDIR
    // (not ENOENT), portably exercising the non-missing read-error branch.
    await fs.mkdir(path.join(tmp, "credentials.json"));
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/exists but could not be read/);
    expect(mocks.runConsentFlow).not.toHaveBeenCalled();
  });

  it("preflights a credentials.json with no installed/web client", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(path.join(tmp, "credentials.json"), JSON.stringify({ foo: 1 }));
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/no "installed" or "web" OAuth client/);
    expect(mocks.runConsentFlow).not.toHaveBeenCalled();
  });
});

describe("token encryption (pure encrypt/decrypt)", () => {
  const secret = JSON.stringify({ type: "authorized_user", refresh_token: "rt-secret" });

  it("round-trips plaintext through encrypt → decrypt", () => {
    const enc = encryptToken(secret, "hunter2");
    expect(enc.type).toBe("mailwarden-encrypted");
    expect(enc.ciphertext).not.toContain("rt-secret"); // opaque on disk
    expect(decryptToken(enc, "hunter2")).toBe(secret);
  });

  it("produces a self-describing, versioned envelope", () => {
    const enc = encryptToken(secret, "hunter2");
    expect(enc).toMatchObject({ type: "mailwarden-encrypted", v: 1, kdf: "scrypt" });
    for (const f of ["salt", "iv", "tag", "ciphertext"] as const) {
      expect(typeof enc[f]).toBe("string");
      expect(enc[f].length).toBeGreaterThan(0);
    }
  });

  it("rejects a tampered auth tag", () => {
    const enc = encryptToken(secret, "hunter2");
    const tag = Buffer.from(enc.tag, "base64");
    tag[0] ^= 0xff;
    expect(() => decryptToken({ ...enc, tag: tag.toString("base64") }, "hunter2")).toThrow();
  });

  it("rejects a tampered salt (key no longer derives)", () => {
    const enc = encryptToken(secret, "hunter2");
    const salt = Buffer.from(enc.salt, "base64");
    salt[0] ^= 0xff;
    expect(() => decryptToken({ ...enc, salt: salt.toString("base64") }, "hunter2")).toThrow();
  });

  it("uses a fresh random salt + iv each time (no reuse across encryptions)", () => {
    const a = encryptToken(secret, "hunter2");
    const b = encryptToken(secret, "hunter2");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong passphrase", () => {
    const enc = encryptToken(secret, "right");
    expect(() => decryptToken(enc, "wrong")).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth-tag mismatch)", () => {
    const enc = encryptToken(secret, "hunter2");
    const ct = Buffer.from(enc.ciphertext, "base64");
    ct[0] ^= 0xff; // flip a byte
    const tampered = { ...enc, ciphertext: ct.toString("base64") };
    expect(() => decryptToken(tampered, "hunter2")).toThrow();
  });
});

describe("token encryption (persist + load through getAuth)", () => {
  let tmp: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    mocks.runConsentFlow.mockReset();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function authWithKey(dir: string, key: string) {
    vi.resetModules();
    vi.stubEnv("MAILWARDEN_DIR", dir);
    vi.stubEnv("MAILWARDEN_TOKEN_PASSPHRASE", key);
    return await import("../src/auth.js");
  }

  it("persists an encrypted token.json when MAILWARDEN_TOKEN_PASSPHRASE is set", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "fresh-rt" });

    const { getAuth } = await authWithKey(tmp, "pw");
    await getAuth(true);

    const raw = await fs.readFile(path.join(tmp, "token.json"), "utf8");
    const stored = JSON.parse(raw);
    expect(stored.type).toBe("mailwarden-encrypted");
    expect(raw).not.toContain("fresh-rt"); // secret not on disk in the clear
  });

  it("loads an encrypted token back with the right key (no network)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "fresh-rt" });
    // Store encrypted, then load in a fresh module instance (no in-process cache).
    const store = await authWithKey(tmp, "pw");
    await store.getAuth(true);

    const { getAuth } = await authWithKey(tmp, "pw");
    const client = await getAuth(false);
    const rt = client.credentials.refresh_token ?? (client as any)._refreshToken;
    expect(rt).toBe("fresh-rt");
  });

  it("throws an actionable error when the token is encrypted but no key is set", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify(encryptToken(JSON.stringify({ type: "authorized_user", refresh_token: "rt" }), "pw")),
    );
    const { getAuth } = await freshAuth(tmp); // MAILWARDEN_TOKEN_PASSPHRASE intentionally unset
    await expect(getAuth(false)).rejects.toThrow(/encrypted.*MAILWARDEN_TOKEN_PASSPHRASE is not set/s);
  });

  it("throws an actionable error when the key is wrong", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify(encryptToken(JSON.stringify({ type: "authorized_user", refresh_token: "rt" }), "right")),
    );
    const { getAuth } = await authWithKey(tmp, "wrong");
    await expect(getAuth(false)).rejects.toThrow(/Could not decrypt/);
  });

  it("still loads a plaintext token when a key is set, warning to re-encrypt", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "cs", refresh_token: "rt-plain" }),
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getAuth } = await authWithKey(tmp, "pw");
    const client = await getAuth(false);
    const rt = client.credentials.refresh_token ?? (client as any)._refreshToken;
    expect(rt).toBe("rt-plain"); // still usable — encryption is opt-in, not enforced on read
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stored in plaintext/));
    warn.mockRestore();
  });

  it("treats a valid-JSON token of the wrong shape as not-authorized", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(path.join(tmp, "token.json"), JSON.stringify({ foo: 1 }));
    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(false)).rejects.toThrow(/--auth/);
  });

  it("treats a correctly-decrypted but wrong-shape token as not-authorized (not 'wrong key')", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    // Key is correct → GCM verifies → but the payload isn't an authorized_user: must fall through to
    // the "not authorized" path, NOT be mislabeled as a decryption failure.
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify(encryptToken(JSON.stringify({ foo: 1 }), "pw")),
    );
    const { getAuth } = await authWithKey(tmp, "pw");
    await expect(getAuth(false)).rejects.toThrow(/--auth/);
  });

  it("treats a correctly-decrypted but non-JSON payload as not-authorized", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify(encryptToken("not json at all", "pw")),
    );
    const { getAuth } = await authWithKey(tmp, "pw");
    await expect(getAuth(false)).rejects.toThrow(/--auth/);
  });
});

describe("tier-derived scopes + recorded-scope gating", () => {
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
  const SETTINGS = "https://www.googleapis.com/auth/gmail.settings.basic";
  let tmp: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    mocks.runConsentFlow.mockReset();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function freshAuthWithTools(dir: string, tools?: string) {
    vi.resetModules();
    vi.stubEnv("MAILWARDEN_DIR", dir);
    if (tools !== undefined) vi.stubEnv("MAILWARDEN_TOOLS", tools);
    return await import("../src/auth.js");
  }

  it("requests modify+settings.basic by default and records the granted scopes", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    const granted = `${MODIFY} ${SETTINGS}`;
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt", scope: granted });

    const { getAuth } = await freshAuthWithTools(tmp); // no MAILWARDEN_TOOLS → all tiers
    await getAuth(true);

    expect(mocks.runConsentFlow).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: [MODIFY, SETTINGS] }),
    );
    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.scope).toBe(granted); // recorded so registration can gate without a network call
  });

  it("requests only gmail.readonly for a read-only tier selection", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });

    const { getAuth } = await freshAuthWithTools(tmp, "read");
    await getAuth(true);

    expect(mocks.runConsentFlow).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: [READONLY] }),
    );
  });

  it("hasFilterScope reflects the recorded token scopes (true / false / unknown)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    const writeToken = (scope?: string) =>
      fs.writeFile(
        path.join(tmp, "token.json"),
        JSON.stringify({
          type: "authorized_user",
          client_id: "c",
          client_secret: "s",
          refresh_token: "rt",
          ...(scope ? { scope } : {}),
        }),
      );

    await writeToken(`${MODIFY} ${SETTINGS}`);
    let mod = await freshAuthWithTools(tmp);
    expect(mod.hasFilterScope()).toBe(true);
    expect(mod.hasModifyScope()).toBe(true);

    await writeToken(MODIFY); // granted, but without settings.basic
    mod = await freshAuthWithTools(tmp);
    expect(mod.hasFilterScope()).toBe(false);
    expect(mod.hasModifyScope()).toBe(true);

    await writeToken(READONLY); // read-only grant → can't write/sweep
    mod = await freshAuthWithTools(tmp);
    expect(mod.hasModifyScope()).toBe(false);
    expect(mod.hasFilterScope()).toBe(false);

    await writeToken(); // older token, no scope field
    mod = await freshAuthWithTools(tmp);
    expect(mod.hasFilterScope()).toBeUndefined();
    expect(mod.hasModifyScope()).toBeUndefined();
  });

  it("hasFilterScope is undefined with no token or an encrypted one", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    expect((await freshAuthWithTools(tmp)).hasFilterScope()).toBeUndefined(); // no token.json yet

    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify(encryptToken(JSON.stringify({ type: "authorized_user", refresh_token: "rt", scope: SETTINGS }), "pw")),
    );
    expect((await freshAuthWithTools(tmp)).hasFilterScope()).toBeUndefined(); // encrypted → not read at registration
  });
});

describe("checkCredentials — --auth preflight (pure)", () => {
  const P = "/cfg/credentials.json";

  it("accepts a Desktop (installed) client", () => {
    const raw = JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } });
    expect(checkCredentials(raw, P)).toEqual({
      ok: true,
      kind: "installed",
      client_id: "cid",
      client_secret: "cs",
      redirect_uri: "http://localhost",
    });
  });

  it("accepts a web client", () => {
    const raw = JSON.stringify({ web: { client_id: "wcid", client_secret: "wcs", redirect_uris: ["http://localhost"] } });
    expect(checkCredentials(raw, P)).toMatchObject({ ok: true, kind: "web", client_id: "wcid" });
  });

  it("reports a missing file (raw === null) with a Desktop-app hint", () => {
    const r = checkCredentials(null, P);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/No OAuth credentials found at \/cfg/);
  });

  it("reports invalid JSON", () => {
    const r = checkCredentials("{ not json", P);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/not valid JSON/);
  });

  it("reports a file with neither installed nor web (e.g. an API key)", () => {
    const r = checkCredentials(JSON.stringify({ apiKey: "x" }), P);
    expect((r as { message: string }).message).toMatch(/no "installed" or "web" OAuth client/);
  });

  it("reports a client missing client_id / client_secret", () => {
    expect(
      (checkCredentials(JSON.stringify({ installed: { client_id: "cid" } }), P) as { message: string })
        .message,
    ).toMatch(/missing client_id or client_secret/);
    expect(
      (checkCredentials(JSON.stringify({ web: { client_secret: "cs", redirect_uris: ["http://localhost"] } }), P) as { message: string })
        .message,
    ).toMatch(/missing client_id or client_secret/);
  });
});

/**
 * The overwrite guard. Reported 15.08.2026 by the two mailbox sessions: a bare `npm run auth`
 * replaced the PRIVATE mailbox's token with a grant for the BUSINESS account, because the target
 * path follows `--account` alone and never the account picked in the consent screen. Proven from
 * both sides by Google's own grant mails, to the minute of the file write.
 *
 * The rules below are the fix. Two of them exist because the reviewing sessions took the first
 * sketch apart: "cannot identify the stored token" must count as a mismatch (otherwise the guard
 * is inert on exactly the first run after an update — every installation's decisive run), and a
 * token Google itself rejects may be replaced (it protects nothing) — but ONLY on invalid_grant,
 * never on a timeout that merely failed to ask.
 */
describe("tokenOverwriteVerdict — --auth must not replace another mailbox's token", () => {
  const base = {
    tokenFile: "/home/u/.mailwarden/token.json",
    exists: true,
    storedEmail: "private@gmail.com",
    newEmail: "private@gmail.com",
    force: false,
    account: null as string | null,
  };
  const refuse = (r: OverwriteCheck) => (r as { ok: false; message: string }).message;

  it("permits the first authorization — there is nothing to overwrite", () => {
    expect(tokenOverwriteVerdict({ ...base, exists: false, storedEmail: null })).toEqual({ ok: true });
  });

  it("permits a plain re-auth of the same mailbox", () => {
    expect(tokenOverwriteVerdict(base)).toEqual({ ok: true });
  });

  it("treats the address case- and whitespace-insensitively", () => {
    expect(
      tokenOverwriteVerdict({ ...base, storedEmail: " Private@Gmail.com ", newEmail: "private@gmail.com" }),
    ).toEqual({ ok: true });
  });

  it("refuses the reported accident, naming both mailboxes and the file", () => {
    const r = tokenOverwriteVerdict({ ...base, newEmail: "business@example.com" });
    expect(r.ok).toBe(false);
    expect(refuse(r)).toContain("private@gmail.com");
    expect(refuse(r)).toContain("business@example.com");
    expect(refuse(r)).toContain("/home/u/.mailwarden/token.json");
  });

  it("offers both ways forward: a second account, or an explicit replacement", () => {
    const r = tokenOverwriteVerdict({ ...base, newEmail: "business@example.com" });
    expect(refuse(r)).toContain("--auth --account <name>");
    expect(refuse(r)).toContain("--force");
  });

  it("says the browser grant already happened and how to revoke it", () => {
    // The abort prevents the WRITE, not the GRANT — by then Google has already sent its security
    // mail. Leaving that out would strand an unwanted authorization nobody knows to revoke.
    const r = tokenOverwriteVerdict({ ...base, newEmail: "business@example.com" });
    expect(refuse(r)).toMatch(/Nothing was written/);
    expect(refuse(r)).toContain("myaccount.google.com/permissions");
  });

  it("repeats the account in the --force hint, so the retry keeps aiming at the same file", () => {
    const r = tokenOverwriteVerdict({
      ...base,
      account: "work",
      tokenFile: "/home/u/.mailwarden/token.work.json",
      newEmail: "business@example.com",
    });
    expect(refuse(r)).toContain("--auth --account work --force");
  });

  it("refuses when the stored token cannot be identified — the blind spot of the first sketch", () => {
    // Every token written before this version records no account. That is the FIRST run after an
    // update, i.e. the very run the guard is for; "unknown" therefore must not mean "go ahead".
    const r = tokenOverwriteVerdict({ ...base, storedEmail: null });
    expect(r.ok).toBe(false);
    expect(refuse(r)).toMatch(/could not be identified/);
  });

  it("refuses when the freshly authorized account could not be confirmed", () => {
    const r = tokenOverwriteVerdict({ ...base, newEmail: null });
    expect(r.ok).toBe(false);
    expect(refuse(r)).toMatch(/could not be confirmed/);
  });

  it("permits replacing a token Google no longer accepts — it protects nobody", () => {
    const r = tokenOverwriteVerdict({ ...base, storedEmail: null, storedDead: true });
    expect(r.ok).toBe(true);
    expect((r as { note?: string }).note).toMatch(/invalid_grant/);
  });

  it("does NOT extend that to a token that merely could not be reached", () => {
    // A timeout fails to name the account just like a dead token does, but proves nothing about
    // it. Treating the two alike would let a flaky network cause the exact loss this prevents.
    expect(tokenOverwriteVerdict({ ...base, storedEmail: null, storedDead: false }).ok).toBe(false);
  });

  it("keeps refusing a known mismatch even if the old token is dead", () => {
    const r = tokenOverwriteVerdict({
      ...base,
      storedEmail: "private@gmail.com",
      storedDead: true,
      newEmail: "business@example.com",
    });
    expect(r.ok).toBe(false);
  });

  it("names the boring cause too when an identity is merely unknown", () => {
    // Round 4 finding: the guard also fires when the check could not RUN — a dropped connection, or
    // a project without the Gmail API enabled. Without a word about that, the message sends the
    // reader hunting for a multi-account mixup they never made.
    const r = tokenOverwriteVerdict({ ...base, storedEmail: null });
    expect(refuse(r)).toMatch(/could not run|not be identified/);
    expect(refuse(r)).toMatch(/network|Gmail API/);
  });

  it("does not offer that excuse when both accounts are known and simply differ", () => {
    const r = tokenOverwriteVerdict({ ...base, newEmail: "business@example.com" });
    expect(refuse(r)).not.toMatch(/network/);
  });

  it("obeys --force, and says what it replaced", () => {
    const r = tokenOverwriteVerdict({ ...base, newEmail: "business@example.com", force: true });
    expect(r.ok).toBe(true);
    expect((r as { note?: string }).note).toContain("business@example.com");
  });
});

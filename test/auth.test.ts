import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkCredentials } from "../src/auth.js";

// Stable mock instance that survives vi.resetModules() (the factory re-runs,
// but keeps handing out this same vi.fn).
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("@google-cloud/local-auth", () => ({ authenticate: mocks.authenticate }));

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
    mocks.authenticate.mockReset();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("runs the consent flow and persists the refresh token", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }),
    );
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "fresh-rt" } });

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
      JSON.stringify({ web: { client_id: "wcid", client_secret: "wcs" } }),
    );
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.client_id).toBe("wcid");
  });

  it("throws (and persists nothing) when the flow yields no refresh token", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }),
    );
    mocks.authenticate.mockResolvedValue({ credentials: {} });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/no refresh token/);

    await expect(fs.access(path.join(tmp, "token.json"))).rejects.toThrow();
  });

  it("runs the consent flow even when a stale token.json already exists (re-auth is not a no-op)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }),
    );
    // A dead token from a previous grant is sitting on disk.
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify({
        type: "authorized_user",
        client_id: "cid",
        client_secret: "cs",
        refresh_token: "stale-rt",
      }),
    );
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "fresh-rt" } });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    // The consent flow must have actually run and replaced the stale token.
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    const stored = JSON.parse(await fs.readFile(path.join(tmp, "token.json"), "utf8"));
    expect(stored.refresh_token).toBe("fresh-rt");
  });

  it("preflights a missing credentials.json before opening the browser", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/No OAuth credentials found/);
    expect(mocks.authenticate).not.toHaveBeenCalled(); // failed before the consent flow
  });

  it("reports an unreadable credentials.json (exists but can't be read) distinctly from missing", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    // A directory at the credentials.json path → readFile fails with EISDIR
    // (not ENOENT), portably exercising the non-missing read-error branch.
    await fs.mkdir(path.join(tmp, "credentials.json"));
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/exists but could not be read/);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("preflights a credentials.json with no installed/web client", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(path.join(tmp, "credentials.json"), JSON.stringify({ foo: 1 }));
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/no "installed" or "web" OAuth client/);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
});

describe("checkCredentials — --auth preflight (pure)", () => {
  const P = "/cfg/credentials.json";

  it("accepts a Desktop (installed) client", () => {
    const raw = JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } });
    expect(checkCredentials(raw, P)).toEqual({
      ok: true,
      kind: "installed",
      client_id: "cid",
      client_secret: "cs",
    });
  });

  it("accepts a web client", () => {
    const raw = JSON.stringify({ web: { client_id: "wcid", client_secret: "wcs" } });
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
      (checkCredentials(JSON.stringify({ web: { client_secret: "cs" } }), P) as { message: string })
        .message,
    ).toMatch(/missing client_id or client_secret/);
  });
});

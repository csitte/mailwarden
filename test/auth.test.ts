import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  it("does not persist anything when the flow yields no refresh token", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    mocks.authenticate.mockResolvedValue({ credentials: {} });

    const { getAuth } = await freshAuth(tmp);
    await getAuth(true);

    await expect(fs.access(path.join(tmp, "token.json"))).rejects.toThrow();
  });

  it("fails clearly when credentials.json is missing", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/Cannot read OAuth credentials/);
  });

  it("fails clearly when credentials.json has no installed/web client", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-auth-"));
    await fs.writeFile(path.join(tmp, "credentials.json"), JSON.stringify({ foo: 1 }));
    mocks.authenticate.mockResolvedValue({ credentials: { refresh_token: "rt" } });

    const { getAuth } = await freshAuth(tmp);
    await expect(getAuth(true)).rejects.toThrow(/Unexpected format/);
  });
});

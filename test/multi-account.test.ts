import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// auth.ts resolves CONFIG_DIR from env at module load; account is read from
// MAILWARDEN_ACCOUNT at call time. Each test imports a fresh module with its own
// temp dir, and stubs MAILWARDEN_ACCOUNT as needed.
async function freshAuth(dir: string, account?: string) {
  vi.resetModules();
  vi.stubEnv("MAILWARDEN_DIR", dir);
  // Always set it explicitly so a prior stub can't leak into a later default-account import;
  // "" trims to empty → activeAccount() returns null (the default account).
  vi.stubEnv("MAILWARDEN_ACCOUNT", account ?? "");
  return await import("../src/auth.js");
}

describe("multi-account", () => {
  let tmp: string;
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("sanitizeAccount accepts safe names and rejects unsafe ones", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    const { sanitizeAccount } = await freshAuth(tmp);
    expect(sanitizeAccount("work")).toBe("work");
    expect(sanitizeAccount(" work ")).toBe("work"); // trimmed
    expect(sanitizeAccount("a.b-c_1")).toBe("a.b-c_1");
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", ".hidden", "-lead"]) {
      expect(() => sanitizeAccount(bad)).toThrow(/Invalid account name/);
    }
  });

  it("lower-cases account names so two casings can't share one token file", async () => {
    // On Windows/macOS token.Work.json and token.work.json are the SAME file — without
    // normalization the second --auth would silently overwrite the first account's token.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    const { sanitizeAccount, tokenPath } = await freshAuth(tmp);
    expect(sanitizeAccount("Work")).toBe("work");
    expect(sanitizeAccount("WORK")).toBe("work");
    expect(tokenPath(sanitizeAccount("Work"))).toBe(tokenPath(sanitizeAccount("work")));

    const upper = await freshAuth(tmp, "Work");
    expect(upper.activeAccount()).toBe("work"); // env value normalized too
  });

  it("activeAccount is null by default and the sanitized value when set", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    const def = await freshAuth(tmp);
    expect(def.activeAccount()).toBeNull();

    const withAcct = await freshAuth(tmp, "work");
    expect(withAcct.activeAccount()).toBe("work");

    const bad = await freshAuth(tmp, "../evil");
    expect(() => bad.activeAccount()).toThrow(/Invalid account name/);
  });

  it("tokenPath maps the default account to token.json and a named one to token.<name>.json", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    const { tokenPath } = await freshAuth(tmp);
    expect(tokenPath(null)).toBe(path.join(tmp, "token.json"));
    expect(tokenPath("work")).toBe(path.join(tmp, "token.work.json"));
  });

  it("getAuth loads the account-specific token when MAILWARDEN_ACCOUNT is set", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    // Two accounts, distinct refresh tokens.
    await fs.writeFile(
      path.join(tmp, "token.json"),
      JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "rt-default" }),
    );
    await fs.writeFile(
      path.join(tmp, "token.work.json"),
      JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "rt-work" }),
    );

    const workAuth = await freshAuth(tmp, "work");
    const workClient = await workAuth.getAuth(false);
    const workRt = workClient.credentials.refresh_token ?? (workClient as any)._refreshToken;
    expect(workRt).toBe("rt-work");

    const defAuth = await freshAuth(tmp); // no MAILWARDEN_ACCOUNT → default token.json
    const defClient = await defAuth.getAuth(false);
    const defRt = defClient.credentials.refresh_token ?? (defClient as any)._refreshToken;
    expect(defRt).toBe("rt-default");
  });

  it("discoverAccounts lists token.<name>.json files and excludes the default token.json", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-acct-"));
    await fs.writeFile(path.join(tmp, "token.json"), "{}");
    await fs.writeFile(path.join(tmp, "token.work.json"), "{}");
    await fs.writeFile(path.join(tmp, "token.personal.json"), "{}");
    await fs.writeFile(path.join(tmp, "credentials.json"), "{}"); // not a token
    const { discoverAccounts } = await freshAuth(tmp);
    expect(discoverAccounts()).toEqual(["personal", "work"]);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chooseProtection,
  isKeystoreEnvelope,
  keyEntryName,
  newKey,
  openWithKey,
  parseKeystoreSetting,
  sealWithKey,
} from "../src/keystore.js";
import { encryptToken } from "../src/auth.js";
import { resetFakeKeyStore, type FakeKeyStore } from "./fake-keystore.js";

const mocks = vi.hoisted(() => ({ runConsentFlow: vi.fn() }));
vi.mock("../src/consent.js", () => ({ runConsentFlow: mocks.runConsentFlow }));

const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const SETTINGS = "https://www.googleapis.com/auth/gmail.settings.basic";
const payload = JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "rt-secret" });

describe("keystore envelope (pure)", () => {
  it("round-trips and keeps neither the secret nor the key on disk", () => {
    const { keyId, key } = newKey();
    const env = sealWithKey(payload, key, keyId, MODIFY);
    const json = JSON.stringify(env);
    expect(json).not.toContain("rt-secret");
    expect(json).not.toContain(key.toString("base64"));
    expect(json).not.toContain(key.toString("hex"));
    expect(env).toMatchObject({ type: "mailwarden-encrypted", v: 2, kdf: "keystore", keyId, scope: MODIFY });
    expect(openWithKey(env, key)).toBe(payload);
  });

  it("uses a fresh nonce every time", () => {
    const { keyId, key } = newKey();
    expect(sealWithKey(payload, key, keyId).iv).not.toBe(sealWithKey(payload, key, keyId).iv);
  });

  it("rejects a wrong key", () => {
    const a = newKey();
    const env = sealWithKey(payload, a.key, a.keyId);
    expect(() => openWithKey(env, newKey().key)).toThrow();
  });

  // The scope is in the clear so registration can read it; binding it as additional data is what
  // keeps an edit from going unnoticed.
  it.each([
    ["an edited scope", (e: ReturnType<typeof sealWithKey>) => ({ ...e, scope: `${MODIFY} ${SETTINGS}` })],
    ["an added scope", (e: ReturnType<typeof sealWithKey>) => ({ ...e, scope: SETTINGS })],
    ["a removed scope", (e: ReturnType<typeof sealWithKey>) => ({ ...e, scope: undefined })],
    ["an edited key id", (e: ReturnType<typeof sealWithKey>) => ({ ...e, keyId: newKey().keyId })],
    [
      "a flipped ciphertext byte",
      (e: ReturnType<typeof sealWithKey>) => {
        const ct = Buffer.from(e.ciphertext, "base64");
        ct[0] ^= 0xff;
        return { ...e, ciphertext: ct.toString("base64") };
      },
    ],
  ])("rejects %s", (_name, edit) => {
    const { keyId, key } = newKey();
    const env = sealWithKey(payload, key, keyId, MODIFY);
    expect(() => openWithKey(edit(env) as typeof env, key)).toThrow();
  });

  it("tells the two envelopes and plaintext apart", () => {
    const { keyId, key } = newKey();
    expect(isKeystoreEnvelope(sealWithKey(payload, key, keyId))).toBe(true);
    expect(isKeystoreEnvelope(encryptToken(payload, "pw"))).toBe(false);
    expect(isKeystoreEnvelope(JSON.parse(payload))).toBe(false);
    expect(isKeystoreEnvelope(null)).toBe(false);
    expect(isKeystoreEnvelope({ type: "mailwarden-encrypted", v: 2, kdf: "keystore" })).toBe(false); // no keyId
  });

  it("names entries only for well-formed key ids", () => {
    const { keyId } = newKey();
    expect(keyEntryName(keyId)).toBe(`token-key-${keyId}`);
    for (const bad of ["", "abc", "../../other-app", "A".repeat(24), `${keyId}0`, "g".repeat(24)]) {
      expect(() => keyEntryName(bad)).toThrow(/Malformed key id/);
    }
  });
});

describe("MAILWARDEN_KEYSTORE + chooseProtection (pure)", () => {
  it.each([
    [undefined, "auto"],
    ["", "auto"],
    ["auto", "auto"],
    [" On ", "auto"],
    ["off", "off"],
    ["OFF", "off"],
    ["0", "off"],
    ["false", "off"],
    ["no", "off"],
  ])("parses %j as %s", (raw, want) => {
    expect(parseKeystoreSetting(raw)).toBe(want);
  });

  it("rejects anything else rather than guessing", () => {
    expect(() => parseKeystoreSetting("always")).toThrow(/MAILWARDEN_KEYSTORE/);
  });

  const ok = { ok: true as const };
  const none = { ok: false as const, reason: "no Secret Service" };
  it.each([
    [{ passphraseSet: true, setting: "auto", store: ok }, { kind: "passphrase" }],
    [{ passphraseSet: true, setting: "off", store: ok }, { kind: "passphrase" }],
    [{ passphraseSet: false, setting: "auto", store: ok }, { kind: "keystore" }],
    [{ passphraseSet: false, setting: "off", store: ok }, { kind: "plaintext", why: "off" }],
    [{ passphraseSet: false, setting: "auto", store: none }, { kind: "plaintext", why: "unavailable", detail: "no Secret Service" }],
  ] as const)("%j → %j", (input, want) => {
    expect(chooseProtection(input)).toEqual(want);
  });
});

describe("keystore through getAuth", () => {
  let tmp: string;
  let ks: FakeKeyStore;

  beforeEach(async () => {
    ks = resetFakeKeyStore();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-ks-"));
    await fs.writeFile(
      path.join(tmp, "credentials.json"),
      JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", redirect_uris: ["http://localhost"] } }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    mocks.runConsentFlow.mockReset();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function fresh(env: Record<string, string> = {}) {
    vi.resetModules();
    vi.stubEnv("MAILWARDEN_DIR", tmp);
    vi.stubEnv("MAILWARDEN_KEYSTORE", "auto");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return await import("../src/auth.js");
  }
  const tokenFile = () => path.join(tmp, "token.json");
  const readToken = async () => JSON.parse(await fs.readFile(tokenFile(), "utf8"));
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("encrypts a new token with a keystore key by default and loads it back", async () => {
    const log = quiet();
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "fresh-rt", scope: `${MODIFY} ${SETTINGS}` });
    await (await fresh()).getAuth(true);

    const raw = await fs.readFile(tokenFile(), "utf8");
    expect(raw).not.toContain("fresh-rt");
    const stored = JSON.parse(raw);
    expect(stored).toMatchObject({ v: 2, kdf: "keystore", scope: `${MODIFY} ${SETTINGS}` });
    expect([...ks.entries.keys()]).toEqual([stored.keyId]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/key in the OS keystore/));

    const client = await (await fresh()).getAuth(false);
    expect(client.credentials.refresh_token ?? (client as any)._refreshToken).toBe("fresh-rt");
  });

  // Encrypting by default must not cost registration its scope gating: the sync read sees the
  // clear scope without touching the keystore.
  it("keeps the synchronous scope read working, without opening the keystore", async () => {
    quiet();
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt", scope: MODIFY });
    await (await fresh()).getAuth(true);
    ks.calls.length = 0;

    const auth = await fresh();
    expect(auth.persistedScopes()).toEqual([MODIFY]);
    expect(auth.hasFilterScope()).toBe(false);
    expect(await auth.readGrantedScopes()).toEqual({ known: true, scopes: [MODIFY] });
    expect(ks.calls).toEqual([]);
  });

  it("removes the previous key when a re-auth replaces the token", async () => {
    quiet();
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt-1" });
    await (await fresh()).getAuth(true);
    const first = (await readToken()).keyId;

    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt-2" });
    await (await fresh()).getAuth(true, { force: true });
    const second = (await readToken()).keyId;

    expect(second).not.toBe(first);
    expect([...ks.entries.keys()]).toEqual([second]);
  });

  it("uses the passphrase when one is set, and never opens the keystore", async () => {
    quiet();
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });
    await (await fresh({ MAILWARDEN_TOKEN_PASSPHRASE: "pw" })).getAuth(true);
    expect(await readToken()).toMatchObject({ v: 1, kdf: "scrypt" });
    expect(ks.calls).toEqual([]);
  });

  it("stores plaintext and never opens the keystore with MAILWARDEN_KEYSTORE=off", async () => {
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });
    await (await fresh({ MAILWARDEN_KEYSTORE: "off" })).getAuth(true);
    expect(await readToken()).toMatchObject({ type: "authorized_user", refresh_token: "rt" });
    expect(ks.calls).toEqual([]);
  });

  it.each([
    ["no keystore is reachable", "unavailable", /plaintext — no OS keystore reachable/],
    ["the keystore refuses the write", "set-fails", /could not store a key in the OS keystore \(access denied/],
  ] as const)("falls back to plaintext and says so when %s", async (_n, mode, said) => {
    const log = quiet();
    ks.mode = mode;
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });
    await (await fresh()).getAuth(true);
    expect(await readToken()).toMatchObject({ type: "authorized_user", refresh_token: "rt" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(said));
    expect(ks.entries.size).toBe(0);
  });

  it("rejects a malformed MAILWARDEN_KEYSTORE before writing anything", async () => {
    mocks.runConsentFlow.mockResolvedValue({ refresh_token: "rt" });
    await expect((await fresh({ MAILWARDEN_KEYSTORE: "maybe" })).getAuth(true)).rejects.toThrow(/MAILWARDEN_KEYSTORE/);
    await expect(fs.access(tokenFile())).rejects.toThrow();
  });

  describe("loading a keystore token that cannot be opened", () => {
    async function writeSealed(opts: { storeKey?: boolean; scope?: string } = {}) {
      const { keyId, key } = newKey();
      if (opts.storeKey !== false) ks.entries.set(keyId, key);
      await fs.writeFile(tokenFile(), JSON.stringify(sealWithKey(payload, key, keyId, opts.scope)));
      return { keyId, key };
    }

    it("names a missing key and the entry it looked for", async () => {
      const { keyId } = await writeSealed({ storeKey: false });
      await expect((await fresh()).getAuth(false)).rejects.toThrow(
        new RegExp(`not in this machine's OS keystore \\(mailwarden / token-key-${keyId}\\).*copied from another machine`, "s"),
      );
    });

    it("says there is no keystore, rather than 'not authorized'", async () => {
      await writeSealed();
      ks.mode = "unavailable";
      await expect((await fresh()).getAuth(false)).rejects.toThrow(/encrypted with a key in the OS keystore, but no OS keystore reachable/);
    });

    it("tells a locked keystore apart from a missing key", async () => {
      await writeSealed();
      ks.mode = "get-fails";
      await expect((await fresh()).getAuth(false)).rejects.toThrow(/Could not read the key .* \(keystore locked \(fake\)\).*unlock/s);
    });

    it("reports an edited scope as a damaged file", async () => {
      await writeSealed({ scope: MODIFY });
      const env = await readToken();
      await fs.writeFile(tokenFile(), JSON.stringify({ ...env, scope: `${MODIFY} ${SETTINGS}` }));
      await expect((await fresh()).getAuth(false)).rejects.toThrow(/corrupted or was edited/);
    });

    it("loads even when MAILWARDEN_KEYSTORE=off — the setting governs writing only", async () => {
      await writeSealed();
      const client = await (await fresh({ MAILWARDEN_KEYSTORE: "off" })).getAuth(false);
      expect(client.credentials.refresh_token ?? (client as any)._refreshToken).toBe("rt-secret");
    });

    it("refuses a key id that is not ours to look up", async () => {
      const { key, keyId } = newKey();
      const env = { ...sealWithKey(payload, key, keyId), keyId: "../../other-app" };
      await fs.writeFile(tokenFile(), JSON.stringify(env));
      await expect((await fresh()).getAuth(false)).rejects.toThrow(/Malformed key id/);
      expect(ks.calls.filter((c) => c.startsWith("get:"))).toEqual([]);
    });
  });

  it("reports the file and key state for --check", async () => {
    const { keyId, key } = newKey();
    await fs.writeFile(tokenFile(), JSON.stringify(sealWithKey(payload, key, keyId)));
    const auth = await fresh();
    expect(auth.tokenFileState()).toEqual({ state: "keystore", keyId });
    expect(await auth.keystoreKeyState(keyId)).toEqual({ state: "missing" });
    ks.entries.set(keyId, key);
    expect(await auth.keystoreKeyState(keyId)).toEqual({ state: "present" });
    ks.mode = "unavailable";
    expect(await auth.keystoreKeyState(keyId)).toMatchObject({ state: "unavailable" });
  });
});

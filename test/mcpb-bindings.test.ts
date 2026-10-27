import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
// @ts-expect-error — repo-only build helper, plain .mjs with no type declarations
import { bindingPackages, uncoveredTargets, parseIntegrity } from "../scripts/lib/mcpb-bindings.mjs";

/**
 * The MCPB bundle is one file for every platform its manifest declares, and `npm ci` installs the
 * keystore binding for the build machine only. These are the rules for which platform packages the
 * build adds, tested against the real lockfile and manifest as well as hand-made ones — the real pair
 * is what decides whether a bundle built on Windows still encrypts the token on a Mac.
 */

const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"));

const entry = (os: string, cpu: string, extra: Record<string, unknown> = {}) => ({
  version: "2.1.1",
  resolved: `https://registry.npmjs.org/x-${os}-${cpu}.tgz`,
  integrity: "sha512-AAAA",
  os: [os],
  cpu: [cpu],
  optional: true,
  ...extra,
});
const lock = (bindings: Record<string, unknown>) => ({
  packages: {
    "node_modules/@napi-rs/keyring": { version: "2.1.1" },
    ...Object.fromEntries(Object.entries(bindings).map(([k, v]) => [`node_modules/@napi-rs/keyring-${k}`, v])),
  },
});

describe("bindingPackages against the real lockfile and manifest", () => {
  const platforms: string[] = manifest.compatibility.platforms;
  const selected = bindingPackages(lockfile, platforms);
  const names = selected.map((p: { name: string }) => p.name);

  it("covers every declared platform on x64 and arm64", () => {
    expect(uncoveredTargets(selected, platforms)).toEqual([]);
  });

  it("carries the desktop targets and both Linux libcs", () => {
    for (const n of [
      "darwin-arm64",
      "darwin-x64",
      "win32-x64-msvc",
      "win32-arm64-msvc",
      "linux-x64-gnu",
      "linux-x64-musl",
      "linux-arm64-gnu",
      "linux-arm64-musl",
    ]) {
      expect(names).toContain(`@napi-rs/keyring-${n}`);
    }
  });

  it("leaves out what no declared platform or bundled CPU can load", () => {
    for (const n of ["freebsd-x64", "win32-ia32-msvc", "linux-arm-gnueabihf", "linux-riscv64-gnu"]) {
      expect(names).not.toContain(`@napi-rs/keyring-${n}`);
    }
  });

  it("pins every package to the parent's version with a fetchable, hashed source", () => {
    const parent = lockfile.packages["node_modules/@napi-rs/keyring"].version;
    for (const p of selected) {
      expect(p.version).toBe(parent);
      expect(p.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(() => parseIntegrity(p.integrity)).not.toThrow();
    }
  });
});

describe("bindingPackages rules", () => {
  it("selects by os and cpu, sorted by name", () => {
    const got = bindingPackages(
      lock({ "win32-x64-msvc": entry("win32", "x64"), "darwin-arm64": entry("darwin", "arm64") }),
      ["darwin", "win32"],
    );
    expect(got.map((p: { name: string }) => p.name)).toEqual([
      "@napi-rs/keyring-darwin-arm64",
      "@napi-rs/keyring-win32-x64-msvc",
    ]);
  });

  it("skips a platform the manifest does not declare", () => {
    const got = bindingPackages(lock({ "linux-x64-gnu": entry("linux", "x64") }), ["darwin", "win32"]);
    expect(got).toEqual([]);
  });

  it("refuses an entry without an integrity hash instead of skipping it", () => {
    const l = lock({ "darwin-arm64": entry("darwin", "arm64", { integrity: undefined }) });
    expect(() => bindingPackages(l, ["darwin"])).toThrow(/integrity/);
  });

  it("refuses a platform package whose version differs from the binding's", () => {
    const l = lock({ "darwin-arm64": entry("darwin", "arm64", { version: "2.1.0" }) });
    expect(() => bindingPackages(l, ["darwin"])).toThrow(/2\.1\.0/);
  });

  it("refuses a lockfile without the binding itself", () => {
    expect(() => bindingPackages({ packages: {} }, ["darwin"])).toThrow(/@napi-rs\/keyring/);
  });
});

describe("uncoveredTargets", () => {
  it("names each declared platform and CPU with no package", () => {
    const got = uncoveredTargets(
      [{ os: ["win32"], cpu: ["x64"] }],
      ["darwin", "win32"],
    );
    expect(got).toEqual(["darwin-x64", "darwin-arm64", "win32-arm64"]);
  });

  it("counts Linux as covered with either libc", () => {
    const got = uncoveredTargets(
      [
        { os: ["linux"], cpu: ["x64"] },
        { os: ["linux"], cpu: ["arm64"] },
      ],
      ["linux"],
    );
    expect(got).toEqual([]);
  });
});

describe("parseIntegrity", () => {
  it("splits an SRI string", () => {
    expect(parseIntegrity("sha512-abc+/=")).toEqual({ algorithm: "sha512", digest: "abc+/=" });
  });

  it("rejects what it cannot verify", () => {
    expect(() => parseIntegrity("sha1-abc")).toThrow();
    expect(() => parseIntegrity(undefined)).toThrow();
  });
});

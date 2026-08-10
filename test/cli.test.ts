import { describe, it, expect } from "vitest";
import { findStrayPositional, readAccountArg, resolveMode } from "../src/cli.js";

// This layer decides which token file an OAuth consent lands in. Three of the defects found
// reviewing the multi-account work lived here, so each fixed behavior gets a test.

describe("readAccountArg", () => {
  it("reads both `--account x` and `--account=x`", () => {
    expect(readAccountArg(["--auth", "--account", "work"])).toBe("work");
    expect(readAccountArg(["--auth", "--account=work"])).toBe("work");
  });

  it("is undefined when the flag is absent", () => {
    expect(readAccountArg([])).toBeUndefined();
    expect(readAccountArg(["--auth", "--http"])).toBeUndefined();
  });

  it("throws on a value-less --account instead of silently using the default account", () => {
    // Treating these as "absent" would let --auth overwrite the DEFAULT token.json.
    expect(() => readAccountArg(["--auth", "--account"])).toThrow(/needs a value/);
    expect(() => readAccountArg(["--account", "--http"])).toThrow(/needs a value/);
  });

  it("returns the value RAW, without validating it", () => {
    // A malformed name must survive to --check, whose job is to report it; validation is
    // sanitizeAccount's, applied by the modes that should fail fast.
    expect(readAccountArg(["--check", "--account", "my work"])).toBe("my work");
    expect(readAccountArg(["--check", "--account", "Work"])).toBe("Work");
    expect(readAccountArg(["--check", "--account="])).toBe("");
  });
});

describe("resolveMode", () => {
  it("maps each flag to its mode", () => {
    expect(resolveMode(["--check"])).toBe("check");
    expect(resolveMode(["--doctor"])).toBe("check");
    expect(resolveMode(["--auth"])).toBe("auth");
    expect(resolveMode(["--sweep"])).toBe("sweep");
    expect(resolveMode(["--http"])).toBe("http");
    expect(resolveMode([])).toBe("serve");
  });

  it("gives --check precedence, so a broken setup can always be diagnosed", () => {
    // The doctor tolerates a malformed account/tier; other modes fail fast on it. If another
    // mode won this race, `--check` could not report the misconfiguration it exists to explain.
    expect(resolveMode(["--auth", "--check"])).toBe("check");
    expect(resolveMode(["--http", "--doctor"])).toBe("check");
    expect(resolveMode(["--sweep", "--check"])).toBe("check");
  });

  it("ignores an --account value that happens to look like a flag name", () => {
    expect(resolveMode(["--account", "http"])).toBe("serve");
  });
});

describe("findStrayPositional", () => {
  it("flags a bare positional (a forgotten --account)", () => {
    // `mailwarden --auth work` must not silently authorize (and overwrite) the DEFAULT account.
    expect(findStrayPositional(["--auth", "work"])).toBe("work");
    expect(findStrayPositional(["work", "--auth"])).toBe("work");
  });

  it("does not flag the value of --account", () => {
    expect(findStrayPositional(["--auth", "--account", "work"])).toBeUndefined();
    expect(findStrayPositional(["--auth", "--account=work"])).toBeUndefined();
  });

  it("does not flag flag-only argv", () => {
    expect(findStrayPositional(["--auth"])).toBeUndefined();
    expect(findStrayPositional(["--check", "--doctor"])).toBeUndefined();
    expect(findStrayPositional([])).toBeUndefined();
  });
});

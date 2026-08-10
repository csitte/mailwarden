import { describe, it, expect } from "vitest";
import { debugEnabled, findStrayPositional, readAccountArg, resolveMode } from "../src/cli.js";

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

  it("throws on an EMPTY value too — the unset-variable case", () => {
    // `--account "$ACCT"` with ACCT unset yields "", which is neither undefined nor a flag.
    // Reading it as "absent" would resolve to the default account and clobber its token.
    expect(() => readAccountArg(["--auth", "--account", ""])).toThrow(/needs a value/);
    expect(() => readAccountArg(["--auth", "--account", "   "])).toThrow(/needs a value/);
    expect(() => readAccountArg(["--auth", "--account="])).toThrow(/needs a value/);
  });

  it("returns a non-empty value RAW, without validating the name", () => {
    // A malformed name must survive to --check, whose job is to report it; name validation is
    // sanitizeAccount's, applied by the modes that should fail fast.
    expect(readAccountArg(["--check", "--account", "my work"])).toBe("my work");
    expect(readAccountArg(["--check", "--account", "Work"])).toBe("Work");
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

describe("debugEnabled", () => {
  it("is off when unset or explicitly disabled", () => {
    // MAILWARDEN_DEBUG=0 previously enabled debug output — a truthy string doing the opposite
    // of what the user asked.
    for (const v of [undefined, "", "0", "false", "no", "  "]) {
      expect(debugEnabled(v === undefined ? {} : { MAILWARDEN_DEBUG: v })).toBe(false);
    }
  });

  it("is on for the usual affirmatives", () => {
    for (const v of ["1", "true", "yes", "TRUE", "on"]) {
      expect(debugEnabled({ MAILWARDEN_DEBUG: v })).toBe(true);
    }
  });
});

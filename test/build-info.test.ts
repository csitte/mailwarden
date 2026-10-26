import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describeBuild, loadBuildRecord } from "../src/buildinfo.js";
// @ts-expect-error — plain .mjs helper without type declarations
import { resolveBuildIdentity, changedPaths, readGitState, BUILD_INPUTS } from "../scripts/lib/build-info.mjs";

const base = { version: "0.24.0", sha: "a5ff4a7", tagsAtHead: [] as string[], changedInputs: [] as string[] };

describe("resolveBuildIdentity — is this build the release?", () => {
  it("HEAD at v<version> with a clean tree is the release", () => {
    expect(resolveBuildIdentity({ ...base, tagsAtHead: ["v0.24.0"] })).toEqual({
      commit: "a5ff4a7",
      dirty: false,
      release: true,
    });
  });

  it("a commit past the tag is not the release — the case two sessions hit on 2026-10-26", () => {
    expect(resolveBuildIdentity(base)).toEqual({ commit: "a5ff4a7", dirty: false, release: false });
  });

  it("another tag at HEAD does not count — only v<version>", () => {
    expect(resolveBuildIdentity({ ...base, tagsAtHead: ["v0.23.0", "latest"] }).release).toBe(false);
  });

  it("the tag with uncommitted build inputs is NOT the release", () => {
    const r = resolveBuildIdentity({ ...base, tagsAtHead: ["v0.24.0"], changedInputs: ["src/gmail.ts"] });
    expect(r).toEqual({ commit: "a5ff4a7", dirty: true, release: false });
  });

  it("GitHub's tag ref is accepted when the checkout carries no tag refs", () => {
    expect(resolveBuildIdentity({ ...base, refType: "tag", refName: "v0.24.0" }).release).toBe(true);
    expect(resolveBuildIdentity({ ...base, refType: "branch", refName: "v0.24.0" }).release).toBe(false);
    expect(resolveBuildIdentity({ ...base, refType: "tag", refName: "v0.23.0" }).release).toBe(false);
  });

  it("no git (no sha) is never a release, even with a matching CI ref", () => {
    expect(resolveBuildIdentity({ ...base, sha: "", refType: "tag", refName: "v0.24.0" })).toEqual({
      commit: null,
      dirty: false,
      release: false,
    });
  });

  it("watches the inputs tsc and npm actually read — including untracked sources", () => {
    // 2026-09-03: an untracked src file was compiled into dist/. A tracked-only check misses it.
    expect(BUILD_INPUTS).toEqual(["src", "package.json", "package-lock.json", "tsconfig.json"]);
  });
});

describe("changedPaths — parsing git status --porcelain", () => {
  it("reads modified, added, untracked and renamed entries", () => {
    const out = [" M src/gmail.ts", "A  src/new.ts", "?? src/scratch.ts", "R  src/old.ts -> src/renamed.ts", ""].join("\n");
    expect(changedPaths(out)).toEqual(["src/gmail.ts", "src/new.ts", "src/scratch.ts", "src/renamed.ts"]);
  });

  it("handles CRLF output and an empty status", () => {
    expect(changedPaths(" M package.json\r\n")).toEqual(["package.json"]);
    expect(changedPaths("")).toEqual([]);
  });
});

describe("readGitState — against a real repository", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  it("sees tag, modified, untracked and ignored-path changes the way a build would", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-git-"));
    try {
      sh(dir, "init", "-q");
      sh(dir, "config", "user.email", "t@example.com");
      sh(dir, "config", "user.name", "t");
      sh(dir, "config", "commit.gpgsign", "false");
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "package.json"), "{}\n");
      writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
      writeFileSync(path.join(dir, "README.md"), "x\n");
      sh(dir, "add", ".");
      sh(dir, "commit", "-q", "-m", "init");
      sh(dir, "tag", "v1.0.0");

      let s = readGitState(dir);
      expect(s.sha).toMatch(/^[0-9a-f]{7}$/);
      expect(s.tagsAtHead).toEqual(["v1.0.0"]);
      expect(s.changedInputs).toEqual([]);
      expect(resolveBuildIdentity({ version: "1.0.0", ...s }).release).toBe(true);

      // A docs change is not a build input.
      writeFileSync(path.join(dir, "README.md"), "y\n");
      expect(readGitState(dir).changedInputs).toEqual([]);

      // A modified tracked input — the FIRST porcelain line starts with a space, which a
      // whole-output trim() once ate together with the path's first letter ("ackage.json").
      writeFileSync(path.join(dir, "package.json"), '{"x":1}\n');
      // An untracked source file: tsc compiles it, so the build is dirty.
      writeFileSync(path.join(dir, "src", "scratch.ts"), "export {};\n");
      s = readGitState(dir);
      expect(s.changedInputs.sort()).toEqual(["package.json", "src/scratch.ts"]);
      expect(resolveBuildIdentity({ version: "1.0.0", ...s })).toMatchObject({ dirty: true, release: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outside a repository there is no commit, and it does not throw", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-nogit-"));
    try {
      const s = readGitState(dir);
      expect(s.sha).toBe("");
      expect(resolveBuildIdentity({ version: "1.0.0", ...s })).toEqual({ commit: null, dirty: false, release: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeBuild — what get_profile reports", () => {
  const rec = { version: "0.24.0", commit: "a5ff4a7", dirty: false, release: false, builtAt: "2026-10-26T08:00:00.000Z" };

  it("a release build carries the bare version", () => {
    const r = describeBuild("0.24.0", { ...rec, release: true });
    expect(r.serverVersion).toBe("0.24.0");
    expect(r.build).toEqual({ commit: "a5ff4a7", dirty: false, release: true, builtAt: rec.builtAt });
  });

  it("a build between releases names its commit", () => {
    expect(describeBuild("0.24.0", rec).serverVersion).toBe("0.24.0+a5ff4a7");
  });

  it("a build from uncommitted sources says so", () => {
    const r = describeBuild("0.24.0", { ...rec, dirty: true });
    expect(r.serverVersion).toBe("0.24.0+a5ff4a7.dirty");
    expect(r.build?.dirty).toBe(true);
  });

  it("a record claiming release AND dirty is believed only in its weaker claim", () => {
    const r = describeBuild("0.24.0", { ...rec, release: true, dirty: true });
    expect(r.serverVersion).toBe("0.24.0+a5ff4a7.dirty");
    expect(r.build?.release).toBe(false);
  });

  it("no record, or an unusable one, is '+unknown' — never the bare version", () => {
    for (const raw of [
      null,
      undefined,
      "0.24.0",
      {},
      { ...rec, version: "0.23.0" }, // stale record from an older build next to newer code
      { ...rec, commit: null }, // built without git
      { ...rec, commit: "../../etc" },
      { ...rec, dirty: "no" },
      { ...rec, builtAt: 0 },
    ]) {
      const r = describeBuild("0.24.0", raw);
      expect(r, JSON.stringify(raw)).toEqual({ serverVersion: "0.24.0+unknown" });
    }
  });
});

describe("loadBuildRecord", () => {
  it("reads build-info.json from the given directory and never throws", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-build-"));
    try {
      expect(loadBuildRecord(dir)).toBeNull(); // missing
      writeFileSync(path.join(dir, "build-info.json"), "{not json");
      expect(loadBuildRecord(dir)).toBeNull(); // malformed
      writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: "abc1234" }));
      expect(loadBuildRecord(dir)).toEqual({ commit: "abc1234" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `CLAUDE.md` — the working instructions for this repository — is not tracked here (see
 * `.gitignore`, untracked 2026-09-04: it is an internal document, and a public repository was
 * the wrong place for drive paths and workflow notes). It still exists in the working tree on
 * the machines it is written on, and a second copy lives elsewhere so a second machine gets it.
 *
 * That copy is the weak point. Untracking the file removed the one thing that made divergence
 * visible: there is no diff on it any more, so an edit that never reaches the copy leaves the
 * other machine on an old version and nothing says so. This test is the replacement signal.
 *
 * Where the copy lives is NOT written here. Hardcoding `D:/etc/Google Drive/...` into a tracked
 * test would put the maintainer's drive layout straight back into the public tree — the exact
 * thing untracking the file was for. Instead `CLAUDE.md` declares its own mirrors in a trailing
 * comment (`instructions-mirror: <path>`, one per line), the same self-declaring shape the
 * comparison table and the site-notice check use, and this test reads them from there.
 *
 * It stays quiet in every situation where it has nothing to say, because a test that fails on
 * someone else's clone is worse than no test:
 *   - no `CLAUDE.md` at all (CI, a contributor's checkout) — nothing to mirror;
 *   - a `CLAUDE.md` that declares no mirror (someone else's own instructions) — not our business;
 *   - a declared mirror whose directory is not mounted (Drive offline, the other machine's path).
 * It speaks only when a mirror directory IS there and its content differs, which is precisely
 * the case where somebody is about to lose an edit.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(ROOT, "CLAUDE.md");

/** Mirror paths the instructions declare about themselves, in the order they are listed. */
export function declaredMirrors(text: string): string[] {
  return [...text.matchAll(/^\s*instructions-mirror:\s*(\S.*?)\s*$/gm)].map((m) => m[1]);
}

const local = existsSync(LOCAL) ? readFileSync(LOCAL, "utf8") : null;
const mirrors = local === null ? [] : declaredMirrors(local);
/** The first declared mirror whose directory exists — the others belong to another machine. */
const reachable = mirrors.find((m) => statSync(path.dirname(m), { throwIfNoEntry: false })?.isDirectory());

describe("instructions mirror", () => {
  it("reads the declared paths out of a trailing comment", () => {
    const sample = "text\n<!--\n  instructions-mirror: X:/one/CLAUDE.md\n  instructions-mirror: Y:/two/CLAUDE.md\n-->\n";
    expect(declaredMirrors(sample)).toEqual(["X:/one/CLAUDE.md", "Y:/two/CLAUDE.md"]);
  });

  it("finds no path in prose that merely mentions the word", () => {
    expect(declaredMirrors("The instructions-mirror lives on Drive, see above.")).toEqual([]);
  });

  it.skipIf(!reachable)("keeps the copy on the reachable mirror byte-identical", () => {
    const target = reachable as string;
    expect(
      existsSync(target),
      `CLAUDE.md declares a mirror at\n  ${target}\nand its directory exists, but the file does ` +
        `not. Copy it:\n  cp "${LOCAL}" "${target}"`,
    ).toBe(true);
    expect(
      readFileSync(target, "utf8"),
      `CLAUDE.md and its mirror have drifted apart. Whichever is newer, the other machine is ` +
        `reading the stale one and no diff will tell it so. Copy the current file over:\n` +
        `  cp "${LOCAL}" "${target}"`,
    ).toBe(local);
  });
});

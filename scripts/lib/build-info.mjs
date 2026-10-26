// Which commit a build of dist/ came from, and whether it is a release.
//
// Reported by `get_profile` because the version number alone could not answer the question it was
// added for (2026-10-26, two operators independently): a clone's `dist/` built six commits after
// 0.23.0 and the npm install of 0.23.0 both said "0.23.0". Only a release build carries the bare
// number; everything else names its commit.
//
// The pure part (`resolveBuildIdentity`) decides; `readGitState` is the thin IO layer around it.

import { spawnSync } from "node:child_process";

/**
 * Paths whose state changes what `tsc` emits or what the package resolves to. A modified README
 * does not make a build dirty; an untracked `src/*.ts` does, because `tsc` compiles it into
 * `dist/` all the same — that happened on 2026-09-03, and a check limited to tracked files (the
 * rule the MCPB bundle uses) would have called that build clean.
 */
export const BUILD_INPUTS = ["src", "package.json", "package-lock.json", "tsconfig.json"];

/**
 * @param {{ version: string, sha: string, tagsAtHead: string[], refType?: string, refName?: string, changedInputs: string[] }} s
 * @returns {{ commit: string | null, dirty: boolean, release: boolean }}
 */
export function resolveBuildIdentity(s) {
  const tag = `v${s.version}`;
  const commit = s.sha ? s.sha : null;
  const dirty = s.changedInputs.length > 0;
  // In GitHub Actions a tag checkout may not carry tag refs; the workflow's own ref is the same
  // evidence (same rule as scripts/build-mcpb.mjs).
  const atTag = s.tagsAtHead.includes(tag) || (s.refType === "tag" && s.refName === tag);
  return { commit, dirty, release: Boolean(commit) && atTag && !dirty };
}

/** Parse `git status --porcelain` lines into their paths (rename lines keep the new path). */
export function changedPaths(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3).split(" -> ").pop().trim());
}

/** Read the git state of `repoRoot`. Never throws: no git, or not a repo, reads as "no commit". */
export function readGitState(repoRoot) {
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    // trimEnd, not trim: porcelain lines start with a status column that may be a space.
    return r.status === 0 ? (r.stdout ?? "").trimEnd() : "";
  };
  return {
    sha: git("rev-parse", "--short=7", "HEAD").trim(),
    tagsAtHead: git("tag", "--points-at", "HEAD").split(/\r?\n/).filter(Boolean),
    changedInputs: changedPaths(git("status", "--porcelain", "--untracked-files=all", "--", ...BUILD_INPUTS)),
  };
}

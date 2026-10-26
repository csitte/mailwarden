import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which build is answering. `scripts/write-build-info.mjs` records the commit next to the compiled
 * code (`dist/build-info.json`); this module turns that record into what `get_profile` reports.
 *
 * Only a release build carries the bare version. Anything else names its commit in semver build
 * metadata (`0.23.0+a5ff4a7`, `+a5ff4a7.dirty` when sources were uncommitted), because two
 * operators found on 2026-10-26 that a clone's `dist/` six commits past 0.23.0 and the npm install
 * of 0.23.0 both reported "0.23.0" — the one question the field exists to answer.
 *
 * A missing, unreadable or foreign record reads as `+unknown`, never as the bare version: a source
 * run (tsx, tests), a `dist/` compiled with a bare `tsc`, or one whose record belongs to another
 * version cannot vouch for being the release.
 */
export interface BuildRecord {
  commit: string;
  dirty: boolean;
  release: boolean;
  builtAt: string;
}

export interface ServerIdentity {
  serverVersion: string;
  build?: BuildRecord;
}

export function describeBuild(pkgVersion: string, raw: unknown): ServerIdentity {
  const r = raw as Partial<Record<keyof BuildRecord | "version", unknown>> | null;
  const valid =
    r !== null &&
    typeof r === "object" &&
    r.version === pkgVersion &&
    typeof r.commit === "string" &&
    /^[0-9a-f]{4,40}$/.test(r.commit) &&
    typeof r.dirty === "boolean" &&
    typeof r.release === "boolean" &&
    typeof r.builtAt === "string";
  if (!valid) return { serverVersion: `${pkgVersion}+unknown` };
  const build: BuildRecord = {
    commit: r.commit as string,
    dirty: r.dirty as boolean,
    // A record cannot be a release and dirty at once; if it says so, trust the weaker claim.
    release: (r.release as boolean) && !(r.dirty as boolean),
    builtAt: r.builtAt as string,
  };
  const serverVersion = build.release
    ? pkgVersion
    : `${pkgVersion}+${build.commit}${build.dirty ? ".dirty" : ""}`;
  return { serverVersion, build };
}

/** Read `build-info.json` from the directory the running code was loaded from. Never throws. */
export function loadBuildRecord(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

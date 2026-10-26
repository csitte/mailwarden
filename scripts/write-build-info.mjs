#!/usr/bin/env node
// Runs after `tsc` (see "build" in package.json): records which commit dist/ was built from in
// dist/build-info.json, read back at runtime by src/buildinfo.ts for `get_profile`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGitState, resolveBuildIdentity } from "./lib/build-info.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const state = readGitState(repoRoot);
const identity = resolveBuildIdentity({
  version,
  ...state,
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
});

const info = { version, ...identity, builtAt: new Date().toISOString() };
mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
writeFileSync(path.join(repoRoot, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");

const label = identity.release
  ? `release ${version}`
  : `${version}+${identity.commit ?? "unknown"}${identity.dirty ? ".dirty" : ""}`;
console.log(`mailwarden build: ${label}${identity.dirty ? ` (uncommitted: ${state.changedInputs.join(", ")})` : ""}`);

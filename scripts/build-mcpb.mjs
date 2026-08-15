#!/usr/bin/env node
/**
 * Build the MCPB bundles in `dist-mcpb/` — the artifact both Smithery (`smithery mcp publish
 * <file>.mcpb`) and the Claude Desktop extension directory accept for a local stdio server. See
 * docs/ROADMAP.md.
 *
 * Two files, same content, different manifest:
 *   - `mailwarden-<version>.mcpb`          — strict MCPB (validated with `mcpb validate`, packed with
 *                                            `mcpb pack`); the GitHub release asset / Claude Desktop.
 *   - `mailwarden-<version>-smithery.mcpb` — for `smithery mcp publish`. Smithery's registry stores
 *     the manifest's `tools` as MCP `Tool` objects and REQUIRES `inputSchema` on each, which the MCPB
 *     tool shape (`{name, description}`) forbids — a strict bundle with tools is rejected with a 400
 *     (smithery-ai/cli#787). Its CLI does not validate the manifest against the MCPB schema, only
 *     JSON-parses it and passes `tools` through, so this variant carries the REAL MCP Tool objects
 *     from tools/list (name, description, inputSchema, annotations) — the exact shape the registry
 *     type (`ServerCard.Tool` in @smithery/api) declares. Validated against the LOOSE MCPB schema
 *     (unknown fields tolerated) and zipped with the same file set and attributes `mcpb pack` uses.
 *
 * The bundle is built FROM THE PACKED PACKAGE, not from the working tree: `npm pack` → unpack →
 * `npm ci --omit=dev` against this repo's lockfile. So it contains exactly the files npm ships
 * (same `files` allowlist), with a dependency tree pinned by package-lock.json — the same tree in
 * CI, on the release machine and next month. The server itself is untouched: the manifest starts
 * `dist/index.js` the way `npx mailwarden` would.
 *
 * Version discipline: the bundle version is package.json's ONLY when HEAD is exactly the tag
 * `v<version>` with a clean tree (or the CI checkout of that tag). Anything else is a development
 * build and is versioned `<version>-dev.<sha>[.dirty]` — in the manifest AND the file name — so a
 * bundle built from an unreleased main can never be mistaken for, or published as, the release.
 *
 * What it proves before it writes an artifact, and again on the artifacts themselves:
 *   1. the staged tree boots and answers `initialize` + `tools/list` (that handshake is also where
 *      the manifests' `tools` come from — read off the real server, never hand-maintained);
 *   2. the reported version is package.json's, and the manifests carry the bundle version;
 *   3. every `${user_config.X}` placeholder in mcp_config has a default (Smithery leaves an
 *      unresolved placeholder LITERAL in the env, and `MAILWARDEN_TOOLS='${user_config.tools}'`
 *      would refuse to boot);
 *   4. `mcpb validate` accepts the strict manifest; the loose schema accepts the Smithery one;
 *   5. both bundles stay under Smithery's 25 MiB limit;
 *   6. both UNPACKED bundles boot — `mcpb pack` drops files by pattern (`*.d.ts`, `*.map`, …), and
 *      this is the check that nothing it dropped was needed at runtime; the read tier still gates.
 *
 * Usage: `npm run mcpb` (from the repo root). Exits non-zero on the first failed check.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { mcpSession } from "./lib/mcp-session.mjs";
import { npm, run } from "./lib/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const version = require(path.join(repoRoot, "package.json")).version;

// Smithery's CLI refuses bundles above this (MAX_BUNDLE_SIZE_BYTES in smithery-ai/cli src/lib/mcpb.ts).
const SMITHERY_MAX_BYTES = 25 * 1024 * 1024;

// The mcpb CLI's entry file, resolved through its own package.json (`exports` blocks a direct
// require of the bin path) — no PATH lookup, no `.cmd` shim, works the same on every platform.
const mcpbPkgDir = path.join(repoRoot, "node_modules", "@anthropic-ai", "mcpb");
const mcpbCli = path.join(mcpbPkgDir, JSON.parse(readFileSync(path.join(mcpbPkgDir, "package.json"), "utf8")).bin);
const mcpb = (...args) => run(process.execPath, [mcpbCli, ...args]);
// Same file walk `mcpb pack` uses (default excludes + .mcpbignore), so the Smithery variant ships
// the identical file set. The loose schema is not on the package's export map (its declared file is
// missing in 2.1.2), so it is loaded by path.
const { getAllFilesWithCount, readMcpbIgnorePatterns } = await import("@anthropic-ai/mcpb/node");
const looseSchema = (await import(pathToFileURL(path.join(mcpbPkgDir, "dist", "schemas_loose", "0.3.js")).href))
  .McpbManifestSchema;

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}
const git = (...args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() ?? "";

/**
 * Release build ⇔ HEAD is the tag `v<version>` and the tree is clean. In GitHub Actions the tag
 * checkout may not carry tag refs, so the workflow's own ref is accepted as the same evidence.
 */
function resolveBundleVersion() {
  const tag = `v${version}`;
  // Tracked changes only: an untracked file (a downloaded tool binary in CI, a scratch note)
  // is not in the packed package and must not demote a release build.
  const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
  const atTag =
    git("tag", "--points-at", "HEAD").split(/\r?\n/).includes(tag) ||
    (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME === tag);
  if (atTag && !dirty) return { bundleVersion: version, release: true };
  const sha = git("rev-parse", "--short", "HEAD") || "nogit";
  return { bundleVersion: `${version}-dev.${sha}${dirty ? ".dirty" : ""}`, release: false };
}

/** Every `${user_config.X}` in mcp_config must name a user_config entry that has a default. */
function templateKeys(manifest) {
  const cfg = manifest.server.mcp_config;
  const strings = [cfg.command, ...(cfg.args ?? []), ...Object.values(cfg.env ?? {})];
  return [...new Set(strings.flatMap((s) => [...s.matchAll(/\$\{user_config\.([^}]+)\}/g)].map((m) => m[1])))];
}

/** Zip a staged directory exactly the way `mcpb pack` does (fflate, unix modes in the upper bits). */
function zipLikeMcpb(dir, outFile) {
  const { files } = getAllFilesWithCount(dir, dir, {}, readMcpbIgnorePatterns(dir));
  const isUnix = process.platform !== "win32";
  const entries = {};
  for (const [file, { data, mode }] of Object.entries(files)) {
    entries[file] = isUnix ? [data, { os: 3, attrs: (mode & 0o777) << 16 }] : data;
  }
  writeFileSync(outFile, zipSync(entries, { level: 9, mtime: new Date() }));
}

/** Unpack a bundle and drive it through the handshake — the artifact check both variants get. */
async function verifyBundle(label, file, expectedVersion, stagedToolNames, emptyConfig, work) {
  console.log(`\n${label}: unpack + MCP handshake`);
  const size = statSync(file).size;
  check(
    `under Smithery's ${SMITHERY_MAX_BYTES / 1024 / 1024} MiB limit`,
    size < SMITHERY_MAX_BYTES,
    `${(size / 1024 / 1024).toFixed(1)} MiB`,
  );
  const unpacked = path.join(work, `unpacked-${label}`);
  mcpb("unpack", file, unpacked);
  const shipped = JSON.parse(readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  check(`shipped manifest version is ${expectedVersion}`, shipped.version === expectedVersion, `got ${shipped.version}`);
  const entry = path.join(unpacked, shipped.server.entry_point);
  const session = await mcpSession(entry, { MAILWARDEN_DIR: emptyConfig });
  check("unpacked bundle boots and answers initialize", session.serverInfo?.name === "mailwarden");
  check(
    "unpacked bundle lists the same tools as the staged tree",
    JSON.stringify(session.tools.map((t) => t.name)) === JSON.stringify(stagedToolNames),
    `${session.tools.length} tools`,
  );
  const readOnly = await mcpSession(entry, { MAILWARDEN_DIR: emptyConfig, MAILWARDEN_TOOLS: "read" });
  const writeTools = readOnly.tools
    .map((t) => t.name)
    .filter((t) => ["archive", "trash", "modify_labels", "create_filter", "unsubscribe"].includes(t));
  check("read tier registers no write tools in the bundle", writeTools.length === 0, writeTools.join(",") || "none");
  return size;
}

const work = mkdtempSync(path.join(tmpdir(), "mailwarden-mcpb-"));
// An existing-but-empty config dir: the server must boot without credentials (it diagnoses them
// lazily, per call), and nothing here may read the developer's real ~/.mailwarden.
const emptyConfig = path.join(work, "config");
mkdirSync(emptyConfig);
const stage = path.join(work, "stage");
mkdirSync(stage);
const outDir = path.join(repoRoot, "dist-mcpb");
mkdirSync(outDir, { recursive: true });

const { bundleVersion, release } = resolveBundleVersion();
const strictFile = path.join(outDir, `mailwarden-${bundleVersion}.mcpb`);
const smitheryFile = path.join(outDir, `mailwarden-${bundleVersion}-smithery.mcpb`);

try {
  console.log(`mailwarden MCPB build — ${bundleVersion} (${release ? "RELEASE: HEAD is v" + version + ", tree clean" : "development build"})`);
  console.log(`  workdir: ${work}`);

  console.log("\nPacking the npm package…");
  run(npm, ["pack", "--pack-destination", work], { cwd: repoRoot });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) {
    console.error("npm pack produced no tarball");
    process.exit(1);
  }
  check(`tarball carries the version (${version})`, tarball.includes(version), tarball);

  console.log("\nStaging: unpack + production dependencies from the lockfile…");
  // The tarball's single top-level directory is `package/`; strip it so dist/ lands at the root.
  // Relative paths on purpose: GNU tar (Git for Windows) reads a `C:` prefix as a remote host.
  run("tar", ["-xzf", tarball, "-C", "stage", "--strip-components=1"], { cwd: work });
  copyFileSync(path.join(repoRoot, "package-lock.json"), path.join(stage, "package-lock.json"));
  run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });

  console.log("\nMCP handshake against the staged tree:");
  const staged = await mcpSession(path.join(stage, "dist", "index.js"), { MAILWARDEN_DIR: emptyConfig });
  check("server boots and answers initialize", staged.serverInfo?.name === "mailwarden", JSON.stringify(staged.serverInfo));
  check(`reported version is ${version}`, staged.serverInfo?.version === version, `got ${staged.serverInfo?.version}`);
  check("tools/list is non-empty", staged.tools.length > 0, `${staged.tools.length} tools`);
  const stagedToolNames = staged.tools.map((t) => t.name);
  const sendish = stagedToolNames.filter((t) => /send|compose|reply|forward/i.test(t));
  check("no send-shaped tool is registered", sendish.length === 0, sendish.join(",") || "none");
  check(
    "every tool from tools/list carries an inputSchema (Smithery's registry requires it)",
    staged.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"),
  );

  console.log("\nManifest:");
  const base = JSON.parse(readFileSync(path.join(repoRoot, "mcpb", "manifest.json"), "utf8"));
  base.version = bundleVersion;
  check("entry_point exists in the staged tree", statSync(path.join(stage, base.server.entry_point)).isFile());
  const keys = templateKeys(base);
  const undefaulted = keys.filter((k) => base.user_config?.[k]?.default === undefined && !base.user_config?.[k]?.required);
  check(
    "every ${user_config.*} placeholder has a default (unresolved placeholders stay literal on Smithery)",
    undefaulted.length === 0,
    undefaulted.length ? `missing: ${undefaulted.join(", ")}` : `${keys.length} checked`,
  );

  // Strict variant — MCPB tool entries are {name, description} only.
  const strict = {
    ...base,
    tools: staged.tools.map(({ name, description }) => (description ? { name, description } : { name })),
  };
  const manifestPath = path.join(stage, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(strict, null, 2) + "\n");
  mcpb("validate", manifestPath);
  check("mcpb validate accepts the strict manifest", true);
  console.log("\nPacking the strict bundle…");
  rmSync(strictFile, { force: true });
  mcpb("pack", stage, strictFile);

  // Smithery variant — the real MCP Tool objects, which is what the registry's Tool schema wants.
  const smithery = {
    ...base,
    tools: staged.tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      ...(description ? { description } : {}),
      inputSchema,
      ...(annotations ? { annotations } : {}),
    })),
  };
  const loose = looseSchema.safeParse(smithery);
  check(
    "loose MCPB schema accepts the Smithery manifest",
    loose.success,
    loose.success ? "" : JSON.stringify(loose.error.issues.slice(0, 3)),
  );
  writeFileSync(manifestPath, JSON.stringify(smithery, null, 2) + "\n");
  console.log("\nPacking the Smithery bundle…");
  rmSync(smitheryFile, { force: true });
  zipLikeMcpb(stage, smitheryFile);

  const strictSize = await verifyBundle("strict", strictFile, bundleVersion, stagedToolNames, emptyConfig, work);
  const smitherySize = await verifyBundle("smithery", smitheryFile, bundleVersion, stagedToolNames, emptyConfig, work);
  const shippedSmithery = JSON.parse(readFileSync(path.join(work, "unpacked-smithery", "manifest.json"), "utf8"));
  check(
    "Smithery bundle's tools carry inputSchema",
    Array.isArray(shippedSmithery.tools) && shippedSmithery.tools.every((t) => t.inputSchema?.type === "object"),
    `${shippedSmithery.tools?.length ?? 0} tools`,
  );

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    rmSync(strictFile, { force: true });
    rmSync(smitheryFile, { force: true });
    process.exit(1);
  }
  const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  console.log(`\n✓ ${path.relative(repoRoot, strictFile)} (${mib(strictSize)}, ${strict.tools.length} tools)`);
  console.log(`✓ ${path.relative(repoRoot, smitheryFile)} (${mib(smitherySize)}, ${smithery.tools.length} tools with inputSchema)`);
  if (!release) {
    console.log(`  development build — HEAD is not a clean checkout of v${version}; do not publish these.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

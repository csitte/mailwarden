#!/usr/bin/env node
/**
 * Build the MCPB bundle in `dist-mcpb/` — `mailwarden-<version>.mcpb`, strict MCPB (validated with
 * `mcpb validate`, packed with `mcpb pack`): the GitHub release asset and what the Claude Desktop
 * extension directory accepts for a local stdio server. See docs/ROADMAP.md.
 *
 * (Until 0.28.0 a second, `-smithery` variant carried the full MCP Tool objects that Smithery's
 * registry required. Smithery shut down its CLI and accounts on 31 October 2026 and stays a
 * directory only; 0.23.0 was the last version published there, so the variant is gone.)
 *
 * The bundle is built FROM THE PACKED PACKAGE, not from the working tree: `npm pack` → unpack →
 * `npm ci --omit=dev` against this repo's lockfile. So it contains exactly the files npm ships
 * (same `files` allowlist), with a dependency tree pinned by package-lock.json — the same tree in
 * CI, on the release machine and next month. The server itself is untouched: the manifest starts
 * `dist/index.js` the way `npx mailwarden` would.
 *
 * One addition to that tree: `npm ci` installs the OS-keystore binding (`@napi-rs/keyring`) for the
 * build machine only, and a bundle is one file for every platform the manifest declares. So the
 * other platforms' binding packages are fetched from the lockfile's `resolved` URLs, checked against
 * its `integrity` hashes and unpacked next to it — without them the bundle would store the token in
 * plaintext on every platform but the one it was built on. Which packages: scripts/lib/mcpb-bindings.mjs.
 *
 * Version discipline: the bundle version is package.json's ONLY when HEAD is exactly the tag
 * `v<version>` with a clean tree (or the CI checkout of that tag). Anything else is a development
 * build and is versioned `<version>-dev.<sha>[.dirty]` — in the manifest AND the file name — so a
 * bundle built from an unreleased main can never be mistaken for, or published as, the release.
 *
 * What it proves before it writes an artifact, and again on the artifacts themselves:
 *   1. the staged tree boots and answers `initialize` + `tools/list` (that handshake is also where
 *      the manifest's `tools` come from — read off the real server, never hand-maintained);
 *   2. the reported version is package.json's, and the manifest carries the bundle version;
 *   3. every `${user_config.X}` placeholder in mcp_config has a default (a host that leaves an
 *      unresolved placeholder LITERAL in the env would start `MAILWARDEN_TOOLS='${user_config.tools}'`,
 *      which refuses to boot);
 *   4. `mcpb validate` accepts the manifest;
 *   5. the UNPACKED bundle boots — `mcpb pack` drops files by pattern (`*.d.ts`, `*.map`, …), and
 *      this is the check that nothing it dropped was needed at runtime; the read tier still gates;
 *   6. the bundle carries a keystore binary for every declared platform on x64 and arm64.
 *
 * Usage: `npm run mcpb` (from the repo root). Exits non-zero on the first failed check.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindingPackages, parseIntegrity, uncoveredTargets } from "./lib/mcpb-bindings.mjs";
import { mcpSession } from "./lib/mcp-session.mjs";
import { npm, run } from "./lib/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const version = require(path.join(repoRoot, "package.json")).version;

// The mcpb CLI's entry file, resolved through its own package.json (`exports` blocks a direct
// require of the bin path) — no PATH lookup, no `.cmd` shim, works the same on every platform.
const mcpbPkgDir = path.join(repoRoot, "node_modules", "@anthropic-ai", "mcpb");
const mcpbCli = path.join(mcpbPkgDir, JSON.parse(readFileSync(path.join(mcpbPkgDir, "package.json"), "utf8")).bin);
const mcpb = (...args) => run(process.execPath, [mcpbCli, ...args]);

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

/** The package's directory under `root`, if it holds the expected version and a native binary. */
function bindingPresent(root, pkg) {
  const dir = path.join(root, "node_modules", ...pkg.name.split("/"));
  const manifestFile = path.join(dir, "package.json");
  if (!existsSync(manifestFile)) return false;
  if (JSON.parse(readFileSync(manifestFile, "utf8")).version !== pkg.version) return false;
  return readdirSync(dir).some((f) => f.endsWith(".node"));
}

/**
 * Fetch each binding package the build machine's `npm ci` left out, exactly as the lockfile pins it,
 * and unpack it into the staged tree. A hash mismatch is fatal: the bytes are a native library that
 * the server loads into its own process.
 */
async function addBindings(stage, work, packages) {
  const tarballs = path.join(work, "bindings");
  mkdirSync(tarballs, { recursive: true });
  for (const pkg of packages) {
    if (bindingPresent(stage, pkg)) {
      console.log(`  · ${pkg.name} — installed by npm ci`);
      continue;
    }
    const res = await fetch(pkg.resolved);
    if (!res.ok) {
      console.error(`  ✗ ${pkg.name}: GET ${pkg.resolved} answered ${res.status}`);
      process.exit(1);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const { algorithm, digest } = parseIntegrity(pkg.integrity);
    const got = createHash(algorithm).update(data).digest("base64");
    if (got !== digest) {
      console.error(`  ✗ ${pkg.name}: ${algorithm} ${got} does not match the lockfile's ${digest}`);
      process.exit(1);
    }
    const base = pkg.name.split("/").pop();
    writeFileSync(path.join(tarballs, `${base}.tgz`), data);
    const dest = path.join(stage, "node_modules", ...pkg.name.split("/"));
    mkdirSync(dest, { recursive: true });
    // Relative paths, as for the package tarball: GNU tar reads a `C:` prefix as a remote host.
    const rel = path.relative(work, dest).split(path.sep).join("/");
    run("tar", ["-xzf", `bindings/${base}.tgz`, "-C", rel, "--strip-components=1"], { cwd: work });
    console.log(`  + ${pkg.name} — ${(data.length / 1024).toFixed(0)} KiB, ${algorithm} verified`);
  }
}

/** Unpack the bundle and drive it through the handshake — the check on the artifact itself. */
async function verifyBundle(file, expectedVersion, stagedToolNames, emptyConfig, work, bindings) {
  console.log("\nBundle: unpack + MCP handshake");
  const size = statSync(file).size;
  const unpacked = path.join(work, "unpacked");
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
  const absent = bindings.filter((pkg) => !bindingPresent(unpacked, pkg)).map((pkg) => pkg.name);
  check(
    "bundle carries a keystore binary for every declared platform",
    absent.length === 0,
    absent.length ? `missing: ${absent.join(", ")}` : `${bindings.length} bindings`,
  );
  // The server loads the binding lazily, so the handshake above never touched it. Load it from the
  // unpacked tree here — on this machine only, which is all a build can prove.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const req = require("node:module").createRequire(process.argv[1]);
       process.exit(typeof req("@napi-rs/keyring").AsyncEntry === "function" ? 0 : 1);`,
      path.join(unpacked, "package.json"),
    ],
    { encoding: "utf8" },
  );
  check(
    `keystore binding loads from the bundle on ${process.platform}-${process.arch}`,
    probe.status === 0,
    probe.status === 0 ? "" : (probe.stderr || "").trim().split(/\r?\n/)[0],
  );
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
const bundleFile = path.join(outDir, `mailwarden-${bundleVersion}.mcpb`);

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

  console.log("\nKeystore bindings for every declared platform (from the lockfile):");
  const platforms = JSON.parse(readFileSync(path.join(repoRoot, "mcpb", "manifest.json"), "utf8")).compatibility.platforms;
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const bindings = bindingPackages(lock, platforms);
  const uncovered = uncoveredTargets(bindings, platforms);
  check("the lockfile has a binding for every declared platform", uncovered.length === 0, uncovered.join(", ") || platforms.join(", "));
  await addBindings(stage, work, bindings);
  const unstaged = bindings.filter((pkg) => !bindingPresent(stage, pkg)).map((pkg) => pkg.name);
  check("every binding is staged with its native binary", unstaged.length === 0, unstaged.join(", ") || `${bindings.length} bindings`);

  console.log("\nMCP handshake against the staged tree:");
  const staged = await mcpSession(path.join(stage, "dist", "index.js"), { MAILWARDEN_DIR: emptyConfig });
  check("server boots and answers initialize", staged.serverInfo?.name === "mailwarden", JSON.stringify(staged.serverInfo));
  check(`reported version is ${version}`, staged.serverInfo?.version === version, `got ${staged.serverInfo?.version}`);
  check("tools/list is non-empty", staged.tools.length > 0, `${staged.tools.length} tools`);
  const stagedToolNames = staged.tools.map((t) => t.name);
  const sendish = stagedToolNames.filter((t) => /send|compose|reply|forward/i.test(t));
  check("no send-shaped tool is registered", sendish.length === 0, sendish.join(",") || "none");
  check(
    "every tool from tools/list carries an inputSchema",
    staged.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"),
  );

  console.log("\nManifest:");
  const base = JSON.parse(readFileSync(path.join(repoRoot, "mcpb", "manifest.json"), "utf8"));
  base.version = bundleVersion;
  check("entry_point exists in the staged tree", statSync(path.join(stage, base.server.entry_point)).isFile());
  const keys = templateKeys(base);
  const undefaulted = keys.filter((k) => base.user_config?.[k]?.default === undefined && !base.user_config?.[k]?.required);
  check(
    "every ${user_config.*} placeholder has a default (a host may leave an unresolved one literal)",
    undefaulted.length === 0,
    undefaulted.length ? `missing: ${undefaulted.join(", ")}` : `${keys.length} checked`,
  );

  // MCPB tool entries are {name, description} only.
  const manifest = {
    ...base,
    tools: staged.tools.map(({ name, description }) => (description ? { name, description } : { name })),
  };
  const manifestPath = path.join(stage, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  mcpb("validate", manifestPath);
  check("mcpb validate accepts the manifest", true);
  console.log("\nPacking the bundle…");
  rmSync(bundleFile, { force: true });
  mcpb("pack", stage, bundleFile);

  const size = await verifyBundle(bundleFile, bundleVersion, stagedToolNames, emptyConfig, work, bindings);

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    rmSync(bundleFile, { force: true });
    process.exit(1);
  }
  console.log(`\n✓ ${path.relative(repoRoot, bundleFile)} (${(size / 1024 / 1024).toFixed(1)} MiB, ${manifest.tools.length} tools)`);
  if (!release) {
    console.log(`  development build — HEAD is not a clean checkout of v${version}; do not publish it.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

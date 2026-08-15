#!/usr/bin/env node
/**
 * Build the MCPB bundle (`dist-mcpb/mailwarden-<version>.mcpb`) — the one artifact both Smithery
 * (`smithery mcp publish <file>.mcpb`) and the Claude Desktop extension directory accept for a
 * local stdio server. See docs/ROADMAP.md.
 *
 * The bundle is built FROM THE PACKED PACKAGE, not from the working tree: `npm pack` → unpack →
 * `npm ci --omit=dev` against this repo's lockfile. So it contains exactly the files npm ships
 * (same `files` allowlist), with a dependency tree pinned by package-lock.json — the same tree in
 * CI, on the release machine and next month. The server itself is untouched: the manifest starts
 * `dist/index.js` the way `npx mailwarden` would.
 *
 * What it proves before it writes the artifact, and again on the artifact itself:
 *   1. the staged tree boots and answers `initialize` + `tools/list` (that handshake is also where
 *      the manifest's `tools` list comes from — read off the real server, never hand-maintained);
 *   2. the reported version is package.json's, and so is the manifest's;
 *   3. `mcpb validate` accepts the manifest;
 *   4. the packed bundle stays under Smithery's 25 MiB limit;
 *   5. the UNPACKED bundle boots too — `mcpb pack` drops files by pattern (`*.d.ts`, `*.map`, …),
 *      and this is the check that nothing it dropped was needed at runtime.
 *
 * Usage: `npm run mcpb` (from the repo root). `--no-tools` omits the manifest's `tools` array —
 * a workaround for smithery-ai/cli#787 (their registry rejects MCPB tool entries because the MCPB
 * tool shape has no inputSchema); drop the flag once that is fixed upstream.
 * Exits non-zero on the first failed check.
 */
import { createRequire } from "node:module";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpSession } from "./lib/mcp-session.mjs";
import { npm, run } from "./lib/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const version = require(path.join(repoRoot, "package.json")).version;
const omitTools = process.argv.includes("--no-tools");

// Smithery's CLI refuses bundles above this (MAX_BUNDLE_SIZE_BYTES in smithery-ai/cli src/lib/mcpb.ts).
const SMITHERY_MAX_BYTES = 25 * 1024 * 1024;

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

const work = mkdtempSync(path.join(tmpdir(), "mailwarden-mcpb-"));
// An existing-but-empty config dir: the server must boot without credentials (it diagnoses them
// lazily, per call), and nothing here may read the developer's real ~/.mailwarden.
const emptyConfig = path.join(work, "config");
mkdirSync(emptyConfig);
const stage = path.join(work, "stage");
mkdirSync(stage);
const outDir = path.join(repoRoot, "dist-mcpb");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `mailwarden-${version}.mcpb`);

try {
  console.log(`mailwarden MCPB build (${version})`);
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
  const stagedCli = path.join(stage, "dist", "index.js");

  console.log("\nMCP handshake against the staged tree:");
  const staged = await mcpSession(stagedCli, { MAILWARDEN_DIR: emptyConfig });
  check("server boots and answers initialize", staged.serverInfo?.name === "mailwarden", JSON.stringify(staged.serverInfo));
  check(`reported version is ${version}`, staged.serverInfo?.version === version, `got ${staged.serverInfo?.version}`);
  check("tools/list is non-empty", staged.tools.length > 0, `${staged.tools.length} tools`);
  const sendish = staged.tools.map((t) => t.name).filter((t) => /send|compose|reply|forward/i.test(t));
  check("no send-shaped tool is registered", sendish.length === 0, sendish.join(",") || "none");

  console.log("\nManifest:");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "mcpb", "manifest.json"), "utf8"));
  manifest.version = version;
  if (omitTools) {
    delete manifest.tools;
    // Honest without a list: the server does register tools, the manifest just does not enumerate them.
    manifest.tools_generated = true;
    console.log("  (--no-tools: manifest carries no tools array)");
  } else {
    // MCPB tool entries are {name, description} only — no inputSchema — so this is all we can carry.
    manifest.tools = staged.tools.map(({ name, description }) => (description ? { name, description } : { name }));
  }
  const manifestPath = path.join(stage, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  check("entry_point exists in the staged tree", statSync(path.join(stage, manifest.server.entry_point)).isFile());
  mcpb("validate", manifestPath);
  check("mcpb validate accepts the manifest", true);

  console.log("\nPacking the bundle…");
  rmSync(outFile, { force: true });
  mcpb("pack", stage, outFile);
  const size = statSync(outFile).size;
  check(
    `bundle is under Smithery's ${SMITHERY_MAX_BYTES / 1024 / 1024} MiB limit`,
    size < SMITHERY_MAX_BYTES,
    `${(size / 1024 / 1024).toFixed(1)} MiB`,
  );

  console.log("\nMCP handshake against the UNPACKED bundle:");
  const unpacked = path.join(work, "unpacked");
  mcpb("unpack", outFile, unpacked);
  const shipped = JSON.parse(readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  check(`shipped manifest version is ${version}`, shipped.version === version, `got ${shipped.version}`);
  const fromBundle = await mcpSession(path.join(unpacked, shipped.server.entry_point), { MAILWARDEN_DIR: emptyConfig });
  check("unpacked bundle boots and answers initialize", fromBundle.serverInfo?.name === "mailwarden");
  check(
    "unpacked bundle lists the same tools as the staged tree",
    JSON.stringify(fromBundle.tools.map((t) => t.name)) === JSON.stringify(staged.tools.map((t) => t.name)),
    `${fromBundle.tools.length} tools`,
  );
  const readOnly = await mcpSession(path.join(unpacked, shipped.server.entry_point), {
    MAILWARDEN_DIR: emptyConfig,
    MAILWARDEN_TOOLS: "read",
  });
  const writeTools = readOnly.tools.map((t) => t.name).filter((t) =>
    ["archive", "trash", "modify_labels", "create_filter", "unsubscribe"].includes(t),
  );
  check("read tier registers no write tools in the bundle", writeTools.length === 0, writeTools.join(",") || "none");

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    rmSync(outFile, { force: true });
    process.exit(1);
  }
  console.log(`\n✓ ${path.relative(repoRoot, outFile)} (${(size / 1024 / 1024).toFixed(1)} MiB, ${manifest.tools?.length ?? 0} tools listed)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

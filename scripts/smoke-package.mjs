#!/usr/bin/env node
/**
 * Smoke-test the PACKED package — the artifact users actually install — not the working tree.
 *
 * Why this exists: `npm test` runs against `src/` with the repo's own node_modules, so it cannot
 * see the failure mode where the published tarball is broken for everyone else. Version 0.7.0
 * shipped with an `overrides` entry that resolved a transitive dependency only for the ROOT
 * project: our tree and the user's tree differed, and nothing in CI would have noticed. `npm
 * publish` is irreversible, so the check has to run BEFORE it.
 *
 * What it proves, from a clean consumer project with no credentials:
 *   1. every runtime import resolves after a real `npm install` (the class of bug above),
 *   2. the MCP server boots and completes an `initialize` + `tools/list` handshake over stdio,
 *   3. the version it reports is the one in package.json,
 *   4. tool tiers still gate in the built artifact (read tier ⇒ no write tools),
 *   5. `--check` diagnoses a missing setup instead of crashing on it,
 *   6. the SHIPPED documentation is not broken for the person who installed it — every relative
 *      link resolves inside the package and every anchor points at a real heading.
 *
 * On (6): README once pointed npm users at a script that only exists in the repo. Checking it by
 * hand is unreliable in a way this file exists to avoid — an ad-hoc grep for it found two of three
 * bad links and invented two anchor failures by getting GitHub's slug rule wrong. The check reads
 * the docs out of the INSTALLED package, so "is this file shipped?" is answered by the artifact
 * rather than by reading `files` and hoping.
 *
 * Usage: `npm run smoke` (from the repo root). Exits non-zero on the first failed check.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpSession } from "./lib/mcp-session.mjs";
import { npm, run } from "./lib/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = createRequire(import.meta.url)(path.join(repoRoot, "package.json")).version;

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}

const work = mkdtempSync(path.join(tmpdir(), "mailwarden-smoke-"));
// A config dir that exists but is empty: the doctor must report "no credentials", and no test here
// may read — let alone touch — the developer's real ~/.mailwarden tokens.
const emptyConfig = path.join(work, "config");
mkdirSync(emptyConfig);
const consumer = path.join(work, "consumer");
mkdirSync(consumer);

try {
  console.log("mailwarden package smoke test");
  console.log(`  workdir: ${work}`);

  console.log("\nPacking…");
  run(npm, ["pack", "--pack-destination", work], { cwd: repoRoot });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) {
    console.error("npm pack produced no tarball");
    process.exit(1);
  }
  check(`tarball name carries the version (${expectedVersion})`, tarball.includes(expectedVersion), tarball);

  console.log("\nInstalling into a clean consumer project…");
  run(npm, ["init", "-y"], { cwd: consumer });
  run(npm, ["install", path.join(work, tarball), "--no-audit", "--no-fund"], { cwd: consumer });
  // Run dist/index.js through the current node rather than the .bin shim: the shim is a shell
  // wrapper on Windows, which spawn cannot execute directly, and the shim adds nothing to test.
  const cliPath = path.join(consumer, "node_modules", "mailwarden", "dist", "index.js");

  console.log("\nMCP handshake (default tiers):");
  const session = await mcpSession(cliPath, { MAILWARDEN_DIR: emptyConfig });
  const toolNames = session.tools.map((t) => t.name);
  check("server boots and answers initialize", session.serverInfo?.name === "mailwarden", JSON.stringify(session.serverInfo));
  check(
    `reported version matches package.json (${expectedVersion})`,
    session.serverInfo?.version === expectedVersion,
    `got ${session.serverInfo?.version}`,
  );
  check("tools/list is non-empty", toolNames.length > 0, `${toolNames.length} tools`);
  for (const tool of ["search", "snooze", "archive", "create_filter"]) {
    check(`tool present: ${tool}`, toolNames.includes(tool));
  }
  // The central safety promise: no compose/reply/forward/send tool exists in the shipped artifact.
  const sendish = toolNames.filter((t) => /send|compose|reply|forward/i.test(t));
  check("no send-shaped tool is registered", sendish.length === 0, sendish.join(",") || "none");

  console.log("\nMCP handshake (MAILWARDEN_TOOLS=read):");
  const readOnly = await mcpSession(cliPath, { MAILWARDEN_DIR: emptyConfig, MAILWARDEN_TOOLS: "read" });
  const readOnlyNames = readOnly.tools.map((t) => t.name);
  check("read tier still registers search", readOnlyNames.includes("search"));
  // `unsubscribe` is in this list for a second reason: it is the only tool that makes an
  // outbound request to a non-Google host, and a read-only deployment must never be able to.
  const writeTools = readOnlyNames.filter((t) =>
    ["archive", "trash", "modify_labels", "create_filter", "unsubscribe"].includes(t),
  );
  check("read tier registers no write tools", writeTools.length === 0, writeTools.join(",") || "none");

  console.log("\nShipped documentation:");
  const installed = path.join(consumer, "node_modules", "mailwarden");
  // GitHub's slug: lowercase, drop punctuation, then turn EACH remaining space into a hyphen —
  // so "Security & privacy" is `security--privacy`, with two. Collapsing the run of spaces is the
  // easy mistake, and it reports every such anchor as dead.
  const slug = (heading) =>
    heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/ /g, "-");
  for (const doc of ["README.md", "SECURITY.md"]) {
    const text = readFileSync(path.join(installed, doc), "utf8");
    // Matches `](target)` and `](target "title")`, including the target of a badge link.
    const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);

    const relative = targets.filter((t) => !/^(https?:|mailto:|#|data:)/.test(t));
    const missing = relative.filter((t) => !existsSync(path.join(installed, t.split("#")[0])));
    check(
      `${doc}: relative links resolve inside the installed package`,
      missing.length === 0,
      missing.join(", ") || `${relative.length} checked`,
    );

    const headings = new Set(
      [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1].trim())),
    );
    const anchors = targets.filter((t) => t.startsWith("#"));
    const dead = anchors.filter((a) => !headings.has(a.slice(1)));
    check(
      `${doc}: anchors point at a real heading`,
      dead.length === 0,
      dead.join(", ") || `${anchors.length} checked`,
    );
  }
  // Not in the tarball, but it is what the MCP registry publishes from — a mismatch here ships a
  // registry entry for a version npm does not have.
  const serverJsonVersion = createRequire(import.meta.url)(
    path.join(repoRoot, "server.json"),
  ).version;
  check(
    "server.json version matches package.json",
    serverJsonVersion === expectedVersion,
    `server.json=${serverJsonVersion}`,
  );

  console.log("\nSetup doctor against an empty config dir:");
  const doctor = spawnSync(process.execPath, [cliPath, "--check"], {
    encoding: "utf8",
    env: { ...process.env, MAILWARDEN_DIR: emptyConfig },
  });
  const doctorOut = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
  check("--check exits non-zero when setup is incomplete", doctor.status !== 0, `exit ${doctor.status}`);
  check("--check names the missing credentials", /No OAuth credentials found/.test(doctorOut));
  // A module-resolution fault would surface here as a stack trace instead of a diagnosis — the
  // exact symptom a broken published tree produces for a user running the documented first step.
  check(
    "--check diagnoses rather than crashes",
    !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)|unexpected error/i.test(doctorOut),
  );

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} smoke check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\nWorkdir kept for inspection: ${work}`);
    process.exit(1);
  }
  console.log("\n✓ packed package installs and runs.");
  rmSync(work, { recursive: true, force: true });
} catch (err) {
  console.error("\n✗ smoke test errored:", err instanceof Error ? err.message : err);
  console.error(`Workdir kept for inspection: ${work}`);
  process.exit(1);
}

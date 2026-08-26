#!/usr/bin/env node
/**
 * Says which columns of the README comparison table are worth re-reading, by comparing the
 * revision each claim was checked against with that project's current HEAD.
 *
 *   npm run table-sources
 *
 * Deliberately NOT a gate. An active project moves every day — `taylorwilsdon` had six commits
 * on the day this was written — so failing the build on "the other side changed" would mean
 * failing it permanently, and a check that always fails is a check nobody reads. This answers a
 * question instead: before a comparison round, which columns actually need work?
 *
 * The structural half (every table column has a source entry, every entry is well-formed) IS a
 * gate and runs in the normal test suite, where it needs no network.
 *
 * Exit codes: 0 when the report was produced, 1 only on a real failure — unreadable file,
 * malformed entries, or a table column with no source at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareRevisions,
  formatReport,
  reconcile,
  tableColumns,
  validateSources,
} from "./lib/comparison-sources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

let sources;
try {
  sources = JSON.parse(read("docs/comparison-sources.json"));
} catch (err) {
  console.error(`table-sources: cannot read docs/comparison-sources.json — ${err.message}`);
  process.exit(1);
}

const problems = validateSources(sources);
if (problems.length) {
  console.error("table-sources: the sources file is malformed:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const { unsourced, orphaned } = reconcile(tableColumns(read("README.md")), sources);
if (unsourced.length) {
  console.error(
    `table-sources: these README columns have no recorded source: ${unsourced.join(", ")}.\n` +
      "             Add an entry to docs/comparison-sources.json naming what was read and at which revision.",
  );
  process.exit(1);
}
if (orphaned.length) {
  console.warn(`table-sources: sources listed for columns no longer in the table: ${orphaned.join(", ")}`);
}

/** Current HEAD per repo, or null when GitHub could not answer. Unauthenticated is fine here. */
async function head(repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
      headers: { accept: "application/vnd.github.sha", "user-agent": "mailwarden-table-sources" },
    });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

const repos = sources.columns.filter((e) => e.kind === "repo").map((e) => e.repo);
const heads = Object.fromEntries(
  await Promise.all(repos.map(async (r) => [r, await head(r)])),
);

const rows = compareRevisions(sources, heads);
console.log("table-sources: revisions behind the README comparison table\n");
console.log(formatReport(rows));

const moved = rows.filter((r) => r.state === "moved");
const unknown = rows.filter((r) => r.state === "unknown");
console.log("");
if (moved.length) {
  console.log(
    `${moved.length} column(s) changed upstream since we looked: ${moved.map((r) => r.column).join(", ")}.\n` +
      "Re-read those cells against the new revision, then update `sha`, `verified` and `note`\n" +
      "in docs/comparison-sources.json — and set shaBasis to \"recorded\", since you just read it.",
  );
} else {
  console.log("No repository moved since it was last checked.");
}
if (unknown.length) {
  console.log(
    `Could not reach GitHub for: ${unknown.map((r) => r.repo).join(", ")} — state unknown, not unchanged.`,
  );
}

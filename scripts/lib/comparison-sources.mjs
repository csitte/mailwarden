/**
 * Pure half of the comparison-table source check: which column of the README table was read
 * at which revision, and which of those revisions have moved on since.
 *
 * The existing `table-age` check knows *when* we last looked. That is the weaker question. A
 * table can be a week old and perfectly correct because nothing changed, or a day old and
 * already wrong because the other project shipped that morning — which is what happened with
 * `taylorwilsdon`'s least-privilege cell: it said "not offered", he had added tool tiers, and
 * the only reason anyone noticed was csitte.at reading his source before mirroring the row.
 *
 * So: record the foreign HEAD next to the claim, and let a command say which columns are worth
 * re-reading. Everything here is pure — the network lives in scripts/check-comparison-sources.mjs.
 */

/** Columns of the README table that are ours and therefore need no foreign source. */
export const OWN_COLUMNS = ["Capability", "mailwarden"];

const SHA_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The competitor column names from the README's comparison table header, in order.
 * Reads the first table row after the `comparison-table-verified` marker, so a table
 * elsewhere in the document cannot be picked up by mistake.
 */
export function tableColumns(readme) {
  const marker = readme.indexOf("<!-- comparison-table-verified:");
  const from = marker === -1 ? 0 : marker;
  const header = readme.slice(from).split("\n").find((l) => l.trim().startsWith("|"));
  if (!header) return [];
  return header
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim())
    // strip markdown emphasis and link syntax: `[taylorwilsdon](https://…)` -> `taylorwilsdon`
    .map((c) => c.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").replace(/\*\*/g, "").trim())
    .filter((c) => !OWN_COLUMNS.includes(c));
}

/**
 * Structural problems in the sources file, as plain sentences. Empty means well-formed.
 * This never looks at the network, so it can run in the normal test suite.
 */
export function validateSources(sources) {
  const problems = [];
  const entries = sources?.columns;
  if (!Array.isArray(entries)) return ["comparison-sources.json has no `columns` array."];

  const seen = new Set();
  for (const e of entries) {
    const where = e?.column ? `column "${e.column}"` : `entry ${entries.indexOf(e)}`;
    if (!e?.column) problems.push(`${where}: missing \`column\`.`);
    else if (seen.has(e.column)) problems.push(`${where}: listed twice.`);
    else seen.add(e.column);

    if (!DATE_RE.test(e?.verified ?? "")) problems.push(`${where}: \`verified\` must be YYYY-MM-DD.`);
    if (!e?.note || e.note.length < 40) problems.push(`${where}: \`note\` must say what was actually read.`);

    if (e?.kind === "repo") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(e?.repo ?? "")) problems.push(`${where}: \`repo\` must be "owner/name".`);
      if (!SHA_RE.test(e?.sha ?? "")) problems.push(`${where}: \`sha\` must be a full 40-character commit id.`);
      // An unrecorded SHA that claims to be recorded is the failure this file exists to prevent.
      if (!["recorded", "inferred"].includes(e?.shaBasis))
        problems.push(`${where}: \`shaBasis\` must be "recorded" or "inferred".`);
    } else if (e?.kind === "docs") {
      if (!/^https:\/\//.test(e?.url ?? "")) problems.push(`${where}: \`url\` must be an https link.`);
    } else {
      problems.push(`${where}: \`kind\` must be "repo" or "docs".`);
    }
  }
  return problems;
}

/** Column names in the table that the sources file does not account for, and vice versa. */
export function reconcile(readmeColumns, sources) {
  const listed = new Set((sources?.columns ?? []).map((e) => e.column));
  return {
    unsourced: readmeColumns.filter((c) => !listed.has(c)),
    orphaned: [...listed].filter((c) => !readmeColumns.includes(c)),
  };
}

/**
 * Compare recorded revisions against the heads just fetched.
 *
 * `heads` maps "owner/name" to the current HEAD sha, or to null when it could not be read.
 * A `docs` column has no revision to compare and comes back as `undated` — the age check is
 * the only handle there, which is stated rather than papered over.
 */
export function compareRevisions(sources, heads) {
  return (sources?.columns ?? []).map((e) => {
    if (e.kind !== "repo") return { column: e.column, state: "undated", verified: e.verified };
    const head = heads?.[e.repo];
    if (!head) return { column: e.column, state: "unknown", repo: e.repo, verified: e.verified };
    return {
      column: e.column,
      repo: e.repo,
      verified: e.verified,
      shaBasis: e.shaBasis,
      state: head === e.sha ? "unchanged" : "moved",
      recorded: e.sha,
      head,
    };
  });
}

/** Human-readable report. `moved` rows come first — they are the ones that cost something. */
export function formatReport(rows) {
  const order = { moved: 0, unknown: 1, undated: 2, unchanged: 3 };
  const label = {
    moved: "MOVED    ",
    unknown: "UNKNOWN  ",
    undated: "no repo  ",
    unchanged: "unchanged",
  };
  return [...rows]
    .sort((a, b) => order[a.state] - order[b.state] || a.column.localeCompare(b.column))
    .map((r) => {
      const head = r.state === "moved" ? `  ${r.recorded.slice(0, 8)} -> ${r.head.slice(0, 8)}` : "";
      const basis = r.shaBasis === "inferred" ? "  (sha inferred, not recorded)" : "";
      return `  ${label[r.state]}  ${r.column.padEnd(18)} checked ${r.verified}${head}${basis}`;
    })
    .join("\n");
}

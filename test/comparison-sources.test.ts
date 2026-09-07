import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — repo-only release helper, plain .mjs with no type declarations
import {
  compareRevisions,
  formatReport,
  markerBasis,
  reconcile,
  tableColumns,
  validateSources,
} from "../scripts/lib/comparison-sources.mjs";

/**
 * The comparison table makes claims about other people's software, and those go stale silently.
 * `table-age` answers "when did we last look"; this answers "has the other side moved since",
 * which is the question that decides whether a cell still holds.
 *
 * The structural part is a gate and lives here, because it needs no network: every column in the
 * README must have a recorded source, and every source must say what was read and at which
 * revision. The comparison against live HEADs is `npm run table-sources` — deliberately not a
 * gate, since an active project moves daily and a check that always fails is one nobody reads.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = () => readFileSync(path.join(ROOT, "README.md"), "utf8");
const sources = () => JSON.parse(readFileSync(path.join(ROOT, "docs/comparison-sources.json"), "utf8"));

describe("comparison-sources: reading the table header", () => {
  it("takes the competitor columns and drops our own", () => {
    const md = [
      "<!-- comparison-table-verified: 2026-08-26 -->",
      "| Capability | **mailwarden** | [Google official](https://x) | [taylorwilsdon](https://y) |",
      "|---|:--:|:--:|:--:|",
    ].join("\n");
    expect(tableColumns(md)).toEqual(["Google official", "taylorwilsdon"]);
  });

  it("starts at the marker, so an earlier table cannot be mistaken for it", () => {
    const md = [
      "| Tool | What it does |",
      "|---|---|",
      "| search | finds things |",
      "",
      "<!-- comparison-table-verified: 2026-08-26 -->",
      "| Capability | **mailwarden** | [klodr](https://z) |",
    ].join("\n");
    expect(tableColumns(md)).toEqual(["klodr"]);
  });
});

describe("comparison-sources: validation", () => {
  const good = {
    columns: [
      {
        column: "someone",
        kind: "repo",
        repo: "someone/server",
        sha: "0".repeat(40),
        shaBasis: "recorded",
        verified: "2026-08-26",
        note: "Read src/scopes.py and the README tier table, both at this revision.",
      },
    ],
  };

  it("accepts a well-formed entry", () => {
    expect(validateSources(good)).toEqual([]);
  });

  it("rejects a short or absent commit id — an abbreviated sha is ambiguous later", () => {
    const bad = { columns: [{ ...good.columns[0], sha: "0123abc" }] };
    expect(validateSources(bad).join(" ")).toMatch(/40-character/);
  });

  it("insists on shaBasis, so an unrecorded revision cannot pose as a recorded one", () => {
    const { shaBasis, ...withoutBasis } = good.columns[0];
    expect(validateSources({ columns: [withoutBasis] }).join(" ")).toMatch(/shaBasis/);
    expect(validateSources({ columns: [{ ...good.columns[0], shaBasis: "guessed" }] }).join(" ")).toMatch(
      /shaBasis/,
    );
  });

  it("insists on a note that says what was read", () => {
    expect(validateSources({ columns: [{ ...good.columns[0], note: "checked" }] }).join(" ")).toMatch(
      /what was actually read/,
    );
  });

  it("rejects a duplicated column", () => {
    expect(validateSources({ columns: [good.columns[0], good.columns[0]] }).join(" ")).toMatch(/twice/);
  });

  it("requires a url instead of a sha for a documentation-only source", () => {
    const docs = { columns: [{ column: "vendor", kind: "docs", verified: "2026-08-26", note: "Read the hosted tool reference page, ten tools, no send." }] };
    expect(validateSources(docs).join(" ")).toMatch(/https link/);
  });
});

describe("comparison-sources: comparing revisions", () => {
  const src = {
    columns: [
      { column: "still", kind: "repo", repo: "a/b", sha: "a".repeat(40), shaBasis: "recorded", verified: "2026-08-20", note: "x".repeat(50) },
      { column: "gone-ahead", kind: "repo", repo: "c/d", sha: "b".repeat(40), shaBasis: "inferred", verified: "2026-08-16", note: "x".repeat(50) },
      { column: "hosted", kind: "docs", url: "https://example.com", verified: "2026-08-26", note: "x".repeat(50) },
    ],
  };

  it("separates unchanged, moved and undated", () => {
    const rows = compareRevisions(src, { "a/b": "a".repeat(40), "c/d": "f".repeat(40) });
    expect(rows.find((r: any) => r.column === "still").state).toBe("unchanged");
    expect(rows.find((r: any) => r.column === "gone-ahead").state).toBe("moved");
    expect(rows.find((r: any) => r.column === "hosted").state).toBe("undated");
  });

  it("calls an unreachable repo unknown, never unchanged", () => {
    // Silence would otherwise read as "nothing changed", which is the failure mode of every
    // check that treats absence of news as good news.
    const rows = compareRevisions(src, { "a/b": null, "c/d": "b".repeat(40) });
    expect(rows.find((r: any) => r.column === "still").state).toBe("unknown");
  });

  it("puts moved rows first and flags an inferred sha in the report", () => {
    const rows = compareRevisions(src, { "a/b": "a".repeat(40), "c/d": "f".repeat(40) });
    const lines = formatReport(rows).split("\n");
    expect(lines[0]).toContain("MOVED");
    expect(lines[0]).toContain("gone-ahead");
    expect(lines[0]).toContain("sha inferred");
  });
});

describe("comparison-sources: which date the table may claim", () => {
  const dated = (...verified: string[]) => ({
    columns: verified.map((v, i) => ({ column: `c${i}`, kind: "docs", url: "https://x", verified: v, note: "x".repeat(50) })),
  });

  it("takes the oldest check, so one re-read column cannot front for the rest", () => {
    // The case that prompted the rule: three columns read on the 3rd, one pulled forward to the
    // 7th. Under the old rule the table would have claimed the 7th — and reset its own age budget.
    const basis = markerBasis(dated("2026-09-03", "2026-09-03", "2026-09-03", "2026-09-07"));
    expect(basis.marker).toBe("2026-09-03");
    expect(basis.newest).toBe("2026-09-07");
  });

  it("names every column sitting on that oldest date — those are the ones to re-read", () => {
    const src = dated("2026-09-03", "2026-09-07", "2026-09-03");
    expect(markerBasis(src).holdingBack).toEqual(["c0", "c2"]);
  });

  it("is the newest date too when every column was checked on the same day", () => {
    const basis = markerBasis(dated("2026-09-03", "2026-09-03"));
    expect(basis.marker).toBe("2026-09-03");
    expect(basis.newest).toBe("2026-09-03");
  });

  it("ignores a column whose date is unusable rather than sorting it as a string", () => {
    // validateSources already rejects such an entry; this one only guarantees that a malformed
    // date cannot become the marker on the way there.
    const src = dated("2026-09-03", "last Tuesday");
    expect(markerBasis(src).marker).toBe("2026-09-03");
  });

  it("returns null on an empty file instead of inventing a date", () => {
    expect(markerBasis({ columns: [] })).toBeNull();
    expect(markerBasis(undefined)).toBeNull();
  });
});

describe("comparison-sources: this repository", () => {
  it("has a well-formed sources file", () => {
    const problems = validateSources(sources());
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("has a recorded source for every competitor column in the README", () => {
    const { unsourced, orphaned } = reconcile(tableColumns(readme()), sources());
    expect(
      unsourced,
      unsourced.length === 0
        ? ""
        : `README comparison columns with no entry in docs/comparison-sources.json: ${unsourced.join(", ")}.\n` +
            "A column without a recorded source is a claim about someone else's software that nobody can check.",
    ).toEqual([]);
    expect(orphaned, `sources for columns no longer in the table: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("carries the date of its stalest column, not its freshest", () => {
    const marker = /<!-- comparison-table-verified: (\d{4}-\d{2}-\d{2}) -->/.exec(readme())?.[1];
    expect(marker).toBeTruthy();
    const basis = markerBasis(sources());
    expect(
      marker,
      `table marked ${marker}; oldest column check ${basis.marker} (${basis.holdingBack.join(", ")}), ` +
        `newest ${basis.newest}. The marker dates the table, and the table is as old as its ` +
        "stalest column — re-read the columns named above rather than moving the marker.",
    ).toBe(basis.marker);
  });
});

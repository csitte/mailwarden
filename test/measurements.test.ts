import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — repo-only helper, plain .mjs with no type declarations
import {
  CONTEXT_RE,
  figuresIn,
  knownFigures,
  knownPercentages,
  untracedFigures,
  validateMeasurements,
} from "../scripts/lib/measurements.mjs";

/**
 * The re-verification figures are the project's central evidence, and they appear in eight
 * places — README, SECURITY, the tool descriptions shipped in dist/, CLAUDE.md, the release
 * checks and two scripts. None of them said which measurement produced them, and two
 * measurements one night apart had merged: the README table said 131 threads for
 * `category:updates is:unread`, six other places said 132 for the same query, both dated 15.08.
 *
 * Both figures were correct. The labelling was not, and that is what cost time when csitte.at
 * asked which one held: the first source found produced the wrong answer ("ours is a typo"),
 * which would have replaced one correct figure with another correct figure from elsewhere.
 *
 * So every published figure has to come from a recorded measurement in docs/measurements.json.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const doc = () => JSON.parse(read("docs/measurements.json"));

/** Files that publish these figures. Prose only — CHANGELOG is append-only history. */
const PUBLISHING_FILES = [
  "README.md",
  "docs/gmail-thread-read-state-drift.md",
  "SECURITY.md",
  "CLAUDE.md",
  "docs/RELEASE-CHECKS.md",
  "src/gmail.ts",
  "src/tools.ts",
  "scripts/probe-reverify.mjs",
  "scripts/probe-crosscheck.mjs",
  "skills/triage/SKILL.md",
  "scripts/demo-reverify.mjs",
];

/**
 * Numbers that legitimately sit in drift prose without being measurement results:
 * the mailbox size, the 800+ control, and the batch cap quoted next to the caveat.
 */
const NOT_RESULTS = new Set([
  70000, // the mailbox size the measurement was taken in
  800, // the control query's result, quoted to show the predicate IS applied
  1000, // batchModify's per-request cap, named next to the caveat
  500, // the cap on thread-id lists in bulk_modify's result
  204, // the HTTP status batchModify answers with — the reason its count proves nothing
]);

const corpus = () => Object.fromEntries(PUBLISHING_FILES.map((f) => [f, read(f)]));

describe("measurements: the net", () => {
  it("reads a figure off a line about the drift", () => {
    const found = figuresIn("`category:updates is:unread` returned 132 threads, 114 of which held no unread message");
    expect(found.map((f: { value: number }) => f.value)).toEqual([132, 114]);
  });

  it("reads a whole markdown table row, where `|` separates instead of a counting noun", () => {
    // The README's main measurement table is such a row. An earlier version of the net skipped
    // these entirely and still passed, which made the green result evidence of nothing.
    const found = figuresIn("| `category:updates is:unread` | 131 | 17 | **87%** | stale |");
    expect(found.map((f: { value: number }) => f.value)).toEqual([131, 17, 87]);
  });

  it("does not read the day out of a spelled date", () => {
    expect(figuresIn("Snapshot as of 26 August 2026, one mailbox, stale read state")).toEqual([]);
  });

  it("ignores counts on lines that are not about the drift", () => {
    // "1000 messages per API request" is a limit, not a result — and says nothing about staleness.
    expect(figuresIn("Batched at 1000 messages per API request.")).toEqual([]);
    expect(CONTEXT_RE.test("Batched at 1000 messages per API request.")).toBe(false);
  });

  it("reads German prose too", () => {
    const found = figuresIn("132 Treffer, davon 114 ohne eine einzige ungelesene Nachricht");
    expect(found.map((f: { value: number }) => f.value)).toContain(132);
  });

  it("handles thousands separators", () => {
    expect(figuresIn("a stale index over 70,000 messages").map((f: { value: number }) => f.value)).toEqual([70000]);
  });
});

describe("measurements: the record", () => {
  it("accepts the repository's file", () => {
    const problems = validateMeasurements(doc());
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("insists every measurement names where it is recorded", () => {
    const bad = { measurements: { x: { what: "measured some things here", date: "2026-08-15", source: "somewhere", queries: [{ query: "q", hits: 1 }] } } };
    expect(validateMeasurements(bad).join(" ")).toMatch(/source/);
  });

  it("catches figures that do not add up", () => {
    const bad = {
      measurements: {
        x: {
          what: "a query measured against live labels",
          date: "2026-08-15",
          source: "session-bridge thread 999, message 2026-08-15T000000Z",
          queries: [{ query: "q", hits: 100, withUnread: 10, stale: 80 }],
        },
      },
    };
    expect(validateMeasurements(bad).join(" ")).toMatch(/does not add up/);
  });

  it("derives the percentages prose may quote", () => {
    // 114/131 = 87%, 114/132 = 86% — both are published, both must be derivable.
    const pct = knownPercentages(doc());
    expect(pct.has(87)).toBe(true);
    expect(pct.has(86)).toBe(true);
    expect(pct.has(58)).toBe(true);
  });

  it("knows both figures for the query measured twice", () => {
    const known = knownFigures(doc());
    expect(known.has(131)).toBe(true); // 2026-08-15, threads.list
    expect(known.has(132)).toBe(true); // the night after, across both endpoints
    expect(known.has(19)).toBe(true); // messages.list, same query, none stale
  });
});

describe("measurements: this repository", () => {
  it("publishes no figure that no measurement accounts for", () => {
    const untraced = untracedFigures(corpus(), doc(), NOT_RESULTS);
    const report = untraced
      .map((u: { file: string; line: number; value: number; text: string }) =>
        `\n  ${u.file}:${u.line}  [${u.value}]\n    ${u.text.slice(0, 180)}`,
      )
      .join("");
    expect(
      untraced,
      untraced.length === 0
        ? ""
        : "Figure(s) presented as measurements with no entry in docs/measurements.json:" +
            report +
            "\n\nEvery published figure needs a recorded measurement naming the mailbox, the date, the " +
            "endpoint and the bridge thread it came from. Two measurements a night apart have already " +
            "merged into one date once; that is what this prevents.",
    ).toEqual([]);
  });

  it("keeps the two threads.list measurements distinguishable in prose", () => {
    // The specific confusion: 131 and 132 for the same query. Wherever 132 appears, the text
    // must not also claim it was measured on 15.08. — that was the evening's figure, 131.
    for (const [file, text] of Object.entries(corpus())) {
      for (const line of (text as string).split("\n")) {
        if (!/\b132\b/.test(line)) continue;
        expect(
          /15\.08|15 August|2026-08-15/.test(line),
          `${file}: 132 is the figure re-measured the night after; this line dates it to the 15th:\n  ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

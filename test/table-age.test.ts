import { describe, it, expect } from "vitest";
// @ts-expect-error — repo-only release helper, plain .mjs with no type declarations
import {
  ageInDays,
  BUDGET_DAYS,
  parseIsoDate,
  parseProseDate,
  tableAgeState,
} from "../scripts/lib/table-age.mjs";

/**
 * The README comparison table is the one thing we ship that makes claims about other people's
 * software, and it goes wrong without anything breaking. `npm run smoke` therefore checks its age
 * against the shipped package; these are the rules behind that check, tested against a pinned clock
 * so they cannot pass by accident on a lucky day.
 *
 * Note what is deliberately NOT asserted anywhere here: that a cell is correct. This check knows
 * about time, not about competitors.
 */

const NOW = new Date("2026-08-17T09:00:00Z");

/** A README stripped to the two things this check reads, dated consistently. */
const readme = (opts: { marker?: string | null; prose?: string | null } = {}) => {
  const marker = opts.marker === undefined ? "2026-08-16" : opts.marker;
  const prose = opts.prose === undefined ? "16 August 2026" : opts.prose;
  return [
    "## Compared to other Gmail MCP servers",
    "",
    ...(marker ? [`<!-- comparison-table-verified: ${marker} -->`] : []),
    "",
    "| Capability | **mailwarden** |",
    "|---|:--:|",
    "| **Mailbox-side snooze** | ✅ |",
    "",
    ...(prose ? [`<sub>Snapshot as of ${prose}, from each project's public docs and source.</sub>`] : []),
  ].join("\n");
};

describe("table-age: date parsing", () => {
  it("reads a plain ISO date", () => {
    expect(parseIsoDate("2026", "08", "16")).toBe(Date.UTC(2026, 7, 16));
  });

  it("rejects a day the month does not have — Date would roll it into the next month", () => {
    expect(parseIsoDate("2026", "04", "31")).toBeNull();
    expect(parseIsoDate("2026", "02", "30")).toBeNull();
  });

  it("takes the leap day in a leap year and refuses it otherwise", () => {
    expect(parseIsoDate("2028", "02", "29")).toBe(Date.UTC(2028, 1, 29));
    expect(parseIsoDate("2026", "02", "29")).toBeNull();
  });

  it("rejects month and day outside their range", () => {
    expect(parseIsoDate("2026", "13", "01")).toBeNull();
    expect(parseIsoDate("2026", "00", "10")).toBeNull();
    expect(parseIsoDate("2026", "08", "00")).toBeNull();
  });

  it("reads the reader-facing sentence, month spelled out, either case", () => {
    expect(parseProseDate("16", "August", "2026")).toBe(Date.UTC(2026, 7, 16));
    expect(parseProseDate("1", "january", "2027")).toBe(Date.UTC(2027, 0, 1));
  });

  it("refuses a month that is not one — an abbreviation is a typo here, not a dialect", () => {
    expect(parseProseDate("16", "Aug", "2026")).toBeNull();
    expect(parseProseDate("16", "Augus", "2026")).toBeNull();
  });

  it("counts whole days and does not round a few hours up", () => {
    const day = Date.UTC(2026, 7, 16);
    expect(ageInDays(day, Date.UTC(2026, 7, 16) + 23 * 3_600_000)).toBe(0);
    expect(ageInDays(day, Date.UTC(2026, 7, 17))).toBe(1);
  });
});

describe("table-age: a fresh table", () => {
  it("passes and says how old it is", () => {
    const state = tableAgeState(readme(), NOW);
    expect(state.state).toBe("ok");
    expect(state.ageDays).toBe(1);
    expect(state.declared).toBe("2026-08-16");
  });

  it("still passes on the last day of the budget, and fails the day after", () => {
    const dated = readme({ marker: "2026-06-18", prose: "18 June 2026" });
    // 2026-06-18 → 2026-08-17 is exactly 60 days.
    expect(tableAgeState(dated, NOW).state).toBe("ok");
    expect(tableAgeState(dated, new Date("2026-08-18T09:00:00Z")).state).toBe("stale");
  });

  it("uses the documented budget by default", () => {
    expect(BUDGET_DAYS).toBe(60);
  });
});

describe("table-age: the ways it must not quietly pass", () => {
  /**
   * The failure this check dies of is silence. Every one of these has to produce a finding — the
   * cheapest way to lose the whole thing is a reworded footnote that takes the date with it.
   */
  it("fails when the marker is gone rather than finding nothing to complain about", () => {
    const state = tableAgeState(readme({ marker: null }), NOW);
    expect(state.state).toBe("missing-marker");
  });

  it("fails when the reader-facing sentence is gone, even though the marker is fine", () => {
    const state = tableAgeState(readme({ prose: null }), NOW);
    expect(state.state).toBe("missing-prose");
  });

  it("fails when the marker was bumped and the sentence was not — readers would be told the old date", () => {
    const state = tableAgeState(readme({ marker: "2026-08-16", prose: "9 August 2026" }), NOW);
    expect(state.state).toBe("mismatch");
    expect(state.detail).toContain("9 August 2026");
  });

  it("fails on a marker that looks like a date but is not one", () => {
    expect(tableAgeState(readme({ marker: "2026-02-30", prose: "30 February 2026" }), NOW).state).toBe(
      "unparsable",
    );
  });

  it("fails on a date in the future instead of reading it as very fresh", () => {
    const state = tableAgeState(readme({ marker: "2026-09-16", prose: "16 September 2026" }), NOW);
    expect(state.state).toBe("future");
    expect(state.ageDays).toBeLessThan(0);
  });

  it("fails on an empty README rather than treating 'nothing to check' as a pass", () => {
    expect(tableAgeState("", NOW).state).toBe("missing-marker");
    expect(tableAgeState(undefined, NOW).state).toBe("missing-marker");
  });
});

describe("table-age: against the README we actually ship", () => {
  it("finds both dates in the real file and they agree", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const state = tableAgeState(text, NOW);
    // Pinned clock on purpose: this asserts the file is well-formed, not that it is fresh today —
    // the freshness verdict belongs to `npm run smoke`, which runs against the real date.
    expect(state.state).toBe("ok");
    expect(state.declared).not.toBeNull();
  });
});

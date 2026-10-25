import { describe, it, expect } from "vitest";
import { compareFilters, criteriaKey } from "../src/filter-preview.js";
import type { FilterCriteria, FilterSummary } from "../src/gmail.js";

const f = (id: string, criteria: FilterCriteria): FilterSummary => ({ id, criteria, addLabelIds: [], removeLabelIds: ["INBOX"] });

describe("criteriaKey — one key per set of criteria", () => {
  it.each<[string, FilterCriteria, FilterCriteria, boolean]>([
    ["from case and outer space", { from: " News@X.com " }, { from: "news@x.com" }, true],
    ["subject case", { subject: "Weekly" }, { subject: "weekly" }, true],
    ["absent vs empty string", { from: "a@x.com", to: "" }, { from: "a@x.com" }, true],
    ["query compared exactly (search syntax is not case-folded)", { query: "label:Work" }, { query: "label:work" }, false],
    ["query outer space only", { query: " is:starred " }, { query: "is:starred" }, true],
    ["extra criterion", { from: "a@x.com" }, { from: "a@x.com", hasAttachment: true }, false],
    ["hasAttachment false vs absent", { from: "a@x.com", hasAttachment: false }, { from: "a@x.com" }, false],
    ["excludeChats false vs absent", { from: "a@x.com", excludeChats: false }, { from: "a@x.com" }, true],
    ["size without comparison is no size", { from: "a@x.com", size: 5 }, { from: "a@x.com" }, true],
    ["larger vs smaller", { size: 5, sizeComparison: "larger" }, { size: 5, sizeComparison: "smaller" }, false],
  ])("%s", (_n, a, b, same) => expect(criteriaKey(a) === criteriaKey(b)).toBe(same));
});

describe("compareFilters", () => {
  const existing = [
    f("same", { from: "NEWS@x.com" }),
    f("from+subject", { from: "news@x.com", subject: "weekly" }),
    f("query", { query: "list:dev.x.com" }),
    f("other", { from: "boss@x.com" }),
    f("negated", { from: "other@x.com", negatedQuery: "is:starred" }),
  ];

  it("separates the exact duplicate from filters sharing a value", () => {
    const r = compareFilters({ from: "news@x.com" }, existing);
    expect(r.sameCriteria.map((x) => x.filter.id)).toEqual(["same"]);
    expect(r.overlapping.map((x) => [x.filter.id, x.shared])).toEqual([["from+subject", ["from"]]]);
  });

  it("names every shared field", () => {
    const r = compareFilters({ from: "news@x.com", subject: "Weekly", query: "has:attachment" }, existing);
    expect(r.overlapping.find((x) => x.filter.id === "from+subject")?.shared).toEqual(["from", "subject"]);
  });

  it("treats a shared query as an overlap only when it is the same query", () => {
    expect(compareFilters({ query: "list:dev.x.com" }, existing).sameCriteria.map((x) => x.filter.id)).toEqual(["query"]);
    expect(compareFilters({ query: "list:dev.x.com", subject: "x" }, existing).overlapping.map((x) => x.filter.id)).toEqual(["query"]);
    expect(compareFilters({ query: "list:other.x.com" }, existing).overlapping).toEqual([]);
  });

  it("does not count a shared negatedQuery — it only narrows", () => {
    const r = compareFilters({ from: "x@y.com", negatedQuery: "is:starred" }, existing);
    expect(r.overlapping).toEqual([]);
  });

  it("finds nothing among unrelated filters, and nothing in an empty list", () => {
    expect(compareFilters({ to: "me@y.com" }, existing)).toEqual({ sameCriteria: [], overlapping: [] });
    expect(compareFilters({ from: "a@x.com" }, [])).toEqual({ sameCriteria: [], overlapping: [] });
  });
});

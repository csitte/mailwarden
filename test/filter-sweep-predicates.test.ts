import { describe, it, expect } from "vitest";
import { filterCriteriaToQuery, unverifiedPredicates, deriveLabelFilters } from "../src/gmail.js";

/**
 * Why `create_filter`'s applyToExisting sweep reports no `unverifiedPredicates`.
 *
 * `bulk_modify` takes the caller's query verbatim and can name the predicates it took on the
 * index's word. The sweep cannot: its query is BUILT by `filterCriteriaToQuery`, and everything
 * that function emits trips one of `deriveLabelFilters`' bail-outs — a `query` criterion is
 * parenthesised, and every from/to/subject value is double-quoted, while the derive bails on
 * `["(){}]` as a whole. The field would therefore be `[]` for every input the tool accepts, and
 * `[]` reads as "nothing to distrust" rather than "could not tell".
 *
 * That reasoning is only sound while the two functions stay in this relationship, which is what
 * these tests hold. If one of them changes so that a built query does yield predicates, the honest
 * move is to report the field — not to delete this file.
 *
 * The parenthesis half was in the code comment from the start; the quoting half — the wider one,
 * since it covers the criteria a caller is most likely to use — came from csitte.at reading the
 * comment against the function on 17 September 2026.
 */
describe("filter sweep: built queries never yield unverified predicates", () => {
  // Each entry is a set of criteria create_filter accepts, paired with the query it builds.
  const cases: Array<{ name: string; criteria: Parameters<typeof filterCriteriaToQuery>[0] }> = [
    { name: "sender only", criteria: { from: "news@example.com" } },
    { name: "subject only", criteria: { subject: "Rechnung" } },
    { name: "recipient only", criteria: { to: "team@example.com" } },
    { name: "raw query criterion", criteria: { query: "category:updates is:unread" } },
    { name: "sender plus query", criteria: { from: "n@e.com", query: "is:unread" } },
    { name: "query carrying only read-state", criteria: { query: "is:unread" } },
    { name: "subject with an umlaut", criteria: { subject: "Grüße für März" } },
  ];

  for (const { name, criteria } of cases) {
    it(`${name} → no predicates`, () => {
      const query = filterCriteriaToQuery(criteria);
      expect(query).not.toBe("");
      expect(unverifiedPredicates(query)).toEqual([]);
    });
  }

  it("the same predicates DO derive from a hand-written query — so the emptiness is the wrapping, not a broken derive", () => {
    // The control: without filterCriteriaToQuery's quoting and parenthesising, this query is
    // exactly the case bulk_modify reports. An always-empty result here would make the tests
    // above prove nothing.
    expect(unverifiedPredicates("category:updates is:unread")).toEqual([
      "+CATEGORY_UPDATES",
      "+UNREAD",
    ]);
  });

  it("deriveLabelFilters bails on a double quote, not only on grouping", () => {
    // The specific half the comment used to miss: quoting alone is enough.
    expect(deriveLabelFilters('is:unread from:"n@e.com"')).toEqual([]);
    expect(deriveLabelFilters("is:unread from:n@e.com")).toEqual([
      { labelId: "UNREAD", present: true },
    ]);
  });
});

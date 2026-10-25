import type { FilterCriteria, FilterSummary } from "./gmail.js";

/**
 * How a filter that is about to be created relates to the filters already there — pure, so a
 * corpus of criteria can hold it.
 *
 * Two answers, both deliberately literal. `sameCriteria`: an existing filter matches exactly the
 * same mail, so a second one is at best redundant and at worst a conflicting action on every
 * arrival. `overlapping`: an existing filter shares at least one criterion value (`from`, `to`,
 * `subject`, `query`) with the new one, so some mail will be handled by both — the list names the
 * shared fields. Neither tries to decide whether two Gmail searches intersect in general: that is
 * the search engine's question, and a guess at it would be wrong in both directions.
 */

/** The text criteria compared field by field. `query`/`negatedQuery` are search syntax: compared exactly. */
const TEXT_FIELDS = ["from", "to", "subject"] as const;

type SharedField = (typeof TEXT_FIELDS)[number] | "query";

export interface FilterRelation {
  filter: FilterSummary;
  /** Fields whose value both filters carry, for `overlapping`; empty for `sameCriteria`. */
  shared: SharedField[];
}

export interface FilterComparison {
  sameCriteria: FilterRelation[];
  overlapping: FilterRelation[];
}

/** `from`/`to`/`subject` as Gmail treats them: case-insensitive, outer whitespace ignored. */
function text(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

function query(v: string | undefined): string {
  return (v ?? "").trim();
}

/** One canonical form per set of criteria; `undefined`, `""` and absent all mean "not set". */
export function criteriaKey(c: FilterCriteria): string {
  return JSON.stringify({
    from: text(c.from),
    to: text(c.to),
    subject: text(c.subject),
    query: query(c.query),
    negatedQuery: query(c.negatedQuery),
    hasAttachment: c.hasAttachment ?? null,
    excludeChats: c.excludeChats === true,
    size: c.size != null && c.sizeComparison ? `${c.sizeComparison}:${c.size}` : null,
  });
}

export function compareFilters(candidate: FilterCriteria, existing: FilterSummary[]): FilterComparison {
  const key = criteriaKey(candidate);
  const sameCriteria: FilterRelation[] = [];
  const overlapping: FilterRelation[] = [];
  for (const f of existing) {
    if (criteriaKey(f.criteria) === key) {
      sameCriteria.push({ filter: f, shared: [] });
      continue;
    }
    const shared: SharedField[] = [];
    for (const k of TEXT_FIELDS) {
      const v = text(candidate[k]);
      if (v !== "" && v === text(f.criteria[k])) shared.push(k);
    }
    // A query is shared only when it is the same query; negatedQuery only narrows and is no overlap.
    const q = query(candidate.query);
    if (q !== "" && q === query(f.criteria.query)) shared.push("query");
    if (shared.length > 0) overlapping.push({ filter: f, shared });
  }
  return { sameCriteria, overlapping };
}

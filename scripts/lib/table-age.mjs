/**
 * Pure logic behind the comparison-table freshness check in `npm run smoke`.
 *
 * Why this exists: the README's "Compared to other Gmail MCP servers" table is a set of claims about
 * OTHER people's software, and it ages differently from everything else we ship. Code breaks loudly
 * when its assumption stops holding; a table cell just sits there. When the table was re-collected on
 * 16.08.2026, two cells still said `—` that no longer deserved it — `taylorwilsdon` and `klodr` had
 * both shipped batch label changes, and `taylorwilsdon` had started surfacing `List-Unsubscribe`.
 * Both errors were in our own favour, which is the direction an unverified comparison cell always
 * drifts. Nothing in the repo noticed, because nothing in the repo looks.
 *
 * What this check can and cannot do — the distinction matters, because overselling it would be worse
 * than not having it. It CANNOT tell you a cell is wrong; only a re-check against each project's
 * source can, and that is human work. It tells you that **nobody has looked in a long time**, which
 * is a finding in its own right and the only part of the problem a script can decide. So a green run
 * here means "recently verified", never "correct".
 *
 * The date is DECLARED by the document about itself, in an HTML comment, rather than scraped out of
 * the prose. That is the lesson from the `site-notice` false alarm, where a pattern search found a
 * version number that a sentence had quoted as an example and waved through the step it existed to
 * enforce: a marker a document sets about itself is a different thing from a pattern someone hunts
 * for in the text. But the sentence under the table is what a *reader* actually sees, so both must be
 * present and agree — a bumped marker above a stale sentence would satisfy this tool while telling
 * every reader something false.
 *
 * No IO here: the caller hands in the README text and the current date, so the rules are testable
 * without a clock or a package.
 */

/** The marker the README sets about itself, directly above the table. */
export const MARKER = /<!--\s*comparison-table-verified:\s*(\d{4})-(\d{2})-(\d{2})\s*-->/;

/** The human sentence under the table: "Snapshot as of 16 August 2026". */
export const PROSE = /Snapshot as of (\d{1,2}) ([A-Za-z]+) (\d{4})/;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * How long a snapshot may stand before the check calls it stale.
 *
 * 60 days is a deliberate compromise, and it is worth naming both edges. Tighter would be truer to
 * how fast this market actually moves — the two stale cells above went wrong within about a week —
 * but a full re-check means reading five projects' sources, and a gate that fires on every release
 * is a gate people learn to bump without looking, which is worse than no gate. Looser and it stops
 * catching the case it is really for: a table nobody has touched across many releases, quietly
 * claiming a lead we may no longer have. So this catches abandonment, not drift. Drift is what the
 * re-check itself is for.
 */
export const BUDGET_DAYS = 60;

/** UTC midnight, so the age is a whole number of days regardless of the runner's timezone. */
function utcDay(year, month, day) {
  return Date.UTC(year, month - 1, day);
}

/** @returns {number|null} UTC-midnight timestamp, or null if the parts do not form a real date. */
export function parseIsoDate(year, month, day) {
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = utcDay(y, m, d);
  // Rejects 31 April and friends: the Date would silently roll into the next month.
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}

/** @returns {number|null} UTC-midnight timestamp for "16 August 2026", or null if the month is not one. */
export function parseProseDate(day, monthName, year) {
  const month = MONTHS.indexOf(String(monthName).toLowerCase()) + 1;
  if (month === 0) return null;
  return parseIsoDate(year, month, day);
}

/** Whole days between two UTC-midnight timestamps. Negative if the snapshot is dated in the future. */
export function ageInDays(snapshot, now) {
  return Math.floor((now - snapshot) / 86_400_000);
}

/**
 * @param {string} readme - the shipped README text.
 * @param {Date} now - the moment to measure against (the caller's clock, so tests can pin it).
 * @param {{budgetDays?: number}} [options]
 * @returns {{state: "ok"|"missing-marker"|"missing-prose"|"mismatch"|"unparsable"|"future"|"stale",
 *            declared: string|null, prose: string|null, ageDays: number|null, budgetDays: number,
 *            detail: string}}
 *
 * Every failure mode reports rather than shrugs. A missing marker is NOT a pass: the way this check
 * dies quietly is someone rewording the footnote, dropping the date with it, and the tool finding
 * nothing to complain about. A false "stale" costs a second look; a false "ok" costs the check.
 */
export function tableAgeState(readme, now, { budgetDays = BUDGET_DAYS } = {}) {
  const base = { declared: null, prose: null, ageDays: null, budgetDays };

  const marker = MARKER.exec(readme ?? "");
  if (!marker) {
    return {
      ...base,
      state: "missing-marker",
      detail: "no <!-- comparison-table-verified: YYYY-MM-DD --> marker in README",
    };
  }
  const declared = `${marker[1]}-${marker[2]}-${marker[3]}`;
  const declaredAt = parseIsoDate(marker[1], marker[2], marker[3]);
  if (declaredAt === null) {
    return { ...base, declared, state: "unparsable", detail: `marker is not a real date: ${declared}` };
  }

  const prose = PROSE.exec(readme ?? "");
  if (!prose) {
    return {
      ...base,
      declared,
      state: "missing-prose",
      detail: 'the table lost its "Snapshot as of <date>" sentence — readers see no date at all',
    };
  }
  const proseAt = parseProseDate(prose[1], prose[2], prose[3]);
  const proseText = `${prose[1]} ${prose[2]} ${prose[3]}`;
  if (proseAt === null) {
    return {
      ...base,
      declared,
      prose: proseText,
      state: "unparsable",
      detail: `the snapshot sentence is not a real date: ${proseText}`,
    };
  }
  if (proseAt !== declaredAt) {
    return {
      ...base,
      declared,
      prose: proseText,
      state: "mismatch",
      detail: `marker says ${declared}, the sentence readers see says ${proseText}`,
    };
  }

  const ageDays = ageInDays(declaredAt, now.getTime());
  if (ageDays < 0) {
    return {
      ...base,
      declared,
      prose: proseText,
      ageDays,
      state: "future",
      detail: `dated ${-ageDays} day(s) in the future — a typo, or a snapshot that was never taken`,
    };
  }
  if (ageDays > budgetDays) {
    return {
      ...base,
      declared,
      prose: proseText,
      ageDays,
      state: "stale",
      detail:
        `last verified ${ageDays} days ago (budget ${budgetDays}). Re-check each column against ` +
        `that project's own source, correct the cells, then move both the marker and the sentence.`,
    };
  }
  return {
    ...base,
    declared,
    prose: proseText,
    ageDays,
    state: "ok",
    detail: `verified ${ageDays} day(s) ago`,
  };
}

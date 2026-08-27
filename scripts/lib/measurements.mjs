/**
 * Keeps the published re-verification figures tied to the measurement they came from.
 *
 * These numbers live in eight places — README, SECURITY, the tool descriptions that ship inside
 * dist/, CLAUDE.md, docs/RELEASE-CHECKS.md and two scripts. Nothing next to any of them said
 * which measurement produced them, and two measurements a night apart had quietly merged: the
 * README table said 131 threads for `category:updates is:unread`, six other places said 132 for
 * the same query, and both were dated 15.08. Both figures were right; the labelling was not.
 *
 * The failure that costs something is not a wrong number, it is an untraceable one. When
 * csitte.at asked which figure held, the first answer drawn from the first source found was
 * "ours is a typo" — wrong, and it would have replaced a correct figure with another correct
 * figure measured elsewhere.
 *
 * Hence: `docs/measurements.json` defines each measurement once, and this module checks that
 * every measurement-shaped figure in the prose is one of them. Same shape as the send-claims
 * guard: a net plus a list, where the list is the evidence rather than an exemption.
 */

/**
 * A figure counts as a measurement result when a result marker sits right next to it — a
 * counting noun after it ("132 threads"), a relative clause ("114 of which"), or a reporting
 * verb before it ("returned 19"). German equivalents included.
 *
 * Two earlier versions of this were wrong in opposite directions, and both failures are worth
 * keeping in mind. Requiring a counting noun *after* the number walked past "132 threads, 114
 * of which held no unread message" — it caught the 132 and missed the 114, so the suite went
 * green while seeing half the corpus. Taking every number on a drift line instead dragged in
 * section numbers, snooze hours, HTTP statuses and the day out of "26 August". A net whose
 * exception list has to absorb that is a net that will be switched off.
 */
const DATE_LIKE =
  /\b(?:\d{1,2}\.\d{1,2}\.(?:\d{2,4})?|\d{4}-\d{2}-\d{2}|\d+\.\d+\.\d+|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December))\b/g;

/** Reporting verb immediately before the number. */
const BEFORE = "(?:returned|returns|reported|showed|answered|found|of|against|lieferte|zeigte|ergab|davon)\\s+";
/** Counting noun or relative clause immediately after it. */
const AFTER =
  "(?:\\s*(?:threads?|hits?|messages|Treffer|Threads?|Nachrichten|of which|for|ohne|mit)\\b|\\s*/)";

const NUMBER_RE = /\b(\d[\d,]*)\b/g;

const FIGURE_RE = new RegExp("(?:" + BEFORE + ")?\\b(\\d[\\d,]*)\\b(?=" + AFTER + ")", "g");

/** Words that mark the surrounding prose as being about the index drift at all. */
export const CONTEXT_RE =
  /stale|veraltet|unread|ungelesen|re-?verif|drift|threads\.list|messages\.list|Rohindex|raw index/i;

/** Normalise "1,234" / "1.234" to a number. */
function toNumber(raw) {
  return Number(raw.replace(/[,.](?=\d{3}\b)/g, ""));
}

/**
 * Every measurement-shaped figure in a text, with the line it sits on.
 * Only lines that also carry drift vocabulary are considered, so unrelated counts are ignored.
 */
export function figuresIn(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (!CONTEXT_RE.test(line)) return;
    // Blank out dates and versions first, so their digits cannot be read as counts.
    const scrubbed = line.replace(DATE_LIKE, (m) => " ".repeat(m.length));
    // A markdown table row about the drift is the densest place figures appear — the README's
    // main measurement table is one — and there the separator is `|`, not a counting noun. Take
    // every number in such a row. Without this the corpus check passed while never looking at
    // the table that carries the headline figures, which is the same green-for-nothing failure
    // as reading only half a sentence.
    const cells = /^\s*\|/.test(line);
    const matches = cells ? scrubbed.matchAll(NUMBER_RE) : scrubbed.matchAll(FIGURE_RE);
    for (const m of matches) {
      const value = toNumber(m[1]);
      if (value >= 1900 && value <= 2100) continue; // a year that survived scrubbing
      out.push({ line: i + 1, value, text: line.trim() });
    }
  });
  return out;
}

/** Every number any recorded measurement contains — the set a published figure must come from. */
export function knownFigures(doc) {
  const known = new Set();
  for (const m of Object.values(doc?.measurements ?? {})) {
    for (const q of m.queries ?? []) {
      for (const key of ["hits", "withUnread", "stale"]) {
        if (typeof q[key] === "number") known.add(q[key]);
      }
    }
  }
  return known;
}

/**
 * Percentages a reader could compute from the recorded figures, rounded the way prose does.
 * Kept separate from `knownFigures` because a share is derived, not measured.
 */
export function knownPercentages(doc) {
  const pct = new Set();
  for (const m of Object.values(doc?.measurements ?? {})) {
    for (const q of m.queries ?? []) {
      if (typeof q.hits !== "number" || !q.hits) continue;
      for (const key of ["stale", "withUnread"]) {
        if (typeof q[key] !== "number") continue;
        pct.add(Math.round((q[key] / q.hits) * 100));
      }
    }
  }
  return pct;
}

/**
 * Figures in `files` (`{path: text}`) that no recorded measurement accounts for.
 * `allow` holds numbers that legitimately appear in drift prose without being results —
 * mailbox sizes, caps, the 800+ control.
 */
export function untracedFigures(files, doc, allow = new Set()) {
  const known = knownFigures(doc);
  const pct = knownPercentages(doc);
  const out = [];
  for (const [file, text] of Object.entries(files)) {
    for (const f of figuresIn(text)) {
      if (known.has(f.value) || pct.has(f.value) || allow.has(f.value)) continue;
      out.push({ file, ...f });
    }
  }
  return out;
}

/** Structural problems in the measurements file. Empty means well-formed. */
export function validateMeasurements(doc) {
  const problems = [];
  const entries = Object.entries(doc?.measurements ?? {});
  if (!entries.length) return ["measurements.json has no `measurements`."];
  for (const [id, m] of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m?.date ?? "")) problems.push(`${id}: \`date\` must be YYYY-MM-DD.`);
    // The source is the whole point: a figure with no traceable origin is what this prevents.
    if (!m?.source || m.source.length < 30) problems.push(`${id}: \`source\` must name where the measurement is recorded.`);
    if (!m?.what || m.what.length < 20) problems.push(`${id}: \`what\` must say what was measured.`);
    if (!Array.isArray(m?.queries) || !m.queries.length) problems.push(`${id}: needs at least one query.`);
    for (const q of m?.queries ?? []) {
      if (!q?.query) problems.push(`${id}: a query entry has no \`query\`.`);
      if (typeof q?.hits !== "number") problems.push(`${id}: "${q?.query}" has no numeric \`hits\`.`);
      if (typeof q?.stale === "number" && typeof q?.hits === "number" && q.stale > q.hits)
        problems.push(`${id}: "${q.query}" reports more stale than hits.`);
      if (
        typeof q?.withUnread === "number" &&
        typeof q?.stale === "number" &&
        typeof q?.hits === "number" &&
        q.withUnread + q.stale !== q.hits
      )
        problems.push(`${id}: "${q.query}" does not add up: ${q.withUnread} + ${q.stale} ≠ ${q.hits}.`);
    }
  }
  return problems;
}

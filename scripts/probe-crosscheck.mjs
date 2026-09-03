#!/usr/bin/env node
/**
 * Do Gmail's two routes into its own index ever disagree?
 *
 * `bulk_modify --crossCheck` rests on a premise nobody has measured: that asking for
 * `q: "… is:unread"` and asking for `labelIds: ["UNREAD"]` can return different sets. If they
 * always agree, the cross-check is a cheap no-op — harmless, and worth knowing before anyone
 * relies on it. If they diverge, it catches false positives on the bulk path for one extra list
 * call per predicate, where `search`-style re-verification would cost one fetch per hit.
 *
 * This is the counterpart to `probe-reverify.mjs`, and the difference matters. That one compares
 * the index against the MAILBOX (fetching each thread's live labels) and answers whether the index
 * is stale. This one compares the index against ITSELF through a second door and answers whether
 * the two doors ever differ. A disagreement here is evidence; agreement is not — both routes read
 * the same index, and an index can be consistently wrong. Neither script can be substituted for
 * the other.
 *
 * Method, per query:
 *   1. `messages.list(q)` → the match set, exactly as `bulk_modify` resolves it.
 *   2. For each predicate mailwarden derives from that query, `messages.list(q, labelIds:[LABEL])`
 *      → the same question through the structured filter.
 *   3. Report the messages the two answers disagree about, per predicate.
 *
 * The label list is always a subset of the match set (same query, plus a label), so the comparison
 * is only sound while the match set came back short of `--max`. A capped run says so and checks
 * nothing, for the same reason the shipped code refuses that case: a message missing from a page
 * is not a message missing the label.
 *
 * STRICTLY READ-ONLY. `messages.list` returns ids and thread ids and nothing else — no subject,
 * sender, label name or body is fetched, and nothing is modified or contacted. Output is counts.
 *
 *   node scripts/probe-crosscheck.mjs [--account NAME] [--max N] [query ...]
 *
 * Needs a built tree (`npm run build`) and an authorized token (`mailwarden --auth`).
 */
import { google } from "googleapis";
import { getAuth } from "../dist/auth.js";
import { deriveLabelFilters } from "../dist/gmail.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const account = flag("--account");
const max = Number(flag("--max") ?? 500);

if (!Number.isInteger(max) || max < 1 || max > 2000) {
  console.error("--max must be an integer between 1 and 2000.");
  process.exit(2);
}
if (account) process.env.MAILWARDEN_ACCOUNT = account;

// The same matrix probe-reverify.mjs uses, so a divergence found here can be held against the
// staleness measured there for the same query in the same mailbox.
const QUERIES = argv.length
  ? argv
  : [
      "category:updates is:unread -in:inbox",
      "category:updates is:unread",
      "is:unread -in:inbox",
      "category:promotions is:unread -in:inbox",
    ];

const auth = await getAuth(false);
const api = google.gmail({ version: "v1", auth });

const profile = await api.users.getProfile({ userId: "me" });
console.log(`Mailbox: ${profile.data.emailAddress}`);
console.log(`Scan:    up to ${max} messages per query, ids only\n`);

/** Message ids for a query, optionally narrowed by a label filter, paginated up to `max`. */
async function ids(q, labelIds) {
  const out = [];
  let pageToken;
  do {
    const res = await api.users.messages.list({
      userId: "me",
      q,
      ...(labelIds ? { labelIds } : {}),
      maxResults: Math.min(500, max - out.length),
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.data.messages ?? []).map((m) => m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < max);
  return out;
}

let anyDivergence = false;
let capped = 0;

for (const q of QUERIES) {
  const filters = deriveLabelFilters(q);
  const byQuery = await ids(q);
  const predicates = filters.map((f) => `${f.present ? "+" : "-"}${f.labelId}`);

  console.log(`Query: ${q}`);
  console.log(`  predicates:      ${predicates.join(" ") || "(none)"}`);
  console.log(`  query route:     ${byQuery.length} messages`);

  if (filters.length === 0) {
    console.log("  nothing to cross-check.\n");
    continue;
  }
  if (byQuery.length >= max) {
    capped++;
    console.log(`  CAPPED at --max ${max}: not cross-checked (a missing page is not a missing`);
    console.log("  label). Re-run with a higher --max, or a narrower query.\n");
    continue;
  }

  const inQuery = new Set(byQuery);
  for (const [i, f] of filters.entries()) {
    const withLabel = new Set(await ids(q, [f.labelId]));
    // Both directions are reported. Query-only is what the shipped cross-check drops; label-only
    // would mean the label route sees a message the query route did not, which the subset
    // argument says cannot happen — printing it is how we would find out that it can.
    const queryOnly = byQuery.filter((id) => withLabel.has(id) === !f.present);
    const labelOnly = [...withLabel].filter((id) => !inQuery.has(id));
    if (queryOnly.length || labelOnly.length) anyDivergence = true;
    console.log(
      `  ${predicates[i]}: label route ${withLabel.size}, disagreed on ${queryOnly.length}` +
        (labelOnly.length ? `, label-only ${labelOnly.length} (UNEXPECTED)` : ""),
    );
  }
  console.log();
}

if (capped) {
  console.log(`${capped} quer${capped === 1 ? "y was" : "ies were"} capped and not checked.`);
}
console.log(
  anyDivergence
    ? "The two routes DISAGREE here — crossCheck:true has something to catch in this mailbox."
    : "No divergence in this sample. Report the sample, not a claim: this is one mailbox on one\n" +
        "day, and agreement between two routes into the same index was never proof of anything.",
);

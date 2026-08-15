#!/usr/bin/env node
/**
 * Hold the re-verification claim against a real mailbox.
 *
 * `scripts/demo-reverify.mjs` proves the *behaviour* — that `search()` drops a hit whose live
 * labels contradict the query — against a fake API whose index we deliberately made loose. That
 * demo cannot prove the premise it rests on: that Gmail's real index is loose in the first place.
 * This script measures exactly that, and only that.
 *
 * It asks Gmail's `threads.list` for a query, then fetches each hit's live labels and checks them
 * against the predicates mailwarden derives from the same query (the shipped pure functions —
 * `deriveLabelFilters` / `threadMatchesFilters`, not a copy). Every hit that fails is a thread the
 * index returned and the query excludes: an index false positive.
 *
 * The default queries form a small matrix: query 1 is the case the docs used to single out, 2 and 3
 * drop one operator each, 4 repeats 1 for another category. The first run of this matrix
 * (15.08.2026) is what corrected the documentation — the drift showed up in ALL of them, the plainest
 * (`is:unread -in:inbox`) included, which is how we learned it is not a quirk of one operator
 * combination but a stale read-state behind `is:unread` itself. Add a query without `is:unread` for
 * the control that settles it: if the index simply ignored the predicate, both would return the same
 * count. They do not (800+ vs 131 in that mailbox), so it is applied — just to stale state.
 *
 * STRICTLY READ-ONLY, and metadata-only: `format: "minimal"` returns label ids and no headers, so
 * this never reads a subject, sender or body. Nothing is modified, nobody is contacted. It prints
 * counts and label names — no mail content and no thread ids.
 *
 *   node scripts/probe-reverify.mjs [--account NAME] [--max N] [query ...]
 *
 * Needs a built tree (`npm run build`) and an authorized token (`mailwarden --auth`).
 */
import { google } from "googleapis";
import { getAuth } from "../dist/auth.js";
import { deriveLabelFilters, threadMatchesFilters } from "../dist/gmail.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const account = flag("--account");
const max = Number(flag("--max") ?? 100);

if (!Number.isInteger(max) || max < 1 || max > 500) {
  console.error("--max must be an integer between 1 and 500.");
  process.exit(2);
}
if (account) process.env.MAILWARDEN_ACCOUNT = account;

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
console.log(`Scan:    up to ${max} threads per query, metadata only\n`);

/** Every thread id the index returns for `q`, following pages up to `max`. */
async function indexHits(q) {
  const ids = [];
  let pageToken;
  do {
    const res = await api.users.threads.list({
      userId: "me",
      q,
      maxResults: Math.min(100, max - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...(res.data.threads ?? []).map((t) => t.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  return ids;
}

/** Live labels of a thread: the union over its messages — the same rule `search()` applies. */
async function liveLabels(id) {
  const res = await api.users.threads.get({ userId: "me", id, format: "minimal" });
  return [...new Set((res.data.messages ?? []).flatMap((m) => m.labelIds ?? []))];
}

let grandTotal = 0;
let grandFalse = 0;

for (const q of QUERIES) {
  const filters = deriveLabelFilters(q);
  const ids = await indexHits(q);
  const failures = new Map(); // predicate -> count

  let checked = 0;
  let falsePositives = 0;
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8);
    const labelSets = await Promise.all(chunk.map((id) => liveLabels(id).catch(() => null)));
    for (const labels of labelSets) {
      if (!labels) continue; // vanished between list and get — not evidence either way
      checked++;
      if (threadMatchesFilters(labels, filters)) continue;
      falsePositives++;
      // Name every predicate this thread breaks, so the output says WHICH operator the
      // index ignored rather than only that something did not line up.
      for (const f of filters) {
        if (labels.includes(f.labelId) === f.present) continue;
        const key = f.present ? `missing ${f.labelId}` : `unexpected ${f.labelId}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
  }

  grandTotal += checked;
  grandFalse += falsePositives;

  const pct = checked ? ((falsePositives / checked) * 100).toFixed(1) : "0.0";
  console.log(`Query: ${q}`);
  console.log(`  predicates re-verified: ${filters.map((f) => (f.present ? "+" : "-") + f.labelId).join(" ") || "(none)"}`);
  console.log(`  index returned:         ${checked} threads`);
  console.log(`  index false positives:  ${falsePositives} (${pct}%)`);
  for (const [key, n] of [...failures].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${n}x ${key}`);
  }
  console.log();
}

console.log(`Total: ${grandFalse} of ${grandTotal} hits contradicted their own query.`);
console.log(
  grandFalse > 0
    ? "The index is loose here — mailwarden drops exactly these before any tool sees them."
    : "No false positive in this sample. That is a finding too: report the sample, not a claim.",
);

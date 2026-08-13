#!/usr/bin/env node
/**
 * Hold `list_subscriptions` against real mail — and specifically its one shortcut.
 *
 * The tool reports each sender's opt-out options from **one** thread (that sender's
 * newest), not from all of them. That is a real optimization — a sender with forty
 * threads costs one metadata fetch instead of forty — but it is also an assumption:
 * that any thread of a sender advertises what the sender offers. If a newsletter
 * changed platforms, or its newest mail happens to be a transactional receipt with
 * no `List-Unsubscribe` header at all, the shortcut reports `none` for a sender you
 * *can* leave. No unit test can settle that; only real mail can.
 *
 * So this script does the expensive thing on purpose: it inspects EVERY thread of
 * each sender and compares the verdict against the one thread the tool would have
 * picked. It reports both directions —
 *
 *   MISS  the tool says none/link, some other thread of that sender offers better
 *   EXTRA the tool's thread offers better than the rest (harmless, worth knowing)
 *
 * — plus how the grouping itself held up (senders parsed, dates parsed, perMonth).
 *
 * STRICTLY READ-ONLY. Message metadata only. No request is ever made to a sender,
 * no URL printed here is visited, nothing in the mailbox is modified. Running it
 * costs a newsletter nothing and tells it nothing.
 *
 *   node scripts/probe-subscriptions.mjs [query] [--max N] [--top N] [--account NAME]
 *
 *   node scripts/probe-subscriptions.mjs                     # category:promotions, 100 threads
 *   node scripts/probe-subscriptions.mjs "in:inbox" --max 200 --top 25
 *
 * Needs a built tree (`npm run build`) and an authorized token (`mailwarden --auth`).
 */
import { getAuth } from "../dist/auth.js";
import { Gmail } from "../dist/gmail.js";
import {
  groupSubscriptions,
  listSubscriptions,
  classifyOptOut,
  inspectUnsubscribe,
} from "../dist/unsubscribe.js";
import { parseSender } from "../dist/digest.js";

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
const topN = Number(flag("--top") ?? 10);
const query = argv[0] ?? "category:promotions";

/** How good an opt-out is, so "better" is orderable. */
const RANK = { "one-click": 3, link: 2, mailto: 1, none: 0, unknown: -1 };

// Account selection goes through the env, exactly as the CLI does it — getAuth takes
// a BOOLEAN (interactive), and passing anything truthy here would open the browser
// consent flow instead of loading the stored token. A read-only probe must never do that.
if (account) process.env.MAILWARDEN_ACCOUNT = account;
const gmail = new Gmail(await getAuth(false));

console.log(`query: ${query}   max: ${max}   top: ${topN}   (read-only, contacts nobody)\n`);
const { threads } = await gmail.search(query, max);
console.log(`${threads.length} threads sampled.\n`);

// ---- 1. The grouping, against real From/Date headers ----
const groups = groupSubscriptions(threads, { topN: Number.POSITIVE_INFINITY });
const undatedRows = threads.filter((t) => Number.isNaN(Date.parse(t.date))).length;
const unknownSender = groups.filter((g) => g.sender === "(unknown)");

console.log("── grouping ──────────────────────────────────────────────");
console.log(`distinct senders : ${groups.length}`);
console.log(`unparsed dates   : ${undatedRows} of ${threads.length} rows`);
console.log(
  `unparsed senders : ${unknownSender.length ? `${unknownSender[0].threads} rows under (unknown)` : "0"}`,
);
console.log(`with a rate      : ${groups.filter((g) => g.perMonth !== null).length} of ${groups.length}\n`);

// ---- 2. What the tool reports (one fetch per sender) ----
const { subscriptions, sendersFound } = await listSubscriptions(gmail, threads, { topN });
console.log("── what list_subscriptions reports ───────────────────────");
console.log(`sendersFound: ${sendersFound}   shown: ${subscriptions.length}\n`);
for (const s of subscriptions) {
  const rate = s.perMonth === null ? "  n/a  " : `${String(s.perMonth).padStart(5)}/m`;
  // The span the rate was extrapolated FROM — a per-30-days figure derived from a
  // two-day window is the number to distrust, and it is invisible without this.
  const span =
    s.newestDate && s.oldestDate
      ? (Date.parse(s.newestDate) - Date.parse(s.oldestDate)) / 86_400_000
      : NaN;
  const spanTxt = Number.isNaN(span) ? "    ?" : `${span.toFixed(1).padStart(5)}d`;
  console.log(
    `${s.optOut.padEnd(9)} ${rate} over ${spanTxt}  ${String(s.threads).padStart(3)}t ${String(s.unread).padStart(3)}u  ${s.sender}`,
  );
}

// ---- 3. The shortcut, checked against every thread of each sender ----
console.log("\n── the one-fetch-per-sender shortcut ─────────────────────");
const bySender = new Map();
for (const t of threads) {
  const key = parseSender(t.from).email || "(unknown)";
  if (!bySender.has(key)) bySender.set(key, []);
  bySender.get(key).push(t.threadId);
}

let misses = 0;
let extras = 0;
let checkedThreads = 0;
for (const s of subscriptions) {
  const ids = bySender.get(s.sender) ?? [];
  const others = ids.filter((id) => id !== s.newestThreadId);
  if (!others.length) continue;

  let best = { kind: s.optOut, threadId: s.newestThreadId };
  for (const id of others) {
    checkedThreads++;
    let kind;
    try {
      const info = await inspectUnsubscribe(gmail, id);
      kind = classifyOptOut(info);
    } catch {
      kind = "unknown";
    }
    if (RANK[kind] > RANK[best.kind]) best = { kind, threadId: id };
  }

  if (best.threadId !== s.newestThreadId) {
    misses++;
    console.log(
      `MISS  ${s.sender}\n      tool saw ${s.optOut} on ${s.newestThreadId}, ` +
        `but ${best.threadId} offers ${best.kind} (${others.length} other threads checked)`,
    );
  } else if (others.length) {
    extras++;
  }
}

console.log(
  `\n${checkedThreads} extra threads inspected across ${subscriptions.length} senders — ` +
    `${misses} MISS, ${extras} senders where the picked thread was already the best.`,
);
if (misses === 0) {
  console.log(
    "The shortcut held: no sender's opt-out was missed by looking at one thread instead of all.",
  );
} else {
  console.log(
    "The shortcut LOST opt-outs. Consider falling back to the next thread when the newest\n" +
      "one advertises nothing, instead of reporting `none` for the sender.",
  );
}

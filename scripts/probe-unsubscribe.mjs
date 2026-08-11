#!/usr/bin/env node
/**
 * Hold the List-Unsubscribe parser against real mail.
 *
 * Every automated test for this parser runs on headers *we* wrote, i.e. against our
 * own assumptions about how senders format them. This script is the missing half:
 * it pulls real headers out of your mailbox and prints each one next to what the
 * parser made of it, so a wrong assumption is visible rather than merely untested.
 *
 * STRICTLY READ-ONLY. It fetches message metadata and nothing else — no request is
 * ever made to a sender, nothing in the mailbox is modified, and the URLs it prints
 * are not visited. Running it costs a newsletter nothing and tells it nothing.
 *
 *   node scripts/probe-unsubscribe.mjs [query] [--max N] [--account NAME]
 *
 *   node scripts/probe-unsubscribe.mjs                          # category:promotions, 25 threads
 *   node scripts/probe-unsubscribe.mjs "from:substack.com" --max 50
 *
 * Needs a built tree (`npm run build`) and an authorized token (`mailwarden --auth`).
 */
import { getAuth } from "../dist/auth.js";
import { Gmail } from "../dist/gmail.js";
import {
  parseListUnsubscribe,
  validateUnsubscribeUrl,
  isBlockedAddress,
  defaultUnsubscribeDeps,
} from "../dist/unsubscribe.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const account = flag("--account");
// --vet additionally runs each parsed endpoint through the URL vetting and the
// address guard (DNS only). It answers the other half of the question: would the
// guards let a REAL opt-out through, or do they quietly block legitimate senders?
// Still contacts no sender — no HTTP request is made to any endpoint.
const vet = argv.includes("--vet") && (argv.splice(argv.indexOf("--vet"), 1), true);
const max = Number(flag("--max") ?? 25);
const query = argv[0] ?? "category:promotions";

if (!Number.isInteger(max) || max < 1 || max > 200) {
  console.error("--max must be an integer between 1 and 200.");
  process.exit(2);
}
if (account) process.env.MAILWARDEN_ACCOUNT = account;

const gmail = new Gmail(await getAuth(false));
const profile = await gmail.getProfile();
console.log(`Mailbox: ${profile.emailAddress}`);
console.log(`Query:   ${query}  (up to ${max} threads)\n`);

const { threads } = await gmail.search(query, max);
if (!threads.length) {
  console.log("No threads matched — try a different query.");
  process.exit(0);
}

const stats = { total: 0, none: 0, postOnly: 0, oneClick: 0, linkOnly: 0, mailtoOnly: 0, odd: 0 };
const oddities = [];
// Whether a folded header reaches us folded is a QUESTION, not a known: the Gmail API
// usually unfolds, but not always (observed on Subject). Counting it turns that into a
// measurement instead of something eyeballed in the output — a CR/LF/tab inside the value
// is invisible at a glance once JSON.stringify has escaped it.
const folded = [];
const refused = [];

/** Would the guards permit this endpoint? Vetting + DNS, never an HTTP request. */
async function vetEndpoint(raw) {
  let url;
  try {
    url = validateUnsubscribeUrl(raw);
  } catch (err) {
    return `rejected by URL vetting — ${err.message}`;
  }
  let addresses;
  try {
    addresses = await defaultUnsubscribeDeps.resolveHost(url.hostname);
  } catch (err) {
    return `host does not resolve — ${err.message}`;
  }
  const blocked = addresses.filter(isBlockedAddress);
  if (blocked.length) return `address guard would refuse ${blocked.join(", ")}`;
  return null;
}

for (const t of threads) {
  const h = await gmail.getUnsubscribeHeaders(t.threadId);
  const parsed = parseListUnsubscribe(h.listUnsubscribe, h.listUnsubscribePost);
  stats.total++;

  const kind = !h.listUnsubscribe.trim()
    // A `List-Unsubscribe-Post` with no `List-Unsubscribe` to go with it is
    // RFC-wise nonsense but occurs in the field (transactional mail from at least
    // one ESP). Counted apart from "no header at all" — the parse result is the
    // same (nothing to offer) but the sender's intent plainly was not.
    ? h.listUnsubscribePost.trim()
      ? "postOnly"
      : "none"
    : parsed.oneClick
      ? "oneClick"
      : parsed.httpsUrls.length
        ? "linkOnly"
        : parsed.mailtos.length
          ? "mailtoOnly"
          : "odd";
  stats[kind]++;

  // A header that advertises something the parser turned into nothing is the
  // interesting case — that is a parsing assumption failing on real input.
  if (kind === "odd") oddities.push({ from: h.from, raw: h.listUnsubscribe });
  if (/[\r\n\t]/.test(h.listUnsubscribe)) folded.push({ from: h.from, raw: h.listUnsubscribe });

  console.log(`── ${h.from || "(no From)"}`);
  console.log(`   subject : ${h.subject || "(none)"}`);
  console.log(`   raw     : ${JSON.stringify(h.listUnsubscribe) || '""'}`);
  if (h.listUnsubscribePost) console.log(`   raw-post: ${JSON.stringify(h.listUnsubscribePost)}`);
  console.log(
    `   parsed  : oneClick=${parsed.oneClick} https=${JSON.stringify(parsed.httpsUrls)} mailto=${JSON.stringify(parsed.mailtos)}`,
  );
  if (vet && parsed.oneClick) {
    const problem = await vetEndpoint(parsed.httpsUrls[0]);
    console.log(`   vetted  : ${problem ? `REFUSED — ${problem}` : "would be allowed"}`);
    if (problem) refused.push({ from: h.from, url: parsed.httpsUrls[0], problem });
  }
  console.log();
}

console.log("─".repeat(60));
console.log(
  `${stats.total} threads: ${stats.oneClick} one-click, ${stats.linkOnly} link-only, ` +
    `${stats.mailtoOnly} mailto-only, ${stats.none} no header, ${stats.postOnly} Post-header only, ` +
    `${stats.odd} unparsed`,
);
if (vet) {
  const checked = stats.oneClick;
  console.log(
    refused.length
      ? `\n⚠ ${refused.length} of ${checked} real one-click endpoints would be REFUSED by the ` +
          `guards — a false positive here silently breaks the feature for that sender:`
      : `\n✓ all ${checked} real one-click endpoints would pass the guards (no false positives).`,
  );
  for (const r of refused) console.log(`   ${r.from}: ${r.problem}\n     ${r.url}`);
}
console.log(
  folded.length
    ? `\n${folded.length} header(s) arrived FOLDED (CR/LF/tab inside the value) — the parser is ` +
        `expected to absorb this, and these are worth keeping as test cases:`
    : `\nNo header arrived folded — the API unfolded every one in this sample.`,
);
for (const f of folded) console.log(`   ${f.from}: ${JSON.stringify(f.raw)}`);
if (oddities.length) {
  console.log(
    `\n⚠ ${oddities.length} header(s) advertised something the parser dropped — these are the ` +
      `cases worth turning into a test:`,
  );
  for (const o of oddities) console.log(`   ${o.from}: ${JSON.stringify(o.raw)}`);
}

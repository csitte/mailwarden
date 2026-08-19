#!/usr/bin/env node
/**
 * Two questions about the SPAM folder, measured rather than assumed.
 *
 * 1. IS IT REACHABLE AT ALL? None of mailwarden's list calls sets `includeSpamTrash`, while
 *    `deriveLabelFilters` maps `in:spam` to a SPAM label predicate — so the query language looks
 *    like it supports spam even if the API never returns any. The Gmail reference documents the
 *    parameter ("Include threads from SPAM and TRASH in the results.") but does NOT say whether an
 *    explicit `in:spam` in `q` overrides it. Undocumented means measured, not guessed.
 *
 * 2. WOULD A FALSE-POSITIVE REVIEW HAVE ANYTHING TO WORK WITH? A spam folder that is all bulk mail
 *    needs no tool. The interesting quantity is how many spam threads look UNLIKE bulk mail: no
 *    List-Id/List-Unsubscribe/Precedence, not auto-submitted — and, the strongest counter-signal
 *    available without a send scope, a sender the user has themselves written to (`in:sent`).
 *
 * STRICTLY READ-ONLY. Nothing is modified, nobody is contacted. Question 1 uses `format: "minimal"`
 * (label ids only). Question 2 needs `From`/`List-*` headers, so it fetches metadata format with an
 * explicit header allowlist — no subject, no body, ever. OUTPUT IS AGGREGATE ONLY: counts and
 * percentages. No address, subject, thread id or domain is ever printed.
 *
 *   node scripts/probe-spam.mjs [--account NAME] [--max N] [--skip-senders]
 *
 * Needs a built tree (`npm run build`) and an authorized token (`mailwarden --auth`).
 */
import { google } from "googleapis";
import { getAuth } from "../dist/auth.js";
import { deriveSignals } from "../dist/signals.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const account = flag("--account");
const max = Number(flag("--max") ?? 100);
const skipSenders = bool("--skip-senders");
if (account) process.env.MAILWARDEN_ACCOUNT = account;
if (!Number.isInteger(max) || max < 1 || max > 500) {
  console.error("--max must be an integer between 1 and 500.");
  process.exit(2);
}

const auth = await getAuth();
const api = google.gmail({ version: "v1", auth });
const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

// ── Question 1: reachability ────────────────────────────────────────────────────────────────────
console.log("\n=== 1. Is SPAM reachable without includeSpamTrash? ===\n");

const label = await api.users.labels.get({ userId: "me", id: "SPAM" });
const totalThreads = label.data.threadsTotal ?? 0;
console.log(`  SPAM label reports:                          ${totalThreads} threads, ` +
  `${label.data.messagesTotal ?? 0} messages`);

const count = async (fn) => {
  try {
    const res = await fn();
    const items = res.data.threads ?? res.data.messages ?? [];
    return items.length;
  } catch (e) {
    return `ERROR ${e?.code ?? ""} ${e?.message ?? e}`;
  }
};

const probes = [
  ["threads.list  q=in:spam              (no flag)", () =>
    api.users.threads.list({ userId: "me", q: "in:spam", maxResults: 25 })],
  ["threads.list  q=in:spam              (flag ON)", () =>
    api.users.threads.list({ userId: "me", q: "in:spam", maxResults: 25, includeSpamTrash: true })],
  ["threads.list  labelIds=[SPAM]        (no flag)", () =>
    api.users.threads.list({ userId: "me", labelIds: ["SPAM"], maxResults: 25 })],
  ["threads.list  labelIds=[SPAM]        (flag ON)", () =>
    api.users.threads.list({ userId: "me", labelIds: ["SPAM"], maxResults: 25, includeSpamTrash: true })],
  ["messages.list q=in:spam              (no flag)", () =>
    api.users.messages.list({ userId: "me", q: "in:spam", maxResults: 25 })],
  ["messages.list q=in:spam              (flag ON)", () =>
    api.users.messages.list({ userId: "me", q: "in:spam", maxResults: 25, includeSpamTrash: true })],
];
for (const [name, fn] of probes) console.log(`  ${name}  ->  ${await count(fn)}`);

// Control: a query that is not spam-scoped, to prove the calls work at all in this mailbox.
console.log(`  threads.list  q=in:inbox             (control)  ->  ` +
  `${await count(() => api.users.threads.list({ userId: "me", q: "in:inbox", maxResults: 25 }))}`);

if (totalThreads === 0) {
  console.log("\n  SPAM is empty in this mailbox — question 2 has nothing to measure. Stopping.\n");
  process.exit(0);
}

// ── Question 2: would a review have anything to work with? ──────────────────────────────────────
console.log("\n=== 2. How much of SPAM looks unlike bulk mail? ===\n");

const ids = [];
let pageToken;
do {
  const res = await api.users.threads.list({
    userId: "me", labelIds: ["SPAM"], maxResults: Math.min(100, max - ids.length),
    includeSpamTrash: true, ...(pageToken ? { pageToken } : {}),
  });
  for (const t of res.data.threads ?? []) ids.push(t.id);
  pageToken = res.data.nextPageToken ?? undefined;
} while (pageToken && ids.length < max);

const HEADERS = ["From", "Reply-To", "List-Id", "List-Unsubscribe", "List-Unsubscribe-Post",
  "Precedence", "Auto-Submitted", "Content-Type"];
const senders = new Map();
const addresses = new Map();
let scanned = 0, plain = 0;
const tally = { newsletter: 0, automated: 0, calendar: 0, replyToMismatch: 0 };

for (let i = 0; i < ids.length; i += 5) {
  const chunk = ids.slice(i, i + 5);
  const got = await Promise.all(chunk.map((id) =>
    api.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: HEADERS })
      .then((r) => r.data).catch(() => null)));
  for (const th of got) {
    const msg = th?.messages?.[0];
    if (!msg) continue;
    scanned++;
    const rawHeaders = msg.payload?.headers ?? [];
    const headerOf = (name) =>
      rawHeaders.find((h) => (h.name ?? "").toLowerCase() === name)?.value ?? "";
    const signals = deriveSignals({ headers: rawHeaders, parts: msg.payload?.parts ?? [] });
    for (const s of signals) if (s in tally) tally[s]++;
    // "Plain" = carries none of the bulk/automation machinery a mailing list would.
    if (!signals.includes("newsletter") && !signals.includes("automated")) {
      plain++;
      const from = headerOf("from").toLowerCase();
      const m = /<?([^<>\s]+@[^<>\s]+?)>?\s*$/.exec(from.trim());
      const address = m ? m[1] : "";
      const domain = address.slice(address.lastIndexOf("@") + 1);
      if (domain) {
        senders.set(domain, (senders.get(domain) ?? 0) + 1);
        addresses.set(address, (addresses.get(address) ?? 0) + 1);
      }
    }
  }
}

console.log(`  threads scanned:                             ${scanned} (of ${totalThreads} in SPAM)`);
console.log(`  carries newsletter machinery (List-*/bulk):  ${tally.newsletter} (${pct(tally.newsletter, scanned)})`);
console.log(`  says a machine wrote it (Auto-Submitted):    ${tally.automated} (${pct(tally.automated, scanned)})`);
console.log(`  Reply-To on a foreign domain:                ${tally.replyToMismatch} (${pct(tally.replyToMismatch, scanned)})`);
console.log(`  NEITHER newsletter NOR automated ("plain"):  ${plain} (${pct(plain, scanned)})  <- the review candidates`);
console.log(`  distinct sender domains among those:         ${senders.size}`);

// ── The strongest counter-signal: did the user ever write to that domain? ───────────────────────
if (!skipSenders && senders.size) {
  console.log("\n=== 3. Of those, how many are domains the user has written to? ===\n");
  const domains = [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  let known = 0, knownThreads = 0;
  for (const [domain, n] of domains) {
    const res = await api.users.messages.list({
      userId: "me", q: `in:sent to:${domain}`, maxResults: 1,
    }).catch(() => null);
    if (res?.data?.messages?.length) { known++; knownThreads += n; }
  }
  console.log(`  domains checked (top by volume):             ${domains.length}`);
  console.log(`  ...the user has sent mail to:                ${known} (${pct(known, domains.length)})`);
  console.log(`  spam threads from those domains:             ${knownThreads}`);

  // Domain level is too coarse where the domain is a freemail provider: having written to
  // one @gmail.com correspondent says nothing about another @gmail.com sender. Measure how
  // much of the domain-level signal rests on such domains, and re-run it per FULL ADDRESS.
  const FREEMAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.de", "hotmail.com",
    "outlook.com", "outlook.de", "live.com", "aol.com", "gmx.de", "gmx.net", "gmx.at", "web.de",
    "icloud.com", "me.com", "mail.com", "protonmail.com", "proton.me", "yandex.ru", "qq.com"]);
  const freeAmongCandidates = [...senders.keys()].filter((d) => FREEMAIL.has(d)).length;
  console.log(`  ...of the candidate domains, freemail:       ${freeAmongCandidates} (${pct(freeAmongCandidates, senders.size)})`);

  const addrs = [...addresses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  let knownAddr = 0, knownAddrThreads = 0;
  for (const [address, n] of addrs) {
    const res = await api.users.messages.list({
      userId: "me", q: `in:sent to:${address}`, maxResults: 1,
    }).catch(() => null);
    if (res?.data?.messages?.length) { knownAddr++; knownAddrThreads += n; }
  }
  console.log(`\n  same check per FULL ADDRESS (top ${addrs.length}):`);
  console.log(`  ...the user has sent mail to:                ${knownAddr} (${pct(knownAddr, addrs.length)})`);
  console.log(`  spam threads from those addresses:           ${knownAddrThreads}`);
  console.log(`\n  A spam thread from an ADDRESS the user writes to is the clearest`);
  console.log(`  false-positive candidate available without a send scope. The domain`);
  console.log(`  variant above is the same check made careless by freemail providers.`);
}
// ── 4. The case that matters in a session: a query that does NOT name the place ────────────────
// "Find the confirmation mail from X" becomes `from:X` — no `in:spam`, because the caller does not
// know where it landed. If that query hides a spam hit, mailwarden answers "no such mail" about a
// mail that exists. This is the failure the folder review was really about.
console.log("\n=== 4. Does a place-less query find a mail that sits in SPAM? ===\n");
{
  const probe = ids[0];
  const th = probe
    ? await api.users.threads.get({
        userId: "me", id: probe, format: "metadata", metadataHeaders: ["From", "Subject"],
      }).catch(() => null)
    : null;
  const from = th?.data?.messages?.[0]?.payload?.headers
    ?.find((h) => (h.name ?? "").toLowerCase() === "from")?.value ?? "";
  const m = /<?([^<>\s]+@[^<>\s]+?)>?\s*$/.exec(from.trim());
  const address = m ? m[1] : "";
  if (!address) {
    console.log("  no usable sender in the sample — skipped");
  } else {
    const ask = async (extra) => {
      try {
        const r = await api.users.messages.list({
          userId: "me", q: `from:${address}`, maxResults: 10, ...extra,
        });
        return r.data.messages?.length ?? 0;
      } catch (e) {
        return `ERROR ${e?.code ?? ""} ${(e?.message ?? String(e)).slice(0, 120)}`;
      }
    };
    // The address itself is never printed — only what the two calls return.
    console.log(`  a sender taken from SPAM, queried as plain \`from:<addr>\`:`);
    console.log(`    without includeSpamTrash                 ->  ${await ask({})}`);
    console.log(`    with    includeSpamTrash: true           ->  ${await ask({ includeSpamTrash: true })}`);
    console.log(`\n  If the first is 0 and the second is not, then \`search\` today reports`);
    console.log(`  "no such mail" for mail that exists — silently, with no way for the`);
    console.log(`  caller to know the spam folder was excluded.`);
  }
}
console.log("");

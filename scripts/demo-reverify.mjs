#!/usr/bin/env node
// Demonstrates mailwarden's live-label re-verification — the thing no other Gmail
// MCP server does — WITHOUT needing Gmail credentials or a network connection.
//
//   npm run build && node scripts/demo-reverify.mjs
//
// It drives the REAL production `Gmail.search()` (imported from dist/) against a
// fake Gmail API whose search index is deliberately *loose*: for the query
// `category:updates is:unread -in:inbox` it hands back a thread that is actually
// READ. That is the real, reproducible Gmail behavior — `threads.list` silently
// drops `is:unread` in some operator combinations. A server that trusts the index
// would act on that read thread (archive it, mark it, feed it to an assistant).
// mailwarden re-checks every hit against its true labels and drops the false
// positive before any tool sees it.
//
// The script asserts the outcome and exits non-zero if it ever stops holding, so
// it doubles as a living check, not just a printout.

import { Gmail } from "../dist/gmail.js";

const QUERY = "category:updates is:unread -in:inbox";

// The mailbox's TRUE state (what threads.get would return). Thread `b` is read.
const trueLabels = {
  a: ["CATEGORY_UPDATES", "UNREAD"],
  b: ["CATEGORY_UPDATES"], //            <- actually READ: the index's false positive
  c: ["CATEGORY_UPDATES", "UNREAD"],
};

// A fake Gmail API whose threads.list index is LOOSE: it returns ALL three threads
// for the is:unread query (including the read one) — mirroring the real bug.
// threads.get, by contrast, returns each thread's real labels.
function looseIndexApi(labels) {
  const ids = Object.keys(labels);
  return {
    users: {
      threads: {
        list: async () => ({ data: { threads: ids.map((id) => ({ id })) } }),
        get: async (req) => ({
          data: {
            messages: [
              {
                id: `m-${req.id}`,
                labelIds: labels[req.id],
                payload: { headers: [{ name: "Subject", value: `subject of ${req.id}` }] },
              },
            ],
          },
        }),
      },
    },
  };
}

const rawIndexReturns = Object.keys(trueLabels); // what a naive server would act on
const gmail = new Gmail(looseIndexApi(trueLabels));
const { threads } = await gmail.search(QUERY, 25);
const mailwardenReturns = threads.map((t) => t.threadId);

const isUnread = (id) => trueLabels[id].includes("UNREAD");
const dropped = rawIndexReturns.filter((id) => !mailwardenReturns.includes(id));

console.log(`\nQuery:  ${QUERY}\n`);
console.log("Raw Gmail index (threads.list) returns:");
for (const id of rawIndexReturns) {
  console.log(`  ${id}  ${isUnread(id) ? "unread ✓" : "READ ✗  <- index false positive"}`);
}
console.log("\nmailwarden.search() returns (re-verified against live labels):");
for (const id of mailwardenReturns) console.log(`  ${id}  unread ✓`);
console.log(`\nDropped as false positives: ${dropped.length ? dropped.join(", ") : "(none)"}\n`);

// Assertions — the demonstration must actually hold.
const expected = rawIndexReturns.filter(isUnread);
const ok =
  JSON.stringify(mailwardenReturns) === JSON.stringify(expected) &&
  dropped.length === 1 &&
  dropped[0] === "b";

if (!ok) {
  console.error("✗ Re-verification demo FAILED: search() did not drop the read false positive.");
  process.exit(1);
}
console.log("✓ mailwarden dropped the read thread the raw index wrongly returned.");

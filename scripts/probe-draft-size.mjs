#!/usr/bin/env node
/**
 * Measure how large a draft Gmail accepts through the plain `drafts.create` / `drafts.update`
 * endpoints — the JSON body with a base64url `raw` message, which is all the `drafts` tier may call.
 *
 * Attachments for drafts hinge on this number. If Gmail takes a draft of the size people attach
 * (photos, PDFs, up to Gmail's 25 MB attachment limit) on the plain path, the egress guard needs no
 * new entry. If it refuses above some size, that size is where the upload endpoint
 * (`/upload/gmail/v1/users/me/drafts`) would have to be opened for the tier — and the guard denies it
 * today on purpose.
 *
 * Each step builds a MIME message with no recipient and one attachment of random bytes (random so
 * that nothing on the way can compress it), saves it as a draft, prints the outcome, and moves the
 * draft's thread to the trash at once, where it can be restored like any message. It never sends,
 * never sets a recipient and never reads a message it did not write.
 *
 *   node scripts/probe-draft-size.mjs [--account NAME] [--update] [MB ...]
 *
 * `--update` first saves a 1 KB draft and then replaces it with each size, to measure
 * `drafts.update` instead of `drafts.create`. Needs a built tree (`npm run build`) and a token with
 * `gmail.modify` (`mailwarden --auth`).
 */
import { randomBytes } from "node:crypto";
import { gmail as gmailApi } from "@googleapis/gmail";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const toggle = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const account = flag("--account");
const update = toggle("--update");
const sizes = (argv.length ? argv : ["1", "4", "5", "6", "8", "10", "15", "20", "24"]).map(Number);

if (sizes.some((mb) => !(mb > 0 && mb <= 40))) {
  console.error("Sizes are megabytes between 0 and 40.");
  process.exit(2);
}
if (account) process.env.MAILWARDEN_ACCOUNT = account;
// The guard lets draft calls through only for a deployment that named the tier; trash is `manage`.
process.env.MAILWARDEN_TOOLS = "read,manage,drafts";

const { getAuth } = await import("../dist/auth.js");
const auth = await getAuth(false);
const api = gmailApi({ version: "v1", auth });

const profile = await api.users.getProfile({ userId: "me" });
console.log(`Mailbox:  ${profile.data.emailAddress}`);
console.log(`Endpoint: drafts.${update ? "update" : "create"} (plain JSON body, raw message)\n`);

const MB = 1024 * 1024;
const base64url = (s) => Buffer.from(s, "binary").toString("base64url");

/** A recipient-less message with one attachment of `bytes` random bytes. */
function message(bytes, label) {
  const boundary = `probe-${randomBytes(8).toString("hex")}`;
  const body = randomBytes(bytes).toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `Subject: mailwarden size probe ${label}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Size probe draft. Safe to delete.",
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="probe-${label}.bin"`,
    `Content-Disposition: attachment; filename="probe-${label}.bin"`,
    "Content-Transfer-Encoding: base64",
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** The guard allows trash per thread, as mailwarden's own tools use it; a draft is its own thread. */
async function trash(threadId) {
  if (!threadId) return "no thread id";
  try {
    await api.users.threads.trash({ userId: "me", id: threadId });
    return "trashed";
  } catch (err) {
    return `trash failed: ${err?.response?.status ?? ""} ${err?.message ?? err}`;
  }
}

let draftId;
let draftMessage;
if (update) {
  const res = await api.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: base64url(message(1024, "seed")) } },
  });
  draftId = res.data.id;
  draftMessage = res.data.message?.threadId;
}

const rows = [];
for (const mb of sizes) {
  const raw = base64url(message(Math.round(mb * MB), `${mb}MB`));
  const rawMB = (raw.length / MB).toFixed(1);
  const started = Date.now();
  let outcome;
  let cleanup = "";
  try {
    const res = update
      ? await api.users.drafts.update({ userId: "me", id: draftId, requestBody: { message: { raw } } })
      : await api.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    // drafts.create answers with ids only; the stored size says whether all of it arrived.
    const saved = await api.users.drafts.get({ userId: "me", id: res.data.id, format: "minimal" });
    const stored = saved.data.message?.sizeEstimate;
    outcome = `ok, stored ${stored ? (stored / MB).toFixed(1) : "?"} MB`;
    if (update) draftMessage = res.data.message?.threadId ?? draftMessage;
    else cleanup = await trash(res.data.message?.threadId);
  } catch (err) {
    const status = err?.response?.status ?? err?.code ?? "?";
    const reason = err?.response?.data?.error?.message ?? err?.message ?? String(err);
    outcome = `REFUSED ${status}: ${String(reason).slice(0, 160)}`;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  rows.push({ mb, rawMB, outcome });
  console.log(`attachment ${String(mb).padStart(4)} MB  raw ${rawMB.padStart(5)} MB  ${secs.padStart(5)} s  ${outcome}${cleanup ? `  [${cleanup}]` : ""}`);
}

if (update) console.log(`\nseed draft: ${await trash(draftMessage)}`);

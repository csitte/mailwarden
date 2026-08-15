#!/usr/bin/env node
/**
 * "Did we tell csitte.at about this release?" — as a command instead of a memory.
 *
 * The product page at https://www.csitte.at/mailwarden/ is maintained by a different session in a
 * repo this one must not commit to, so a release only reaches the page if someone posts a
 * session-bridge message. Three releases in a row (0.8.0 → 0.10.0) shipped without that message and
 * the page kept describing 0.7.0.
 *
 * Two ways in:
 *   npm run site-notice          gate — exits non-zero when this version was never announced
 *   node scripts/check-site-notice.mjs --warn    same verdict, always exit 0 (npm `postversion`)
 *
 * It reads; it never writes to the bridge. The message itself needs judgement (what on the page is
 * now wrong, which claim needs requalifying) and stays hand-written — see CLAUDE.md, "Release".
 * The judgement that matters most there is not "what did we add" but "which promise got narrower":
 * on 15.08.2026 a caveat about the bulk tools travelled as a side note, and the page went on
 * promising a guarantee the shipped version only gives for `search`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isSiteThread, noticeState, resolveBridgeDir } from "./lib/site-notice.mjs";

const warnOnly = process.argv.includes("--warn");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const bridge = resolveBridgeDir(existsSync);
if (!bridge) {
  // No bridge on this machine (CI, a clone, someone else's checkout). Saying "fine" here would be a
  // lie and failing would break every such run, so it reports the one true thing: nothing was checked.
  console.log(`site-notice: SKIPPED — no session-bridge directory on this machine (${version}).`);
  console.log("            Set MAILWARDEN_BRIDGE_DIR to check from a non-standard path.");
  process.exit(0);
}

// Closed threads are moved to _archiv/ verbatim; a notice there still counts as sent.
const roots = [path.join(bridge, "threads"), path.join(bridge, "_archiv")].filter(existsSync);
const threads = [];
for (const root of roots) {
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory() || !isSiteThread(slug.name)) continue;
    const msgs = path.join(root, slug.name, "msgs");
    if (!existsSync(msgs)) continue;
    // Only our own messages are opened — on Drive every read can cost a fetch.
    const messages = readdirSync(msgs)
      .filter((n) => n.includes("__mailwarden__") && n.endsWith(".md"))
      .map((name) => ({ name, text: readFileSync(path.join(msgs, name), "utf8") }));
    threads.push({ slug: slug.name, messages });
  }
}

const { state, hits } = noticeState(threads, version);

if (state === "notified") {
  console.log(`site-notice: OK — csitte was told about ${version}:`);
  for (const hit of hits) console.log(`             ${hit.slug}/msgs/${hit.name}`);
  process.exit(0);
}

const scanned = threads.length ? threads.map((t) => t.slug).join(", ") : "none found";
console.error(`site-notice: MISSING — no bridge message from us to csitte mentions ${version}.`);
console.error(`             Site threads scanned: ${scanned}`);
console.error("             www.csitte.at/mailwarden/ will keep describing the previous release.");
console.error("             Post the delta (what on the page is now wrong / missing) per CLAUDE.md,");
console.error("             then re-run. Limits that narrowed an existing promise belong there FIRST —");
console.error("             a page that still promises the old scope is worse than one missing a feature.");
console.error("             Write-once: new file, temp-then-rename, never edit one.");
process.exit(warnOnly ? 0 : 1);

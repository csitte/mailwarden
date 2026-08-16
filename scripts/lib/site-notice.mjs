/**
 * Pure logic behind `npm run site-notice`: has the csitte.at session been told about THIS version?
 *
 * The product page https://www.csitte.at/mailwarden/ lives in a foreign repo (`csitte.at`) that this
 * session must never commit to — the agreed channel is a session-bridge message. That works, but it
 * is a step a human has to remember at the end of a release, and it was forgotten across 0.8.0,
 * 0.9.0 and 0.10.0: the page still described 0.7.0 when someone finally looked.
 *
 * So the reminder is mechanical now. The check is deliberately narrow — it answers "does a message
 * from us, addressed to csitte, mention this version?" and nothing about whether the page was
 * actually changed. Whether csitte adopts the delta is *their* call and their commit; what is ours
 * is telling them. Tracking the rest is what the bridge thread's OPEN status already does.
 *
 * No IO here: the caller hands in what it read, so the rules below are testable without a Drive.
 */

/** Message filenames are `<UTC>__<from>__<rand>.md` — the author is the middle field. */
export const AUTHOR_IN_FILENAME = /__([a-z0-9-]+)__/i;

/**
 * Thread dirs to look in. The site thread is `061-mailwarden-doku-csitte-update`; a later release
 * may well open its own, so this matches on both participants appearing in the slug rather than
 * pinning that one id. Narrow on purpose: the bridge lives on Google Drive, where every file access
 * can trigger a fetch, and a scan across all ~77 threads is what ran into the tool timeout once.
 */
export const SITE_THREAD_PATTERN = /(mailwarden.*csitte|csitte.*mailwarden)/i;

export function isSiteThread(slug, pattern = SITE_THREAD_PATTERN) {
  return pattern.test(slug);
}

/** `from:` / `to:` off the frontmatter. Absent frontmatter is not an error — the file just fails to match. */
export function readHeaders(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const headers = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z-]+):\s*(.*)$/i.exec(line.trim());
    if (kv) headers[kv[1].toLowerCase()] = kv[2].trim();
  }
  return headers;
}

/** `to:` takes one id, a comma list, or `all`. Matching is token-exact — `csitte` is not `csitte-x`. */
export function addresses(headers, id) {
  const to = headers.to ?? "";
  return to
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .includes(id);
}

/**
 * Does this message DECLARE that it announces `version`? Read from a frontmatter field, never from
 * the prose:
 *
 *     announces: 0.11.0
 *
 * The first cut scanned the body text for the version instead, and it produced a false OK within
 * hours — on the very first release it ran for. The offending message was our own, and it contained
 * `0.11.0` only as an EXAMPLE, inside a sentence explaining this check's own rules. Every
 * text-matching rule has that failure mode: a version turns up in a plan, a quote, a caveat about dev
 * bundles, and the tool reads it as "already announced" and waves through the one step it exists to
 * enforce. A false MISSING costs a second look; a false OK costs the thing itself.
 *
 * So an announcement declares itself. The field takes one version or a comma list (one message may
 * cover two releases), compared exactly after trimming an optional `v`. What a message merely
 * *mentions* is now irrelevant — which is the whole point.
 */
export function announcesVersion(headers, version) {
  const raw = headers?.announces;
  if (typeof raw !== "string") return false;
  return raw
    .split(",")
    .map((v) => v.trim().replace(/^v/i, ""))
    .includes(version.trim());
}

/**
 * @param {Array<{slug: string, messages: Array<{name: string, text: string}>}>} threads
 * @returns {{state: "notified"|"missing", version: string, hits: Array<{slug: string, name: string}>}}
 */
export function noticeState(threads, version, { from = "mailwarden", to = "csitte" } = {}) {
  const hits = [];
  for (const thread of threads) {
    for (const msg of thread.messages) {
      const author = AUTHOR_IN_FILENAME.exec(msg.name)?.[1]?.toLowerCase();
      if (author !== from) continue;
      const headers = readHeaders(msg.text);
      if ((headers.from ?? "").toLowerCase() !== from) continue;
      if (!addresses(headers, to)) continue;
      if (!announcesVersion(headers, version)) continue;
      hits.push({ slug: thread.slug, name: msg.name });
    }
  }
  return { state: hits.length > 0 ? "notified" : "missing", version, hits };
}

/** First existing candidate wins; `MAILWARDEN_BRIDGE_DIR` overrides. Device-dependent by nature. */
export const BRIDGE_CANDIDATES = [
  "D:/etc/Google Drive/_session-bridge", // PC
  "F:/Meine Ablage/_session-bridge", // notebook
];

export function resolveBridgeDir(exists, { env = process.env, candidates = BRIDGE_CANDIDATES } = {}) {
  const override = env.MAILWARDEN_BRIDGE_DIR;
  if (override) return exists(override) ? override : null;
  return candidates.find((c) => exists(c)) ?? null;
}

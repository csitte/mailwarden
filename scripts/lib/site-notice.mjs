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
 * Does the body name this version? Bounded on both sides so `0.1.0` is never read out of `0.10.0`
 * and a `v` prefix still counts. The version is escaped — its dots are literal, not wildcards.
 *
 * The two sides are deliberately asymmetric. A trailing hyphen is refused because that is exactly
 * how a *different* thing spells itself: `0.11.0-dev.<sha>` is the unreleased-main bundle, and a
 * message about it must not read as an announcement of the release. Nothing analogous sits in front,
 * so a leading hyphen stays allowed. The cost is that a German compound (`das 0.11.0-Release`) is not
 * counted on its own — cheap, because every real announcement names the version plainly somewhere,
 * and the failure direction is the safe one: a second look, not a page left stale.
 *
 * A trailing dot is refused only when a digit follows it (`0.11.0.1` is a different version). A dot
 * that ends the sentence is the single most common way to write a version and has to keep counting.
 */
export function mentionsVersion(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])v?${escaped}(?![\\w-])(?!\\.\\d)`).test(text ?? "");
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
      if (!mentionsVersion(msg.text, version)) continue;
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

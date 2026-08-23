/**
 * Egress guard — the last place an outgoing Gmail API call can be stopped.
 *
 * `mailwarden` ships no compose/reply/forward/send tool, and that is the whole
 * security promise. Until now the promise rested on the tool surface alone: no
 * tool exists that would send, so nothing calls `messages.send`. That argument
 * is only as good as every future edit to this codebase, and it is *not* backed
 * by the OAuth scope — `gmail.modify` is a scope Google accepts for sending
 * (see SECURITY.md, threat 1). Only the `read` tier is send-proof by scope.
 *
 * So the promise gets a floor. Every authenticated request goes through the auth
 * client's `request()`; wrapping it puts one checkpoint in front of all of them,
 * no matter which code path built the request:
 *
 *   1. `FORBIDDEN` — checked first and on its own terms. These paths must never
 *      be reachable, and checking them separately means a careless future
 *      addition to the allowlist cannot quietly re-open one.
 *   2. `ALLOWED` — exactly the calls mailwarden makes today. Anything else is
 *      refused, so a newly used endpoint has to be added here deliberately
 *      rather than shipping unnoticed.
 *
 * This does not make `gmail.modify` a read-only scope: a stolen token still
 * sends mail from anywhere else. What it guarantees is that no code path *in
 * this server* can, whatever a prompt-injected mail talks a model into asking
 * for.
 */

import { ToolError } from "./cli.js";

/** Gmail API hosts googleapis may route to. The path check is what really decides. */
const GMAIL_HOSTS = new Set(["gmail.googleapis.com", "www.googleapis.com"]);

/** Google's OAuth endpoints: token refresh and revocation, never mailbox data. */
const OAUTH_HOSTS = new Set(["oauth2.googleapis.com", "accounts.google.com"]);

/** `/gmail/v1/users/{userId}` — userId is `me` here, but the API accepts an address. */
const U = "/gmail/v1/users/[^/]+";

type Rule = { method?: string; path: RegExp; what: string };

/**
 * Never, under any circumstances. Ordered by how bad it would be: mail leaving
 * the mailbox, mail being planted in it, mail disappearing irrecoverably, and
 * settings that would arrange any of the three behind the user's back.
 */
const FORBIDDEN: Rule[] = [
  { path: new RegExp(`^${U}/(messages|drafts)/send$`), what: "sending mail" },
  { path: new RegExp(`^${U}/drafts(/|$)`), what: "composing mail" },
  { path: new RegExp(`^${U}/messages/(import|insert)$`), what: "planting mail in the mailbox" },
  {
    path: new RegExp(`^${U}/messages/batchDelete$`),
    what: "permanently deleting mail (mailwarden only ever trashes)",
  },
  {
    method: "DELETE",
    path: new RegExp(`^${U}/(messages|threads)/[^/]+$`),
    what: "permanently deleting mail (mailwarden only ever trashes)",
  },
  {
    // Filters are the one settings branch mailwarden uses; forwarding, send-as,
    // delegation, IMAP/POP and vacation replies are all exfiltration or
    // auto-reply paths and stay shut.
    path: new RegExp(`^${U}/settings/(?!filters(/|$))`),
    what: "changing mailbox settings (forwarding, send-as, delegation, IMAP/POP, vacation)",
  },
];

/** Exactly the endpoints mailwarden calls. Everything else is refused. */
const ALLOWED: Rule[] = [
  { method: "GET", path: new RegExp(`^${U}/profile$`), what: "get profile" },
  { method: "GET", path: new RegExp(`^${U}/threads$`), what: "list threads" },
  { method: "GET", path: new RegExp(`^${U}/threads/[^/]+$`), what: "get thread" },
  {
    method: "POST",
    path: new RegExp(`^${U}/threads/[^/]+/(modify|trash|untrash)$`),
    what: "modify/trash/untrash a thread",
  },
  { method: "GET", path: new RegExp(`^${U}/messages$`), what: "list messages" },
  {
    method: "POST",
    path: new RegExp(`^${U}/messages/batchModify$`),
    what: "batch-modify labels",
  },
  {
    method: "GET",
    path: new RegExp(`^${U}/messages/[^/]+/attachments/[^/]+$`),
    what: "get an attachment",
  },
  { method: "GET", path: new RegExp(`^${U}/labels$`), what: "list labels" },
  { method: "POST", path: new RegExp(`^${U}/labels$`), what: "create a label" },
  { method: "DELETE", path: new RegExp(`^${U}/labels/[^/]+$`), what: "delete a label" },
  { method: "GET", path: new RegExp(`^${U}/settings/filters$`), what: "list filters" },
  { method: "POST", path: new RegExp(`^${U}/settings/filters$`), what: "create a filter" },
  {
    method: "DELETE",
    path: new RegExp(`^${U}/settings/filters/[^/]+$`),
    what: "delete a filter",
  },
];

/**
 * The path the deny list is matched against.
 *
 * googleapis does not only build `/gmail/v1/...`. Hand a method `media` and the
 * library targets `/upload/gmail/v1/...` instead (`uploadType=resumable` lands on
 * the same path) — checked against the installed library, not assumed. Those are
 * real send paths: `users.messages.send` with `media` is how a large message is
 * uploaded, and `users.drafts.create` behaves the same way. A deny rule anchored
 * at `/gmail/v1` never sees them.
 *
 * So the deny list matches the normalised path: upload prefixes stripped, repeated
 * slashes collapsed. `ALLOWED` deliberately does *not* get this treatment and keeps
 * matching the raw path, so an upload URL can only ever be refused, never allowed.
 * The asymmetry is the point — the deny list should be as wide as the API really
 * is, the allowlist as narrow as mailwarden really is.
 */
function denyPath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/").replace(/^\/(?:resumable\/)?upload(?=\/gmail\/)/, "");
}

/**
 * Decide whether one outgoing request may leave.
 *
 * Pure, so the whole policy is testable without a network or a token: returns
 * `undefined` when the call is allowed, otherwise the reason to refuse it.
 */
export function checkEgress(method: string, url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `unparseable request URL (${url || "empty"})`;
  }
  const verb = (method || "GET").toUpperCase();
  const { hostname, pathname } = parsed;

  // Token refresh and revocation are not mailbox traffic and carry no mail.
  if (OAUTH_HOSTS.has(hostname)) return undefined;

  if (!GMAIL_HOSTS.has(hostname)) {
    return (
      `request to a non-Gmail host (${hostname}) — mailwarden's Gmail client only ever talks to Google. ` +
      "googleapis rewrites the host when GOOGLE_CLOUD_UNIVERSE_DOMAIN is set or a rootUrl option is " +
      "passed; mailwarden sets neither, so an authenticated request aimed anywhere else stops here."
    );
  }

  const deny = denyPath(pathname);
  for (const rule of FORBIDDEN) {
    if (rule.method && rule.method !== verb) continue;
    if (rule.path.test(deny)) return rule.what;
  }

  for (const rule of ALLOWED) {
    if (rule.method === verb && rule.path.test(pathname)) return undefined;
  }

  return `endpoint outside mailwarden's allowlist (${verb} ${pathname})`;
}

/** The error a refused call raises — names the endpoint and why it is shut. */
export function egressRefusal(method: string, url: string, reason: string): Error {
  return new ToolError(
    "forbidden_operation",
    `mailwarden refused its own outgoing request: ${reason}. ` +
      `(${(method || "GET").toUpperCase()} ${url}) This is a deliberate block in src/egress.ts, ` +
      "not a Gmail error — no tool should be able to reach that endpoint.",
  );
}

/** Minimal shape of the auth client this guard wraps (googleapis calls `request`). */
export type Requester = {
  request: (opts: { url?: string | URL; method?: string }) => Promise<unknown>;
};

/**
 * Put the checkpoint in front of a client's `request`. Idempotent: wrapping an
 * already-wrapped client is a no-op, so repeated `getAuth()` calls cannot stack
 * guards on the cached client.
 */
export function guardEgress<T extends Requester>(client: T): T {
  const marker = "__mailwardenEgressGuarded";
  const c = client as T & { [marker]?: boolean };
  if (c[marker]) return client;

  const original = client.request.bind(client);
  client.request = ((opts: { url?: string | URL; method?: string }) => {
    const url = String(opts?.url ?? "");
    const method = opts?.method ?? "GET";
    const reason = checkEgress(method, url);
    if (reason) return Promise.reject(egressRefusal(method, url, reason));
    return original(opts);
  }) as T["request"];

  Object.defineProperty(c, marker, { value: true, enumerable: false });
  return client;
}

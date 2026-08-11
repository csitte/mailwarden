# mailwarden

[![npm](https://img.shields.io/npm/v/mailwarden)](https://www.npmjs.com/package/mailwarden)
[![license](https://img.shields.io/npm/l/mailwarden)](LICENSE)
[![Node](https://img.shields.io/node/v/mailwarden)](package.json)
[![Website](https://img.shields.io/badge/Website-csitte.at%2Fmailwarden-2ea44f)](https://www.csitte.at/mailwarden/)
[![Available on CodeGuilds](https://img.shields.io/badge/Available_on-CodeGuilds-6366f1?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6TTIgMTdsMTAgNSAxMC01TTIgMTJsMTAgNSAxMC01Ii8+PC9zdmc+)](https://codeguilds.dev/packages/mailwarden)

A reliable, **native** Gmail [MCP](https://modelcontextprotocol.io) server — full mailbox triage for AI assistants, with the feature nobody else ships: **snooze**.

## Highlights

- **Snooze — the feature nobody else ships.** Archive a thread now, have it resurface in the inbox
  on a date. Built on dated labels + a sweep, so it works from any client and survives restarts.
- **Search you can trust.** Gmail's own search index silently drops `is:unread` in some operator
  combinations — `search` re-verifies every hit against its live labels and discards the index's
  false positives. Paginated via `pageToken`/`nextPageToken`.
- **Bulk operations that scale.** `bulk_modify` archives/labels everything matching a query at
  1000 messages per API request — with per-chunk partial-success reporting instead of
  all-or-nothing. The snooze sweep uses the same batch path.
- **Structured outputs.** Every tool declares an `outputSchema` and returns validated
  `structuredContent` alongside fenced JSON text — no parsing guesswork for clients.
- **Small attack surface.** No send tools (no exfiltration path for prompt-injected mail),
  optional read-only mode, no telemetry, no open ports by default, symlink-safe download fencing,
  injection-fenced output. Details under [Security & privacy](#security--privacy).
- **Correct with real-world mail.** RFC 2047 headers decoded (`=?UTF-8?B?…?=` → readable text),
  bodies decoded in their *declared* charset (no mojibake for ISO-8859-1/Shift_JIS mail),
  429/5xx retried with exponential backoff.

## Why

Connectors that sync or cache your mailbox can lag behind it — and even Gmail's own search index is sometimes loose (see below). `mailwarden` talks straight to the live Gmail API (no cached snapshot) and re-verifies what the index returns, so what you see is what's actually there. It's a generic Gmail capability layer — keep your own rules/logic in your AI client, not in the server.

`search` goes one step further than the raw API: Gmail's `threads.list` index is sometimes *loose* for read-state operators — `is:unread` is silently dropped in some operator combinations (e.g. `category:updates is:unread -in:inbox` returns read mail too). Since every hit is fetched live anyway, `search` re-checks the unambiguous predicates (`is:unread`/`is:read`/`is:starred`/`in:inbox`/`category:…`, with negation) against each thread's true labels and drops the index's false positives.

## Compared to other Gmail MCP servers

Most Gmail MCP servers cover the same read/label/send surface. Two capabilities are still unique to `mailwarden`, and one deliberate omission is a security feature, not a gap.

| Capability | **mailwarden** | [taylorwilsdon](https://github.com/taylorwilsdon/google_workspace_mcp) | [Google official](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) | mcpemails.com |
|---|:--:|:--:|:--:|:--:|
| **Snooze** — defer a thread back to the inbox on a date/time or preset | ✅ | — | — | — |
| **Search-result re-verification** — drops the index's false positives against live labels | ✅ | — | — | — |
| **Sweep / bulk over a query** — one action across every matching thread | ✅ 1000/req, partial-success | — | — | ⚠️ bulk organize (no query re-verification) |
| **No send tools — by design** — a prompt-injected mail has no exfiltration path | ✅ no compose at all | ❌ sends | ⚠️ draft-only | ❌ sends |
| **Least-privilege tool tiers** — OAuth scopes derived from the tools you enable | ✅ | — | ⚠️ scope split | ⚠️ scoped keys |
| **Token encryption at rest** (optional) | ✅ AES-256-GCM | ✅ | n/a (hosted) | ✅ AES-256-GCM |
| **Runs fully local — no cloud copy of your mail** | ✅ | ✅ | ❌ hosted | ❌ SaaS |
| **Structured outputs** — every tool declares an `outputSchema` | ✅ | — | — | — |

<sub>Snapshot as of August 2026, from each project's public docs/repo; `—` = not offered / not documented. Send capability is listed as a security property: `mailwarden`'s lack of it is intentional (see [Security & privacy](#security--privacy)).</sub>

The moat isn't any single row — it's **snooze + live re-verification together**: an actual inbox-workflow layer that acts on the mailbox's *current* state, not a cached snapshot. Where competitors have caught up (bulk actions, at-rest encryption) it's noted honestly above.

### Why re-verification matters — a concrete case

Ask an assistant to *"archive the unread promotional mail that's already skipped my inbox"* and it will reach for the obvious query, `category:updates is:unread -in:inbox`. Gmail's `threads.list` index answers **loosely** here: it silently drops the `is:unread` constraint and hands back read mail too. A server that trusts the index now archives threads you'd already read — mail you never meant to touch, gone in a bulk action you can't easily reverse.

`mailwarden` fetches every hit live anyway, so `search` re-checks the unambiguous predicates (`is:unread`, `is:read`, `in:inbox`, `category:…`, with negation) against each thread's **true** labels and drops the index's false positives before any tool sees them. The bulk action then runs on exactly the set you asked for. This is the difference between acting on what Gmail *indexed* and acting on what's *actually in the mailbox right now* — and it's why snooze/sweep are safe to hand to an assistant: the sweep resurfaces only threads whose snooze is genuinely due, verified against live labels at run time.

**See it yourself — no Gmail account needed.** From a clone of the repo (the demo is a repo-only
verification script, not part of the npm package):

```bash
git clone https://github.com/csitte/mailwarden && cd mailwarden
npm install && npm run build
node scripts/demo-reverify.mjs
```

The demo drives the real `search()` against a fake Gmail API whose index is deliberately loose (returns a read thread for an `is:unread` query, exactly as Gmail does) and shows mailwarden dropping the false positive. It asserts the outcome, so it exits non-zero if the behavior ever regresses. The same case is locked by unit tests in [`test/gmail.test.ts`](https://github.com/csitte/mailwarden/blob/main/test/gmail.test.ts) (*"drops index false positives via live-label re-verify"*).

## Tools

| Tool | What it does |
|---|---|
| `search` | Gmail query syntax → thread summaries (from/subject/date/labels/snippet); read-state/category predicates are re-verified against each hit's live labels; paginated via `pageToken`/`nextPageToken` |
| `get_thread` | Full thread: headers, plaintext + HTML bodies, attachment metadata |
| `list_labels` | All labels (system + user) |
| `get_profile` | Connected account's address + total message/thread counts — confirm *which* mailbox is wired up before acting |
| **`triage_digest`** | Structured overview of a mailbox slice for *decisions*: top senders, label and age buckets, unread + attachment counts — instead of a raw thread list |
| `list_unsubscribe` | What opt-out options a thread advertises (`List-Unsubscribe`) — contacts nobody |
| `create_label` | Create a user label (idempotent; nested via `Parent/Child`) and return its id |
| `modify_labels` | Add/remove labels by **name or id** — an unknown name in `add` is auto-created (archive = remove `INBOX`, read = remove `UNREAD`) |
| **`bulk_modify`** | Batch label changes for every message matching a query — 1000 messages per API request, partial success reported per chunk (thread-id list capped at 500, `modifiedThreadCount` has the total) |
| `archive` / `mark_read` / `mark_unread` | Convenience wrappers |
| `trash` / `untrash` | Move to / restore from Trash |
| `download_attachment` | Save an attachment to a local path (never overwrites — collisions get a numeric suffix) |
| **`unsubscribe`** | One-click opt-out (RFC 8058) using the endpoint from the message's own header — the only tool that contacts a non-Google host ([details](#unsubscribing--the-one-outbound-request)) |
| **`snooze`** | Archive now, resurface on/after a date (`YYYY-MM-DD`), a date+time (`2026-06-20 9am`), or a preset (`tomorrow`, `tomorrow 9am`, `weekend`, `next week`, a weekday name, `in N days`, `in N hours`) |
| **`unsnooze`** | Cancel a snooze, return to inbox now |
| **`list_snoozed`** | All snoozed threads + due dates |
| **`sweep_snoozed`** | Resurface threads whose snooze is due (run on demand, via cron, or the daemon); batched, with partial-failure reporting |
| `list_filters` | All Gmail filters (criteria + label actions); surfaces any `forward` address on existing filters for auditing |
| `create_filter` | Create a server-side auto-triage rule (criteria → label actions only; **no forwarding** — see below). Optionally `applyToExisting` to also sweep matching mail already in the mailbox |
| `delete_filter` | Delete a filter by id |

All tools declare an `outputSchema` and return **structured content** (validated, machine-readable)
alongside the same JSON as fenced text — clients never have to parse prose.

### How snooze works (no Gmail API snooze exists — we build it)

`snooze` removes `INBOX` and applies a dated label `MCP/Snoozed/<key>`, where the key is either `YYYY-MM-DD` (due all day) or `YYYY-MM-DDTHHMM` (due at that local minute). The `until` argument takes an explicit date, a date+time (`2026-06-20 9am`, `…T17:00`), or a preset resolved server-side — `today`, `tomorrow`, `weekend` (next Saturday), `next week` (next Monday), a weekday name (`monday`–`sunday`, next occurrence), `in N days`, or `in N hours` — and a date preset may carry a trailing time (`tomorrow 9am`, `monday 8:30`), so the caller never has to compute the moment itself. `sweep_snoozed` finds due labels and returns those threads to the inbox (marked unread); a timed snooze wakes at the first sweep on/after its minute, so wake latency equals your sweep interval. Run the sweep:
- on demand (`sweep_snoozed` tool),
- via cron: `mailwarden --sweep`,
- or automatically: set `MAILWARDEN_AUTO_SWEEP=1` (hourly sweep while the server runs).

### Filters (persistent auto-triage rules)

`create_filter` sets up a Gmail server-side rule: mail matching the criteria automatically gets the
given label actions — the mailbox keeps triaging itself with no assistant in the loop.

- **Criteria:** `from`, `to`, `subject`, `query` (full Gmail search syntax), `negatedQuery`,
  `hasAttachment`, `excludeChats`, and `size` + `sizeComparison` (`smaller`/`larger`, given together).
  At least one is required.
- **Actions (label only):** `addLabels` / `removeLabels`, by name or id (an unknown name in
  `addLabels` is auto-created, nested via `/`). Common recipes: skip the inbox → `removeLabels: ["INBOX"]`;
  auto-mark-read → `removeLabels: ["UNREAD"]`; auto-trash → `addLabels: ["TRASH"]`;
  star → `addLabels: ["STARRED"]`; never-spam → `removeLabels: ["SPAM"]`; file under a label → `addLabels: ["Receipts"]`.
- **Existing mail:** a filter only runs on messages arriving *after* it's created. Pass
  `applyToExisting: true` to also apply the same actions once to mail already in the mailbox —
  mailwarden builds a Gmail search from the criteria and runs a bulk modify (up to `maxMessages`,
  default 1000; same loose-index caveat as `bulk_modify`, and the one-off pass excludes Spam/Trash).
  This requires at least one *positive* criterion (`from`/`to`/`subject`/`query`/`hasAttachment:true`/`size`):
  an exclusion-only rule (`negatedQuery` or `hasAttachment:false`) is refused for `applyToExisting`
  because it would match almost the whole mailbox — create such a filter without the flag.
  The outcome comes back under `applied` (the `query` used, `matchedMessages`/`modifiedMessages`/`modifiedThreadCount`
  counts, `capped` when the match set hit `maxMessages`, per-chunk `failed`, and an `error` string if the whole
  pass failed); it's `null` when `applyToExisting` was not set. The filter is created first, so a partial or
  failed backlog pass is *reported* in `applied`, never raised — the rule still stands.
- **No forwarding** — see [Security & privacy](#security--privacy).
- Requires the `gmail.settings.basic` scope; re-run `--auth` once if you authorized an older version.
  Not available in read-only mode.

### Unsubscribing — the one outbound request

`list_unsubscribe` (read tier) reports what the sender offers, without contacting anyone. It reads the
newest message that actually carries a `List-Unsubscribe` header — a reply threaded onto a newsletter
sits at the end and advertises nothing, which would otherwise read as "this list has no opt-out". `unsubscribe` (manage tier) acts on it — and
it is the **only** place mailwarden ever talks to a host that isn't Google, so the rules are tight:

- **There is no URL parameter.** The endpoint comes from the message's own header and nowhere else.
  A URL argument would let a prompt-injected mail turn the tool into an exfiltration channel
  (mailbox content in a query string); the header cannot carry data the model chose.
- **Only RFC 8058 one-click** is performed — the sender must have opted in via `List-Unsubscribe-Post`.
  A plain `https:` link is meant for a human in a browser and is handed back, not fetched.
- **`mailto:` opt-outs are never performed.** They would require sending mail, which mailwarden cannot
  do. The address is reported so you can act on it yourself.
- **Fixed request, discarded response.** The POST body is always `List-Unsubscribe=One-Click` and is
  never derived from anything; the response body is cancelled unread. What returns to the model is the
  status code and the URL actually called — no content from the endpoint, so it cannot answer with
  instructions. (A 301/302/303 redirect is followed as a GET, i.e. with no body at all.)
- **SSRF guards.** https only, default port only, no credentials in the URL, and every hop — including
  redirects, followed at most 3 times — must resolve exclusively to globally reachable addresses. The
  check parses each address to its bytes and matches it against the IANA special-purpose registry, so
  every spelling of the same address gets the same verdict (`::1` and `0:0:0:0:0:0:0:1` alike); an
  address that does not parse is refused. DNS resolution and all hops share one 10-second budget. Not
  rebinding-proof (`fetch` resolves again when it connects) — see [SECURITY.md](SECURITY.md); what
  survives that gap is a blind POST whose response is never read.

**Check it against your own mail before you trust it.** From a repo clone (repo-only, not in the
npm package), after `npm run build` and `mailwarden --auth`:

```bash
node scripts/probe-unsubscribe.mjs --vet          # category:promotions, 25 threads
node scripts/probe-unsubscribe.mjs "from:substack.com" --max 50 --vet
```

It prints each real `List-Unsubscribe` header next to what the parser made of it, and `--vet` also
runs the endpoint through the URL vetting and the address guard — so you see both whether the parser
understood the header *and* whether the guards would have let that opt-out through. Strictly
read-only: no request is ever made to a sender, and nothing in the mailbox changes.

What it can't undo: the request tells the sender your address is live. A sender that ignores its own
opt-out is beyond any client's reach — pair `unsubscribe` with `create_filter` or `trash` for those.
Not offering an automatable option is reported as `unsubscribed:false` with the alternatives, not as an
error. A `read`-only deployment gets `list_unsubscribe` and never makes the request at all.

## Security & privacy

> For the full threat model — trust boundary, per-threat mitigations, explicit non-goals, and how to
> report a vulnerability — see **[SECURITY.md](SECURITY.md)**. The highlights:

- **No telemetry.** Nothing phones home — no analytics, no crash reporting, no tracking.
- **No open ports by default.** stdio only. The optional `--http` listener binds to `127.0.0.1`
  (not the LAN) and **refuses to start without a `MAILWARDEN_TOKEN`** bearer token — set
  `MAILWARDEN_ALLOW_NO_TOKEN=1` to override on a trusted, isolated network. On a loopback bind it
  also validates the `Host` header (DNS-rebinding defense). For remote hosting, set `MAILWARDEN_HOST`
  and front it with TLS.
- **No send tools — by design.** mailwarden cannot compose, reply, or forward. A prompt-injected
  instruction inside an email has no exfiltration path through this server. `create_filter` follows
  the same rule: it can label, archive, trash, star or mark mail, but **never** creates a *forwarding*
  filter (which would be an exfiltration path). `list_filters` still surfaces any forwarding filter
  already on the account, so you can spot one.
- **One outbound host, no model-chosen URL.** The `unsubscribe` tool is the only code path that
  contacts a non-Google host. Its endpoint is read from the message's `List-Unsubscribe` header —
  never from a tool argument — the request body is fixed and the response body is discarded, so it
  cannot become a data channel. https/default-port only, redirects re-validated, and any hop resolving
  to a private, loopback, link-local or metadata address is refused. See
  [Unsubscribing](#unsubscribing--the-one-outbound-request).
- **Tool tiers (progressive disclosure + least scope).** `MAILWARDEN_TOOLS` advertises only the tiers
  you name — `read` (the read tools), `manage` (mailbox mutations, snooze, downloads), `filters`
  (server-side filter CRUD, the only tier whose tools need `gmail.settings.basic`). Default is all
  three; e.g. `read,manage` gives a full triage surface without filter management. The **OAuth scopes
  requested at `--auth` are derived from the enabled tiers** — a `read` deployment asks only for
  `gmail.readonly`, and `gmail.settings.basic` is requested only when the `filters` tier is on. And the
  filter tools are **hidden automatically** when the stored token doesn't carry `gmail.settings.basic`
  (e.g. a token authorized before you enabled the tier) — re-run `--auth` to grant it. Older tokens
  without a recorded scope are advertised as before, with the runtime insufficient-scope message as the
  fallback.
- **Read-only mode.** Set `MAILWARDEN_READONLY=1` (shorthand for `MAILWARDEN_TOOLS=read`) and only the
  read tools (`search`, `get_thread`, `list_labels`, `list_snoozed`, `get_profile`, `triage_digest`,
  `list_unsubscribe`)
  are registered — nothing that can change the mailbox or write
  files is even advertised to clients (the filter tools, which need the broader `gmail.settings.basic`
  scope, are excluded too). Recommended for shared/HTTP deployments that only triage.
- **Fenced downloads.** With `MAILWARDEN_DOWNLOAD_DIR` set, attachment writes are confined to that
  directory (realpath-canonicalized, symlink-aware) and never overwrite an existing file.
- **Untrusted-content fencing.** Every tool result is wrapped in `<untrusted-tool-output>` markers
  and stripped of invisible/BiDi-override characters, so clients can tell quoted mail content from
  instructions.
- **Live API, no copy.** No mailbox mirror or search index is stored anywhere. The only local state
  is your OAuth token in `~/.mailwarden/`.
- **Optional token encryption at rest.** `token.json` holds a refresh token; on disk it is protected
  only by `mode 0o600` (a no-op on Windows). Set `MAILWARDEN_TOKEN_PASSPHRASE` to a passphrase and the token
  is stored AES-256-GCM-encrypted (scrypt-derived key), so a *copy* of the file — a backup, a synced
  folder, another machine — is useless without the passphrase. Re-run `mailwarden --auth` once after
  setting it to encrypt the existing token. Note the boundary: this defends against file theft, **not**
  against malware running as your user (which can read the passphrase from the environment too).

## Quick start

```bash
claude mcp add mailwarden -- npx -y mailwarden
```

That's the whole install — `npx` fetches and runs the published package, no clone or build step. You only need Google OAuth credentials once (below).

## Setup

First time setting up a Google OAuth app? Follow the **[step-by-step setup guide](https://github.com/csitte/mailwarden/blob/main/docs/SETUP.md)** — it walks through the Google Cloud Console with exact click paths, explains the "unverified app" screen, and covers the trap that makes tokens die after 7 days. The short version:

1. **Google Cloud:** create a project → enable the **Gmail API** → configure the OAuth consent screen and **publish it to Production** (in *Testing* status, Google expires refresh tokens after 7 days) → create an **OAuth client ID** of type *Desktop app* → download it as `credentials.json`.
2. Put `credentials.json` in `~/.mailwarden/` (or set `MAILWARDEN_CREDENTIALS=/path/to/credentials.json`).
3. Authorize once — opens a browser, stores a refresh token in `~/.mailwarden/token.json`:
   ```bash
   npx -y mailwarden --auth
   ```
   Scopes requested: `gmail.modify` (read + label/archive/trash) and `gmail.settings.basic`
   (filter management — grants no send capability). If you authorized a version before filters
   existed, re-run `--auth` once to grant the added scope.
4. **Verify the setup** any time with the built-in doctor:
   ```bash
   npx -y mailwarden --check
   ```
   It checks `credentials.json`, whether a token exists (and if it's encrypted), whether the
   granted scopes cover your enabled tiers, and makes one live Gmail call to prove the token
   still works — printing a concrete fix for anything that's wrong, and exiting non-zero if so
   (handy in CI/health checks). Diagnoses the common traps: no/`wrong` credentials file, never
   authorized, an encrypted token with no `MAILWARDEN_TOKEN_PASSPHRASE`, a missing scope, or the
   7-day "Testing"-consent token expiry.

## Connect

**Claude Code** (local stdio):
```bash
claude mcp add mailwarden -- npx -y mailwarden
```

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mailwarden": { "command": "npx", "args": ["-y", "mailwarden"] }
  }
}
```

**Remote (Streamable HTTP)** — for a VPS / claude.ai custom connector:
```bash
# Loopback + token required by default. For real hosting, bind outward and keep the token:
MAILWARDEN_TOKEN=<secret> MAILWARDEN_HOST=0.0.0.0 npx -y mailwarden --http   # :8787/mcp
```
Then in claude.ai: Settings → Connectors → *Add custom connector* → your `https://your-host/mcp` URL. In Claude Code: `claude mcp add --transport http mailwarden https://your-host/mcp`.

## Multiple accounts

One OAuth app (one `credentials.json`) can authorize several Gmail accounts. Each account keeps its
own refresh token in a separate file, selected by `MAILWARDEN_ACCOUNT`:

```bash
mailwarden --auth --account work        # stores token.work.json
mailwarden --auth --account personal    # stores token.personal.json
```

Run them side by side by registering the server **once per account**, each with its own
`MAILWARDEN_ACCOUNT`. Every instance is fully isolated — its own token, its own granted scopes, its
own tool surface — so nothing can act on the wrong mailbox:

```json
{
  "mcpServers": {
    "gmail-work":     { "command": "npx", "args": ["-y", "mailwarden"], "env": { "MAILWARDEN_ACCOUNT": "work" } },
    "gmail-personal": { "command": "npx", "args": ["-y", "mailwarden"], "env": { "MAILWARDEN_ACCOUNT": "personal" } }
  }
}
```

Account names are **case-insensitive** — they become filenames, so `Work` and `work` would be the
same file on Windows/macOS. mailwarden lower-cases them (`--account Work` → `token.work.json`) so a
name always maps to exactly one mailbox.

`mailwarden --check` shows the active account and lists the others it finds. With no
`MAILWARDEN_ACCOUNT` set, everything uses the default `token.json` exactly as before — this is fully
backward compatible.

## From source

```bash
git clone https://github.com/csitte/mailwarden && cd mailwarden
npm install && npm run build
node dist/index.js --auth
```

## Config (env)

| Var | Meaning |
|---|---|
| `MAILWARDEN_DIR` | config dir (default `~/.mailwarden`) |
| `MAILWARDEN_CREDENTIALS` | path to `credentials.json` |
| `MAILWARDEN_ACCOUNT` | select a named account (its token is `token.<name>.json`; names are lower-cased); unset = the default `token.json`. See [Multiple accounts](#multiple-accounts) |
| `MAILWARDEN_TOKEN_PASSPHRASE` | passphrase → encrypt `token.json` at rest (AES-256-GCM); re-run `--auth` after setting |
| `MAILWARDEN_AUTO_SWEEP` | `1` → snooze sweep at startup + hourly while running (writes labels — needs the `manage`/`gmail.modify` scope; a `read`-only grant can't sweep) |
| `MAILWARDEN_DOWNLOAD_DIR` | restrict `download_attachment` to this directory (strongly recommended for HTTP hosting) |
| `MAILWARDEN_READONLY` | `1` → register only the read tools (search/get_thread/list_labels/list_snoozed/get_profile/triage_digest/list_unsubscribe). Shorthand for `MAILWARDEN_TOOLS=read` |
| `MAILWARDEN_TOOLS` | comma-separated tool tiers to advertise: `read`, `manage`, `filters` (default: all). Also derives the OAuth scopes requested at `--auth`. E.g. `read,manage` drops the filter tools and their `gmail.settings.basic` scope |
| `MAILWARDEN_DEBUG` | `1` → print full errors with stack traces instead of a one-line message (for bug reports) |
| `PORT` | HTTP port (default 8787) |
| `MAILWARDEN_HOST` | HTTP bind address (default `127.0.0.1`; set e.g. `0.0.0.0` for remote hosting) |
| `MAILWARDEN_TOKEN` | bearer token for the HTTP endpoint — **required** for `--http` unless overridden |
| `MAILWARDEN_ALLOW_NO_TOKEN` | `1` → allow `--http` without a token (trusted/isolated networks only) |
| `MAILWARDEN_ALLOWED_HOSTS` | extra comma-separated `host:port` values accepted by the loopback `Host` allowlist |

## Status

Working and used in daily mailbox automation. Core Gmail tools + snooze implemented against `googleapis`, covered by a vitest suite (430 tests — `npm run coverage`). Current version: see the npm badge above, the [changelog](https://github.com/csitte/mailwarden/blob/main/CHANGELOG.md), or [releases](https://github.com/csitte/mailwarden/releases). PRs welcome.

## License

MIT © C.Sitte Softwaretechnik

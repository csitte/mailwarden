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

## Tools

| Tool | What it does |
|---|---|
| `search` | Gmail query syntax → thread summaries (from/subject/date/labels/snippet); read-state/category predicates are re-verified against each hit's live labels; paginated via `pageToken`/`nextPageToken` |
| `get_thread` | Full thread: headers, plaintext + HTML bodies, attachment metadata |
| `list_labels` | All labels (system + user) |
| `get_profile` | Connected account's address + total message/thread counts — confirm *which* mailbox is wired up before acting |
| `create_label` | Create a user label (idempotent; nested via `Parent/Child`) and return its id |
| `modify_labels` | Add/remove labels by **name or id** — an unknown name in `add` is auto-created (archive = remove `INBOX`, read = remove `UNREAD`) |
| **`bulk_modify`** | Batch label changes for every message matching a query — 1000 messages per API request, partial success reported per chunk (thread-id list capped at 500, `modifiedThreadCount` has the total) |
| `archive` / `mark_read` / `mark_unread` | Convenience wrappers |
| `trash` / `untrash` | Move to / restore from Trash |
| `download_attachment` | Save an attachment to a local path (never overwrites — collisions get a numeric suffix) |
| **`snooze`** | Archive now, resurface on/after a date (`YYYY-MM-DD`) |
| **`unsnooze`** | Cancel a snooze, return to inbox now |
| **`list_snoozed`** | All snoozed threads + due dates |
| **`sweep_snoozed`** | Resurface threads whose snooze is due (run on demand, via cron, or the daemon); batched, with partial-failure reporting |
| `list_filters` | All Gmail filters (criteria + label actions); surfaces any `forward` address on existing filters for auditing |
| `create_filter` | Create a server-side auto-triage rule (criteria → label actions only; **no forwarding** — see below). Optionally `applyToExisting` to also sweep matching mail already in the mailbox |
| `delete_filter` | Delete a filter by id |

All tools declare an `outputSchema` and return **structured content** (validated, machine-readable)
alongside the same JSON as fenced text — clients never have to parse prose.

### How snooze works (no Gmail API snooze exists — we build it)

`snooze` removes `INBOX` and applies a dated label `MCP/Snoozed/<YYYY-MM-DD>`. `sweep_snoozed` finds due labels and returns those threads to the inbox (marked unread). Run the sweep:
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

## Security & privacy

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
- **Read-only mode.** Set `MAILWARDEN_READONLY=1` and only the read tools (`search`, `get_thread`,
  `list_labels`, `list_snoozed`, `get_profile`) are registered — nothing that can change the mailbox or write
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

First time setting up a Google OAuth app? Follow the **[step-by-step setup guide](docs/SETUP.md)** — it walks through the Google Cloud Console with exact click paths, explains the "unverified app" screen, and covers the trap that makes tokens die after 7 days. The short version:

1. **Google Cloud:** create a project → enable the **Gmail API** → configure the OAuth consent screen and **publish it to Production** (in *Testing* status, Google expires refresh tokens after 7 days) → create an **OAuth client ID** of type *Desktop app* → download it as `credentials.json`.
2. Put `credentials.json` in `~/.mailwarden/` (or set `MAILWARDEN_CREDENTIALS=/path/to/credentials.json`).
3. Authorize once — opens a browser, stores a refresh token in `~/.mailwarden/token.json`:
   ```bash
   npx -y mailwarden --auth
   ```
   Scopes requested: `gmail.modify` (read + label/archive/trash) and `gmail.settings.basic`
   (filter management — grants no send capability). If you authorized a version before filters
   existed, re-run `--auth` once to grant the added scope.

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
| `MAILWARDEN_TOKEN_PASSPHRASE` | passphrase → encrypt `token.json` at rest (AES-256-GCM); re-run `--auth` after setting |
| `MAILWARDEN_AUTO_SWEEP` | `1` → snooze sweep at startup + hourly while running |
| `MAILWARDEN_DOWNLOAD_DIR` | restrict `download_attachment` to this directory (strongly recommended for HTTP hosting) |
| `MAILWARDEN_READONLY` | `1` → register only the read tools (search/get_thread/list_labels/list_snoozed/get_profile) |
| `PORT` | HTTP port (default 8787) |
| `MAILWARDEN_HOST` | HTTP bind address (default `127.0.0.1`; set e.g. `0.0.0.0` for remote hosting) |
| `MAILWARDEN_TOKEN` | bearer token for the HTTP endpoint — **required** for `--http` unless overridden |
| `MAILWARDEN_ALLOW_NO_TOKEN` | `1` → allow `--http` without a token (trusted/isolated networks only) |
| `MAILWARDEN_ALLOWED_HOSTS` | extra comma-separated `host:port` values accepted by the loopback `Host` allowlist |

## Status

Working and used in daily mailbox automation. Core Gmail tools + snooze implemented against `googleapis`, covered by a vitest suite (169 tests — `npm run coverage`). Current version: see the npm badge above, the [changelog](CHANGELOG.md), or [releases](https://github.com/csitte/mailwarden/releases). PRs welcome.

## License

MIT © C.Sitte Softwaretechnik

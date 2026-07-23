# mailwarden

[![npm](https://img.shields.io/npm/v/mailwarden)](https://www.npmjs.com/package/mailwarden)
[![license](https://img.shields.io/npm/l/mailwarden)](LICENSE)
[![Node](https://img.shields.io/node/v/mailwarden)](package.json)

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
| `modify_labels` | Add/remove labels (archive = remove `INBOX`, read = remove `UNREAD`) |
| **`bulk_modify`** | Batch label changes for every message matching a query — 1000 messages per API request, partial success reported per chunk (thread-id list capped at 500, `modifiedThreadCount` has the total) |
| `archive` / `mark_read` / `mark_unread` | Convenience wrappers |
| `trash` / `untrash` | Move to / restore from Trash |
| `download_attachment` | Save an attachment to a local path (never overwrites — collisions get a numeric suffix) |
| **`snooze`** | Archive now, resurface on/after a date (`YYYY-MM-DD`) |
| **`unsnooze`** | Cancel a snooze, return to inbox now |
| **`list_snoozed`** | All snoozed threads + due dates |
| **`sweep_snoozed`** | Resurface threads whose snooze is due (run on demand, via cron, or the daemon); batched, with partial-failure reporting |

All tools declare an `outputSchema` and return **structured content** (validated, machine-readable)
alongside the same JSON as fenced text — clients never have to parse prose.

### How snooze works (no Gmail API snooze exists — we build it)

`snooze` removes `INBOX` and applies a dated label `MCP/Snoozed/<YYYY-MM-DD>`. `sweep_snoozed` finds due labels and returns those threads to the inbox (marked unread). Run the sweep:
- on demand (`sweep_snoozed` tool),
- via cron: `mailwarden --sweep`,
- or automatically: set `MAILWARDEN_AUTO_SWEEP=1` (hourly sweep while the server runs).

## Security & privacy

- **No telemetry.** Nothing phones home — no analytics, no crash reporting, no tracking.
- **No open ports by default.** stdio only; an HTTP listener exists solely behind an explicit
  `--http`, optionally gated by a `MAILWARDEN_TOKEN` bearer token.
- **No send tools — by design.** mailwarden cannot compose, reply, or forward. A prompt-injected
  instruction inside an email has no exfiltration path through this server.
- **Read-only mode.** Set `MAILWARDEN_READONLY=1` and only the read tools (`search`, `get_thread`,
  `list_labels`, `list_snoozed`) are registered — nothing that can change the mailbox or write
  files is even advertised to clients. Recommended for shared/HTTP deployments that only triage.
- **Fenced downloads.** With `MAILWARDEN_DOWNLOAD_DIR` set, attachment writes are confined to that
  directory (realpath-canonicalized, symlink-aware) and never overwrite an existing file.
- **Untrusted-content fencing.** Every tool result is wrapped in `<untrusted-tool-output>` markers
  and stripped of invisible/BiDi-override characters, so clients can tell quoted mail content from
  instructions.
- **Live API, no copy.** No mailbox mirror or search index is stored anywhere. The only local state
  is your OAuth token in `~/.mailwarden/`.

## Quick start

```bash
claude mcp add mailwarden -- npx -y mailwarden
```

That's the whole install — `npx` fetches and runs the published package, no clone or build step. You only need Google OAuth credentials once (below).

## Setup

1. **Google Cloud:** create a project → enable the **Gmail API** → configure the OAuth consent screen → create an **OAuth client ID** of type *Desktop app* → download it as `credentials.json`.
2. Put `credentials.json` in `~/.mailwarden/` (or set `MAILWARDEN_CREDENTIALS=/path/to/credentials.json`).
3. Authorize once — opens a browser, stores a refresh token in `~/.mailwarden/token.json`:
   ```bash
   npx -y mailwarden --auth
   ```
   Scope requested: `https://www.googleapis.com/auth/gmail.modify`.

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
npx -y mailwarden --http     # listens on :8787/mcp ; set PORT, optional MAILWARDEN_TOKEN bearer gate
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
| `MAILWARDEN_AUTO_SWEEP` | `1` → snooze sweep at startup + hourly while running |
| `MAILWARDEN_DOWNLOAD_DIR` | restrict `download_attachment` to this directory (strongly recommended for HTTP hosting) |
| `MAILWARDEN_READONLY` | `1` → register only the read tools (search/get_thread/list_labels/list_snoozed) |
| `PORT` | HTTP port (default 8787) |
| `MAILWARDEN_TOKEN` | optional bearer token for the HTTP endpoint |

## Status

`0.1.7` — working. Core Gmail tools + snooze implemented against `googleapis` and used in daily mailbox automation. Covered by a vitest suite (116 tests, ~99 % statement coverage — `npm run coverage`). See the [changelog](CHANGELOG.md) / [releases](https://github.com/csitte/mailwarden/releases). PRs welcome.

## License

MIT © C.Sitte Softwaretechnik

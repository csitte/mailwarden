# mailwarden

A reliable, **native** Gmail [MCP](https://modelcontextprotocol.io) server — full mailbox control for AI assistants, with the feature nobody else ships: **snooze**.

Every operation hits the **live Gmail API** (no cached snapshot), so it reliably sees *all* your mail — search, read, label, archive, trash, download attachments, and snooze threads until a date.

## Why

Hosted Gmail connectors run on a synced index that can silently miss messages. `mailwarden` talks straight to the Gmail API, so what you see is what's there. It's a generic Gmail capability layer — keep your own rules/logic in your AI client, not in the server.

`search` goes one step further than the raw API: Gmail's `threads.list` index is sometimes *loose* for read-state operators — `is:unread` is silently dropped in some operator combinations (e.g. `category:updates is:unread -in:inbox` returns read mail too). Since every hit is fetched live anyway, `search` re-checks the unambiguous predicates (`is:unread`/`is:read`/`is:starred`/`in:inbox`/`category:…`, with negation) against each thread's true labels and drops the index's false positives.

## Tools

| Tool | What it does |
|---|---|
| `search` | Gmail query syntax → thread summaries (from/subject/date/labels/snippet); read-state/category predicates are re-verified against each hit's live labels |
| `get_thread` | Full thread: headers, plaintext + HTML bodies, attachment metadata |
| `list_labels` | All labels (system + user) |
| `modify_labels` | Add/remove labels (archive = remove `INBOX`, read = remove `UNREAD`) |
| `archive` / `mark_read` / `mark_unread` | Convenience wrappers |
| `trash` / `untrash` | Move to / restore from Trash |
| `download_attachment` | Save an attachment to a local path |
| **`snooze`** | Archive now, resurface on/after a date (`YYYY-MM-DD`) |
| **`unsnooze`** | Cancel a snooze, return to inbox now |
| **`list_snoozed`** | All snoozed threads + due dates |
| **`sweep_snoozed`** | Resurface threads whose snooze is due (run on demand, via cron, or the daemon) |

### How snooze works (no Gmail API snooze exists — we build it)

`snooze` removes `INBOX` and applies a dated label `MCP/Snoozed/<YYYY-MM-DD>`. `sweep_snoozed` finds due labels and returns those threads to the inbox (marked unread). Run the sweep:
- on demand (`sweep_snoozed` tool),
- via cron: `mailwarden --sweep`,
- or automatically: set `MAILWARDEN_AUTO_SWEEP=1` (hourly sweep while the server runs).

## Setup

1. **Google Cloud:** create a project → enable the **Gmail API** → configure the OAuth consent screen → create an **OAuth client ID** of type *Desktop app* → download it as `credentials.json`.
2. Put `credentials.json` in `~/.mailwarden/` (or set `MAILWARDEN_CREDENTIALS=/path/to/credentials.json`).
3. Install & authorize once:
   ```bash
   npm install && npm run build
   mailwarden --auth        # opens a browser, stores a refresh token in ~/.mailwarden/token.json
   ```
   Scope requested: `https://www.googleapis.com/auth/gmail.modify`.

## Run

- **Local (stdio)** — for Claude Code / Claude Desktop:
  ```bash
  mailwarden
  ```
- **Remote (Streamable HTTP)** — for a VPS / claude.ai custom connector:
  ```bash
  mailwarden --http       # listens on :8787/mcp ; set PORT, optional MAILWARDEN_TOKEN bearer gate
  ```

## Connect

**Claude Code:**
```bash
# local stdio
claude mcp add mailwarden -- mailwarden
# or remote
claude mcp add --transport http mailwarden https://your-host/mcp
```

**claude.ai (web):** Settings → Connectors → *Add custom connector* → your `https://your-host/mcp` URL.

## Config (env)

| Var | Meaning |
|---|---|
| `MAILWARDEN_DIR` | config dir (default `~/.mailwarden`) |
| `MAILWARDEN_CREDENTIALS` | path to `credentials.json` |
| `MAILWARDEN_AUTO_SWEEP` | `1` → hourly snooze sweep while running |
| `PORT` | HTTP port (default 8787) |
| `MAILWARDEN_TOKEN` | optional bearer token for the HTTP endpoint |

## Status

`0.1.2` — working. Core Gmail tools + snooze implemented against `googleapis` and used in daily mailbox automation. Covered by a vitest suite (30 tests). The HTTP transport is a thin wrapper to verify against your installed `@modelcontextprotocol/sdk` version. See the [changelog](CHANGELOG.md) / [releases](https://github.com/csitte/mailwarden/releases). PRs welcome.

## License

MIT © C.Sitte Softwaretechnik

# Roadmap

What's planned, in rough priority. Informed by a survey of the Gmail MCP server landscape
(July 2026); no promises, PRs welcome.

## Done (0.1.7 – 0.2.0)

- **`--http` hardening** (0.2.0): loopback bind + mandatory bearer token by default,
  Host-header allowlist (DNS-rebinding defense), request-body cap.
- **Guided `--auth`** (unreleased on `main`): credentials.json preflight with actionable messages
  before the browser flow, plus a post-consent live smoke call confirming the account.

- MCP tool annotations + structured `USE WHEN / DO NOT USE / SIDE EFFECTS` descriptions.
- Paginated `search` (`pageToken`/`nextPageToken`).
- RFC 2047 header decoding; charset-correct body decoding.
- 429/5xx retry with exponential backoff on every API call.
- Hardened download fence (realpath-canonicalized, symlink-aware, never overwrites).
- `<untrusted-tool-output>` fencing + hidden/BiDi character stripping on all output.
- `bulk_modify` (query-based batch label ops, partial-success reporting); batched snooze sweep.
- Label management: `modify_labels`/`bulk_modify` accept label **names** (unknown name in `add`
  auto-created, nested via `/`) and a `create_label` tool for pre-creating labels.
- Filter management: `list_filters`/`create_filter`/`delete_filter` for server-side auto-triage
  rules. Label actions only — no forwarding filters (kept out to preserve the no-exfiltration
  stance); `list_filters` surfaces existing forwards for auditing. `create_filter` can optionally
  `applyToExisting` (build a search from the criteria + one-off bulk modify over the backlog).
  Adds the `gmail.settings.basic` scope.
- Structured outputs (`outputSchema` + validated `structuredContent`) on every tool.
- `get_profile` — the connected account's address plus message/thread totals, for confirming
  *which* mailbox is wired up before a bulk or filter action (read-only, no extra scope).
- Read-only mode (`MAILWARDEN_READONLY=1`).
- Step-by-step [setup guide](SETUP.md) covering the Google Cloud / OAuth consent dance,
  the "unverified app" screen, and the Testing-status 7-day token expiry.
- Optional at-rest token encryption (unreleased on `main`): set `MAILWARDEN_TOKEN_PASSPHRASE` and
  `token.json` is stored AES-256-GCM-encrypted (scrypt key), closing the `0o600`-is-a-no-op gap on
  Windows for file copies. Opt-in; defends against file theft, not same-user malware.

- **Snooze presets + time of day** (unreleased on `main`): `snooze`'s `until` accepts natural presets
  (`today`, `tomorrow`, `weekend`, `next week`, a weekday name, `in N days`, `in N hours`) resolved
  server-side, alongside explicit `YYYY-MM-DD`, plus a clock time (`tomorrow 9am`, `2026-06-20 17:00`)
  stored to minute precision and woken at the next sweep on/after that minute.

## Next

1. **Multi-account** support — only if real demand shows up.

## Non-goals

- **Sending mail** (compose/reply/forward/drafts). Deliberate: a triage server that cannot send
  gives prompt-injected mail no exfiltration path. This will not change.
- Mailbox syncing/caching of any kind — every call stays live against the Gmail API.

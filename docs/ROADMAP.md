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
- Structured outputs (`outputSchema` + validated `structuredContent`) on every tool.
- Read-only mode (`MAILWARDEN_READONLY=1`).
- Step-by-step [setup guide](SETUP.md) covering the Google Cloud / OAuth consent dance,
  the "unverified app" screen, and the Testing-status 7-day token expiry.

## Next

1. **Multi-account** support — only if real demand shows up.

## Non-goals

- **Sending mail** (compose/reply/forward/drafts). Deliberate: a triage server that cannot send
  gives prompt-injected mail no exfiltration path. This will not change.
- Mailbox syncing/caching of any kind — every call stays live against the Gmail API.

# Roadmap

What's planned, in rough priority. Informed by a survey of the Gmail MCP server landscape
(July 2026); no promises, PRs welcome.

## Done (0.1.7 / 0.1.8)

- MCP tool annotations + structured `USE WHEN / DO NOT USE / SIDE EFFECTS` descriptions.
- Paginated `search` (`pageToken`/`nextPageToken`).
- RFC 2047 header decoding; charset-correct body decoding.
- 429/5xx retry with exponential backoff on every API call.
- Hardened download fence (realpath-canonicalized, symlink-aware, never overwrites).
- `<untrusted-tool-output>` fencing + hidden/BiDi character stripping on all output.
- `bulk_modify` (query-based batch label ops, partial-success reporting); batched snooze sweep.
- Structured outputs (`outputSchema` + validated `structuredContent`) on every tool.
- Read-only mode (`MAILWARDEN_READONLY=1`).

## Next

1. **Onboarding**: guided `--auth` experience and a step-by-step setup guide with screenshots —
   the Google Cloud project + OAuth consent dance is the biggest friction point.
2. **Multi-account** support — only if real demand shows up.

## Non-goals

- **Sending mail** (compose/reply/forward/drafts). Deliberate: a triage server that cannot send
  gives prompt-injected mail no exfiltration path. This will not change.
- Mailbox syncing/caching of any kind — every call stays live against the Gmail API.

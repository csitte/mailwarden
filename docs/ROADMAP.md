# Roadmap

What's planned, in rough priority, and what is deliberately out. Informed by a running survey of
the Gmail MCP server landscape (July–August 2026); no promises, PRs welcome. Shipped work is
recorded per version in [`CHANGELOG.md`](../CHANGELOG.md) — this file only keeps the map.

## Shipped (0.1 – 0.9)

- **Mailbox-side snooze** with presets and time of day; sweep on demand, via cron, or the built-in
  hourly daemon (0.1 → 0.6.0).
- **Search-result re-verification** against live labels (0.1.2); paginated search (0.1.7).
- **Bulk operations** — `bulk_modify` over a query, batched snooze sweep, partial-success reporting (0.1.8).
- **Labels and filters** — names or ids, auto-created labels, server-side filter rules with label
  actions only (no forwarding), optional apply-to-existing (0.4.0).
- **`triage_digest`** — top senders, label/age buckets, unread + attachment counts (0.6.0).
- **Tool tiers** `read`/`manage`/`filters` (`MAILWARDEN_TOOLS`) with OAuth scopes derived from the
  enabled tiers, scope-gated registration, `MAILWARDEN_READONLY` shorthand (0.6.0).
- **Structured outputs** (`outputSchema` + validated `structuredContent`, 0.1.8) and tool
  annotations (0.1.7) on every tool.
- **Multi-account** — one server entry per account, chosen before tool registration
  (`MAILWARDEN_ACCOUNT`, `--auth --account`), `--check` setup doctor (0.7.0).
- **Unsubscribe** — `list_unsubscribe`, `unsubscribe` (RFC 8058 one-click, URL never a tool
  parameter, byte-based SSRF guard) in 0.8.0; `list_subscriptions` by sender and
  `bulk_unsubscribe` in 0.9.0.
- **Hardening** — `<untrusted-tool-output>` fencing, RFC 2047 / charset-correct decoding and
  429/5xx backoff (0.1.7); `--http` loopback + bearer token + Host allowlist (0.2.0); optional
  AES-256-GCM token encryption at rest (0.5.0); symlink-safe download fence.
- **Server `instructions`** in the initialize response, tier-aware, for tool-search clients (unreleased on `main`).
- **`dryRun`** on `bulk_modify`, `bulk_unsubscribe` and `sweep_snoozed` — same path as the real call,
  stopped before the first write or outbound request (unreleased on `main`).
- **Triage `signals`** on search hits (newsletter / automated / calendar / replyToMismatch), header-derived,
  aggregated in `triage_digest` (unreleased on `main`).

## Next

1. **MCP SDK v2 / spec 2026-07-28** — `@modelcontextprotocol/server` 2.x (stateless core,
   `server/discover`, Zod 4). Not urgent: current clients negotiate down to the 1.x protocol and
   the 1.x SDK is maintained through at least early 2027; `src/http.ts` is already stateless.
   Planned for late 2026.
2. **Claude Code plugin packaging** (`.mcp.json` → `npx mailwarden`) for the community
   marketplace — a distribution item, no server change.

## Non-goals

- **Sending mail** (compose/reply/forward/send). Deliberate: a triage server that cannot send gives
  prompt-injected mail no exfiltration path. This will not change. Note the exact claim: Google
  enforces it only in the `read` tier (`gmail.readonly`); in `manage`/`filters` the guarantee is
  the tool surface, since `gmail.modify` would permit `messages.send` — see
  [`SECURITY.md`](../SECURITY.md).
- **Permanent delete.** Trash/untrash only.
- **Mailbox syncing/caching of any kind** — every call stays live against the Gmail API.
- **Forwarding filters** — `create_filter` never produces one; `list_filters` surfaces existing
  forwards for auditing.

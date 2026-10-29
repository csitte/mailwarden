# Roadmap

What's planned, in rough priority, and what is deliberately out. Informed by a running survey of
the Gmail MCP server landscape (July–August 2026); no promises, PRs welcome. Shipped work is
recorded per version in [`CHANGELOG.md`](../CHANGELOG.md) — this file only keeps the map.

## Shipped (0.1 – 0.10)

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
- **Server `instructions`** in the initialize response, tier-aware, for tool-search clients (0.10.0).
- **`dryRun`** on `bulk_modify`, `bulk_unsubscribe` and `sweep_snoozed` — same path as the real call,
  stopped before the first write or outbound request (0.10.0).
- **Claude Code plugin** — repo root as plugin (`.claude-plugin/plugin.json` → `npx -y mailwarden`) with a
  `/mailwarden:setup` skill; submitted to the community marketplace (0.10.0).
- **Triage `signals`** on search hits (newsletter / automated / calendar / replyToMismatch, later displayNameSpoof / lookalikeDomain), header-derived,
  aggregated in `triage_digest` (0.10.0).
- **MCPB bundle** (`npm run mcpb` → `dist-mcpb/mailwarden-<version>.mcpb`) as a release artifact — the
  format Smithery (`smithery mcp publish`) and the Claude Desktop extension directory accept for a
  local stdio server; built from the packed package against the lockfile, validated, unpacked and
  booted in CI (0.10.0). Published on Smithery as `csitte/mailwarden` (15.08.2026).

## Next

1. **Token encryption by default, with the key in the OS keystore** — decided 25 October 2026, for
   the release after 0.24.0. A native keyring binding (`@napi-rs/keyring`, as `agentcomms` uses), not a
   shell-out to `security`/`secret-tool`/PowerShell: the one server we read that does the latter had
   exactly that file locked and then removed from our disk right after cloning — presumably by a
   virus scanner, which we could not confirm, and a risk we will not ship. Same AES-256-GCM as today, the key from
   the keystore instead of a passphrase; where no keystore is reachable (a headless Linux host, a
   platform whose binary is missing) it behaves as today and `--check` says so. The passphrase stays
   as the explicit choice for headless hosts. Plaintext tokens keep loading and are encrypted at the
   next `--auth`, never rewritten silently. What it does not defend against goes into `SECURITY.md`
   as plainly: malware running as the same user can query the keystore too. Built on `main` on
   27 October 2026 and tried against the Windows Credential Manager; the MCPB bundle carries every
   declared platform's binding since 28 October. Still to be tried on a second machine before it
   ships; macOS is untried.
2. **Drafts, never sending** — decided 25 October 2026, for the release after the keystore one;
   built on `main` since 29 October 2026 (`create_draft`, `update_draft`; see `SECURITY.md`,
   threat 10). A
   separate `drafts` tier, off by default, so a deployment that does not enable it still has no
   compose tool at all, and the `read` tier keeps Google's own enforcement. It writes drafts — replies
   to an existing thread with the recipients derived from that thread, and new messages with
   recipients the caller names — and can change only drafts it created. A new message to a freely
   chosen address is where an injected instruction could aim mail at a stranger, so that path always
   asks the person at the client first, through the same elicitation as `MAILWARDEN_CONFIRM`, and is
   refused on a client that cannot ask. No attachments from local disk. Sending stays a non-goal:
   `messages.send` and `drafts.send` stay on the egress denylist, and only a person pressing Send in
   Gmail sends anything. What remains is stated plainly: a draft can carry what an injected mail asked
   for, and the protection is the human reading it before Send.
3. **MCP SDK v2 / spec 2026-07-28** — `@modelcontextprotocol/server` 2.x (stateless core,
   `server/discover`, Zod 4). Not urgent: current clients negotiate down to the 1.x protocol and
   the 1.x SDK is maintained through at least early 2027; `src/http.ts` is already stateless.
   Planned for late 2026.

That is the whole list, and the short list is the finding rather than an omission. The September
2026 survey turned up no capability gap worth closing: of the five servers in the README's
comparison table, none has snooze, none re-verifies a search result against live labels, none reads
`Authentication-Results`. (This sentence also said that none declares an `outputSchema` on more
than a single tool. That was wrong for Google's own server, whose reference documents an output
schema for every tool; corrected on 2026-10-13.) What it
did turn up was a way of doing something this project already does — `aaronsb/google-workspace-mcp`
checks an account's access level against the *granted* scopes at call time, where scope gating here
happened only at registration — and that has been adopted (see `CHANGELOG.md`). The next entry on
this list is more likely to come from that kind of reading than from a feature another server ships.

The October 2026 round bore that out, five times over, each a way of doing something already here
rather than a new kind of thing: a `bulk_modify` dry run that binds the write through a one-use
`previewToken` (from `aaronsb`), `preview_filter` before `create_filter` (likewise), `read_attachment`
for the text inside reports and archives (from `gmail-tidy-mcp`), `MAILWARDEN_CONFIRM` asking the user
through elicitation before a filter or an unsubscribe (from `klodr`), and two more header signals,
`displayNameSpoof` and `lookalikeDomain`. One gap remained, token encryption by default with the key
in the OS keystore, as `agentcomms` and `gmail-tidy-mcp` do it; it was item 1 under Next and is built
on `main` since 27 October 2026.

## Non-goals

- **Sending mail** (send, and forward or reply as an action that sends). Deliberate: a triage server
  that cannot send gives prompt-injected mail no exfiltration path. This will not change. Writing a
  *draft* that a person then sends is planned as an opt-in tier (see Next, item 2); it is not sending. Note the exact claim: Google
  enforces it only in the `read` tier (`gmail.readonly`); in `manage`/`filters` the guarantee is
  the tool surface, since `gmail.modify` would permit `messages.send` — see
  [`SECURITY.md`](../SECURITY.md).
- **Permanent delete.** Trash/untrash only.
- **Mailbox syncing/caching of any kind** — every call stays live against the Gmail API.
- **Forwarding filters** — `create_filter` never produces one; `list_filters` surfaces existing
  forwards for auditing.

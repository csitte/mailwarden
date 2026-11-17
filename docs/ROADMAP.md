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
- **Claude Code plugin** — repo root as plugin (`.claude-plugin/plugin.json`) with a `/mailwarden:setup`
  skill (0.10.0); the launcher is pinned to the published version (`npx -y mailwarden@<version>`), and
  since 0.31.2 the repo is its own plugin marketplace, the directory submission being on hold.
- **Triage `signals`** on search hits (newsletter / automated / calendar / replyToMismatch, later displayNameSpoof / lookalikeDomain), header-derived,
  aggregated in `triage_digest` (0.10.0).
- **MCPB bundle** (`npm run mcpb` → `dist-mcpb/mailwarden-<version>.mcpb`) as a release artifact — the
  format Smithery (`smithery mcp publish`, until its shutdown on 31.10.2026) and the Claude Desktop
  extension directory accepted for a local stdio server; built from the packed package against the
  lockfile, validated, unpacked and booted in CI (0.10.0). Published on Smithery as `csitte/mailwarden`
  from 15.08.2026 to 0.23.0; the Smithery variant of the bundle was removed in 0.28.0.

## Shipped from the Next list

- **Token encryption by default, with the key in the OS keystore** (0.25.0, 28 October 2026). A
  native keyring binding (`@napi-rs/keyring`, as `agentcomms` uses), not a shell-out to
  `security`/`secret-tool`/PowerShell: the one server we read that does the latter had exactly that
  file locked and then removed from our disk right after cloning — presumably by a virus scanner,
  which we could not confirm, and a risk we will not ship. Same AES-256-GCM as before, the key from
  the keystore instead of a passphrase; where no keystore is reachable it behaves as before and
  `--check` says so, and the passphrase stays the explicit choice for headless hosts. Tried end to
  end against the Windows Credential Manager; the macOS Keychain has not been tried yet. What it does
  not defend against is in `SECURITY.md`: malware running as the same user can query the keystore too.
- **Drafts, never sending** (0.26.0, 31 October 2026; attachments 0.28.0, a chosen sender address
  0.29.0, signatures 0.31.0). A separate `drafts` tier, off by default, so a deployment that does not
  enable it still has no compose tool at all, and the `read` tier keeps Google's own enforcement.
  `create_draft` writes replies and new messages, `update_draft` changes only drafts it wrote. An
  address the thread did not already contain needs a yes in an elicitation dialog, and a client that
  cannot show one gets a refusal; `MAILWARDEN_CONFIRM` decides the rest. Two opt-in settings skip
  that dialog, `MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG=1` for the account's own address and
  `MAILWARDEN_DRAFT_CONFIRM=off` for every draft; an explicit `MAILWARDEN_CONFIRM=require` still asks
  under either. Sending stays a non-goal: `messages.send` and
  `drafts.send` stay on the egress denylist, and only a person pressing Send in Gmail sends anything.
  What remains is stated plainly (`SECURITY.md`, threat 10): a draft can carry what an injected mail
  asked for, and the protection is the human reading it before Send.

## Next

1. **MCP SDK v2 / spec 2026-07-28** — `@modelcontextprotocol/server` 2.x (stateless core,
   `server/discover`, Zod 4), tracked in [issue #8](https://github.com/csitte/mailwarden/issues/8).
   Planned in [`docs/SDK-2-PLAN.md`](SDK-2-PLAN.md) as two steps. Step 1 (the SDK swap, held at
   the 2025 protocol revisions so the confirmation dialogs keep working) was built on 17 November
   2026 and is not released yet. Step 2 rebuilds the dialogs for 2026-07-28 and is not started.

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
in the OS keystore, as `agentcomms` and `gmail-tidy-mcp` do it; it shipped in 0.25.0.

## Non-goals

- **Sending mail** (send, and forward or reply as an action that sends). Deliberate: a triage server
  that cannot send gives prompt-injected mail no exfiltration path. This will not change. Writing a
  *draft* that a person then sends is an opt-in tier (see Shipped from the Next list); it is not sending. Note the exact claim: Google
  enforces it only in the `read` tier (`gmail.readonly`); in `manage`/`filters` the guarantee is
  the tool surface, since `gmail.modify` would permit `messages.send` — see
  [`SECURITY.md`](../SECURITY.md).
- **Permanent delete.** Trash/untrash only.
- **Mailbox syncing/caching of any kind** — every call stays live against the Gmail API.
- **Forwarding filters** — `create_filter` never produces one; `list_filters` surfaces existing
  forwards for auditing.

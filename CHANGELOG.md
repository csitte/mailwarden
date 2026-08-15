# Changelog

All notable changes to **mailwarden** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Listed on Smithery as [`csitte/mailwarden`](https://smithery.ai/servers/csitte/mailwarden)** — it serves
  the 0.10.0 MCPB bundle. README says which of Smithery's two paths keeps the no-third-party property
  (`smithery install …` writes a local stdio entry; the toolbox/uplink path relays tool traffic through
  Smithery's gateway).

### Fixed
- **`npm run mcpb` release detection counted untracked files as a dirty tree.** In the publish
  workflow the downloaded `mcp-publisher` binary sat untracked in the checkout, so the CI-built 0.10.0
  bundle was named `-dev.<sha>.dirty` (the release asset was built locally on the clean tag instead).
  Only tracked changes count now, and the workflow builds the bundle before the publish steps.

## [0.10.0] - 2026-08-15

Triage signals on every search hit, dry runs for the three bulk tools, server `instructions` for
tool-search clients, and two new ways to install (Claude Code plugin, MCPB bundle) — plus one fix
to a 0.9.0 behaviour (a crafted `From` display name could take another sender's key). All additive:
no tool removed, no field changes meaning, no new OAuth scope, no re-authorization needed.

### Added
- **MCPB bundle as a release artifact.** `npm run mcpb` (`scripts/build-mcpb.mjs`) builds two bundles in
  `dist-mcpb/` — the format Smithery (`smithery mcp publish <file>.mcpb`) and the Claude Desktop extension
  directory accept for a local stdio server. `mailwarden-<version>.mcpb` is strict MCPB (`mcpb validate`
  + `mcpb pack`; the GitHub release asset / Desktop extension); `mailwarden-<version>-smithery.mcpb` is
  the same file set with the manifest's `tools` as the REAL MCP Tool objects (name, description,
  `inputSchema`, annotations) — Smithery's registry requires `inputSchema` per tool and rejects the strict
  MCPB tool shape with a 400 (smithery-ai/cli#787); its CLI passes manifest tools through unvalidated, so
  this variant matches the registry's `ServerCard.Tool` type exactly. Both are built from the PACKED npm
  package (`npm pack` → unpack → `npm ci --omit=dev` against this repo's lockfile), so they ship exactly the
  published files with a pinned dependency tree; the manifest (`mcpb/manifest.json`, one `user_config`
  knob: the tool tiers → `MAILWARDEN_TOOLS`) gets its `tools` from a real `tools/list` handshake against
  the staged tree, never by hand. Version discipline: the bundle version is `package.json`'s only when HEAD
  is a clean checkout of tag `v<version>` (or that tag's CI run); otherwise it is `<version>-dev.<sha>[.dirty]` in
  manifest AND file name, so a bundle from an unreleased `main` cannot be mistaken for the release. Checks
  before an artifact is written and again on the unpacked artifacts: handshake, version, every
  `${user_config.*}` placeholder has a default (Smithery leaves unresolved placeholders literal), strict /
  loose schema validation, size under Smithery's 25 MiB limit (6 MiB today), boot + read-tier gate from
  the UNPACKED bundle — the pack step drops files by pattern and this is the proof nothing dropped was
  needed. Runs in CI on every push and in the publish workflow (kept as a run artifact); the strict bundle
  is the GitHub release asset, the Smithery one is what `smithery mcp publish` takes. No server change:
  the bundle starts `dist/index.js` the way `npx mailwarden` would.
- **Claude Code plugin packaging.** The repository root now carries `.claude-plugin/plugin.json` (server
  entry `npx -y mailwarden`, i.e. the published package — the plugin ships no code of its own) plus one
  skill, `/mailwarden:setup`, which walks a user through the OAuth setup by reading the plugin's own
  `docs/SETUP.md` (no second copy of the instructions to drift) and starts from `mailwarden --check`.
  Loads with `claude --plugin-dir <clone>`; verified with `claude mcp list` (`plugin:mailwarden:mailwarden`
  connected). Neither the manifest nor the skill is part of the npm package. No `version` field on
  purpose: marketplaces then pin the commit SHA and follow pushes, and there is no second version
  number to keep in step with `package.json`.
- **Header-derived triage `signals` on every search hit, aggregated in `triage_digest`.** Four flags an
  agent can act on without opening the mail, each a documented header convention or MIME fact and never
  a guess from wording: `newsletter` (a non-blank `List-Id` or `List-Unsubscribe`, or
  `Precedence: bulk|list`), `automated` (`Auto-Submitted` other than `no` — RFC 3834 comments and
  `;` parameters understood —, `Precedence: auto_reply`, `X-Auto-Response-Suppress` with any value but
  `None`, or a machine local-part: no-reply / do-not-reply / mailer-daemon / postmaster / notification(s)
  / alert(s) / bounce(s), hyphen or underscore, quoted or bare — exact spellings only, so a person named
  "Noreen Reply" is not flagged), `calendar` (a `text/calendar` part or an `.ics` attachment, however
  deep in the MIME tree), `replyToMismatch` (any `Reply-To` mailbox on a domain that is neither `From`'s
  nor a subdomain of it in either direction — `news@e.brand.example` → `help@brand.example` is how
  marketing mail is built and stays silent; `a@brand.example` → `b@brand.example.evil` fires; domains
  compared case-folded, IDN and Punycode unified, trailing dot ignored). Addresses are read with a
  scanner that knows RFC 5322 quoting, comments, groups, several mailboxes and the obsolete source
  route — a display name containing a literal `<other@x>` cannot pose as the address, so the header
  corpus that locks the logic (RFC 3834 / 2919 / 2369 / 5322 shapes, IDN, real Apple / LinkedIn /
  Exchange forms, and the edges that must NOT fire — 22 wrong verdicts of the first cut, all found by
  the corpus) is what the release ships. Read off the thread's FIRST message — its origin, so a
  newsletter stays one after the user replies — from the `format=full` fetch `search` already makes,
  i.e. no extra API call and available in the `read` tier. `triage_digest` reports how many sampled
  threads carry each signal and, per sender, the union of its threads' signals. Empty means "nothing
  declared", not "personal". The same scanner now derives the *sender key* that groups
  `triage_digest` / `list_subscriptions` and dedupes `bulk_unsubscribe` per sender (`parseSender`), so
  a crafted display name cannot claim another sender's key there either.
- **`dryRun` on the three tools that act on many things at once** — `bulk_modify`, `bulk_unsubscribe`,
  `sweep_snoozed`. A dry run walks the *same* path as the real call up to the first write or outbound
  request and stops there: `bulk_modify` resolves the query and reports `matchedThreads` plus
  `labelsToCreate` (names in `add` that don't exist yet — reported, not created); `bulk_unsubscribe`
  reads every thread's headers, runs the same per-sender dedupe (as the real run would with every
  request succeeding) and reports the endpoint each thread that would be contacted `wouldCall` (its selection is now a pure function, `planUnsubscribe`, shared with the real
  run, so the two cannot disagree — a test holds them thread for thread); `sweep_snoozed` reports
  `dueLabels`/`dueThreads` and deletes no label, not even an empty one. Every dry-run result says
  `dryRun: true` and claims no outcome (`modified*`/`woken*`/`unsubscribed` are zero). The real
  runs gain the same descriptive fields (`matchedThreads`, `dueThreads`, `requests`) so a
  rehearsal and its execution read alike. Additive; every existing field keeps its meaning.
- **Server `instructions`.** The MCP `initialize` response now carries a short, tier-aware
  description of what the enabled tools can do and the two invariants an agent must know (no
  send, no permanent delete). Clients that defer tool definitions — Claude Code's tool search
  loads only tool *names* plus these instructions at session start — use exactly this text to
  decide whether to look for mailwarden's tools at all; before, mailwarden sent none. Under 2 KB
  for every tier combination (Claude Code truncates there), and a read-only deployment does not
  advertise snooze or filters. Scope-gated like the registration: a `filters` tier whose stored token
  is known to lack `gmail.settings.basic` registers no filter tools and advertises none.

### Changed
- **`from` in search hits, `get_thread` messages and subscription rows is normalised** to
  `Name <address>` (address lowercased, RFC 5322 comments dropped, a name with address syntax in it
  quoted) — a by-product of reading the structure off the raw header (see *Fixed*). A bare address stays
  bare; a header with no recognisable mailbox stays plain decoded text.
- **README: the snooze claim is now "mailbox-side snooze", not "the feature nobody else ships".** Another
  Gmail MCP server carries a local reminder list under the name snooze; what is unique here is that the
  snooze lives in the mailbox (label + sweep, visible in Gmail, survives a restart). Unsubscribe added to
  the comparison matrix.
- **`SECURITY.md`: mapped against published guidance.** New section citing the MCP Security Best
  Practices (spec 2026-07-28) and the OWASP MCP Security Cheat Sheet, and stating which control here
  answers which recommendation (stdio/loopback+token, scope minimization = tiers, SSRF guard, output
  fencing, URL never a tool parameter, `destructiveHint` on the tools a client should gate). Also
  names what only a client can deliver.
- **MCP SDK 1.29 → 1.30.0** (floor now `^1.30.0`): upstream stdio buffer limits, SSE keep-alive frames and
  stricter Content-Type validation. No behavioural change for mailwarden; the v2 SDK (spec 2026-07-28)
  is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md), not pulled by this range.

### Fixed
- **A crafted `From` display name could take another sender's key.** The sender key (the addr-spec) that
  groups `triage_digest` and `list_subscriptions` and dedupes `bulk_unsubscribe` per sender was read off
  the *RFC 2047-decoded* header. RFC 2047 says decoded text is text, never syntax — but a display name
  that decodes to `<legit@news.example>,` read as a second mailbox, so a mail Gmail shows as
  `evil@x.example` was filed under the newsletter's key: `list_subscriptions` merged it into that sender's
  row (and inspected the attacker's thread for the row's opt-out options), `bulk_unsubscribe` skipped
  the real newsletter as a duplicate if the attacker's thread came first. Since 0.9.0. Now the mailbox
  structure is read off the RAW header (`decodeAddressHeader`), only the display name is decoded, and it
  is re-emitted quoted whenever it contains address syntax; `parseSender` itself uses the same
  quote-/comment-aware scanner as the signals, so neither the raw form (`"<legit@x>" <evil@y>`) nor the
  encoded one can pose as another address. No send, no data leaves the mailbox either way — this was
  mis-grouping and a skipped opt-out, found in the release checks (round 4, fix-commit review), not
  reported.

## [0.9.0] - 2026-08-13

Sender-level subscription triage and bulk unsubscribe, plus a correction to the scope claim in
the threat model. All additive — nothing existing changes behaviour, and no re-authorization is
needed: `list_subscriptions` is a read-tier tool and `bulk_unsubscribe` needs only `gmail.modify`.

### Added
- **`list_subscriptions` (read tier) — who keeps writing, and can you get off the list.** Groups a
  mailbox slice by sender and reports each one's opt-out options in the same row: thread and unread
  counts, and the date span that sender was seen over. **No precomputed frequency**, deliberately:
  `oldestDate`/`newestDate` bound what the *sample* saw, not the sender's history, so `threads` across
  that span is the honest form of the question and the caller judges it with the sampling caveat in
  view (the field probe below is why). Opt-out options cost **one** metadata fetch per *sender* — on
  that sender's newest dated thread, or its first thread in the sample if none carry a parseable date
  — not one per thread. `optOut` is `one-click` / `link` / `mailto` / `none`, or `unknown` when that
  sender's fetch failed, which is deliberately distinct from `none`. `sendersFound` reports how many
  distinct senders the sample held *before* `topN` truncated the list, so a top-ten slice of forty
  cannot be mistaken for the whole answer. Contacts nobody. The grouping itself is a pure function
  over rows `search` already fetched.
- **`bulk_unsubscribe` (manage tier).** Unsubscribes from several threads in one call, taking thread
  ids — never a query, which would fire a request per matched sender before anyone had looked.
  Sequential, never parallel, and **at most one request per sender**: a second thread from a sender
  whose request already went out comes back with `duplicateOf` and no request, since two threads from
  one list share an opt-out and calling it twice only confirms the address twice. A sender counts as
  handled only once a request actually reached an endpoint — a refusal, or a connection that died on
  the way, leaves the next thread its own try, because nothing was confirmed to that sender either
  way. Where the skipped thread advertises a *different* endpoint (one sender, several lists) the
  reason says so, rather than letting a list the caller asked to leave stay quietly subscribed; the
  comparison is advertised-endpoint to advertised-endpoint, so a redirecting sender is not mistaken
  for a second list. Bounded on three axes because none of it can be undone: 25 threads per call, one
  request per sender, and a single **60-second budget** for the whole call — 25 × the single-request
  timeout would stall long past any client's patience, the same reasoning that gives a redirect chain
  one budget instead of one per hop. Threads left over are returned as `skippedOutOfTime` with a
  reason, not dropped. Partial success is reported per thread, matching `bulk_modify`. Every existing
  unsubscribe guard applies unchanged — the URL still comes only from the message's own header, only
  RFC 8058 one-click is performed, and `mailto:` never is.
- **`scripts/probe-subscriptions.mjs` — hold `list_subscriptions` against real mail.** Companion to
  the parser probe, aimed at this tool's one shortcut: options are read from a single thread per
  sender, which assumes any thread of a sender advertises what that sender offers. The script does
  the expensive thing instead — it inspects *every* thread of each sender and reports where the
  shortcut would have missed a better opt-out, alongside how the grouping fared on real `From`/`Date`
  headers and how far back the sample actually reaches. Strictly read-only: metadata only, no sender
  contacted, no printed URL visited. Repo-only, like the parser probe and the re-verification demo.
  **Its first run against a real mailbox settled three things and killed a fourth.** Held: the
  one-fetch-per-sender shortcut (26 extra threads across 8 senders, 0 missed opt-outs), the grouping
  (60 real `From`/`Date` headers, none unparsed), and `sendersFound` (8 of 31 senders shown — the cap
  was visibly needed). Killed: a `perMonth` rate this tool briefly carried. Every value it produced
  was extrapolated from a window of 0.1 to 6.5 days, the worst turning two messages a day apart into
  "59.8/month". Raising the threshold to half the reported unit stopped the overstatement but exposed
  the real problem — the span is bounded by `max` (≤100 threads), and a busy mailbox produces 100
  threads in days, so an honest rate was `null` for all 35 senders sampled. A field that is either
  absent or extrapolated is worse than no field, so it is gone: `threads` with both dates says
  strictly more, minus the false precision a model would have acted on.

### Fixed
- **`SECURITY.md`: corrected an overstated scope claim.** Threat 1 asserted that neither requested
  OAuth scope "can send mail" and that the no-send property was "enforced by Google". That is wrong
  for `gmail.modify`: Google lists it as an accepted scope for `users.messages.send` and
  `users.drafts.send`, and a probe against a `gmail.modify`-only token confirms it — both endpoints
  answer with a payload error (400/404) rather than 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, i.e. the
  request passes the authorization gate. The Google-enforced guarantee therefore holds only for a
  `read` deployment (`gmail.readonly`); in `manage`/`filters` deployments no-send rests on the tool
  surface — there is no send/compose/reply/forward tool and none can be registered at runtime. No
  send-free write scope exists for an installed app (`users.messages.modify` accepts only
  `mail.google.com`, `gmail.modify`, and the domain-wide-delegation-only `gmail.modify.restricted`).
  **No behaviour or scope change** — documentation only; the non-goals section now also states that a
  compromised *machine* can use the token directly, bypassing the tool surface.
- **`README.md` / `docs/SETUP.md`: same correction, plus the positive framing.** The setup guide
  claimed the requested scopes grant no send capability; it no longer does. Both documents now name
  `read` as the one tier whose no-send property Google enforces (`gmail.readonly` is rejected by
  Gmail's send endpoints), which is the honest — and stronger — way to state it.
- **`SECURITY.md`: the `uuid` advisory status was out of date.** It said no upstream fix existed. One
  does — later `googleapis` releases drop `uuid` rather than patch it — but raising our range alone
  would not clear the four advisories, because `@google-cloud/local-auth` (the one-time browser
  consent behind `--auth`) is at its own latest and pins `google-auth-library` to `^9`, whose
  `gaxios` 6 still pulls `uuid` 9. The section now says that, and names replacing that dependency as
  what would actually resolve it. The advisory count and the reachability analysis are unchanged and
  re-verified: `uuid`'s bug is in `v3`/`v5`/`v6` with a `buf` argument, and this tree calls only `v4`.

## [0.8.0] - 2026-08-11

Unsubscribe from mailing lists, and a release pipeline that verifies the artifact rather than the
source tree. All additive — nothing existing changes behaviour, and no re-authorization is needed.

### Added
- **Unsubscribe from mailing lists — two new tools.** `list_unsubscribe` (read tier) reports what
  opt-out options a thread advertises via its `List-Unsubscribe` header, contacting nobody — reading
  the newest message that actually carries the header, so a reply threaded onto a newsletter does not
  hide it. `unsubscribe` (manage tier) performs the RFC 8058 one-click opt-out. This is the only code
  path in mailwarden that reaches a host other than Google, so it is fenced accordingly (new threat
  class 9 in `SECURITY.md`): **the URL is never a tool parameter** — it comes from the addressed
  message's own header, so an injected mail cannot smuggle mailbox content into a query string; the
  request body is fixed and the response body is discarded unread, so the endpoint cannot answer with
  instructions; only senders who opted in via `List-Unsubscribe-Post` are automated, a bare link is
  handed back for a human, and a `mailto:` opt-out is never performed because mailwarden cannot send.
  SSRF guards on every hop: https and default port only, no credentials in the URL, at most three
  redirects, and each host must resolve exclusively to globally reachable addresses. Addresses are
  matched as **bytes** against the IANA special-purpose registries rather than as text, so every
  spelling of one address gets one verdict (`::1` and `0:0:0:0:0:0:0:1` alike) and an IPv4 embedded in
  an IPv6 — mapped, translated, NAT64 or 6to4 — is judged on its own account too; anything that does
  not parse as an address is refused. DNS resolution shares the request's 10-second budget. A sender
  offering nothing automatable yields `unsubscribed:false` plus the alternatives — not an error.
- **`scripts/probe-unsubscribe.mjs` — hold the List-Unsubscribe parser against real mail.** Prints
  each real header from your own mailbox next to what the parser made of it; `--vet` additionally
  runs the endpoint through the URL vetting and the address guard, so you also see whether the
  guards would let a genuine opt-out through rather than only that they block a hostile one.
  Strictly read-only — no sender is ever contacted and nothing in the mailbox changes. Repo-only,
  like the re-verification demo.
- **Every release is now verified as an installed package, not just as a source tree.** `npm run
  smoke` packs the tarball, installs it into a clean project with no credentials, and drives the
  real MCP handshake against it: all runtime imports must resolve, `initialize` must report the
  version in `package.json`, `tools/list` must contain no send-shaped tool, `MAILWARDEN_TOOLS=read`
  must still gate out the write tools, and `--check` must diagnose the missing setup rather than
  crash on it. It runs in CI and — crucially — as the last gate before the irreversible `npm
  publish`. The `uuid` override below is exactly the class of defect it exists to catch: invisible
  to a test suite that runs against this repo's own `node_modules`.
- **`SECURITY.md` documents why the account is not a tool parameter** (new threat class 8: acting on
  the wrong mailbox). A process serves exactly one account, fixed by `MAILWARDEN_ACCOUNT` in the
  server configuration and therefore outside the model's reach — so a prompt-injected call cannot
  switch mailbox, and tool tiers and scopes stay resolved per instance (a read-only work account
  next to a full-access private one). The cost — one server entry per account — is stated too.
- **CI on every push and pull request to `main`** (Node 20 and 22). The only workflow before this
  fired on a version tag, so a broken commit stayed invisible until release — when the tag was
  already pushed.

### Changed
- **The dependency tree used in development now matches what users get.** A `uuid` override was
  forcing a patched version locally; npm `overrides` apply only to the root project, so it cleared
  our `npm audit` while every user still resolved the original version — and we were testing a tree
  nobody runs. Removed. `SECURITY.md` now documents the resulting googleapis-chain advisories and
  why they are not reachable (`uuid.v4()` is called without the affected `buf` argument).

## [0.7.0] - 2026-08-10

Multiple Gmail accounts, a setup doctor, and a published threat model. All additive — an existing
single-account setup keeps working untouched, with no re-authorization.

### Added
- **Multiple accounts.** `MAILWARDEN_ACCOUNT=<name>` selects a named account whose refresh token
  lives in `token.<name>.json`; `mailwarden --auth --account <name>` provisions it. One shared
  `credentials.json` authorizes several Gmail accounts — run them side by side by registering the
  server once per account, each instance fully isolated (own token, own granted scopes, own tool
  surface). Account names are case-insensitive and stored lower-cased, so a name always maps to
  exactly one mailbox on every filesystem. Unset means the default `token.json`, exactly as before.
- **`mailwarden --check` (setup doctor).** Diagnoses the OAuth setup end to end and prints a
  concrete fix for anything wrong, instead of failing cryptically on the first Gmail call: the
  `credentials.json` shape (telling an unreadable file apart from a missing one), whether a token
  exists and whether it is encrypted, whether the granted scopes cover the enabled tiers (by
  capability — `gmail.modify` satisfies a read-only deployment), and one live Gmail call. Reports
  the active account and any others it finds, and names the matching `--account` in every
  remediation. Exits non-zero on failure, so it works as a CI/health check. `--doctor` is an alias.
- **[`SECURITY.md`](SECURITY.md) — a published threat model.** Trust boundary, data flow, the
  mitigations for seven threat classes (prompt-injection exfiltration, destructive actions, stale
  state, token theft, the HTTP listener, path traversal), explicit non-goals, and a private
  vulnerability-reporting path.
- **Runnable re-verification demo** (`scripts/demo-reverify.mjs`). Credential-free proof that
  `search()` drops the Gmail index's `is:unread` false positives — it drives the real `search()`
  against a deliberately loose fake index, asserts the outcome, and runs as part of the test suite.
- **README: a named comparison against other Gmail MCP servers**, plus a worked example of why
  live re-verification matters.

### Changed
- **CLI errors print one actionable line instead of a stack trace.** Unexpected faults still say
  how to get the full error; `MAILWARDEN_DEBUG=1` forces it for everything.

### Fixed
- The "could not be read" message for an unreadable `credentials.json` no longer prints
  `(undefined)` when the underlying error carries no errno.

## [0.6.1] - 2026-08-09

Non-breaking robustness and edge-case hardening from a full-codebase review. No API or tool changes.

### Fixed
- **Search survives a concurrently-deleted thread.** A single `threads.get` that fails because a hit
  vanished between the list snapshot and the fetch (deleted or moved — e.g. by another client or an
  auto-trashing filter) no longer aborts the whole search; that one candidate is skipped instead. The
  underlying `threads.list` stays unguarded, so a systemic auth/network failure still surfaces.
- **Transient network failures are retried.** `withBackoff` now retries network-level errors that carry
  no HTTP status (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `"socket hang up"`), not only
  `429`/`5xx` — a dropped socket mid-sweep rides out the blip instead of failing immediately.
- **Snooze accepts hyphen-separated presets.** The negative-offset guard treats `-` as a sign only at a
  token boundary, so `in-3-days` and `monday-9am` are parsed as intended rather than rejected as
  negative offsets (a genuine `in -3 days` is still refused).
- **`--http` rejects a malformed `PORT`.** A non-numeric `PORT` now fails fast with an actionable
  message instead of passing `NaN` to `listen()` and silently binding a random port.
- **`unsnooze` preserves manual sub-labels.** It strips only the parent and real dated snooze labels,
  leaving a hand-made bucket like `MCP/Snoozed/Archiv` intact — the same validity rule `sweep_snoozed`
  already uses.

### Changed
- **`list_snoozed` fetches subjects concurrently** (bounded pool) instead of one thread at a time,
  speeding up large snooze backlogs.

## [0.6.0] - 2026-08-07

### Added
- **Scope-derived, scope-gated tiers.** The OAuth scopes requested at `--auth` are now derived from the
  enabled tool tiers: `read` asks for `gmail.readonly`, `manage` for `gmail.modify`, and
  `gmail.settings.basic` is requested only when the `filters` tier is on (default, all tiers, is
  unchanged: `gmail.modify` + `gmail.settings.basic`). The granted scopes are recorded in `token.json`,
  and the filter tools are hidden at startup when the stored token lacks `gmail.settings.basic` (with a
  hint to re-run `--auth`) instead of being advertised and failing at call time. Tokens written before
  this (no recorded scope) and encrypted tokens are advertised as before, with the runtime
  insufficient-scope message as the fallback.
- **Tool tiers (`MAILWARDEN_TOOLS`).** Advertise only the tool tiers a deployment needs —
  `read` (read tools), `manage` (mailbox mutations, snooze, downloads), `filters` (filter CRUD).
  Comma-separated, default all three. Keeps the surface focused (progressive disclosure) — e.g.
  `read,manage` skips filter management, the only tier whose tools need `gmail.settings.basic`.
  `MAILWARDEN_READONLY=1` is now shorthand for `MAILWARDEN_TOOLS=read` (unchanged behavior);
  `MAILWARDEN_TOOLS` is authoritative when defined (a blank value is a startup error, not "all").
- **`triage_digest` tool.** A read-only, structured overview of a mailbox slice (default `in:inbox`)
  for triage *decisions* rather than reading: top senders (with per-sender unread), label buckets,
  age buckets (`last24h`/`last7d`/`last30d`/`older`/`undated`), and unread + attachment counts. Samples
  up to `max` (≤100) of the most recent matches and flags `hasMore` when more matched. Adds no new scope
  (runs under `gmail.readonly`) and is available in `MAILWARDEN_READONLY` mode. Aggregation is a pure,
  fully-tested function over the summaries `search` already returns — no extra API calls beyond that search.
- **Snooze presets.** The `snooze` tool's `until` argument now accepts natural presets in addition to
  an explicit `YYYY-MM-DD` — `today`, `tomorrow`, `weekend` (next Saturday), `next week` (next Monday),
  a weekday name (`monday`–`sunday`, resolved to the next occurrence), or `in N days`. Resolution happens
  server-side, so the caller no longer has to compute the date (a common source of off-by-one and
  wrong-timezone snoozes). Explicit dates behave exactly as before.
- **Time-of-day snooze.** `until` now also accepts a clock time — a date+time (`2026-06-20 9am`,
  `2026-06-20T17:00`), a preset with a trailing time (`tomorrow 9am`, `monday 8:30`), or `in N hours`.
  A timed snooze is stored as a `MCP/Snoozed/YYYY-MM-DDTHHMM` label (minute precision, local time) and
  resurfaces at the first sweep on/after that minute, so wake latency equals the sweep interval
  (run `sweep_snoozed` on demand, or set `MAILWARDEN_AUTO_SWEEP=1` for an hourly sweep). Bare-date
  snoozes are unchanged — still due for the whole day.

## [0.5.0] - 2026-08-06

### Added
- **Optional token encryption at rest.** Set `MAILWARDEN_TOKEN_PASSPHRASE` to a passphrase and
  `token.json` is stored AES-256-GCM-encrypted with a scrypt-derived key, so a copy of the file
  (backup, synced folder, another machine) is useless without the passphrase — closing the gap
  that `mode 0o600` leaves on Windows. Opt-in, mirroring the `--http` / `MAILWARDEN_TOKEN` pattern;
  unset keeps today's plaintext behavior. Re-run `mailwarden --auth` once after setting the key to
  encrypt an existing token. An encrypted token with a missing or wrong key yields an actionable
  error instead of a misleading "not authorized" prompt. This defends against file theft, **not**
  against malware running as the same user (which can read the passphrase from the environment).

### Changed
- **`homepage`** now points to the canonical project page (`https://www.csitte.at/mailwarden/`)
  instead of a GitHub README anchor, so npm and downstream scrapers (Glama, CodeGuilds) link there;
  added a website badge to the README. Metadata only — no behavior change.

## [0.4.0] - 2026-08-04

### Added
- **`get_profile` tool.** Returns the connected account's email address plus total
  message/thread counts — so an agent can confirm *which* mailbox is wired up before a
  bulk or filter action, or use it as a cheap liveness check. Read-only, no additional
  OAuth scope (works under `gmail.readonly`), and available in `MAILWARDEN_READONLY` mode.
  Gmail's incremental-sync `historyId` is deliberately not surfaced (syncing is a non-goal).
- **Filter management.** New `list_filters`, `create_filter`, and `delete_filter` tools for
  Gmail's server-side auto-triage rules. `create_filter` supports label actions only (criteria →
  add/remove labels, by name or id — unknown names auto-created); it deliberately **cannot create a
  forwarding filter**, which would be an exfiltration path, keeping the no-send guarantee intact.
  `list_filters` still surfaces any `forward` address on existing filters so it can be audited.
  `create_filter` also accepts `applyToExisting: true`, which — after creating the rule — builds a Gmail
  search from the criteria and runs a one-off bulk modify over mail already in the mailbox (up to
  `maxMessages`, default 1000), returning the outcome under `applied`. Guardrails: it requires a positive
  criterion (an exclusion-only rule would sweep almost the whole mailbox and is refused), plain values
  are quoted so they can't break out of the query, a backlog failure is reported in `applied.error`
  rather than raised (the filter still stands), and `create_filter`/`bulk_modify` are now marked
  `destructiveHint` since they can bulk-trash. Empty `bulk_modify` queries are rejected.
  This adds the `gmail.settings.basic` OAuth scope — **existing users must re-run `mailwarden --auth`
  once**; until then filter calls return an actionable insufficient-scope message. Not registered in
  `MAILWARDEN_READONLY` mode.
- **Label management.** New `create_label` tool creates a user label (idempotent —
  returns the existing id if the name is already taken) and supports nested labels via
  `/` (each missing parent level is created too). `modify_labels` and `bulk_modify` now
  advertise that `add`/`remove` accept a plain label **name** as well as an id — an
  unknown name in `add` is created automatically, an unknown name in `remove` is ignored.
  (The name-resolution itself already shipped; this exposes it and adds the explicit tool.)

### Security
- **Closed 4 transitive `npm audit` advisories** via `overrides` (none on mailwarden's own
  code path): `fast-uri`, `hono`, `ip-address`, `postcss`. Each pinned to an in-range fix,
  no major bumps; `npm audit` is back to 0 vulnerabilities.

## [0.3.0] - 2026-08-03

### Added
- **Guided `--auth`.** Before opening the browser, `mailwarden --auth` now validates
  `credentials.json` and, on any problem, prints an actionable message (missing file,
  unreadable file, invalid JSON, not an OAuth *client* file, missing `client_id`/`client_secret`)
  with a pointer to `docs/SETUP.md` — instead of local-auth's cryptic `Cannot find module` /
  `Cannot read properties of undefined`. After consent it makes one live Gmail call and
  confirms the authorized account (`✓ mailwarden authorized as you@example.com`), so a
  credential that stored but can't actually call Gmail is caught immediately.

### Fixed
- **Build from source now produces `dist/`.** Added a `prepare` script so an
  install from the git source (`npm install github:csitte/mailwarden`, or a
  source-based build) compiles TypeScript instead of leaving `bin` pointing at a
  non-existent `dist/index.js`. Consumers installing the published npm package are
  unaffected — the tarball already ships `dist/`, and `prepare` doesn't run for
  registry installs.

## [0.2.0] - 2026-08-02

### Security
- **`--http` is secure-by-default.** The HTTP listener now binds to `127.0.0.1`
  instead of every interface, and **refuses to start without a `MAILWARDEN_TOKEN`**
  (set `MAILWARDEN_ALLOW_NO_TOKEN=1` to opt into an unauthenticated endpoint on a
  trusted network). On a loopback bind it validates the `Host` header as a
  DNS-rebinding defense. New env vars: `MAILWARDEN_HOST`, `MAILWARDEN_ALLOW_NO_TOKEN`,
  `MAILWARDEN_ALLOWED_HOSTS`. The request body is now capped at 1 MB.
  **Breaking for `--http` users who ran without a token** — set one, or opt out explicitly.

### Fixed
- **Dead/revoked refresh token now yields an actionable error.** An expired
  `invalid_grant` (e.g. a "Testing" consent screen's 7-day expiry) surfaces as
  "Run `mailwarden --auth` to re-authorize" instead of a cryptic OAuth failure.

### Changed
- **One OAuth token refresh per process, not per tool call.** The authenticated
  client is cached for the process lifetime; previously every tool call rebuilt it
  and forced a fresh token-endpoint round-trip before the actual Gmail request.
- **`bulk_modify` reports truncation.** The result carries a `capped` flag, set
  when more messages matched than `maxMessages` (only the first `maxMessages` are
  processed) so callers can raise the cap or re-run instead of silently missing mail.

## [0.1.10] - 2026-07-25

### Fixed
- **`download_attachment` annotation corrected:** `idempotentHint` was `true` but
  the tool never overwrites (a second call with the same args writes `file-1.pdf`),
  which is non-idempotent. Now `idempotentHint: false`, matching the described
  behavior. (Caught by Glama's tool-definition-quality evaluation.)

## [0.1.9] - 2026-07-24

### Security
- **Cleared all `npm audit` advisories in the dependency tree** (`npm audit` now
  reports 0 vulnerabilities). None were on mailwarden's runtime path — all were
  transitive (chiefly via `@modelcontextprotocol/sdk`'s `hono` stack, which the
  server does not use; its HTTP mode runs on `express`) — but the tree is now
  clean so security scanners and Dependabot stop flagging it:
  - `@hono/node-server` forced to `^2.0.5` via `overrides` (fixes GHSA-frvp-7c67-39w9,
    path traversal in `serve-static` on Windows; the SDK still pins `^1.19.x`, so
    an override is the only way to lift it).
  - `hono`, `fast-uri`, and `body-parser` bumped to patched versions within range.

## [0.1.8] - 2026-07-23

### Added
- **`bulk_modify` tool:** batch label changes for every message matching a Gmail
  query via `messages.batchModify` — 1000 messages per API request instead of
  one modify per thread, with per-chunk partial-success reporting
  (`matchedMessages` / `modifiedMessages` / `modifiedThreadCount` /
  `modifiedThreads`, capped at 500 ids / `failed`). Rejects a call with neither
  `add` nor `remove` before spending any API quota; the description states that
  the query hits Gmail's index without search's live re-verification.
- **Structured outputs:** every tool declares an `outputSchema` and returns
  validated `structuredContent` alongside the fenced JSON text. Array results
  are now wrapped in objects: `list_labels` → `{ labels }`, `list_snoozed` →
  `{ snoozed }`.
- **Read-only mode:** `MAILWARDEN_READONLY=1` registers only the read tools
  (`search`, `get_thread`, `list_labels`, `list_snoozed`).

### Changed
- **`sweep_snoozed` is batched:** wakes due messages via `messages.batchModify`
  (listed per label with `messages.list`) instead of one `threads.modify` per
  thread — a 250-thread sweep is now a handful of API calls. The result gains
  `failedCount`/`errors`; a label whose batch fails is kept for the next sweep
  (snoozes are never lost), and `--sweep` logs failures.

## [0.1.7] - 2026-07-23

### Added
- **`search` is paginated:** pass `pageToken`, get `nextPageToken` back when more
  results exist. The result shape changed from a bare array to
  `{ threads, nextPageToken? }`.
- **MCP tool annotations** (`title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) and structured `USE WHEN / DO NOT USE /
  SIDE EFFECTS` descriptions on all 14 tools.
- **Prompt-injection fencing:** every tool result is wrapped in
  `<untrusted-tool-output>` markers (breakout-neutralized) and stripped of
  invisible/BiDi-override characters (`src/sanitize.ts`).
- **RFC 2047 header decoding** — non-ASCII Subject/From/To
  (`=?UTF-8?B?...?=`) now arrive as readable text.
- **429/5xx retry with exponential backoff** on every Gmail API call.
- `docs/ROADMAP.md` — planned work and non-goals.

### Changed
- **`download_attachment` never overwrites:** an existing file gets a numeric
  suffix (`file-1.pdf`); the response reports the path actually used. The
  `MAILWARDEN_DOWNLOAD_DIR` fence is realpath-canonicalized and re-checked
  after directory creation, so a symlinked subdirectory can no longer escape it.

### Fixed
- `google-auth-library` is now a declared dependency (it is imported directly;
  strict installers like pnpm failed the build on the phantom dependency).

## [0.1.6] - 2026-07-20

### Fixed
- **`mailwarden --auth` now always runs the browser consent flow.** Previously
  `getAuth` short-circuited on any stored `token.json` *before* checking whether
  it was an interactive re-auth, so once a refresh token had expired (Google
  expires them every 7 days while the OAuth consent screen is in "Testing",
  surfacing as `invalid_grant`) running `--auth` returned the dead token, never
  opened a browser, and still printed a success message. Re-auth is no longer a
  silent no-op. If Google completes consent without returning a refresh token,
  `--auth` now fails with a clear message instead of reporting false success.

## [0.1.5] - 2026-07-19

### Added
- **Published to npm** — install via `npx -y mailwarden`, no clone/build needed.
- `mcpName` field + `server.json` for listing in the official MCP registry.
- `repository`, `homepage`, and `bugs` metadata so the npm and registry pages
  link back to the source.
- `prepublishOnly` script (`build && test`) so a stale `dist/` can never ship.
- README now leads with an `npx` quick-start; Claude Desktop JSON snippet and a
  "from source" section added.

### Added (test suite)
- **Test suite expanded from 46 to 82 tests** — now covering `parseMessage`,
  `getThread`, `getThreadSubject`, `listThreadIdsByLabel`, `ensureLabel`,
  `trash`/`untrash`/`deleteLabel`, `search` pagination + chunked early-break,
  the `downloadAttachment` directory fence, `snooze`/`unsnooze`/`listSnoozed`,
  sweep label arguments, and the full `auth` module (token load, consent flow,
  persistence, error paths) via a mocked `@google-cloud/local-auth`.
- `npm run coverage` (new `@vitest/coverage-v8` dev-dependency): 100 % line and
  function coverage, ~99 % statements on `auth`/`gmail`/`snooze`; `index.ts`
  (CLI/transport wiring) and `tools.ts` (declarative MCP registration) are
  excluded from the report.

## [0.1.4] - 2026-07-19

### Fixed
- **HTTP transport: fresh `McpServer` per request.** A single shared server was
  `connect()`ed to a new transport on every POST; each connect replaces the
  previous transport, cross-wiring concurrent requests. Stateless mode now
  builds a per-request server (`makeServer()`), as the SDK intends.
- **Snooze sweep uses the local calendar date, not UTC.** East of Greenwich a
  sweep shortly after local midnight still saw yesterday's date and woke
  today's snoozes hours late.
- **Sweep can no longer lose snoozes.** A dated label is only deleted after a
  listing proves it empty; previously the label was deleted even when the
  drain loop hit its iteration cap, leaving archived threads without their
  snooze label — never to resurface.
- **Sweep and `list_snoozed` filter by exact `labelIds`** (new
  `listThreadIdsByLabel`, fully paginated) instead of a `label:"…"` search
  query — the search index can lag behind just-applied label changes, and the
  old path fetched full thread bodies it never needed. `list_snoozed` is no
  longer capped at 100 threads per date.
- **Non-UTF-8 bodies decode correctly.** `collectBodies` now honors the
  part's `Content-Type` charset (ISO-8859-1 / windows-1252 mail was mojibake);
  unknown charset labels fall back to UTF-8.
- **`snooze` rejects impossible dates.** `2026-99-99` passed the format regex
  and produced a label that would not become due for months; dates are now
  validated as real calendar dates and must not lie in the past.
- **Sweep never deletes non-dated sub-labels.** A manual label like
  `MCP/Snoozed/Archiv` was matchable by the dueness check; only strict
  `YYYY-MM-DD` suffixes are swept.
- **Label names resolve case-insensitively** in `modify_labels`/`ensureLabel`,
  matching Gmail's case-insensitive uniqueness — `todo` no longer triggers a
  doomed create when `ToDo` exists.
- **Quoted queries disable the search post-filter.** A literal `is:unread`
  inside a quoted phrase was parsed as a predicate and wrongly dropped hits.
- **`search` follows `pageToken`s** when collecting candidates — a single list
  page may return fewer threads than requested even when more exist.
- The MCP handshake reports the real package version (was hardcoded `0.1.1`).
- `--auth` fails with a clear message when `credentials.json` is missing or
  malformed (was a bare `TypeError`).

### Changed
- `search` fetches thread details in parallel chunks of 8 (was strictly
  sequential — a filtered search could take many seconds).
- `download_attachment` creates the destination directory, and honors a new
  `MAILWARDEN_DOWNLOAD_DIR` env var that confines writes to that directory —
  strongly recommended for HTTP-hosted deployments, where an unconfined
  `destPath` amounts to an arbitrary file write on the server.
- HTTP bearer-token check uses a constant-time comparison.
- `MAILWARDEN_AUTO_SWEEP=1` sweeps once at startup (first tick used to be an
  hour away); the timer no longer keeps a closing process alive (`unref`).
- `token.json` is written with mode `0600` (contains a refresh token).
- Tool registration migrated from the deprecated `server.tool()` to
  `server.registerTool()` (SDK ≥ 1.12 API); test suite grown to 46 tests.

## [0.1.3] - 2026-07-19

### Fixed
- **Attachments with a `Content-ID` but no `Content-Disposition` are no longer
  dropped.** Some mailers (e.g. maut1 invoice PDFs) tag a real attachment with a
  `Content-ID` and omit the disposition header; the old heuristic treated any
  `Content-ID` part as inline, so `get_thread` returned `attachments: []` and
  `search` reported `hasAttachments: false` — making the file impossible to
  download. A part without an explicit disposition now counts as inline only when
  its `Content-ID` is actually referenced via `cid:<id>` in the message body
  (new `referencedCids()` helper); an unreferenced `Content-ID` is a real
  attachment, and `Content-Disposition: attachment` always wins.

## [0.1.2] - 2026-06-23

### Fixed
- **`search` now re-verifies read-state/category predicates against each hit's live labels.**
  Gmail's `threads.list` index silently drops `is:unread` in some operator
  combinations (e.g. `category:updates is:unread -in:inbox` returned read mail
  too). Since every hit is already fetched live, the query's unambiguous
  predicates — `is:unread`/`is:read`, `is:starred`/`is:unstarred`,
  `is:important`, `in:inbox`/`in:trash`/`in:spam`, `category:…`, each with
  negation — are now checked against the thread's true labels and index false
  positives are dropped. `OR` / parenthesised / braced queries disable the
  post-filter so the user's boolean logic is left untouched; `label:NAME` is not
  resolved here.

### Changed
- When a label post-filter is active, `search` scans a full candidate page
  (≤100) and stops once `maxResults` threads genuinely match, so `maxResults`
  stays meaningful instead of silently short.

### Added
- Pure, unit-tested helpers `deriveLabelFilters` / `threadMatchesFilters`, plus
  12 vitest cases (suite now 30 tests).

## [0.1.1] - 2026-06-20

### Fixed
- **Attachment detection in `search`:** fetch threads with `full` format instead
  of `metadata` so MIME parts are present — `metadata` omits `payload.parts`, so
  attachment detection always returned false.
- **Inline images no longer counted as attachments:** `collectAttachments`
  filters on `Content-Disposition` (and `Content-ID` / `X-Attachment-Id`), so
  logos and tracking pixels are excluded while real files (and headerless
  attachments) are kept.
- **`sweep_snoozed` could miss threads** when more than 100 shared a due date —
  pagination loss fixed.
- **`modify_labels` resolves human-readable names → label ids** (e.g. `STARRED`,
  `ToDo`, `MCP/Snoozed`); unknown names in `add` are created, unknown names in
  `remove` are skipped. Pure label ids still pass through without a lookup.
- **Body decoding uses `base64url`** (Gmail's alphabet) — content containing `-`
  or `_` is no longer corrupted.
- Security: override `uuid` to `^11.1.1` (GHSA-w5hq-g745-h8pq); dependency bump
  for esbuild + vitest 4.1.9.

### Added
- vitest test suite (`test/gmail.test.ts`, `test/snooze.test.ts`).

### Changed
- Refactor toward testability: pure `collectBodies` / `collectAttachments` /
  `parseMessage` and an injectable Gmail API client.
- Author / copyright set to C.Sitte Softwaretechnik.

## [0.1.0] - 2026-06-18

### Added
- Initial release: a native Gmail [MCP](https://modelcontextprotocol.io) server
  talking straight to the live Gmail API (no synced snapshot).
- Read/find tools: `search`, `get_thread`, `list_labels`.
- Mailbox actions: `modify_labels`, `archive`, `mark_read`, `mark_unread`,
  `trash`, `untrash`.
- `download_attachment` — save an attachment to a local path.
- **Snooze** (no native Gmail API equivalent): `snooze`, `unsnooze`,
  `list_snoozed`, `sweep_snoozed`, built on dated `MCP/Snoozed/<YYYY-MM-DD>`
  labels; sweep on demand, via `mailwarden --sweep`, or hourly with
  `MAILWARDEN_AUTO_SWEEP=1`.
- Transports: stdio (local) and Streamable HTTP (VPS / claude.ai custom
  connector). OAuth scope `gmail.modify`.
- `package-lock.json` for reproducible installs.

[Unreleased]: https://github.com/csitte/mailwarden/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/csitte/mailwarden/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/csitte/mailwarden/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/csitte/mailwarden/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/csitte/mailwarden/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/csitte/mailwarden/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/csitte/mailwarden/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/csitte/mailwarden/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/csitte/mailwarden/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/csitte/mailwarden/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/csitte/mailwarden/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/csitte/mailwarden/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/csitte/mailwarden/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/csitte/mailwarden/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/csitte/mailwarden/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/csitte/mailwarden/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/csitte/mailwarden/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/csitte/mailwarden/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/csitte/mailwarden/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/csitte/mailwarden/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/csitte/mailwarden/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/csitte/mailwarden/releases/tag/v0.1.0

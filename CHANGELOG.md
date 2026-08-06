# Changelog

All notable changes to **mailwarden** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/csitte/mailwarden/compare/v0.4.0...HEAD
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

# Changelog

All notable changes to **mailwarden** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `docs/COMPETITORS.md` — source-level analysis of the four main Gmail MCP
  competitors.

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

[Unreleased]: https://github.com/csitte/mailwarden/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/csitte/mailwarden/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/csitte/mailwarden/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/csitte/mailwarden/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/csitte/mailwarden/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/csitte/mailwarden/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/csitte/mailwarden/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/csitte/mailwarden/releases/tag/v0.1.0

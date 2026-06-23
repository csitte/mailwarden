# Changelog

All notable changes to **mailwarden** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/csitte/mailwarden/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/csitte/mailwarden/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/csitte/mailwarden/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/csitte/mailwarden/releases/tag/v0.1.0

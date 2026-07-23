# Competitive landscape: Gmail MCP servers

Source-level analysis of the four most relevant competitors on [Glama](https://glama.ai/mcp/servers?query=gmail),
done 2026-07-23 (shallow clones, versions as noted). Everything below was verified in code, not marketing copy.

**TL;DR:** None of the four ships snooze. None handles Gmail's loose search index. mailwarden's niche
(reliable triage, snooze, dual transport, no send = no exfiltration surface) holds up under code inspection.

## klodr/gmail-mcp — v1.3.1, ~468 ★

The security gold standard. ~8.3k LOC source, ~13k LOC tests (731 cases incl. property/fuzz testing via
fast-check). Fork lineage: GongRzhe → ArtyMcLabin TS port → klodr's hardening layer.

**Strengths (worth copying):**
- Path jails with realpath canonicalization, validate-before-mkdir + re-check after (symlink-swap race),
  `O_NOFOLLOW|O_EXCL` leaf writes (`utl.ts`).
- OAuth loopback flow with CSRF `state`, timing-safe byte-length-checked compares, fd-based bounded JSON
  reads (TOCTOU), full credential redaction in error logs.
- Prompt-injection fencing: every tool output wrapped in `<untrusted-tool-output>` with close-tag
  neutralization; control/BiDi char stripping.
- Tool descriptions with `USE WHEN / DO NOT USE / SIDE EFFECTS` + accurate MCP annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- Scope-gated registration: `tools/list` only advertises tools the stored token can actually use.
- Supply-chain rigor: CodeQL, OSV, Scorecard, gitleaks, pinned actions, npm provenance.

**Weaknesses:**
- stdio only — no HTTP transport, no remote story. No multi-account.
- No snooze, no scheduled send, no vacation responder, no watch/push.
- `search_emails` is N+1 (one `messages.get` per hit) with no pagination surfaced; free-text output.
- Flagship protections (recipient allowlist, rate limits) are **off by default**; rate limiter has an
  acknowledged cross-process race.
- Node >=22.23 required; path-jail symlink guarantees weaker on Windows (`O_NOFOLLOW` semantics).
- Heavy abstraction: middleware stack shared with unrelated invoicing/fax MCP template siblings.

## shinzo-labs/gmail-mcp — v1.7.4, ~64 ★

Breadth play: 64 thin wrapper tools (near 1:1 Gmail REST mirror incl. settings, S/MIME, delegates,
send-as, filters) in a single 1,362-line `index.ts`.

**Strengths:** genuinely complete API surface; good reply-threading/MIME quoting logic
(`In-Reply-To`/`References`, quoted-printable wrapping); `includeBodyHtml=false` default for context
economy; mature release engineering (changesets, npm provenance).

**Weaknesses (severe):**
- **Unauthenticated Streamable-HTTP server always starts** alongside stdio, even for local use; default
  port collides with the OAuth callback (both 3000).
- **Telemetry on by default** (opt-out), exporting OTel spans to `api.otel.shinzo.tech`.
- Plaintext token storage, no chmod; no PKCE, no `state` in OAuth flow.
- `update_draft` broken and commented out — but still listed in the README.
- `list_drafts` pagination loop re-reads the stale `nextPageToken` → **infinite loop** with >1 page.
- CRLF header injection possible in `constructRawMessage` (unsanitized to/cc/subject).
- Cannot send HTML bodies or attachments at all (`text/plain` MIME only).
- Tests exist but are not run in CI; auth-error tests test a copy of the logic, not the shipping code.

## d-mato/gmail-mcp — v0.1.10, ~235 ★

mailwarden's most direct competitor: same triage niche (15 tools, read/manage, no send), 838 LOC, clean
3-layer separation (tools → client → utils), Maintenance grade A.

**Strengths:** **zero-config onboarding** — bundled OAuth client, `npx` and go, no Google Cloud project
needed (almost certainly the driver of its stars); correct MCP error semantics (`isError` results via a
shared `wrapGmailError`); token file `0o600`; exact-pinned deps + Dependabot + Biome + CI gate + npm
provenance; well-tested pure helpers (MIME/body/HTML extraction incl. UTF-8/nested multipart).

**Weaknesses:**
- **OAuth client ID + secret committed in plaintext** in repo and npm package (`auth.ts:12-14`).
- OAuth callback binds all interfaces (no host arg), no `state`/CSRF.
- Unbounded `Promise.all` fan-outs (search: up to 50 concurrent gets; batch archive/trash: unbounded),
  all-or-nothing semantics, doesn't use Gmail's `batchModify`; no retry/backoff on 429.
- No pagination past 50, no attachments at all, no HTTP transport, no snooze.
- Naive regex HTML-to-text; UTF-8-only decode (garbles ISO-2022-JP etc.); RFC 2047 headers not decoded.
- `gmail.modify` + redundant `readonly` scope; auth failure exits the whole server process.
- Tests cover pure functions only — OAuth flow and Gmail client are untested.

## tavoyne/gmail-mcp — ~154 ★

Remote-only: Cloudflare Workers + Durable Objects, multi-account, schemas copied verbatim from
Anthropic's built-in Gmail connector. 13 tools, ~2.5k LOC.

**Strengths:** one-connector multi-account UX (`account` enum on every tool, `account:"all"` fan-out);
proper MCP OAuth (dynamic client registration + PKCE via `workers-oauth-provider`) plus static bearer
with `timingSafeEqual`; single-flight token refresh cache (prevents refresh stampede on 50-wide
fan-outs); best-quality hand-rolled MIME builder (nested multipart, RFC 2047, CRLF sanitization);
nested-label auto-creation.

**Weaknesses:**
- No send, **no attachment download** (metadata visible, bytes unreachable), no snooze, no archive/read
  convenience tools.
- **Zero tests.** Only quality gate is `tsc --noEmit`.
- Refresh tokens plaintext in KV, permanent; `SETUP_SECRET` leaks via the OAuth `state` param into
  Google's logs/browser history; single hard-coded `userId: "owner"` trust model.
- No 401 retry in `gmailFetch` — token expiry mid-request is a hard error.
- N+1 search fan-out forces a **paid Workers plan** (50-subrequest cap).
- Consumer Gmail second-class: design assumes Workspace "Internal" apps; personal accounts hit the
  7-day testing-token expiry (which mailwarden's production-consent setup avoids).
- `create_draft` schema says attachments unsupported, but the handler implements them — the false
  description suppresses a working feature.

## Where mailwarden stands

**Already ahead:** snooze/sweep (unique across all 20 Glama-listed Gmail servers); live re-verification
of search predicates against real labels (all four pass `q` through raw); hardened dual transport
(stdio + HTTP with bearer); production consent flow avoiding the 7-day token trap; no telemetry, no
unsolicited listening port.

**Adopted from this analysis:** MCP tool annotations + `USE WHEN / DO NOT USE / SIDE EFFECTS`
descriptions (klodr pattern).

**Candidate improvements, in rough priority:**
1. Onboarding friction (d-mato's lesson): guided `--auth` wizard / better setup docs — without the
   bundled-secret mistake (PKCE, bring-your-own client).
2. Search pagination (`nextPageToken`) and `batchModify` for bulk label ops with partial-success
   reporting — the exact spots where d-mato and klodr are weak.
3. RFC 2047 header decoding + charset handling in body extraction.
4. Path-jail hardening of the download fence (realpath + post-mkdir re-check) and
   `<untrusted-tool-output>` fencing, both after klodr's `utl.ts`/`sanitize.ts`.
5. Send/drafts remain a deliberate non-goal: "no send = no exfiltration surface" is a defensible,
   marketable position (d-mato and tavoyne run it successfully).

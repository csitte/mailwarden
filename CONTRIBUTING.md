# Contributing to mailwarden

Bug reports, questions and pull requests are all welcome. This file is short on purpose: it
covers what is genuinely specific to this project, and trusts you with the rest.

## Reporting a bug

Run with `MAILWARDEN_DEBUG=1` and include the full error. Mention your Node version
(`node -v`, needs ≥ 20), the tier you run (`MAILWARDEN_TOOLS`, default is all), and the client
(Claude Desktop, Claude Code, VS Code, plain HTTP …).

Please redact message ids, subjects and addresses — a bug that only reproduces with your real mail
is still reproducible with a description of the *shape* of the mail.

## Before you open a pull request

```bash
npm install
npm run build            # tsc, must be clean
npm test                 # vitest, must be green
npm run smoke            # packs the tarball, installs it, speaks MCP to it
```

New logic needs tests. There is no coverage threshold to game — the useful question is whether a
future change that breaks your feature would fail a test.

One feature per commit, [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`). Everything in this repository is written in English, commit messages
included. (German umlauts inside test fixtures are not German text — `"Grüße für März"`,
`münchen.example` and friends exercise RFC 2047, IDN and label handling. Leave them alone.)

## Design rules that are not up for grabs

These are the reason the project exists. A PR that crosses one will be declined however good the
code is — so please ask in an issue first if you want to change one.

- **No sending. At all.** No compose, reply, forward or send tools, and `create_filter` never
  builds a forwarding rule. This is the central promise against prompt-injection exfiltration:
  a malicious message that reaches the model finds no outbound path. It is enforced in three
  places — the tools that exist, the OAuth scopes each tier requests, and `src/egress.ts`, an
  allow list checked around every API request.
- **No hard delete.** `trash`/`untrash` only, because those are recoverable.
- **No cache, no mailbox mirror, no search index.** Every call is live against the Gmail API. The
  only local state is `~/.mailwarden/` (credentials and tokens).
- **Tiers gate scopes.** `MAILWARDEN_TOOLS` decides both which tools register *and* which OAuth
  scopes `--auth` asks for. Please don't loosen that coupling.

### If you touch `src/egress.ts`

Using a Gmail endpoint that isn't on the allow list makes the call fail — that is the guard
working, not a bug. Add the endpoint there in the same PR.

The two lists in that file are deliberately asymmetric, and it matters:

- the **deny list** matches a *normalized* path (upload prefixes stripped, repeated slashes
  folded), because `googleapis` targets `/upload/gmail/v1/...` for media uploads — a real send
  route that rules anchored at `/gmail/v1` never saw;
- the **allow list** matches the **raw** path and must keep doing so, or every permitted endpoint
  would gain a second, unchecked spelling.

Rule of thumb: the deny list should be as wide as the API really is, the allow list as narrow as
mailwarden really is.

## Code shape

Keep pure logic separate from IO: a testable pure function plus a thin IO layer around it
(`buildReport`, `resolveSnoozeDate`, `deriveLabelFilters`, `classifyBatchModify` are the pattern).
It is what makes the interesting parts testable without mocking Gmail.

Layout: `auth.ts` (OAuth, tokens, accounts) · `gmail.ts` (API wrapper) · `tools.ts` (MCP tool
registration) · `tiers.ts` (tiers → scopes) · `snooze.ts` · `digest.ts` · `signals.ts` ·
`unsubscribe.ts` (RFC 8058 + SSRF guard) · `sanitize.ts` (output fencing) · `egress.ts` ·
`http.ts` · `doctor.ts` (`--check`) · `cli.ts` · `index.ts`.

## A note on claims

Anything the docs assert about behaviour should be checked against the code, and anything they
assert about *another* project should be checked against that project's source — including
statements that are already there. Both kinds of claim go stale silently, because nobody tests a
sentence. If you notice one that no longer holds, correcting it is a welcome PR on its own.

## Security

Please don't open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the [MIT license](LICENSE).

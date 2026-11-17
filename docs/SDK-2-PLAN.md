# Plan: moving to MCP SDK 2.x (issue #8)

Surveyed on 17 Nov 2026 against `@modelcontextprotocol/sdk` 1.32.2 and
`@modelcontextprotocol/server` 2.4.0 (latest; its type definitions and runtime were read from the
published package). The v2 docs at `ts.sdk.modelcontextprotocol.io/v2/` were read in part, and every
point below that rests on them alone is marked **(docs)**.

## Status

- **Step 1 is built** on branch `feat/sdk-2` (17 Nov 2026): the v2 packages are in, the protocol is
  held at the 2025 revisions, and the confirmation guard is in place. Not merged, not released.
- **Step 2 is not started.**

The four measurements this plan asked for came before any code. The third one changed step 1:

1. **A confirmation timeout** raises `SdkError` with `SdkErrorCode.RequestTimeout` in 2.4.0 (not a
   `ProtocolError`). `confirmWithUser` matches on that, and the ten-minute test passes.
2. **Elicitation over our HTTP mode on 1.32.2 does not work today.** The per-request server never
   saw the client's `initialize`, so `getClientCapabilities()` is `undefined` and `elicitInput`
   throws "Client does not support form elicitation". Step 1 takes nothing away there.
3. **Claude Code 2.1.318 opens with `server/discover`** for 2026-07-28 and sends the 2025
   `initialize` only when that fails (measured with a logging stub server). A v2 server wired with
   `serveStdio` accepts the probe. The connection then runs on 2026-07-28, `elicitInput` throws
   there, and `getClientCapabilities()` reads `undefined`. The step 1 planned first ("refuse
   confirmable actions on 2026-era connections") would therefore have switched off every dialog for
   Claude Code users on the day of release. **What step 1 does instead:** it keeps both transports
   wired by hand (`McpServer.connect` on `StdioServerTransport`, and `NodeStreamableHTTPServerTransport`
   per request). That wiring answers `server/discover` with -32601 "method not found", which is
   what a 1.x server answers too. Checked live: Claude Code 2.1.318 against the step 1 build gets
   -32601, falls back to `initialize` with 2025-11-25, and receives the server `instructions`.
   Claude Desktop could not be measured here (no MCP logs found for the Store install).
4. **The raw-shape `registerTool` overloads** are `@deprecated` in 2.4.0 without a removal date.
   Wrapping the 30 shapes in `z.object(...)` is left for step 2.

## Summary

The API move itself is small. mailwarden reaches the SDK in four source files and three test files,
mostly through imports that only changed their names. **The one change that matters is
elicitation:** under the 2026-07-28 protocol, a handler can no longer ask the client a question
mid-call. It returns an `input_required` result instead, and the client calls the tool again with
the answer. Four actions (`unsubscribe`, `bulk_unsubscribe`, `create_filter` and both draft tools)
get their human yes this way, so their confirmation flow has to be rebuilt, not renamed. Doing
that naively would open a gap that does not exist today (see "Risks").

**Two steps, no home-made compatibility layer:**

1. **Step 1, the SDK swap, held at the 2025 protocol (built).** The v2 packages and their new
   imports go in. Stdio and HTTP stay wired by hand, so every client negotiates a 2025 revision.
   Confirmations keep the push-style `elicitInput`, which v2 serves on those connections. As a
   guard for the next change, `ask` and `require` refuse if a connection ever runs on 2026-07-28
   anyway; tests pin the wiring and the guard. Releasable on its own.
2. **Step 2, multi-round confirmation (est. 5 calendar days, ~1.5 of them review and live testing
   on both eras).** The four dialog sites move to `inputRequired()`, with each answer bound to the
   dialog that was shown. Then switch to `serveStdio`/`createMcpHandler`, so that 2026-era
   clients get the dialogs too.

The big-bang alternative merges both steps into one release. It saves a release cycle but puts a
mechanical change, which is easy to review, together with a security-relevant redesign, which is
not, and a regression would then be hard to place. Under `docs/RELEASE-CHECKS.md` the second needs
its own review round anyway.

**Not urgent.** Holding the 2025 revisions costs no current client anything: Claude Code falls back
without a word. The pages read name no end-of-life date for 1.x or for the 2025 revisions.

## Where mailwarden touches the SDK

| Place | 1.32.2 | 2.4.0 (step 1 as built) |
|---|---|---|
| `src/index.ts` | `McpServer` from `sdk/server/mcp.js`; `StdioServerTransport` + `connect()` | `McpServer` from `@modelcontextprotocol/server`, `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, still `connect()`. **Not** `serveStdio`, which would serve 2026-07-28 (measurement 3). `instructions` is still a server option. |
| `src/http.ts` | a fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection, allowedHosts })` per request, in our Express app with host and bearer checks | Same shape with `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`, which takes the same options and serves the 2025 revisions only. `createMcpHandler` (step 2) would serve 2026-07-28 as well. |
| `src/tools.ts`: 33 `registerTool` calls | Zod **raw shapes** for `inputSchema`/`outputSchema` | Unchanged; accepted through the `@deprecated` overloads. |
| `src/tools.ts`: `guarded()` | casts around `McpServer["registerTool"]` | Unchanged; type-checks against 2.4.0 as it is. |
| `src/tools.ts`: `confirmWithUser` | `server.server.getClientCapabilities()`, `server.server.elicitInput(..., { timeout })`, `McpError` + `ErrorCode.RequestTimeout` | Same calls (deprecated in 2.4.0, working on 2025 connections); `SdkError` + `SdkErrorCode.RequestTimeout`. New: `dialogPlan()` also reads `getNegotiatedProtocolVersion()`, see Risk 1. |
| `src/tools.ts` `bulk_unsubscribe` | its own `getClientCapabilities()` read | goes through `dialogPlan()` too |
| Tests: `confirm.test.ts`, `draft-tools.test.ts`, `tools.test.ts` | `Client` + `InMemoryTransport` from the 1.x package, `ElicitRequestSchema` handler | `Client` from `@modelcontextprotocol/client` (devDependency), `InMemoryTransport` from `@modelcontextprotocol/server` on both ends, `setRequestHandler("elicitation/create", ...)`, `callTool(params, options)` (the result-schema argument is gone). New: `test/protocol-era.test.ts`. |
| `scripts/smoke-package.mjs`, `scripts/build-mcpb.mjs` | no SDK import | Unchanged; both pass on the step 1 build. |

Behaviour confirmed **unchanged** (2.4.0 runtime against 1.32.2): a handler that throws still comes
back as `isError: true`. Structured content is still validated against the output schema, a
mismatch is still an `InvalidParams` protocol error, and `isError` results are still exempt. The
sanitizer path in `src/sanitize.ts` does not touch the SDK.

## What changes on the wire

- **`tools/list`, measured over all 33 tools** (0.31.2 against the step 1 build, sorted keys):
  identical except that every schema names JSON Schema 2020-12 instead of draft-07, and the
  `execution.taskSupport: "forbidden"` field is gone. The docs' warning that
  `additionalProperties: false` would be dropped did not apply to these schemas.
- An unknown or disabled tool rejects with `-32602` instead of an `isError` result **(docs)**,
  for example a tool whose tier is off. No test depends on the old answer. Before step 2, check
  whether any doc describes it.
- `ctx.mcpReq.signal` fires when the transport closes **(docs)**, so long bulk runs get aborted
  instead of finishing silently. Worth a test in step 2.

## Dependencies

The direct runtime dependencies of the MCP layer shrink. `@modelcontextprotocol/server` 2.4.0
depends only on `@modelcontextprotocol/core` and `zod`, where the 1.x package had 17 direct
dependencies (ajv, express, hono, cors, jose, eventsource, express-rate-limit, ...). The HTTP
adapter `@modelcontextprotocol/node` brings `hono` and `@hono/node-server`. Both were in the tree
before through the 1.x package, and the `overrides` floors from 0.31.2 still apply to them, so the
exposure stays as it was. Converting Express `req`/`res` to web `Request`s ourselves would keep hono
out of the tree, at the cost of our own code on the request path. That option stays open. Zod
`^4.6.7` already meets v2's `^4.2.0`. `npm audit --omit=dev` reports 0.

## Risks

1. **Silent loss of the dialog on 2026-era connections.** `confirmPlan` goes ahead *unasked* under
   `ask` when the client cannot show a form. On a 2026-07-28 connection `getClientCapabilities()`
   reads `undefined` (measured), so a plain switch to `serveStdio` would let every `ask` dialog
   vanish without a word. **Held in step 1 twice.** The hand-wired transports keep 2026-07-28 off,
   and `test/protocol-era.test.ts` fails if `serveStdio`/`createMcpHandler` appear or if the probe
   is accepted. The second guard is `confirmPlan(..., noDialogInThisEra)`: `ask` and `require` both
   refuse when the negotiated revision is 2026-07-28 or later. The tests are red without the guard
   (5 of them, checked). Two limits, from the review on 17 Nov 2026:
   - The guard reads the *negotiated* revision. An instance that negotiated nothing (stateless
     HTTP, or stdio with no `initialize`) reads `undefined` even when a request carries a
     2026-07-28 `_meta` envelope. That is the 1.32.2 behaviour, not a regression, but step 2 must
     read the era per request (`ctx.mcpReq.envelope`), not per connection.
   - "Capabilities read as absent" holds for `serveStdio`. `createMcpHandler` backfills
     `getClientCapabilities()` per request from the envelope, so there the dialog would be attempted
     and fail at `elicitInput` (as a refusal), not skipped.
   - Over HTTP, a `server/discover` that already carries `MCP-Protocol-Version: 2026-07-28` gets
     HTTP 400 "Unsupported protocol version", not -32601. No 2026 session comes of it either way;
     whether a client then falls back to 2025 over HTTP is not measured.
2. **An answer bound to the wrong question (step 2).** With `inputRequired`, the handler runs
   twice, once to ask and once with the answer. On the 2026 era the client sends the second call,
   **with the arguments again**. A yes given for one set of recipients could therefore come back
   attached to a different set, or the thread could gain a message between the rounds and change
   the computed recipients. The SDK says explicitly that `requestState` comes back as
   attacker-controlled input and must be integrity-protected (HMAC/AEAD) if it influences anything.
   The plan is to recompute the dialog text on re-entry from the arguments and the live thread,
   and to accept the answer only if a keyed digest of that text matches the one minted in round
   one; otherwise the dialog is shown again. This part needs a corpus of re-entry cases, not just
   a code read.
3. **Double reads (step 2).** The legacy shim runs the handler twice on 2025-era connections as
   well (seen in the 2.4.0 runtime), so the Gmail reads before a dialog happen twice. That costs
   quota, not correctness, but `draft-flow.ts` should be split into "prepare" and "commit" so round
   two repeats no more than it must.
4. **Stateless HTTP and dialogs.** Settled by measurement 2: no dialog over HTTP today, none lost.
   With `inputRequired` (step 2) HTTP could get dialogs for the first time, because the answer
   comes back in a new request.
5. **`bulk_unsubscribe` confirms a rehearsal, not the run (found in the same review, older than
   this change).** The dialog lists the hosts from a dry run; the real run reads the threads again
   and asks no question of its own. A thread whose read fails in the rehearsal is missing from the
   dialog and still contacted in the run; if every read fails, no dialog is shown at all, even under
   `require`. A sender whose first request throws is not remembered, so its second thread is
   contacted, possibly at another host, though the dialog listed it as a duplicate. **Fixed
   17 November 2026, on this branch:** the real run is held to the dialog's thread-to-endpoint list
   (`approved` in `bulkUnsubscribe`), and everything outside it is reported, not contacted. Step 2
   must keep that binding when the dialog moves to `inputRequired`: the rehearsal then runs in round
   one and the list has to travel in the protected `requestState`. Each listed thread gets one
   attempt, so a thread id given twice cannot buy a second request after the first threw. Still open,
   and older: a request that went out and then failed (a redirect the vetting refuses, a timeout, a
   dropped connection) leaves the sender unrecorded, because the record is written only for a
   returned result; a LATER call contacts that sender again without a duplicate note.

## Estimate for step 2

Calendar days, no weekend buffer.

| Work | Review / waiting | Total |
|---|---|---|
| 3.5 (draft-flow split 1; `inputRequired` at four sites with state binding 1.5; re-entry corpus and both-era tests, switch to `serveStdio`/`createMcpHandler` 1) | 1.5 (two review rounds, live dialog test on both eras) | **5** |

Step 1 took one day of work. The review rounds and the release are still to come. Waiting time on
Chris (decisions, `npm version`) is not included.

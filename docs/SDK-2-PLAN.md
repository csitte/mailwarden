# Plan: moving to MCP SDK 2.x (issue #8)

Survey only: no code has changed. The goal is to choose between a single big change and a staged
one before anyone writes code. Surveyed on 17 Nov 2026 against `@modelcontextprotocol/sdk` 1.32.2
(installed) and `@modelcontextprotocol/server` 2.4.0 (latest; its type definitions and runtime
were read from the published package). The v2 docs at `ts.sdk.modelcontextprotocol.io/v2/` were
read in part, and every point below that rests on them alone is marked **(docs)**.

## Summary

The API move itself is small, but one part of it is a security question. mailwarden reaches the
SDK in four source files and three test files. Most of that is renamed imports. **The one change
that matters is elicitation:** under the 2026-07-28 protocol, a handler can no longer ask the
client a question mid-call. It returns an `input_required` result, and the client calls the tool
again with the answer. Four actions (`unsubscribe`, `bulk_unsubscribe`, `create_filter`, and both
draft tools) get their human yes this way, so their confirmation flow has to be rebuilt, not
renamed. Doing that naively would open a gap that does not exist today (see "Risks").

**Recommendation: two steps, no home-made compatibility layer.**

1. **Step 1, SDK swap (est. 4 calendar days, ~1 of them review):** v2 packages and new imports,
   with stdio and HTTP rewired. Confirmations keep the push-style call (`ctx.mcpReq.elicitInput`),
   which v2 still serves on 2025-era connections, the only kind today's clients open. On a
   2026-era connection, every confirmable action **refuses**: it neither proceeds nor asks. This
   step can be released on its own.
2. **Step 2, multi-round confirmation (est. 5 calendar days, ~1–2 of them review and live
   testing on both eras):** rebuild the four dialog sites on `inputRequired()` and bind the answer
   to what was shown. After this, 2026-era clients get the dialogs too.

The big-bang alternative merges both steps into a single release. It saves one release cycle, but
it combines a mechanical change, which is easy to review, with a security-relevant redesign, which
is not. A regression would then be hard to place. Under `docs/RELEASE-CHECKS.md`, the second
needs its own review round anyway.

**Not urgent.** v2 still negotiates the 2025 handshake with every current client. **(docs)**
says published 1.29.x and v2 ship the same supported-version list, ending at 2025-11-25. The
pages read name no end-of-life date for 1.x; the issue text's "maintained into at least early
2027" was not re-checked here.

## Where mailwarden touches the SDK

| Place | Today (1.32.2) | In 2.4.0 |
|---|---|---|
| `src/index.ts` | `McpServer` from `sdk/server/mcp.js`; `StdioServerTransport` + `connect()` | `McpServer` from `@modelcontextprotocol/server`; `StdioServerTransport` / `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`. `instructions` is still a server option (verified in the type definitions), so the tier-aware text survives as it is. |
| `src/http.ts` | a fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection, allowedHosts })` per request, inside our own Express app with host check and bearer check | `createMcpHandler(factory)` (a fresh server per request is its model) behind `toNodeHandler` (`@modelcontextprotocol/node`). **(docs)**: the handler itself validates no Host, no Origin and no token, so our existing pure checks (`hostHeaderAllowed`, `bearerAuthorized`) stay in front. Those checks are the tested part, and `enableDnsRebindingProtection` / `allowedHosts` as transport options do not appear in the docs read. |
| `src/tools.ts`: 33 `registerTool` calls | Zod **raw shapes** for `inputSchema`/`outputSchema` | Raw shapes still accepted, but only through `@deprecated` overloads **(docs)**. Wrapping them in `z.object(...)` is mechanical (26 inline shapes plus 4 shared constants) and takes the deprecation off the table. It can come in step 1 or later. |
| `src/tools.ts`: `guarded()` | casts around `McpServer["registerTool"]` | The overloads changed. The cast has to be re-typed, but the behaviour (scope errors turn into `fail(...)`) stays. |
| `src/tools.ts`: `confirmWithUser` | `server.server.getClientCapabilities()`, `server.server.elicitInput(..., { timeout })`, `McpError` + `ErrorCode.RequestTimeout` | Handler context `ctx.mcpReq.elicitInput(params, { timeout })` (2025 era); `ProtocolError` / `ProtocolErrorCode` (and `SdkError` for local timeouts, **(docs)**, to verify which one a timeout raises); capabilities: see Risk 1. |
| `src/tools.ts` `bulk_unsubscribe` (line ~1461) | second direct `getClientCapabilities()` read | same as above |
| Tests: `confirm.test.ts`, `draft-tools.test.ts`, `tools.test.ts` | `Client` + `InMemoryTransport` from the 1.x package, `ElicitRequestSchema` handler | `Client` from `@modelcontextprotocol/client` (new devDependency), `InMemoryTransport` from the same package on both ends; `setRequestHandler('elicitation/create', ...)`. **(docs)** says `createLinkedPair()` connects 2025-era instances only. 2026-era tests have to go through `handler.fetch` in process. |
| `scripts/smoke-package.mjs`, `scripts/build-mcpb.mjs` | no SDK import; smoke speaks raw `initialize` + `tools/list` over stdio | Unchanged, but they are the check that the 2025 handshake still holds after the swap. |

Behaviour the survey confirmed is **unchanged** (2.4.0 runtime against 1.32.2): a handler that
throws still comes back as `isError: true`. Structured content is still validated against the
output schema, and a mismatch is still an `InvalidParams` protocol error. `isError` results are
still exempt. The sanitizer path in `src/sanitize.ts` does not touch the SDK.

## What else changes on the wire

- Tool schemas are emitted as JSON Schema 2020-12 without `additionalProperties: false` by
  default **(docs)**. Clients see slightly different schemas. Tests that read `inputSchema`
  properties (e.g. `tools.test.ts` around `get_thread`, `read_attachment`) may need re-baselining.
- An unknown or disabled tool now rejects with `-32602` instead of an `isError` result **(docs)**.
  That covers a tool that is not registered because its tier is off. Whatever an agent did with
  that answer before changes. Check whether any test or doc describes the old behaviour.
- `ctx.mcpReq.signal` fires when the transport closes **(docs)**. Long bulk runs get aborted
  instead of finishing silently. Arguably better, but it needs a test.

## Dependencies

Runtime dependencies shrink. `@modelcontextprotocol/server` 2.4.0 depends only on
`@modelcontextprotocol/core` and `zod`. The 1.x package has 17 direct dependencies (ajv, express, hono,
cors, jose, eventsource, express-rate-limit, ...). The HTTP adapter `@modelcontextprotocol/node`
brings `hono` and `@hono/node-server` back, the packages behind the seven 13 November advisories.
That trade-off is worth deciding on purpose. We could skip the adapter and convert Express
`req`/`res` to a web `Request` ourselves, which keeps hono out of the dependency tree. The cost is
one more piece of our own code on the request path. Zod `^4.6.7` already meets v2's `^4.2.0`.

## Risks

1. **Silent loss of the dialog on 2026-era connections.** `confirmPlan` proceeds *unasked*
   when the mode is `ask` and the client cannot show a form, and `ask` is a documented mode. On a
   2026-pinned connection, `getClientCapabilities()` returns `undefined` **(docs)**. A plain swap
   would therefore read every 2026 client as "cannot ask" and let `ask` go ahead with no dialog,
   as if the client lacked elicitation. Capabilities for that era come from the per-request
   envelope (`ctx.mcpReq.envelope`). Step 1 must not depend on that being right: on a 2026-era
   connection, `confirmWithUser` refuses outright. A test pins this down.
2. **An answer bound to the wrong question (step 2).** With `inputRequired`, the handler runs
   twice: once to ask and once with the answer. On the 2026 era, the client sends the second call,
   **with the arguments again**. A yes given for one set of recipients could therefore come back
   attached to a different set, or the thread could gain a message between the rounds and change
   the computed recipients. The SDK says explicitly that `requestState` comes back as
   attacker-controlled input and must be integrity-protected (HMAC/AEAD) if it influences
   anything. Plan: on re-entry, recompute the dialog text from the arguments and the live thread,
   and accept the answer only if a keyed digest of that text matches the one minted in round one.
   Otherwise, ask again. This is the part that needs a corpus of re-entry cases, not just a code
   read.
3. **Double reads.** The legacy shim runs the handler twice on 2025-era connections as well
   (confirmed in the 2.4.0 runtime). The Gmail reads before a dialog then happen twice. That costs
   quota, not correctness, but `draft-flow.ts` should be split into "prepare" (pure, reusable) and
   "commit" so round two does not repeat more than it must.
4. **Stateless HTTP and dialogs.** The shim's own error text says per-request legacy serving
   cannot receive server-to-client requests. Before step 1, measure whether our HTTP mode can show
   a dialog on 1.32.2 at all. If it cannot today, nothing is lost. If it can, step 1 would take it
   away.

## To verify before writing code (each a short measurement)

- Which error a confirmation timeout raises in 2.4.0 (`ProtocolError` with `RequestTimeout`, or
  `SdkError`), so that the retryable "nobody answered" message survives.
- Risk 4: elicitation over our HTTP mode on 1.32.2.
- Which protocol version Claude Code and Claude Desktop negotiate today. As long as both say
  2025-11-25, step 1 costs no user a dialog.
- The `@deprecated` raw-shape overloads: any removal date announced?

## Estimate

Calendar days, no weekend buffer.

| | Work | Review / waiting | Total |
|---|---|---|---|
| Step 1 | 3 (imports and types 0.5; HTTP rewiring 1; tests rewired and re-baselined 1; smoke, bundle, docs 0.5) | 1 (release checks, Grok round) | **4** |
| Step 2 | 3.5 (draft-flow split 1; `inputRequired` at four sites with state binding 1.5; re-entry corpus and both-era tests 1) | 1.5 (two review rounds, live dialog test on both eras) | **5** |

Waiting time on Chris (decisions, `npm version`) is not included.

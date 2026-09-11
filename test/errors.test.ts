import { describe, it, expect } from "vitest";
import { classifyError } from "../src/errors.js";
import { ToolError } from "../src/cli.js";
import { checkEgress, egressRefusal } from "../src/egress.js";

describe("classifyError", () => {
  it("takes a ToolError at its word — it was classified where it happened", () => {
    expect(classifyError(new ToolError("not_authorized", "Run --auth."))).toEqual({
      code: "not_authorized",
      message: "Run --auth.",
      retryable: false,
    });
    expect(classifyError(new ToolError("rate_limited", "slow down", true)).retryable).toBe(true);
  });

  it("recognises a dead refresh token in both shapes googleapis produces", () => {
    expect(classifyError({ response: { data: { error: "invalid_grant" } } }).code).toBe(
      "needs_reauth",
    );
    expect(classifyError(new Error("invalid_grant: Token has been expired or revoked.")).code).toBe(
      "needs_reauth",
    );
  });

  it("separates a scope shortfall from a plain 403", () => {
    const scope = { code: 403, errors: [{ reason: "insufficientPermissions" }], message: "no" };
    expect(classifyError(scope).code).toBe("insufficient_scope");
    // A 403 that is NOT about scopes (e.g. an admin policy) must not send the
    // user re-authorizing — nothing about a new grant would change it.
    expect(classifyError({ code: 403, message: "Permission denied by policy" }).code).toBe(
      "forbidden_operation",
    );
  });

  // The two status mappings a caller meets most often were checked against the
  // live API, not only against these shapes: a well-formed thread id that does not
  // exist answers 404 ("Requested entity was not found." → not_found), while a
  // malformed one answers 400 ("Invalid id value" → invalid_input). Gmail does not
  // treat "no such thing" and "that is not an id" as the same failure, and neither
  // do we — one is worth retrying with a different id, the other with a fixed one.
  it.each([
    [429, "rate_limited", true],
    [500, "upstream_unavailable", true],
    [503, "upstream_unavailable", true],
    [404, "not_found", false],
    [400, "invalid_input", false],
  ])("maps HTTP %i", (status, code, retryable) => {
    expect(classifyError({ code: status, message: `HTTP ${status}` })).toMatchObject({
      code,
      retryable,
    });
    // The same status nested the way other googleapis versions report it.
    expect(classifyError({ response: { status } }).code).toBe(code);
    // …and as the string googleapis sometimes uses.
    expect(classifyError({ code: String(status) }).code).toBe(code);
  });

  it("calls a request that never got an answer retryable", () => {
    for (const err of [
      { code: "ECONNRESET", message: "read ECONNRESET" },
      { code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN" },
      new Error("socket hang up"),
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    ]) {
      expect(classifyError(err), JSON.stringify(err)).toMatchObject({
        code: "network_error",
        retryable: true,
      });
    }
  });

  it("admits when it does not know, rather than guessing a retry", () => {
    expect(classifyError(new Error("Cannot read properties of undefined"))).toEqual({
      code: "internal_error",
      message: "Cannot read properties of undefined",
      retryable: false,
    });
    // Something that is not an Error at all still yields a usable message.
    expect(classifyError("boom")).toEqual({
      code: "internal_error",
      message: "boom",
      retryable: false,
    });
  });

  it("classifies an egress refusal as forbidden, never as retryable", () => {
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
    const reason = checkEgress("POST", url)!;
    expect(classifyError(egressRefusal("POST", url, reason))).toMatchObject({
      code: "forbidden_operation",
      retryable: false,
    });
  });
});

/**
 * Gmail reports a per-user quota overrun as a 403, not only as a 429. The
 * corpus below is the shape a live mailbox actually produced (reported twice in
 * one week from routine sweeps), plus the two 403s that must NOT be swept up
 * with it: a scope shortfall, which re-auth fixes and waiting does not, and an
 * administrative denial, which nothing fixes from here.
 */
describe("classifyError — a 403 that is really a rate limit", () => {
  const quotaMessage =
    "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' " +
    "of service 'gmail.googleapis.com' for consumer 'project_number:968304984367'.";

  it("calls the reported failure retryable, and says how long to wait", () => {
    // Verbatim from the field report: a mark_read that failed mid-run and
    // succeeded untouched a few minutes later.
    const err = Object.assign(new Error(quotaMessage), {
      code: 403,
      errors: [{ reason: "rateLimitExceeded", message: quotaMessage }],
    });
    expect(classifyError(err)).toEqual({
      code: "rate_limited",
      message: quotaMessage,
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it("reads the reason in either shape googleapis produces, and from the message alone", () => {
    for (const err of [
      { code: 403, message: "denied", errors: [{ reason: "userRateLimitExceeded" }] },
      {
        code: 403,
        message: "denied",
        response: { data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      },
      { code: 403, message: "denied", errors: [{ reason: "quotaExceeded" }] },
      // No reason array at all — only Google's sentence.
      { code: 403, message: quotaMessage },
    ]) {
      expect(classifyError(err)).toMatchObject({ code: "rate_limited", retryable: true });
    }
  });

  it("still fails fast on the two 403s that waiting cannot fix", () => {
    expect(
      classifyError({ code: 403, errors: [{ reason: "insufficientPermissions" }], message: "no" }),
    ).toMatchObject({ code: "insufficient_scope", retryable: false });
    expect(classifyError({ code: 403, message: "Permission denied by policy" })).toMatchObject({
      code: "forbidden_operation",
      retryable: false,
    });
  });

  it("carries the wait on a 429 too — same condition, different status", () => {
    expect(classifyError({ code: 429, message: "slow down" })).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterSeconds: 60,
    });
  });
});

describe("classifyError — the other shapes of the same quota", () => {
  it("reads Google's newer error body: an ErrorInfo reason, or RESOURCE_EXHAUSTED", () => {
    const message = "Resource has been exhausted (e.g. check quota).";
    for (const err of [
      {
        code: 403,
        message,
        response: {
          data: {
            error: {
              details: [
                { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
              ],
            },
          },
        },
      },
      { code: 403, message, response: { data: { error: { status: "RESOURCE_EXHAUSTED" } } } },
    ]) {
      expect(classifyError(err)).toMatchObject({
        code: "rate_limited",
        retryable: true,
        retryAfterSeconds: 60,
      });
    }
  });

  it("does not take a daily limit for a minute's wait", () => {
    expect(
      classifyError({
        code: 403,
        message: "Daily Limit Exceeded",
        errors: [{ reason: "dailyLimitExceeded" }],
      }),
    ).toMatchObject({ code: "forbidden_operation", retryable: false });
  });
});

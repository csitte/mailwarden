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

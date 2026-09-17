import { describe, it, expect } from "vitest";
import {
  scopeGapMessage,
  scopeShort,
  GMAIL_READONLY,
  GMAIL_MODIFY,
  GMAIL_SETTINGS_BASIC,
  type ToolTier,
} from "../src/tiers.js";

const tiers = (...t: ToolTier[]) => new Set<ToolTier>(t);
const CMD = "mailwarden --auth";

describe("scopeGapMessage", () => {
  it("says nothing when the grant covers the enabled tiers", () => {
    expect(scopeGapMessage([GMAIL_MODIFY, GMAIL_SETTINGS_BASIC], tiers("read", "manage", "filters"), CMD)).toBeNull();
    expect(scopeGapMessage([GMAIL_READONLY], tiers("read"), CMD)).toBeNull();
  });

  it("treats gmail.modify as covering gmail.readonly", () => {
    // A token granted for the full surface must not be reported as broken for a narrower
    // deployment — that would push a healthy setup into re-consenting with LESS.
    expect(scopeGapMessage([GMAIL_MODIFY], tiers("read"), CMD)).toBeNull();
  });

  it("names the missing scope, what it covers, and what IS granted", () => {
    const msg = scopeGapMessage([GMAIL_READONLY], tiers("read", "manage"), CMD);
    expect(msg).toContain("gmail.modify");
    expect(msg).toContain("every write");
    // The half the pre-existing runtime message could not have: what the token actually carries.
    expect(msg).toContain("It currently grants gmail.readonly");
    expect(msg).toContain(CMD);
    // The full URL belongs in a scope request, not in a sentence a human has to act on.
    expect(msg).not.toContain("https://www.googleapis.com/auth/");
  });

  it("reports a missing filter scope with the tools it disables", () => {
    const msg = scopeGapMessage([GMAIL_MODIFY], tiers("read", "manage", "filters"), CMD);
    expect(msg).toContain("gmail.settings.basic");
    expect(msg).toContain("create_filter");
  });

  it("reports both missing scopes at once", () => {
    const msg = scopeGapMessage([GMAIL_READONLY], tiers("manage", "filters"), CMD);
    expect(msg).toContain("gmail.modify");
    expect(msg).toContain("gmail.settings.basic");
  });

  it("handles a grant with no Gmail scope at all without reading as an empty list", () => {
    const msg = scopeGapMessage([], tiers("read"), CMD);
    expect(msg).toContain("no Gmail scope at all");
  });

  it("carries the account into the re-auth command it prints", () => {
    // A bare `mailwarden --auth` writes the DEFAULT token; telling a named-account user to run it
    // would overwrite a different account's token and leave their problem in place.
    const msg = scopeGapMessage([GMAIL_READONLY], tiers("manage"), "mailwarden --auth --account work");
    expect(msg).toContain("mailwarden --auth --account work");
  });

  it("agrees in singular and plural with the number of tiers", () => {
    expect(scopeGapMessage([GMAIL_READONLY], tiers("manage"), CMD)).toContain("tier (manage) needs");
    expect(scopeGapMessage([GMAIL_READONLY], tiers("read", "manage"), CMD)).toContain(
      "tiers (read, manage) need",
    );
  });
});

describe("scopeShort", () => {
  it("strips Google's scope prefix and leaves anything else alone", () => {
    expect(scopeShort(GMAIL_SETTINGS_BASIC)).toBe("gmail.settings.basic");
    expect(scopeShort("openid")).toBe("openid");
  });
});

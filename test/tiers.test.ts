import { describe, it, expect } from "vitest";
import {
  authScopesForTiers,
  GMAIL_READONLY,
  GMAIL_MODIFY,
  GMAIL_SETTINGS_BASIC,
  type ToolTier,
} from "../src/tiers.js";

const tiers = (...t: ToolTier[]) => new Set(t);

describe("authScopesForTiers", () => {
  it("requests modify+settings.basic for the default (all tiers) — unchanged from before", () => {
    expect(authScopesForTiers(tiers("read", "manage", "filters"))).toEqual([
      GMAIL_MODIFY,
      GMAIL_SETTINGS_BASIC,
    ]);
  });

  it("drops to read-only for a read-only surface", () => {
    expect(authScopesForTiers(tiers("read"))).toEqual([GMAIL_READONLY]);
  });

  it("uses modify (not readonly) whenever manage is enabled", () => {
    expect(authScopesForTiers(tiers("read", "manage"))).toEqual([GMAIL_MODIFY]);
    expect(authScopesForTiers(tiers("manage"))).toEqual([GMAIL_MODIFY]);
  });

  it("adds settings.basic only for the filters tier, over a readable base", () => {
    expect(authScopesForTiers(tiers("read", "filters"))).toEqual([GMAIL_READONLY, GMAIL_SETTINGS_BASIC]);
    // filters-only still keeps a base read scope so the post-consent smoke test works
    expect(authScopesForTiers(tiers("filters"))).toEqual([GMAIL_READONLY, GMAIL_SETTINGS_BASIC]);
  });
});

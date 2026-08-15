import { describe, it, expect } from "vitest";
import {
  authScopesForTiers,
  missingScopes,
  serverInstructions,
  ALL_TIERS,
  GMAIL_READONLY,
  GMAIL_MODIFY,
  GMAIL_SETTINGS_BASIC,
  type ToolTier,
} from "../src/tiers.js";

const tiers = (...t: ToolTier[]) => new Set(t);

describe("serverInstructions — what a tool-search client reads before it ever lists our tools", () => {
  it("stays under the 2 KB truncation point for every tier combination", () => {
    const combos: ToolTier[][] = [[], ["read"], ["manage"], ["filters"], ["read", "manage"], [...ALL_TIERS]];
    for (const c of combos) expect(serverInstructions(tiers(...c)).length).toBeLessThan(2000);
  });

  it("always states the two invariants an agent must know: no send, no permanent delete", () => {
    for (const t of [tiers(), tiers("read"), tiers(...ALL_TIERS)]) {
      const s = serverInstructions(t);
      expect(s).toMatch(/NO compose\/reply\/forward\/send tools/);
      expect(s).toMatch(/no permanent delete \(trash only\)/);
      expect(s).toMatch(/nothing is cached/);
    }
  });

  it("advertises only what the enabled tiers can do — a read-only deployment must not promise snooze", () => {
    const readOnly = serverInstructions(tiers("read"));
    expect(readOnly).toMatch(/search and read mail/);
    expect(readOnly).toMatch(/get_profile/);
    expect(readOnly).not.toMatch(/snooze/i); // neither as a job nor as a "use when" trigger
    expect(readOnly).not.toMatch(/Gmail filters/);

    const full = serverInstructions(tiers(...ALL_TIERS));
    expect(full).toMatch(/snooze a thread/);
    expect(full).toMatch(/unsubscribe/);
    expect(full).toMatch(/Gmail filters/);
  });

  it("does not point at get_profile when the read tier (which owns it) is off", () => {
    expect(serverInstructions(tiers("manage"))).not.toMatch(/get_profile/);
    expect(serverInstructions(tiers())).toMatch(/No tools are enabled/);
  });
});

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

describe("missingScopes — capability containment, not string equality", () => {
  it("treats gmail.modify as covering gmail.readonly", () => {
    expect(missingScopes([GMAIL_MODIFY], [GMAIL_READONLY])).toEqual([]);
    expect(missingScopes([GMAIL_MODIFY, GMAIL_SETTINGS_BASIC], [GMAIL_READONLY])).toEqual([]);
  });

  it("does not invent the reverse implication (readonly cannot cover modify)", () => {
    expect(missingScopes([GMAIL_READONLY], [GMAIL_MODIFY])).toEqual([GMAIL_MODIFY]);
  });

  it("reports each genuinely missing scope", () => {
    expect(missingScopes([GMAIL_READONLY], [GMAIL_READONLY, GMAIL_SETTINGS_BASIC])).toEqual([
      GMAIL_SETTINGS_BASIC,
    ]);
    expect(missingScopes([], [GMAIL_MODIFY])).toEqual([GMAIL_MODIFY]);
  });

  it("is satisfied by an exact grant", () => {
    expect(missingScopes([GMAIL_MODIFY, GMAIL_SETTINGS_BASIC], [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC])).toEqual([]);
  });
});

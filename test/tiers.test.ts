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
  // The whole input space: every subset of the three tiers (2^3 = 8), the empty set included.
  const everyCombo: ToolTier[][] = [
    [],
    ["read"],
    ["manage"],
    ["filters"],
    ["read", "manage"],
    ["read", "filters"],
    ["manage", "filters"],
    [...ALL_TIERS],
  ];

  it.each(everyCombo.map((c) => [c.join("+") || "(none)", c] as const))(
    "tiers %s: under 2 KB in BYTES (the text has non-ASCII dashes) and in characters",
    (_n, c) => {
      const s = serverInstructions(tiers(...c));
      expect(Buffer.byteLength(s, "utf8")).toBeLessThan(2048);
      expect(s.length).toBeLessThan(2000);
    },
  );

  it.each(everyCombo.map((c) => [c.join("+") || "(none)", c] as const))(
    "tiers %s: mentions snooze/unsubscribe only with manage, filters only with filters, get_profile only with read",
    (_n, c) => {
      const s = serverInstructions(tiers(...c));
      expect(/snooze/i.test(s)).toBe(c.includes("manage"));
      expect(/unsubscribe/i.test(s)).toBe(c.includes("manage"));
      expect(/Gmail filters/.test(s)).toBe(c.includes("filters"));
      expect(/get_profile/.test(s)).toBe(c.includes("read"));
      expect(/search and read mail/.test(s)).toBe(c.includes("read"));
    },
  );

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

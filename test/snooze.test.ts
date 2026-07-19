import { describe, it, expect } from "vitest";
import { isDue, isValidIsoDate, todayIso, sweepSnoozed, snooze } from "../src/snooze.js";
import { Gmail } from "../src/gmail.js";

describe("todayIso — local calendar date, not UTC", () => {
  it("formats a locally-constructed date as its local YYYY-MM-DD", () => {
    // new Date(y, m, d, …) is built in local time, so this must round-trip in
    // every timezone — with toISOString() (UTC) it would fail east of Greenwich
    // for times shortly after local midnight.
    expect(todayIso(new Date(2026, 5, 20, 0, 30))).toBe("2026-06-20");
    expect(todayIso(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("isValidIsoDate", () => {
  it("accepts real calendar dates", () => {
    for (const s of ["2026-01-01", "2026-06-20", "2024-02-29"]) {
      expect(isValidIsoDate(s)).toBe(true);
    }
  });
  it("rejects impossible or malformed dates", () => {
    for (const s of ["2026-99-99", "2026-02-30", "2026-13-01", "2023-02-29", "26-06-20", "foo", ""]) {
      expect(isValidIsoDate(s)).toBe(false);
    }
  });
});

describe("isDue — snooze dueness boundary", () => {
  const cutoff = "2026-06-20";

  it("date == today ⇒ due", () => {
    expect(isDue("MCP/Snoozed/2026-06-20", cutoff)).toBe(true);
  });

  it("date < today ⇒ due", () => {
    expect(isDue("MCP/Snoozed/2026-06-19", cutoff)).toBe(true);
  });

  it("date > today ⇒ not due", () => {
    expect(isDue("MCP/Snoozed/2026-06-21", cutoff)).toBe(false);
  });

  it("non-dated / unrelated labels ⇒ not due", () => {
    expect(isDue("MCP/Snoozed", cutoff)).toBe(false);
    expect(isDue("INBOX", cutoff)).toBe(false);
  });

  it("a sub-label without a valid date suffix is never due (and thus never deleted)", () => {
    expect(isDue("MCP/Snoozed/Archiv", cutoff)).toBe(false);
    expect(isDue("MCP/Snoozed/0-test", cutoff)).toBe(false);
    expect(isDue("MCP/Snoozed/2026-99-99", cutoff)).toBe(false);
  });
});

describe("snooze — input validation", () => {
  it("rejects an invalid date before touching the API", async () => {
    const gmail = {} as Gmail; // must not be called
    await expect(snooze(gmail, "th-1", "2026-99-99")).rejects.toThrow(/Invalid snooze date/);
  });
});

describe("sweepSnoozed", () => {
  /**
   * Fake Gmail that simulates a dated label. listThreadIdsByLabel returns the
   * threads still carrying it; modifyLabels pops one off (unless `sticky`, which
   * simulates a label that never drains).
   */
  function makeFakeGmail(total: number, opts: { sticky?: boolean } = {}) {
    let remaining = Array.from({ length: total }, (_, i) => `th-${i}`);
    let deleted = false;

    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "Label_parent", name: "MCP/Snoozed", type: "user" },
          { id: "Label_due", name: "MCP/Snoozed/2026-06-01", type: "user" },
          { id: "Label_archiv", name: "MCP/Snoozed/Archiv", type: "user" },
        ];
      },
      async listThreadIdsByLabel(labelId: string) {
        return labelId === "Label_due" ? [...remaining] : [];
      },
      async modifyLabels(threadId: string) {
        if (!opts.sticky) remaining = remaining.filter((t) => t !== threadId);
      },
      async deleteLabel() {
        deleted = true;
      },
    };
    return { gmail: fake as Gmail, getDeleted: () => deleted, getRemaining: () => remaining };
  }

  it("wakes ALL 250 threads and deletes the drained label", async () => {
    const { gmail, getDeleted, getRemaining } = makeFakeGmail(250);
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(res.wokenCount).toBe(250);
    expect(getRemaining()).toHaveLength(0);
    expect(getDeleted()).toBe(true);
  });

  it("does NOT delete a label it could not drain (no lost snoozes)", async () => {
    const { gmail, getDeleted } = makeFakeGmail(3, { sticky: true });
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(getDeleted()).toBe(false); // label kept → snoozes survive
    expect(res.wokenCount).toBe(3); // woken is a Set — no duplicates across rounds
  });

  it("ignores non-dated sub-labels entirely", async () => {
    const { gmail } = makeFakeGmail(0);
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));
    expect(res.wokenCount).toBe(0); // Label_archiv never swept
  });
});

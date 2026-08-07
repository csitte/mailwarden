import { describe, it, expect } from "vitest";
import {
  isDue,
  isValidIsoDate,
  isValidSnoozeKey,
  todayIso,
  resolveSnoozeDate,
  sweepSnoozed,
  snooze,
  unsnooze,
  listSnoozed,
} from "../src/snooze.js";
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

describe("resolveSnoozeDate", () => {
  // Anchor: Saturday, 2026-06-20 (verified). Fixed so weekday presets are deterministic.
  const today = new Date(2026, 5, 20);

  it("passes an explicit YYYY-MM-DD through unchanged", () => {
    expect(resolveSnoozeDate("2026-06-25", today)).toBe("2026-06-25");
    expect(resolveSnoozeDate("2026-06-20", today)).toBe("2026-06-20"); // today is allowed
  });

  it("resolves the relative presets", () => {
    expect(resolveSnoozeDate("today", today)).toBe("2026-06-20");
    expect(resolveSnoozeDate("tomorrow", today)).toBe("2026-06-21");
    expect(resolveSnoozeDate("in 3 days", today)).toBe("2026-06-23");
    expect(resolveSnoozeDate("in 1 day", today)).toBe("2026-06-21");
  });

  it("resolves next week to the next Monday and weekend to the next Saturday", () => {
    expect(resolveSnoozeDate("next week", today)).toBe("2026-06-22");
    // today IS Saturday ⇒ weekend means NEXT Saturday, never now
    expect(resolveSnoozeDate("weekend", today)).toBe("2026-06-27");
  });

  it("resolves a weekday name to its next strictly-future occurrence", () => {
    expect(resolveSnoozeDate("friday", today)).toBe("2026-06-26");
    expect(resolveSnoozeDate("monday", today)).toBe("2026-06-22");
    expect(resolveSnoozeDate("saturday", today)).toBe("2026-06-27"); // +7, not today
  });

  it("is case- and separator-insensitive", () => {
    expect(resolveSnoozeDate("  Next-Week ", today)).toBe("2026-06-22");
    expect(resolveSnoozeDate("TOMORROW", today)).toBe("2026-06-21");
    expect(resolveSnoozeDate("In 2 Days", today)).toBe("2026-06-22");
  });

  it("rejects an ISO-shaped but impossible date", () => {
    expect(() => resolveSnoozeDate("2026-99-99", today)).toThrow(/Invalid snooze date/);
  });

  it("rejects a past explicit date", () => {
    expect(() => resolveSnoozeDate("2026-06-19", today)).toThrow(/in the past/);
  });

  it("rejects an unrecognized value with an actionable message", () => {
    expect(() => resolveSnoozeDate("someday", today)).toThrow(/Invalid snooze value/);
    expect(() => resolveSnoozeDate("next month", today)).toThrow(/Invalid snooze value/);
  });

  it("rejects a negative offset instead of silently flipping its sign", () => {
    // "-" would normalize to a space and turn "in -1 days" into tomorrow.
    expect(() => resolveSnoozeDate("in -1 days", today)).toThrow(/positive/);
    expect(() => resolveSnoozeDate("in -3 hours", today)).toThrow(/positive/);
  });

  it("rejects an absurd offset instead of stranding the thread on a NaN key", () => {
    // Overflowing Date arithmetic would otherwise yield a key that never comes due.
    expect(() => resolveSnoozeDate("in 999999999 days", today)).toThrow(/too far/);
    expect(() => resolveSnoozeDate("in 999999999 hours", today)).toThrow(/too far/);
    // …but a large-yet-valid offset still resolves.
    expect(resolveSnoozeDate("in 3000 days", today)).toBe("2034-09-06");
  });

  it("points a loose (non-zero-padded) date at the correct format", () => {
    expect(() => resolveSnoozeDate("2026-2-3", today)).toThrow(/zero-padded YYYY-MM-DD/);
    expect(() => resolveSnoozeDate("2026-6-1", today)).toThrow(/zero-padded YYYY-MM-DD/);
  });
});

describe("resolveSnoozeDate — time of day", () => {
  // Anchor: Saturday, 2026-06-20 at 09:00 local.
  const today = new Date(2026, 5, 20, 9, 0);

  it("appends a THHMM stamp for a preset with a trailing time", () => {
    expect(resolveSnoozeDate("tomorrow 9am", today)).toBe("2026-06-21T0900");
    expect(resolveSnoozeDate("today 5pm", today)).toBe("2026-06-20T1700");
    expect(resolveSnoozeDate("monday 8:30", today)).toBe("2026-06-22T0830");
    expect(resolveSnoozeDate("weekend 10am", today)).toBe("2026-06-27T1000");
  });

  it("accepts an explicit date + time with T or space and 12h or 24h clocks", () => {
    expect(resolveSnoozeDate("2026-06-20T17:00", today)).toBe("2026-06-20T1700");
    expect(resolveSnoozeDate("2026-06-20 9:30pm", today)).toBe("2026-06-20T2130");
    expect(resolveSnoozeDate("2026-06-21 9 am", today)).toBe("2026-06-21T0900");
  });

  it("maps 12am to 00:00 and 12pm to 12:00", () => {
    expect(resolveSnoozeDate("tomorrow 12am", today)).toBe("2026-06-21T0000");
    expect(resolveSnoozeDate("tomorrow 12pm", today)).toBe("2026-06-21T1200");
  });

  it("resolves 'in N hours' relative to the current minute", () => {
    expect(resolveSnoozeDate("in 3 hours", today)).toBe("2026-06-20T1200");
    expect(resolveSnoozeDate("in 1 hour", today)).toBe("2026-06-20T1000");
  });

  it("rejects a time earlier today as past", () => {
    expect(() => resolveSnoozeDate("today 8am", today)).toThrow(/in the past/);
    expect(() => resolveSnoozeDate("2026-06-20 07:30", today)).toThrow(/in the past/);
  });

  it("rejects an impossible clock time", () => {
    expect(() => resolveSnoozeDate("2026-06-20 25:00", today)).toThrow(/Invalid time/);
    expect(() => resolveSnoozeDate("tomorrow 25:00", today)).toThrow();
  });
});

describe("isValidSnoozeKey", () => {
  it("accepts bare dates and valid THHMM timestamps", () => {
    for (const s of ["2026-06-20", "2026-06-20T0900", "2026-06-20T0000", "2026-06-20T2359"]) {
      expect(isValidSnoozeKey(s)).toBe(true);
    }
  });
  it("rejects impossible times, wrong widths, and non-keys", () => {
    for (const s of ["2026-06-20T2400", "2026-06-20T0960", "2026-06-20T900", "2026-13-01", "foo", ""]) {
      expect(isValidSnoozeKey(s)).toBe(false);
    }
  });
});

describe("isDue — timestamped keys", () => {
  it("compares to the minute against a localStamp cutoff", () => {
    expect(isDue("MCP/Snoozed/2026-06-20T0900", "2026-06-20T0900")).toBe(true); // == due
    expect(isDue("MCP/Snoozed/2026-06-20T0900", "2026-06-20T0859")).toBe(false); // one min early
    expect(isDue("MCP/Snoozed/2026-06-20T0900", "2026-06-20T1000")).toBe(true); // later
  });
  it("treats a bare-date label as due from the start of its day", () => {
    expect(isDue("MCP/Snoozed/2026-06-20", "2026-06-20T0000")).toBe(true);
    expect(isDue("MCP/Snoozed/2026-06-21", "2026-06-20T2359")).toBe(false);
  });
});

describe("snooze — input validation", () => {
  it("rejects an invalid date before touching the API", async () => {
    const gmail = {} as Gmail; // must not be called
    await expect(snooze(gmail, "th-1", "2026-99-99")).rejects.toThrow(/Invalid snooze date/);
  });
});

describe("snooze — happy path", () => {
  it("ensures parent + dated label, archives, and reports the due date", async () => {
    const ensured: string[] = [];
    const modified: any[] = [];
    const fake: Partial<Gmail> = {
      async ensureLabel(name: string) {
        ensured.push(name);
        return `id:${name}`;
      },
      async modifyLabels(threadId: string, add: string[] = [], remove: string[] = []) {
        modified.push({ threadId, add, remove });
      },
    };

    // Fixed `today` so the future-date guard stays deterministic over time.
    const res = await snooze(fake as Gmail, "th-1", "2026-08-01", new Date(2026, 6, 1));

    expect(ensured).toEqual(["MCP/Snoozed", "MCP/Snoozed/2026-08-01"]);
    expect(modified).toEqual([
      { threadId: "th-1", add: ["id:MCP/Snoozed", "id:MCP/Snoozed/2026-08-01"], remove: ["INBOX"] },
    ]);
    expect(res).toEqual({ threadId: "th-1", snoozedUntil: "2026-08-01" });
  });

  it("resolves a preset before hitting the API", async () => {
    const ensured: string[] = [];
    const fake: Partial<Gmail> = {
      async ensureLabel(name: string) {
        ensured.push(name);
        return `id:${name}`;
      },
      async modifyLabels() {},
    };

    const res = await snooze(fake as Gmail, "th-1", "tomorrow", new Date(2026, 5, 20));

    expect(ensured).toEqual(["MCP/Snoozed", "MCP/Snoozed/2026-06-21"]);
    expect(res).toEqual({ threadId: "th-1", snoozedUntil: "2026-06-21" });
  });
});

describe("unsnooze", () => {
  it("returns the thread to the inbox and strips ALL snooze labels — but does not force UNREAD", async () => {
    const modified: any[] = [];
    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "Label_parent", name: "MCP/Snoozed", type: "user" },
          { id: "Label_a", name: "MCP/Snoozed/2026-08-01", type: "user" },
          { id: "Label_b", name: "MCP/Snoozed/2026-09-15", type: "user" },
          { id: "Label_todo", name: "ToDo", type: "user" },
        ];
      },
      async modifyLabels(threadId: string, add: string[] = [], remove: string[] = []) {
        modified.push({ threadId, add, remove });
      },
    };

    const res = await unsnooze(fake as Gmail, "th-1");

    expect(modified).toEqual([
      { threadId: "th-1", add: ["INBOX"], remove: ["Label_parent", "Label_a", "Label_b"] },
    ]);
    expect(res).toEqual({ threadId: "th-1", unsnoozed: true });
  });
});

describe("listSnoozed", () => {
  it("lists threads per dated label with subjects, sorted by due date; skips non-dated sub-labels", async () => {
    const listedLabels: string[] = [];
    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "Label_parent", name: "MCP/Snoozed", type: "user" },
          { id: "Label_b", name: "MCP/Snoozed/2026-09-15", type: "user" },
          { id: "Label_a", name: "MCP/Snoozed/2026-08-01", type: "user" },
          { id: "Label_archiv", name: "MCP/Snoozed/Archiv", type: "user" },
          { id: "Label_todo", name: "ToDo", type: "user" },
        ];
      },
      async listThreadIdsByLabel(labelId: string) {
        listedLabels.push(labelId);
        return labelId === "Label_a" ? ["t1"] : labelId === "Label_b" ? ["t2", "t3"] : [];
      },
      async getThreadSubject(threadId: string) {
        return `subj-${threadId}`;
      },
    };

    const res = await listSnoozed(fake as Gmail);

    expect(res).toEqual([
      { threadId: "t1", subject: "subj-t1", snoozedUntil: "2026-08-01" },
      { threadId: "t2", subject: "subj-t2", snoozedUntil: "2026-09-15" },
      { threadId: "t3", subject: "subj-t3", snoozedUntil: "2026-09-15" },
    ]);
    // parent, Archiv, and unrelated labels are never queried
    expect(listedLabels.sort()).toEqual(["Label_a", "Label_b"]);
  });

  it("presents timestamped keys in human form, sorted chronologically", async () => {
    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "L_pm", name: "MCP/Snoozed/2026-08-01T1730", type: "user" },
          { id: "L_am", name: "MCP/Snoozed/2026-08-01T0900", type: "user" },
          { id: "L_date", name: "MCP/Snoozed/2026-08-01", type: "user" },
        ];
      },
      async listThreadIdsByLabel(labelId: string) {
        return [labelId];
      },
      async getThreadSubject(threadId: string) {
        return `subj-${threadId}`;
      },
    };

    const res = await listSnoozed(fake as Gmail);

    // Bare date (start of day) < 09:00 < 17:30, all on 2026-08-01.
    expect(res).toEqual([
      { threadId: "L_date", subject: "subj-L_date", snoozedUntil: "2026-08-01" },
      { threadId: "L_am", subject: "subj-L_am", snoozedUntil: "2026-08-01 09:00" },
      { threadId: "L_pm", subject: "subj-L_pm", snoozedUntil: "2026-08-01 17:30" },
    ]);
  });
});

describe("sweepSnoozed", () => {
  /**
   * Fake Gmail that simulates a dated label on the message level.
   * listMessageRefs returns the messages still carrying it; batchModifyMessages
   * clears them (unless `sticky`, which simulates a label that never drains, or
   * `failChunks`, which reports every chunk as failed).
   */
  function makeFakeGmail(total: number, opts: { sticky?: boolean; failChunks?: boolean } = {}) {
    let remaining = Array.from({ length: total }, (_, i) => ({ id: `m-${i}`, threadId: `th-${i}` }));
    let deleted = false;
    const batchCalls: any[] = [];

    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "Label_parent", name: "MCP/Snoozed", type: "user" },
          { id: "Label_due", name: "MCP/Snoozed/2026-06-01", type: "user" },
          { id: "Label_archiv", name: "MCP/Snoozed/Archiv", type: "user" },
        ];
      },
      async listMessageRefs({ labelIds, max }: any = {}) {
        return labelIds?.includes("Label_due") ? remaining.slice(0, max) : [];
      },
      async batchModifyMessages(refs: any[], add: string[] = [], remove: string[] = []) {
        batchCalls.push({ refs: [...refs], add, remove });
        if (opts.failChunks) {
          return {
            modifiedMessages: 0,
            modifiedThreads: [],
            failed: [{ messageIds: refs.map((r) => r.id), error: "boom" }],
          };
        }
        if (!opts.sticky) {
          const ids = new Set(refs.map((r) => r.id));
          remaining = remaining.filter((r) => !ids.has(r.id));
        }
        return {
          modifiedMessages: refs.length,
          modifiedThreads: [...new Set(refs.map((r) => r.threadId))],
          failed: [],
        };
      },
      async deleteLabel() {
        deleted = true;
      },
    };
    return {
      gmail: fake as Gmail,
      getDeleted: () => deleted,
      getRemaining: () => remaining,
      batchCalls,
    };
  }

  it("wakes ALL 250 threads in one batch and deletes the drained label", async () => {
    const { gmail, getDeleted, getRemaining, batchCalls } = makeFakeGmail(250);
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(res.wokenCount).toBe(250);
    expect(res.failedCount).toBe(0);
    expect(getRemaining()).toHaveLength(0);
    expect(getDeleted()).toBe(true);
    expect(batchCalls).toHaveLength(1); // one batch call, not 250 modifies
  });

  it("does NOT delete a label it could not drain (no lost snoozes)", async () => {
    const { gmail, getDeleted } = makeFakeGmail(3, { sticky: true });
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(getDeleted()).toBe(false); // label kept → snoozes survive
    expect(res.wokenCount).toBe(3); // woken is a Set — no duplicates across rounds
  });

  it("reports failed chunks, keeps the label, and stops retrying it this sweep", async () => {
    const { gmail, getDeleted, batchCalls } = makeFakeGmail(5, { failChunks: true });
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(res.wokenCount).toBe(0);
    expect(res.failedCount).toBe(5);
    expect(res.errors).toEqual(["boom"]);
    expect(getDeleted()).toBe(false); // messages still carry the label
    expect(batchCalls).toHaveLength(1); // no repeat hammering within one sweep
  });

  it("ignores non-dated sub-labels entirely", async () => {
    const { gmail } = makeFakeGmail(0);
    const res = await sweepSnoozed(gmail, new Date(2026, 5, 20));
    expect(res.wokenCount).toBe(0); // Label_archiv never swept
  });

  it("wakes a timestamped label only once its local minute has passed", async () => {
    const swept: string[] = [];
    let remaining = [{ id: "m-0", threadId: "th-0" }];
    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "L_due", name: "MCP/Snoozed/2026-06-20T0800", type: "user" }, // 08:00 — due at 09:00
          { id: "L_later", name: "MCP/Snoozed/2026-06-20T1000", type: "user" }, // 10:00 — not yet
        ];
      },
      async listMessageRefs({ labelIds }: any = {}) {
        return labelIds?.includes("L_due") ? [...remaining] : [];
      },
      async batchModifyMessages(refs: any[]) {
        swept.push(...refs.map((r) => r.id));
        remaining = [];
        return { modifiedMessages: refs.length, modifiedThreads: ["th-0"], failed: [] };
      },
      async deleteLabel() {},
    };

    const res = await sweepSnoozed(fake as Gmail, new Date(2026, 5, 20, 9, 0));

    expect(res.wokenCount).toBe(1);
    expect(swept).toEqual(["m-0"]); // the 10:00 label stays snoozed
    expect(res.date).toBe("2026-06-20"); // summary reports the day, not the minute
  });

  it("wakes messages into the inbox as unread, stripping dated + parent label", async () => {
    const { gmail, batchCalls } = makeFakeGmail(1);
    await sweepSnoozed(gmail, new Date(2026, 5, 20));

    expect(batchCalls).toEqual([
      {
        refs: [{ id: "m-0", threadId: "th-0" }],
        add: ["INBOX", "UNREAD"],
        remove: ["Label_due", "Label_parent"],
      },
    ]);
  });

  it("works when the parent label is missing (only the dated label is stripped)", async () => {
    const batchCalls: any[] = [];
    let remaining = [{ id: "m-0", threadId: "th-0" }];
    const fake: Partial<Gmail> = {
      async listLabels() {
        return [{ id: "Label_due", name: "MCP/Snoozed/2026-06-01", type: "user" }];
      },
      async listMessageRefs() {
        return [...remaining];
      },
      async batchModifyMessages(refs: any[], add: string[] = [], remove: string[] = []) {
        batchCalls.push({ add, remove });
        remaining = [];
        return {
          modifiedMessages: refs.length,
          modifiedThreads: [...new Set(refs.map((r) => r.threadId))],
          failed: [],
        };
      },
      async deleteLabel() {},
    };

    const res = await sweepSnoozed(fake as Gmail, new Date(2026, 5, 20));

    expect(batchCalls[0].remove).toEqual(["Label_due"]);
    expect(res.wokenCount).toBe(1);
  });
});

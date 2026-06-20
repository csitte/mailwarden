import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { isDue, sweepSnoozed } from "../src/snooze.js";
import { Gmail } from "../src/gmail.js";

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
});

describe("sweepSnoozed — Bug 2: drains >100 threads before deleting the label", () => {
  /**
   * Fake Gmail that simulates a dated label holding 250 threads. Each
   * modifyLabels removal pops one thread off; search returns the next <=100.
   */
  function makeFakeGmail(total: number) {
    let remaining = Array.from({ length: total }, (_, i) => `th-${i}`);
    let deleted = false;

    const fake: Partial<Gmail> = {
      async listLabels() {
        return [
          { id: "Label_parent", name: "MCP/Snoozed", type: "user" },
          { id: "Label_due", name: "MCP/Snoozed/2026-06-01", type: "user" },
        ];
      },
      async search(_query: string, maxResults = 25) {
        return remaining.slice(0, maxResults).map((threadId) => ({
          threadId,
          messageCount: 1,
          from: "",
          subject: "",
          date: "",
          labelIds: [],
          snippet: "",
          hasAttachments: false,
        }));
      },
      async modifyLabels(threadId: string) {
        remaining = remaining.filter((t) => t !== threadId);
      },
      async deleteLabel() {
        deleted = true;
      },
    };
    return { gmail: fake as Gmail, getDeleted: () => deleted, getRemaining: () => remaining };
  }

  it("wakes ALL 250 threads (not just the first 100) and deletes the empty label", async () => {
    const { gmail, getDeleted, getRemaining } = makeFakeGmail(250);
    const res = await sweepSnoozed(gmail, new Date("2026-06-20T00:00:00Z"));

    expect(res.wokenCount).toBe(250);
    expect(getRemaining()).toHaveLength(0);
    expect(getDeleted()).toBe(true);
  });
});

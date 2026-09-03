import { describe, it, expect } from "vitest";
import { summarizeHistory, HISTORY_ID_LIMIT, type RawHistoryRecord } from "../src/history.js";

const msg = (id: string, threadId = `t-${id}`) => ({ message: { id, threadId } });
const labelled = (id: string, labelIds: string[], threadId = `t-${id}`) => ({
  message: { id, threadId },
  labelIds,
});

describe("summarizeHistory", () => {
  it("reports a quiet mailbox as quiet, and still hands back a resume point", () => {
    expect(summarizeHistory([], "9001")).toEqual({
      historyId: "9001",
      added: [],
      deleted: [],
      labelsAdded: [],
      labelsRemoved: [],
      records: 0,
      truncated: false,
    });
  });

  it("collects arrivals and removals", () => {
    const records: RawHistoryRecord[] = [
      { id: "1", messagesAdded: [msg("m1"), msg("m2")] },
      { id: "2", messagesDeleted: [msg("m3")] },
    ];
    const s = summarizeHistory(records, "9002");
    expect(s.added).toEqual([
      { id: "m1", threadId: "t-m1" },
      { id: "m2", threadId: "t-m2" },
    ]);
    expect(s.deleted).toEqual([{ id: "m3", threadId: "t-m3" }]);
    expect(s.records).toBe(2);
  });

  it("counts a message once even when several records name it", () => {
    const records: RawHistoryRecord[] = [
      { id: "1", messagesAdded: [msg("m1")] },
      { id: "2", messagesAdded: [msg("m1")] },
    ];
    expect(summarizeHistory(records, "9003").added).toHaveLength(1);
  });

  it("groups label events by label, busiest first", () => {
    const records: RawHistoryRecord[] = [
      { id: "1", labelsAdded: [labelled("m1", ["UNREAD", "INBOX"])] },
      { id: "2", labelsAdded: [labelled("m2", ["UNREAD"])] },
      { id: "3", labelsRemoved: [labelled("m1", ["INBOX"])] },
    ];
    const s = summarizeHistory(records, "9004");
    expect(s.labelsAdded).toEqual([
      { labelId: "UNREAD", messages: 2, threadIds: ["t-m1", "t-m2"] },
      { labelId: "INBOX", messages: 1, threadIds: ["t-m1"] },
    ]);
    expect(s.labelsRemoved).toEqual([{ labelId: "INBOX", messages: 1, threadIds: ["t-m1"] }]);
  });

  it("keeps a label that went on and came off in BOTH lists — both events happened", () => {
    // The feed reports events, not state. Collapsing these would be a claim about how the
    // mailbox looks now, which this function is in no position to make.
    const records: RawHistoryRecord[] = [
      { id: "1", labelsAdded: [labelled("m1", ["UNREAD"])] },
      { id: "2", labelsRemoved: [labelled("m1", ["UNREAD"])] },
    ];
    const s = summarizeHistory(records, "9005");
    expect(s.labelsAdded[0].labelId).toBe("UNREAD");
    expect(s.labelsRemoved[0].labelId).toBe("UNREAD");
  });

  it("dedupes thread ids inside one label — ten messages in one thread is one thread", () => {
    const records: RawHistoryRecord[] = [
      {
        id: "1",
        labelsAdded: Array.from({ length: 10 }, (_, i) => labelled(`m${i}`, ["INBOX"], "t-same")),
      },
    ];
    expect(summarizeHistory(records, "9006").labelsAdded[0]).toEqual({
      labelId: "INBOX",
      messages: 10,
      threadIds: ["t-same"],
    });
  });

  it("uses the mailbox's current id, not the last record's", () => {
    // Resuming from the last record would re-deliver everything that happened after it.
    const s = summarizeHistory([{ id: "500", messagesAdded: [msg("m1")] }], "777");
    expect(s.historyId).toBe("777");
  });

  it("skips entries with no message id rather than inventing one", () => {
    const records: RawHistoryRecord[] = [
      { id: "1", messagesAdded: [{ message: null }, { message: { id: null } }, msg("m1")] },
      { id: "2", labelsAdded: [{ message: null, labelIds: ["INBOX"] }] },
    ];
    const s = summarizeHistory(records, "9007");
    expect(s.added).toEqual([{ id: "m1", threadId: "t-m1" }]);
    expect(s.labelsAdded).toEqual([]);
  });

  it("tolerates a label event with no labelIds", () => {
    const records: RawHistoryRecord[] = [{ id: "1", labelsAdded: [{ message: { id: "m1" } }] }];
    expect(summarizeHistory(records, "9008").labelsAdded).toEqual([]);
  });

  it("cuts the id lists at the limit but keeps the counts complete", () => {
    const many = Array.from({ length: 250 }, (_, i) => msg(`m${i}`));
    const s = summarizeHistory([{ id: "1", messagesAdded: many }], "9009", 200);
    expect(s.added).toHaveLength(200);
    expect(s.truncated).toBe(true);
  });

  it("flags truncation when a label's THREAD list is cut, not its message count", () => {
    const many = Array.from({ length: 12 }, (_, i) => labelled(`m${i}`, ["INBOX"]));
    const s = summarizeHistory([{ id: "1", labelsAdded: many }], "9010", 5);
    expect(s.labelsAdded[0].messages).toBe(12); // the count still describes everything seen
    expect(s.labelsAdded[0].threadIds).toHaveLength(5);
    expect(s.truncated).toBe(true);
  });

  it("does not flag truncation when several messages simply share a thread", () => {
    const many = Array.from({ length: 12 }, (_, i) => labelled(`m${i}`, ["INBOX"], "t-one"));
    const s = summarizeHistory([{ id: "1", labelsAdded: many }], "9011", 5);
    expect(s.labelsAdded[0].messages).toBe(12);
    expect(s.truncated).toBe(false);
  });

  it("defaults to a limit that keeps a busy week inside a model's context", () => {
    expect(HISTORY_ID_LIMIT).toBe(200);
    const many = Array.from({ length: HISTORY_ID_LIMIT + 1 }, (_, i) => msg(`m${i}`));
    expect(summarizeHistory([{ id: "1", messagesAdded: many }], "1").added).toHaveLength(
      HISTORY_ID_LIMIT,
    );
  });
});

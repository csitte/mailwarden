import { describe, it, expect } from "vitest";
import { waitingOnMe, waitingOnThem, type TailMessage, type ThreadTail } from "../src/followups.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => NOW.getTime() - n * 24 * 60 * 60 * 1000;
const msg = (labelIds: string[], days: number, extra: Partial<TailMessage> = {}): TailMessage => ({
  labelIds,
  from: "Someone <someone@x.example>",
  to: "me@y.example",
  dateMs: daysAgo(days),
  signals: [],
  ...extra,
});
const thread = (threadId: string, ...messages: TailMessage[]): ThreadTail => ({ threadId, subject: `S ${threadId}`, messages });

describe("waitingOnThem", () => {
  it("lists a thread whose last message is mine and old enough, oldest wait first", () => {
    const out = waitingOnThem(
      [
        thread("t1", msg(["INBOX"], 10), msg(["SENT"], 5, { to: "a@x.example" })),
        thread("t2", msg(["SENT"], 9, { to: "b@x.example" })),
      ],
      NOW,
      3,
    );
    expect(out.map((t) => [t.threadId, t.daysWaiting, t.to])).toEqual([
      ["t2", 9, "b@x.example"],
      ["t1", 5, "a@x.example"],
    ]);
    expect(out[0].lastSentAt).toBe(new Date(daysAgo(9)).toISOString());
  });

  it("leaves out a thread that was answered, or is too recent to nudge", () => {
    expect(waitingOnThem([thread("t1", msg(["SENT"], 8), msg(["INBOX"], 2))], NOW, 3)).toEqual([]);
    expect(waitingOnThem([thread("t1", msg(["SENT"], 1))], NOW, 3)).toEqual([]);
  });

  it("does not let a draft, or mail in trash or spam, be the last word", () => {
    // An unsent draft is not an answer, and a message thrown away is not the last word.
    expect(waitingOnThem([thread("t1", msg(["SENT"], 6), msg(["DRAFT"], 1))], NOW, 3)).toHaveLength(1);
    expect(waitingOnThem([thread("t1", msg(["SENT"], 6), msg(["TRASH"], 1))], NOW, 3)).toHaveLength(1);
  });

  it("leaves out a note to myself — it waits on nobody", () => {
    const note = thread("t1", msg(["SENT", "INBOX"], 5, { from: "me@y.example", to: "Me <ME@y.example>" }));
    expect(waitingOnThem([note], NOW, 3, ["me@y.example"])).toEqual([]);
    // Sent to someone else as well: that someone may still answer.
    const cc = thread("t2", msg(["SENT", "INBOX"], 5, { to: "me@y.example, ann@x.example" }));
    expect(waitingOnThem([cc], NOW, 3, ["me@y.example"])).toHaveLength(1);
  });

  it("leaves out a thread whose last message has no date instead of inventing an age", () => {
    expect(waitingOnThem([thread("t1", msg(["SENT"], 6, { dateMs: undefined }))], NOW, 0)).toEqual([]);
  });
});

describe("waitingOnMe", () => {
  it("lists inbox threads whose last word is someone else's, with read state", () => {
    const out = waitingOnMe(
      [thread("t1", msg(["SENT"], 9), msg(["INBOX", "UNREAD"], 4)), thread("t2", msg(["INBOX"], 1))],
      NOW,
    );
    expect(out.map((t) => [t.threadId, t.daysWaiting, t.unread])).toEqual([
      ["t1", 4, true],
      ["t2", 1, false],
    ]);
  });

  it("drops a thread the live labels no longer put in the inbox — the index proposed it, the labels decide", () => {
    expect(waitingOnMe([thread("t1", msg([], 4))], NOW)).toEqual([]);
  });

  it("leaves out a thread I answered last", () => {
    expect(waitingOnMe([thread("t1", msg(["INBOX"], 4), msg(["SENT"], 2))], NOW)).toEqual([]);
  });

  it("leaves out mail a machine wrote by its own headers", () => {
    expect(waitingOnMe([thread("t1", msg(["INBOX"], 4, { signals: ["newsletter"] }))], NOW)).toEqual([]);
    expect(waitingOnMe([thread("t1", msg(["INBOX"], 4, { signals: ["automated"] }))], NOW)).toEqual([]);
    // A calendar invite is a person asking for an answer, and stays.
    expect(waitingOnMe([thread("t1", msg(["INBOX"], 4, { signals: ["calendar"] }))], NOW)).toHaveLength(1);
  });
});

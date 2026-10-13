import { describe, it, expect } from "vitest";
import { buildUndo } from "../src/undo.js";

const refs = (...ids: [string, string][]) => ids.map(([id, threadId]) => ({ id, threadId }));

describe("buildUndo", () => {
  it("restores only what each message actually lost", () => {
    // Archive: m1 was in the inbox, m2 already was not. Only m1 goes back.
    const plan = buildUndo(refs(["m1", "t1"], ["m2", "t2"]), [], ["INBOX"], new Map([
      ["m1", ["INBOX"]],
      ["m2", []],
    ]));
    expect(plan).toEqual({
      steps: [{ add: ["INBOX"], remove: [], messageIds: ["m1"], threadIds: ["t1"] }],
      unknown: [],
    });
  });

  it("takes off only what each message actually gained", () => {
    // Label: m1 already carried it, m2 did not. Only m2 loses it again.
    const plan = buildUndo(refs(["m1", "t1"], ["m2", "t1"]), ["Label_9"], [], new Map([
      ["m1", ["Label_9"]],
      ["m2", ["INBOX"]],
    ]));
    expect(plan.steps).toEqual([{ add: [], remove: ["Label_9"], messageIds: ["m2"], threadIds: ["t1"] }]);
  });

  it("groups messages that need the same inverse, and keeps different ones apart", () => {
    const plan = buildUndo(
      refs(["m1", "t1"], ["m2", "t1"], ["m3", "t2"]),
      ["Label_9"],
      ["INBOX", "UNREAD"],
      new Map([
        ["m1", ["INBOX", "UNREAD"]],
        ["m2", ["INBOX", "UNREAD"]],
        ["m3", ["INBOX"]],
      ]),
    );
    expect(plan.steps).toEqual([
      { add: ["INBOX", "UNREAD"], remove: ["Label_9"], messageIds: ["m1", "m2"], threadIds: ["t1"] },
      { add: ["INBOX"], remove: ["Label_9"], messageIds: ["m3"], threadIds: ["t2"] },
    ]);
  });

  it("guesses nothing for a message whose prior state was not read", () => {
    const plan = buildUndo(refs(["m1", "t1"], ["m2", "t2"]), [], ["INBOX"], new Map([["m1", ["INBOX"]]]));
    expect(plan.unknown).toEqual(["m2"]);
    expect(plan.steps.flatMap((s) => s.messageIds)).toEqual(["m1"]);
  });

  it("returns an empty plan when nothing changed", () => {
    expect(buildUndo(refs(["m1", "t1"]), ["INBOX"], [], new Map([["m1", ["INBOX"]]]))).toEqual({
      steps: [],
      unknown: [],
    });
  });

  it("counts a repeated message once", () => {
    const plan = buildUndo(refs(["m1", "t1"], ["m1", "t1"]), [], ["INBOX"], new Map([["m1", ["INBOX"]]]));
    expect(plan.steps[0].messageIds).toEqual(["m1"]);
  });
});

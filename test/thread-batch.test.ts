import { describe, it, expect, vi } from "vitest";
import { ToolError } from "../src/cli.js";
import type { Gmail } from "../src/gmail.js";
import {
  MAX_THREAD_IDS,
  foldOutcomes,
  modifyThreads,
  resolveThreadTargets,
} from "../src/thread-batch.js";

const invalid = (fn: () => unknown, pattern: RegExp) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ToolError);
  expect((err as ToolError).code).toBe("invalid_input");
  expect((err as ToolError).message).toMatch(pattern);
};

describe("resolveThreadTargets", () => {
  it("one threadId is a single target, the old call shape", () => {
    expect(resolveThreadTargets({ threadId: "t1" })).toEqual({ ids: ["t1"], many: false });
  });

  it("threadIds is a list target, trimmed and de-duplicated in first-seen order", () => {
    expect(resolveThreadTargets({ threadIds: ["t2", " t1 ", "t2", "t3", "t1"] })).toEqual({
      ids: ["t2", "t1", "t3"],
      many: true,
    });
  });

  it("a one-element list is still a list: the caller asked for the per-thread report", () => {
    expect(resolveThreadTargets({ threadIds: ["t1"] })).toEqual({ ids: ["t1"], many: true });
  });

  it("neither, both, empty and blank are invalid_input with a message that says what to do", () => {
    invalid(() => resolveThreadTargets({}), /threadId .* or threadIds/);
    invalid(() => resolveThreadTargets({ threadId: "t1", threadIds: ["t2"] }), /not both/);
    invalid(() => resolveThreadTargets({ threadId: "  " }), /empty/);
    invalid(() => resolveThreadTargets({ threadIds: [] }), /non-empty/);
    invalid(() => resolveThreadTargets({ threadIds: ["t1", " "] }), /non-empty/);
  });

  it("the cap counts distinct ids and names the way out", () => {
    const atCap = Array.from({ length: MAX_THREAD_IDS }, (_, i) => `t${i}`);
    expect(resolveThreadTargets({ threadIds: [...atCap, "t0"] }).ids).toHaveLength(MAX_THREAD_IDS);
    invalid(() => resolveThreadTargets({ threadIds: [...atCap, "extra"] }), /limit is 100.*bulk_modify/);
  });
});

describe("foldOutcomes", () => {
  const fail = (threadId: string, code: "not_found" | "rate_limited") => ({
    threadId,
    ok: false as const,
    failure: { code, message: `${code} msg`, retryable: code === "rate_limited" },
  });

  it("all changed: ok", () => {
    expect(foldOutcomes(["a", "b"], [{ threadId: "b", ok: true }, { threadId: "a", ok: true }])).toEqual({
      ok: true,
      changed: ["a", "b"], // input order, not completion order
      failed: [],
      notAttempted: [],
    });
  });

  it("a failure and a gap: not ok, each id in exactly one bucket", () => {
    const r = foldOutcomes(["a", "b", "c"], [{ threadId: "a", ok: true }, fail("b", "not_found")]);
    expect(r).toEqual({
      ok: false,
      changed: ["a"],
      failed: [{ threadId: "b", code: "not_found", message: "not_found msg", retryable: false }],
      notAttempted: ["c"],
    });
  });

  it("nothing attempted at all", () => {
    expect(foldOutcomes(["a"], [])).toEqual({ ok: false, changed: [], failed: [], notAttempted: ["a"] });
  });
});

/** A Gmail stand-in with just the two methods modifyThreads uses. */
function fakeGmail(failFor: Record<string, unknown> = {}) {
  const calls: { id: string; add: string[]; remove: string[] }[] = [];
  const resolveLabelIds = vi.fn(async (add: string[], remove: string[]) => ({
    addLabelIds: add.map((n) => `id:${n}`),
    removeLabelIds: remove,
  }));
  const gmail = {
    resolveLabelIds,
    modifyThreadLabelIds: vi.fn(async (id: string, add: string[], remove: string[]) => {
      calls.push({ id, add, remove });
      if (id in failFor) throw failFor[id];
    }),
  };
  return { gmail: gmail as unknown as Gmail, calls, resolveLabelIds };
}

describe("modifyThreads", () => {
  it("resolves labels ONCE for the whole list and applies the same ids to every thread", async () => {
    const { gmail, calls, resolveLabelIds } = fakeGmail();
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const r = await modifyThreads(gmail, ids, ["Receipts"], ["INBOX", "UNREAD"]);
    expect(resolveLabelIds).toHaveBeenCalledTimes(1); // a new name in `add` is created once, not 20 times
    expect(r).toEqual({ ok: true, changed: ids, failed: [], notAttempted: [] });
    expect(calls).toHaveLength(20);
    for (const c of calls) expect(c).toMatchObject({ add: ["id:Receipts"], remove: ["INBOX", "UNREAD"] });
  });

  it("a thread that is gone fails alone; the rest still run", async () => {
    // Google-shaped 404, classified by errors.ts like any tool error.
    const gone = Object.assign(new Error("Requested entity was not found."), { code: 404 });
    const { gmail, calls } = fakeGmail({ t2: gone });
    const r = await modifyThreads(gmail, ["t1", "t2", "t3"], [], ["INBOX"]);
    expect(calls.map((c) => c.id)).toEqual(["t1", "t2", "t3"]);
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual(["t1", "t3"]);
    expect(r.failed).toEqual([
      { threadId: "t2", code: "not_found", message: "Requested entity was not found.", retryable: false },
    ]);
    expect(r.notAttempted).toEqual([]);
  });

  it("a rate limit stops the run after its chunk: the rest are notAttempted, not hammered", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const { gmail, calls } = fakeGmail({ t3: new ToolError("rate_limited", "quota", true) });
    const r = await modifyThreads(gmail, ids, [], ["INBOX"]);
    // The first chunk (8) ran in parallel and finished; nothing after it was sent.
    expect(calls).toHaveLength(8);
    expect(r.changed).toEqual(ids.slice(0, 8).filter((id) => id !== "t3"));
    expect(r.failed).toEqual([{ threadId: "t3", code: "rate_limited", message: "quota", retryable: true }]);
    expect(r.notAttempted).toEqual(ids.slice(8));
    expect(r.ok).toBe(false);
  });

  it.each(["needs_reauth", "insufficient_scope", "network_error", "upstream_unavailable"] as const)(
    "%s is systemic too: stop instead of failing every thread the same way",
    async (code) => {
      const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
      const { gmail, calls } = fakeGmail({ t0: new ToolError(code, code) });
      const r = await modifyThreads(gmail, ids, [], ["UNREAD"]);
      expect(calls).toHaveLength(8);
      expect(r.notAttempted).toEqual(["t8", "t9"]);
    },
  );

  it("label resolution failing is the whole answer: nothing was changed", async () => {
    const { gmail, calls, resolveLabelIds } = fakeGmail();
    resolveLabelIds.mockRejectedValueOnce(new ToolError("insufficient_scope", "no labels scope"));
    await expect(modifyThreads(gmail, ["t1"], ["New"], [])).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(calls).toHaveLength(0);
  });
});

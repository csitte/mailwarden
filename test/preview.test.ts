import { describe, it, expect } from "vitest";
import { PreviewStore, bindingDigest, previewDrift, PREVIEW_TTL_MS } from "../src/preview.js";

const refs = [
  { id: "m1", threadId: "t1" },
  { id: "m2", threadId: "t1" },
  { id: "m3", threadId: "t2" },
];
const change = { query: "from:shop@example.com older_than:30d", add: [], remove: ["INBOX"] };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("bindingDigest", () => {
  it("treats label order and case as the same change, as the tool does", () => {
    expect(bindingDigest({ query: "q", add: ["A", "b"], remove: ["INBOX"] })).toBe(
      bindingDigest({ query: "q", add: ["b", "a"], remove: ["inbox"] }),
    );
  });

  it("trims the query but otherwise compares it exactly — one operator more is another set", () => {
    expect(bindingDigest({ ...change, query: `  ${change.query} ` })).toBe(bindingDigest(change));
    expect(bindingDigest({ ...change, query: `${change.query} is:unread` })).not.toBe(bindingDigest(change));
  });

  it("tells adding a label from removing it", () => {
    expect(bindingDigest({ query: "q", add: ["INBOX"], remove: [] })).not.toBe(
      bindingDigest({ query: "q", add: [], remove: ["INBOX"] }),
    );
  });
});

describe("PreviewStore", () => {
  it("releases exactly the held set, once", () => {
    const store = new PreviewStore();
    const token = store.hold(change, refs, false);
    const first = store.take(token, change);
    expect(first).toEqual({ ok: true, refs, heldAt: expect.any(Number), capped: false });
    const second = store.take(token, change);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("unknown");
  });

  it("copies the refs, so a later mutation of the caller's array cannot change what was previewed", () => {
    const store = new PreviewStore();
    const mine = refs.map((r) => ({ ...r }));
    const token = store.hold(change, mine);
    mine.push({ id: "m9", threadId: "t9" });
    mine[0].id = "changed";
    const taken = store.take(token, change);
    expect(taken.ok && taken.refs).toEqual(refs);
  });

  it("refuses a different change without spending the token — the previewed one can still be confirmed", () => {
    const store = new PreviewStore();
    const token = store.hold(change, refs);
    const other = store.take(token, { ...change, query: "from:shop@example.com" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("mismatch");
    expect(store.take(token, change).ok).toBe(true);
  });

  it("refuses a token past its lifetime, and forgets it", () => {
    const c = clock();
    const store = new PreviewStore(c.now);
    const token = store.hold(change, refs);
    c.advance(PREVIEW_TTL_MS - 1);
    expect(store.size).toBe(1);
    c.advance(2);
    const late = store.take(token, change);
    expect(late.ok).toBe(false);
    // prune() runs first, so an expired token reads as unknown — the same advice either way.
    if (!late.ok) expect(["expired", "unknown"]).toContain(late.reason);
    expect(store.size).toBe(0);
  });

  it("issues tokens nobody can guess from the previous one", () => {
    const store = new PreviewStore();
    const a = store.hold(change, refs);
    const b = store.hold(change, refs);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("keeps at most maxHeld tokens, dropping the oldest — a preview loop cannot grow memory", () => {
    const store = new PreviewStore(Date.now, PREVIEW_TTL_MS, 3);
    const tokens = [1, 2, 3, 4].map(() => store.hold(change, refs));
    expect(store.size).toBe(3);
    expect(store.take(tokens[0], change).ok).toBe(false);
    expect(store.take(tokens[3], change).ok).toBe(true);
  });

  it("carries the preview's capped flag through to the write", () => {
    const store = new PreviewStore();
    const token = store.hold(change, refs, true);
    const taken = store.take(token, change);
    expect(taken.ok && taken.capped).toBe(true);
  });
});

describe("previewDrift", () => {
  it("counts mail that started matching and held mail that stopped", () => {
    const current = [{ id: "m2", threadId: "t1" }, { id: "m3", threadId: "t2" }, { id: "m4", threadId: "t3" }, { id: "m5", threadId: "t3" }];
    expect(previewDrift(refs, current, false)).toEqual({ newMatches: 2, noLongerMatching: 1, capped: false });
  });

  it("reports no drift for an unchanged mailbox", () => {
    expect(previewDrift(refs, [...refs].reverse(), false)).toEqual({ newMatches: 0, noLongerMatching: 0, capped: false });
  });
});

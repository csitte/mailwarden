/**
 * Random interleavings of `unsubscribe` and `bulk_unsubscribe` against the process-wide sender
 * record, with random dialog answers and random network outcomes. Two invariants:
 *
 *  - a sender gets a second request only from a `force: true` call;
 *  - once every call has settled, no sender is still held by a call that is gone.
 *
 * Kept because code review missed both failures it catches: the version before the hold sent twice
 * to one sender (a retry during an open dialog), the first version of the hold left a sender held
 * for good (force:true alongside a running call, both declined). Seeds are fixed so a failure
 * reproduces; the rounds are few enough to run in a second.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { bulkUnsubscribe, resetContactedSenders, unsubscribeThread, type UnsubscribeDeps } from "../src/unsubscribe.js";
import { Gmail } from "../src/gmail.js";

beforeEach(resetContactedSenders);

const SENDERS = ["a", "b"];
const THREADS = Array.from({ length: 8 }, (_, i) => "t" + i);
const senderOf = (id: string) => SENDERS[Number(id.slice(1)) % SENDERS.length];

function makeRandom(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  // 0 to 3 turns of the event loop: enough to reorder the calls, without timers' coarse clock.
  const tick = async () => {
    for (let i = Math.floor(rnd() * 4); i > 0; i--) await new Promise((r) => setImmediate(r));
  };
  return { rnd, pick, tick };
}

function gmailFor(tick: () => Promise<unknown>): Gmail {
  const api = {
    users: {
      threads: {
        get: async ({ id }: { id: string }) => {
          await tick();
          const s = senderOf(id);
          return {
            data: {
              messages: [
                {
                  id: id + "-m",
                  payload: {
                    headers: [
                      { name: "From", value: `N <${s}@example.com>` },
                      { name: "List-Unsubscribe", value: `<https://${s}.example/u>` },
                      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
                    ],
                  },
                },
              ],
            },
          };
        },
      },
    },
  };
  return new Gmail(api as any);
}

const answered = { status: 200, headers: { get: () => null }, body: { cancel: async () => {} } };

async function round(seed: number): Promise<string[]> {
  resetContactedSenders();
  const { rnd, pick, tick } = makeRandom(seed);
  const gmail = gmailFor(tick);
  const sent: { sender: string; force: boolean }[] = [];
  const depsFor = (force: boolean): UnsubscribeDeps => ({
    resolveHost: async () => {
      await tick();
      return ["93.184.216.34"];
    },
    fetch: (async (url: string) => {
      const sender = new URL(url).hostname.split(".")[0];
      await tick();
      const r = rnd();
      if (r < 0.15) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }
      sent.push({ sender, force });
      if (r < 0.35) throw new Error("socket hang up");
      return { ...answered, status: pick([200, 200, 500]) };
    }) as unknown as typeof globalThis.fetch,
  });

  const ops: Promise<unknown>[] = [];
  const n = 2 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const kind = pick(["single", "single", "force", "bulk"]);
    if (kind === "bulk") {
      ops.push(bulkUnsubscribe(gmail, [pick(THREADS), pick(THREADS), pick(THREADS)], depsFor(false)));
    } else {
      const force = kind === "force";
      ops.push(
        unsubscribeThread(gmail, pick(THREADS), depsFor(force), {
          force,
          beforeRequest: async () => {
            await tick();
            if (rnd() < 0.3) throw new Error("declined");
          },
        }).catch(() => undefined),
      );
    }
    await tick();
  }
  await Promise.all(ops);

  const problems: string[] = [];
  for (const s of SENDERS) {
    const mine = sent.filter((x) => x.sender === s);
    if (mine.some((x, i) => i > 0 && !x.force)) {
      problems.push(`seed ${seed}: sender ${s} got ${mine.length} requests, a later one without force`);
    }
  }
  for (const s of SENDERS) {
    const id = THREADS.find((t) => senderOf(t) === s)!;
    const probe = await unsubscribeThread(gmail, id, { ...depsFor(false), fetch: (async () => answered) as any }, {
      beforeRequest: async () => {
        throw new Error("probe");
      },
    }).catch(() => undefined);
    if (probe?.reason && /right now/.test(probe.reason)) problems.push(`seed ${seed}: sender ${s} still held`);
  }
  return problems;
}

describe("unsubscribe record under random interleavings", () => {
  it("never sends twice without force, and never leaves a sender held", async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 150; seed++) problems.push(...(await round(seed)));
    expect(problems).toEqual([]);
  }, 30_000);
});

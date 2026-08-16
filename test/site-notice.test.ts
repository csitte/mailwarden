import { describe, it, expect } from "vitest";
// @ts-expect-error — repo-only release helper, plain .mjs with no type declarations
import {
  addresses,
  isSiteThread,
  announcesVersion,
  noticeState,
  readHeaders,
  resolveBridgeDir,
} from "../scripts/lib/site-notice.mjs";

/**
 * The release ritual now includes "tell the csitte.at session what changed", and this is the check
 * that says whether it happened. It runs against a Google Drive folder that is absent in CI, so the
 * rules themselves are pure functions and get their coverage here rather than from a live bridge.
 */

const msg = (opts: { from?: string; to?: string; body?: string; announces?: string } = {}) =>
  [
    "---",
    `from: ${opts.from ?? "mailwarden"}`,
    `to: ${opts.to ?? "csitte"}`,
    "type: fyi",
    "date: 2026-08-15T18:28:11Z",
    ...(opts.announces ? [`announces: ${opts.announces}`] : []),
    "---",
    "",
    opts.body ?? "mailwarden 0.11.0 ist live.",
  ].join("\n");

const thread = (messages: Array<{ name: string; text: string }>) => [
  { slug: "061-mailwarden-doku-csitte-update", messages },
];

describe("site-notice: which threads are looked at", () => {
  it("takes the thread the site delta actually lives in", () => {
    expect(isSiteThread("061-mailwarden-doku-csitte-update")).toBe(true);
  });

  it("takes a future thread naming both sides, in either order", () => {
    expect(isSiteThread("120-csitte-site-mailwarden-0-12")).toBe(true);
  });

  it("leaves unrelated threads alone — the scan stays cheap on Drive", () => {
    expect(isSiteThread("082-mailwarden-unsubscribe-test")).toBe(false);
    expect(isSiteThread("056-diffoniq-site-legal-pages")).toBe(false);
  });
});

describe("site-notice: what counts as an announcement", () => {
  it("counts a message that declares the version", () => {
    expect(announcesVersion({ announces: "0.11.0" }, "0.11.0")).toBe(true);
    expect(announcesVersion({ announces: "v0.11.0" }, "0.11.0")).toBe(true);
    expect(announcesVersion({ announces: " 0.11.0 " }, "0.11.0")).toBe(true);
  });

  it("counts one message covering two releases", () => {
    expect(announcesVersion({ announces: "0.10.0, 0.11.0" }, "0.11.0")).toBe(true);
  });

  it("does NOT count a version merely mentioned in the body — the false OK that forced this rule", () => {
    // Verbatim shape of the message that broke the first cut: it explained this very check and used
    // the upcoming version as an example, so a body scan reported "already announced" and the
    // postversion gate waved through the step it exists to enforce.
    const body = [
      "---",
      "from: mailwarden",
      "to: csitte",
      "---",
      "",
      "ein `0.11.0-dev.<sha>`-Bundle zählt nicht als Ankündigung von 0.11.0",
    ].join("\n");
    const headers = readHeaders(body);
    expect(headers.announces).toBeUndefined();
    expect(announcesVersion(headers, "0.11.0")).toBe(false);
  });

  it("does not confuse neighbouring versions", () => {
    expect(announcesVersion({ announces: "0.10.0" }, "0.1.0")).toBe(false);
    expect(announcesVersion({ announces: "0.11.0" }, "0.11.1")).toBe(false);
    expect(announcesVersion({ announces: "0.11.0-dev.abc" }, "0.11.0")).toBe(false);
  });

  it("treats a missing field as not announced, without throwing", () => {
    expect(announcesVersion({}, "0.11.0")).toBe(false);
    expect(announcesVersion(undefined, "0.11.0")).toBe(false);
  });
});

describe("site-notice: addressing", () => {
  it("reads the frontmatter fields", () => {
    expect(readHeaders(msg())).toMatchObject({ from: "mailwarden", to: "csitte", type: "fyi" });
  });

  it("survives a file without frontmatter instead of throwing", () => {
    expect(readHeaders("just text")).toEqual({});
  });

  it("accepts csitte inside a comma list — a group message counts as told", () => {
    expect(addresses({ to: "csitte, freddy" }, "csitte")).toBe(true);
  });

  it("matches ids token-exact, so a prefix is not a recipient", () => {
    expect(addresses({ to: "csitte-core" }, "csitte")).toBe(false);
    expect(addresses({ to: "gmail-csitte" }, "csitte")).toBe(false);
  });

  it("does not count a broadcast — `to: all` is deliberately not pushed to anyone", () => {
    expect(addresses({ to: "all" }, "csitte")).toBe(false);
  });
});

describe("site-notice: the verdict", () => {
  it("reports notified, naming the message that says so", () => {
    const state = noticeState(
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg({ announces: "0.11.0" }) }]),
      "0.11.0",
    );
    expect(state.state).toBe("notified");
    expect(state.hits).toEqual([
      { slug: "061-mailwarden-doku-csitte-update", name: "2026-08-15T182811Z__mailwarden__7b27.md" },
    ]);
  });

  it("reports missing when only the PREVIOUS release was announced", () => {
    const state = noticeState(
      thread([
        {
          name: "2026-08-15T182811Z__mailwarden__7b27.md",
          text: msg({ announces: "0.10.0", body: "0.8.0, 0.9.0 und 0.10.0 sind auf der Seite nicht abgebildet." }),
        },
      ]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
    expect(state.hits).toEqual([]);
  });

  it("does not count csitte's own reply as us having told them", () => {
    const state = noticeState(
      thread([
        {
          name: "2026-08-15T190000Z__csitte__abcd.md",
          text: msg({ from: "csitte", to: "mailwarden", announces: "0.11.0" }),
        },
      ]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
  });

  it("trusts the frontmatter over the filename when the two disagree", () => {
    const state = noticeState(
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg({ from: "csitte", announces: "0.11.0" }) }]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
  });

  it("does not count a message addressed to someone else", () => {
    const state = noticeState(
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg({ to: "freddy", announces: "0.11.0" }) }]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
  });
});

describe("site-notice: where the bridge is", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it("takes the first candidate that exists — the drive letter differs per device", () => {
    expect(resolveBridgeDir(exists(["F:/Meine Ablage/_session-bridge"]), { env: {} })).toBe(
      "F:/Meine Ablage/_session-bridge",
    );
  });

  it("lets the environment override", () => {
    expect(
      resolveBridgeDir(exists(["/tmp/bridge", "D:/etc/Google Drive/_session-bridge"]), {
        env: { MAILWARDEN_BRIDGE_DIR: "/tmp/bridge" },
      }),
    ).toBe("/tmp/bridge");
  });

  it("returns null for an override that is not there, rather than silently scanning elsewhere", () => {
    expect(
      resolveBridgeDir(exists(["D:/etc/Google Drive/_session-bridge"]), {
        env: { MAILWARDEN_BRIDGE_DIR: "/nope" },
      }),
    ).toBeNull();
  });

  it("returns null where no bridge is mounted — the CI case, which must skip, not fail", () => {
    expect(resolveBridgeDir(exists([]), { env: {} })).toBeNull();
  });
});

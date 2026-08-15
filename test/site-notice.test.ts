import { describe, it, expect } from "vitest";
// @ts-expect-error — repo-only release helper, plain .mjs with no type declarations
import {
  addresses,
  isSiteThread,
  mentionsVersion,
  noticeState,
  readHeaders,
  resolveBridgeDir,
} from "../scripts/lib/site-notice.mjs";

/**
 * The release ritual now includes "tell the csitte.at session what changed", and this is the check
 * that says whether it happened. It runs against a Google Drive folder that is absent in CI, so the
 * rules themselves are pure functions and get their coverage here rather than from a live bridge.
 */

const msg = (opts: { from?: string; to?: string; body?: string } = {}) =>
  [
    "---",
    `from: ${opts.from ?? "mailwarden"}`,
    `to: ${opts.to ?? "csitte"}`,
    "type: fyi",
    "date: 2026-08-15T18:28:11Z",
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

describe("site-notice: version matching", () => {
  it("finds the version, with or without a v prefix", () => {
    expect(mentionsVersion("mailwarden 0.11.0 ist live", "0.11.0")).toBe(true);
    expect(mentionsVersion("Tag v0.11.0 gepusht", "0.11.0")).toBe(true);
    expect(mentionsVersion("(0.11.0)", "0.11.0")).toBe(true);
  });

  it("does not read 0.1.0 out of 0.10.0 — the trap a substring check walks into", () => {
    expect(mentionsVersion("Stand 0.10.0", "0.1.0")).toBe(false);
    expect(mentionsVersion("Stand 0.10.0", "0.10.0")).toBe(true);
  });

  it("does not accept a longer version as this one", () => {
    expect(mentionsVersion("0.11.01", "0.11.0")).toBe(false);
    expect(mentionsVersion("0.11.0.1", "0.11.0")).toBe(false);
  });

  it("counts a version that ends the sentence — the commonest spelling of all", () => {
    expect(mentionsVersion("Live ist jetzt 0.11.0.", "0.11.0")).toBe(true);
  });

  it("does not read the dev bundle as the release — it is a different artifact", () => {
    expect(mentionsVersion("das Bundle heisst 0.11.0-dev.a1b2c3", "0.11.0")).toBe(false);
  });

  it("accepts the price of that rule: a hyphenated compound alone does not count", () => {
    // `0.11.0-Release` is syntactically a semver prerelease, so it cannot be told apart from
    // `0.11.0-dev.<sha>`. Refusing both is the safe direction — a real announcement names the
    // bare version somewhere, and this way a page is never assumed updated when it is not.
    expect(mentionsVersion("das 0.11.0-Release ist raus", "0.11.0")).toBe(false);
    expect(mentionsVersion("das 0.11.0-Release ist raus. Stand 0.11.0.", "0.11.0")).toBe(true);
  });

  it("treats the dots as literal, not as wildcards", () => {
    expect(mentionsVersion("0x11y0", "0.11.0")).toBe(false);
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
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg() }]),
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
          text: msg({ body: "0.8.0, 0.9.0 und 0.10.0 sind auf der Seite nicht abgebildet." }),
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
          text: msg({ from: "csitte", to: "mailwarden", body: "0.11.0 ist auf der Seite." }),
        },
      ]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
  });

  it("trusts the frontmatter over the filename when the two disagree", () => {
    const state = noticeState(
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg({ from: "csitte" }) }]),
      "0.11.0",
    );
    expect(state.state).toBe("missing");
  });

  it("does not count a message addressed to someone else", () => {
    const state = noticeState(
      thread([{ name: "2026-08-15T182811Z__mailwarden__7b27.md", text: msg({ to: "freddy" }) }]),
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

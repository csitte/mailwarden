import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { checkEgress, guardEgress, allowRuleFor, ALLOW_RULES } from "../src/egress.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

describe("checkEgress — what may leave", () => {
  it.each([
    ["GET", `${GMAIL}/profile`],
    ["GET", `${GMAIL}/threads?q=is%3Aunread&maxResults=25`],
    ["GET", `${GMAIL}/threads/t1?format=full`],
    ["POST", `${GMAIL}/threads/t1/modify`],
    ["POST", `${GMAIL}/threads/t1/trash`],
    ["POST", `${GMAIL}/threads/t1/untrash`],
    ["GET", `${GMAIL}/messages?q=label%3Ainbox`],
    ["POST", `${GMAIL}/messages/batchModify`],
    ["GET", `${GMAIL}/messages/m1/attachments/a1`],
    ["GET", `${GMAIL}/history?startHistoryId=1`],
    ["GET", `${GMAIL}/labels`],
    ["POST", `${GMAIL}/labels`],
    ["PATCH", `${GMAIL}/labels/Label_7`],
    ["DELETE", `${GMAIL}/labels/Label_7`],
    ["GET", `${GMAIL}/settings/filters`],
    ["POST", `${GMAIL}/settings/filters`],
    ["DELETE", `${GMAIL}/settings/filters/f1`],
  ])("allows %s %s", (method, url) => {
    expect(checkEgress(method, url)).toBeUndefined();
  });

  it.each([
    ["sending a message", "POST", `${GMAIL}/messages/send`],
    ["sending a draft", "POST", `${GMAIL}/drafts/send`],
    ["creating a draft", "POST", `${GMAIL}/drafts`],
    ["reading drafts", "GET", `${GMAIL}/drafts/d1`],
    ["importing mail", "POST", `${GMAIL}/messages/import`],
    ["inserting mail", "POST", `${GMAIL}/messages/insert`],
    ["batch-deleting mail", "POST", `${GMAIL}/messages/batchDelete`],
    ["deleting a message", "DELETE", `${GMAIL}/messages/m1`],
    ["deleting a thread", "DELETE", `${GMAIL}/threads/t1`],
    ["auto-forwarding", "PUT", `${GMAIL}/settings/autoForwarding`],
    ["forwarding addresses", "POST", `${GMAIL}/settings/forwardingAddresses`],
    ["send-as identities", "POST", `${GMAIL}/settings/sendAs`],
    ["delegation", "POST", `${GMAIL}/settings/delegates`],
    ["IMAP", "PUT", `${GMAIL}/settings/imap`],
    ["vacation auto-reply", "PUT", `${GMAIL}/settings/vacation`],
  ])("refuses %s", (_what, method, url) => {
    expect(checkEgress(method, url)).toBeDefined();
  });

  it("refuses an endpoint that is simply not on the allowlist", () => {
    expect(checkEgress("GET", `${GMAIL}/messages/m1`)).toMatch(/allowlist/); // we read threads
    expect(checkEgress("POST", `${GMAIL}/watch`)).toMatch(/allowlist/);
  });

  it("matches on the method too — a read path is not a write path", () => {
    expect(checkEgress("DELETE", `${GMAIL}/threads/t1/trash`)).toBeDefined();
    expect(checkEgress("POST", `${GMAIL}/labels/Label_7`)).toBeDefined();
  });

  it("refuses the media-upload base path (mailwarden never uploads)", () => {
    expect(
      checkEgress("POST", "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send"),
    ).toBeDefined();
  });

  it("does not let a userId segment smuggle in another endpoint", () => {
    // A path parameter cannot introduce a slash through googleapis, but the rule
    // anchors both ends anyway so a crafted userId cannot walk to a sibling path.
    expect(checkEgress("POST", `${GMAIL}%2Fdrafts/messages/send`)).toBeDefined();
    expect(checkEgress("GET", `${GMAIL}/threads/t1/messages/m1`)).toMatch(/allowlist/);
  });

  it("allows Google's OAuth endpoints (token refresh carries no mail)", () => {
    expect(checkEgress("POST", "https://oauth2.googleapis.com/token")).toBeUndefined();
    expect(checkEgress("POST", "https://oauth2.googleapis.com/revoke")).toBeUndefined();
    expect(checkEgress("GET", "https://accounts.google.com/o/oauth2/v2/auth")).toBeUndefined();
  });

  it("refuses any other host outright", () => {
    expect(checkEgress("POST", "https://evil.example/gmail/v1/users/me/messages/send")).toMatch(
      /non-Gmail host/,
    );
    expect(checkEgress("GET", "https://gmail.googleapis.com.evil.example/gmail/v1/users/me/labels"))
      .toMatch(/non-Gmail host/);
  });

  it("refuses an unparseable or empty URL instead of falling through", () => {
    expect(checkEgress("GET", "")).toMatch(/unparseable/);
    expect(checkEgress("GET", "not a url")).toMatch(/unparseable/);
  });

  it("treats a missing method as GET", () => {
    expect(checkEgress("", `${GMAIL}/labels`)).toBeUndefined();
    expect(checkEgress("", `${GMAIL}/labels/Label_7`)).toBeDefined(); // GET on a label id: not used
  });
});

// The guard is only worth anything if googleapis really routes through
// `auth.request`. These drive the actual library, not a hand-built URL.
describe("guardEgress — in front of the real googleapis client", () => {
  function guardedClient() {
    const auth = new OAuth2Client({ clientId: "id", clientSecret: "secret" });
    auth.setCredentials({ access_token: "fake", expiry_date: Date.now() + 3_600_000 });
    const calls: string[] = [];
    auth.request = (async (opts: { method?: string; url?: string }) => {
      calls.push(`${opts.method ?? "GET"} ${opts.url}`);
      return { data: {} };
    }) as typeof auth.request;
    return { gmail: google.gmail({ version: "v1", auth: guardEgress(auth) }), calls };
  }

  it("blocks messages.send before it reaches the transport", async () => {
    const { gmail, calls } = guardedClient();
    await expect(
      gmail.users.messages.send({ userId: "me", requestBody: { raw: "" } }),
    ).rejects.toThrow(/refused its own outgoing request: sending mail/);
    expect(calls).toEqual([]); // nothing left the process
  });

  it("blocks drafts.send and drafts.create too", async () => {
    const { gmail, calls } = guardedClient();
    await expect(gmail.users.drafts.send({ userId: "me", requestBody: {} })).rejects.toThrow(
      /sending mail/,
    );
    await expect(gmail.users.drafts.create({ userId: "me", requestBody: {} })).rejects.toThrow(
      /composing mail/,
    );
    expect(calls).toEqual([]);
  });

  it("blocks permanent deletion and forwarding settings", async () => {
    const { gmail, calls } = guardedClient();
    await expect(gmail.users.messages.delete({ userId: "me", id: "m1" })).rejects.toThrow(
      /permanently deleting mail/,
    );
    await expect(
      gmail.users.settings.updateAutoForwarding({ userId: "me", requestBody: {} }),
    ).rejects.toThrow(/mailbox settings/);
    expect(calls).toEqual([]);
  });

  /**
   * Every Gmail call mailwarden makes, in one place, because two tests ask opposite
   * questions of the same list: that each one gets through, and that no allowlist entry
   * exists which none of them reaches.
   */
  async function everyCallMailwardenMakes(gmail: ReturnType<typeof google.gmail>) {
    await gmail.users.getProfile({ userId: "me" });
    await gmail.users.threads.list({ userId: "me", q: "is:unread" });
    await gmail.users.threads.get({ userId: "me", id: "t1" });
    await gmail.users.threads.modify({ userId: "me", id: "t1", requestBody: {} });
    await gmail.users.threads.trash({ userId: "me", id: "t1" });
    await gmail.users.threads.untrash({ userId: "me", id: "t1" });
    await gmail.users.messages.list({ userId: "me", q: "is:unread" });
    await gmail.users.messages.batchModify({ userId: "me", requestBody: { ids: ["m1"] } });
    await gmail.users.messages.attachments.get({ userId: "me", messageId: "m1", id: "a1" });
    await gmail.users.history.list({ userId: "me", startHistoryId: "1" });
    await gmail.users.labels.list({ userId: "me" });
    await gmail.users.labels.create({ userId: "me", requestBody: { name: "x" } });
    await gmail.users.labels.patch({
      userId: "me",
      id: "Label_7",
      requestBody: { color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" } },
    });
    await gmail.users.labels.delete({ userId: "me", id: "Label_7" });
    await gmail.users.settings.filters.list({ userId: "me" });
    await gmail.users.settings.filters.create({ userId: "me", requestBody: {} });
    await gmail.users.settings.filters.delete({ userId: "me", id: "f1" });
  }

  it("lets every call mailwarden actually makes through, unchanged", async () => {
    const { gmail, calls } = guardedClient();
    await everyCallMailwardenMakes(gmail);
    expect(calls).toHaveLength(17);
  });

  /**
   * The other direction, which nothing checked until now: an allowlist entry no call
   * reaches any more. The existing test proves every call has a rule; it says nothing
   * about a rule that has outlived its call — and a rule like that is an endpoint left
   * open for a feature that no longer exists, which is the one kind of allowlist drift
   * that widens the guard rather than breaking it. Nothing fails when it happens, so
   * only a test looking for it will find it.
   *
   * It counts rules reached rather than calls made, because the two totals differ on
   * purpose: one rule spells `modify|trash|untrash` as a single expression, so there are
   * fewer rules than endpoints. Comparing counts here would need that difference written
   * down a third time, and a number kept in three places is a number that drifts.
   */
  it("keeps no allowlist entry that no call reaches", async () => {
    const { gmail, calls } = guardedClient();
    await everyCallMailwardenMakes(gmail);

    const reached = new Set(
      calls.map((call) => {
        const [method, url] = call.split(" ");
        return allowRuleFor(method, new URL(url).pathname);
      }),
    );
    const dead = ALLOW_RULES.filter((rule) => !reached.has(rule));
    expect(dead).toEqual([]);
  });

  it("wraps only once, so a cached client cannot stack guards", () => {
    const auth = new OAuth2Client({ clientId: "id", clientSecret: "secret" });
    const guarded = guardEgress(auth);
    const first = guarded.request;
    expect(guardEgress(guarded).request).toBe(first);
    expect(guardEgress(auth)).toBe(auth);
  });


  /**
   * These two are why the deny list normalises the path. Handing a method
   * `media` makes googleapis target `/upload/gmail/v1/...`, which the rules used
   * to miss — the call was still refused, but by the allowlist rather than by the
   * rule that names it. The URLs below are not hand-written: the library builds
   * them.
   */
  it("blocks a media send, which googleapis routes to the /upload path", async () => {
    const { gmail, calls } = guardedClient();
    await expect(
      gmail.users.messages.send({
        userId: "me",
        media: { mimeType: "message/rfc822", body: "raw" },
      }),
    ).rejects.toThrow(/sending mail/);
    await expect(
      gmail.users.messages.send({
        userId: "me",
        uploadType: "resumable",
        media: { mimeType: "message/rfc822", body: "raw" },
      }),
    ).rejects.toThrow(/sending mail/);
    await expect(
      gmail.users.drafts.create({
        userId: "me",
        media: { mimeType: "message/rfc822", body: "raw" },
      }),
    ).rejects.toThrow(/composing mail/);
    expect(calls).toEqual([]);
  });

  /**
   * googleapis-common reads GOOGLE_CLOUD_UNIVERSE_DOMAIN straight from the
   * environment and rewrites the hostname with it. mailwarden never sets it, but
   * it does not own the environment either — so an authenticated request can be
   * aimed at a host of someone else's choosing without a line of mailwarden
   * changing. The guard is what makes that inert.
   */
  it("blocks a request the environment redirected to another host", async () => {
    const previous = process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN;
    process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN = "attacker.example";
    try {
      const { gmail, calls } = guardedClient();
      await expect(gmail.users.labels.list({ userId: "me" })).rejects.toThrow(/non-Gmail host/);
      expect(calls).toEqual([]); // the access token never reached that host
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN;
      else process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN = previous;
    }
  });
});

/**
 * The guard only helps where it is actually attached. Two invariants keep it attached:
 * a behavioural one (the client `getAuth` hands out refuses a forbidden call) and a
 * structural one (no code path builds a mailbox client without it).
 *
 * The structural half exists because the behavioural half cannot see the path that was
 * missed: `identifyStoredToken` built its own client for the `--auth` mailbox probe and
 * never wrapped it. That client only ever called `users.getProfile`, which is allowed, so
 * no test could have caught it by watching what it did. What was wrong was where the
 * client came from — so that is what this checks.
 */
describe("every mailbox client is guarded, whoever builds it", () => {
  it("hands out a guarded client from getAuth", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-egress-"));
    try {
      await fs.writeFile(
        path.join(dir, "token.json"),
        JSON.stringify({
          type: "authorized_user",
          client_id: "cid",
          client_secret: "cs",
          refresh_token: "rt",
        }),
      );
      vi.resetModules();
      vi.stubEnv("MAILWARDEN_DIR", dir);
      const { getAuth } = await import("../src/auth.js");
      const client = (await getAuth(false)) as unknown as {
        request: (o: { url: string; method: string }) => Promise<unknown>;
      };
      // A send is refused before any token refresh could happen, so this needs no network.
      await expect(
        client.request({ url: `${GMAIL}/messages/send`, method: "POST" }),
      ).rejects.toThrow(/sending mail/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("builds no client in auth.ts outside guardEgress()", async () => {
    const source = await fs.readFile(new URL("../src/auth.ts", import.meta.url), "utf8");
    // Strip comments first: this file discusses `fromJSON` in prose, and prose is not a call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // Every span that is an argument to guardEgress(...), by brace matching.
    const guarded: Array<[number, number]> = [];
    for (const m of code.matchAll(/guardEgress\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      guarded.push([m.index, i]);
    }
    const isGuarded = (at: number) => guarded.some(([from, to]) => at > from && at < to);

    const builders = [...code.matchAll(/google\.auth\.fromJSON\(|new OAuth2Client\(/g)];
    expect(builders.length).toBeGreaterThan(0); // the check is worthless if it matches nothing
    const unguarded = builders.filter((m) => !isGuarded(m.index)).map((m) => m[0]);
    expect(unguarded).toEqual([]);
  });
});

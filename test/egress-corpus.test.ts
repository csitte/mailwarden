import { describe, it, expect } from "vitest";
import { checkEgress } from "../src/egress.js";

/**
 * The egress guard is a pure function over a URL, and the SSRF guards taught us
 * what that means: a hand-written list of cases only defends against the
 * spellings someone thought of. So this corpus is not hand-written. It is every
 * method in Gmail's own discovery document (rev 20260810, `GET
 * https://gmail.googleapis.com/$discovery/rest?version=v1`) crossed with the
 * spellings Google actually serves.
 *
 * The table below is a snapshot of that revision — no test here reaches the
 * network — so it does not notice an endpoint Google adds later. Re-run the
 * request and regenerate it when the guard's surface is in question; the length
 * assertion is what makes a changed surface fail rather than pass quietly.
 */
const ENDPOINTS: Array<[method: string, path: string, id: string]> = [
  ["POST", "/gmail/v1/users/me/drafts", "gmail.users.drafts.create"],
  ["GET", "/gmail/v1/users/me/drafts", "gmail.users.drafts.list"],
  ["GET", "/gmail/v1/users/me/drafts/X", "gmail.users.drafts.get"],
  ["PUT", "/gmail/v1/users/me/drafts/X", "gmail.users.drafts.update"],
  ["DELETE", "/gmail/v1/users/me/drafts/X", "gmail.users.drafts.delete"],
  ["POST", "/gmail/v1/users/me/drafts/send", "gmail.users.drafts.send"],
  ["GET", "/gmail/v1/users/me/history", "gmail.users.history.list"],
  ["POST", "/gmail/v1/users/me/labels", "gmail.users.labels.create"],
  ["GET", "/gmail/v1/users/me/labels", "gmail.users.labels.list"],
  ["GET", "/gmail/v1/users/me/labels/L", "gmail.users.labels.get"],
  ["PUT", "/gmail/v1/users/me/labels/L", "gmail.users.labels.update"],
  ["DELETE", "/gmail/v1/users/me/labels/L", "gmail.users.labels.delete"],
  ["PATCH", "/gmail/v1/users/me/labels/L", "gmail.users.labels.patch"],
  ["GET", "/gmail/v1/users/me/messages", "gmail.users.messages.list"],
  ["POST", "/gmail/v1/users/me/messages", "gmail.users.messages.insert"],
  ["GET", "/gmail/v1/users/me/messages/X", "gmail.users.messages.get"],
  ["DELETE", "/gmail/v1/users/me/messages/X", "gmail.users.messages.delete"],
  ["POST", "/gmail/v1/users/me/messages/X/modify", "gmail.users.messages.modify"],
  ["POST", "/gmail/v1/users/me/messages/X/trash", "gmail.users.messages.trash"],
  ["POST", "/gmail/v1/users/me/messages/X/untrash", "gmail.users.messages.untrash"],
  ["GET", "/gmail/v1/users/me/messages/M/attachments/A", "gmail.users.messages.attachments.get"],
  ["POST", "/gmail/v1/users/me/messages/batchDelete", "gmail.users.messages.batchDelete"],
  ["POST", "/gmail/v1/users/me/messages/batchModify", "gmail.users.messages.batchModify"],
  ["POST", "/gmail/v1/users/me/messages/import", "gmail.users.messages.import"],
  ["POST", "/gmail/v1/users/me/messages/send", "gmail.users.messages.send"],
  ["GET", "/gmail/v1/users/me/profile", "gmail.users.getProfile"],
  ["PUT", "/gmail/v1/users/me/settings/autoForwarding", "gmail.users.settings.updateAutoForwarding"],
  ["GET", "/gmail/v1/users/me/settings/autoForwarding", "gmail.users.settings.getAutoForwarding"],
  ["POST", "/gmail/v1/users/me/settings/cse/identities", "gmail.users.settings.cse.identities.create"],
  ["GET", "/gmail/v1/users/me/settings/cse/identities", "gmail.users.settings.cse.identities.list"],
  ["DELETE", "/gmail/v1/users/me/settings/cse/identities/a@b.example", "gmail.users.settings.cse.identities.delete"],
  ["GET", "/gmail/v1/users/me/settings/cse/identities/a@b.example", "gmail.users.settings.cse.identities.get"],
  ["PATCH", "/gmail/v1/users/me/settings/cse/identities/a@b.example", "gmail.users.settings.cse.identities.patch"],
  ["POST", "/gmail/v1/users/me/settings/cse/keypairs", "gmail.users.settings.cse.keypairs.create"],
  ["GET", "/gmail/v1/users/me/settings/cse/keypairs", "gmail.users.settings.cse.keypairs.list"],
  ["GET", "/gmail/v1/users/me/settings/cse/keypairs/a@b.example", "gmail.users.settings.cse.keypairs.get"],
  ["POST", "/gmail/v1/users/me/settings/cse/keypairs/a@b.example:disable", "gmail.users.settings.cse.keypairs.disable"],
  ["POST", "/gmail/v1/users/me/settings/cse/keypairs/a@b.example:enable", "gmail.users.settings.cse.keypairs.enable"],
  ["POST", "/gmail/v1/users/me/settings/cse/keypairs/a@b.example:obliterate", "gmail.users.settings.cse.keypairs.obliterate"],
  ["GET", "/gmail/v1/users/me/settings/delegates", "gmail.users.settings.delegates.list"],
  ["POST", "/gmail/v1/users/me/settings/delegates", "gmail.users.settings.delegates.create"],
  ["GET", "/gmail/v1/users/me/settings/delegates/a@b.example", "gmail.users.settings.delegates.get"],
  ["DELETE", "/gmail/v1/users/me/settings/delegates/a@b.example", "gmail.users.settings.delegates.delete"],
  ["GET", "/gmail/v1/users/me/settings/filters", "gmail.users.settings.filters.list"],
  ["POST", "/gmail/v1/users/me/settings/filters", "gmail.users.settings.filters.create"],
  ["GET", "/gmail/v1/users/me/settings/filters/F", "gmail.users.settings.filters.get"],
  ["DELETE", "/gmail/v1/users/me/settings/filters/F", "gmail.users.settings.filters.delete"],
  ["GET", "/gmail/v1/users/me/settings/forwardingAddresses", "gmail.users.settings.forwardingAddresses.list"],
  ["POST", "/gmail/v1/users/me/settings/forwardingAddresses", "gmail.users.settings.forwardingAddresses.create"],
  ["DELETE", "/gmail/v1/users/me/settings/forwardingAddresses/a@b.example", "gmail.users.settings.forwardingAddresses.delete"],
  ["GET", "/gmail/v1/users/me/settings/forwardingAddresses/a@b.example", "gmail.users.settings.forwardingAddresses.get"],
  ["GET", "/gmail/v1/users/me/settings/imap", "gmail.users.settings.getImap"],
  ["PUT", "/gmail/v1/users/me/settings/imap", "gmail.users.settings.updateImap"],
  ["PUT", "/gmail/v1/users/me/settings/language", "gmail.users.settings.updateLanguage"],
  ["GET", "/gmail/v1/users/me/settings/language", "gmail.users.settings.getLanguage"],
  ["GET", "/gmail/v1/users/me/settings/pop", "gmail.users.settings.getPop"],
  ["PUT", "/gmail/v1/users/me/settings/pop", "gmail.users.settings.updatePop"],
  ["GET", "/gmail/v1/users/me/settings/sendAs", "gmail.users.settings.sendAs.list"],
  ["POST", "/gmail/v1/users/me/settings/sendAs", "gmail.users.settings.sendAs.create"],
  ["PATCH", "/gmail/v1/users/me/settings/sendAs/a@b.example", "gmail.users.settings.sendAs.patch"],
  ["DELETE", "/gmail/v1/users/me/settings/sendAs/a@b.example", "gmail.users.settings.sendAs.delete"],
  ["GET", "/gmail/v1/users/me/settings/sendAs/a@b.example", "gmail.users.settings.sendAs.get"],
  ["PUT", "/gmail/v1/users/me/settings/sendAs/a@b.example", "gmail.users.settings.sendAs.update"],
  ["GET", "/gmail/v1/users/me/settings/sendAs/a@b.example/smimeInfo", "gmail.users.settings.sendAs.smimeInfo.list"],
  ["POST", "/gmail/v1/users/me/settings/sendAs/a@b.example/smimeInfo", "gmail.users.settings.sendAs.smimeInfo.insert"],
  ["GET", "/gmail/v1/users/me/settings/sendAs/a@b.example/smimeInfo/X", "gmail.users.settings.sendAs.smimeInfo.get"],
  ["DELETE", "/gmail/v1/users/me/settings/sendAs/a@b.example/smimeInfo/X", "gmail.users.settings.sendAs.smimeInfo.delete"],
  ["POST", "/gmail/v1/users/me/settings/sendAs/a@b.example/smimeInfo/X/setDefault", "gmail.users.settings.sendAs.smimeInfo.setDefault"],
  ["POST", "/gmail/v1/users/me/settings/sendAs/a@b.example/verify", "gmail.users.settings.sendAs.verify"],
  ["GET", "/gmail/v1/users/me/settings/vacation", "gmail.users.settings.getVacation"],
  ["PUT", "/gmail/v1/users/me/settings/vacation", "gmail.users.settings.updateVacation"],
  ["POST", "/gmail/v1/users/me/stop", "gmail.users.stop"],
  ["GET", "/gmail/v1/users/me/threads", "gmail.users.threads.list"],
  ["GET", "/gmail/v1/users/me/threads/T", "gmail.users.threads.get"],
  ["DELETE", "/gmail/v1/users/me/threads/T", "gmail.users.threads.delete"],
  ["POST", "/gmail/v1/users/me/threads/T/modify", "gmail.users.threads.modify"],
  ["POST", "/gmail/v1/users/me/threads/T/trash", "gmail.users.threads.trash"],
  ["POST", "/gmail/v1/users/me/threads/T/untrash", "gmail.users.threads.untrash"],
  ["POST", "/gmail/v1/users/me/watch", "gmail.users.watch"],
];

/** Exactly the calls mailwarden makes — everything else in the API must be refused. */
const USED = new Set([
  "GET /gmail/v1/users/me/profile",
  "GET /gmail/v1/users/me/threads",
  "GET /gmail/v1/users/me/threads/T",
  "POST /gmail/v1/users/me/threads/T/modify",
  "POST /gmail/v1/users/me/threads/T/trash",
  "POST /gmail/v1/users/me/threads/T/untrash",
  "GET /gmail/v1/users/me/messages",
  "POST /gmail/v1/users/me/messages/batchModify",
  "GET /gmail/v1/users/me/messages/M/attachments/A",
  "GET /gmail/v1/users/me/labels",
  "POST /gmail/v1/users/me/labels",
  "DELETE /gmail/v1/users/me/labels/L",
  "GET /gmail/v1/users/me/settings/filters",
  "POST /gmail/v1/users/me/settings/filters",
  "DELETE /gmail/v1/users/me/settings/filters/F",
]);

/**
 * The classes SECURITY.md promises are unreachable. These carry a stronger
 * expectation than "refused": the deny list has to catch them on its own terms,
 * because its whole job is to survive a careless future edit to the allowlist.
 */
function forbiddenClass(method: string, path: string): string | undefined {
  if (/\/(messages|drafts)\/send$/.test(path)) return "sending";
  if (/\/drafts(\/|$)/.test(path)) return "drafts";
  if (/\/messages\/(import|insert)$/.test(path)) return "planting";
  if (/\/messages\/batchDelete$/.test(path)) return "hard delete";
  if (method === "DELETE" && /\/(messages|threads)\/[^/]+$/.test(path)) return "hard delete";
  if (/\/settings\/(?!filters(\/|$))/.test(path)) return "settings";
  return undefined;
}

const HOST = "https://gmail.googleapis.com";

describe("egress corpus — every endpoint Gmail documents", () => {
  it("covers the whole discovery surface", () => {
    expect(ENDPOINTS).toHaveLength(79);
    // Every call we make must still exist in the API we were generated from.
    for (const used of USED) {
      const [method, ...rest] = used.split(" ");
      expect(ENDPOINTS.some(([m, p]) => m === method && p === rest.join(" "))).toBe(true);
    }
  });

  it.each(ENDPOINTS)("%s %s (%s)", (method, path, _id) => {
    const verdict = checkEgress(method, HOST + path);
    if (USED.has(`${method} ${path}`)) expect(verdict).toBeUndefined();
    else expect(verdict).toBeDefined();
  });

  /**
   * googleapis builds `/upload/gmail/v1/...` whenever a method is handed `media`,
   * and `/resumable/upload/...` for a resumable one. Both are documented in the
   * same discovery document, so the deny list has to recognise a send by either
   * name. Before this corpus existed they fell through to the allowlist instead:
   * still refused, but by the rule that a future allowlist entry would override.
   */
  const SPELLINGS: Array<[label: string, rewrite: (p: string) => string]> = [
    ["canonical", (p) => p],
    ["media upload", (p) => "/upload" + p],
    ["resumable upload", (p) => "/resumable/upload" + p],
    ["doubled slashes", (p) => p.replace(/\//g, "//")],
    ["trailing slash", (p) => p + "/"],
    ["query string", (p) => p + "?alt=json&prettyPrint=false"],
    ["userId as an address", (p) => p.replace("/users/me", "/users/chris%40csitte.com")],
  ];

  const dangerous = ENDPOINTS.filter(([m, p]) => forbiddenClass(m, p));

  it("knows every dangerous endpoint by name, in every spelling Google serves", () => {
    expect(dangerous.length).toBeGreaterThan(30);
    const fallthrough: string[] = [];
    for (const [method, path] of dangerous) {
      for (const [label, rewrite] of SPELLINGS) {
        const url = HOST + rewrite(path);
        const verdict = checkEgress(method, url);
        expect(verdict, `${method} ${url}`).toBeDefined();
        // A trailing slash or a percent-encoded path is a 404 at Google, so the
        // allowlist may legitimately be the one refusing those. The spellings the
        // API really answers to must be caught by the deny list itself.
        if (/allowlist/.test(verdict!) && !["trailing slash"].includes(label)) {
          fallthrough.push(`${label}: ${method} ${url} -> ${verdict}`);
        }
      }
    }
    expect(fallthrough).toEqual([]);
  });

  it("does not let an upload prefix widen the allowlist", () => {
    // The deny list is normalised, the allowlist is not: an upload URL can only
    // ever be refused, never allowed — otherwise stripping the prefix would hand
    // every allowed endpoint a second, unchecked spelling.
    for (const used of USED) {
      const [method, path] = [used.slice(0, used.indexOf(" ")), used.slice(used.indexOf(" ") + 1)];
      expect(checkEgress(method, HOST + "/upload" + path), `upload ${used}`).toMatch(/allowlist/);
      expect(checkEgress(method, HOST + "/resumable/upload" + path)).toMatch(/allowlist/);
    }
  });

  /**
   * Two library features rewrite the host of an already-authenticated request:
   * `GOOGLE_CLOUD_UNIVERSE_DOMAIN` (read straight from the environment by
   * googleapis-common) and a `rootUrl` client option. mailwarden sets neither,
   * but neither is under its control either — the guard is what makes them
   * harmless, and it should say so when it fires.
   */
  it("refuses a host rewritten by universe domain or rootUrl, and names the mechanism", () => {
    const redirected = [
      "https://gmail.example.com/gmail/v1/users/me/labels",
      "https://gmail.googleapis.example/gmail/v1/users/me/threads",
      "https://evil.example/gmail/v1/users/me/labels",
    ];
    for (const url of redirected) {
      const verdict = checkEgress("GET", url);
      expect(verdict, url).toMatch(/non-Gmail host/);
      expect(verdict).toMatch(/GOOGLE_CLOUD_UNIVERSE_DOMAIN/);
    }
  });
});

import { describe, it, expect } from "vitest";
import { buildReport, reportExitCode, type DoctorInputs } from "../src/doctor.js";
import { GMAIL_MODIFY, GMAIL_SETTINGS_BASIC, GMAIL_READONLY, type ToolTier } from "../src/tiers.js";

const tiers = (...t: ToolTier[]) => new Set(t);

// A fully-healthy baseline; each test overrides just the fields it exercises.
function inputs(over: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    credPath: "/cfg/credentials.json",
    tokenPath: "/cfg/token.json",
    cred: { ok: true, kind: "installed", client_id: "id", client_secret: "sec" },
    account: null,
    tokenState: "plaintext",
    passphraseSet: false,
    grantedScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC],
    enabledTiers: tiers("read", "manage", "filters"),
    requiredScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC],
    profile: { ok: true, email: "me@example.com" },
    ...over,
  };
}

const check = (r: ReturnType<typeof buildReport>, name: string) => r.find((c) => c.name === name)!;

describe("buildReport", () => {
  it("reports all-green for a healthy setup and exits 0", () => {
    const r = buildReport(inputs());
    expect(r.every((c) => c.status === "ok")).toBe(true);
    expect(reportExitCode(r)).toBe(0);
  });

  it("fails on missing credentials with the actionable message", () => {
    const r = buildReport(inputs({ cred: { ok: false, message: "No OAuth credentials found at X." } }));
    expect(check(r, "Credentials")).toMatchObject({ status: "fail", detail: "No OAuth credentials found at X." });
    expect(reportExitCode(r)).toBe(1);
  });

  it("fails when no token exists and tells the user to run --auth", () => {
    const r = buildReport(inputs({ tokenState: "missing", grantedScopes: null, profile: null }));
    expect(check(r, "Token")).toMatchObject({ status: "fail" });
    expect(check(r, "Token").detail).toMatch(/--auth/);
    // No scope/live checks piled on top of a missing token.
    expect(r.find((c) => c.name === "Scopes")).toBeUndefined();
    expect(r.find((c) => c.name === "Live Gmail call")).toBeUndefined();
    expect(reportExitCode(r)).toBe(1);
  });

  it("fails an encrypted token when no passphrase is set", () => {
    const r = buildReport(inputs({ tokenState: "encrypted", passphraseSet: false, grantedScopes: null, profile: null }));
    expect(check(r, "Token")).toMatchObject({ status: "fail" });
    expect(check(r, "Token").detail).toMatch(/MAILWARDEN_TOKEN_PASSPHRASE/);
  });

  it("accepts an encrypted token when the passphrase is set", () => {
    const r = buildReport(inputs({ tokenState: "encrypted", passphraseSet: true }));
    expect(check(r, "Token")).toMatchObject({ status: "ok" });
  });

  it("warns on a plaintext token while a passphrase is configured", () => {
    const r = buildReport(inputs({ tokenState: "plaintext", passphraseSet: true }));
    expect(check(r, "Token")).toMatchObject({ status: "warn" });
  });

  it("fails when granted scopes don't cover the enabled tiers", () => {
    const r = buildReport(
      inputs({ grantedScopes: [GMAIL_READONLY], requiredScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC] }),
    );
    const scopes = check(r, "Scopes");
    expect(scopes.status).toBe("fail");
    expect(scopes.detail).toMatch(/gmail\.modify/);
    expect(scopes.detail).toMatch(/gmail\.settings\.basic/);
    expect(reportExitCode(r)).toBe(1);
  });

  it("warns (not fails) when scopes are unknown but a token exists", () => {
    const r = buildReport(inputs({ grantedScopes: null }));
    expect(check(r, "Scopes")).toMatchObject({ status: "warn" });
    expect(reportExitCode(r)).toBe(0); // unknown scopes must not be a hard failure
  });

  it("accepts gmail.modify as covering a read-only deployment's gmail.readonly", () => {
    // modify is a superset of readonly — a full-surface token must not be reported as broken
    // just because MAILWARDEN_TOOLS=read narrows the required scope list.
    const r = buildReport(
      inputs({
        grantedScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC],
        requiredScopes: [GMAIL_READONLY],
        enabledTiers: tiers("read"),
      }),
    );
    expect(check(r, "Scopes")).toMatchObject({ status: "ok" });
    expect(reportExitCode(r)).toBe(0);
  });

  it("does not nag about unreadable scopes on an encrypted token (re-auth can't fix it)", () => {
    const r = buildReport(inputs({ tokenState: "encrypted", passphraseSet: true, grantedScopes: null }));
    const scopes = check(r, "Scopes");
    expect(scopes.status).toBe("ok"); // a permanent, unfixable warning would be noise
    expect(scopes.detail).not.toMatch(/--auth/);
  });

  it("names the account in remediation so a named-account user can't clobber the default token", () => {
    const r = buildReport(inputs({ account: "work", tokenState: "missing", grantedScopes: null, profile: null }));
    expect(check(r, "Token").detail).toMatch(/mailwarden --auth --account work/);
  });

  it("surfaces a failing live Gmail call (e.g. revoked/expired token)", () => {
    const r = buildReport(
      inputs({ profile: { ok: false, error: "authorization has expired or been revoked. Run --auth." } }),
    );
    expect(check(r, "Live Gmail call")).toMatchObject({ status: "fail" });
    expect(reportExitCode(r)).toBe(1);
  });
});

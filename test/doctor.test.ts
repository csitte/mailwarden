import { describe, it, expect } from "vitest";
import {
  buildReport,
  classifyCredRead,
  reportExitCode,
  shouldLiveCheck,
  type DoctorInputs,
} from "../src/doctor.js";
import { GMAIL_MODIFY, GMAIL_SETTINGS_BASIC, GMAIL_READONLY, type ToolTier } from "../src/tiers.js";

const tiers = (...t: ToolTier[]) => new Set(t);

// A fully-healthy baseline; each test overrides just the fields it exercises.
function inputs(over: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    credPath: "/cfg/credentials.json",
    tokenPath: "/cfg/token.json",
    cred: { ok: true, kind: "installed", client_id: "id", client_secret: "sec", redirect_uri: "http://localhost" },
    account: null,
    tokenState: "plaintext",
    passphraseSet: false,
    grantedScopes: { known: true, scopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC] },
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
    const r = buildReport(inputs({ tokenState: "missing", grantedScopes: { known: false, reason: "no-token" }, profile: null }));
    expect(check(r, "Token")).toMatchObject({ status: "fail" });
    expect(check(r, "Token").detail).toMatch(/--auth/);
    // No scope/live checks piled on top of a missing token.
    expect(r.find((c) => c.name === "Scopes")).toBeUndefined();
    expect(r.find((c) => c.name === "Live Gmail call")).toBeUndefined();
    expect(reportExitCode(r)).toBe(1);
  });

  it("fails an encrypted token when no passphrase is set", () => {
    const r = buildReport(inputs({ tokenState: "encrypted", passphraseSet: false, grantedScopes: { known: false, reason: "no-token" }, profile: null }));
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
      inputs({ grantedScopes: { known: true, scopes: [GMAIL_READONLY] }, requiredScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC] }),
    );
    const scopes = check(r, "Scopes");
    expect(scopes.status).toBe("fail");
    expect(scopes.detail).toMatch(/gmail\.modify/);
    expect(scopes.detail).toMatch(/gmail\.settings\.basic/);
    expect(reportExitCode(r)).toBe(1);
  });

  it("warns (not fails) when scopes are unknown but a token exists", () => {
    const r = buildReport(inputs({ grantedScopes: { known: false, reason: "unrecorded" } }));
    expect(check(r, "Scopes")).toMatchObject({ status: "warn" });
    expect(reportExitCode(r)).toBe(0); // unknown scopes must not be a hard failure
  });

  it("accepts gmail.modify as covering a read-only deployment's gmail.readonly", () => {
    // modify is a superset of readonly — a full-surface token must not be reported as broken
    // just because MAILWARDEN_TOOLS=read narrows the required scope list.
    const r = buildReport(
      inputs({
        grantedScopes: { known: true, scopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC] },
        requiredScopes: [GMAIL_READONLY],
        enabledTiers: tiers("read"),
      }),
    );
    expect(check(r, "Scopes")).toMatchObject({ status: "ok" });
    expect(reportExitCode(r)).toBe(0);
  });

  it("never reports unknown scopes as ok — not even for an encrypted token", () => {
    // runDoctor decrypts (readGrantedScopes), so unknown here means genuinely unknown. Calling
    // that "ok" would green-light a token that lacks a required scope: the doctor would print
    // "Setup looks good" and the very next create_filter call would fail on insufficient scope.
    const r = buildReport(inputs({ tokenState: "encrypted", passphraseSet: true, grantedScopes: { known: false, reason: "unrecorded" } }));
    expect(check(r, "Scopes").status).toBe("warn");
  });

  it("never advises --auth for a LOCKED token — that would replace it with a plaintext one", () => {
    // readGrantedScopes returns null for a missing passphrase too. Reusing the "records no
    // scopes, re-run --auth" text there is both false and destructive: re-authorizing without
    // the passphrase in the environment rewrites the encrypted token in plaintext.
    const r = buildReport(
      inputs({ tokenState: "encrypted", passphraseSet: false, grantedScopes: { known: false, reason: "locked" } }),
    );
    const scopes = check(r, "Scopes");
    expect(scopes.status).toBe("warn");
    expect(scopes.detail).toMatch(/MAILWARDEN_TOKEN_PASSPHRASE/);
    expect(scopes.detail).not.toMatch(/records no scopes/);
    expect(scopes.detail).toMatch(/Do NOT re-run/);
  });

  it("reports a wrong passphrase as such, not as a missing scope record", () => {
    const r = buildReport(
      inputs({ tokenState: "encrypted", passphraseSet: true, grantedScopes: { known: false, reason: "bad-key" } }),
    );
    expect(check(r, "Scopes").detail).toMatch(/does not decrypt/);
    expect(check(r, "Scopes").detail).not.toMatch(/records no scopes/);
  });

  it("warns about the tool surface when an encrypted token lacks a scope", () => {
    // Registration cannot decrypt, so the server advertises the tools anyway — say so, or
    // --check and the live tool list look like they contradict each other.
    const r = buildReport(
      inputs({
        tokenState: "encrypted",
        passphraseSet: true,
        grantedScopes: { known: true, scopes: [GMAIL_READONLY] },
        requiredScopes: [GMAIL_MODIFY],
      }),
    );
    expect(check(r, "Scopes").detail).toMatch(/still advertises those tools/);
  });

  it("checks the real scopes of an encrypted token once they are known", () => {
    const r = buildReport(
      inputs({
        tokenState: "encrypted",
        passphraseSet: true,
        grantedScopes: { known: true, scopes: [GMAIL_READONLY] }, // decrypted by readGrantedScopes
        requiredScopes: [GMAIL_MODIFY, GMAIL_SETTINGS_BASIC],
      }),
    );
    expect(check(r, "Scopes").status).toBe("fail");
    expect(reportExitCode(r)).toBe(1);
  });

  it("names the account in remediation so a named-account user can't clobber the default token", () => {
    const r = buildReport(inputs({ account: "work", tokenState: "missing", grantedScopes: { known: false, reason: "no-token" }, profile: null }));
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

describe("classifyCredRead — absent vs unreadable", () => {
  const P = "/cfg/credentials.json";

  it("passes a successful read through to checkCredentials", () => {
    const ok = classifyCredRead(
      { ok: true, raw: JSON.stringify({ installed: { client_id: "i", client_secret: "s", redirect_uris: ["http://localhost"] } }) },
      P,
    );
    expect(ok).toMatchObject({ ok: true, kind: "installed" });
  });

  it("reports ENOENT as 'not found' with the download instructions", () => {
    const r = classifyCredRead({ ok: false, code: "ENOENT" }, P);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/No OAuth credentials found/);
  });

  it("reports a present-but-unreadable file as a permissions problem, not as missing", () => {
    // Telling an EACCES/EISDIR user to re-download the file sends them in circles.
    for (const code of ["EACCES", "EISDIR", "EPERM"]) {
      const r = classifyCredRead({ ok: false, code }, P);
      expect(r.ok).toBe(false);
      const msg = (r as { message: string }).message;
      expect(msg).toMatch(new RegExp(code));
      expect(msg).toMatch(/could not be read/);
      expect(msg).not.toMatch(/No OAuth credentials found/);
    }
  });
});

describe("shouldLiveCheck", () => {
  it("tries a live call for a usable token", () => {
    expect(shouldLiveCheck("plaintext", false)).toBe(true);
    expect(shouldLiveCheck("plaintext", true)).toBe(true);
    expect(shouldLiveCheck("encrypted", true)).toBe(true);
  });

  it("skips it when the token cannot be loaded at all", () => {
    // Encrypted without a passphrase: the Token check already reports it — a live call would
    // only duplicate that failure. Missing/invalid have nothing to call with.
    expect(shouldLiveCheck("encrypted", false)).toBe(false);
    expect(shouldLiveCheck("missing", true)).toBe(false);
    expect(shouldLiveCheck("invalid", true)).toBe(false);
  });
});

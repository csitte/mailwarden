# Setup guide — from zero to a working mailwarden

This is the long-form walkthrough. If you have set up a Google OAuth desktop app before,
the [README's five-line setup](../README.md#setup) is all you need — this page exists for
everyone doing it the first time, and for the two traps that cost real hours
(the [7-day token expiry](#help-it-worked-for-a-week-then-died-with-invalid_grant) and the
["unverified app" screen](#the-unverified-app-warning-is-normal)).

**What you'll end up with:**

- a Google Cloud project of your own (free, no billing account needed),
- an OAuth *Desktop app* client (`credentials.json`),
- a stored refresh token (`~/.mailwarden/token.json`) created by a one-time browser consent,
- mailwarden connected to your MCP client.

**Prerequisites:** Node.js ≥ 20 and a Google account. Nothing else — no server, no domain,
no billing.

---

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose
   mailbox you want to manage.
2. Click the **project picker** in the top bar → **New project**.
3. Name it anything (e.g. `mailwarden`) → **Create**, then make sure the new project is
   selected in the picker.

> Why a whole "cloud project" for a local tool? Google requires every OAuth app — even a
> single-user desktop tool — to live inside a project. Nothing will run in the cloud and
> nothing on this path costs money.

## 2. Enable the Gmail API

1. In the console, go to **APIs & Services → Library** (or open
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com> directly).
2. Search for **Gmail API** → open it → **Enable**.

## 3. Configure the OAuth consent screen — and set it to **Production**

This is the screen users see when they authorize the app. You are the only user, but Google
still requires it — and one setting here matters more than all the others.

1. Go to **APIs & Services → OAuth consent screen**. (Newer consoles show this under
   **Google Auth Platform**; if you land on a "Get started" branding wizard, that's the
   same thing.)
2. **User type: External.** ("Internal" is only available for Google Workspace
   organizations; with a plain Gmail account, External is your only option — and it's fine.)
3. Fill in the minimum: app name (e.g. `mailwarden`), your email as user support email and
   developer contact. Everything else can stay empty.
4. **Scopes:** you can skip this page. mailwarden requests its scopes
   (`gmail.modify` for read + label/archive/trash, and `gmail.settings.basic` for filter
   management) at authorization time; they do not need to be pre-declared here. The exact scopes
   follow your enabled tool tiers (`MAILWARDEN_TOOLS`, see the README) — the default requests both;
   a `read`-only setup asks only for `gmail.readonly`. Note that `gmail.modify` *is* a scope Gmail
   accepts for sending; mailwarden never does, because it registers no tool that could. If you want
   that ruled out at Google's end rather than mailwarden's, authorize a `read` deployment.
5. If the console asks for **test users**, add your own Gmail address.
6. **Now the important part — publish the app:** on the consent-screen overview, under
   **Publishing status**, click **Publish app** and confirm. The status must read
   **In production**, not "Testing".

### Why Production, seriously

While the consent screen is in **Testing** status, Google expires every refresh token after
**7 days** ([documented here](https://developers.google.com/identity/protocols/oauth2#expiration)).
The failure mode is nasty: mailwarden works perfectly for a week, then every call fails with
`invalid_grant`, and re-authorizing only buys you another week. Publishing to Production
makes the refresh token long-lived. There is no review, no cost, and no downside for a
personal app — "Production" does **not** mean Google verifies or lists your app; it only
changes token lifetime and shows a one-time warning screen (next section).

## 4. Create the OAuth client and download `credentials.json`

1. Go to **APIs & Services → Credentials** → **Create credentials → OAuth client ID**.
2. **Application type: Desktop app.** (Not "Web application" — the desktop type is what
   allows the localhost redirect that `mailwarden --auth` uses.)
3. Name it anything → **Create**.
4. In the confirmation dialog (or via the download icon in the client list), **download the
   JSON** file.
5. Save it as `~/.mailwarden/credentials.json`:

   ```bash
   # macOS / Linux
   mkdir -p ~/.mailwarden
   mv ~/Downloads/client_secret_*.json ~/.mailwarden/credentials.json
   ```

   ```powershell
   # Windows (PowerShell)
   New-Item -ItemType Directory -Force "$HOME\.mailwarden" | Out-Null
   Move-Item "$HOME\Downloads\client_secret_*.json" "$HOME\.mailwarden\credentials.json"
   ```

   Alternatively, keep the file wherever you like and point
   `MAILWARDEN_CREDENTIALS=/path/to/credentials.json` at it.

> Treat this file like a password. It identifies *your* OAuth client; combined with a
> refresh token it grants mailbox access. Don't commit it anywhere.

## 5. Authorize once

```bash
npx -y mailwarden --auth
```

What happens: a browser window opens on Google's consent page, you pick your account,
approve the `gmail.modify` and `gmail.settings.basic` scopes, and the terminal prints a success line. mailwarden stores
the refresh token in `~/.mailwarden/token.json` (mode `0600`) — that's the only local state
it keeps, and you never have to do this again on this machine.

> **Optional — encrypt the token at rest.** `mode 0600` is a no-op on Windows, so on that
> platform (or if `token.json` might end up in a backup or synced folder) set a passphrase
> before authorizing: `MAILWARDEN_TOKEN_PASSPHRASE=<your-passphrase>`. The token is then stored
> AES-256-GCM-encrypted, and a copy of the file is useless without the passphrase. The server
> needs the same `MAILWARDEN_TOKEN_PASSPHRASE` set at runtime to read it. This guards against a stolen
> *file*, not against malware running as your own user. See *Security & privacy* in the README.

> **Optional — a second Gmail account.** Authorize it under a name of its own:
> `npx -y mailwarden --auth --account work`. That stores `~/.mailwarden/token.work.json` instead of
> the default `token.json` (the same `credentials.json` is reused). Names are **case-insensitive**
> and stored lower-cased (`--account Work` → `token.work.json`), because on Windows/macOS two
> casings would otherwise be one file. **The server only picks that
> account up when you also set `MAILWARDEN_ACCOUNT=work` in its environment** — the `--account` flag
> alone affects the `--auth` run, not the running server. See *Multiple accounts* in the README.

### Verify it worked

```bash
npx -y mailwarden --check
```

The built-in doctor checks `credentials.json`, whether a token exists (and whether it's encrypted),
whether the granted scopes cover your enabled tiers, and makes one live Gmail call — printing a
concrete fix for anything wrong and exiting non-zero if so. Add `--account <name>` to check a named
account. **Run this first whenever something doesn't work** — it usually names the exact problem.

### The "unverified app" warning is normal

Because `gmail.modify` is a restricted scope and your app hasn't gone through Google's
(paid, CASA-audit) verification, Google shows a **"Google hasn't verified this app"**
interstitial. For a self-created, self-used app this is expected and safe — *you* are the
developer it warns you about:

1. Click **Advanced** (bottom left of the warning).
2. Click **Go to mailwarden (unsafe)**.
3. Approve the requested access.

You'll see this only when (re-)authorizing, never during normal operation.

## 6. Connect your client

**Claude Code:**

```bash
claude mcp add mailwarden -- npx -y mailwarden
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mailwarden": { "command": "npx", "args": ["-y", "mailwarden"] }
  }
}
```

**Remote (Streamable HTTP)** — see the [README](../README.md#connect); for shared or
remote deployments also read [Security & privacy](../README.md#security--privacy) and
consider `MAILWARDEN_READONLY=1` and `MAILWARDEN_DOWNLOAD_DIR`.

**Smoke test:** ask your assistant something like *"search my inbox for unread mail from
the last 2 days"* — you should get real thread summaries back.

---

## Troubleshooting

> **Start here:** `npx -y mailwarden --check` (add `--account <name>` for a named account). The
> doctor diagnoses most of the cases below in one command and prints the fix.

### "Not authorized yet for … (no token at …). Run `mailwarden --auth` once…"

The server found no token file. Run step 5. If you *did* run it, the `--auth` run and the
server are looking at **different files** — check both of these agree:

- **Config dir:** a custom `MAILWARDEN_DIR` must be set for **both**, or one looks in
  `~/.mailwarden` while the other wrote elsewhere.
- **Account:** if the server has `MAILWARDEN_ACCOUNT=work` it needs `token.work.json`, which is
  only written by `mailwarden --auth --account work`. A plain `mailwarden --auth` writes the
  *default* `token.json` — running it here does **not** fix the error and overwrites your default
  account's token. `mailwarden --check` prints which account and file are actually in use.

### Help, it worked for a week, then died with `invalid_grant`

Your consent screen is (or was) in **Testing** status — the 7-day refresh-token expiry
from step 3. Fix it for good:

1. Publish the app to **Production** (step 3.6).
2. Re-authorize once: `npx -y mailwarden --auth` (the consent flow always runs and always
   replaces the stored token — a dead token can't turn re-auth into a silent no-op).

`invalid_grant` outside the 7-day pattern means the token was revoked (e.g. via your
Google account's security page, or a Google-side password/security event) — the same
re-auth fixes that too.

### "Consent completed but Google returned no refresh token"

Google only issues a refresh token when the user *grants* access, not when an existing
grant is silently reused. mailwarden refuses to overwrite your stored token with nothing —
do what the error says: revoke mailwarden's access at
<https://myaccount.google.com/permissions> (or delete `~/.mailwarden/token.json`), then run
`--auth` again and you'll get a fresh consent prompt including a refresh token.

### "token.json is encrypted, but MAILWARDEN_TOKEN_PASSPHRASE is not set"

You (or a previous `--auth` run) turned on at-rest encryption by setting
`MAILWARDEN_TOKEN_PASSPHRASE`, but the server process doesn't have it. The **same** passphrase
must be present both when you run `--auth` *and* whenever the server runs — set it in the same
environment your MCP client launches mailwarden from (or your shell/service definition). If you
never meant to encrypt the token, just run `--auth` again *without* the variable set and it'll be
stored in plaintext.

### "Could not decrypt token.json — MAILWARDEN_TOKEN_PASSPHRASE is wrong or the file is corrupted"

The passphrase in the environment doesn't match the one the token was encrypted with (or the file
was truncated/edited). There is **no recovery** of the refresh token without the exact passphrase —
that's the point of the encryption. Options: fix `MAILWARDEN_TOKEN_PASSPHRASE` to the value you used
at `--auth` time, or if it's lost, delete the affected token file and run `--auth` again
(optionally revoke the old grant at <https://myaccount.google.com/permissions> first).

**Delete the right file.** With named accounts the file is `~/.mailwarden/token.<account>.json`, not
`token.json` — deleting the latter destroys a healthy *default* grant and leaves the broken one in
place. `mailwarden --check` names the exact file in use; re-authorize with the matching
`--account <name>`.

### "Cannot read OAuth credentials at …"

`credentials.json` isn't where mailwarden looks. Default: `~/.mailwarden/credentials.json`;
overrides: `MAILWARDEN_CREDENTIALS` (file path) or `MAILWARDEN_DIR` (directory). Also check
the file is the *OAuth client* JSON (top-level key `"installed"`) — an API key or a service
account JSON won't work.

### The filter tools are missing, or a call fails with "missing a Gmail scope this operation needs"

Scopes are tied to tool tiers. Filter management (`list_filters`/`create_filter`/`delete_filter`)
needs `gmail.settings.basic`; write actions (label/archive/trash/snooze, and the snooze sweep) need
`gmail.modify`. If your stored token was granted before you needed a scope — or you authorized with a
narrower `MAILWARDEN_TOOLS` (e.g. `read` or `read,manage`) than you now run with — mailwarden either
**hides the filter tools at startup** (with a one-line stderr hint) or, for older tokens that predate
the recorded-scope check, surfaces the message **at call time**. A read-only grant likewise can't run
the snooze sweep (`--sweep` / `MAILWARDEN_AUTO_SWEEP`), and warns at startup. Fix in all cases: run
`npx -y mailwarden --auth` with the tiers you need enabled — the default (`MAILWARDEN_TOOLS` unset)
grants `gmail.modify` + `gmail.settings.basic` and covers everything. See the README "Tool tiers"
section for how tiers map to tools and scopes.

### Authorized the wrong Google account

Revoke the token at <https://myaccount.google.com/permissions> for the wrong account (or
just delete the token file — `~/.mailwarden/token.json`, or `token.<account>.json` if you used
`--account`), then run `--auth` again (with the same `--account <name>`, if any) and pick the right
account in the browser.

Want **both** mailboxes instead of replacing one? Keep the first and authorize the second under its
own name: `npx -y mailwarden --auth --account work`, then register a second server entry with
`MAILWARDEN_ACCOUNT=work` in its env. See *Multiple accounts* in the README.

### Where's my data? How do I uninstall?

Local state is one directory: `~/.mailwarden/` — `credentials.json`, `token.json`, and one
`token.<account>.json` per named account. Delete the directory and revoke access at
<https://myaccount.google.com/permissions> — that's a complete uninstall (revoke **each** account
you authorized). mailwarden keeps no mailbox copy, index, or cache anywhere.

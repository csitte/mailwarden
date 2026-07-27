# Setup guide — from zero to a working mailwarden

This is the long-form walkthrough. If you have set up a Google OAuth desktop app before,
the [README's five-line setup](../README.md#setup) is all you need — this page exists for
everyone doing it the first time, and for the two traps that cost real hours
(the [7-day token expiry](#help-it-worked-for-a-week-then-died-invalid_grant) and the
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
4. **Scopes:** you can skip this page. mailwarden requests its scope
   (`https://www.googleapis.com/auth/gmail.modify`) at authorization time; it does not need
   to be pre-declared here.
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
approve the `gmail.modify` scope, and the terminal prints a success line. mailwarden stores
the refresh token in `~/.mailwarden/token.json` (mode `0600`) — that's the only local state
it keeps, and you never have to do this again on this machine.

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

### "mailwarden is not authorized yet. Run `mailwarden --auth` once…"

Exactly what it says: the server found no `token.json`. Run step 5. If you *did* run it,
check that the server and the `--auth` run agree on the config dir — a custom
`MAILWARDEN_DIR` must be set for **both**, or one of them looks in `~/.mailwarden` while
the other wrote elsewhere.

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

### "Cannot read OAuth credentials at …"

`credentials.json` isn't where mailwarden looks. Default: `~/.mailwarden/credentials.json`;
overrides: `MAILWARDEN_CREDENTIALS` (file path) or `MAILWARDEN_DIR` (directory). Also check
the file is the *OAuth client* JSON (top-level key `"installed"`) — an API key or a service
account JSON won't work.

### Authorized the wrong Google account

Revoke the token at <https://myaccount.google.com/permissions> for the wrong account (or
just delete `~/.mailwarden/token.json`), then `npx -y mailwarden --auth` and pick the right
account in the browser.

### Where's my data? How do I uninstall?

Local state is one directory: `~/.mailwarden/` (`credentials.json`, `token.json`). Delete
it and revoke access at <https://myaccount.google.com/permissions> — that's a complete
uninstall. mailwarden keeps no mailbox copy, index, or cache anywhere.

# mailwarden — Projektinstruktionen

Native Gmail-MCP-Server (TypeScript, Node ≥20). Veröffentlicht als npm-Paket `mailwarden`
und in der MCP-Registry als `io.github.csitte/mailwarden`.

## Harte Design-Regeln (nicht ohne Rücksprache ändern)

- **Kein Senden — by design.** Es gibt keine compose/reply/forward/send-Tools. Das ist die
  zentrale Sicherheitszusage gegen Prompt-Injection-Exfiltration und der wichtigste
  Differenzierer — siehe `SECURITY.md`. Auch `create_filter` erzeugt **nie** eine
  Forwarding-Regel. **Präzise formulieren:** von Google *erzwungen* ist das nur im
  `read`-Tier (`gmail.readonly`); `gmail.modify` ist bei Google für `messages.send` zulässig
  (13.08.2026 live bestätigt), dort trägt die Tool-Oberfläche die Zusage. Nie wieder
  „die Scopes können nicht senden" schreiben.
- **Kein Hard-Delete.** Nur `trash`/`untrash` (wiederherstellbar).
- **Live-API, kein Cache.** Kein Mailbox-Spiegel, kein Suchindex. Einziger lokaler Zustand:
  `~/.mailwarden/` (`credentials.json`, `token.json`, ggf. `token.<account>.json`).
- **Suchtreffer werden re-verifiziert.** Gmails `threads.list`-Index ist bei
  Read-State-Operatoren unzuverlässig (`is:unread` fällt in manchen Kombinationen weg);
  `search()` prüft jeden Treffer gegen die echten Labels. Beweis-Demo:
  `node scripts/demo-reverify.mjs`.

## Architektur-Muster

- `src/` — `auth.ts` (OAuth/Token/Accounts), `gmail.ts` (API-Wrapper), `tools.ts`
  (MCP-Tool-Registrierung), `tiers.ts` (Tool-Tiers → Scopes), `snooze.ts`, `digest.ts`,
  `doctor.ts` (`--check`), `http.ts`, `index.ts` (CLI).
- **Reine Logik von IO trennen.** Testbare pure Funktionen (z. B. `buildReport`,
  `resolveSnoozeDate`, `deriveLabelFilters`) + dünne IO-Schicht drumherum. Neue Features
  folgen diesem Muster.
- **Tool-Tiers** (`read`/`manage`/`filters`, via `MAILWARDEN_TOOLS`) bestimmen sowohl die
  registrierten Tools als auch die bei `--auth` angeforderten Scopes. Scope-Gating nicht
  aufweichen.

## Arbeitsweise

- **Tests sind Pflicht** für neue Logik (`npx vitest run`). Vor jedem Commit `npm run build` +
  Tests grün. (Keine Testanzahl hier — sie war schon zweimal veraltet; die aktuelle Zahl steht
  im README-Status, der beim Release ohnehin angefasst wird.)
- **Ein Feature = ein Commit**, Conventional Commits (`feat:`, `fix:`, `docs:`).
- **Prüfrunden vor einem Release:** `docs/RELEASE-CHECKS.md` — fertige Prompts, ein Winkel
  je Runde. Zwei Runden sind das Budget; eine nötige dritte ist ein Design-Signal. Immer
  Doku-gegen-Code und die Artefakt-Runde, dazu genau eine passende weitere. Reine
  Funktionen prüft ein Eingabe-Korpus zuverlässiger als jedes Code-Review.
- **Doku mitziehen:** README, `CHANGELOG.md` (`[Unreleased]`), bei Setup-relevanten
  Änderungen `docs/SETUP.md`, bei Sicherheitsaussagen `SECURITY.md`.
- **Release** (nur auf Ansage): `npm version <patch|minor>` (synct `server.json`), CHANGELOG
  `[Unreleased]` → Version + Link-Ref, Commit + Tag `vX.Y.Z` pushen → CI publisht npm und
  MCP-Registry automatisch; danach `gh release create`.

## Session-Bridge

Diese Session nimmt an der Session-Bridge teil unter der Id **`mailwarden`**.
Beim Session-Start `<drive>/_session-bridge/threads/*/msgs/` falten (PC:
`D:/etc/Google Drive/_session-bridge`, Notebook: `F:/Meine Ablage/_session-bridge`) und
Threads mit `owner: mailwarden` und Status ≠ `DONE` melden. Antworten **immer** als neue
Datei (write-once, temp-then-rename); nie eine bestehende Nachricht ändern.
Protokoll: `_session-bridge/README.md`.

**Nie direkt in fremde Repos committen** (z. B. `csitte.at`) — nur über die Bridge informieren.

**Bridge-Push (Watcher):** Beim Session-Start (nach dem Bridge-Start-Scan) das
Monitor-Tool armen — persistent: true, Beschreibung "Session-Bridge: neue Nachrichten an
mailwarden", Kommando mit dem Pfad, der auf diesem Gerät existiert:
`bash D:/gitwork/session-broker/watch-bridge.sh mailwarden` (PC) bzw.
`bash C:/gitwork/session-broker/watch-bridge.sh mailwarden` (Notebook).
Jede Notification = neue Bridge-Nachricht an diese Session → Datei lesen, im Chat
melden, gemäß Bridge-Protokoll reagieren. Der Watcher liest nur und ergänzt den
Start-Scan; write-once bleibt. **Watcher nicht entwaffnen:** er überlebt `/clear` und
stellt weiter zu; ein zweiter Arm erkennt den laufenden und tritt zur Seite.
`TaskStop` nur, wenn die Zustellung *sofort* aufhören soll. Zustand prüfen mit
`bash D:/gitwork/session-broker/watch-bridge.sh --status mailwarden`. Betriebsdoku: WATCHER.md neben dem Script.

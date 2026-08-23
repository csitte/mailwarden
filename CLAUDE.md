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
  „die Scopes können nicht senden" schreiben. **Seit 20.08. zusätzlich `src/egress.ts`:** ein
  Checkpoint um `request()` des Auth-Clients, Allowlist der 15 tatsächlich genutzten Endpunkte plus
  vorgeschaltete Denylist (send/drafts/import/insert/Hard-Delete/settings außer filters). Damit ist
  die Zusage **im Server** erzwungen — aber weiter **nicht am Token**: ein gestohlenes
  `gmail.modify`-Refresh-Token sendet von woanders. Wer einen Endpunkt neu benutzt, muss ihn dort
  eintragen, sonst fliegt der Aufruf. **Die beiden Listen sind bewusst asymmetrisch (23.08.):** die
  Denylist matcht einen **normalisierten** Pfad (Upload-Präfixe gestrippt, Mehrfach-Slashes gefaltet),
  weil `googleapis` bei `media` auf `/upload/gmail/v1/...` zielt — ein realer Sendeweg, den auf
  `/gmail/v1` verankerte Regeln nie sahen. Die **Allowlist matcht weiter roh** und darf das nie
  ändern: sonst bekäme jeder erlaubte Endpunkt eine zweite, ungeprüfte Schreibweise. Merksatz:
  **Denylist so breit wie die API wirklich ist, Allowlist so eng wie mailwarden wirklich ist.**
- **Kein Hard-Delete.** Nur `trash`/`untrash` (wiederherstellbar).
- **Live-API, kein Cache.** Kein Mailbox-Spiegel, kein Suchindex. Einziger lokaler Zustand:
  `~/.mailwarden/` (`credentials.json`, `token.json`, ggf. `token.<account>.json`).
- **Suchtreffer werden re-verifiziert.** **`threads.list`** (nicht „der Suchindex") kann
  Read-State-Operatoren aus einem veralteten **Thread-**Read-State beantworten (**gemessen
  15.08.2026**: 132 Treffer für `category:updates is:unread`, davon 114 ohne eine einzige ungelesene
  Nachricht = 86 % — **im selben Durchgang ein zweites Postfach mit 0 Drift, und dieselbe Query über
  `messages.list` im selben Postfach in derselben Minute: 19 Treffer, 0 veraltet**). `search()` geht
  über `threads.list` und prüft deshalb jeden Treffer gegen die echten Labels; der
  Message-Pfad (`bulk_modify`) ist ein anderer Fall.
  **Drei Formulierungen sind verbrannt und nicht wiederzubeleben:** der Index „verwerfe `is:unread`"
  (falsch — dieselbe Query ohne das Prädikat liefert 800+, es wirkt also), es liege an bestimmten
  **Operator-Kombinationen** (falsch — auch die simpelste Query zeigt den Effekt; „größter Effekt" nur
  absolut, 136 Threads, in Prozent ist sie mit 58 % die schwächste), und es
  betreffe `is:unread` **allgemein** (unbelegt — das zweite Postfach widerspricht). Belegt ist:
  postfachabhängig, und ein Server kann vorher nicht wissen, in welchem er steckt. Demo gegen eine
  Fake-API: `node scripts/demo-reverify.mjs`; Messung im eigenen Postfach:
  `node scripts/probe-reverify.mjs`.

## Architektur-Muster

- `src/` — `auth.ts` (OAuth/Token/Accounts), `gmail.ts` (API-Wrapper), `tools.ts`
  (MCP-Tool-Registrierung), `tiers.ts` (Tool-Tiers → Scopes, Server-`instructions`), `snooze.ts`,
  `digest.ts`, `signals.ts` (Header-Signale), `unsubscribe.ts` (RFC 8058 + SSRF-Guard),
  `sanitize.ts` (Fencing), `cli.ts`, `doctor.ts` (`--check`), `http.ts`, `index.ts` (CLI).
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
- **Alles im Repo ist Englisch — auch Commit-Messages.** Code, Kommentare, Tests, README,
  `SECURITY.md`, `CHANGELOG.md`, `docs/SETUP.md`, Tool-Beschreibungen. **Genau zwei Ausnahmen:
  diese Datei und `docs/RELEASE-CHECKS.md`** — interne Arbeitsdokumente, die an Chris und an mich
  gehen, nicht an Nutzer. (Anweisung 18.08.2026; die Commit-Historie davor ist deutsch und wird
  nicht umgeschrieben.) **Deutsche Umlaute in Testdaten sind kein deutscher Text**: `"Grüße für
  März"`, `münchen.example`, `Scanbot/zu-löschen` prüfen RFC-2047-, IDN- und Labelbehandlung und
  bleiben, wo sie stehen.
- **Prüfrunden vor einem Release:** `docs/RELEASE-CHECKS.md` — fertige Prompts, ein Winkel
  je Runde. Zwei Runden sind das Budget; eine nötige dritte ist ein Design-Signal. Immer
  Doku-gegen-Code und die Artefakt-Runde, dazu genau eine passende weitere. Reine
  Funktionen prüft ein Eingabe-Korpus zuverlässiger als jedes Code-Review.
- **Doku mitziehen:** README, `CHANGELOG.md` (`[Unreleased]`), bei Setup-relevanten
  Änderungen `docs/SETUP.md`, bei Sicherheitsaussagen `SECURITY.md`.
- **Release** (nur auf Ansage): erst alles außer der Version pushen und **CI grün abwarten**, dann
  `npm version <patch|minor>` (synct `server.json`; CHANGELOG vorher `[Unreleased]` → Version +
  Link-Ref) und pushen. **Achtung `push.followTags=true`:** ein `git push` nimmt den Tag
  automatisch mit, der Publish-Lauf startet also sofort — die Reihenfolge „taggen, dann in Ruhe
  schauen" gibt es hier nicht. Das ist vertretbar, weil `publish.yml` Build, Tests, `npm run smoke`
  und `npm run mcpb` selbst vor dem irreversiblen `npm publish` fährt. CI publisht npm und
  MCP-Registry automatisch; danach `npm run mcpb` (auf dem sauberen Tag-Checkout — sonst entsteht
  ein `-dev.<sha>`-Bundle, das bewusst nicht als Release durchgeht),
  `gh release create vX.Y.Z dist-mcpb/mailwarden-X.Y.Z.mcpb` (striktes Bundle = Release-Asset) und
  `npx -y @smithery/cli mcp publish dist-mcpb/mailwarden-X.Y.Z-smithery.mcpb -n csitte/mailwarden`
  (die `-smithery`-Variante trägt die echten Tool-Objekte mit `inputSchema`, die Smitherys Registry
  verlangt; Namespace `csitte` und Login stehen seit 15.08.2026).
- **Ein Release ist erst fertig, wenn csitte.at es weiß.** Die Produktseite
  `www.csitte.at/mailwarden/` liegt im fremden Repo `csitte.at` — **nicht committen**, sondern eine
  Bridge-Nachricht an `csitte` in Thread `061-mailwarden-doku-csitte-update` (Owner → `csitte`,
  Status `OPEN`; der offene Thread ist die Nachverfolgung). Inhalt ist ein *Delta gegen die Seite*,
  nicht der CHANGELOG: erst `web/app/mailwarden/page.tsx` lesen, dann (a) was dort jetzt **falsch**
  ist, (b) was fehlt, (c) neue Bezugswege. Wir liefern Fakten + Quellen, csitte formuliert selbst.
  **(a) schließt ausdrücklich *Einschränkungen bestehender Zusagen* ein — und die stehen zuerst.**
  Eine Zusage, die enger geworden ist, ist wichtiger als jedes neue Feature: die Seite verspricht
  sonst weiter etwas, das die ausgelieferte Version so nicht (mehr) hält. Anlass (15.08.): der
  Vorbehalt „`bulk_modify` re-verifiziert nicht" ging als Nebensatz einer Faktenkorrektur raus;
  die Seite versprach daraufhin, Fehltreffer würden verworfen, „bevor eine Aktion sie sieht" —
  wahr für `search`, als generelle Zusage zu weit. (Nachtrag derselben Nacht: die Drift sitzt in
  `threads.list`; der Bulk-Pfad über `messages.list` zeigte sie im direkten Vergleich **nicht** —
  die Zusage war trotzdem unbelegt, und der Reihenfolge-Punkt gilt unverändert.)
  Zwei Konventionen der Seite respektieren: **keine Versionsnummer und keine gezählten Aufzählungen**
  im Fließtext — beides veraltet bei jedem unserer Commits.
  **Die Meldung trägt `announces: <version>` im Frontmatter** — daran und nur daran erkennt
  `npm run site-notice`, dass sie erfolgt ist (exit ≠ 0, wenn nicht); `postversion` sagt es beim Taggen
  schon einmal an. Die erste Fassung suchte die Version im Fließtext und meldete prompt einen
  Fehlalarm, weil eine ältere Nachricht sie als *Beispiel* enthielt: ein falsches „ok" kostet den
  Schritt selbst, ein falsches „fehlt" nur einen zweiten Blick. Ohne Bridge-Laufwerk (CI, fremder
  Klon) meldet der Check **SKIPPED**, nie „ok" — er behauptet nichts, was er nicht gesehen hat.
  Anlass: die Seite beschrieb noch 0.7.0, als 0.10.0 live war (drei Releases ohne Nachricht).

## Session-Bridge

Diese Session nimmt an der Session-Bridge teil unter der Id **`mailwarden`**.
Beim Session-Start `<drive>/_session-bridge/threads/*/msgs/` falten (PC:
`D:/etc/Google Drive/_session-bridge`, Notebook: `F:/Meine Ablage/_session-bridge`) und
Threads mit `owner: mailwarden` und Status ≠ `DONE` melden. Antworten **immer** als neue
Datei (write-once, temp-then-rename); nie eine bestehende Nachricht ändern.
Protokoll: `_session-bridge/README.md`.

**Nie direkt in fremde Repos committen** (z. B. `csitte.at`) — nur über die Bridge informieren.

**Bridge-Push (Watcher):** Beim Session-Start **zuerst armen, dann falten** — in dieser
Reihenfolge, und ohne `--status`-Vorprüfung: Das Monitor-Tool armen mit persistent: true,
Beschreibung "Session-Bridge: neue Nachrichten an mailwarden", Kommando mit dem Pfad, der auf diesem
Gerät existiert:
`bash D:/gitwork/session-broker/watch-bridge.sh mailwarden` (PC) bzw.
`bash C:/gitwork/session-broker/watch-bridge.sh mailwarden` (Notebook).
Liefert für diese Id schon ein Watcher, tritt der neue Arm von selbst zur Seite; ein stummer
Rest wird dabei abgeräumt — deshalb ist Armen bedingungslos richtig. **Danach** der
Bridge-Start-Scan in einem Durchgang — keine eigene Schleife über die Dateien, die läuft auf
dem Drive ins Timeout:
`bash D:/gitwork/session-broker/watch-bridge.sh --fold mailwarden` (PC) bzw.
`bash C:/gitwork/session-broker/watch-bridge.sh --fold mailwarden` (Notebook)
zeigt die offenen Threads mit `owner: mailwarden`; meldet er eine WARNUNG, lädt Drive noch
nach — später wiederholen; meldet er ACHTUNG, ist der Arm ausgeblieben — dann jetzt armen.
Was beim Armen schon dalag, ist Baseline und kommt über den Start-Scan; die Reihenfolge
verliert also nichts.
Jede Notification = neue Bridge-Nachricht an diese Session → Datei lesen, im Chat
melden, gemäß Bridge-Protokoll reagieren. Der Watcher liest nur und ergänzt den
Start-Scan; write-once bleibt. **Watcher nicht entwaffnen:** er überlebt `/clear` und
stellt weiter zu; ein zweiter Arm erkennt den laufenden und tritt zur Seite.
`TaskStop` nur, wenn die Zustellung *sofort* aufhören soll. Zustand prüfen mit
`bash D:/gitwork/session-broker/watch-bridge.sh --status mailwarden`. Betriebsdoku: WATCHER.md neben dem Script.

# Prüfrunden vor einem Release

> Internes Arbeitsdokument, deshalb Deutsch — wie `CLAUDE.md`. README, SECURITY und die
> übrigen `docs/` sind Englisch, weil sie an Nutzer gehen.

Fertige Prompts zum Kopieren. Jede Runde prüft aus einem **anderen Winkel**; das ist der
Punkt. Dieselbe Prüfung zweimal liefert beim zweiten Mal eine schwächere Kopie.

## Warum Winkel und nicht Wiederholung

Die Ausbeute in diesem Projekt war extrem ungleich verteilt:

| Winkel | Ergebnis |
|---|---|
| Code nochmal adversarial lesen | 1 mittlerer Fund |
| Eingabe-Korpus über reine Funktionen | **13 falsche Verdikte**, Ursache strukturell |
| Doku gegen Code | **4 falsche Zusagen**, 3 davon von den Fixes derselben Sitzung gebrochen |
| Lauf gegen echte Daten | bestätigte die Annahmen, die sonst ungeprüft geblieben wären |

Dazu die Multi-Account-Erfahrung: **vier** Runden, weil jede Fix-Runde neue Fehler im
selben Bereich erzeugte. Das war ein Design-Signal, kein Review-Bedarf — konvergiert ist es
erst, als die Ursache behoben wurde (ein Token-Leser statt drei).

**Zwei Runden sind das Budget.** Eine nötige dritte Runde ist ein Hinweis auf ein
Designproblem, kein Qualitätsgewinn.

## Das Muster jeder Prüfung

Ohne diese vier Bestandteile verwässert jede Runde:

1. **Invariante benennen**, die halten muss — nicht „such Fehler".
2. **Eingabequelle benennen**, die der Angreifer kontrolliert.
3. **Systematisch über den Eingaberaum**, nicht über die Beispiele aus den Tests.
4. **Repro-Zwang und Erlaubnis, nichts zu finden.** Ein Fund ohne auslösende Eingabe ist
   eine Vermutung. Ohne die ausdrückliche Erlaubnis liefert ab Runde zwei jede Prüfung
   Beschäftigungs-Findings, um nützlich auszusehen.

## Die stehenden Invarianten

Diese ändern sich zwischen Releases nicht — deshalb stehen sie hier und nicht im Prompt.
Runde 3 verweist darauf.

1. **Kein Senden.** Kein compose/reply/forward/send-Tool und kein Forwarding-Filter.
   **Achtung, hier stand bis 13.08.2026 etwas Falsches:** „die angeforderten Scopes *können*
   nicht senden" gilt **nur für den `read`-Tier** (`gmail.readonly`). `gmail.modify` ist bei
   Google ein zulässiger Scope für `messages.send`/`drafts.send` — live bestätigt, beide
   Endpunkte antworten mit einem Payload-Fehler statt mit 403. In `manage`/`filters` trägt
   also die **Tool-Oberfläche** die Zusage, nicht Google. Einen send-freien Write-Scope gibt
   es für eine Installed App nicht.
2. **Kein Hard-Delete.** Nur `trash`/`untrash`.
3. **Das Konto ist kein Tool-Parameter.** Ein Prozess bedient genau ein Konto, fixiert vor
   der Tool-Registrierung.
4. **Kein Cache, kein Spiegel, kein Suchindex.** Einziger lokaler Zustand: `~/.mailwarden/`.
5. **Tier- und Scope-Gating.** Ein `read`-Deployment kann nichts verändern und nichts
   schreiben — weder Mailbox noch Dateien noch ausgehende Requests.
6. **Kein Ausgang außer Google**, mit der einen dokumentierten Ausnahme (`unsubscribe`,
   SECURITY.md Klasse 9). Keine URL, die das Modell wählen kann.
7. **Jede Tool-Ausgabe ist gefenced** und von unsichtbaren/BiDi-Zeichen bereinigt.

---

## Runde 1 — Eingaberaum

Der stärkste Winkel für dieses Projekt, weil fast alles hier parst und normalisiert:
Datumsangaben, Suchprädikate, Label-Namen, RFC-2047-Header, Zeichensätze, Adressen.

```
Nimm jede reine Funktion, die dieser Release neu hat oder geändert hat, und bau
für sie einen Eingabe-Korpus statt Beispieltests:
 - die maßgebliche Quelle ihres Wertebereichs vollständig durchgegangen (RFC,
   IANA-Registry, Gmail-Doku, Kalender- und Zeitzonenregeln), inklusive der
   Grenzwerte direkt ober- und unterhalb jedes Bereichs;
 - dieselbe Eingabe in JEDER Schreibweise, die dasselbe bedeutet — abgekürzt und
   ausgeschrieben, Groß- und Kleinschreibung, kodiert und dekodiert, gefaltet,
   mit und ohne optionale Bestandteile;
 - Eingaben, die gar nicht in den Wertebereich gehören.
Zeig mir ZUERST als Tabelle (Eingabe → erwartet → tatsächlich), welche dieser
Fälle die Implementierung heute falsch beantwortet. Erst danach den Fix, und
danach den Korpus als tabellengetriebenen Test.
Stimmt alles, sag das.
```

Warum das trägt: beide bisherigen Sicherheitslücken im Adress-Guard waren
**Schreibweisen**-Fehler — dieselbe Adresse, anders geschrieben. Kein Code-Review findet
so etwas zuverlässig, ein Korpus schon.

## Runde 2 — Doku gegen Code

```
Prüfe jede Aussage über die Änderungen dieses Release einzeln gegen den Code:
README.md, SECURITY.md, CHANGELOG.md, docs/ und die Beschreibungstexte der
betroffenen Tools. Pro Aussage: stimmt / stimmt nicht / stimmt nur unter
Bedingung X. Zitiere jede beanstandete Aussage wörtlich mit Datei und Zeile.
Zwei Schwerpunkte:
 - Sicherheitszusagen zuerst. Eine Zusage, die der Code nicht hält, ist
   schlimmer als ein fehlendes Feature.
 - Aussagen, die von den Fixes DIESES Zyklus überholt wurden. Das sind
   erfahrungsgemäß die meisten Treffer: der Fix ändert das Verhalten, der Satz
   daneben bleibt stehen.
Prüf auch die Tool-Beschreibungen — sie sind die Doku, die das Modell liest, und
eine falsche Beschreibung führt direkt zu falschen Aufrufen.
```

## Runde 3 — Invarianten

```
Die stehenden Invarianten stehen in docs/RELEASE-CHECKS.md. Geh den Diff dieses
Release durch und beantworte für JEDE Invariante einzeln: kann irgendein Pfad
sie verletzen — auch indirekt über mehrere Schritte, auch erst in Kombination
mit bestehendem Code?
Der Angreifer kontrolliert den kompletten Mailinhalt inklusive aller Header, und
das Modell folgt ihm bereitwillig. Er kontrolliert NICHT die Server-Konfiguration
und nicht die Umgebungsvariablen.
Für jeden Fund den konkreten Aufruf oder die konkrete Mail, die ihn auslöst.
Findest du nichts, sag das — keine erfundenen Funde.
```

## Runde 4 — Die Fix-Commits

Eigene Runde, weil Fixes in diesem Projekt zuverlässig neue Fehler erzeugt haben.

```
Prüfe NUR die Fix-Commits dieses Zyklus, nicht die Feature-Commits.
Drei Fragen:
 1. Was hat jeder Fix außer dem beabsichtigten Verhalten noch geändert?
    Besonders: gemeinsam genutzte Helfer, deren übrige Aufrufer nicht
    mitangefasst wurden.
 2. Welche Tests wurden GEÄNDERT statt hinzugefügt? Für jeden einzeln: war die
    alte Zusicherung falsch, oder ist die neue falsch? (Ein Test, der während
    eines Fixes angepasst wird, hat hier schon zweimal das falsche Verhalten
    festgeschrieben.)
 3. Behebt der Fix die Ursache oder den beobachteten Fall? Wenn der Fund an
    einer Stelle auftrat, an der er auch anderswo auftreten kann, zähl die
    anderen Stellen auf.
```

## Runde 5 — Nur gegen Fakes belegt

```
Welche Zusage dieses Release ist bisher NUR gegen Testdaten belegt, die wir
selbst geschrieben haben — also gegen unsere eigenen Annahmen darüber, wie die
Realität aussieht? Liste sie auf und markiere die riskanteste.
Bau dann die kleinstmögliche, STRIKT LESENDE Sonde, die genau diese Annahme
gegen die Realität hält, und gib roh aus, was die Realität liefert, daneben was
unser Code daraus macht. Keine schreibende Operation, kein Kontakt zu Dritten,
nichts Irreversibles.
Prüf mit derselben Sonde auch die Gegenrichtung: lehnt unsere Prüfung etwas ab,
das in Wirklichkeit legitim ist? Ein False Positive macht ein Feature still
kaputt und fällt in keinem Test auf.
```

Die letzte Frage ist die, die sonst niemand stellt. Bei `unsubscribe` war sie der eigentliche
Gewinn: 27 echte Opt-out-Endpunkte, keiner fälschlich blockiert.

## Runde 6 — Das Artefakt, nicht der Quellbaum

**Der mechanische Teil läuft inzwischen automatisch.** `npm run smoke` prüft gegen das
*installierte* Paket: relative Links, Sprungmarken, Versionsgleichstand package.json ↔
server.json, dazu Handshake, Tool-Oberfläche und `--check`. `npm run mcpb` tut dasselbe für das
zweite Artefakt, das MCPB-Bundle (Manifest validiert, Bundle entpackt und gebootet, Größe unter
Smitherys Limit). Nicht mehr per Prompt nachbauen — der Prompt fragt nur noch nach dem, was ein
Skript nicht beurteilen kann:

```
`npm run smoke` ist gelaufen und grün — es deckt relative Links, Sprungmarken,
Versionsgleichstand, Handshake, Tool-Oberfläche und --check gegen das
installierte Paket ab. Prüf das, was es NICHT beurteilen kann:
 - Ist CHANGELOG [Unreleased] vollständig UND ehrlich? Steht dort jeder Commit
   seit dem letzten Tag, der Nutzerverhalten ändert, und beschreibt der Text das
   tatsächliche Verhalten statt der Absicht?
 - Stimmen die Zahlen in den ausgelieferten Docs noch (Testanzahl, Tool-Anzahl,
   Versionsangaben im Fließtext)?
 - Ist die Versionsnummer die richtige Stufe — bringt der Release etwas, das
   minor statt patch verlangt, oder umgekehrt?
 - Behauptet ein Link zwar ein Ziel, das existiert, aber inhaltlich das Falsche?
```

Warum automatisiert: dieselbe Runde von Hand ausgeführt fand zwei von drei kaputten Links,
übersah den dritten und meldete zwei funktionierende Sprungmarken als tot — GitHub macht aus
*jedem* Leerzeichen einen Bindestrich, „Security & privacy" wird also `security--privacy` mit
zweien. Genau die Art Fehler, die ein Skript nicht macht.

---

## Auswahl und Stoppregel

**Immer:** Runde 2 und Runde 6. Beide sind billig und hatten hier die höchste Trefferquote
pro Aufwand.

**Dazu je nach Release genau eine weitere:**

- berührt reine Funktionen, Parser oder Normalisierung → **Runde 1**
- berührt die Sicherheitsoberfläche → **Runde 3**
- es gab Fix-Commits → **Runde 4**
- eine Zusage ist nur gegen Fakes belegt → **Runde 5**

**Aufhören, wenn** die Funde im Schweregrad sinken, an verschiedenen Stellen liegen und die
Fixes lokal blieben.

**Nicht weiterprüfen, sondern umbauen, wenn** eine dritte Runde weiterhin Schwerwiegendes
im *selben* Bereich findet, oder wenn eine Fix-Runde erneut Regressionen einbaut. Beides
heißt: das Problem ist der Entwurf, und weitere Runden verschieben nur den Zeitpunkt, an
dem das auffällt.

## Was die Runden nicht leisten

Keine Prüfrunde ersetzt die Architektur. Was das Risiko eines übersehenen Fehlers
tatsächlich begrenzt, sind die harten Design-Regeln: kein Send-Tool (im `read`-Tier zusätzlich
von Google erzwungen, sonst von der Tool-Oberfläche — s. Invariante 1), kein Hard-Delete,
Tier-Gating, der Smoke-Test vor dem irreversiblen `npm publish` — und dass ein Patch in Minuten
veröffentlicht ist. Die Prüfrunden sind für den Rest.

## Nachtrag zur Trefferquote (13.08.2026)

Die falsche Scope-Zusage stand in **sechs** Dateien und wurde in zwei Anläufen gefunden: die
englischen Nutzer-Docs zuerst, die internen (`CLAUDE.md`, dieses Dokument) erst in der Runde
danach. **Lehre für Runde 2: die Aussage suchen, nicht die Formulierung.** Der erste Grep lief
auf „cannot send"/„scope.*send" und verfehlte deshalb `docs/SETUP.md` („neither grants a send
capability") und alles Deutschsprachige. Ein Dokument, das Prüfrunden steuert, verdient dabei
Vorrang — von dort reproduziert sich ein Fehler in jede spätere Runde.

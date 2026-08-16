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

## Nachtrag zur Trefferquote (15.08.2026, Release 0.10.0)

Vier Runden, Ausbeute wieder ungleich: Runde 1 (Korpus über `signals.ts`) **22 falsche Verdikte**,
alle reproduziert, darunter eine Evasion; Runde 2 **19 Formulierungen**, keine gebrochene Zusage;
Runde 6 8 Kleinigkeiten (toter Anker in `docs/SETUP.md`, 404-`$schema`, Testzahl); Runde 4 auf den
Fix-Commits **4 Funde, einer an der Ursache**: der Runde-1-Fix hatte den beobachteten Fall
(`"<a@evil>" <a@x>` im Rohheader) geschlossen, nicht die Ursache — `From` wurde RFC-2047-*dekodiert*,
bevor `parseSender` die Struktur las, und ein Encoded-Word, das zu `<legit@news.example>,` dekodiert,
kaperte den Sender-Key eines Newsletters (seit 0.9.0). Dazu zwei Regressionen desselben Fixes
(quadratische Laufzeit, verlorener Anzeigename). **Lehre: schreibt ein Runde-1-Fix einen geteilten
Helfer neu (hier `parseSender` mit drei Aufrufern), ist Runde 4 nicht optional — und die Frage „Ursache
oder Fall?" ist dort die ertragreichste.** Zweite Lehre: was ein Skript verifiziert, muss es auch beim
Release-Lauf verifizieren — der Publish-Workflow legte eine Datei in den Baum, die der Dirty-Check des
Bundle-Builds mitzählte; erst der Release-Lauf zeigte es.

## Nachtrag (15.08.2026): die Runde, die keine ist — Behauptungen über fremdes Verhalten

Alle Runden hier prüfen **unseren** Code und **unsere** Doku gegeneinander. Keine prüft den Satz, der
das Ganze *begründet* — eine Aussage darüber, wie sich **Gmail** verhält. Genau dort saß acht Wochen
lang ein Fehler: „Gmails Index verwirft `is:unread` in manchen Operator-Kombinationen" entstand als
Beobachtung in einer Commit-Message (`cec77aa`) und stand danach in README, SECURITY.md, den
Code-Kommentaren und auf der Website. Gemessen hatte es niemand. Die Messung (Thread 110) bestätigte
das **Symptom** und widerlegte die **Erklärung**: das Prädikat wird angewandt, nur gegen veralteten
Read-State, und es hängt nicht an Operator-Kombinationen.

**Die Regel, die daraus folgt:** eine Behauptung über ein fremdes System braucht dieselbe Beweislast
wie Code — eine Messung oder einen Beleg, sonst wird sie zitiert („beobachtet am …") statt behauptet.
Der billigste Test ist fast immer die **Kontrollabfrage**: dieselbe Anfrage ohne das verdächtige
Element. 800+ gegen 131 hätte im Juni zwanzig Minuten gekostet und die falsche Mechanik sofort
erledigt.

**Und die Falle beim Reparieren, an einem Abend dreimal zugeschnappt:** beim Korrigieren einer
ungeprüften Behauptung entsteht leicht die nächste. Die erste Korrektur verallgemeinerte auf „betrifft
`is:unread` allgemein" (ein zweites Postfach zeigte 0 % Drift); die zweite behauptete „größter Effekt
auf der simpelsten Query" (stimmt absolut, in Prozent umgedreht); die Website-Session schrieb beim
Korrigieren „the check is unconditional" neu hinein (wahr für `search`, falsch für die Bulk-Tools).
Jede dieser drei fand jemand **anderes**. Wer eine Aussage zurücknimmt, prüft den Ersatz mit demselben
Maß — am besten, indem eine zweite Instanz gegen die Rohdaten liest, nicht gegen den neuen Text.

## Nachtrag zur Trefferquote (16.08.2026, Release 0.11.0)

Drei Fehler, drei verschiedene Finder — und **keiner** davon war älter als ein paar Stunden. Alle
drei entstanden beim *Korrigieren* von etwas anderem, was diesen Zyklus zum Musterfall der Regel
oben macht.

- **Runde 2 (Doku gegen Code) fand eine Hochrechnung über eine Endpunktgrenze.** Die frisch
  geschriebene Warnung an `bulk_modify` bezifferte das Risiko mit Zahlen, die auf `threads.list`
  gemessen waren — `bulk_modify` fragt aber `messages.list`. Nachgemessen statt argumentiert,
  gleiches Postfach, gleiche Minute: `threads.list` 132 Treffer / 114 ohne eine ungelesene
  Nachricht, `messages.list` 19 / 0. Die Drift sitzt im **Thread**-Index. **Lehre: eine Zahl, die
  von Endpunkt A stammt und über Endpunkt B redet, ist eine Vermutung — und der Messaufwand war
  hier ein einziger Skriptlauf.**
- **Runde 4 (Fix-Commits) fand eine mitgeänderte Fehlerlage.** Die Auth-Härtung ließ zwei
  Situationen gleich aussehen: „die Konten unterscheiden sich" und „ich konnte gar nicht prüfen"
  (Netzfehler, Gmail-API nicht aktiviert). Frage 1 der Runde — *was hat der Fix außer dem
  beabsichtigten Verhalten noch geändert?* — traf genau das.
- **Der Release-Lauf selbst fand den dritten, den keine Runde hätte finden können.** Der
  `postversion`-Check meldete **fälschlich OK**: er suchte die Version im Fließtext und fand sie in
  einer älteren eigenen Nachricht, die sie als *Beispiel* enthielt. Tag lokal zurückgenommen,
  Kriterium auf eine ausdrückliche Deklaration im Frontmatter umgestellt, der Fehlalarm als
  Testfall aufgenommen. **Zwei Lehren:** ein Prüfwerkzeug, das noch nie scharf gelaufen ist, ist
  ungeprüft — der erste echte Lauf gehört zum Test. Und: **ein falsches „ok" kostet den Schritt
  selbst, ein falsches „fehlt" nur einen zweiten Blick; im Zweifel die Variante bauen, die eher zu
  viel meldet.**

Formulierung der fremden Session, die das am kürzesten fasst und deshalb hier steht: *ein Marker,
den ein Dokument über sich selbst setzt, ist etwas anderes als ein Muster, das jemand im Text sucht.*

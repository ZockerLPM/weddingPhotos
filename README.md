# 📷 Hochzeits-Fotowand

Gäste machen Fotos mit dem eigenen Handy und laden sie ohne App und ohne
Login über den Browser hoch. Neue Fotos erscheinen Sekunden später auf der
**Fotowand** (Beamer/TV) mit einem Highlight-Effekt. Nach der Hochzeit wird
die **Galerie** freigeschaltet – ansehen, filtern, Originale herunterladen,
alles als ZIP.

## Die vier Seiten

| URL | Zweck | Wer |
|---|---|---|
| `/` | Foto-Upload und Foto-Aufgaben (QR-Code führt hierher) | alle Gäste |
| `/show` | Fotowand im Vollbild | TV-/Beamer-Rechner |
| `/box` | Erzählecke: Videobotschaften aufnehmen | Tablet in einer ruhigen Ecke |
| `/galerie` | Galerie mit Download – gesperrt bis zur Freischaltung | alle Gäste, nach dem Fest |
| `/mod#SCHLÜSSEL` | Moderation: ausblenden, Fotowand steuern, Rückblick, Galerie öffnen | Trauzeuge/in |
| `/sichten` | Sichten nach der Feier – Vollbild, Tastatur, Aussortieren | Brautpaar |
| `/buch` | Fotobuch: Vorschau, als PDF drucken, ZIP für Druckdienste | Brautpaar |

## Wie es funktioniert

**Zweistufiger Upload** – die zentrale Design-Entscheidung:

1. Der Browser des Gasts verkleinert das Foto sofort (Canvas, max. 1600 px,
   ~200–400 KB). Dieses kleine Bild wird zuerst hochgeladen → das Foto ist
   nach **2–4 Sekunden auf der Fotowand**, auch bei schlechtem Netz.
2. Das Original in voller Qualität lädt danach im Hintergrund hoch, mit
   automatischen Wiederholversuchen (IndexedDB-Warteschlange, übersteht
   Reload und Netzausfall).

Nebeneffekt: Weil das Anzeigebild im Browser entsteht, kommt beim Server
immer JPEG an – **HEIC/Bildformate sind serverseitig kein Thema**.

**Grosse Originale gehen in 8-MB-Stücken hoch.** Ein 400-MB-Video in einer
einzigen Anfrage scheitert zuverlässig – besonders auf dem iPhone: Multer
und Caddy haben Grenzen, das Gerät muss die Datei am Stück halten, und ein
Abbruch bei 90 % wirft alles weg. Stückweise sieht keine Schicht je mehr
als 8 MB, der Speicherbedarf bleibt klein, und ein Abbruch kostet höchstens
ein Stück. Unterhalb von 8 MB bleibt es bei einer einzelnen Anfrage – das
ist schneller und völlig unproblematisch.

Damit ist die Dateigrösse praktisch keine Grenze mehr. Was bleibt: Die Seite
muss offen bleiben, bis der Upload durch ist (Banner und Rückfrage weisen
darauf hin), denn bei sehr grossen Dateien liegt das Original nur im
Speicher dieser Sitzung.

**Live-Updates** laufen über Server-Sent Events (`/api/stream`). Jedes Event
hat eine fortlaufende ID; nach einem Verbindungsabbruch liefert der Server
alles Verpasste automatisch nach. Die Fotowand läuft bei Netzausfall aus
ihrem lokalen Pool weiter.

**Fotowand-Logik:** Neue Fotos kommen in eine Highlight-Warteschlange
(großes Bild, „Gerade eben von Anna", 12 s). Dazwischen läuft eine
Ambient-Rotation mit gewichtetem Zufall: Neues wird bevorzugt, oft
Gezeigtes tritt zurück. Gegen Wiederholungen sorgt ein **Ringpuffer**, dessen
Größe sich am Foto-Pool orientiert (`min(Pool − 1, 8)`) – dadurch bleibt der
Abstand auch bei einer kleinen Gesellschaft mit wenigen Fotos so groß wie
möglich. Bei unter 12 Fotos stehen Bilder 10 statt 7 Sekunden, was ruhiger
wirkt. Ken-Burns-Effekt und unscharfer Hintergrund für Hochformat inklusive.

## Die Abendfunktionen

**Foto-Aufgaben.** Acht Aufgaben stehen dauerhaft auf der Upload-Seite zum
Abhaken („Jemand, der gerade lacht", „Die Hände deines Tischnachbarn" …).
Aufgabe antippen, dann Foto wählen – die Zuordnung landet in der Datenbank
und erscheint auf der Fotowand unter dem Bild. Bei kleiner Gesellschaft
sorgen die Aufgaben vor allem dafür, dass überhaupt genug Material
zusammenkommt.

**Aufgaben ändern:** in der Moderation auf **🎯 Aufgaben bearbeiten**. Jede
Zeile hat ein Feld fürs Symbol und eines für den Text, dazu ✕ zum Entfernen
und **＋ Aufgabe** für eine neue. Speichern wirkt sofort auf allen offenen
Gästehandys (über den SSE-Kanal), ein Neuladen ist nicht nötig.
**↺ Standard** stellt die Ursprungsliste wieder her.

Umformulieren ist unbedenklich: Jede Aufgabe trägt intern eine unveränderliche
`id`, die beim Bearbeiten erhalten bleibt – bereits hochgeladene Fotos behalten
ihre Zuordnung. Die Standardliste steht in
[`server/challenges.js`](server/challenges.js), die aktive Liste in der
Einstellungstabelle der Datenbank.

**Namentliche Begrüssung.** Beim allerersten Beitrag eines Gastes blendet die
Fotowand groß „Schön, dass du da bist, Werner!" ein. Der Server erkennt das
selbst (`firstUpload` im SSE-Event) – nichts einzustellen.

**Mitternachts-Rückblick.** Über die Moderation auslösbar. Der Server stellt
aus `/api/recap` eine Auswahl zusammen: pro 15-Minuten-Fenster das
aussagekräftigste Foto (Gruß und Foto-Aufgabe zählen), danach wird ergänzt,
bis **jeder Gast mindestens einmal vorkommt** – bei einer kleinen Runde soll
niemand fehlen. Die Wand spielt das chronologisch mit Uhrzeit-Marke ab
(~6 s je Bild), zeigt dann die Auszeichnungen und endet mit einer Dankeskarte.
Danach läuft die normale Fotowand weiter. Dauer: etwa 4–6 Minuten.

**Auszeichnungen.** Werden aus der Datenbank berechnet und möglichst auf
verschiedene Gäste verteilt, damit in kleiner Runde fast jeder einen Titel
bekommt: 📸 Fleissigster Fotograf · 📼 Der Archivar · 🌅 Der frühe Vogel ·
🌙 Der Ausdauernde · 💬 Der Erzähler · 🎯 Der Aufgabenjäger ·
🎙️ Die Stimme des Abends.

**Woher der Zeitpunkt kommt.** Der Browser liest den Auslösezeitpunkt aus den
EXIF-Metadaten (`DateTimeOriginal`, bei Bedarf mit Zeitzone aus
`OffsetTimeOriginal`), bevor das Foto verkleinert wird – siehe
[`public/js/exif.js`](public/js/exif.js), ein kleiner eigener Parser ohne
Zusatzabhängigkeit. Das ist deutlich verlässlicher als das Dateidatum: Ein
über einen Messenger weitergeleitetes Bild trägt dort den Zeitpunkt des
Downloads, nicht der Aufnahme.

Reihenfolge der Quellen, gespeichert als `time_source`:

| Quelle | Bedeutung |
|---|---|
| `exif` | `DateTimeOriginal` – der Auslösezeitpunkt, der Normalfall |
| `exif-scan` | `DateTimeDigitized` – etwa bei eingescannten Bildern |
| `exif-datei` | `DateTime` aus IFD0 |
| `aufnahme` | direkt in der Erzählecke aufgenommen |
| `datei` | kein EXIF – Rückfall auf `lastModified`, unzuverlässig |

Videos und Bilder ohne EXIF (etwa HEIC oder PNG) fallen auf das Dateidatum
zurück. Bei einem Video, das am Fest aufgenommen wurde, stimmt das ohnehin.

**Mitgebrachte Altfotos.** Wer ein Kinderbild hochlädt, bringt ein
Aufnahmedatum von vor dreissig Jahren mit – das würde die Zeitachse des
Abends und die Auszeichnungen ruinieren („Der frühe Vogel" ginge an ein Foto
von 1995). Der Server erkennt das selbst: Liegt das Aufnahmedatum **mehr als
36 Stunden vor dem Upload** oder mehr als eine Stunde in der Zukunft (falsch
gestellte Handyuhr), gilt das Bild als *Altfoto*.

- Für Reihenfolge und Auszeichnungen zählt dann der **Uploadzeitpunkt**
  (`effective_at`), das echte Aufnahmedatum bleibt gespeichert
- Auf der Fotowand steht „📼 Von früher, mitgebracht von Oma"
- Im Rückblick eröffnen die Altfotos ein eigenes Kapitel **„Von früher"**,
  bevor der Abend chronologisch beginnt
- In der Galerie stehen sie unter **„📼 Mitgebracht von früher"** am Ende,
  mit ihrem echten Aufnahmedatum in der Detailansicht
- In der Moderation sind sie mit 📼 gekennzeichnet
- Sie zählen für den Titel **Der Archivar**, nicht für den fleissigsten Fotografen

Die Grenze steht als `ARCHIVE_BEFORE_MS` in `server/index.js`. Wer am
Vortag schon Fotos macht und erst am Fest hochlädt, bleibt innerhalb der
36 Stunden und wird normal einsortiert.

**Von Hand korrigieren.** Ohne Metadaten kann die Erkennung danebenliegen –
ein über WhatsApp weitergeleitetes Kinderbild trägt das Datum der
Weiterleitung. In der Moderation hat deshalb jede Kachel oben links einen
Schalter: 🕐 = Foto des Abends, 📼 = mitgebracht von früher. Antippen
schaltet um, ein Fingerzeig auf den Schalter zeigt Zeitpunkt und Herkunft.
Der Schalter ist ein eigenes Tippfeld, damit ein Fehlgriff nicht
versehentlich das Foto ausblendet.

Die Upload-Seite meldet dem Gast ebenfalls zurück, wenn sein Bild als
„📼 Foto von früher" eingestuft wurde.

**Erzählecke** (`/box`). Tablet oder Laptop in einer ruhigen Ecke. Namen
eintragen, aufnehmen (max. 90 s), anschauen, absenden – oder nochmal. Die
Aufnahme läuft durch dieselbe Warteschlange wie die Fotos: Standbild als
Vorschau, Video als Original. Auf der Fotowand erscheint nur eine dezente
Notiz („🎙️ Eine Botschaft von Werner"), **es wird kein Ton im Raum
abgespielt**. Angeschaut werden die Botschaften in der Galerie.
Braucht HTTPS – über `http://` verweigern Browser den Kamerazugriff.

## Kategorien

Trauung, Essen, Geschenke … – die Gäste filtern die Galerie damit. Verwaltet
wird die Liste in der Moderation unter **🗂️ Kategorien**: Symbol und Name
frei änderbar, Standardliste in [`server/kategorien.js`](server/kategorien.js).
Wie bei den Foto-Aufgaben trägt jede Kategorie eine unveränderliche `id`,
die beim Umbenennen erhalten bleibt – zugeordnete Fotos behalten also ihre
Kategorie.

**Zuordnen** geht auf zwei Wegen:

- **Ganzen Zeitraum** – der schnelle Weg. „Alles zwischen 14:00 und 15:30 ist
  die Trauung" ordnet Hunderte Fotos auf einmal zu.
- **Mehrere auswählen** – Knopf **☑️** in der Moderation, dann Kacheln
  antippen und unten die Kategorie setzen. Dieselbe Auswahl lässt sich auch
  auf einen Schlag ausblenden.

Beim Bau der Download-Pakete entsteht automatisch **ein Paket je belegter
Kategorie** – der häufigste Wunsch ist „alles von der Trauung", nicht alles
überhaupt.

## Die Galerie auf dem Handy

Die Galerie ist fürs Handy gebaut, nicht nur dafür angepasst:

- **Filterleiste** oben, waagrecht scrollbar, klebt beim Scrollen: Alle ·
  ★ Favoriten · je Kategorie mit Anzahl · Ohne Kategorie. Dazu ein
  Personenfilter.
- **„Alle" ist nach Kategorie geordnet** – Lieblingsbilder zuerst, dann
  Trauung, Essen, Torte … in der Reihenfolge, die in der Moderation
  festgelegt ist, danach „Weitere Aufnahmen" und „📼 Mitgebracht von
  früher". Das entspricht dem Ablauf des Tages und ist die Ordnung, in der
  man ein Fotoalbum durchblättert. Innerhalb einer Kategorie geht es
  chronologisch weiter. Ist ein Kategorie-Filter aktiv, wird stattdessen
  nach Tagen gruppiert – eine zweite Ebene wäre dort sinnlos.
- **📼 Von früher** steht als eigener Filter ganz am Ende der Leiste und in
  der Übersicht als letzter Abschnitt. Mitgebrachte Altfotos gehören nicht
  in den Ablauf des Tages, sind aber eine eigene kleine Sammlung.
- **Raster** mit drei Spalten und minimalen Abständen – auf dem Handy zählt
  jeder Pixel; ab 620 px Breite wird automatisch umgestellt.
- **Aktionsleiste unten**, weil dort der Daumen ist. Sie klebt am unteren
  Rand und respektiert die Gerätekante (`safe-area-inset`).
- **Vollbildansicht** mit Wischgesten: seitlich blättern, nach unten
  schliessen. Blätter-Pfeile liegen über dem Bild, unten stehen zwei klar
  beschriftete Knöpfe: **📲 In Fotos sichern** und **⬇️ 42 MB** – die
  Grösse steht am Knopf, man weiss also vorher, worauf man sich einlässt.
  Nachbarbilder werden vorgeladen, Videos laufen inline.
- **Mehrfachauswahl** per Knopf oder langem Drücken auf eine Kachel.
  „Alle" wählt die gerade gefilterte Ansicht.

### Begrüssung

Ganz oben steht ein kurzer Dank an die Gäste, darunter drei Zeilen, die
erklären, wie die Seite funktioniert. Text und Überschrift sind in der
Moderation unter **💛 Begrüssung** änderbar – es sind eure Worte, der
Standard ist nur ein Vorschlag. Änderungen erscheinen sofort, ohne
Neuladen.

### In die Fotos-App sichern

Der Knopf **📲 Sichern** übergibt die Dateien über die
Web-Share-Schnittstelle ans Betriebssystem; dort erscheint „In Fotos
sichern" bzw. „Bilder sichern". Das ist der einzige Weg, den ein Browser
dafür hat, und er funktioniert auf iOS und Android.

**Ein eigenes Album kann eine Webseite nicht anlegen.** Das entscheidet das
Betriebssystem – dafür bräuchte es eine echte App. Auf iOS landen die Bilder
in „Zuletzt", auf Android im Ordner der Downloads bzw. der Galerie. Wer die
Fotos gebündelt in einem Ordner haben will, lädt ein ZIP-Paket und entpackt
es; daraus wird auf Android ein eigenes Album.

**Videos bekommen eine Handy-Version.** Auf iOS führt der einzige Weg in die
Fotos-App über die Web-Share-Schnittstelle, und die verlangt die Datei
komplett im Speicher – bei 300 MB bricht das Telefon ab. Safaris eigenes
Teilen-Menü hilft nicht: Es bietet bei Videos nur „In Dateien sichern".

Also muss die Datei kleiner werden. In der Moderation erzeugt
**📱 Handy-Versionen** aus jedem grösseren Video eine zweite Fassung
(H.264, höchstens 1080p) – gut genug für die Fotos-App und klein genug fürs
Sichern in einem Zug. Das Original bleibt unangetastet und steckt weiter in
den ZIP-Paketen; die Galerie nimmt beim Sichern automatisch die kleinere
Fassung.

Nebeneffekt: Ein HEVC-Video vom iPhone spielt in Chrome oft gar nicht –
die Handy-Version tut es überall. Dafür braucht das Image **ffmpeg**
(steckt im Dockerfile); fehlt es, bleibt nur diese Funktion aus.
Schwellen über `MOBIL_AB_MB` (Standard 40), `MOBIL_HOEHE` (1080) und
`MOBIL_CRF` (26).

**Bilder gehen auf iOS immer direkt** – gedrückt halten, „Zu Fotos
hinzufügen", ohne Grössengrenze. Darauf weist die Vollbildansicht hin.

**Für den Rest gibt es den nativen Weg.** Die Web-Share-Schnittstelle
braucht die Datei komplett im Speicher – daran scheitert ein 300-MB-Video
auf dem Handy. Der eingebaute Weg des Geräts kennt diese Grenze **nicht**:

- **Video auf iOS:** öffnen → der Player startet → Teilen-Symbol →
  „Video sichern"
- **Bild auf iOS:** öffnen → gedrückt halten → „Zu Fotos hinzufügen"
- **Android:** herunterladen – die Galerie-App zeigt es meist automatisch

Ab 150 MB (und immer, wenn das Gerät ablehnt) blendet die Galerie deshalb
ein **Anleitungsblatt** mit genau diesen Schritten und zwei Knöpfen ein:
„Öffnen" und „In Dateien laden". Damit gibt es keine Grössenbeschränkung
mehr – nur einen Schritt mehr.

Im Vollbild steht bei grossen Dateien schon vorher ein Hinweis, damit
niemand erst in eine Absage läuft.

**Die Grösse wird vorher geprüft, nicht nachher.** Das war der Grund für die
Fehlermeldung bei grösseren Videos: Die Galerie lud erst die ganze Datei in
den Speicher und stellte danach fest, dass das Handy sie nicht sichern kann.
Jetzt steht die Dateigrösse im Datensatz (`original_bytes`), und die
Entscheidung fällt vor dem Laden:

| Fall | Was passiert |
|---|---|
| Einzelne Datei über **150 MB** | Anleitungsblatt mit dem nativen Weg – keine Grössengrenze |
| Auswahl über **150 MB** insgesamt | Bitte, weniger zu wählen oder das ZIP zu nehmen |
| mehr als **10 Dateien** | Bitte, weniger zu wählen |
| Gerät lehnt trotzdem ab | Anleitungsblatt statt Fehlermeldung |

Während des Ladens läuft ein Fortschritt in Prozent – bei 80 MB ist das der
Unterschied zwischen „hängt" und „läuft noch". Geladen wird nacheinander,
nicht gleichzeitig, damit der Speicher des Handys nicht unnötig belastet wird.

Wo Teilen gar nicht geht (die meisten Rechner-Browser), wird ohne Umweg
heruntergeladen.

### Downloads in der Galerie

| Weg | Wofür |
|---|---|
| **📦 Alles herunterladen** | ein grosser Knopf ganz oben – für alle, die einfach alles wollen (Rechner, Sicherungskopie) |
| **Fertige Pakete** unter ⬇️ Herunterladen | Alles, Fotos, Videos, je Kategorie – als vorbereitete Dateien, fortsetzbar |
| **Nur von einer Person** | im Fluge erzeugt, klein genug |
| **Auswahl als ZIP** | beliebige Zusammenstellung aus der Mehrfachauswahl |
| **📲 Sichern** | direkt in die Fotos-App des Handys |
| **Einzelbild** | Knopf ⬇️ in der Vollbildansicht |

Für die Auswahl legt die Galerie ihre Liste per POST ab und lädt mit der
zurückgegebenen Marke – eine lange Liste von IDs passt nicht zuverlässig in
eine URL, ein Download muss aber ein GET sein. Die Marke gilt zwei Stunden;
danach meldet der Server `410`, statt stillschweigend die ganze Galerie zu
liefern.

Persönliche Links: `/galerie?gast=Werner` und `/galerie?kategorie=trauung`.

**Aus der Galerie in die Moderation.** Wer den Moderations-Schlüssel im
Browser hat, sieht in der Vollbildansicht zusätzlich **✎ In der Moderation
öffnen**. Das führt auf `/mod?foto=<ID>`, wo die Kachel angesprungen und
hervorgehoben wird – ohne sie unter 871 anderen suchen zu müssen. Für alle
anderen Gäste bleibt der Verweis unsichtbar.

## Nach der Feier

In der Moderation unter **🧹 Nach der Feier**. Sinnvolle Reihenfolge:

**1. Backup ziehen.** Ausblenden ist umkehrbar, endgültiges Löschen nicht.

**2. Aussortieren – am besten unter [`/sichten`](public/sichten.html).**
Die Seite zeigt eine Aufnahme gross und ist auf die Tastatur hin gebaut:

| Taste | Wirkung |
|---|---|
| **→** (oder Leertaste) | behalten und weiter |
| **←** | zurück |
| **X** (oder Entf) | aussortieren und weiter |
| **F** | Favorit umschalten |
| **Z** | letzte Aktion rückgängig |
| **1–9** | Kategorie setzen · **0** = keine |

Mit Pfeiltaste und X kommt man durch 871 Aufnahmen in etwa zwanzig Minuten,
statt eine Stunde auf Kacheln zu zielen. Auf dem Handy geht es auch per
Wischen: nach links behalten, nach rechts zurück.

Dazu drei Dinge, die den Durchlauf angenehm machen:

- **Gesichtet-Merker** in der Datenbank (`reviewed`). Ihr könnt jederzeit
  abbrechen und später weitermachen – oben steht „noch 340 offen".
- **Filter**: noch nicht gesichtet · alle · nur Videos · nur Altfotos ·
  nur Favoriten · nur Aussortierte, dazu ein Personenfilter.
- **Vorladen** der nächsten drei Aufnahmen, sonst ruckelt das Blättern.

**Zwei können parallel sichten** – über den Ereigniskanal kommt an, was die
andere Seite gerade entschieden hat.

Jede Aktion ist genau eine Anfrage (`/api/mod/sichten`); bei 871 Fotos
summieren sich zwei Anfragen je Bild sonst spürbar.

**Alternativ in der Moderation:** Auf jeder Kachel liegt ein **★** für
Lieblingsbilder und der 🕐/📼-Schalter für die Einordnung; ein Tipp auf die
Kachel blendet aus. Zwei Helfer beschleunigen das zusätzlich:

- **🎞️ Serien finden** – Aufnahmen desselben Gasts innerhalb von zehn
  Sekunden werden gruppiert („4 Aufnahmen von Werner um 21:34, in 6 s").
  Grün umrandet bleibt, blass fliegt raus; antippen schaltet um, ein Knopf
  übernimmt die Gruppe. Zeitfenster: `SERIE_SEKUNDEN`.
- **🧬 Duplikate finden** – berechnet eine Prüfsumme über alle Originale und
  zeigt Gruppen mit **identischem Inhalt**. Nur exakte Treffer; ähnliche
  Bilder zu erraten würde am Ende echte Aufnahmen wegwerfen. Der erste
  Durchlauf liest alle Originale einmal und dauert Minuten, danach ist er
  sofort.

**3. 📱 Handy-Versionen** (nur wenn es Videos gibt). Rechnet im Hintergrund
kleinere Fassungen, damit sich Videos auf dem Telefon direkt in die Fotos-App
sichern lassen. Die Originale bleiben unangetastet.

**3b. 🎬 Originale nachreichen.** Videos über dem Upload-Limit kamen am Fest
nur als Vorschaubild an. Der Knopf listet alle Beiträge ohne Original mit
Vorschaubild, Name und Uhrzeit – Datei auswählen, fertig.

Die Datei geht in **8-MB-Stücken** hoch. Dadurch spielt die Grösse keine
Rolle mehr: Weder Multer noch Caddy sehen je mehr als ein Stück, und ein
Verbindungsabbruch kostet höchstens ein Stück statt der ganzen Datei. Ein
vorhandenes Original wird ersetzt, eine alte Datei mit anderer Endung
dabei entfernt.

Manche Aufnahmen bekommen nie ein Original – das Video ist verloren oder es
lohnt schlicht nicht. Dafür gibt es je Zeile **✕ keins**: Der Eintrag
verschwindet von der Liste, ohne ausgeblendet zu werden. Ohne diesen Weg
wüsste man nie, ob man fertig ist.

Taucht später doch eine Datei auf, holt **👁️ auch die abgehakten zeigen**
sie zurück auf die Liste – dort lässt sich das Original ganz normal
nachreichen oder die Entscheidung mit **↩ zurück** aufheben.

In der Galerie tragen Videos **ohne** Original kein Filmsymbol mehr. Es gibt
dort nur das Standbild zu sehen; ein Symbol verspräche etwas, das nicht kommt.

**Von Hand geht es auch** – praktisch, wenn die Dateien schon auf dem Server
liegen. Die passenden IDs nennt `check-data.cjs` unter „Ohne Original":

```bash
# Datei unter dem Namen {ID}-o.{endung} ablegen …
scp GROSS.MOV deploy@SERVER:/opt/hochzeit/app/data/photos/01M03PCYDD…-o.mov
# … und die Verknüpfung nachtragen lassen
docker compose exec -T -e DATA_DIR=/data -e REPAIR=1 app node < scripts/check-data.cjs
```

**4. Kategorien zuordnen** (siehe oben) – am schnellsten über Zeiträume.

**5. 📦 Downloads vorbereiten.** Zeigt zuerst eine **Vorschau**: welche
Pakete entstünden, mit Anzahl, Grösse und Gesamtsumme – dazu die Angabe, wie
viel Plattenplatz zusätzlich gebraucht wird. Wählbar ist, was gebaut wird
(kleine Version · Fotos · Videos · je Kategorie) und wie gross die Teile sein
sollen. Erst der Knopf **📦 Jetzt bauen** legt los.

Vorschau und Bau kommen aus derselben Beschreibung im Code – sonst zeigte die
Vorschau etwas anderes, als hinterher entsteht.

Erst bauen, wenn Aussortieren, Nachreichen und Zuordnen fertig sind – die
Pakete enthalten genau das, was dann sichtbar ist.

**5b. 📅 Datum korrigieren.** Aufnahmen ohne Metadaten erben das Dateidatum,
wiederhergestellte Einträge das ihrer Datei – dann steht dort schnell „heute"
statt des Hochzeitstags. Der Knopf zählt die Aufnahmen je Tag, hebt den
Hochzeitstag hervor und schiebt jeden anderen Tag mit einem Klick dorthin.

- **Uhrzeit bleibt erhalten** – ein Foto von 21:34 landet am Hochzeitstag um
  21:34, nicht mitten in der Nacht.
- Auf Wunsch verlieren die verschobenen Aufnahmen dabei das Kennzeichen
  „von früher".
- Verschoben wird `effective_at`, also das, wonach überall sortiert wird.
  Das ursprüngliche `taken_at` bleibt als Aufzeichnung dessen stehen, was
  in der Datei stand.

**6. Galerie öffnen.** Erst danach sehen die Gäste die Pakete.

**7. 🗑️ Ausgeblendete löschen** – wenn ihr sicher seid. Verlangt eine
Rückfrage und das Wort `LOESCHEN`, entfernt Einträge und Dateien
endgültig. Nur aus dem Backup wiederherstellbar.

### Warum die ZIPs vorab gebaut werden

Ein im Fluge erzeugtes ZIP hat keine bekannte Länge und lässt sich **nicht
fortsetzen**: Bricht die Verbindung bei 4 von 5 GB ab, fängt der Gast wieder
bei null an – auf dem Handy scheitert das praktisch immer.

Fertige Dateien liefert der Server dagegen mit Längenangabe und
Bereichsanfragen aus (`/d/…`, über `express.static`). Ein abgebrochener
Download setzt dort fort, wo er aufhörte. Zusätzlich sind die grossen
Pakete in Teile von 1,5 GB geschnitten (`ZIP_TEIL_MB`).

## Logs lesen

**Server-Log** (Docker, auf dem Server):

```bash
cd /opt/hochzeit/app
docker compose logs -f app              # laufend mitlesen
docker compose logs --tail=200 app      # die letzten 200 Zeilen
docker compose logs --since 2h app      # die letzten zwei Stunden
docker compose logs caddy               # TLS und Weiterleitung
```

Was dort steht:

| Zeile | Bedeutung |
|---|---|
| `[upload] 01M… photo Anna` | Beitrag angekommen, mit Art und Name |
| `[original] 01M… mov 84 MB` | Original nachgeliefert |
| `[Upload abgebrochen] …` | Handy im Standby, Netz weg – die Warteschlange sendet neu |
| `Datenbank ergänzt: …` | Migration beim Start |
| `Dateigrössen nachgetragen: …` | einmalige Nachrüstung |

Nur nach Uploads filtern:

```bash
docker compose logs app | grep -E '^[upload|^[original'
docker compose logs app | grep 'Upload abgebrochen' | wc -l
```

Die Logs sind auf **10 MB je Datei und 5 Dateien** begrenzt
(`logging` in `docker-compose.yml`) – ohne diese Begrenzung wachsen sie
unbegrenzt und können die Platte füllen.

**Verlauf in der Moderation** – 🧹 Nach der Feier → **📜 Verlauf**. Quelle
ist die Ereignistabelle der Datenbank, nicht das Docker-Log: Sie übersteht
Neustarts und wird nicht gedreht. Dort steht mit Zeitstempel, was hochgeladen,
ausgeblendet oder geändert wurde – der verlässlichere Rückblick auf den Abend.

**Was der Gast sieht:** Auf der Upload-Seite steht unter jedem Bild der
Stand („lädt 42 %", „✓✓ komplett gesichert", „⚠️ …"). Ein fehlgeschlagener
Upload lässt sich dort antippen und neu starten.

## Fotobuch

Unter [`/buch`](public/buch.html) entsteht aus der Galerie ein Buch – mit
Vorschau, die genau zeigt, was hinterher herauskommt. Zwei Ausgabewege, ein
gemeinsamer Bauplan:

**🖨️ Drucken / als PDF.** Der Browser macht aus der Seite über „Drucken →
Als PDF sichern" eine fertige Datei. Das Stylesheet setzt A4 quer, echte
Seitenumbrüche und blendet die Werkzeugleiste aus. Vor dem Drucken werden
alle Bilder nachgeladen – sonst blieben Lücken im PDF.

**📦 ZIP für Druckdienste.** Durchnummeriert nach Kapitel und Position
(`01_Trauung/01-003_Anna.jpg`), weil CEWE, Saal & Co. ihre Vorlagen in
Dateinamen-Reihenfolge befüllen. Originale, wo vorhanden, dazu ein
`00_Inhalt.txt` mit der Kapitelübersicht.

### Collagen statt Kontaktabzug

Immer vier gleich grosse Bilder je Seite sehen aus wie ein Kontaktabzug.
Unter **Gestaltung → Collage** wechseln die Seitenaufteilungen stattdessen
durch: ein grosses Bild neben zwei kleinen, ein ganzseitiges dazwischen,
ein Streifen aus drei Hochformaten, dann wieder ein ruhiger Vierer.
Neun Vorlagen stecken in [`server/buchvorlagen.js`](server/buchvorlagen.js).

Zwei Dinge machen das brauchbar statt zufällig:

* **Die Reihenfolge liegt fest**, sie wird nicht ausgewürfelt. Ein Buch soll
  bei jedem Aufschlagen gleich aussehen – und ein Zufallsgenerator stellt zu
  oft zwei fast gleiche Seiten nebeneinander. **Abwechslung** wählt, wie weit
  der Reigen ausholt: *ruhig* bleibt beim Vierer mit gelegentlich einem
  grossen Bild, *lebhaft* nutzt alle Vorlagen.
* **Hochformate landen auf hohen Plätzen, breite auf den grossen.** Jede
  Vorlage sagt je Platz, welche Bildform dorthin passt; beim Verteilen
  bekommt jeder geforderte Platz zuerst ein passendes Bild. Sonst würde ein
  Hochformat im breiten Heldenplatz auf einen Streifen zusammengeschnitten.

Beim Schneiden schaut der Server drei Vorlagen voraus und nimmt die, deren
Formen am besten zu den nächsten Bildern passen. Ganz am Ende eines Kapitels,
wo weniger übrig bleibt als jede Vorlage braucht, greift die grösste, die
noch passt.

**Gerechnet wird auf dem Server**, nicht im Browser: Vorschau, Ausdruck und
ZIP-Export kämen sonst mit drei verschiedenen Aufteilungen heraus. Die Seite
bekommt jede Buchseite fertig geschnitten geliefert – als CSS-Grid
(`grid-template-areas`) mit den Bildern in Platz-Reihenfolge.

Wer es gleichmässig mag, stellt **Gestaltung → Raster** ein; dann greift
wieder *Bilder je Seite*.

### Was sich einstellen lässt

| | |
|---|---|
| **Titel, Untertitel, Widmung** | erscheinen auf der ersten Seite |
| **Gestaltung** | Collage (wechselnde Aufteilungen) oder Raster |
| **Abwechslung** | ruhig, gemischt, lebhaft – nur bei Collage |
| **Bilder je Seite** | 1 (ganzseitig), 2, 4 oder 6 – nur beim Raster |
| **Bilder füllen ihren Platz** | beschneidet die Ränder; aus = alles zu sehen, weisse Ränder |
| **Höchstens je Kapitel** | 0 = alle |
| **Beschriftung** | Name und Uhrzeit unter den Bildern, oder Gruss |
| **Kapitel** | einzeln an- und abwählbar, in der Reihenfolge der Kategorien |
| **Lieblingsbilder / Von früher** | eigene Kapitel, zuschaltbar |

Aufbau: Titelseite → Lieblingsbilder → je Kategorie ein Trenner und die
Bildseiten → „Weitere Aufnahmen" → „Von früher". Jedes Foto erscheint genau
einmal; ein Lieblingsbild taucht in seiner Kategorie nicht noch einmal auf.

**Beim Kürzen wird gleichmässig ausgedünnt**, nicht vorne abgeschnitten. Ein
Kapitel auf 24 Bilder zu bringen, indem man die ersten 24 nimmt, erzählt nur
den Anfang – über den ganzen Zeitraum verteilt bleibt der Verlauf erhalten.

Jede Änderung wirkt sofort auf die Vorschau; gespeichert wird erst mit
**Einstellungen merken** – und dann nimmt auch der ZIP-Export sie.

> Für die Bildseiten werden die Anzeigebilder mit 1600 px verwendet. Bei
> 2 bis 6 Bildern je Seite reicht das für 300 dpi bequem; nur ganzseitig
> und auf den grossen Collagen-Plätzen ist es knapp. Der ZIP-Export nimmt
> dafür die Originale.

## Bestand prüfen

Wenn im `data`-Ordner mehr zu liegen scheint, als in Fotowand und Galerie
auftaucht: Es liegen **pro Foto bis zu drei Dateien** dort (`-d.jpg`
Anzeigebild, `-t.jpg` Vorschau, `-o.*` Original). Die reine Dateizahl ist
also normalerweise etwa dreimal so hoch wie die Zahl der Fotos.

Für eine echte Prüfung gibt es [`scripts/check-data.cjs`](scripts/check-data.cjs):

```bash
# auf dem Server, im Container
cd /opt/hochzeit/app
docker compose exec -T -e DATA_DIR=/data app node < scripts/check-data.cjs
```

Der Bericht zeigt Einträge, Dateien und vor allem die Auffälligkeiten:
Dateien ohne Datenbankeintrag (unsichtbar), nicht verknüpfte Originale,
Einträge ohne Bild, Reste abgebrochener Uploads. Gefundene Probleme
beheben:

```bash
docker compose exec -T -e DATA_DIR=/data -e REPAIR=1   -e ADOPT_NAME="Wiedergefunden" app node < scripts/check-data.cjs
```

REPAIR verknüpft herumliegende Originale wieder, nimmt verwaiste Bilder als
Fotos auf (unter dem Namen aus `ADOPT_NAME`), entfernt tote
Original-Verweise und räumt `tmp/` auf. Danach in der Moderation
**Fotowand neu laden** drücken.

Dasselbe geht auch lokal gegen einen Backup-Ordner:

```bash
DATA_DIR=~/hochzeit-backup node scripts/check-data.cjs
```

## Tests

```bash
npm test
```

Startet für jede Suite einen eigenen Server mit temporärem Datenverzeichnis
und prüft 334 Punkte: den EXIF-Parser (gegen selbst gebaute JPEGs mit
bekannten Metadaten), Grundfunktionen (Upload, Moderation, Galerie, ZIP,
Fehlerfälle), die Upload-Warteschlange inklusive nachgebautem iOS-Verhalten,
die Abendfunktionen, Altfoto-Erkennung und Aufgaben-Editor sowie die
Übereinstimmung von Datenbank und Dateien, die gesamte Nachbereitung –
Serien, Duplikate, Favoriten, Paketbau, fortsetzbare Downloads und
endgültiges Löschen –, das stückweise Nachreichen grosser Originale sowie
Kategorien, Auswahl-Downloads, die Sichtungs-Seite, den stückweisen Upload
grosser Videos, Dateigrössen, Begrüssung und Altfoto-Filter der Galerie
sowie den Verlauf, Handy-Versionen, „kein Original", die Paket-Vorschau, die
Datumskorrektur und das Fotobuch. Vor jedem Deploy einmal laufen lassen.

## Projektstruktur

```
server/           Node.js-Backend (Express, SQLite, SSE)
  index.js        Routen: Upload, Feed, Stream, Moderation, Rückblick, ZIP, Health
  challenges.js   Standard-Aufgaben und Prüfung der bearbeiteten Liste
  kategorien.js   Standard-Kategorien und Prüfung der bearbeiteten Liste
  nachbereitung.js Serien, Duplikate, Download-Pakete, endgültiges Löschen
  videos.js       Handy-Versionen der Videos (ffmpeg)
  buch.js         Bauplan des Fotobuchs und ZIP-Export
  buchvorlagen.js Seitenvorlagen für die Collagen
  db.js           SQLite-Schema, Migrationen und Zugriffe (better-sqlite3, WAL)
  sse.js          Event-Verteiler mit Nachhol-Logik
  ulid.js         Zeitlich sortierbare Foto-IDs
public/           Frontend, reines HTML/CSS/JS ohne Build-Schritt
  index.html      Upload + Foto-Aufgaben  + js/upload.js, js/queue.js
  show.html       Fotowand + Rückblick    + js/show.js
  box.html        Erzählecke              + js/box.js
  galerie.html    Galerie (handy-zuerst)  + js/gallery.js
  sichten.html    Sichten mit Tastatur    + js/sichten.js
  buch.html       Fotobuch, druckfertig   + js/buch.js
  mod.html        Moderation              + js/mod.js
  js/challenges.js  lädt die Aufgabenliste vom Server, von mehreren Seiten genutzt
  js/exif.js        liest den Aufnahmezeitpunkt aus den Bild-Metadaten
scripts/
  backup-pull.sh  Backup von zuhause holen (WSL/Linux/macOS)
  backup-pull.ps1 dasselbe nativ unter Windows, ohne WSL
  check-data.cjs  Datenbank gegen die Dateien prüfen und reparieren
  test/           Testsuiten (npm test)
data/             entsteht zur Laufzeit: app.db + photos/ + downloads/ (nicht im Git)
```

Das Datenbankschema wird beim Start automatisch nachgezogen (`ensureColumn`
in `db.js`) – ein Update auf einer bestehenden Installation braucht keine
Handarbeit, vorhandene Fotos bleiben erhalten.

Gespeicherte Dateien pro Foto: `photos/{id}-d.jpg` (Anzeige),
`{id}-t.jpg` (Thumbnail), `{id}-o.{ext}` (Original, sobald hochgeladen).

## Konfiguration

`.env` (Vorlage: `.env.example`):

| Variable | Bedeutung |
|---|---|
| `DOMAIN` | Deine Domain, z. B. `fotos.example.ch` – A-Record muss auf den Server zeigen |
| `MOD_KEY` | Geheimer Schlüssel für Moderation. Erzeugen: `openssl rand -hex 16` |
| `TZ` | Zeitzone, Standard `Europe/Zurich` |

Ohne gesetzten `MOD_KEY` startet der Server absichtlich nicht.

## Lokal ausprobieren (Windows)

```powershell
npm install
$env:MOD_KEY = 'test'
npm start
```

Dann: <http://localhost:3000> (Upload), `/show`, `/mod#test`, `/galerie`.
Die Daten landen in `./data/`. Tipp: Handy im selben WLAN über
`http://<PC-IP>:3000` testen – Achtung, ohne HTTPS gibt es keinen Service
Worker, der Upload selbst funktioniert aber.

## Installation auf dem VPS

Voraussetzungen (durch die Cloud-Config beim Server-Anlegen bereits erfüllt):

- Ubuntu 24.04, Docker + Compose installiert, Benutzer `deploy`
- Hetzner-Firewall: TCP 22, 80, 443 (+ UDP 443) offen
- DNS: **A-Record** `fotos.example.ch → Server-IPv4`
  (optional AAAA → IPv6). Vorher prüfen: `nslookup fotos.example.ch`

### 1. Code auf den Server bringen

**Variante A – über GitHub (empfohlen, macht Updates leicht):**

```bash
# Lokal (einmalig): privates Repo anlegen und pushen
git remote add origin git@github.com:DEIN-NAME/weddingPhotos.git
git push -u origin main

# Auf dem Server:
ssh hochzeit
git clone https://github.com/DEIN-NAME/weddingPhotos.git /opt/hochzeit/app
```

**Variante B – direkt kopieren (PowerShell, ohne GitHub):**

```powershell
scp -i $env:USERPROFILE\.ssh\hochzeit -r `
  server public package.json Dockerfile docker-compose.yml Caddyfile .env.example .dockerignore `
  deploy@SERVER-IP:/opt/hochzeit/app/
```

### 2. Konfigurieren

```bash
cd /opt/hochzeit/app
cp .env.example .env
openssl rand -hex 16          # Ausgabe als MOD_KEY eintragen
nano .env                     # DOMAIN und MOD_KEY setzen
```

### 3. Starten

```bash
docker compose up -d --build
docker compose logs -f        # Caddy holt das TLS-Zertifikat automatisch
```

### 4. Prüfen

```bash
curl -s localhost:3000/api/health   # {"ok":true,...}
```

Im Browser: `https://fotos.example.ch` → Upload-Seite. Ein Testfoto
hochladen, `/show` daneben öffnen – es muss binnen Sekunden erscheinen.

`restart: unless-stopped` sorgt dafür, dass nach einem Server-Reboot alles
von selbst wieder hochkommt.

### Updates einspielen

```bash
cd /opt/hochzeit/app
git pull                      # bzw. erneut per scp kopieren
docker compose up -d --build
```

Danach in der Moderation „Fotowand neu laden" drücken, damit der
Beamer-Browser den neuen Stand zieht.

## Bedienung

### Fotowand einrichten (Beamer/TV)

Laptop per HDMI, Browser im Kiosk-Modus:

```bash
# Linux/Raspberry Pi
chromium-browser --kiosk --noerrdialogs --disable-infobars https://fotos.example.ch/show
```

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk https://fotos.example.ch/show
```

Ohne Kiosk-Modus: Seite öffnen und **Doppelklick** → Vollbild.
Die Seite hält den Bildschirm per Wake Lock wach – zusätzlich im
Betriebssystem den Ruhezustand deaktivieren (Windows: Energieoptionen;
Pi: `xset s off -dpms`).

### Moderation

Auf dem Handy der zuständigen Person **einmal**
`https://fotos.example.ch/mod#DEIN_MOD_KEY` öffnen – der Schlüssel wird
gespeichert und aus der URL entfernt. Funktionen:

- **Foto antippen** → sofort von Fotowand und Galerie ausgeblendet
  (nichts wird gelöscht; nochmal antippen macht es rückgängig)
- **Pause** → Fotowand friert ein (für Reden). **Weiter** → läuft weiter
- **Ruhe-Modus** → keine Highlight-Unterbrechungen, Rotation läuft ruhig weiter
- **Rückblick starten** → Mitternachts-Rückblick mit Auszeichnungen (4–6 min)
- **Galerie öffnen/schliessen** → schaltet `/galerie` für alle frei
- **Fotowand neu laden** → nach einem Update

### Galerie freischalten

Nach dem Fest in der Moderation „Galerie öffnen", dann den Link
`https://fotos.example.ch/galerie` an alle Gäste schicken.
ZIP-Download vorher testen: `/api/gallery/zip?key=DEIN_MOD_KEY`
funktioniert auch bei geschlossener Galerie.

### QR-Codes für die Tischkarten

Zwei Codes nebeneinander drucken (z. B. mit einem beliebigen QR-Generator):

1. **WLAN** (falls eigenes WLAN): Inhalt `WIFI:T:WPA;S:NetzName;P:passwort;;`
2. **Upload-Seite**: Inhalt `https://fotos.example.ch`

Darunter die URL in Klartext für Geräte, bei denen der Scan hakt.

## Backup

Drei Ebenen, von automatisch bis manuell:

1. **Hetzner-Backups** (beim Server aktiviert): tägliche Snapshots des
   ganzen Servers. Wiederherstellung über die Hetzner-Konsole.
2. **Pull von zuhause** – wichtigste Ebene, weil unabhängig von Hetzner.
   Zwei Wege, beide holen dasselbe:

   ```powershell
   # Windows, ohne WSL – braucht nur den mitgelieferten OpenSSH-Client
   .scriptsackup-pull.ps1 -Server deploy@SERVER-IP -Dest C:hochzeitBackup
   ```

   ```bash
   # WSL, Linux oder macOS
   SSH_KEY=~/.ssh/hochzeit ./scripts/backup-pull.sh deploy@SERVER-IP ~/hochzeit-backup
   ```

   Beide Skripte erzeugen zuerst einen **konsistenten Datenbank-Schnappschuss**
   auf dem Server (`VACUUM INTO`) und holen dann die Dateien. Ein einfaches
   Kopieren der laufenden `app.db` könnte im WAL-Modus einen halben
   Schreibvorgang erwischen.

   Die Dateien kommen über **eine einzige SSH-Verbindung** als tar-Datenstrom.
   Das ist schnell und – wichtiger – es fragt die Passphrase höchstens zweimal
   statt einmal pro Übertragungsblock.

   ### Passphrase nur einmal eingeben

   Ohne geladenen Schlüssel fragt jeder Verbindungsaufbau erneut. Einmalig
   einrichten, dann ist Ruhe:

   ```powershell
   # PowerShell als Administrator – nur einmal pro Rechner
   Set-Service ssh-agent -StartupType Automatic
   Start-Service ssh-agent
   ```

   ```powershell
   # normale PowerShell – Passphrase einmal eingeben
   ssh-add $env:USERPROFILE.sshhochzeit
   ```

   Unter WSL/Linux entsprechend `eval $(ssh-agent -s) && ssh-add ~/.ssh/hochzeit`
   (gilt dort pro Terminal-Sitzung).

   Am Hochzeitsabend und am Tag danach je einmal ausführen.

   > **Windows-Laufwerk unter WSL:** Sichert man nach `/mnt/c/...`, scheitert
   > `rsync -a` mit `mkstemp ... failed: Operation not permitted (1)`. Das
   > Windows-Dateisystem lässt die Rechte- und Eigentümer-Operationen nicht zu,
   > die `-a` mitbringt. Das Skript arbeitet deshalb mit
   > `--no-perms --no-owner --no-group --omit-dir-times --inplace` –
   > `--inplace` vermeidet die temporären Dateien, an denen `mkstemp`
   > scheitert. Wer lieber gar nicht über WSL geht, nimmt die
   > PowerShell-Variante.
3. **Nach dem Fest**: `data/`-Ordner zusätzlich auf eine externe Platte
   kopieren (3-2-1-Regel). Erst dann den Server kündigen.

**Wiederherstellung** auf einem frischen Server: Repo klonen, `.env`
anlegen, gesichertes `data/` nach `/opt/hochzeit/app/data/` kopieren,
`docker compose up -d --build` – fertig.

## Checkliste vor dem Fest

- [ ] `npm test` läuft grün
- [ ] **Generalprobe ~2 Wochen vorher** in der Location: echte Handys
      (mind. 1 iPhone, 1 Android), Upload + Fotowand + Moderation testen
- [ ] Rückblick einmal komplett durchlaufen lassen (dauert 4–6 min)
- [ ] Erzählecke: Kamera- und Mikrofonfreigabe auf dem Tablet erteilt,
      Netzstecker dran, eine Probeaufnahme gemacht
- [ ] Mobilfunk-Empfang aller grossen Netze in der Location messen
      (Upload-Speedtest, nicht nur Balken)
- [ ] Beamer-Rechner: Kiosk-Autostart, Ruhezustand aus, Ton aus
- [ ] Moderations-Handy eingerichtet (nicht deins – du heiratest)
- [ ] QR-Codes gedruckt und an den Tischen verteilt
- [ ] `watch df -h` einmal anschauen: genug Platz? (`/api/health` zeigt es auch)
- [ ] Externes Monitoring auf `https://fotos.example.ch/api/health`
      (z. B. UptimeRobot, kostenlos, alle 5 min)
- [ ] Backup-Pull einmal komplett durchgespielt
- [ ] Zettel mit WLAN-Daten, URL und „Bei Problemen: X fragen" ausgedruckt

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| `docker compose logs app` zeigt „MOD_KEY fehlt" | `.env` nicht angelegt oder Platzhalter nicht ersetzt |
| Kein TLS-Zertifikat | DNS zeigt noch nicht auf den Server (`nslookup`), oder Port 80 zu. `docker compose logs caddy` |
| Weniger Fotos sichtbar als Dateien im data-Ordner | Erstens liegen pro Foto bis zu drei Dateien dort. Zweitens gab es einen Fehler, der Dateien ohne Datenbankeintrag hinterlassen konnte – behoben. Bestand mit `scripts/check-data.cjs` prüfen und reparieren |
| Moderation zeigt nicht alle Fotos | Behoben. Die Liste war auf 300 begrenzt, die Seite forderte 500 an. Jetzt 2000, und eine Kürzung wird als „⚠️ Nicht angezeigt" gemeldet |
| Grosses Video kommt nicht an | Die Seite muss offen bleiben, bis der Upload durch ist – ein Banner und eine Rückfrage beim Schliessen weisen jetzt darauf hin. Der Fortschritt steht in der Liste |
| Video wird nicht hochgeladen | Behoben. Bisher scheiterte der ganze Upload, wenn sich kein Standbild aus dem Video gewinnen liess. Jetzt gibt es einen Platzhalter, das Video geht in jedem Fall hoch |
| Video zeigt eine schwarze Kachel mit 🎬 | Der Browser konnte kein Standbild gewinnen (oft HEVC vom iPhone in Chrome). Das Video selbst ist vollständig gespeichert |
| Video kam nur als Vorschaubild an | Behoben: Originale gehen jetzt auch beim Gäste-Upload in 8-MB-Stücken hoch. Altbestand über **🧹 Nach der Feier → 🎬 Originale nachreichen** ergänzen |
| Abgehakte Einträge sind nicht mehr erreichbar | Behoben. War alles abgehakt, blieb die Liste leer – und der Umschalter wurde gar nicht erst gezeichnet. Er erscheint jetzt immer, sobald es abgehakte gibt |
| Aufnahmen tragen das Datum von heute | **📅 Datum korrigieren** in der Moderation – zählt die Tage und schiebt jeden falschen auf den Hochzeitstag, unter Beibehaltung der Uhrzeit |
| Fehler beim Sichern grosser Videos in die Fotos-App | In der Moderation **📱 Handy-Versionen** erzeugen – danach nimmt die Galerie beim Sichern automatisch die kleinere Fassung |
| `ffmpeg ist nicht installiert` | Image neu bauen: `docker compose up -d --build`. Ohne ffmpeg bleibt nur diese eine Funktion aus |
| Video lässt sich in der Galerie nicht abspielen | `.mov` mit HEVC spielt Safari, Chrome oft nicht. Die Datei ist in Ordnung – über den Download-Knopf lokal öffnen |
| `mkstemp ... Operation not permitted` beim Backup | Ziel liegt auf einem Windows-Laufwerk unter WSL. Aktuelles `backup-pull.sh` verwenden oder auf `backup-pull.ps1` wechseln |
| Backup: `bash: syntax error near unexpected token '('` | Behoben. PowerShell entfernte beim Aufruf nativer Programme die inneren Anführungszeichen, dadurch kam `node -e eval(...)` ohne Quotes auf dem Server an. Das Skript schickt das Snippet jetzt über stdin an `node` |
| Backup fragt ständig nach der Passphrase | Schlüssel in den ssh-agent legen, siehe oben. Ohne Agent fragt jede Verbindung neu |
| `scp: Connection closed` mitten im Backup | War die Folge vieler Einzelverbindungen. Das Skript nutzt jetzt eine Verbindung; danach nochmal starten, es holt nur das Fehlende |
| Upload bricht mit 413 ab | Datei > 512 MB. Limit in `server/index.js` (`upOriginal`) erhöhen – `Caddyfile` (`max_size`) muss **grösser** bleiben als dieser Wert |
| Log: `[Upload abgebrochen] …` | Normal, kein Fehler: Handy ging in Standby, Netz weg oder Tab geschlossen. Die Warteschlange im Browser sendet automatisch neu. Erst wenn es dauerhaft dieselbe Datei trifft, ist die Datei selbst das Problem |
| Log: `Unexpected end of form` mit Stacktrace | Alte Version – ab dem Fix wird daraus die kompakte Zeile oben. `docker compose up -d --build` |
| Fotos erscheinen nicht live auf `/show` | `docker compose logs caddy` – SSE braucht `flush_interval -1` (ist konfiguriert). Browser-Konsole auf `/show` prüfen |
| „wartet auf Netz" hängt ewig | Handy hat Captive-Portal-WLAN ohne Internet → Mobilfunk nutzen. Seite offen lassen, Queue sendet automatisch nach |
| HEIC-Foto schlägt auf Android fehl | Android-Chrome kann HEIC nicht dekodieren (iPhone-Fotos via Messenger). Betroffene Gäste: Foto stattdessen aus der Kamera-App teilen |
| iPhone bleibt bei „Original folgt …", Log zeigt `laenge=0` | Behoben. iOS Safari konnte die `File`-Referenz nicht aus IndexedDB zurückgeben. Die Warteschlange materialisiert die Bytes jetzt vor dem Speichern (`MATERIALIZE_MAX` in `queue.js`) |
| Erzählecke zeigt „Kamera nicht verfügbar" | Seite muss über **HTTPS** laufen (`localhost` ist ausgenommen). Sonst: Kamerafreigabe im Browser erteilt? Nutzt eine andere App gerade die Kamera? |
| Altfoto wurde fälschlich als Abendfoto einsortiert | Die Datei hat kein EXIF (typisch nach dem Weiterleiten über einen Messenger). In der Moderation über den Schalter 🕐 → 📼 korrigieren |
| Abendfoto landet unter „von früher" | Die Uhr des Handys geht falsch, oder das EXIF fehlt. In der Moderation über den Schalter 📼 → 🕐 korrigieren |
| Zeitpunkt eines Fotos wirkt falsch | In der Moderation auf den Schalter der Kachel zeigen – dort stehen Zeitpunkt und Herkunft (`exif` vs. `datei`) |
| Rückblick zeigt nur wenige Fotos | Normal bei wenigen Uploads – gewählt wird eines je 15-Minuten-Fenster plus je ein Foto pro Gast. Fenstergrösse: `BUCKET` in `buildRecap` (`server/index.js`) |
| Fotowand wiederholt sich trotzdem | Passiert nur, wenn insgesamt sehr wenige Fotos da sind – der Ringpuffer kann nicht mehr Abstand schaffen als Bilder vorhanden sind |
| Platte läuft voll | `df -h`; Volume in Hetzner-Konsole anhängen, in compose als zusätzlichen Mount für `./data` nutzen |
| Galerie-ZIP bricht ab | Bei sehr grossen Sammlungen Browser-Download-Timeout – einzelne Tage/Gäste laden oder ZIP per `curl -O` ziehen |

## Bewusste Grenzen

- **Kein Login für Gäste** – Schutz besteht darin, dass die URL nur den
  Gästen bekannt ist (`noindex` ist gesetzt). Für eine Hochzeit angemessen.
- **„Galerie geschlossen" ist weich**: Die Foto-Metadaten sind per API
  lesbar, der ZIP-Download ist hart gesperrt. Wer das Datum der API-Routen
  kennt und JS liest, könnte einzelne Bild-URLs erraten – reale Gefahr: gering.
- **Videos > 300 MB** werden nicht mit hochgeladen (nur Vorschaubild),
  Videos > 512 MB serverseitig abgelehnt.
- **Ausblenden statt Löschen**: Moderation versteckt Dateien, löscht sie
  nicht. Endgültiges Löschen: Datei aus `data/photos/` entfernen und
  Zeile aus der DB löschen (oder einfach versteckt lassen).
- **Keine Rate-Limits** – bei einer geschlossenen Gästerunde unnötig.

## Kosten (zur Erinnerung)

Hetzner CX22 + IPv4 + Backups ≈ **5 €/Monat**, stundengenau abgerechnet.
Nach dem Fest und dem letzten Backup: Server löschen, Kosten stoppen.

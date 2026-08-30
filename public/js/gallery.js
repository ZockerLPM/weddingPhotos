/* Galerie – auf das Handy hin gebaut.
 *
 * Filterleiste nach Kategorien, Raster, Vollbildansicht mit Wischgesten,
 * Mehrfachauswahl und Downloads. Die Aktionsleiste klebt unten, weil dort
 * der Daumen ist.
 *
 * Zum Sichern in die Fotos-App des Handys wird die Web-Share-Schnittstelle
 * benutzt – das ist der einzige Weg, den ein Browser dafür hat. Ein
 * eigenes Album lässt sich von einer Webseite aus NICHT anlegen; das
 * entscheidet das Betriebssystem.
 */
(function () {
  'use strict';

  /* Grenzen fürs Sichern in die Fotos-App.
   *
   * Die Web-Share-Schnittstelle reicht die Dateien komplett im Speicher
   * weiter. Bei einem 400-MB-Video bricht vor allem iOS dabei ab – und
   * zwar erst, NACHDEM alles geladen wurde. Deshalb wird die Grösse
   * vorher aus den Metadaten geprüft, nicht erst nach dem Herunterladen.
   */
  var SHARE_MAX_DATEIEN = 10;
  var SHARE_MAX_BYTES = 150 * 1024 * 1024;   // Summe einer Auswahl
  var SHARE_MAX_EINZELN = 150 * 1024 * 1024; // eine einzelne Datei

  // Auf iOS führt bei grossen Dateien der eingebaute Weg zum Ziel: Videos
  // über den Player, Bilder über langes Drücken. Beides kennt KEINE
  // Grössenbeschränkung – anders als das Übergeben im Speicher.
  var istIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  var photos = [];
  var kategorien = [];
  var gefiltert = [];
  var filterKat = '';        // '' = alle, '★' = Favoriten
  var filterGast = '';
  var lbIndex = -1;
  var auswahlModus = false;
  var gewaehlt = {};

  var el = function (id) { return document.getElementById(id); };
  var elLock = el('lock');
  var elContent = el('content');
  var elSub = el('subline');
  var elGrid = el('grid');
  var elChips = el('chipsleiste');
  var elFilter = el('filter');
  var elZaehler = el('zaehler');
  var elAktionen = el('aktionen');
  var elLb = el('lightbox');
  var elLbMedia = el('lbMedia');
  var elToast = el('toast');

  // ---------------------------------------------------------- Kleinkram

  var toastTimer = null;
  function toast(text, ms) {
    elToast.textContent = text;
    elToast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      elToast.classList.add('hidden');
    }, ms || 3000);
  }

  function fmtDay(ts) {
    return new Date(ts).toLocaleDateString('de-AT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function groesse(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    return Math.round(bytes / 1048576) + ' MB';
  }

  function kategorieVon(id) {
    for (var i = 0; i < kategorien.length; i++) {
      if (kategorien[i].id === id) return kategorien[i];
    }
    return null;
  }

  // Beste verfügbare Datei: Original, sonst das Anzeigebild.
  function dateiUrl(p) {
    return p.hasOriginal ? '/i/' + p.id + '-o.' + p.ext : '/i/' + p.id + '-d.jpg';
  }

  /* Fürs Sichern aufs Handy zählt eine andere Datei.
   *
   * Wo eine Handy-Version des Videos vorliegt, ist sie die richtige Wahl:
   * kleiner gerechnet, damit das Telefon sie in einem Zug in die Fotos-App
   * übernehmen kann. Das Original bleibt für ZIP und Rechner.
   */
  function sicherUrl(p) {
    if (p.mobilBytes) return '/i/' + p.id + '-m.mp4';
    return dateiUrl(p);
  }

  function sicherBytes(p) {
    return p.mobilBytes || p.bytes || 0;
  }

  function sicherName(p) {
    if (!p.mobilBytes) return dateiName(p);
    return dateiName(p).replace(/\.[a-z0-9]+$/i, '.mp4');
  }

  function dateiName(p) {
    var datum = new Date(p.effectiveAt || p.uploadedAt).toISOString().slice(0, 10);
    var wer = (p.uploader || 'gast').replace(/[^\w\-]/g, '_');
    var ext = p.hasOriginal ? p.ext : 'jpg';
    return datum + '_' + wer + '_' + p.id + '.' + ext;
  }

  // ---------------------------------------------------------- Filter

  function chip(text, wert, aktiv) {
    var b = document.createElement('button');
    b.className = 'chip' + (aktiv ? ' an' : '');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', function () {
      filterKat = wert;
      chipsZeichnen();
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    return b;
  }

  function chipsZeichnen() {
    elChips.textContent = '';
    elChips.appendChild(chip('Alle', '', filterKat === ''));

    if (photos.some(function (p) { return p.favorite; })) {
      elChips.appendChild(chip('★ Favoriten', '★', filterKat === '★'));
    }

    kategorien.forEach(function (k) {
      var n = photos.filter(function (p) { return p.category === k.id; }).length;
      if (!n) return;   // leere Kategorien nicht anzeigen
      elChips.appendChild(
        chip(k.icon + ' ' + k.name + ' ' + n, k.id, filterKat === k.id));
    });

    var ohne = photos.filter(function (p) {
      return !p.category && !p.archive;
    }).length;
    if (ohne && kategorien.length) {
      elChips.appendChild(chip('Weitere ' + ohne, '∅', filterKat === '∅'));
    }

    // Mitgebrachte Altfotos ganz zum Schluss – sie gehören nicht zum
    // Ablauf des Tages, sind aber eine eigene kleine Sammlung.
    var alt = photos.filter(function (p) { return p.archive; }).length;
    if (alt) {
      elChips.appendChild(chip('📼 Von früher ' + alt, '📼', filterKat === '📼'));
    }
  }

  function auswaehlen() {
    return photos.filter(function (p) {
      if (filterGast && p.uploader !== filterGast) return false;
      if (filterKat === '★') return p.favorite;
      if (filterKat === '📼') return p.archive;
      if (filterKat === '∅') return !p.category && !p.archive;
      if (filterKat) return p.category === filterKat;
      return true;
    });
  }

  // ---------------------------------------------------------- Raster

  function ueberschrift(text, klasse) {
    var h = document.createElement('div');
    h.className = klasse || 'datehead';
    h.textContent = text;
    elGrid.appendChild(h);
  }

  function kachel(p, index) {
    var tile = document.createElement('div');
    tile.className = 'tile' + (gewaehlt[p.id] ? ' gewaehlt' : '');
    tile.dataset.id = p.id;

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = '/i/' + p.id + '-t.jpg';
    img.alt = 'Foto von ' + p.uploader;
    tile.appendChild(img);

    // Nur kennzeichnen, wenn tatsächlich etwas abzuspielen ist. Ohne
    // Original gibt es bloss das Standbild – ein Filmsymbol verspräche
    // dann etwas, das nicht kommt.
    if ((p.kind === 'video' || p.kind === 'message') && p.hasOriginal) {
      var v = document.createElement('span');
      v.className = 'vid';
      v.textContent = p.kind === 'message' ? '🎙️' : '🎬';
      tile.appendChild(v);
    }
    if (p.favorite) {
      var st = document.createElement('span');
      st.className = 'fav';
      st.textContent = '★';
      tile.appendChild(st);
    }
    if (auswahlModus) {
      var haken = document.createElement('span');
      haken.className = 'haken';
      haken.textContent = '✓';
      tile.appendChild(haken);
    }

    tile.addEventListener('click', function () {
      if (auswahlModus) {
        if (gewaehlt[p.id]) delete gewaehlt[p.id];
        else gewaehlt[p.id] = true;
        tile.classList.toggle('gewaehlt', !!gewaehlt[p.id]);
        auswahlZeigen();
        return;
      }
      lbOeffnen(index);
    });

    // Langes Drücken startet die Mehrfachauswahl – das erwartet man so.
    var halten = null;
    tile.addEventListener('touchstart', function () {
      halten = setTimeout(function () {
        if (!auswahlModus) auswahlStarten();
        gewaehlt[p.id] = true;
        render();
        auswahlZeigen();
      }, 500);
    }, { passive: true });
    var abbrechen = function () { clearTimeout(halten); };
    tile.addEventListener('touchend', abbrechen);
    tile.addEventListener('touchmove', abbrechen, { passive: true });

    elGrid.appendChild(tile);
  }

  var nachZeit = function (a, b) {
    return (a.effectiveAt || a.uploadedAt) - (b.effectiveAt || b.uploadedAt);
  };

  /* Aufbau der Ansicht.
   *
   * Ohne Filter wird nach KATEGORIE gruppiert – „Trauung", „Essen", … in
   * der Reihenfolge, die in der Moderation festgelegt ist. Das entspricht
   * dem Ablauf des Tages und ist die Ordnung, in der man ein Fotoalbum
   * durchblättert. Innerhalb einer Kategorie geht es chronologisch weiter.
   *
   * Ist ein Kategorie-Filter aktiv, wäre eine zweite Ebene sinnlos – dann
   * wird nach Tagen gruppiert wie zuvor.
   */
  function render() {
    var pick = auswaehlen();
    var i = 0;

    elGrid.textContent = '';
    elGrid.classList.toggle('waehlen', auswahlModus);

    var abschnitt = function (titel, klasse, gruppe) {
      if (!gruppe.length) return;
      ueberschrift(titel, klasse);
      gruppe.forEach(function (p) { kachel(p, i++); });
    };

    if (filterKat) {
      // Gefilterte Ansicht: flach und chronologisch, mit Tages-Überschriften.
      var flach = pick.slice().sort(nachZeit);
      gefiltert = flach;
      var letzterTag = '';
      flach.forEach(function (p) {
        var tag = fmtDay(p.effectiveAt || p.uploadedAt);
        if (tag !== letzterTag) { letzterTag = tag; ueberschrift(tag); }
        kachel(p, i++);
      });
    } else {
      var favoriten = pick.filter(function (p) { return p.favorite; }).sort(nachZeit);
      var rest = pick.filter(function (p) { return !p.favorite; });

      var frueher = rest.filter(function (p) { return p.archive; })
        .sort(function (a, b) {
          return (a.takenAt || a.uploadedAt) - (b.takenAt || b.uploadedAt);
        });
      var abend = rest.filter(function (p) { return !p.archive; });

      // Nach Kategorie gruppieren, Reihenfolge wie in der Moderation.
      var gruppen = [];
      var vergeben = {};
      kategorien.forEach(function (k) {
        var drin = abend.filter(function (p) { return p.category === k.id; })
          .sort(nachZeit);
        if (!drin.length) return;
        drin.forEach(function (p) { vergeben[p.id] = true; });
        gruppen.push({ titel: k.icon + ' ' + k.name, fotos: drin });
      });

      var ohne = abend.filter(function (p) { return !vergeben[p.id]; }).sort(nachZeit);

      gefiltert = favoriten.concat(
        gruppen.reduce(function (a, g) { return a.concat(g.fotos); }, []),
        ohne, frueher);

      abschnitt('★ Unsere Lieblingsbilder', 'favhead', favoriten);
      gruppen.forEach(function (g) { abschnitt(g.titel, null, g.fotos); });
      abschnitt(kategorien.length ? '📷 Weitere Aufnahmen' : 'Alle Aufnahmen',
        null, ohne);
      abschnitt('📼 Mitgebracht von früher', null, frueher);
    }

    elZaehler.textContent = gefiltert.length +
      (gefiltert.length === 1 ? ' Aufnahme' : ' Aufnahmen');

    if (!gefiltert.length) {
      var leer = document.createElement('p');
      leer.className = 'hint';
      leer.textContent = 'Hier ist nichts – andere Auswahl probieren.';
      elGrid.appendChild(leer);
    }
  }

  // ---------------------------------------------------------- Vollbild

  function lbOeffnen(i) {
    lbIndex = i;
    var p = gefiltert[i];
    if (!p) return;

    var altesMedium = elLbMedia.querySelector('img, video');
    if (altesMedium) altesMedium.remove();
    if ((p.kind === 'video' || p.kind === 'message') && p.hasOriginal) {
      var video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = dateiUrl(p);
      elLbMedia.appendChild(video);
    } else {
      var img = document.createElement('img');
      img.src = '/i/' + p.id + '-d.jpg';
      img.alt = '';
      elLbMedia.appendChild(img);
    }

    var k = kategorieVon(p.category);
    var teile = [];
    if (p.kind === 'message') teile.push('🎙️ Botschaft');
    teile.push('von ' + p.uploader);
    if (k) teile.push(k.icon + ' ' + k.name);
    if (p.archive && p.takenAt) {
      teile.push('📼 ' + new Date(p.takenAt)
        .toLocaleDateString('de-AT', { month: 'long', year: 'numeric' }));
    }
    el('lbWho').textContent = teile.join(' · ');

    var chal = window.Challenges && Challenges.byId(p.challengeId);
    var hinweis = (p.kind !== 'photo' && !p.hasOriginal)
      ? 'Von dieser Aufnahme gibt es nur das Standbild.' : '';
    el('lbCap').textContent =
      (chal ? chal.icon + ' ' + chal.text : (p.caption || '')) ||
      hinweis;
    el('lbPos').textContent = (i + 1) + ' / ' + gefiltert.length;
    el('lbDownload').href = dateiUrl(p);
    el('lbDownload').setAttribute('download', dateiName(p));
    // Grösse am Knopf – dann weiss man vorher, worauf man sich einlässt.
    el('lbGroesse').textContent = p.bytes ? groesse(p.bytes) : 'Laden';

    var modLink = el('lbMod');
    modLink.classList.toggle('hidden', !istVerwaltung);
    if (istVerwaltung) modLink.href = '/mod?foto=' + encodeURIComponent(p.id);
    el('lbSichern').classList.toggle('hidden',
      !(navigator.canShare && navigator.share));

    // Bei grossen Dateien gleich auf den nativen Weg hinweisen, statt den
    // Gast erst in eine Absage laufen zu lassen.
    var tipp = el('lbTipp');
    if (istIOS && p.kind === 'photo') {
      // Der schnellste Weg auf dem iPhone, und er kennt keine Grössengrenze.
      tipp.textContent = 'Am schnellsten: Bild gedrückt halten → ' +
        '„Zu Fotos hinzufügen".';
      tipp.classList.remove('hidden');
    } else if (p.mobilBytes) {
      tipp.textContent = 'Sichern nimmt die handytaugliche Fassung (' +
        groesse(p.mobilBytes) + '). Das Original steckt im ZIP.';
      tipp.classList.remove('hidden');
    } else if (sicherBytes(p) > SHARE_MAX_EINZELN) {
      tipp.textContent = 'Grosse Datei – „Sichern" zeigt den passenden Weg.';
      tipp.classList.remove('hidden');
    } else {
      tipp.classList.add('hidden');
    }

    elLb.classList.remove('hidden');
    document.body.classList.add('lb-offen');

    // Nachbarn vorladen, damit das Blättern nicht ruckelt.
    [i - 1, i + 1].forEach(function (n) {
      var q = gefiltert[n];
      if (q && q.kind === 'photo') new Image().src = '/i/' + q.id + '-d.jpg';
    });
  }

  function lbSchliessen() {
    elLb.classList.add('hidden');
    var m = elLbMedia.querySelector('img, video');
    if (m) m.remove();                 // stoppt laufende Videos
    document.body.classList.remove('lb-offen');
    lbIndex = -1;
  }

  function lbSchritt(d) {
    if (lbIndex < 0) return;
    var n = lbIndex + d;
    if (n >= 0 && n < gefiltert.length) lbOeffnen(n);
  }

  el('lbClose').addEventListener('click', lbSchliessen);
  el('lbPrev').addEventListener('click', function (e) {
    e.stopPropagation(); lbSchritt(-1);
  });
  el('lbNext').addEventListener('click', function (e) {
    e.stopPropagation(); lbSchritt(1);
  });
  el('lbSichern').addEventListener('click', function () {
    if (gefiltert[lbIndex]) inFotosSichern([gefiltert[lbIndex]]);
  });

  document.addEventListener('keydown', function (e) {
    if (elLb.classList.contains('hidden')) return;
    if (e.key === 'Escape') lbSchliessen();
    if (e.key === 'ArrowLeft') lbSchritt(-1);
    if (e.key === 'ArrowRight') lbSchritt(1);
  });

  // Wischen: seitlich blättern, nach unten schliessen.
  (function () {
    var x0 = 0, y0 = 0, aktiv = false;
    elLb.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      aktiv = true;
    }, { passive: true });

    elLb.addEventListener('touchend', function (e) {
      if (!aktiv) return;
      aktiv = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - x0;
      var dy = t.clientY - y0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        lbSchritt(dx < 0 ? 1 : -1);
      } else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
        lbSchliessen();
      }
    });
  })();

  // ---------------------------------------------------------- Sichern

  /* In die Fotos-App des Handys sichern.
   *
   * Die Web-Share-Schnittstelle reicht die Dateien an das Betriebssystem
   * weiter; dort erscheint „Bilder sichern" bzw. „In Fotos sichern". Das
   * ist der einzige Weg, den ein Browser hat – ein eigenes Album kann eine
   * Webseite NICHT anlegen, das entscheidet das Betriebssystem.
   *
   * Wo Teilen nicht geht (die meisten Rechner-Browser), wird stattdessen
   * heruntergeladen.
   */
  // Herunterladen statt Teilen – der verlässliche Weg für grosse Dateien.
  function herunterladen(liste) {
    liste.forEach(function (p, i) {
      setTimeout(function () {
        var a = document.createElement('a');
        a.href = dateiUrl(p);          // hier immer das Original
        a.download = dateiName(p);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400);   // Browser mögen keine Download-Lawine
    });
  }

  /* Datei holen und dabei den Fortschritt melden.
   *
   * Ein schlichtes fetch().blob() lässt den Gast bei 80 MB eine Minute im
   * Ungewissen. Über den Lesestrom lässt sich sagen, wie weit es ist.
   */
  function holeMitFortschritt(p, melde) {
    return fetch(sicherUrl(p)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var gesamt = Number(r.headers.get('content-length')) || sicherBytes(p) || 0;
      if (!r.body || !r.body.getReader) return r.blob();

      var leser = r.body.getReader();
      var teile = [];
      var geladen = 0;
      return (function weiter() {
        return leser.read().then(function (res) {
          if (res.done) return new Blob(teile, { type: r.headers.get('content-type') || '' });
          teile.push(res.value);
          geladen += res.value.length;
          if (melde && gesamt) melde(geladen / gesamt);
          return weiter();
        });
      })();
    });
  }

  /* In die Fotos-App des Handys sichern.
   *
   * Reihenfolge ist wichtig: ERST die Grösse aus den Metadaten prüfen,
   * dann laden. Andersherum zieht das Handy 400 MB in den Speicher und
   * scheitert danach – genau die Fehlermeldung, die es zu vermeiden gilt.
   */
  function inFotosSichern(liste) {
    if (!liste.length) return;

    var kannTeilen = !!(navigator.canShare && navigator.share);
    if (!kannTeilen) {
      herunterladen(liste);
      toast(liste.length === 1 ? 'Wird heruntergeladen …'
        : liste.length + ' Dateien werden heruntergeladen …');
      return;
    }

    if (liste.length > SHARE_MAX_DATEIEN) {
      toast('Bitte höchstens ' + SHARE_MAX_DATEIEN + ' auf einmal sichern.', 5000);
      return;
    }

    // Grössen stehen im Datensatz – kein Herunterladen nötig, um zu wissen,
    // ob es passt.
    var summe = 0;
    var zuGross = null;
    liste.forEach(function (p) {
      var b = sicherBytes(p);
      summe += b;
      if (b > SHARE_MAX_EINZELN && !zuGross) zuGross = p;
    });

    // Eine einzelne grosse Datei: den nativen Weg zeigen statt abzusagen.
    if (zuGross && liste.length === 1) { hilfeZeigen(zuGross); return; }
    if (zuGross) {
      toast('Eine Datei der Auswahl ist zu gross. Bitte einzeln antippen – ' +
        'dann zeige ich, wie es geht.', 6000);
      return;
    }

    if (summe > SHARE_MAX_BYTES) {
      toast('Zusammen ' + groesse(summe) + ' – bitte weniger auswählen ' +
        'oder als ZIP laden.', 5000);
      return;
    }

    var fertig = 0;
    toast('Wird vorbereitet …', 60000);

    var reihe = liste.map(function (p) {
      return function () {
        return holeMitFortschritt(p, function (anteil) {
          var gesamtAnteil = (fertig + anteil) / liste.length;
          toast('Wird vorbereitet … ' + Math.round(gesamtAnteil * 100) + ' %', 60000);
        }).then(function (b) {
          fertig++;
          return new File([b], sicherName(p), { type: b.type || 'application/octet-stream' });
        });
      };
    });

    // Nacheinander laden – gleichzeitig würde der Speicher des Handys
    // unnötig belastet.
    reihe.reduce(function (kette, schritt) {
      return kette.then(function (gesammelt) {
        return schritt().then(function (d) { return gesammelt.concat([d]); });
      });
    }, Promise.resolve([])).then(function (dateien) {
      if (!navigator.canShare({ files: dateien })) {
        elToast.classList.add('hidden');
        toast('Dieses Gerät kann Dateien nicht direkt sichern – ' +
          'es wird stattdessen geladen.', 5000);
        herunterladen(liste);
        return;
      }
      return navigator.share({ files: dateien, title: 'Unsere Hochzeitsfotos' })
        .then(function () { toast('Fertig – „In Fotos sichern" wählen.'); })
        .catch(function (e) {
          if (e && e.name === 'AbortError') { elToast.classList.add('hidden'); return; }
          elToast.classList.add('hidden');
          // Das Gerät hat abgelehnt, fast immer wegen der Grösse.
          if (liste.length === 1) hilfeZeigen(liste[0]);
          else {
            toast('Das Gerät hat abgelehnt – bitte einzeln sichern.', 5000);
          }
        });
    }).catch(function () {
      toast('Datei konnte nicht geladen werden. Bitte nochmal versuchen.', 4000);
    });
  }

  /* Anleitung für grosse Dateien.
   *
   * Die Web-Share-Schnittstelle braucht die Datei komplett im Speicher –
   * daran scheitert ein 300-MB-Video auf dem Handy. Der eingebaute Weg des
   * Geräts kennt diese Grenze nicht: Auf iOS spielt der Player das Video
   * und bietet im Teilen-Menü „Video sichern"; ein Bild wird durch langes
   * Drücken zu den Fotos hinzugefügt. Beides ohne Grössenbeschränkung –
   * es muss nur jemand zeigen.
   */
  function hilfeZeigen(p) {
    var istVideo = p.kind !== 'photo';
    var titel = istVideo ? 'Video sichern' : 'Bild sichern';
    var schritte;

    if (istIOS && !istVideo) {
      // Bilder gehen auf iOS immer direkt – egal wie gross. Das Bild ist
      // schon zu sehen, es braucht keinen Umweg.
      schritte = [
        'Das Blatt schliessen – das Bild ist schon offen.',
        'Mit dem Finger auf das Bild drücken und halten.',
        '„Zu Fotos hinzufügen" wählen.',
      ];
    } else if (istIOS) {
      schritte = [
        'Auf „Öffnen" tippen – das Video wird geladen.',
        'Oben rechts auf das Teilen-Symbol tippen.',
        '„In Dateien sichern" wählen, dann in der Dateien-App ' +
          'das Video antippen und dort „Sichern" wählen.',
      ];
    } else {
      schritte = [
        'Auf „In Dateien laden" tippen.',
        'Die Datei landet in den Downloads.',
        'Die Galerie-App zeigt sie meist automatisch an.',
      ];
    }

    el('hilfeTitel').textContent = titel + ' (' + groesse(sicherBytes(p)) + ')';
    el('hilfeText').textContent = (istIOS && !istVideo)
      ? 'Bilder lassen sich auf dem iPhone direkt sichern – ganz ohne Umweg:'
      : 'Für so grosse Dateien gibt es einen eigenen Weg – ' +
        'er funktioniert unabhängig von der Grösse:';

    var ol = el('hilfeSchritte');
    ol.textContent = '';
    schritte.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      ol.appendChild(li);
    });

    var url = dateiUrl(p);
    el('hilfeOeffnen').href = url;
    el('hilfeOeffnen').textContent = istVideo ? '▶ Öffnen' : '🖼️ Öffnen';
    el('hilfeLaden').href = url;
    el('hilfeLaden').setAttribute('download', dateiName(p));

    el('hilfeBlatt').classList.remove('hidden');
    document.body.classList.add('lb-offen');
  }

  function hilfeSchliessen() {
    el('hilfeBlatt').classList.add('hidden');
    if (elLb.classList.contains('hidden')) {
      document.body.classList.remove('lb-offen');
    }
  }

  el('hilfeZu').addEventListener('click', hilfeSchliessen);
  el('hilfeBlatt').addEventListener('click', function (e) {
    if (e.target === el('hilfeBlatt')) hilfeSchliessen();
  });
  el('hilfeOeffnen').addEventListener('click', hilfeSchliessen);

  // ---------------------------------------------------------- Auswahl

  function auswahlIds() { return Object.keys(gewaehlt); }

  function auswahlZeigen() {
    var n = auswahlIds().length;
    el('auswahlZahl').textContent = n + (n === 1 ? ' gewählt' : ' gewählt');
    el('aktionenNormal').classList.toggle('hidden', auswahlModus);
    el('aktionenAuswahl').classList.toggle('hidden', !auswahlModus);
  }

  function auswahlStarten() {
    auswahlModus = true;
    auswahlZeigen();
  }

  function auswahlBeenden() {
    auswahlModus = false;
    gewaehlt = {};
    auswahlZeigen();
    render();
  }

  el('btnAuswahl').addEventListener('click', function () {
    auswahlStarten();
    render();
  });
  el('btnAuswahlEnde').addEventListener('click', auswahlBeenden);

  el('btnAuswahlAlle').addEventListener('click', function () {
    var alle = gefiltert.length && gefiltert.every(function (p) { return gewaehlt[p.id]; });
    gewaehlt = {};
    if (!alle) gefiltert.forEach(function (p) { gewaehlt[p.id] = true; });
    render();
    auswahlZeigen();
  });

  el('btnSichern').addEventListener('click', function () {
    var ids = auswahlIds();
    inFotosSichern(photos.filter(function (p) { return ids.indexOf(p.id) >= 0; }));
  });

  el('btnAuswahlZip').addEventListener('click', function () {
    var ids = auswahlIds();
    if (!ids.length) return;
    toast('ZIP wird vorbereitet …');
    fetch('/api/gallery/auswahl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.marke) { toast('Auswahl konnte nicht abgelegt werden.', 4000); return; }
        // Die Marke gilt zwei Stunden; danach meldet der Server 410 und
        // die Auswahl muss neu getroffen werden.
        elToast.classList.add('hidden');
        location.href = '/api/gallery/zip?auswahl=' + encodeURIComponent(d.marke);
      })
      .catch(function () { toast('Download fehlgeschlagen.', 4000); });
  });

  // ---------------------------------------------------------- Downloads

  var elDownloads = el('downloads');

  el('btnDownloads').addEventListener('click', function () {
    var zeigen = elDownloads.classList.contains('hidden');
    elDownloads.classList.toggle('hidden', !zeigen);
    if (zeigen) {
      ladeDownloads();
      elDownloads.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  function paketZeile(titel, hinweis, meta, href) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'titel';
    a.href = href;
    a.setAttribute('download', '');
    a.textContent = '⬇️ ' + titel;
    li.appendChild(a);
    if (meta) {
      var m = document.createElement('span');
      m.className = 'meta';
      m.textContent = meta;
      li.appendChild(m);
    }
    if (hinweis) {
      var h = document.createElement('span');
      h.className = 'voll';
      h.textContent = hinweis;
      li.appendChild(h);
    }
    return li;
  }

  function ladeDownloads() {
    var liste = el('paketliste');
    fetch('/api/gallery/downloads')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        liste.textContent = '';

        /* Ein Knopf für alle, die einfach alles wollen.
         *
         * Liegen fertige Pakete bereit, führt er auf das grösste – bei
         * mehreren Teilen bleibt die Liste darunter der Weg. Ohne fertige
         * Pakete wird im Fluge gepackt; das ist für den Rechner völlig
         * in Ordnung.
         */
        var pakete = d.pakete || [];
        var voll = pakete.filter(function (p) {
          return p.art === 'foto' || p.art === 'video';
        });
        var knopf = el('btnAlles');
        if (voll.length === 1) {
          knopf.href = '/d/' + voll[0].datei;
          el('allesMeta').textContent = voll[0].anzahl + ' Dateien · ' +
            groesse(voll[0].bytes) + ' – fortsetzbar';
        } else if (voll.length > 1) {
          var summe = voll.reduce(function (n, p) { return n + p.bytes; }, 0);
          var anzahl = voll.reduce(function (n, p) { return n + p.anzahl; }, 0);
          knopf.href = '/d/' + voll[0].datei;
          el('allesMeta').textContent = anzahl + ' Dateien · ' + groesse(summe) +
            ' in ' + voll.length + ' Teilen – hier Teil 1, der Rest unten';
        } else {
          knopf.href = '/api/gallery/zip';
          el('allesMeta').textContent =
            'als ZIP – alle Fotos und Videos in Originalgrösse';
        }
        (d.pakete || []).forEach(function (p) {
          liste.appendChild(paketZeile(p.titel, p.hinweis,
            p.anzahl + ' Dateien · ' + groesse(p.bytes), '/d/' + p.datei));
        });
        if (!(d.pakete || []).length) {
          var leer = document.createElement('li');
          leer.textContent = 'Die Pakete werden gerade noch vorbereitet.';
          liste.appendChild(leer);
        }

        var gastWahl = el('gastWahl');
        gastWahl.textContent = '';
        (d.gaeste || []).forEach(function (name) {
          var o = document.createElement('option');
          o.value = name;
          o.textContent = name;
          gastWahl.appendChild(o);
        });
        gastLink();
      })
      .catch(function () {});
  }

  function gastLink() {
    el('gastLink').href = '/api/gallery/zip?gast=' +
      encodeURIComponent(el('gastWahl').value || '');
  }
  el('gastWahl').addEventListener('change', gastLink);

  // ---------------------------------------------------------- Start

  elFilter.addEventListener('change', function () {
    filterGast = elFilter.value;
    render();
  });

  // Änderungen an der Begrüssung erscheinen ohne Neuladen.
  (function () {
    try {
      var es = new EventSource('/api/stream');
      es.addEventListener('gruss', function (e) {
        var g = JSON.parse(e.data);
        el('grussTitel').textContent = g.titel;
        el('grussText').textContent = g.text;
      });
    } catch (e) { /* ohne Live-Verbindung geht es auch */ }
  })();

  // Wer den Moderations-Schlüssel im Browser hat, ist das Brautpaar –
  // für alle anderen bleibt der Verweis unsichtbar.
  var istVerwaltung = !!localStorage.getItem('modKey');

  var params = new URLSearchParams(location.search);

  fetch('/api/feed')
    .then(function (r) { return r.json(); })
    .then(function (f) {
      if (!f.galleryOpen) {
        elLock.classList.remove('hidden');
        return;
      }
      if (window.Challenges) Challenges.adopt(f.challenges);
      kategorien = f.kategorien || [];
      photos = f.photos || [];

      if (f.gruss) {
        el('grussTitel').textContent = f.gruss.titel;
        el('grussText').textContent = f.gruss.text;
      }

      elContent.classList.remove('hidden');
      elAktionen.classList.remove('hidden');
      var videos = photos.filter(function (p) { return p.kind !== 'photo'; }).length;
      elSub.textContent = f.count + ' Aufnahmen von ' + f.uploaders + ' Gästen' +
        (videos ? ' · davon ' + videos + ' Videos' : '');

      var namen = Array.from(new Set(photos.map(function (p) { return p.uploader; })))
        .sort(function (a, b) { return a.localeCompare(b, 'de'); });
      namen.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        elFilter.appendChild(o);
      });

      // Persönliche Links: /galerie?gast=Werner oder ?kategorie=trauung
      if (params.get('gast') && namen.indexOf(params.get('gast')) >= 0) {
        filterGast = params.get('gast');
        elFilter.value = filterGast;
      }
      if (params.get('kategorie')) filterKat = params.get('kategorie');

      var ohneOriginal = photos.filter(function (p) { return !p.hasOriginal; }).length;
      el('fussnote').textContent = ohneOriginal
        ? ohneOriginal + ' Aufnahmen liegen nur in Bildschirmgrösse vor – ' +
          'bei ihnen war die Originaldatei zu gross für den Upload.'
        : '';

      chipsZeichnen();
      render();
      auswahlZeigen();
    })
    .catch(function () {
      elSub.textContent = 'Galerie konnte nicht geladen werden – später nochmal versuchen.';
      elContent.classList.remove('hidden');
    });
})();

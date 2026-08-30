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

  // iOS wird beim Teilen vieler oder grosser Dateien unzuverlässig.
  var SHARE_MAX_DATEIEN = 10;
  var SHARE_MAX_BYTES = 120 * 1024 * 1024;

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

    var ohne = photos.filter(function (p) { return !p.category; }).length;
    if (ohne && kategorien.length) {
      elChips.appendChild(chip('Ohne Kategorie ' + ohne, '∅', filterKat === '∅'));
    }
  }

  function auswaehlen() {
    return photos.filter(function (p) {
      if (filterGast && p.uploader !== filterGast) return false;
      if (filterKat === '★') return p.favorite;
      if (filterKat === '∅') return !p.category;
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

    if (p.kind === 'video' || p.kind === 'message') {
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

    elLbMedia.textContent = '';
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
    el('lbCap').textContent = chal ? chal.icon + ' ' + chal.text : (p.caption || '');
    el('lbPos').textContent = (i + 1) + ' / ' + gefiltert.length;
    el('lbDownload').href = dateiUrl(p);
    el('lbDownload').setAttribute('download', dateiName(p));

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
    elLbMedia.textContent = '';        // stoppt laufende Videos
    document.body.classList.remove('lb-offen');
    lbIndex = -1;
  }

  function lbSchritt(d) {
    if (lbIndex < 0) return;
    var n = lbIndex + d;
    if (n >= 0 && n < gefiltert.length) lbOeffnen(n);
  }

  el('lbClose').addEventListener('click', lbSchliessen);
  el('lbPrev').addEventListener('click', function () { lbSchritt(-1); });
  el('lbNext').addEventListener('click', function () { lbSchritt(1); });
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
  function inFotosSichern(liste) {
    if (!liste.length) return;

    if (liste.length > SHARE_MAX_DATEIEN) {
      toast('Bitte höchstens ' + SHARE_MAX_DATEIEN +
        ' auf einmal sichern – sonst bricht das Handy ab.', 5000);
      return;
    }

    var kannTeilen = !!(navigator.canShare && navigator.share);
    if (!kannTeilen) {
      liste.forEach(function (p, i) {
        setTimeout(function () {
          var a = document.createElement('a');
          a.href = dateiUrl(p);
          a.download = dateiName(p);
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, i * 400);   // Browser mögen keine Download-Lawine
      });
      toast(liste.length === 1 ? 'Wird heruntergeladen …'
        : liste.length + ' Dateien werden heruntergeladen …');
      return;
    }

    toast('Dateien werden vorbereitet …', 10000);
    var summe = 0;

    Promise.all(liste.map(function (p) {
      return fetch(dateiUrl(p))
        .then(function (r) { return r.blob(); })
        .then(function (b) {
          summe += b.size;
          return new File([b], dateiName(p), { type: b.type });
        });
    })).then(function (dateien) {
      if (summe > SHARE_MAX_BYTES) {
        toast('Zusammen ' + groesse(summe) +
          ' – das ist zu viel auf einmal. Bitte weniger auswählen.', 5000);
        return;
      }
      if (!navigator.canShare({ files: dateien })) {
        toast('Dieses Gerät kann Dateien nicht direkt sichern. ' +
          'Bild lange antippen und „Zu Fotos hinzufügen" wählen.', 6000);
        return;
      }
      return navigator.share({ files: dateien, title: 'Unsere Hochzeitsfotos' })
        .then(function () { toast('Fertig – im Menü „In Fotos sichern" wählen.'); })
        .catch(function (e) {
          // Abbruch durch den Nutzer ist kein Fehler.
          if (e && e.name === 'AbortError') { elToast.classList.add('hidden'); return; }
          toast('Sichern nicht möglich. Bild lange antippen und ' +
            '„Zu Fotos hinzufügen" wählen.', 6000);
        });
    }).catch(function () {
      toast('Dateien konnten nicht geladen werden.', 4000);
    });
  }

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

      elContent.classList.remove('hidden');
      elAktionen.classList.remove('hidden');
      elSub.textContent = f.count + ' Aufnahmen von ' + f.uploaders + ' Gästen';

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

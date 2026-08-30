/* Sichten – der schnelle Durchlauf durch alle Aufnahmen.
 *
 * Gebaut für Tastatur: Pfeil rechts behält und geht weiter, X sortiert aus.
 * Damit kommt man durch 871 Fotos in etwa zwanzig Minuten, statt auf
 * Kacheln zu zielen. Jede Aktion ist eine einzige Anfrage an den Server
 * (/api/mod/sichten), und jede lässt sich rückgängig machen.
 *
 * Zwei Leute können gleichzeitig sichten – über den Ereigniskanal kommen
 * die Änderungen der anderen Seite an.
 */
(function () {
  'use strict';

  var VORLADEN = 3;         // so viele Bilder im Voraus holen
  var UNDO_TIEFE = 50;

  var key = location.hash.slice(1) || localStorage.getItem('modKey') || '';
  if (location.hash.length > 1) {
    localStorage.setItem('modKey', key);
    history.replaceState(null, '', '/sichten');
  }
  if (!key) {
    key = prompt('Moderations-Schlüssel:') || '';
    localStorage.setItem('modKey', key);
  }

  var alle = [];            // alle Beiträge, neueste zuletzt
  var kategorien = [];
  var liste = [];           // gefilterte Reihenfolge
  var pos = 0;
  var undoStapel = [];
  var offen = 0;

  var el = function (id) { return document.getElementById(id); };
  var elBuehne = el('siBuehne');
  var elLeer = el('siLeer');
  var elToast = el('toast');

  // ------------------------------------------------------------ Kleinkram

  var toastTimer = null;
  function toast(text, ms) {
    elToast.textContent = text;
    elToast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.add('hidden'); }, ms || 2200);
  }

  function api(pfad, koerper) {
    return fetch(pfad, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mod-key': key },
      body: JSON.stringify(koerper || {}),
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem('modKey');
        alert('Schlüssel ungültig. Seite neu laden.');
        throw new Error('401');
      }
      return r.json();
    });
  }

  function kategorieVon(id) {
    for (var i = 0; i < kategorien.length; i++) {
      if (kategorien[i].id === id) return kategorien[i];
    }
    return null;
  }

  function zeit(p) {
    return new Date(p.effectiveAt || p.uploadedAt).toLocaleString('de-AT', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  // ------------------------------------------------------------ Auswahl

  function passt(p) {
    var art = el('siFilter').value;
    var gast = el('siGast').value;
    if (gast && p.uploader !== gast) return false;

    switch (art) {
      case 'offen':      return !p.reviewed && !p.hidden;
      case 'video':      return p.kind !== 'photo';
      case 'archiv':     return p.archive;
      case 'favorit':    return p.favorite;
      case 'versteckt':  return p.hidden;
      default:           return !p.hidden;   // 'alle' = alles Sichtbare
    }
  }

  /* Liste neu aufbauen und dabei möglichst an derselben Aufnahme bleiben.
   *
   * Wichtig beim Filter „noch nicht gesichtet": Sobald ein Bild bearbeitet
   * ist, fällt es aus der Liste. Ohne diese Merkung würde der Zeiger
   * springen statt einfach beim nächsten offenen Bild zu landen.
   */
  function neuAufbauen(behalteId) {
    var vorher = behalteId || (liste[pos] && liste[pos].id);
    liste = alle.filter(passt);

    if (vorher) {
      var i = liste.findIndex(function (p) { return p.id === vorher; });
      if (i >= 0) pos = i;
      else if (pos >= liste.length) pos = Math.max(0, liste.length - 1);
    } else {
      pos = 0;
    }
    zeichnen();
  }

  // ------------------------------------------------------------ Anzeige

  function zeichnen() {
    var p = liste[pos];
    var leer = !p;

    elLeer.classList.toggle('hidden', !leer);
    el('siFuss').classList.toggle('hidden', leer);

    // Fortschritt gilt immer für den gesamten Bestand, nicht nur den Filter.
    el('siOffen').textContent = offen > 0
      ? 'noch ' + offen + ' offen'
      : 'alles gesichtet';

    if (leer) {
      el('siPos').textContent = '–';
      el('siBalken').style.width = '100%';
      var bild = elBuehne.querySelector('.si-medium');
      if (bild) bild.remove();
      el('siLeerTitel').textContent = el('siFilter').value === 'offen'
        ? 'Alles gesichtet' : 'Nichts gefunden';
      return;
    }

    el('siPos').textContent = (pos + 1) + ' von ' + liste.length;
    el('siBalken').style.width =
      Math.round(((pos + 1) / liste.length) * 100) + '%';

    // Medium austauschen
    var alt = elBuehne.querySelector('.si-medium');
    if (alt) alt.remove();

    var box = document.createElement('div');
    box.className = 'si-medium';
    if (p.hidden) box.classList.add('aussortiert');

    if (p.kind !== 'photo' && p.hasOriginal) {
      var video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = '/i/' + p.id + '-o.' + p.ext;
      box.appendChild(video);
    } else {
      var img = document.createElement('img');
      img.src = '/i/' + p.id + '-d.jpg';
      img.alt = '';
      box.appendChild(img);
    }

    if (p.hidden) {
      var marke = document.createElement('span');
      marke.className = 'si-marke';
      marke.textContent = '✕ aussortiert';
      box.appendChild(marke);
    }
    elBuehne.appendChild(box);

    // Kopf- und Fusszeile
    el('siWer').textContent =
      (p.kind === 'photo' ? '📷 ' : p.kind === 'message' ? '🎙️ ' : '🎬 ') + p.uploader;
    el('siWann').textContent = zeit(p) + (p.archive ? ' · 📼 von früher' : '');
    var k = kategorieVon(p.category);
    el('siKat').textContent = k ? k.icon + ' ' + k.name : '';
    el('siKatWahl').value = p.category || '';
    el('siFav').classList.toggle('active-state', !!p.favorite);
    el('siFavIcon').textContent = p.favorite ? '★' : '☆';

    vorladen();
  }

  function vorladen() {
    for (var d = 1; d <= VORLADEN; d++) {
      var q = liste[pos + d];
      if (q && q.kind === 'photo') new Image().src = '/i/' + q.id + '-d.jpg';
    }
    var z = liste[pos - 1];
    if (z && z.kind === 'photo') new Image().src = '/i/' + z.id + '-d.jpg';
  }

  // ------------------------------------------------------------ Aktionen

  function merken(p) {
    undoStapel.push({
      id: p.id,
      hidden: p.hidden,
      favorite: p.favorite,
      reviewed: p.reviewed,
      category: p.category,
    });
    while (undoStapel.length > UNDO_TIEFE) undoStapel.shift();
  }

  function anwenden(p, aenderung) {
    Object.keys(aenderung).forEach(function (k) { p[k] = aenderung[k]; });
    return api('/api/mod/sichten', Object.assign({ id: p.id }, aenderung))
      .then(function (r) {
        if (typeof r.offen === 'number') offen = r.offen;
        if (r.photo) Object.assign(p, r.photo);
        return r;
      })
      .catch(function () { toast('Änderung nicht gespeichert.', 3000); });
  }

  function weiter() {
    if (el('siFilter').value === 'offen') {
      // Bearbeitete fallen aus der Liste; der Zeiger bleibt stehen und
      // zeigt damit automatisch auf die nächste offene Aufnahme.
      neuAufbauen(null);
      if (pos >= liste.length) pos = Math.max(0, liste.length - 1);
      zeichnen();
    } else if (pos < liste.length - 1) {
      pos++;
      zeichnen();
    } else {
      zeichnen();
      toast('Ende der Liste erreicht.');
    }
  }

  function behalten() {
    var p = liste[pos];
    if (!p) return;
    merken(p);
    anwenden(p, { reviewed: true, hidden: false }).then(weiter);
  }

  function aussortieren() {
    var p = liste[pos];
    if (!p) return;
    merken(p);
    anwenden(p, { reviewed: true, hidden: true }).then(weiter);
  }

  function favorit() {
    var p = liste[pos];
    if (!p) return;
    merken(p);
    anwenden(p, { favorite: !p.favorite }).then(zeichnen);
  }

  function kategorieSetzen(katId) {
    var p = liste[pos];
    if (!p) return;
    merken(p);
    anwenden(p, { category: katId || '' }).then(zeichnen);
  }

  function zurueck() {
    if (pos > 0) { pos--; zeichnen(); }
  }

  function rueckgaengig() {
    var vorher = undoStapel.pop();
    if (!vorher) { toast('Nichts rückgängig zu machen.'); return; }
    var p = alle.find(function (x) { return x.id === vorher.id; });
    if (!p) return;

    anwenden(p, {
      hidden: vorher.hidden,
      favorite: vorher.favorite,
      reviewed: vorher.reviewed,
      category: vorher.category || '',
    }).then(function () {
      neuAufbauen(vorher.id);
      toast('Rückgängig gemacht.');
    });
  }

  // ------------------------------------------------------------ Bedienung

  el('siBehalten').addEventListener('click', behalten);
  el('siWeg').addEventListener('click', aussortieren);
  el('siFav').addEventListener('click', favorit);
  el('siZurueck').addEventListener('click', zurueck);
  el('siUndo').addEventListener('click', rueckgaengig);
  el('siKatWahl').addEventListener('change', function () {
    kategorieSetzen(this.value);
  });
  el('siHilfe').addEventListener('click', function () {
    el('siTasten').classList.toggle('zeigen');
  });
  el('siFilter').addEventListener('change', function () { neuAufbauen(null); });
  el('siGast').addEventListener('change', function () { neuAufbauen(null); });

  document.addEventListener('keydown', function (e) {
    // In Auswahlfeldern soll die Tastatur normal funktionieren.
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'input' || tag === 'textarea') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    var t = e.key.toLowerCase();
    if (e.key === 'ArrowRight' || t === ' ' || t === 'enter') { e.preventDefault(); behalten(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); zurueck(); }
    else if (t === 'x' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); aussortieren(); }
    else if (t === 'f') { e.preventDefault(); favorit(); }
    else if (t === 'z') { e.preventDefault(); rueckgaengig(); }
    else if (t === '0') { e.preventDefault(); kategorieSetzen(''); }
    else if (t >= '1' && t <= '9') {
      var k = kategorien[Number(t) - 1];
      if (k) { e.preventDefault(); kategorieSetzen(k.id); }
    }
  });

  // Wischen auf dem Handy: links = weiter (behalten), rechts = zurück.
  (function () {
    var x0 = 0, y0 = 0, aktiv = false;
    elBuehne.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; aktiv = true;
    }, { passive: true });
    elBuehne.addEventListener('touchend', function (e) {
      if (!aktiv) return;
      aktiv = false;
      var dx = e.changedTouches[0].clientX - x0;
      var dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) behalten(); else zurueck();
    });
  })();

  // ------------------------------------------------------------ Laden

  function katWahlFuellen() {
    var sel = el('siKatWahl');
    sel.textContent = '';
    var leer = document.createElement('option');
    leer.value = '';
    leer.textContent = '— keine Kategorie —';
    sel.appendChild(leer);
    kategorien.forEach(function (k, i) {
      var o = document.createElement('option');
      o.value = k.id;
      o.textContent = (i < 9 ? (i + 1) + '  ' : '') + k.icon + ' ' + k.name;
      sel.appendChild(o);
    });
  }

  function verbinden() {
    var es = new EventSource('/api/stream');
    var uebernehmen = function (neu) {
      var p = alle.find(function (x) { return x.id === neu.id; });
      if (p) Object.assign(p, neu);
      else alle.push(neu);
      if (liste[pos] && liste[pos].id === neu.id) zeichnen();
    };
    es.addEventListener('update', function (e) { uebernehmen(JSON.parse(e.data)); });
    es.addEventListener('photo', function (e) { uebernehmen(JSON.parse(e.data)); });
    es.addEventListener('hide', function (e) {
      var d = JSON.parse(e.data);
      var p = alle.find(function (x) { return x.id === d.id; });
      if (p) p.hidden = d.hidden;
    });
    es.addEventListener('kategorien', function (e) {
      kategorien = JSON.parse(e.data).kategorien || [];
      katWahlFuellen();
      zeichnen();
    });
  }

  Promise.all([
    fetch('/api/categories').then(function (r) { return r.json(); }),
    fetch('/api/mod/list?limit=5000', { headers: { 'x-mod-key': key } })
      .then(function (r) {
        if (r.status === 401) {
          localStorage.removeItem('modKey');
          document.body.textContent = 'Schlüssel ungültig – Seite neu laden.';
          throw new Error('401');
        }
        return r.json();
      }),
  ]).then(function (res) {
    kategorien = res[0].kategorien || [];
    // Der Server liefert neueste zuerst – zum Sichten ist chronologisch
    // von vorne die natürliche Richtung.
    alle = (res[1].photos || []).slice().reverse();
    offen = res[1].offen || 0;

    katWahlFuellen();

    var namen = Array.from(new Set(alle.map(function (p) { return p.uploader; })))
      .sort(function (a, b) { return a.localeCompare(b, 'de'); });
    namen.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      el('siGast').appendChild(o);
    });

    neuAufbauen(null);
    verbinden();
  }).catch(function () {});
})();

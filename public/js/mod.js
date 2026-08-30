/* Moderation: Schlüssel per URL-Fragment (/mod#SCHLUESSEL), danach im
 * localStorage. Live-Ansicht aller Uploads, Ausblenden per Tipp,
 * Fernsteuerung der Fotowand, Galerie auf/zu.
 */
(function () {
  'use strict';

  var key = location.hash.slice(1) || localStorage.getItem('modKey') || '';
  if (location.hash.length > 1) {
    localStorage.setItem('modKey', key);
    history.replaceState(null, '', '/mod'); // Schlüssel aus der URL nehmen
  }
  if (!key) {
    key = prompt('Moderations-Schlüssel:') || '';
    localStorage.setItem('modKey', key);
  }

  var state = { paused: false, mode: 'normal', galleryOpen: false };
  var gesamt = 0;   // Gesamtzahl laut Server, um Kürzungen zu erkennen
  var kategorien = [];
  var auswahlModus = false;
  var gewaehlt = {};   // id -> true
  var photos = new Map(); // id -> Foto (inkl. hidden), neueste zuerst gerendert
  var health = null;

  var elGrid = document.getElementById('grid');
  var elChips = document.getElementById('chips');
  var btnPause = document.getElementById('btnPause');
  var btnQuiet = document.getElementById('btnQuiet');
  var btnGallery = document.getElementById('btnGallery');

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mod-key': key },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem('modKey');
        alert('Schlüssel ungültig. Seite neu laden und korrekten Schlüssel eingeben.');
        throw new Error('401');
      }
      return r.json();
    });
  }

  // ------------------------------------------------------------ Anzeige

  function chip(label, value) {
    var c = document.createElement('span');
    c.className = 'chip';
    var b = document.createElement('b');
    b.textContent = value;
    c.appendChild(document.createTextNode(label + ' '));
    c.appendChild(b);
    return c;
  }

  // Zeilenumbruch für die Tooltips der Kacheln.
  var BREAK = String.fromCharCode(10);

  var QUELLE = {
    'exif': 'Aufnahmezeit aus den Metadaten',
    'exif-scan': 'Digitalisierungszeit aus den Metadaten',
    'exif-datei': 'Änderungszeit aus den Metadaten',
    'aufnahme': 'direkt in der Erzählecke aufgenommen',
    'datei': 'keine Metadaten – Dateidatum (unzuverlässig)',
  };

  function describeTime(p) {
    var ts = p.takenAt || p.uploadedAt;
    var wann = new Date(ts).toLocaleString('de-AT', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    return wann + BREAK + (QUELLE[p.timeSource] || p.timeSource);
  }

  function renderChips() {
    elChips.textContent = '';
    var visible = 0, hidden = 0;
    photos.forEach(function (p) { p.hidden ? hidden++ : visible++; });
    var altfotos = 0;
    photos.forEach(function (p) { if (p.archive && !p.hidden) altfotos++; });
    elChips.appendChild(chip('Sichtbar:', String(visible)));
    elChips.appendChild(chip('Versteckt:', String(hidden)));
    if (altfotos) elChips.appendChild(chip('📼 Von früher:', String(altfotos)));
    var favoriten = 0;
    photos.forEach(function (p) { if (p.favorite && !p.hidden) favoriten++; });
    if (favoriten) elChips.appendChild(chip('★ Favoriten:', String(favoriten)));
    if (gesamt && gesamt > photos.size) {
      elChips.appendChild(chip('⚠️ Nicht angezeigt:', String(gesamt - photos.size)));
    }
    elChips.appendChild(chip('Fotowand:', state.paused ? '⏸ Pause' : '▶ läuft'));
    elChips.appendChild(chip('Modus:', state.mode === 'quiet' ? '🤫 Ruhe' : 'Normal'));
    elChips.appendChild(chip('Galerie:', state.galleryOpen ? '🔓 offen' : '🔒 zu'));
    if (health && health.disk) {
      elChips.appendChild(chip('Platte:',
        health.disk.usedPct + '% belegt (' + health.disk.freeGB + ' GB frei)'));
    }

    btnPause.textContent = state.paused ? '▶ Weiter' : '⏸ Pause';
    btnPause.classList.toggle('active-state', state.paused);
    btnQuiet.textContent = state.mode === 'quiet' ? '🤫 Ruhe-Modus AN' : '🤫 Ruhe-Modus';
    btnQuiet.classList.toggle('active-state', state.mode === 'quiet');
    btnGallery.textContent = state.galleryOpen ? '🔓 Galerie schliessen' : '🔒 Galerie öffnen';
  }

  function makeTile(p) {
    var tile = document.createElement('div');
    tile.className = 'tile' + (p.hidden ? ' off' : '');
    tile.dataset.id = p.id;
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/i/' + p.id + '-t.jpg';
    img.alt = p.uploader;
    tile.appendChild(img);
    if (p.hidden) {
      var n = document.createElement('div');
      n.className = 'nope';
      n.textContent = '🚫';
      tile.appendChild(n);
    }
    // Schalter für die Einordnung. Eigenes Tippfeld, damit ein Fehlgriff
    // nicht versehentlich das Foto ausblendet.
    var flag = document.createElement('button');
    flag.className = 'flag' + (p.archive ? ' on' : '');
    flag.type = 'button';
    flag.textContent = p.archive ? '📼' : '🕐';
    flag.title = describeTime(p) + BREAK + (p.archive
      ? 'Gilt als mitgebrachtes Altfoto – antippen macht es zum Foto des Abends.'
      : 'Gilt als Foto des Abends – antippen macht es zum Altfoto.');
    flag.addEventListener('click', function (ev) {
      ev.stopPropagation();
      api('/api/mod/archive', { id: p.id, archive: !photos.get(p.id).archive })
        .then(function (r) {
          photos.set(p.id, Object.assign({}, photos.get(p.id), r.photo));
          tile.replaceWith(makeTile(photos.get(p.id)));
        }).catch(function () {});
    });
    tile.appendChild(flag);

    // Lieblingsbild. Eigenes Tippfeld wie der Einordnungs-Schalter.
    var stern = document.createElement('button');
    stern.className = 'stern' + (p.favorite ? ' on' : '');
    stern.type = 'button';
    stern.textContent = p.favorite ? '★' : '☆';
    stern.title = p.favorite
      ? 'Lieblingsbild – erscheint oben in der Galerie'
      : 'Als Lieblingsbild markieren';
    stern.addEventListener('click', function (ev) {
      ev.stopPropagation();
      api('/api/mod/favorite', { id: p.id, favorite: !photos.get(p.id).favorite })
        .then(function (r) {
          photos.set(p.id, Object.assign({}, photos.get(p.id), r.photo));
          tile.replaceWith(makeTile(photos.get(p.id)));
          renderChips();
        }).catch(function () {});
    });
    tile.appendChild(stern);

    // Art und Kategorie in EINEM Feld unten rechts – zwei getrennte
    // Marken lagen auf einer 110-Pixel-Kachel übereinander.
    var k = kategorieVon(p.category);
    var marken = [];
    if (p.kind === 'video') marken.push('🎬');
    if (p.kind === 'message') marken.push('🎙️');
    if (k) marken.push(k.icon);
    if (marken.length) {
      var kat = document.createElement('span');
      kat.className = 'kat';
      kat.textContent = marken.join(' ');
      kat.title = [p.kind === 'photo' ? null : p.kind, k ? k.name : null]
        .filter(Boolean).join(' · ');
      tile.appendChild(kat);
    }

    if (auswahlModus) {
      var haken = document.createElement('span');
      haken.className = 'haken';
      haken.textContent = '✓';
      tile.appendChild(haken);
      if (gewaehlt[p.id]) tile.classList.add('gewaehlt');
    }

    tile.addEventListener('click', function () {
      // Im Auswahlmodus sammelt ein Tipp, sonst blendet er aus.
      if (auswahlModus) {
        if (gewaehlt[p.id]) delete gewaehlt[p.id];
        else gewaehlt[p.id] = true;
        tile.classList.toggle('gewaehlt', !!gewaehlt[p.id]);
        auswahlLeisteZeigen();
        return;
      }
      var newHidden = !photos.get(p.id).hidden;
      api('/api/mod/hide', { id: p.id, hidden: newHidden }).then(function () {
        photos.get(p.id).hidden = newHidden;
        var fresh = makeTile(photos.get(p.id));
        tile.replaceWith(fresh);
        renderChips();
      }).catch(function () {});
    });
    return tile;
  }

  function renderGrid() {
    elGrid.textContent = '';
    // Neueste zuerst – IDs sind zeitlich sortierbar.
    Array.from(photos.values())
      .sort(function (a, b) { return b.id.localeCompare(a.id); })
      .forEach(function (p) { elGrid.appendChild(makeTile(p)); });
  }

  // ------------------------------------------------------------ Steuerung

  btnPause.addEventListener('click', function () {
    api('/api/mod/control', { action: state.paused ? 'resume' : 'pause' })
      .then(function (r) { state = r.state; renderChips(); });
  });
  document.getElementById('btnSkip').addEventListener('click', function () {
    api('/api/mod/control', { action: 'skip' });
  });
  btnQuiet.addEventListener('click', function () {
    api('/api/mod/control', {
      action: 'mode',
      mode: state.mode === 'quiet' ? 'normal' : 'quiet',
    }).then(function (r) { state = r.state; renderChips(); });
  });
  btnGallery.addEventListener('click', function () {
    var opening = !state.galleryOpen;
    if (!confirm(opening
      ? 'Galerie für alle Gäste öffnen?'
      : 'Galerie wieder schliessen?')) return;
    api('/api/mod/gallery', { open: opening })
      .then(function (r) { state = r.state; renderChips(); });
  });
  document.getElementById('btnRecap').addEventListener('click', function () {
    if (!confirm('Mitternachts-Rückblick auf der Fotowand starten?\n\n' +
      'Dauert je nach Fotomenge etwa 4–6 Minuten und endet mit den ' +
      'Auszeichnungen. Danach läuft die normale Fotowand weiter.')) return;
    api('/api/mod/control', { action: 'recap' });
  });

  document.getElementById('btnReload').addEventListener('click', function () {
    api('/api/mod/control', { action: 'reload' });
  });

  // ------------------------------------------------------------ Aufgaben-Editor

  var elEditor = document.getElementById('chalEditor');
  var elRows = document.getElementById('chalRows');
  var elChalStatus = document.getElementById('chalStatus');

  function chalStatus(text, cls) {
    elChalStatus.textContent = text || '';
    elChalStatus.className = 'status' + (cls ? ' ' + cls : '');
  }

  // Neue Zeilen bekommen eine id aus dem Text. Bestehende behalten ihre id
  // auch beim Umformulieren – sonst verlieren hochgeladene Fotos die
  // Zuordnung und der "Aufgabenjäger" zählt falsch.
  function slugFor(text) {
    var base = text.toLowerCase()
      .replace(/[äöüß]/g, function (c) {
        return { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c];
      })
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    return (base || 'aufgabe') + '-' + Math.random().toString(36).slice(2, 6);
  }

  function addRow(item) {
    var li = document.createElement('li');
    li.dataset.id = item.id || '';

    var icon = document.createElement('input');
    icon.type = 'text';
    icon.className = 'icon';
    icon.maxLength = 8;
    icon.value = item.icon || '📷';

    var text = document.createElement('input');
    text.type = 'text';
    text.className = 'text';
    text.maxLength = 120;
    text.value = item.text || '';
    text.placeholder = 'Aufgabe beschreiben …';

    var del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Aufgabe entfernen';
    del.addEventListener('click', function () {
      li.remove();
      chalStatus('Nicht vergessen: Speichern.');
    });

    li.appendChild(icon);
    li.appendChild(text);
    li.appendChild(del);
    elRows.appendChild(li);
    return li;
  }

  function fillEditor(list) {
    elRows.textContent = '';
    list.forEach(addRow);
  }

  function collectRows() {
    return Array.prototype.map.call(elRows.children, function (li) {
      var text = li.querySelector('.text').value.trim();
      return {
        id: li.dataset.id || slugFor(text || 'aufgabe'),
        icon: li.querySelector('.icon').value.trim() || '📷',
        text: text,
      };
    }).filter(function (c) { return c.text; });
  }

  document.getElementById('btnEditChal').addEventListener('click', function () {
    var opening = elEditor.classList.contains('hidden');
    elEditor.classList.toggle('hidden', !opening);
    if (opening) {
      chalStatus('');
      Challenges.load().then(function (list) {
        fillEditor(list);
        elEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });

  document.getElementById('btnAddChal').addEventListener('click', function () {
    var li = addRow({ icon: '📷', text: '' });
    li.querySelector('.text').focus();
  });

  document.getElementById('btnSaveChal').addEventListener('click', function () {
    var list = collectRows();
    if (!list.length) { chalStatus('Mindestens eine Aufgabe angeben.', 'err'); return; }
    chalStatus('Wird gespeichert …');
    api('/api/mod/challenges', { challenges: list }).then(function (r) {
      Challenges.adopt(r.challenges);
      fillEditor(r.challenges);
      chalStatus('✓ Gespeichert – alle Gästehandys sind aktualisiert.', 'ok');
    }).catch(function () { chalStatus('Speichern fehlgeschlagen.', 'err'); });
  });

  document.getElementById('btnResetChal').addEventListener('click', function () {
    if (!confirm('Aufgabenliste auf den Standard zurücksetzen?')) return;
    api('/api/mod/challenges/reset', {}).then(function (r) {
      Challenges.adopt(r.challenges);
      fillEditor(r.challenges);
      chalStatus('✓ Standardliste wiederhergestellt.', 'ok');
    }).catch(function () { chalStatus('Zurücksetzen fehlgeschlagen.', 'err'); });
  });

  // ------------------------------------------------------------ Begrüssung

  var elGrussEditor = document.getElementById('grussEditor');
  var elGrussStatus = document.getElementById('grussStatus');

  function grussStatus(text, cls) {
    elGrussStatus.textContent = text || '';
    elGrussStatus.className = 'status' + (cls ? ' ' + cls : '');
  }

  document.getElementById('btnGruss').addEventListener('click', function () {
    var oeffnen = elGrussEditor.classList.contains('hidden');
    elGrussEditor.classList.toggle('hidden', !oeffnen);
    if (!oeffnen) return;
    grussStatus('');
    fetch('/api/feed').then(function (r) { return r.json(); })
      .then(function (f) {
        document.getElementById('grussTitelFeld').value = (f.gruss && f.gruss.titel) || '';
        document.getElementById('grussTextFeld').value = (f.gruss && f.gruss.text) || '';
        elGrussEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }).catch(function () {});
  });

  document.getElementById('btnGrussSave').addEventListener('click', function () {
    grussStatus('Wird gespeichert …');
    api('/api/mod/gruss', {
      titel: document.getElementById('grussTitelFeld').value,
      text: document.getElementById('grussTextFeld').value,
    }).then(function (r) {
      document.getElementById('grussTitelFeld').value = r.gruss.titel;
      document.getElementById('grussTextFeld').value = r.gruss.text;
      grussStatus('✓ Gespeichert – die Galerie zeigt es sofort.', 'ok');
    }).catch(function () { grussStatus('Speichern fehlgeschlagen.', 'err'); });
  });

  document.getElementById('btnGrussReset').addEventListener('click', function () {
    document.getElementById('grussTitelFeld').value = '';
    document.getElementById('grussTextFeld').value = '';
    api('/api/mod/gruss', { titel: '', text: '' }).then(function (r) {
      document.getElementById('grussTitelFeld').value = r.gruss.titel;
      document.getElementById('grussTextFeld').value = r.gruss.text;
      grussStatus('✓ Vorschlag wiederhergestellt.', 'ok');
    }).catch(function () { grussStatus('Fehlgeschlagen.', 'err'); });
  });

  // ------------------------------------------------------------ Kategorien

  function kategorieVon(id) {
    for (var i = 0; i < kategorien.length; i++) {
      if (kategorien[i].id === id) return kategorien[i];
    }
    return null;
  }

  function katAuswahlFuellen(select, mitLeer) {
    select.textContent = '';
    if (mitLeer) {
      var leer = document.createElement('option');
      leer.value = '';
      leer.textContent = '— keine Kategorie —';
      select.appendChild(leer);
    }
    kategorien.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.icon + ' ' + k.name;
      select.appendChild(o);
    });
  }

  function ladeKategorien() {
    return fetch('/api/categories')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        kategorien = d.kategorien || [];
        katAuswahlFuellen(document.getElementById('katWahl'), true);
        katAuswahlFuellen(document.getElementById('katWahlZeit'), true);
        return kategorien;
      })
      .catch(function () { return []; });
  }

  // ---- Editor
  var elKatEditor = document.getElementById('katEditor');
  var elKatRows = document.getElementById('katRows');
  var elKatStatus = document.getElementById('katStatus');

  function katStatus(text, cls) {
    elKatStatus.textContent = text || '';
    elKatStatus.className = 'status' + (cls ? ' ' + cls : '');
  }

  function katZeile(item) {
    var li = document.createElement('li');
    li.dataset.id = item.id || '';

    var icon = document.createElement('input');
    icon.type = 'text';
    icon.className = 'icon';
    icon.maxLength = 8;
    icon.value = item.icon || '📁';

    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'text';
    name.maxLength = 40;
    name.value = item.name || '';
    name.placeholder = 'Name der Kategorie …';

    var del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '✕';
    del.addEventListener('click', function () {
      li.remove();
      katStatus('Nicht vergessen: Speichern.');
    });

    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(del);
    elKatRows.appendChild(li);
    return li;
  }

  function katEditorFuellen(liste) {
    elKatRows.textContent = '';
    liste.forEach(katZeile);
  }

  function katSammeln() {
    return Array.prototype.map.call(elKatRows.children, function (li) {
      var name = li.querySelector('.text').value.trim();
      return {
        id: li.dataset.id || slugFor(name || 'kategorie'),
        icon: li.querySelector('.icon').value.trim() || '📁',
        name: name,
      };
    }).filter(function (k) { return k.name; });
  }

  document.getElementById('btnKat').addEventListener('click', function () {
    var oeffnen = elKatEditor.classList.contains('hidden');
    elKatEditor.classList.toggle('hidden', !oeffnen);
    if (oeffnen) {
      katStatus('');
      ladeKategorien().then(function (liste) {
        katEditorFuellen(liste);
        elKatEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });

  document.getElementById('btnAddKat').addEventListener('click', function () {
    katZeile({ icon: '📁', name: '' }).querySelector('.text').focus();
  });

  document.getElementById('btnSaveKat').addEventListener('click', function () {
    var liste = katSammeln();
    if (!liste.length) { katStatus('Mindestens eine Kategorie angeben.', 'err'); return; }
    katStatus('Wird gespeichert …');
    api('/api/mod/categories', { kategorien: liste }).then(function (r) {
      kategorien = r.kategorien;
      katEditorFuellen(kategorien);
      katAuswahlFuellen(document.getElementById('katWahl'), true);
      katAuswahlFuellen(document.getElementById('katWahlZeit'), true);
      renderGrid();
      katStatus('✓ Gespeichert.', 'ok');
    }).catch(function () { katStatus('Speichern fehlgeschlagen.', 'err'); });
  });

  document.getElementById('btnResetKat').addEventListener('click', function () {
    if (!confirm('Kategorien auf den Standard zurücksetzen?')) return;
    api('/api/mod/categories/reset', {}).then(function (r) {
      kategorien = r.kategorien;
      katEditorFuellen(kategorien);
      katAuswahlFuellen(document.getElementById('katWahl'), true);
      katAuswahlFuellen(document.getElementById('katWahlZeit'), true);
      katStatus('✓ Standard wiederhergestellt.', 'ok');
    }).catch(function () { katStatus('Zurücksetzen fehlgeschlagen.', 'err'); });
  });

  // ---- Zeitraum zuordnen
  document.getElementById('btnKatZeit').addEventListener('click', function () {
    var elZeitStatus = document.getElementById('katZeitStatus');
    var von = document.getElementById('katVon').value;
    var bis = document.getElementById('katBis').value;
    if (!von || !bis) {
      elZeitStatus.textContent = 'Bitte Von und Bis ausfüllen.';
      elZeitStatus.className = 'status err';
      return;
    }
    var kat = document.getElementById('katWahlZeit').value;
    elZeitStatus.className = 'status';
    elZeitStatus.textContent = 'Wird zugeordnet …';
    api('/api/mod/category', {
      category: kat,
      von: new Date(von).getTime(),
      bis: new Date(bis).getTime(),
    }).then(function (r) {
      (r.ids || []).forEach(function (id) {
        var p = photos.get(id);
        if (p) p.category = kat || null;
      });
      renderGrid();
      elZeitStatus.textContent = r.geaendert + ' Beiträge zugeordnet.';
      elZeitStatus.className = 'status ok';
    }).catch(function () {
      elZeitStatus.textContent = 'Zuordnen fehlgeschlagen.';
      elZeitStatus.className = 'status err';
    });
  });

  // ------------------------------------------------------------ Mehrfachauswahl

  var elLeiste = document.getElementById('auswahlLeiste');
  var elAuswahlZahl = document.getElementById('auswahlZahl');

  function auswahlIds() { return Object.keys(gewaehlt); }

  function auswahlLeisteZeigen() {
    var n = auswahlIds().length;
    elAuswahlZahl.textContent = n === 1 ? '1 ausgewählt' : n + ' ausgewählt';
    elLeiste.classList.toggle('hidden', !auswahlModus);
    document.body.classList.toggle('auswahl-offen', auswahlModus);
  }

  function auswahlBeenden() {
    auswahlModus = false;
    gewaehlt = {};
    elGrid.classList.remove('waehlen');
    elLeiste.classList.add('hidden');
    document.getElementById('btnAuswahl').classList.remove('active-state');
    renderGrid();
  }

  document.getElementById('btnAuswahl').addEventListener('click', function () {
    auswahlModus = !auswahlModus;
    gewaehlt = {};
    elGrid.classList.toggle('waehlen', auswahlModus);
    this.classList.toggle('active-state', auswahlModus);
    auswahlLeisteZeigen();
    renderGrid();
  });

  document.getElementById('btnAuswahlEnde').addEventListener('click', auswahlBeenden);

  document.getElementById('btnKatZuweisen').addEventListener('click', function () {
    var ids = auswahlIds();
    if (!ids.length) return;
    var kat = document.getElementById('katWahl').value;
    api('/api/mod/category', { ids: ids, category: kat }).then(function () {
      ids.forEach(function (id) {
        var p = photos.get(id);
        if (p) p.category = kat || null;
      });
      auswahlBeenden();
    }).catch(function () {});
  });

  document.getElementById('btnAuswahlAus').addEventListener('click', function () {
    var ids = auswahlIds();
    if (!ids.length) return;
    if (!confirm(ids.length + ' Beiträge ausblenden?')) return;
    api('/api/mod/hide-many', { ids: ids, hidden: true }).then(function () {
      ids.forEach(function (id) {
        var p = photos.get(id);
        if (p) p.hidden = true;
      });
      auswahlBeenden();
      renderChips();
    }).catch(function () {});
  });

  // ------------------------------------------------------------ Nach der Feier

  var elNach = document.getElementById('nachEditor');
  var elNachStatus = document.getElementById('nachStatus');
  var elNachErgebnis = document.getElementById('nachErgebnis');

  function nachStatus(text, cls) {
    elNachStatus.textContent = text || '';
    elNachStatus.className = 'status' + (cls ? ' ' + cls : '');
  }

  function mb(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    return Math.round(bytes / 1048576) + ' MB';
  }

  document.getElementById('btnNach').addEventListener('click', function () {
    var oeffnen = elNach.classList.contains('hidden');
    elNach.classList.toggle('hidden', !oeffnen);
    if (oeffnen) {
      nachStatus('');
      elNachErgebnis.textContent = '';
      elNach.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pruefeDownloads();
    }
  });

  /* Eine Gruppe (Serie oder Duplikate) darstellen.
   *
   * Grün umrandet = wird behalten, blass und rot = fliegt raus. Ein Tipp
   * auf ein Bild schaltet um, der Knopf übernimmt die ganze Gruppe.
   */
  function gruppeZeigen(titel, ids, behaltenId) {
    var box = document.createElement('div');
    box.className = 'gruppe';

    var kopf = document.createElement('div');
    kopf.className = 'kopf';
    var text = document.createElement('span');
    text.textContent = titel;
    kopf.appendChild(text);

    var uebernehmen = document.createElement('button');
    uebernehmen.className = 'btn';
    uebernehmen.textContent = 'Auswahl übernehmen';
    kopf.appendChild(uebernehmen);
    box.appendChild(kopf);

    var reihe = document.createElement('div');
    reihe.className = 'reihe';

    var behalten = {};
    ids.forEach(function (id) { behalten[id] = (id === behaltenId); });

    ids.forEach(function (id) {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = '/i/' + id + '-t.jpg';
      img.alt = '';
      function male() {
        img.className = behalten[id] ? 'behalten' : 'weg';
      }
      male();
      img.addEventListener('click', function () {
        behalten[id] = !behalten[id];
        male();
      });
      reihe.appendChild(img);
    });
    box.appendChild(reihe);

    uebernehmen.addEventListener('click', function () {
      var weg = ids.filter(function (id) { return !behalten[id]; });
      if (!weg.length) { box.remove(); return; }
      uebernehmen.disabled = true;
      api('/api/mod/hide-many', { ids: weg, hidden: true }).then(function () {
        weg.forEach(function (id) {
          var p = photos.get(id);
          if (p) p.hidden = true;
          var kachel = elGrid.querySelector('[data-id="' + id + '"]');
          if (kachel && p) kachel.replaceWith(makeTile(p));
        });
        renderChips();
        box.remove();
      }).catch(function () { uebernehmen.disabled = false; });
    });

    return box;
  }

  document.getElementById('btnSerien').addEventListener('click', function () {
    nachStatus('Serien werden gesucht …');
    elNachErgebnis.textContent = '';
    fetch('/api/mod/serien', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var serien = d.serien || [];
        if (!serien.length) {
          nachStatus('Keine Serien gefunden.', 'ok');
          return;
        }
        var fotos = serien.reduce(function (n, g) { return n + g.ids.length; }, 0);
        nachStatus(serien.length + ' Serien mit zusammen ' + fotos +
          ' Aufnahmen. Antippen wählt aus, der Knopf übernimmt.');
        serien.forEach(function (g) {
          var wann = new Date(g.von).toLocaleTimeString('de-AT',
            { hour: '2-digit', minute: '2-digit' });
          elNachErgebnis.appendChild(gruppeZeigen(
            g.ids.length + ' Aufnahmen von ' + g.uploader + ' um ' + wann +
            ' (in ' + g.sekunden + ' s)', g.ids, g.ids[0]));
        });
      })
      .catch(function () { nachStatus('Suche fehlgeschlagen.', 'err'); });
  });

  document.getElementById('btnDupes').addEventListener('click', function () {
    elNachErgebnis.textContent = '';
    nachStatus('Prüfsummen werden berechnet – das dauert bei vielen Originalen.');

    api('/api/mod/hashes', {}).then(function () {
      // Fortschritt verfolgen, bis alles durch ist.
      var timer = setInterval(function () {
        fetch('/api/mod/duplikate', { headers: { 'x-mod-key': key } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.laeuft) {
              nachStatus('Prüfsummen: ' + d.fertig + ' von ' + d.gesamt + ' …');
              return;
            }
            clearInterval(timer);
            var gruppen = d.gruppen || [];
            if (!gruppen.length) {
              nachStatus('Keine doppelten Dateien gefunden.', 'ok');
              return;
            }
            var doppelt = gruppen.reduce(function (n, g) { return n + g.weg.length; }, 0);
            nachStatus(gruppen.length + ' Gruppen, ' + doppelt +
              ' überzählige Dateien. Voreinstellung: das älteste bleibt.');
            gruppen.forEach(function (g) {
              var alle = [g.behalten].concat(g.weg);
              elNachErgebnis.appendChild(gruppeZeigen(
                alle.length + '× dieselbe Datei (' + g.uploader.join(', ') + ')',
                alle, g.behalten));
            });
          })
          .catch(function () { clearInterval(timer); });
      }, 1200);
    }).catch(function () { nachStatus('Start fehlgeschlagen.', 'err'); });
  });

  function paketeZeigen(d) {
    elNachErgebnis.textContent = '';
    var pakete = (d.pakete && d.pakete.pakete) || [];
    if (!pakete.length) return;

    var liste = document.createElement('ul');
    liste.className = 'paketliste';
    var summe = 0;
    pakete.forEach(function (p) {
      summe += p.bytes;
      var li = document.createElement('li');
      var t = document.createElement('span');
      t.className = 'titel';
      t.textContent = p.titel;
      var m = document.createElement('span');
      m.className = 'meta';
      m.textContent = p.anzahl + ' Dateien · ' + mb(p.bytes);
      li.appendChild(t);
      li.appendChild(m);
      liste.appendChild(li);
    });
    elNachErgebnis.appendChild(liste);

    var fuss = document.createElement('p');
    fuss.className = 'hint-left';
    fuss.textContent = 'Zusammen ' + mb(summe) +
      '. Die Gäste sehen diese Pakete in der Galerie, sobald sie offen ist.';
    elNachErgebnis.appendChild(fuss);
  }

  function pruefeDownloads() {
    fetch('/api/mod/downloads', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.laeuft) {
          nachStatus('Pakete werden gebaut: ' + d.schritt +
            ' (' + d.fertig + ' von ' + d.gesamt + ' Dateien)');
          setTimeout(pruefeDownloads, 1500);
          return;
        }
        if (d.fehler) { nachStatus('Fehler: ' + d.fehler, 'err'); return; }
        if (d.pakete && d.pakete.gebaut) {
          var wann = new Date(d.pakete.gebaut).toLocaleString('de-AT');
          nachStatus('Pakete vom ' + wann + ' liegen bereit.', 'ok');
          paketeZeigen(d);
        }
      })
      .catch(function () {});
  }

  /* Handy-Versionen der Videos.
   *
   * Auf iOS führt der einzige Weg in die Fotos-App über die
   * Web-Share-Schnittstelle, und die verlangt die Datei komplett im
   * Speicher. Ein 300-MB-Video scheitert daran. Eine kleiner gerechnete
   * Fassung löst genau das.
   */
  function handyStand() {
    fetch('/api/mod/handyversionen', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.moeglich === false) {
          nachStatus('ffmpeg ist im Container nicht vorhanden – bitte neu ' +
            'bauen (docker compose up -d --build).', 'err');
          return;
        }
        if (d.laeuft) {
          nachStatus('Handy-Versionen: ' + d.fertig + ' von ' + d.gesamt +
            ' · gerade ' + (d.schritt || '…'));
          setTimeout(handyStand, 2000);
          return;
        }
        if (d.gesamt > 0 && d.schritt === 'fertig') {
          nachStatus('✓ ' + d.gesamt + ' Handy-Versionen erzeugt.', 'ok');
        } else if (d.offen === 0) {
          nachStatus('Alle Videos haben bereits eine Handy-Version.', 'ok');
        } else {
          nachStatus(d.offen + ' Videos hätten gern eine Handy-Version.');
        }
      })
      .catch(function () {});
  }

  document.getElementById('btnHandy').addEventListener('click', function () {
    elNachErgebnis.textContent = '';
    fetch('/api/mod/handyversionen', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.moeglich === false) {
          nachStatus('ffmpeg fehlt im Container – bitte neu bauen.', 'err');
          return;
        }
        if (d.laeuft) { handyStand(); return; }
        if (!d.offen) {
          nachStatus('Alle Videos haben bereits eine Handy-Version.', 'ok');
          return;
        }
        if (!confirm(d.offen + ' Videos bekommen eine kleinere Fassung, damit ' +
          'sie sich auf dem Handy direkt in die Fotos-App sichern lassen.\n\n' +
          'Das rechnet der Server im Hintergrund – je nach Menge dauert es ' +
          'eine Weile. Die Originale bleiben unangetastet.')) return;
        nachStatus('Wird gestartet …');
        api('/api/mod/handyversionen', {}).then(handyStand)
          .catch(function () { nachStatus('Start fehlgeschlagen.', 'err'); });
      })
      .catch(function () { nachStatus('Abruf fehlgeschlagen.', 'err'); });
  });

  // Auswahl der Pakete – wird vor dem Bau gezeigt und laufend nachgerechnet.
  var bauWahl = { klein: true, fotos: true, videos: true, kategorien: true, teilMB: 1500 };

  function vorschauZeigen() {
    var frage = '/api/mod/downloads/vorschau?teilMB=' + bauWahl.teilMB;
    fetch(frage, { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        elNachErgebnis.textContent = '';

        // Kästchen für die Auswahl
        var box = document.createElement('div');
        box.className = 'bauwahl';
        var arten = [
          ['klein', 'Kleine Version (Bildschirmgrösse)'],
          ['fotos', 'Fotos in Originalgrösse'],
          ['videos', 'Videos'],
          ['kategorien', 'Ein Paket je Kategorie'],
        ];
        arten.forEach(function (a) {
          var lab = document.createElement('label');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = bauWahl[a[0]];
          cb.addEventListener('change', function () {
            bauWahl[a[0]] = cb.checked;
            zeichneListe(v);
          });
          var txt = document.createElement('span');
          txt.textContent = a[1];
          var zahl = document.createElement('span');
          zahl.className = 'zahl';
          var passend = v.pakete.filter(function (p) { return p.art === a[0].replace(/n$/, ''); });
          if (a[0] === 'klein') passend = v.pakete.filter(function (p) { return p.art === 'klein'; });
          if (a[0] === 'fotos') passend = v.pakete.filter(function (p) { return p.art === 'foto'; });
          if (a[0] === 'videos') passend = v.pakete.filter(function (p) { return p.art === 'video'; });
          if (a[0] === 'kategorien') passend = v.pakete.filter(function (p) { return p.art === 'kategorie'; });
          zahl.textContent = passend.length
            ? passend.length + (passend.length === 1 ? ' Paket' : ' Pakete')
            : 'nichts vorhanden';
          lab.appendChild(cb);
          lab.appendChild(txt);
          lab.appendChild(zahl);
          box.appendChild(lab);
        });

        var teil = document.createElement('div');
        teil.className = 'teilzeile';
        var tl = document.createElement('span');
        tl.textContent = 'Grösse je Teil:';
        var ti = document.createElement('input');
        ti.type = 'number';
        ti.min = '100';
        ti.max = '8000';
        ti.step = '100';
        ti.value = String(bauWahl.teilMB);
        var te = document.createElement('span');
        te.textContent = 'MB';
        ti.addEventListener('change', function () {
          var n = Number(ti.value);
          bauWahl.teilMB = (n >= 100 && n <= 8000) ? n : 1500;
          ti.value = String(bauWahl.teilMB);
          vorschauZeigen();
        });
        teil.appendChild(tl); teil.appendChild(ti); teil.appendChild(te);
        box.appendChild(teil);
        elNachErgebnis.appendChild(box);

        var liste = document.createElement('ul');
        liste.className = 'paketliste';
        elNachErgebnis.appendChild(liste);

        var summe = document.createElement('p');
        summe.className = 'bausumme';
        elNachErgebnis.appendChild(summe);

        var los = document.createElement('button');
        los.className = 'btn primary';
        los.textContent = '📦 Jetzt bauen';
        los.addEventListener('click', function () {
          if (!confirm('Pakete jetzt bauen?\n\n' +
            'Braucht kurzzeitig noch einmal so viel Plattenplatz wie die ' +
            'ausgewählten Dateien und dauert je nach Menge einige Minuten.')) return;
          elNachErgebnis.textContent = '';
          nachStatus('Pakete werden gebaut …');
          api('/api/mod/downloads', bauWahl).then(function () { pruefeDownloads(); })
            .catch(function () { nachStatus('Start fehlgeschlagen.', 'err'); });
        });
        elNachErgebnis.appendChild(los);

        function zeichneListe(vor) {
          var gewaehltePakete = vor.pakete.filter(function (p) {
            if (p.art === 'klein') return bauWahl.klein;
            if (p.art === 'foto') return bauWahl.fotos;
            if (p.art === 'video') return bauWahl.videos;
            if (p.art === 'kategorie') return bauWahl.kategorien;
            return true;
          });
          liste.textContent = '';
          gewaehltePakete.forEach(function (p) {
            var li = document.createElement('li');
            var t = document.createElement('span');
            t.className = 'titel';
            t.textContent = p.titel;
            var m = document.createElement('span');
            m.className = 'meta';
            m.textContent = p.anzahl + ' Dateien · ' + mb(p.bytes);
            li.appendChild(t);
            li.appendChild(m);
            liste.appendChild(li);
          });
          var gesamt = gewaehltePakete.reduce(function (n, p) { return n + p.bytes; }, 0);
          summe.textContent = gewaehltePakete.length + ' Pakete, zusammen ' +
            mb(gesamt) + ' – so viel Plattenplatz wird zusätzlich gebraucht.';
        }

        zeichneListe(v);
        nachStatus('Vorschau: so würden die Pakete aussehen.');
      })
      .catch(function () { nachStatus('Vorschau fehlgeschlagen.', 'err'); });
  }

  document.getElementById('btnDownloads').addEventListener('click', vorschauZeigen);

  /* Grosse Originale nachreichen.
   *
   * Die Datei geht in 8-MB-Stücken hoch. Dadurch spielt die Grösse keine
   * Rolle mehr – weder Multer noch Caddy sehen je mehr als ein Stück –
   * und ein Abbruch kostet höchstens ein Stück statt der ganzen Datei.
   */
  var TEIL = 8 * 1024 * 1024;

  function nachreichen(id, datei, melde) {
    return api('/api/mod/nachreichen/start', { id: id, dateiname: datei.name })
      .then(function (start) {
        if (!start.marke) throw new Error('kein Start');

        var pos = 0;
        function weiter() {
          if (pos >= datei.size) {
            return api('/api/mod/nachreichen/fertig', { marke: start.marke });
          }
          var ende = Math.min(pos + TEIL, datei.size);
          var stueck = datei.slice(pos, ende);
          return fetch('/api/mod/nachreichen/teil?marke=' +
              encodeURIComponent(start.marke), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-mod-key': key,
            },
            body: stueck,
          }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            pos = ende;
            melde(pos / datei.size);
            return weiter();
          });
        }
        return weiter();
      });
  }

  function fehlendeZeile(p) {
    var li = document.createElement('li');

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/i/' + p.id + '-t.jpg';
    img.alt = '';
    li.appendChild(img);

    var rest = document.createElement('div');
    rest.className = 'rest';

    var wer = document.createElement('div');
    wer.className = 'wer';
    wer.textContent = (p.kind === 'photo' ? '📷 ' : p.kind === 'message' ? '🎙️ ' : '🎬 ')
      + p.uploader;

    var wann = document.createElement('div');
    wann.className = 'wann';
    wann.textContent = new Date(p.effectiveAt || p.uploadedAt)
      .toLocaleString('de-AT', { day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit' });

    var stand = document.createElement('div');
    stand.className = 'fortschritt';
    if (p.ohneOriginal) stand.textContent = '– als „kein Original" abgehakt';

    rest.appendChild(wer);
    rest.appendChild(wann);
    rest.appendChild(stand);
    li.appendChild(rest);

    var label = document.createElement('label');
    label.className = 'btn';
    label.textContent = '📁 Datei';
    var eingabe = document.createElement('input');
    eingabe.type = 'file';
    eingabe.accept = 'image/*,video/*';
    eingabe.hidden = true;
    label.appendChild(eingabe);
    li.appendChild(label);

    // Manche Aufnahmen bekommen nie ein Original – ohne diesen Knopf
    // stünden sie für immer auf der Liste.
    var keins = document.createElement('button');
    keins.className = 'btn';
    keins.type = 'button';
    keins.textContent = '✕ keins';
    keins.title = 'Kein Original vorhanden oder gewünscht – von der Liste nehmen';
    keins.textContent = p.ohneOriginal ? '↩ zurück' : '✕ keins';
    keins.title = p.ohneOriginal
      ? 'Doch wieder auf die Liste nehmen'
      : 'Kein Original vorhanden oder gewünscht – von der Liste nehmen';
    keins.addEventListener('click', function () {
      keins.disabled = true;
      var neu = !p.ohneOriginal;
      api('/api/mod/kein-original', { id: p.id, skip: neu }).then(function () {
        p.ohneOriginal = neu;
        stand.className = neu ? 'fertig' : 'fortschritt';
        stand.textContent = neu ? '– kein Original' : '';
        keins.textContent = neu ? '↩ zurück' : '✕ keins';
        keins.disabled = false;
      }).catch(function () { keins.disabled = false; });
    });
    li.appendChild(keins);

    eingabe.addEventListener('change', function () {
      var datei = eingabe.files && eingabe.files[0];
      if (!datei) return;
      label.classList.add('disabled');
      eingabe.disabled = true;
      stand.textContent = 'lädt 0 %';

      nachreichen(p.id, datei, function (anteil) {
        stand.textContent = 'lädt ' + Math.round(anteil * 100) + ' %';
      }).then(function (r) {
        stand.className = 'fertig';
        var mb = Math.round((r.bytes || datei.size) / 1048576);
        stand.textContent = '✓ nachgereicht (' + mb + ' MB)';
        label.remove();
        keins.remove();          // „kein Original" ist damit erledigt
        p.ohneOriginal = false;
        var vorhanden = photos.get(p.id);
        if (vorhanden && r.photo) photos.set(p.id, Object.assign(vorhanden, r.photo));
      }).catch(function () {
        stand.textContent = '⚠️ fehlgeschlagen – nochmal versuchen';
        label.classList.remove('disabled');
        eingabe.disabled = false;
        eingabe.value = '';
      });
    });

    return li;
  }

  var zeigeAbgehakte = false;

  function fehlendeLaden() {
    elNachErgebnis.textContent = '';
    nachStatus('Wird geladen …');
    fetch('/api/mod/fehlende-originale' + (zeigeAbgehakte ? '?alle=1' : ''),
      { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var liste = d.eintraege || [];

        /* Der Umschalter muss IMMER erscheinen, wenn es abgehakte gibt –
         * auch dann, wenn gerade nichts offen ist. Sonst kommt man an sie
         * nicht mehr heran, sobald man alle abgehakt hat.
         */
        if (d.uebersprungen || zeigeAbgehakte) {
          var um = document.createElement('button');
          um.className = 'btn';
          um.textContent = zeigeAbgehakte
            ? '↩ nur die offenen zeigen'
            : '👁️ auch die ' + d.uebersprungen + ' abgehakten zeigen';
          um.addEventListener('click', function () {
            zeigeAbgehakte = !zeigeAbgehakte;
            fehlendeLaden();
          });
          elNachErgebnis.appendChild(um);
        }

        if (!liste.length) {
          nachStatus(zeigeAbgehakte
            ? 'Hier ist nichts – bei allen liegt ein Original vor.'
            : 'Bei allen offenen Beiträgen liegt das Original vor.' +
              (d.uebersprungen
                ? ' ' + d.uebersprungen + ' sind als „kein Original" abgehakt – ' +
                  'oben einblenden, falls doch noch eine Datei auftaucht.'
                : ''), 'ok');
          return;
        }

        var videos = liste.filter(function (p) { return p.kind !== 'photo'; }).length;
        nachStatus(liste.length + ' Beiträge ohne Original, davon ' + videos +
          ' Videos' +
          (d.uebersprungen && !zeigeAbgehakte
            ? ' · ' + d.uebersprungen + ' abgehakt' : '') +
          '. Datei auswählen – sie geht in Stücken hoch, die Grösse spielt ' +
          'keine Rolle.');

        var ul = document.createElement('ul');
        ul.className = 'fehlliste';
        liste.forEach(function (p) { ul.appendChild(fehlendeZeile(p)); });
        elNachErgebnis.appendChild(ul);
      })
      .catch(function () { nachStatus('Liste konnte nicht geladen werden.', 'err'); });
  }

  document.getElementById('btnFehlende').addEventListener('click', function () {
    zeigeAbgehakte = false;
    fehlendeLaden();
  });

  /* Verlauf des Abends.
   *
   * Quelle ist die Ereignistabelle der Datenbank, nicht das Docker-Log:
   * Sie überlebt Neustarts und wird nicht gedreht.
   */
  var ART_TEXT = {
    photo: 'hochgeladen',
    hide: 'ausgeblendet',
    update: 'geändert',
    control: 'Fotowand gesteuert',
    challenges: 'Aufgaben geändert',
    kategorien: 'Kategorien geändert',
    gruss: 'Begrüssung geändert',
  };

  /* Datum korrigieren.
   *
   * Aufnahmen ohne Metadaten erben das Dateidatum, und wiederhergestellte
   * Einträge das ihrer Datei – dann steht dort schnell „heute" statt des
   * Hochzeitstags. Verschoben wird effective_at, also das, wonach überall
   * sortiert wird; das ursprüngliche taken_at bleibt als Aufzeichnung
   * dessen stehen, was in der Datei stand.
   */
  document.getElementById('btnDatum').addEventListener('click', function () {
    elNachErgebnis.textContent = '';
    nachStatus('Tage werden gezählt …');
    fetch('/api/mod/datum', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var tage = d.tage || [];
        if (!tage.length) { nachStatus('Nichts vorhanden.', 'ok'); return; }

        nachStatus(tage.length === 1
          ? 'Alle Aufnahmen liegen auf einem Tag – nichts zu tun.'
          : tage.length + ' verschiedene Tage. Der Hochzeitstag ist ' +
            'hervorgehoben; alles andere lässt sich dorthin schieben.');

        var zeile = document.createElement('div');
        zeile.className = 'teilzeile';
        var lab = document.createElement('span');
        lab.textContent = 'Hochzeitstag:';
        var feld = document.createElement('input');
        feld.type = 'date';
        feld.value = d.vorschlag || '';
        zeile.appendChild(lab);
        zeile.appendChild(feld);
        elNachErgebnis.appendChild(zeile);

        var behalten = document.createElement('label');
        behalten.className = 'kastenzeile';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        var cbt = document.createElement('span');
        cbt.textContent = 'Uhrzeit beibehalten (empfohlen)';
        behalten.appendChild(cb);
        behalten.appendChild(cbt);
        elNachErgebnis.appendChild(behalten);

        var abend = document.createElement('label');
        abend.className = 'kastenzeile';
        var cb2 = document.createElement('input');
        cb2.type = 'checkbox';
        cb2.checked = true;
        var cb2t = document.createElement('span');
        cb2t.textContent = 'Dabei als Aufnahmen des Abends markieren (nicht „von früher")';
        abend.appendChild(cb2);
        abend.appendChild(cb2t);
        elNachErgebnis.appendChild(abend);

        var ul = document.createElement('ul');
        ul.className = 'tagliste';
        tage.forEach(function (t) {
          var li = document.createElement('li');
          if (t.tag === d.vorschlag) li.className = 'haupttag';
          if (t.tag === d.heute) li.className += ' heute';

          var tag = document.createElement('span');
          tag.className = 'tag';
          var dd = new Date(t.tag + 'T12:00:00');
          tag.textContent = dd.toLocaleDateString('de-AT', {
            weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
          }) + (t.tag === d.heute ? ' (heute)' : '');

          var anz = document.createElement('span');
          anz.className = 'anz';
          anz.textContent = t.anzahl + (t.anzahl === 1 ? ' Aufnahme' : ' Aufnahmen') +
            (t.archive ? ' · ' + t.archive + '× „von früher"' : '');

          li.appendChild(tag);
          li.appendChild(anz);

          if (t.tag !== d.vorschlag) {
            var knopf = document.createElement('button');
            knopf.className = 'btn';
            knopf.textContent = '→ auf den Hochzeitstag';
            knopf.addEventListener('click', function () {
              var ziel = feld.value;
              if (!ziel) { alert('Bitte zuerst den Hochzeitstag eintragen.'); return; }
              if (!confirm(t.anzahl + ' Aufnahmen vom ' + tag.textContent +
                ' auf den ' + ziel + ' verschieben?')) return;
              knopf.disabled = true;
              api('/api/mod/datum', {
                vonTag: t.tag,
                tag: ziel,
                uhrzeitBehalten: cb.checked,
                alsAbend: cb2.checked,
              }).then(function (r) {
                nachStatus(r.geaendert + ' Aufnahmen verschoben.', 'ok');
                li.remove();
                load();
              }).catch(function () {
                knopf.disabled = false;
                nachStatus('Verschieben fehlgeschlagen.', 'err');
              });
            });
            li.appendChild(knopf);
          }
          ul.appendChild(li);
        });
        elNachErgebnis.appendChild(ul);
      })
      .catch(function () { nachStatus('Abruf fehlgeschlagen.', 'err'); });
  });

  document.getElementById('btnVerlauf').addEventListener('click', function () {
    elNachErgebnis.textContent = '';
    nachStatus('Verlauf wird geladen …');
    fetch('/api/mod/verlauf?limit=300', { headers: { 'x-mod-key': key } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var zeilen = d.zeilen || [];
        if (!zeilen.length) { nachStatus('Noch kein Verlauf.', 'ok'); return; }
        nachStatus('Die letzten ' + zeilen.length + ' von ' + d.gesamt +
          ' Ereignissen, neueste zuerst.');

        var ul = document.createElement('ul');
        ul.className = 'verlauf';
        zeilen.forEach(function (z) {
          var li = document.createElement('li');
          if (z.art === 'photo') li.className = 'neu';
          if (z.art === 'hide' && z.hidden) li.className = 'weg';

          var zeit = document.createElement('span');
          zeit.className = 'zeit';
          zeit.textContent = new Date(z.zeit).toLocaleString('de-AT', {
            day: '2-digit', month: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });

          var was = document.createElement('span');
          was.className = 'was';
          var teile = [];
          if (z.kind) teile.push(z.kind === 'photo' ? '📷' : z.kind === 'video' ? '🎬' : '🎙️');
          teile.push(ART_TEXT[z.art] || z.art);
          if (z.art === 'hide' && z.hidden === false) teile[teile.length - 1] = 'wieder gezeigt';
          if (z.wer) teile.push('· ' + z.wer);
          was.textContent = teile.join(' ');

          li.appendChild(zeit);
          li.appendChild(was);
          ul.appendChild(li);
        });
        elNachErgebnis.appendChild(ul);
      })
      .catch(function () { nachStatus('Verlauf konnte nicht geladen werden.', 'err'); });
  });

  document.getElementById('btnPurge').addEventListener('click', function () {
    var versteckt = 0;
    photos.forEach(function (p) { if (p.hidden) versteckt++; });
    if (!versteckt) { nachStatus('Es ist nichts ausgeblendet.', 'ok'); return; }

    if (!confirm('WIRKLICH löschen?\n\n' + versteckt + ' ausgeblendete Beiträge ' +
      'werden mit allen Dateien endgültig entfernt. Das lässt sich nur aus ' +
      'einem Backup wiederherstellen.\n\nHast du ein aktuelles Backup?')) return;

    var wort = prompt('Zur Bestätigung bitte LOESCHEN eintippen:');
    if (wort !== 'LOESCHEN') { nachStatus('Abgebrochen.', ''); return; }

    api('/api/mod/loeschen', { bestaetigung: 'LOESCHEN' }).then(function (r) {
      nachStatus(r.eintraege + ' Beiträge und ' + r.dateien +
        ' Dateien entfernt.', 'ok');
      load();
    }).catch(function () { nachStatus('Löschen fehlgeschlagen.', 'err'); });
  });

  // ------------------------------------------------------------ Laden & Live

  function load() {
    return fetch('/api/mod/list?limit=2000', { headers: { 'x-mod-key': key } })
      .then(function (r) {
        if (r.status === 401) {
          localStorage.removeItem('modKey');
          document.body.textContent = 'Schlüssel ungültig – Seite neu laden.';
          throw new Error('401');
        }
        return r.json();
      })
      .then(function (d) {
        state = { paused: d.paused, mode: d.mode, galleryOpen: d.galleryOpen };
        gesamt = d.total || 0;
        photos.clear();
        d.photos.forEach(function (p) { photos.set(p.id, p); });
        renderGrid();
        renderChips();
      });
  }

  function connectSSE() {
    var es = new EventSource('/api/stream');
    es.addEventListener('photo', function (e) {
      var p = JSON.parse(e.data);
      p.hidden = false;
      photos.set(p.id, p);
      elGrid.insertBefore(makeTile(p), elGrid.firstChild);
      renderChips();
    });
    es.addEventListener('hide', function (e) {
      var d = JSON.parse(e.data);
      var p = photos.get(d.id);
      if (p) {
        p.hidden = d.hidden;
        var old = elGrid.querySelector('[data-id="' + d.id + '"]');
        if (old) old.replaceWith(makeTile(p));
        renderChips();
      }
    });
    es.addEventListener('update', function (e) {
      var p = JSON.parse(e.data);
      var known = photos.get(p.id);
      if (!known) return;
      photos.set(p.id, Object.assign({}, known, p));
      var old = elGrid.querySelector('[data-id="' + p.id + '"]');
      if (old) old.replaceWith(makeTile(photos.get(p.id)));
      renderChips();
    });
    es.addEventListener('kategorien', function (e) {
      kategorien = JSON.parse(e.data).kategorien || [];
      renderGrid();
    });
    es.addEventListener('control', function (e) {
      var c = JSON.parse(e.data);
      state = { paused: !!c.paused, mode: c.mode || 'normal', galleryOpen: !!c.galleryOpen };
      renderChips();
    });
  }

  function pollHealth() {
    fetch('/api/health').then(function (r) { return r.json(); })
      .then(function (h) { health = h; renderChips(); })
      .catch(function () {});
  }

  /* Sprung aus der Galerie: /mod?foto=<ID>
   *
   * Wer in der Galerie etwas entdeckt, das weg soll oder eine Kategorie
   * braucht, kommt von dort direkt hierher – ohne die Kachel unter 871
   * anderen suchen zu müssen.
   */
  function zuFotoSpringen() {
    var params = new URLSearchParams(location.search);
    var id = params.get('foto');
    if (!id) return;

    var p = photos.get(id);
    var leiste = document.createElement('div');
    leiste.className = 'sprungleiste';
    var txt = document.createElement('span');

    if (!p) {
      txt.textContent = 'Die Aufnahme aus der Galerie wurde nicht gefunden.';
    } else {
      txt.textContent = '↓ Aus der Galerie: ' + p.uploader + ' · ' +
        new Date(p.effectiveAt || p.uploadedAt).toLocaleString('de-AT', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
    }
    leiste.appendChild(txt);

    var zu = document.createElement('button');
    zu.className = 'btn';
    zu.textContent = '✕';
    zu.addEventListener('click', function () {
      leiste.remove();
      history.replaceState(null, '', '/mod');
    });
    leiste.appendChild(zu);
    elGrid.parentNode.insertBefore(leiste, elGrid);

    if (!p) return;
    var kachel = elGrid.querySelector('[data-id="' + id + '"]');
    if (!kachel) return;
    kachel.classList.add('gefunden');
    kachel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  ladeKategorien().then(function () {
    return load();
  }).then(function () {
    zuFotoSpringen();
    connectSSE();
  }).catch(function () {});
  pollHealth();
  setInterval(pollHealth, 60000);
})();

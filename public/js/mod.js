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

  function renderChips() {
    elChips.textContent = '';
    var visible = 0, hidden = 0;
    photos.forEach(function (p) { p.hidden ? hidden++ : visible++; });
    elChips.appendChild(chip('Sichtbar:', String(visible)));
    elChips.appendChild(chip('Versteckt:', String(hidden)));
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
    if (p.archive) {
      var a = document.createElement('span');
      a.className = 'vid';
      a.textContent = '📼';
      a.title = 'Mitgebrachtes Altfoto – zählt nicht zur Zeitachse des Abends';
      tile.appendChild(a);
    }
    tile.addEventListener('click', function () {
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

  // ------------------------------------------------------------ Laden & Live

  function load() {
    return fetch('/api/mod/list?limit=500', { headers: { 'x-mod-key': key } })
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

  load().then(connectSSE).catch(function () {});
  pollHealth();
  setInterval(pollHealth, 60000);
})();

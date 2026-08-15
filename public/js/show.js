/* Fotowand: Ambient-Rotation mit gewichtetem Zufall, Highlight-Warteschlange
 * für neue Fotos, Ken-Burns-Effekt, SSE-Live-Verbindung mit Nachholen.
 */
(function () {
  'use strict';

  var AMBIENT_MS = 7000;
  var HIGHLIGHT_MS = 12000;
  var HIGHLIGHT_FAST_MS = 7000; // wenn die Warteschlange voll läuft
  var QUEUE_FAST_AT = 4;
  var QUEUE_CAP = 12;
  var COOLDOWN_MS = 10 * 60 * 1000;

  var pool = new Map();      // id -> Foto (sichtbare)
  var queue = [];            // frisch hochgeladene, noch nicht gezeigte
  var lastShown = new Map(); // id -> Zeitstempel (nur diese Sitzung)
  var shownCounts = {};      // id -> Anzahl, persistiert in localStorage
  var paused = false;
  var mode = 'normal';
  var current = null;
  var timer = null;
  var idle = true;

  try { shownCounts = JSON.parse(localStorage.getItem('shownCounts') || '{}'); }
  catch (e) { shownCounts = {}; }
  var saveTimer = null;
  function bump(id) {
    shownCounts[id] = (shownCounts[id] || 0) + 1;
    lastShown.set(id, Date.now());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem('shownCounts', JSON.stringify(shownCounts)); }
      catch (e) { /* voll -> egal, ist nur Optimierung */ }
    }, 2000);
  }

  // ------------------------------------------------------------ DOM

  var layers = [document.getElementById('layerA'), document.getElementById('layerB')];
  var front = 0;
  var elBadge = document.getElementById('badge');
  var elCredit = document.getElementById('credit');
  var elCounter = document.getElementById('counter');
  var elPaused = document.getElementById('pausedIcon');
  var elOffline = document.getElementById('offlineIcon');
  var elWaiting = document.getElementById('waiting');
  document.getElementById('waitUrl').textContent =
    location.host;

  function updateCounter() {
    var ups = new Set();
    pool.forEach(function (p) { ups.add(p.uploader); });
    elCounter.textContent = pool.size
      ? pool.size + ' Fotos · ' + ups.size + ' Gäste'
      : '';
  }

  // ------------------------------------------------------------ Auswahl

  function pickAmbient() {
    var now = Date.now();
    var items = [];
    pool.forEach(function (p) { if (p.kind === 'photo') items.push(p); });
    if (!items.length) return null;
    if (items.length === 1) return items[0];

    var weights = [];
    var total = 0;
    items.forEach(function (p) {
      var ageMin = (now - (p.takenAt || p.uploadedAt)) / 60000;
      var fresh = 1 + 3 * Math.exp(-ageMin / 45);       // Neues zählt mehr
      var fatigue = 1 / (1 + (shownCounts[p.id] || 0)); // oft Gezeigtes weniger
      var last = lastShown.get(p.id) || 0;
      var cooldown = (now - last < COOLDOWN_MS) ? 0.05 : 1;
      var w = fresh * fatigue * cooldown;
      weights.push(w);
      total += w;
    });
    var r = Math.random() * total;
    for (var i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  // ------------------------------------------------------------ Anzeige

  function display(p, isHighlight, durMs) {
    var back = layers[1 - front];
    var img = back.querySelector('img');
    var bg = back.querySelector('.bg');
    var url = '/i/' + p.id + '-d.jpg';

    img.src = url;
    bg.style.backgroundImage = 'url("' + url + '")';

    return img.decode().catch(function () {}).then(function () {
      // Ken Burns: kaum wahrnehmbar = elegant.
      var s0 = 1.02 + Math.random() * 0.06;
      var s1 = s0 + 0.06 + Math.random() * 0.05;
      var pos = function () { return (Math.random() * 4 - 2).toFixed(2); };
      img.style.transition = 'none';
      img.style.transform = 'scale(' + s0 + ') translate(' + pos() + '%,' + pos() + '%)';
      void img.offsetWidth; // Reflow erzwingen, damit die Transition neu startet
      img.style.transition = 'transform ' + (durMs + 1600) + 'ms linear';
      img.style.transform = 'scale(' + s1 + ') translate(' + pos() + '%,' + pos() + '%)';

      back.classList.add('active');
      layers[front].classList.remove('active');
      front = 1 - front;
      current = p;

      // Badge & Credit
      if (isHighlight) {
        elBadge.textContent = '';
        var strong = document.createElement('b');
        strong.textContent = p.uploader;
        elBadge.appendChild(document.createTextNode(
          (p.kind === 'video' ? '🎬 ' : '✨ ') + 'Gerade eben von '));
        elBadge.appendChild(strong);
        if (p.caption) {
          var cap = document.createElement('span');
          cap.className = 'cap';
          cap.textContent = ' – ' + p.caption;
          elBadge.appendChild(cap);
        }
        elBadge.classList.add('on');
        elCredit.style.opacity = '0';
      } else {
        elBadge.classList.remove('on');
        elCredit.textContent = 'von ' + p.uploader;
        elCredit.style.opacity = '1';
      }
      bump(p.id);
    });
  }

  function setWaiting(on) {
    idle = on;
    elWaiting.classList.toggle('on', on);
  }

  function advance() {
    clearTimeout(timer);
    if (paused) return;

    var item = null;
    var isHl = false;
    if (mode !== 'quiet' && queue.length) {
      item = queue.shift();
      isHl = true;
      // Falls inzwischen versteckt: überspringen.
      if (!pool.has(item.id)) return advance();
    } else {
      item = pickAmbient();
    }

    if (!item) {
      setWaiting(true);
      timer = setTimeout(advance, 3000);
      return;
    }
    setWaiting(false);

    var dur = isHl
      ? (queue.length > QUEUE_FAST_AT ? HIGHLIGHT_FAST_MS : HIGHLIGHT_MS)
      : AMBIENT_MS;

    display(item, isHl, dur).then(function () {
      timer = setTimeout(advance, dur);
    });
  }

  // ------------------------------------------------------------ Events

  function onPhoto(p) {
    pool.set(p.id, p);
    updateCounter();
    // Vorladen, damit das Highlight ohne Ladepause startet.
    new Image().src = '/i/' + p.id + '-d.jpg';
    if (mode !== 'quiet') {
      queue.push(p);
      while (queue.length > QUEUE_CAP) queue.shift(); // Überlauf in den Pool
    }
    if (idle && !paused) advance();
  }

  function onHide(d) {
    if (d.hidden) {
      pool.delete(d.id);
      queue = queue.filter(function (p) { return p.id !== d.id; });
      if (current && current.id === d.id) advance();
    } else if (d.photo) {
      pool.set(d.photo.id, d.photo);
    }
    updateCounter();
  }

  function onControl(c) {
    if (c.reload) { location.reload(); return; }
    mode = c.mode || 'normal';
    var wasPaused = paused;
    paused = !!c.paused;
    elPaused.classList.toggle('on', paused);
    if (paused) {
      clearTimeout(timer); // aktuelles Bild bleibt stehen
    } else if (wasPaused || c.skip) {
      advance();
    }
  }

  // ------------------------------------------------------------ Verbindung

  function connect(afterSeq) {
    var es = new EventSource('/api/stream?after=' + afterSeq);
    var hadError = false;

    es.addEventListener('photo', function (e) { onPhoto(JSON.parse(e.data)); });
    es.addEventListener('hide', function (e) { onHide(JSON.parse(e.data)); });
    es.addEventListener('control', function (e) { onControl(JSON.parse(e.data)); });

    es.onerror = function () {
      hadError = true;
      elOffline.classList.add('on');
      // Die Show läuft aus dem Pool weiter – Browser reconnectet selbst.
    };
    es.onopen = function () {
      elOffline.classList.remove('on');
      if (hadError) {
        hadError = false;
        // Nach längerem Ausfall den kompletten Zustand abgleichen.
        loadFeed(false);
      }
    };
  }

  function loadFeed(firstTime) {
    return fetch('/api/feed')
      .then(function (r) { return r.json(); })
      .then(function (f) {
        pool.clear();
        f.photos.forEach(function (p) { pool.set(p.id, p); });
        mode = f.mode || 'normal';
        paused = !!f.paused;
        elPaused.classList.toggle('on', paused);
        updateCounter();
        if (firstTime) {
          connect(f.maxSeq);
          advance();
        }
      });
  }

  loadFeed(true).catch(function () {
    // Server nicht erreichbar: alle 5 s neu versuchen.
    var retry = setInterval(function () {
      loadFeed(true).then(function () { clearInterval(retry); }).catch(function () {});
    }, 5000);
  });

  // ------------------------------------------------------------ Bildschirm wach halten

  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen')
      .then(function (l) { wakeLock = l; })
      .catch(function () {});
  }
  keepAwake();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') keepAwake();
  });

  // Doppelklick: Vollbild umschalten (praktisch ohne Kiosk-Modus).
  document.addEventListener('dblclick', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () {});
  });
})();

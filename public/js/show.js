/* Fotowand.
 *
 * Ambient-Rotation mit gewichtetem Zufall und Wiederholsperre über einen
 * Ringpuffer (funktioniert auch bei sehr kleinem Foto-Pool), Highlight-
 * Warteschlange für neue Fotos, namentliche Begrüssung beim ersten Beitrag
 * eines Gastes, Ken-Burns-Effekt, Mitternachts-Rückblick mit Auszeichnungen
 * und SSE-Live-Verbindung mit Nachholen.
 */
(function () {
  'use strict';

  var AMBIENT_MS = 7000;
  var AMBIENT_SMALL_MS = 10000;  // ruhiger, wenn erst wenige Fotos da sind
  var SMALL_POOL = 12;
  var HIGHLIGHT_MS = 12000;
  var HIGHLIGHT_FAST_MS = 7000;
  var GREETING_MS = 9000;
  var QUEUE_FAST_AT = 4;
  var QUEUE_CAP = 12;
  var RECENT_CAP = 8;            // Obergrenze der Wiederholsperre

  var RECAP_PHOTO_MS = 6000;
  var RECAP_CARD_MS = 6000;

  var pool = new Map();     // id -> Foto (sichtbar)
  var queue = [];           // frisch hochgeladen, noch nicht gezeigt
  var recent = [];          // zuletzt gezeigte IDs (Ringpuffer)
  var shownCounts = {};     // id -> Anzahl, in localStorage gespiegelt
  var paused = false;
  var mode = 'normal';
  var current = null;
  var timer = null;
  var idle = true;
  var recapToken = 0;       // laufende Nummer, um alte Läufe abzubrechen
  var inRecap = false;

  try { shownCounts = JSON.parse(localStorage.getItem('shownCounts') || '{}'); }
  catch (e) { shownCounts = {}; }

  var saveTimer = null;
  function bump(id) {
    shownCounts[id] = (shownCounts[id] || 0) + 1;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem('shownCounts', JSON.stringify(shownCounts)); }
      catch (e) { /* voll -> egal, ist nur Optimierung */ }
    }, 2000);
  }

  var sleep = function (ms) {
    return new Promise(function (r) { timer = setTimeout(r, ms); });
  };

  // ------------------------------------------------------------ DOM

  var layers = [document.getElementById('layerA'), document.getElementById('layerB')];
  var front = 0;
  var elBadge = document.getElementById('badge');
  var elClock = document.getElementById('clock');
  var elCredit = document.getElementById('credit');
  var elCounter = document.getElementById('counter');
  var elPaused = document.getElementById('pausedIcon');
  var elOffline = document.getElementById('offlineIcon');
  var elWaiting = document.getElementById('waiting');
  var elCard = document.getElementById('card');
  var elCardIcon = document.getElementById('cardIcon');
  var elCardTitle = document.getElementById('cardTitle');
  var elCardWho = document.getElementById('cardWho');
  var elCardDetail = document.getElementById('cardDetail');
  document.getElementById('waitUrl').textContent = location.host;

  function photoCount() {
    var n = 0;
    pool.forEach(function (p) { if (p.kind === 'photo') n++; });
    return n;
  }

  function updateCounter() {
    var ups = new Set();
    pool.forEach(function (p) { ups.add(p.uploader); });
    elCounter.textContent = pool.size
      ? pool.size + ' Fotos · ' + ups.size + ' Gäste'
      : '';
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('de-AT', {
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ------------------------------------------------------------ Auswahl

  // Wiederholsperre passt sich der Pool-Grösse an: bei 12 Fotos werden
  // die letzten 11 gesperrt, bei 500 die letzten 8. Damit ist der Abstand
  // immer so gross wie möglich, ohne den Pool leerlaufen zu lassen.
  function recentLimit() {
    return Math.max(0, Math.min(photoCount() - 1, RECENT_CAP));
  }

  function noteShown(id) {
    recent.push(id);
    var lim = recentLimit();
    while (recent.length > lim) recent.shift();
  }

  function pickAmbient() {
    var items = [];
    pool.forEach(function (p) { if (p.kind === 'photo') items.push(p); });
    if (!items.length) return null;
    if (items.length === 1) return items[0];

    var fresh = items.filter(function (p) { return recent.indexOf(p.id) < 0; });
    if (!fresh.length) fresh = items;   // Sicherheitsnetz

    var now = Date.now();
    var weights = [];
    var total = 0;
    fresh.forEach(function (p) {
      var ageMin = (now - (p.effectiveAt || p.uploadedAt)) / 60000;
      var recency = 1 + 3 * Math.exp(-ageMin / 45);       // Neues zählt mehr
      var fatigue = 1 / (1 + (shownCounts[p.id] || 0));   // oft Gezeigtes weniger
      var w = recency * fatigue;
      weights.push(w);
      total += w;
    });
    var r = Math.random() * total;
    for (var i = 0; i < fresh.length; i++) {
      r -= weights[i];
      if (r <= 0) return fresh[i];
    }
    return fresh[fresh.length - 1];
  }

  // ------------------------------------------------------------ Anzeige

  function setBadge(kind, photo) {
    elBadge.textContent = '';
    elBadge.classList.remove('greeting');

    if (kind === 'greeting') {
      elBadge.classList.add('greeting');
      var g = document.createElement('b');
      g.textContent = photo.uploader;
      elBadge.appendChild(document.createTextNode('👋 Schön, dass du da bist, '));
      elBadge.appendChild(g);
      elBadge.appendChild(document.createTextNode('!'));
    } else if (kind === 'message') {
      var m = document.createElement('b');
      m.textContent = photo.uploader;
      elBadge.appendChild(document.createTextNode('🎙️ Eine Botschaft von '));
      elBadge.appendChild(m);
    } else if (kind === 'highlight') {
      var s = document.createElement('b');
      s.textContent = photo.uploader;
      var lead = photo.archive
        ? '📼 Von früher, mitgebracht von '
        : (photo.kind === 'video' ? '🎬 ' : '✨ ') + 'Gerade eben von ';
      elBadge.appendChild(document.createTextNode(lead));
      elBadge.appendChild(s);
      var chal = Challenges.byId(photo.challengeId);
      if (chal) {
        var c = document.createElement('span');
        c.className = 'cap';
        c.textContent = ' · ' + chal.icon + ' ' + chal.text;
        elBadge.appendChild(c);
      } else if (photo.caption) {
        var cap = document.createElement('span');
        cap.className = 'cap';
        cap.textContent = ' – ' + photo.caption;
        elBadge.appendChild(cap);
      }
    } else {
      elBadge.classList.remove('on');
      return;
    }
    elBadge.classList.add('on');
  }

  function display(p, badgeKind, durMs) {
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

      if (badgeKind) {
        setBadge(badgeKind, p);
        elCredit.style.opacity = '0';
      } else {
        elBadge.classList.remove('on');
        elBadge.classList.remove('greeting');
        elCredit.textContent = 'von ' + p.uploader;
        elCredit.style.opacity = '1';
      }
      bump(p.id);
    });
  }

  function showCard(icon, title, who, detail, ms) {
    elCardIcon.textContent = icon || '';
    elCardTitle.textContent = title || '';
    elCardWho.textContent = who || '';
    elCardDetail.textContent = detail || '';
    elCard.classList.add('on');
    return sleep(ms).then(function () {
      elCard.classList.remove('on');
      return sleep(800);
    });
  }

  function setWaiting(on) {
    idle = on;
    elWaiting.classList.toggle('on', on);
  }

  // ------------------------------------------------------------ Normale Rotation

  function advance() {
    clearTimeout(timer);
    if (paused || inRecap) return;

    var item = null;
    var badgeKind = null;
    if (mode !== 'quiet' && queue.length) {
      item = queue.shift();
      if (!pool.has(item.id)) return advance();  // inzwischen versteckt
      badgeKind = item.firstUpload ? 'greeting'
        : (item.kind === 'message' ? 'message' : 'highlight');
    } else {
      item = pickAmbient();
    }

    if (!item) {
      setWaiting(true);
      timer = setTimeout(advance, 3000);
      return;
    }
    setWaiting(false);

    var dur;
    if (badgeKind === 'greeting') dur = GREETING_MS;
    else if (badgeKind) dur = queue.length > QUEUE_FAST_AT ? HIGHLIGHT_FAST_MS : HIGHLIGHT_MS;
    else dur = photoCount() < SMALL_POOL ? AMBIENT_SMALL_MS : AMBIENT_MS;

    noteShown(item.id);
    display(item, badgeKind, dur).then(function () {
      if (inRecap) return;
      timer = setTimeout(advance, dur);
    });
  }

  // ------------------------------------------------------------ Rückblick

  function startRecap() {
    var token = ++recapToken;
    inRecap = true;
    clearTimeout(timer);
    setWaiting(false);
    elBadge.classList.remove('on');
    elCredit.style.opacity = '0';

    var alive = function () { return token === recapToken; };

    fetch('/api/recap')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!alive()) return;
        var archive = data.archive || [];
        var photos = data.photos || [];
        var awards = data.awards || [];

        // Ein Bild eine Weile stehen lassen und dabei den Namen einblenden.
        function playOne(p, clockText) {
          return function () {
            if (!alive()) return;
            if (clockText) {
              elClock.textContent = clockText;
              elClock.classList.add('on');
            } else {
              elClock.classList.remove('on');
            }
            return display(p, null, RECAP_PHOTO_MS).then(function () {
              elCredit.textContent = 'von ' + p.uploader;
              elCredit.style.opacity = '1';
              return sleep(RECAP_PHOTO_MS);
            });
          };
        }

        var chain = Promise.resolve();

        // Mitgebrachte Altfotos eröffnen als eigenes Kapitel.
        if (archive.length) {
          chain = chain
            .then(function () {
              if (!alive()) return;
              return showCard('📼', 'Von früher', '', 'was ihr mitgebracht habt', 5000);
            });
          archive.forEach(function (p) {
            var when = p.takenAt
              ? new Date(p.takenAt).toLocaleDateString('de-AT',
                  { month: 'long', year: 'numeric' })
              : '';
            chain = chain.then(playOne(p, when));
          });
        }

        chain = chain.then(function () {
          if (!alive()) return;
          return showCard('🌙', 'Unser Abend', 'in Bildern', '', 5000);
        });

        photos.forEach(function (p) {
          chain = chain.then(playOne(p, fmtTime(p.effectiveAt || p.uploadedAt)));
        });

        chain = chain.then(function () {
          if (!alive()) return;
          elClock.classList.remove('on');
          elCredit.style.opacity = '0';
          if (!awards.length) return;
          return showCard('🏆', 'Auszeichnungen', 'des Abends', '', 4500);
        });

        awards.forEach(function (a) {
          chain = chain.then(function () {
            if (!alive()) return;
            return showCard(a.icon, a.title, a.who, a.detail, RECAP_CARD_MS);
          });
        });

        return chain.then(function () {
          if (!alive()) return;
          return showCard('❤️', 'Danke, dass ihr da wart', '', '', 8000);
        });
      })
      .catch(function () { /* Netz weg: einfach zurück in die Rotation */ })
      .then(function () {
        if (!alive()) return;
        inRecap = false;
        elClock.classList.remove('on');
        elCard.classList.remove('on');
        advance();
      });
  }

  // ------------------------------------------------------------ Events

  function onPhoto(p) {
    pool.set(p.id, p);
    updateCounter();
    new Image().src = '/i/' + p.id + '-d.jpg';  // vorladen
    if (mode !== 'quiet') {
      queue.push(p);
      while (queue.length > QUEUE_CAP) queue.shift();
    }
    if (idle && !paused && !inRecap) advance();
  }

  function onHide(d) {
    if (d.hidden) {
      pool.delete(d.id);
      queue = queue.filter(function (p) { return p.id !== d.id; });
      if (!inRecap && current && current.id === d.id) advance();
    } else if (d.photo) {
      pool.set(d.photo.id, d.photo);
    }
    updateCounter();
  }

  function onControl(c) {
    if (c.reload) { location.reload(); return; }
    if (c.recap) { startRecap(); return; }

    mode = c.mode || 'normal';
    var wasPaused = paused;
    paused = !!c.paused;
    elPaused.classList.toggle('on', paused);
    if (paused) {
      clearTimeout(timer);           // aktuelles Bild bleibt stehen
    } else if ((wasPaused || c.skip) && !inRecap) {
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
    es.addEventListener('challenges', function (e) {
      Challenges.adopt(JSON.parse(e.data).challenges);
    });

    es.onerror = function () {
      hadError = true;
      elOffline.classList.add('on');
      // Die Show läuft aus dem Pool weiter – Browser reconnectet selbst.
    };
    es.onopen = function () {
      elOffline.classList.remove('on');
      if (hadError) {
        hadError = false;
        loadFeed(false);   // nach längerem Ausfall komplett abgleichen
      }
    };
  }

  function loadFeed(firstTime) {
    return fetch('/api/feed')
      .then(function (r) { return r.json(); })
      .then(function (f) {
        pool.clear();
        f.photos.forEach(function (p) { pool.set(p.id, p); });
        Challenges.adopt(f.challenges);
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
    var retry = setInterval(function () {
      loadFeed(true).then(function () { clearInterval(retry); }).catch(function () {});
    }, 5000);
  });

  // ------------------------------------------------------------ Bildschirm wach halten

  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').catch(function () {});
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

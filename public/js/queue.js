/* Upload-Warteschlange auf IndexedDB-Basis.
 *
 * Zweistufig: erst das kleine Anzeigebild (Foto ist damit sofort auf der
 * Fotowand), danach das Original im Hintergrund. Überlebt Seiten-Reload
 * und Netzausfälle; Wiederholversuche mit Backoff.
 */
(function () {
  'use strict';

  var DB_NAME = 'wedding-upload';
  var STORE = 'q';
  // Nach so vielen erfolglosen Versuchen aufgeben, statt endlos zu wiederholen
  // (sonst spammt ein kaputter Upload Server-Log und Akku).
  var MAX_ATTEMPTS = 10;

  // iOS Safari kann eine File-REFERENZ aus <input type="file"> nicht
  // zuverlässig aus IndexedDB zurückgeben – der Upload geht dann mit
  // 0 Bytes raus. Deshalb die Bytes vor dem Speichern materialisieren.
  // Sehr grosse Dateien (Videos) bleiben nur im Speicher dieser Sitzung,
  // weil ein 300-MB-ArrayBuffer das Handy sonst in die Knie zwingt.
  var MATERIALIZE_MAX = 200 * 1024 * 1024;
  var CHUNK = 8 * 1024 * 1024;   // Stückgrösse fürs Einlesen und Hochladen

  // Ab dieser Grösse wird das Original in Stücken hochgeladen. Darunter ist
  // eine einzelne Anfrage schneller und völlig unproblematisch.
  var STUECKWEISE_AB = 8 * 1024 * 1024;
  var liveOriginals = {}; // clientId -> File/Blob, nur diese Sitzung

  var listeners = [];
  var memoryFallback = []; // falls IndexedDB voll/kaputt ist (grosse Videos)
  var running = false;

  function openDB() {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () {
        rq.result.createObjectStore(STORE, { keyPath: 'clientId' });
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function put(item) {
    return tx('readwrite', function (s) { s.put(item); })
      .catch(function () {
        // IndexedDB verweigert (Quota) -> nur im Speicher halten.
        item.volatile = true;
        var i = memoryFallback.findIndex(function (x) { return x.clientId === item.clientId; });
        if (i >= 0) memoryFallback[i] = item; else memoryFallback.push(item);
      });
  }

  function remove(clientId) {
    delete liveOriginals[clientId];
    memoryFallback = memoryFallback.filter(function (x) { return x.clientId !== clientId; });
    return tx('readwrite', function (s) { s.delete(clientId); }).catch(function () {});
  }

  function allItems() {
    return tx('readonly', function (s) { return s.getAll(); })
      .then(function (rows) { return (rows || []).concat(memoryFallback); })
      .catch(function () { return memoryFallback.slice(); });
  }

  function notify(item, phase) {
    listeners.forEach(function (fn) { fn(item, phase); });
  }

  function due(item) {
    return !item.nextTry || item.nextTry <= Date.now();
  }

  function backoff(item, permanent, msg) {
    item.attempts = (item.attempts || 0) + 1;
    if (permanent || item.attempts >= MAX_ATTEMPTS) {
      item.state = 'failed';
      item.error = msg || (permanent
        ? 'fehlgeschlagen'
        : 'mehrfach abgebrochen – zum erneuten Versuch antippen');
    } else {
      item.nextTry = Date.now() + Math.min(60000, 3000 * Math.pow(2, item.attempts));
    }
    return put(item).then(function () { notify(item, 'update'); });
  }

  // XMLHttpRequest statt fetch: nur damit gibt es einen Fortschritt beim
  // Hochladen. Bei einem 100-MB-Video über Mobilfunk ist das der
  // Unterschied zwischen "hängt" und "läuft noch".
  function postForm(url, form, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);

      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && e.total) onProgress(e.loaded / e.total);
        };
      }

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText || '{}')); }
          catch (e) { reject(new Error('unlesbare Antwort')); }
          return;
        }
        var err = new Error('HTTP ' + xhr.status);
        err.status = xhr.status;
        err.permanent = xhr.status === 413 || xhr.status === 400 || xhr.status === 404;
        reject(err);
      };
      xhr.onerror = function () { reject(new Error('Netzfehler')); };
      xhr.onabort = function () { reject(new Error('abgebrochen')); };
      xhr.ontimeout = function () { reject(new Error('Zeitüberschreitung')); };

      xhr.send(form);
    });
  }

  function postJSON(url, koerper) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(koerper || {}),
    }).then(function (r) {
      if (r.ok) return r.json();
      var err = new Error('HTTP ' + r.status);
      err.status = r.status;
      err.permanent = r.status === 400 || r.status === 404;
      throw err;
    });
  }

  /* Original in Stücken hochladen.
   *
   * Der Grund: Ein grosses Video in einer einzigen Anfrage scheitert
   * zuverlässig – besonders auf dem iPhone. Multer und Caddy haben Grenzen,
   * das Gerät muss die Datei am Stück halten, und ein Abbruch bei 90 %
   * wirft alles weg. In 8-MB-Stücken sieht keine Schicht je mehr als ein
   * Stück, und ein Abbruch kostet höchstens dieses eine.
   */
  function sendeStueckweise(item, blob, melde) {
    var basis = '/api/original/' + item.serverId;
    return postJSON(basis + '/start', { dateiname: item.filename || 'original' })
      .then(function (start) {
        // Server meldet: liegt schon vor (etwa nach einem Wiederholversuch).
        if (start.existed) return { ok: true };
        if (!start.marke) throw new Error('kein Start');

        var pos = 0;
        function weiter() {
          if (pos >= blob.size) {
            return postJSON(basis + '/fertig', { marke: start.marke });
          }
          var ende = Math.min(pos + CHUNK, blob.size);
          return fetch(basis + '/teil?marke=' + encodeURIComponent(start.marke), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob.slice(pos, ende),
          }).then(function (r) {
            if (!r.ok) {
              var err = new Error('HTTP ' + r.status);
              err.status = r.status;
              // 410 heisst: Marke abgelaufen – ein neuer Anlauf hilft.
              err.permanent = r.status === 400 || r.status === 404;
              throw err;
            }
            pos = ende;
            if (melde) melde(pos / blob.size);
            return weiter();
          });
        }
        return weiter();
      });
  }

  /* Datei stückweise in den Speicher holen.
   *
   * orig.arrayBuffer() über die ganze Datei bräuchte kurzzeitig die
   * doppelte Dateigrösse (Puffer + Blob) und lässt Handys bei grossen
   * Videos abstürzen. In 8-MB-Scheiben bleibt der Mehrbedarf klein.
   */
  function materialize(file) {
    var teile = [];
    var pos = 0;
    function weiter() {
      if (pos >= file.size) {
        return Promise.resolve(new Blob(teile, {
          type: file.type || 'application/octet-stream',
        }));
      }
      var ende = Math.min(pos + CHUNK, file.size);
      return file.slice(pos, ende).arrayBuffer().then(function (buf) {
        teile.push(buf);
        pos = ende;
        return weiter();
      });
    }
    return weiter();
  }

  function sendMeta(item) {
    var f = new FormData();
    f.append('clientId', item.clientId);
    f.append('uploader', item.uploader);
    f.append('deviceId', item.deviceId);
    f.append('kind', item.kind);
    f.append('takenAt', String(item.takenAt));
    f.append('caption', item.caption || '');
    f.append('challengeId', item.challengeId || '');
    f.append('timeSource', item.timeSource || 'datei');
    f.append('w', String(item.w || ''));
    f.append('h', String(item.h || ''));
    f.append('display', item.displayBlob, 'display.jpg');
    f.append('thumb', item.thumbBlob, 'thumb.jpg');
    return postForm('/api/upload', f).then(function (res) {
      item.serverId = res.id;
      item.serverArchive = !!res.archive;
      item.state = item.wantsOriginal ? 'meta' : 'done';
      item.nextTry = 0;
      item.attempts = 0;
      // Anzeigebild/Thumb nicht mehr nötig -> Speicher freigeben.
      delete item.displayBlob;
      delete item.thumbBlob;
      if (item.state === 'done') {
        notify(item, 'done');
        return remove(item.clientId);
      }
      return put(item).then(function () { notify(item, 'meta'); });
    });
  }

  function sendOriginal(item) {
    // Erst der Speicher dieser Sitzung, dann die materialisierte Kopie.
    var blob = liveOriginals[item.clientId] || item.originalBlob;

    // Kein Inhalt mehr da (Seite neu geladen, Referenz verloren)? Dann nicht
    // endlos 0 Bytes senden – das Anzeigebild ist längst geteilt.
    if (!blob || !blob.size) {
      item.state = 'done';
      item.originalLost = true;
      notify(item, 'done');
      return remove(item.clientId);
    }

    // Nur bei spürbarer Änderung melden, sonst flackert die Anzeige.
    var zuletzt = -1;
    var melde = function (anteil) {
      var pct = Math.round(anteil * 100);
      if (pct === zuletzt) return;
      zuletzt = pct;
      item.progress = anteil;
      notify(item, 'progress');
    };

    var uebertragung;
    if (blob.size > STUECKWEISE_AB) {
      uebertragung = sendeStueckweise(item, blob, melde);
    } else {
      var f = new FormData();
      f.append('original', blob, item.filename || 'original');
      uebertragung = postForm('/api/original/' + item.serverId, f, melde);
    }

    return uebertragung.then(function () {
      item.state = 'done';
      notify(item, 'done');
      return remove(item.clientId);
    });
  }

  function pump() {
    if (running) return;
    running = true;
    (function loop() {
      allItems().then(function (items) {
        var next =
          items.find(function (i) { return i.state === 'new' && due(i); }) ||
          items.find(function (i) { return i.state === 'meta' && due(i); });
        if (!next) { running = false; return; }
        var job = next.state === 'new' ? sendMeta(next) : sendOriginal(next);
        job.then(loop, function (e) {
          backoff(next, e && e.permanent, e && e.status === 413 ? 'Datei zu gross' : null)
            .then(loop);
        });
      }).catch(function () { running = false; });
    })();
  }

  window.UploadQueue = {
    enqueue: function (item) {
      item.state = 'new';
      item.attempts = 0;

      var orig = item.originalBlob;
      delete item.originalBlob;
      item.wantsOriginal = !!orig;

      var prepared;
      if (!orig) {
        prepared = Promise.resolve();
      } else {
        // Für diese Sitzung immer im Speicher halten – schnellster und
        // sicherster Weg, unabhängig von IndexedDB.
        liveOriginals[item.clientId] = orig;
        if (orig.size <= MATERIALIZE_MAX) {
          // Echte Bytes statt Datei-Referenz: übersteht Reload und iOS.
          prepared = materialize(orig).then(function (blob) {
            item.originalBlob = blob;
          }).catch(function () { /* dann eben nur im Speicher */ });
        } else {
          prepared = Promise.resolve();
        }
      }

      return prepared.then(function () {
        return put(item);
      }).then(function () {
        notify(item, 'queued');
        pump();
      });
    },
    pending: allItems,
    onChange: function (fn) { listeners.push(fn); },

    // Wie viele Uploads sind noch unterwegs? Für die Warnung beim
    // Schliessen der Seite.
    offeneAnzahl: function () {
      return allItems().then(function (items) {
        return items.filter(function (i) {
          return i.state === 'new' || i.state === 'meta';
        }).length;
      });
    },
    pump: pump,

    // Aufgegebenen Upload von Hand neu anstossen (Antippen in der Liste).
    retry: function (clientId) {
      return allItems().then(function (items) {
        var it = items.filter(function (x) { return x.clientId === clientId; })[0];
        if (!it || it.state !== 'failed') return;
        it.state = it.serverId ? 'meta' : 'new';
        it.attempts = 0;
        it.nextTry = 0;
        delete it.error;
        return put(it).then(function () { notify(it, 'update'); pump(); });
      });
    },
  };

  window.addEventListener('online', pump);
  setInterval(pump, 15000);
})();

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
  var CHUNK = 8 * 1024 * 1024;   // stückweise einlesen, siehe materialize()
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

    var f = new FormData();
    f.append('original', blob, item.filename || 'original');

    // Nur bei spürbarer Änderung melden, sonst flackert die Anzeige.
    var zuletzt = -1;
    return postForm('/api/original/' + item.serverId, f, function (anteil) {
      var pct = Math.round(anteil * 100);
      if (pct === zuletzt) return;
      zuletzt = pct;
      item.progress = anteil;
      notify(item, 'progress');
    }).then(function () {
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

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
  var MATERIALIZE_MAX = 60 * 1024 * 1024;
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

  function postForm(url, form) {
    return fetch(url, { method: 'POST', body: form }).then(function (r) {
      if (r.ok) return r.json();
      var permanent = r.status === 413 || r.status === 400 || r.status === 404;
      var err = new Error('HTTP ' + r.status);
      err.permanent = permanent;
      err.status = r.status;
      throw err;
    });
  }

  function sendMeta(item) {
    var f = new FormData();
    f.append('clientId', item.clientId);
    f.append('uploader', item.uploader);
    f.append('deviceId', item.deviceId);
    f.append('kind', item.kind);
    f.append('takenAt', String(item.takenAt));
    f.append('caption', item.caption || '');
    f.append('w', String(item.w || ''));
    f.append('h', String(item.h || ''));
    f.append('display', item.displayBlob, 'display.jpg');
    f.append('thumb', item.thumbBlob, 'thumb.jpg');
    return postForm('/api/upload', f).then(function (res) {
      item.serverId = res.id;
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
    return postForm('/api/original/' + item.serverId, f).then(function () {
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
          prepared = orig.arrayBuffer().then(function (buf) {
            item.originalBlob = new Blob([buf], {
              type: orig.type || 'application/octet-stream',
            });
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

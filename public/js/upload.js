/* Upload-Seite: Name merken, Dateien verkleinern, in die Warteschlange geben. */
(function () {
  'use strict';

  var MAX_DISPLAY = 1600;   // lange Kante Anzeigebild
  var MAX_THUMB = 400;
  var JPEG_Q = 0.82;
  var MAX_PHOTO_ORIG = 50 * 1024 * 1024;
  var MAX_VIDEO_ORIG = 300 * 1024 * 1024;

  var elName = document.getElementById('name');
  var elCaption = document.getElementById('caption');
  var elPick = document.getElementById('pickbtn');
  var elPickHint = document.getElementById('pickhint');
  var elFile = document.getElementById('file');
  var elList = document.getElementById('list');
  var elStats = document.getElementById('stats');
  var elNet = document.getElementById('netbanner');

  // ---------------------------------------------------------- Identität

  elName.value = localStorage.getItem('guestName') || '';

  var deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('deviceId', deviceId);
  }

  function nameOk() { return elName.value.trim().length >= 2; }

  function refreshPickState() {
    elPick.classList.toggle('disabled', !nameOk());
    elFile.disabled = !nameOk();
    elPickHint.textContent = nameOk()
      ? 'Du kannst mehrere auf einmal auswählen.'
      : 'Zuerst oben deinen Vornamen eintragen 🙂';
  }

  elName.addEventListener('input', function () {
    localStorage.setItem('guestName', elName.value.trim());
    refreshPickState();
  });
  refreshPickState();

  // ---------------------------------------------------------- Status-Liste

  var rows = {}; // clientId -> li

  function statusText(item) {
    switch (item.state) {
      case 'processing': return 'wird verkleinert …';
      case 'new': return navigator.onLine ? '⬆️ lädt hoch …' : 'wartet auf Netz …';
      case 'meta': return '✓ auf der Fotowand – Original folgt …';
      case 'done': return item.skipOriginal
        ? '✓ geteilt (Video zu gross fürs Original)'
        : '✓✓ komplett gesichert';
      case 'failed': return '⚠️ ' + (item.error || 'fehlgeschlagen');
      default: return '';
    }
  }

  function render(item) {
    var li = rows[item.clientId];
    if (!li) {
      li = document.createElement('li');
      var img = document.createElement('img');
      img.alt = '';
      var box = document.createElement('div');
      var st = document.createElement('div');
      st.className = 'st';
      box.appendChild(st);
      li.appendChild(img);
      li.appendChild(box);
      elList.insertBefore(li, elList.firstChild);
      rows[item.clientId] = li;
    }
    var imgEl = li.querySelector('img');
    if (item.thumbUrl && !imgEl.src) imgEl.src = item.thumbUrl;
    else if (item.serverId && !imgEl.dataset.srv) {
      imgEl.src = '/i/' + item.serverId + '-t.jpg';
      imgEl.dataset.srv = '1';
    }
    var st2 = li.querySelector('.st');
    st2.textContent = statusText(item);
    st2.className = 'st' +
      (item.state === 'done' || item.state === 'meta' ? ' ok' : '') +
      (item.state === 'failed' ? ' err' : '');
  }

  UploadQueue.onChange(render);

  // Beim Laden: hängengebliebene Uploads anzeigen und weiterverarbeiten.
  UploadQueue.pending().then(function (items) {
    items.forEach(render);
    if (items.length) UploadQueue.pump();
  });

  // ---------------------------------------------------------- Bildverarbeitung

  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('toBlob fehlgeschlagen'));
      }, 'image/jpeg', q);
    });
  }

  function scaled(source, sw, sh, maxEdge, q) {
    var f = Math.min(1, maxEdge / Math.max(sw, sh));
    var w = Math.round(sw * f), h = Math.round(sh * f);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0, w, h);
    return toBlob(c, q).then(function (b) { return { blob: b, w: w, h: h }; });
  }

  // <img> statt createImageBitmap: wendet die EXIF-Drehung überall korrekt an.
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Bildformat wird von deinem Browser nicht unterstützt'));
      };
      img.src = url;
    });
  }

  function captureVideoFrame(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      var to = setTimeout(function () { fail(); }, 8000);
      function fail() {
        clearTimeout(to);
        URL.revokeObjectURL(url);
        reject(new Error('Video-Vorschau fehlgeschlagen'));
      }
      v.onerror = fail;
      v.onloadeddata = function () {
        v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
      };
      v.onseeked = function () {
        clearTimeout(to);
        resolve({ video: v, url: url, w: v.videoWidth, h: v.videoHeight });
      };
      v.src = url;
    });
  }

  function processFile(file, uploader, caption) {
    var isVideo = (file.type || '').indexOf('video') === 0;
    var item = {
      clientId: crypto.randomUUID(),
      uploader: uploader,
      deviceId: deviceId,
      kind: isVideo ? 'video' : 'photo',
      caption: caption,
      takenAt: file.lastModified || Date.now(),
      filename: file.name,
      state: 'processing',
    };
    render(item);

    var prep;
    if (isVideo) {
      prep = captureVideoFrame(file).then(function (r) {
        return Promise.all([
          scaled(r.video, r.w, r.h, MAX_DISPLAY, JPEG_Q),
          scaled(r.video, r.w, r.h, MAX_THUMB, 0.7),
        ]).then(function (res) {
          URL.revokeObjectURL(r.url);
          return res;
        });
      });
    } else {
      prep = loadImage(file).then(function (r) {
        var w = r.img.naturalWidth, h = r.img.naturalHeight;
        return Promise.all([
          scaled(r.img, w, h, MAX_DISPLAY, JPEG_Q),
          scaled(r.img, w, h, MAX_THUMB, 0.7),
        ]).then(function (res) {
          URL.revokeObjectURL(r.url);
          return res;
        });
      });
    }

    return prep.then(function (res) {
      var display = res[0], thumb = res[1];
      item.displayBlob = display.blob;
      item.thumbBlob = thumb.blob;
      item.w = display.w;
      item.h = display.h;
      item.thumbUrl = URL.createObjectURL(thumb.blob);

      var limit = isVideo ? MAX_VIDEO_ORIG : MAX_PHOTO_ORIG;
      if (file.size <= limit) {
        item.originalBlob = file;
      } else {
        item.skipOriginal = true; // nur Vorschau teilen
      }
      return UploadQueue.enqueue(item);
    }).catch(function (e) {
      item.state = 'failed';
      item.error = e && e.message ? e.message : 'Verarbeitung fehlgeschlagen';
      render(item);
    });
  }

  elFile.addEventListener('change', function () {
    var files = Array.prototype.slice.call(elFile.files || []);
    elFile.value = '';
    if (!files.length || !nameOk()) return;
    var uploader = elName.value.trim();
    var caption = elCaption.value.trim();
    elCaption.value = '';
    // Sequentiell verarbeiten – schont den Speicher auf älteren Handys.
    files.reduce(function (chain, f) {
      return chain.then(function () { return processFile(f, uploader, caption); });
    }, Promise.resolve());
  });

  // ---------------------------------------------------------- Zähler & Netz

  function refreshStats() {
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) {
      if (s.count > 0) {
        elStats.textContent = '🎉 Schon ' + s.count + ' Fotos von ' + s.uploaders + ' Gästen';
      } else {
        elStats.textContent = 'Mach das erste Foto des Festes! 🥇';
      }
    }).catch(function () {});
  }
  refreshStats();
  setInterval(refreshStats, 60000);
  UploadQueue.onChange(function (item, phase) {
    if (phase === 'meta' || phase === 'done') refreshStats();
  });

  function netState() { elNet.classList.toggle('hidden', navigator.onLine); }
  window.addEventListener('online', netState);
  window.addEventListener('offline', netState);
  netState();
})();

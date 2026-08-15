/* Galerie: chronologisches Raster mit Tages-Überschriften, Filter nach Gast,
 * Lightbox mit Original-Download. Gesperrt, bis die Moderation sie öffnet.
 */
(function () {
  'use strict';

  var photos = [];   // sichtbare Fotos, chronologisch
  var filtered = [];
  var lbIndex = -1;

  var elLock = document.getElementById('lock');
  var elContent = document.getElementById('content');
  var elSub = document.getElementById('subline');
  var elGrid = document.getElementById('grid');
  var elFilter = document.getElementById('filter');
  var elLb = document.getElementById('lightbox');
  var elLbMedia = document.getElementById('lbMedia');
  var elLbWho = document.getElementById('lbWho');
  var elLbCap = document.getElementById('lbCap');
  var elLbDownload = document.getElementById('lbDownload');

  function fmtDay(ts) {
    return new Date(ts).toLocaleDateString('de-CH', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function render() {
    var who = elFilter.value;
    filtered = who
      ? photos.filter(function (p) { return p.uploader === who; })
      : photos.slice();

    elGrid.textContent = '';
    var lastDay = '';
    filtered.forEach(function (p, i) {
      var day = fmtDay(p.takenAt || p.uploadedAt);
      if (day !== lastDay) {
        lastDay = day;
        var h = document.createElement('div');
        h.className = 'datehead';
        h.textContent = day;
        elGrid.appendChild(h);
      }
      var tile = document.createElement('div');
      tile.className = 'tile';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = '/i/' + p.id + '-t.jpg';
      img.alt = 'Foto von ' + p.uploader;
      tile.appendChild(img);
      if (p.kind === 'video') {
        var v = document.createElement('span');
        v.className = 'vid';
        v.textContent = '🎬';
        tile.appendChild(v);
      }
      tile.addEventListener('click', function () { openLb(i); });
      elGrid.appendChild(tile);
    });
  }

  function openLb(i) {
    lbIndex = i;
    var p = filtered[i];
    if (!p) return;
    elLbMedia.textContent = '';

    if (p.kind === 'video' && p.hasOriginal) {
      var video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      video.src = '/i/' + p.id + '-o.' + p.ext;
      elLbMedia.appendChild(video);
    } else {
      var img = document.createElement('img');
      img.src = '/i/' + p.id + '-d.jpg';
      elLbMedia.appendChild(img);
    }

    elLbWho.textContent = 'von ' + p.uploader;
    elLbCap.textContent = p.caption ||
      (p.kind === 'video' && !p.hasOriginal ? 'Video war zu gross fürs Hochladen – nur Vorschaubild.' : '');
    if (p.hasOriginal) {
      elLbDownload.classList.remove('hidden');
      elLbDownload.href = '/i/' + p.id + '-o.' + p.ext;
    } else {
      elLbDownload.href = '/i/' + p.id + '-d.jpg';
    }
    elLb.classList.remove('hidden');
  }

  function closeLb() {
    elLb.classList.add('hidden');
    elLbMedia.textContent = ''; // stoppt laufende Videos
    lbIndex = -1;
  }

  function step(d) {
    if (lbIndex < 0) return;
    var n = lbIndex + d;
    if (n >= 0 && n < filtered.length) openLb(n);
  }

  document.getElementById('lbClose').addEventListener('click', closeLb);
  document.getElementById('lbPrev').addEventListener('click', function () { step(-1); });
  document.getElementById('lbNext').addEventListener('click', function () { step(1); });
  elLb.addEventListener('click', function (e) { if (e.target === elLb) closeLb(); });
  document.addEventListener('keydown', function (e) {
    if (elLb.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLb();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  elFilter.addEventListener('change', render);

  fetch('/api/feed')
    .then(function (r) { return r.json(); })
    .then(function (f) {
      if (!f.galleryOpen) {
        elLock.classList.remove('hidden');
        return;
      }
      photos = f.photos;
      elContent.classList.remove('hidden');
      elSub.textContent = f.count + ' Fotos von ' + f.uploaders + ' Gästen';

      var names = Array.from(new Set(photos.map(function (p) { return p.uploader; })))
        .sort(function (a, b) { return a.localeCompare(b, 'de'); });
      names.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        elFilter.appendChild(o);
      });
      render();
    })
    .catch(function () {
      elSub.textContent = 'Galerie konnte nicht geladen werden – später nochmal versuchen.';
    });
})();

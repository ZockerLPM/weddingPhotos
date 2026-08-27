/* Erzählecke: Videobotschaften aufnehmen.
 *
 * Läuft auf einem Tablet oder Laptop in einer ruhigen Ecke. Die Aufnahme
 * geht durch dieselbe Upload-Warteschlange wie die Fotos: das Standbild
 * wird als Anzeigebild/Thumbnail hochgeladen, das Video als "Original".
 * Damit erscheint auf der Fotowand eine dezente Notiz, ohne dass im Raum
 * Ton abgespielt wird.
 */
(function () {
  'use strict';

  var MAX_MS = 90000;
  var MAX_UPLOAD = 300 * 1024 * 1024;

  var elName = document.getElementById('name');
  var elPreview = document.getElementById('preview');
  var elRec = document.getElementById('rec');
  var elRecTime = document.getElementById('recTime');
  var elActions = document.getElementById('actions');
  var elBtnStart = document.getElementById('btnStart');
  var elStatus = document.getElementById('status');

  var stream = null;
  var recorder = null;
  var chunks = [];
  var posterBlobs = null;   // {display, thumb} – Standbild aus der Aufnahme
  var recorded = null;      // {blob, ext}
  var startedAt = 0;
  var tick = null;
  var stopTimer = null;

  var deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('deviceId', deviceId);
  }
  elName.value = localStorage.getItem('guestName') || '';
  elName.addEventListener('input', function () {
    localStorage.setItem('guestName', elName.value.trim());
    refreshStart();
  });

  function nameOk() { return elName.value.trim().length >= 2; }
  function setStatus(text, cls) {
    elStatus.textContent = text;
    elStatus.className = 'status' + (cls ? ' ' + cls : '');
  }

  function refreshStart() {
    var ready = !!stream && nameOk();
    elBtnStart.classList.toggle('disabled', !ready);
    if (stream && !nameOk()) setStatus('Bitte zuerst deinen Namen eintragen 🙂');
    else if (ready) setStatus('Bereit, wenn du es bist.');
  }

  // ---------------------------------------------------------- Kamera

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  }).then(function (s) {
    stream = s;
    elPreview.srcObject = s;
    elPreview.play().catch(function () {});
    refreshStart();
  }).catch(function (e) {
    setStatus('Kamera nicht verfügbar: ' + (e && e.name ? e.name : 'Fehler') +
      '. Bitte Zugriff erlauben und Seite neu laden.', 'err');
  });

  // ---------------------------------------------------------- Aufnahme

  function pickMime() {
    var cands = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (var i = 0; i < cands.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return '';
  }

  function grabPoster() {
    // Standbild aus dem laufenden Stream – dient als Vorschau auf der
    // Fotowand und in der Galerie.
    var w = elPreview.videoWidth || 720;
    var h = elPreview.videoHeight || 960;
    function scaleTo(maxEdge, q) {
      var f = Math.min(1, maxEdge / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * f);
      c.height = Math.round(h * f);
      c.getContext('2d').drawImage(elPreview, 0, 0, c.width, c.height);
      return new Promise(function (resolve) {
        c.toBlob(function (b) { resolve({ blob: b, w: c.width, h: c.height }); },
          'image/jpeg', q);
      });
    }
    return Promise.all([scaleTo(1600, 0.82), scaleTo(400, 0.7)])
      .then(function (r) { posterBlobs = { display: r[0], thumb: r[1] }; });
  }

  function fmtDur(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function startRecording() {
    if (!stream || !nameOk()) return;
    var mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch (e) {
      setStatus('Aufnahme wird von diesem Browser nicht unterstützt.', 'err');
      return;
    }

    chunks = [];
    recorded = null;
    recorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = function () {
      var type = recorder.mimeType || 'video/webm';
      recorded = {
        blob: new Blob(chunks, { type: type }),
        ext: type.indexOf('mp4') >= 0 ? 'mp4' : 'webm',
      };
      chunks = [];
      showReview();
    };

    recorder.start();
    startedAt = Date.now();
    elRec.classList.add('on');
    setStatus('Läuft … sprich einfach los.');

    // Standbild kurz nach dem Start, da ist die Person schon im Bild.
    setTimeout(function () {
      if (recorder && recorder.state === 'recording') grabPoster();
    }, 1200);

    tick = setInterval(function () {
      elRecTime.textContent = fmtDur(Date.now() - startedAt);
    }, 250);
    stopTimer = setTimeout(stopRecording, MAX_MS);

    elActions.className = 'actions';
    elActions.textContent = '';
    var stop = document.createElement('div');
    stop.className = 'bigbtn';
    stop.textContent = '⏹ Aufnahme beenden';
    stop.addEventListener('click', stopRecording);
    elActions.appendChild(stop);
  }

  function stopRecording() {
    clearTimeout(stopTimer);
    clearInterval(tick);
    elRec.classList.remove('on');
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function showReview() {
    // Aufnahme abspielen statt Live-Bild.
    elPreview.srcObject = null;
    elPreview.classList.remove('mirror');
    elPreview.src = URL.createObjectURL(recorded.blob);
    elPreview.muted = false;
    elPreview.controls = true;
    elPreview.play().catch(function () {});

    var mb = Math.round(recorded.blob.size / 1e5) / 10;
    setStatus('Aufnahme fertig (' + mb + ' MB). Anschauen, dann absenden.');

    elActions.className = 'actions two';
    elActions.textContent = '';

    var again = document.createElement('div');
    again.className = 'bigbtn';
    again.style.background = '#4a4f58';
    again.style.color = 'var(--text)';
    again.textContent = '↺ Nochmal';
    again.addEventListener('click', resetToLive);

    var send = document.createElement('div');
    send.className = 'bigbtn';
    send.textContent = '📨 Absenden';
    send.addEventListener('click', submit);

    elActions.appendChild(again);
    elActions.appendChild(send);
  }

  function resetToLive() {
    if (elPreview.src) URL.revokeObjectURL(elPreview.src);
    elPreview.removeAttribute('src');
    elPreview.controls = false;
    elPreview.muted = true;
    elPreview.classList.add('mirror');
    elPreview.srcObject = stream;
    elPreview.play().catch(function () {});
    recorded = null;
    posterBlobs = null;

    elActions.className = 'actions';
    elActions.textContent = '';
    elActions.appendChild(elBtnStart);
    refreshStart();
  }

  function submit() {
    if (!recorded) return;
    var ready = posterBlobs
      ? Promise.resolve()
      : grabPoster().catch(function () {});

    ready.then(function () {
      if (!posterBlobs) {
        setStatus('Vorschaubild konnte nicht erzeugt werden.', 'err');
        return;
      }
      var item = {
        clientId: crypto.randomUUID(),
        uploader: elName.value.trim(),
        deviceId: deviceId,
        kind: 'message',
        caption: 'Botschaft aus der Erzählecke',
        challengeId: null,
        takenAt: Date.now(),
        filename: 'botschaft.' + recorded.ext,
        w: posterBlobs.display.w,
        h: posterBlobs.display.h,
        displayBlob: posterBlobs.display.blob,
        thumbBlob: posterBlobs.thumb.blob,
      };
      if (recorded.blob.size <= MAX_UPLOAD) item.originalBlob = recorded.blob;
      else item.skipOriginal = true;

      UploadQueue.enqueue(item);
      setStatus('Danke, ' + item.uploader + '! Deine Botschaft wird gesendet …', 'ok');

      UploadQueue.onChange(function (it, phase) {
        if (it.clientId !== item.clientId) return;
        if (phase === 'meta') setStatus('Danke! Botschaft angekommen, Video lädt noch …', 'ok');
        if (phase === 'done') setStatus('✓ Botschaft vollständig gespeichert. Danke!', 'ok');
      });

      // Nach kurzer Bestätigung zurück auf Anfang – der Nächste ist dran.
      setTimeout(function () {
        elName.value = '';
        localStorage.removeItem('guestName');
        resetToLive();
        setStatus('Bereit für die nächste Botschaft.');
      }, 6000);
    });
  }

  elBtnStart.addEventListener('click', function () {
    if (!elBtnStart.classList.contains('disabled')) startRecording();
  });

  refreshStart();
})();

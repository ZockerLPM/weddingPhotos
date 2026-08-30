/* Fotobuch – Druckseite mit Vorschau.
 *
 * Der Browser macht aus dieser Seite über „Drucken → Als PDF sichern" eine
 * fertige Datei. Das spart eine PDF-Bibliothek auf dem Server und hat einen
 * praktischen Vorteil: Was hier zu sehen ist, kommt genauso heraus.
 *
 * Alle Einstellungen wirken sofort auf die Vorschau; gespeichert wird erst
 * auf Wunsch. Der ZIP-Export für Druckdienste nutzt denselben Bauplan.
 */
(function () {
  'use strict';

  var key = location.hash.slice(1) || localStorage.getItem('modKey') || '';
  if (location.hash.length > 1) {
    localStorage.setItem('modKey', key);
    history.replaceState(null, '', '/buch');
  }
  if (!key) {
    key = prompt('Moderations-Schlüssel:') || '';
    localStorage.setItem('modKey', key);
  }

  var el = function (id) { return document.getElementById(id); };
  var elSeiten = el('buSeiten');
  var alleKapitel = [];     // ids der belegten Kapitel, für die Auswahl
  var cfg = null;
  var neuZeichnen = null;

  function status(text, cls) {
    el('buStatus').textContent = text || '';
    el('buStatus').className = 'status' + (cls ? ' ' + cls : '');
  }

  function api(pfad, koerper) {
    return fetch(pfad, {
      method: koerper ? 'POST' : 'GET',
      headers: koerper
        ? { 'Content-Type': 'application/json', 'x-mod-key': key }
        : { 'x-mod-key': key },
      body: koerper ? JSON.stringify(koerper) : undefined,
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem('modKey');
        document.body.textContent = 'Schlüssel ungültig – Seite neu laden.';
        throw new Error('401');
      }
      return r.json();
    });
  }

  // ------------------------------------------------------------ Formular

  function ausFormular() {
    var gewaehlt = [];
    Array.prototype.forEach.call(
      el('buKapitel').querySelectorAll('input[type=checkbox]'), function (cb) {
        if (cb.checked) gewaehlt.push(cb.value);
      });
    return {
      titel: el('buTitel').value,
      untertitel: el('buUnter').value,
      widmung: el('buWidmung').value,
      layout: el('buLayout').value,
      abwechslung: el('buAbwechslung').value,
      fuellen: el('buFuellen').checked,
      proSeite: Number(el('buProSeite').value),
      proKapitel: Number(el('buProKapitel').value) || 0,
      beschriftung: el('buBeschriftung').checked,
      favoritenKapitel: el('buFavoriten').checked,
      altfotos: el('buAltfotos').checked,
      kapitel: alleKapitel.length && gewaehlt.length < alleKapitel.length
        ? gewaehlt : null,
    };
  }

  function insFormular(c) {
    el('buTitel').value = c.titel || '';
    el('buUnter').value = c.untertitel || '';
    el('buWidmung').value = c.widmung || '';
    el('buLayout').value = c.layout || 'collage';
    el('buAbwechslung').value = c.abwechslung || 'gemischt';
    el('buFuellen').checked = c.fuellen !== false;
    el('buProSeite').value = String(c.proSeite);
    felderZeigen();
    el('buProKapitel').value = String(c.proKapitel);
    el('buBeschriftung').checked = c.beschriftung !== false;
    el('buFavoriten').checked = c.favoritenKapitel !== false;
    el('buAltfotos').checked = c.altfotos !== false;
  }

  // Raster und Collage brauchen unterschiedliche Regler – der jeweils
  // andere wäre nur verwirrend.
  function felderZeigen() {
    var collage = el('buLayout').value === 'collage';
    el('buAbwechslungFeld').classList.toggle('hidden', !collage);
    el('buProSeiteFeld').classList.toggle('hidden', collage);
  }

  function kapitelListe(plan) {
    // Nur echte Kategorien zur Auswahl – Favoriten, Weitere und „von
    // früher" haben ihre eigenen Schalter.
    var eigene = ['★', '∅', '📼'];
    var liste = plan.kapitel.filter(function (k) { return eigene.indexOf(k.id) < 0; });
    if (!alleKapitel.length) alleKapitel = liste.map(function (k) { return k.id; });

    var ul = el('buKapitel');
    ul.textContent = '';
    var gewaehlt = cfg.kapitel;
    alleKapitel.forEach(function (id) {
      var k = liste.filter(function (x) { return x.id === id; })[0];
      var li = document.createElement('li');
      var lab = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = id;
      cb.checked = !gewaehlt || gewaehlt.indexOf(id) >= 0;
      cb.addEventListener('change', function () { aktualisieren(); });
      var txt = document.createElement('span');
      txt.textContent = k ? (k.icon + ' ' + k.titel) : id;
      var zahl = document.createElement('span');
      zahl.className = 'zahl';
      zahl.textContent = k ? k.anzahl + ' Bilder' : '–';
      lab.appendChild(cb);
      lab.appendChild(txt);
      lab.appendChild(zahl);
      li.appendChild(lab);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------ Buch bauen

  function zeit(ts) {
    return new Date(ts).toLocaleString('de-AT', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function seite(klasse) {
    var d = document.createElement('section');
    d.className = 'bu-seite' + (klasse ? ' ' + klasse : '');
    elSeiten.appendChild(d);
    return d;
  }

  function zeichnen(plan) {
    var c = plan.einstellungen;
    elSeiten.textContent = '';

    // --- Titelseite
    var t = seite('titelseite');
    var h = document.createElement('h1');
    h.textContent = c.titel;
    t.appendChild(h);
    if (c.untertitel) {
      var u = document.createElement('p');
      u.className = 'unter';
      u.textContent = c.untertitel;
      t.appendChild(u);
    }
    if (c.widmung) {
      var w = document.createElement('p');
      w.className = 'widmung';
      w.textContent = c.widmung;
      t.appendChild(w);
    }
    var fuss = document.createElement('p');
    fuss.className = 'titelfuss';
    fuss.textContent = plan.fotos + ' Aufnahmen in ' + plan.kapitel.length + ' Kapiteln';
    t.appendChild(fuss);

    // --- Kapitel
    plan.kapitel.forEach(function (k) {
      var trenner = seite('kapitelseite');
      var ki = document.createElement('div');
      ki.className = 'kapitel-icon';
      ki.textContent = k.icon;
      var kt = document.createElement('h2');
      kt.textContent = k.titel;
      var kz = document.createElement('p');
      kz.className = 'kapitel-zahl';
      kz.textContent = k.anzahl + (k.anzahl === 1 ? ' Aufnahme' : ' Aufnahmen');
      trenner.appendChild(ki);
      trenner.appendChild(kt);
      trenner.appendChild(kz);

      /* Der Server hat die Seiten schon geschnitten und jedem Bild
       * seinen Platz zugewiesen – hier wird nur noch gezeichnet. Die
       * Vorlage kommt als CSS-Grid: bereiche sind die Zeilen von
       * grid-template-areas, die Plätze heissen a, b, c …
       */
      k.seiten.forEach(function (sp) {
        var s = seite('bildseite');
        var v = sp.vorlage;
        s.style.gridTemplateAreas = v.bereiche.map(function (z) {
          return '"' + z + '"';
        }).join(' ');
        s.style.gridTemplateColumns = 'repeat(' + v.spalten + ', 1fr)';
        s.style.gridTemplateRows = 'repeat(' + v.zeilen + ', 1fr)';

        sp.fotos.forEach(function (f, i) {
          var box = document.createElement('figure');
          box.style.gridArea = String.fromCharCode(97 + i);   // a, b, c …
          var img = document.createElement('img');
          img.src = '/i/' + f.id + '-d.jpg';
          img.alt = '';
          img.loading = 'lazy';
          img.className = c.fuellen ? 'fuellt' : '';
          box.appendChild(img);
          if (c.beschriftung) {
            var cap = document.createElement('figcaption');
            cap.textContent = f.caption
              ? f.caption + ' · ' + f.uploader
              : f.uploader + ' · ' + zeit(f.zeit);
            box.appendChild(cap);
          }
          s.appendChild(box);
        });
      });
    });
  }

  // ------------------------------------------------------------ Ablauf

  var wartet = null;
  function aktualisieren() {
    clearTimeout(wartet);
    wartet = setTimeout(function () {
      cfg = ausFormular();
      status('Vorschau wird aufgebaut …');
      api('/api/mod/buch/vorschau', cfg).then(function (plan) {
        cfg = plan.einstellungen;
        kapitelListe(plan);
        zeichnen(plan);
        el('buStand').textContent = plan.fotos + ' Bilder · ' +
          plan.kapitel.length + ' Kapitel · etwa ' + plan.seiten + ' Seiten';
        status('');
      }).catch(function () { status('Vorschau fehlgeschlagen.', 'err'); });
    }, 250);
  }
  neuZeichnen = aktualisieren;

  el('buLayout').addEventListener('change', felderZeigen);

  ['buTitel', 'buUnter', 'buWidmung', 'buLayout', 'buAbwechslung', 'buFuellen',
   'buProSeite', 'buProKapitel',
   'buBeschriftung', 'buFavoriten', 'buAltfotos'].forEach(function (id) {
    el(id).addEventListener('change', aktualisieren);
    el(id).addEventListener('input', aktualisieren);
  });

  el('buSpeichern').addEventListener('click', function () {
    status('Wird gespeichert …');
    api('/api/mod/buch', ausFormular()).then(function (plan) {
      cfg = plan.einstellungen;
      insFormular(cfg);
      zipVerweis();
      status('✓ Gemerkt – der ZIP-Export nimmt jetzt dieselben Einstellungen.', 'ok');
    }).catch(function () { status('Speichern fehlgeschlagen.', 'err'); });
  });

  el('buDrucken').addEventListener('click', function () {
    // Alle Bilder müssen geladen sein, sonst bleiben Lücken im PDF.
    var offen = Array.prototype.filter.call(
      elSeiten.querySelectorAll('img'), function (i) { return !i.complete; });
    if (!offen.length) { window.print(); return; }

    status('Bilder werden geladen (' + offen.length + ') …');
    var rest = offen.length;
    offen.forEach(function (i) {
      i.loading = 'eager';
      var fertig = function () {
        if (--rest <= 0) { status(''); window.print(); }
      };
      i.addEventListener('load', fertig, { once: true });
      i.addEventListener('error', fertig, { once: true });
    });
  });

  function zipVerweis() {
    el('buZip').href = '/api/mod/buch/zip?key=' + encodeURIComponent(key);
  }

  api('/api/mod/buch').then(function (plan) {
    cfg = plan.einstellungen;
    insFormular(cfg);
    kapitelListe(plan);
    zeichnen(plan);
    el('buStand').textContent = plan.fotos + ' Bilder · ' +
      plan.kapitel.length + ' Kapitel · etwa ' + plan.seiten + ' Seiten';
    zipVerweis();
  }).catch(function () {});
})();

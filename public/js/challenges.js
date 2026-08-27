/* Foto-Aufgaben im Browser.
 *
 * Die Liste kommt vom Server (über die Moderation änderbar) und wird hier
 * gepuffert. Seiten rendern zuerst mit dem, was da ist, und noch einmal,
 * sobald die Liste geladen oder über SSE geändert wurde.
 */
(function () {
  'use strict';

  var list = [];
  var loaded = false;
  var listeners = [];

  function set(next) {
    list = Array.isArray(next) ? next : [];
    loaded = true;
    listeners.forEach(function (fn) {
      try { fn(list); } catch (e) { /* eine kaputte Ansicht bremst nicht alle */ }
    });
  }

  window.Challenges = {
    get list() { return list; },
    get loaded() { return loaded; },

    byId: function (id) {
      if (!id) return null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    },

    // Aus einer bereits geladenen Feed-Antwort übernehmen, spart einen Aufruf.
    adopt: function (next) { if (next) set(next); },

    load: function () {
      return fetch('/api/challenges')
        .then(function (r) { return r.json(); })
        .then(function (d) { set(d.challenges); return list; })
        .catch(function () { return list; });
    },

    onChange: function (fn) { listeners.push(fn); },
  };
})();

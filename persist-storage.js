// Lucid PWA - asks the browser to keep the app's data permanently (navigator.storage.persist()).
//
// Without it iOS (and other browsers under storage pressure) may delete IndexedDB and the downloaded speech model.
// Runs on every launch until it is granted: first at load, then once more on the first touch, because some browsers
// only answer the request after a user gesture. Safari grants it silently to an app added to the Home Screen.
// The result is kept in localStorage ("lucidPersist") for the diagnostics panel. Plain script, no build step;
// this file must live in Lucid\pwa\public\ too.
(function () {
    'use strict';

    if (!navigator.storage || !navigator.storage.persist || !navigator.storage.persisted) return;

    var KEY = 'lucidPersist';

    function save(granted, how) {
        try { localStorage.setItem(KEY, JSON.stringify({ granted: granted, how: how, at: new Date().toISOString() })); } catch (e) { /* ignore */ }
    }

    function ask(how) {
        return navigator.storage.persisted().then(function (already) {
            if (already) { save(true, 'already'); return true; }
            return navigator.storage.persist().then(function (granted) {
                save(granted, how);
                return granted;
            });
        }).catch(function () { return false; });
    }

    ask('load').then(function (granted) {
        if (granted) return;
        var once = function () {
            window.removeEventListener('pointerdown', once, true);
            ask('gesture');
        };
        window.addEventListener('pointerdown', once, true);
    });
})();

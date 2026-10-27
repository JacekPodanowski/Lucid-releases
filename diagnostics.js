// Lucid PWA - diagnostics wizard (temporary, easy to remove).
//
// Plain script loaded by index.html with <script defer src="/diagnostics.js">. The app opens it from
// Ustawienia -> Diagnostyka (window.lucidDiag.open()); "?diag=1" in the address opens it too.
//
// It leads the user step by step, with a progress bar and a plain-language result after every step:
//   environment, permission to write files, microphone, a 10 s test recording (twice: like the app, and without the
//   level meter), saving it into the app's real database, playing it back, the speech model files, loading the model,
//   letting the model read the SAVED recording, a real backup (export + re-import), and cleanup of the test data.
// Every step is timed, so a freeze shows up as "this stage took N ms / did not finish". After EACH step the whole
// report so far goes to POST /api/v1/lucid/diagnostics/ (BACKEND/api/views/lucid.py), so a hang in a later step does
// not lose the earlier results. Agents read it from the server:
//   GET /api/v1/lucid/diagnostics/list/            (admin login)  - latest report + file names
//   <MEDIA_ROOT>/.lucid_diagnostics/latest.json     (on vps1, container site777_django_app: /var/www/media/...)
// The user can also copy the report ("Kopiuj raport"). Errors of the app (window errors, rejections, console.error)
// are collected from page load on and attached to the report.
//
// Privacy: the report holds counts, sizes, states and timings - never the text of the user's dream entries. The
// recognised sentence of the test recording is sent (the user said it on purpose).
//
// The app's data: the test writes ONE entry titled "__diag__" (+ its audio) into the real database to prove saving
// works, and removes it again in the last step (and when the panel is closed). Nothing else is changed. The backup
// test re-imports the backup it just made; the import skips every entry that already exists, so nothing is duplicated.
// To hide it: set ENABLED to false below, or delete the <script> line from index.html.
// This file must live in Lucid\pwa\public\ too, otherwise the next build of the PWA removes it.
(function () {
    'use strict';

    var ENABLED = true;
    if (!ENABLED) return;

    var API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? location.protocol + '//' + location.hostname + ':8000/api/v1'
        : 'https://api.youreasysite.pl/api/v1';
    var ERR_KEY = 'lucidDiagErrors';
    var MODEL_CACHE = 'lucid-model-nemo-v1';
    var MODEL_FILES = ['tokens.txt', 'decoder.int8.onnx', 'joiner.int8.onnx', 'encoder.int8.onnx'];
    var TEST_DB = 'lucid-diag-test';
    var TEST_TITLE = '__diag__';
    var REC_SECONDS = 10;

    // ---- error collection (starts immediately) ----------------------------------------------------

    var errors = [];
    try { errors = JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (e) { errors = []; }
    if (!Array.isArray(errors)) errors = [];

    function rememberError(kind, msg) {
        try {
            errors.push({ t: new Date().toISOString(), kind: kind, msg: String(msg).slice(0, 600) });
            if (errors.length > 60) errors = errors.slice(-60);
            localStorage.setItem(ERR_KEY, JSON.stringify(errors));
        } catch (e) { /* storage full or blocked */ }
    }

    window.addEventListener('error', function (e) {
        rememberError('error', (e.message || 'error') + (e.filename ? ' @' + e.filename + ':' + e.lineno : ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        rememberError('rejection', r && r.stack ? r.stack : String(r));
    });
    ['error', 'warn'].forEach(function (level) {
        var orig = console[level];
        console[level] = function () {
            try {
                rememberError('console.' + level, Array.prototype.map.call(arguments, function (a) {
                    return a instanceof Error ? (a.stack || a.message) : (typeof a === 'object' ? JSON.stringify(a) : String(a));
                }).join(' '));
            } catch (e) { /* ignore */ }
            return orig.apply(console, arguments);
        };
    });

    // ---- helpers ------------------------------------------------------------------------------------

    function randomId() {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var out = '';
        for (var i = 0; i < 12; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
        return out;
    }

    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error('nie zakończyło się w ' + Math.round(ms / 1000) + ' s: ' + label)); }, ms);
            promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
        });
    }

    function fmtBytes(n) {
        if (n == null) return '?';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function msg(e) { return String(e && e.message ? e.message : e); }

    // Longest time the page was blocked (timer late by this much) since the last reset: a frozen screen shows here.
    var stall = { last: performance.now(), max: 0 };
    setInterval(function () {
        var now = performance.now();
        var gap = now - stall.last - 100;
        if (gap > stall.max) stall.max = gap;
        stall.last = now;
    }, 100);
    function resetStall() { stall.max = 0; stall.last = performance.now(); }

    // ---- IndexedDB: the app's database and our own test database -------------------------------------

    function openLucidDb() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open('lucid');
            req.onupgradeneeded = function (e) { e.target.transaction.abort(); }; // never create an empty one
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('nie można otworzyć bazy lucid')); };
            req.onblocked = function () { reject(new Error('baza lucid zablokowana')); };
        });
    }

    // Runs fn(transaction) and resolves with the request fn returns (if any) once the transaction has committed.
    function tx(db, stores, mode, fn) {
        return new Promise(function (resolve, reject) {
            var t = db.transaction(stores, mode);
            var req;
            try { req = fn(t); } catch (e) { reject(e); return; }
            t.oncomplete = function () { resolve(req && req.result !== undefined ? req.result : undefined); };
            t.onerror = function () { reject(t.error || new Error('operacja na bazie nie powiodła się')); };
            t.onabort = function () { reject(t.error || new Error('operacja na bazie przerwana')); };
        });
    }

    function getAll(db, store) {
        return tx(db, store, 'readonly', function (t) { return t.objectStore(store).getAll(); });
    }

    function openTestDb() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(TEST_DB, 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('blobs'); };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('nie można otworzyć bazy testowej')); };
            req.onblocked = function () { reject(new Error('baza testowa zablokowana')); };
        });
    }

    function deleteTestDb() {
        return new Promise(function (resolve) {
            var req = indexedDB.deleteDatabase(TEST_DB);
            req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
        });
    }

    function sameBytes(a, b) {
        if (a.byteLength !== b.byteLength) return false;
        var x = new Uint8Array(a), y = new Uint8Array(b);
        for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
        return true;
    }

    // Removes the "__diag__" entries and their audio from the app's database. Returns how many it removed.
    function removeTestEntries(db) {
        return getAll(db, 'entries').then(function (entries) {
            var mine = entries.filter(function (e) { return e.title === TEST_TITLE; });
            if (!mine.length) return 0;
            return tx(db, ['entries', 'audio'], 'readwrite', function (t) {
                mine.forEach(function (e) {
                    t.objectStore('entries').delete(e.id);
                    if (e.audioFileName) t.objectStore('audio').delete(e.audioFileName);
                });
            }).then(function () { return mine.length; });
        });
    }

    // ---- audio ---------------------------------------------------------------------------------------

    function pickMime() {
        if (!window.MediaRecorder) return '';
        var types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
        for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
        return '';
    }

    // A 3 s test tone as a WAV file: used when no real recording exists, so saving can still be tested.
    function synthWav(seconds) {
        var rate = 16000, n = rate * (seconds || 3), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * 440 * i / rate)), true);
        return new Blob([buf], { type: 'audio/wav' });
    }

    // Same as the app's toMono16k: decode, then resample to 16 kHz mono.
    function decodeTo16k(blob) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return Promise.reject(new Error('AudioContext niedostępny'));
        return blob.arrayBuffer().then(function (buf) {
            var ctx = new AC();
            return new Promise(function (resolve, reject) {
                ctx.decodeAudioData(buf, resolve, reject);
            }).then(function (audio) {
                try { ctx.close(); } catch (e) { /* ignore */ }
                var frames = Math.max(1, Math.ceil(audio.duration * 16000));
                var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
                var off = new Off(1, frames, 16000);
                var src = off.createBufferSource();
                src.buffer = audio;
                src.connect(off.destination);
                src.start(0);
                return new Promise(function (resolve, reject) {
                    var p = off.startRendering(resolve, reject);
                    if (p && p.then) p.then(resolve, reject);
                }).then(function (rendered) {
                    var data = rendered.getChannelData(0).slice();
                    var peak = 0;
                    for (var i = 0; i < data.length; i += 16) { var a = Math.abs(data[i]); if (a > peak) peak = a; }
                    return { samples: data, duration: audio.duration, peak: peak };
                });
            });
        });
    }

    function computePeaks(samples) {
        var n = 64, step = Math.max(1, Math.floor(samples.length / n)), out = new Uint8Array(n);
        for (var i = 0; i < n; i++) {
            var m = 0;
            for (var j = i * step; j < Math.min(samples.length, (i + 1) * step); j++) { var a = Math.abs(samples[j]); if (a > m) m = a; }
            out[i] = Math.min(255, Math.round(m * 255));
        }
        return out;
    }

    // Records REC_SECONDS from the microphone and then does what the app does with a recording. `order`:
    //   'app'     - stop the tracks and close the audio context first, then MediaRecorder.stop() (what Recorder.tsx does)
    //   'nometer' - like 'app' but without the AudioContext level meter on the microphone (iOS Safari can record
    //               0 B when an AudioContext reads the same stream)
    // Every stage is timed and has its own timeout, so the report names the stage that froze.
    function recordTest(order, h) {
        var st = { order: order, mime: '', stages: {}, chunks: 0 };
        var stream, rec, ctx, raf, chunks = [], t0;
        var AC = window.AudioContext || window.webkitAudioContext;

        function release() {
            if (raf) cancelAnimationFrame(raf);
            if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
            if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
        }

        function stage(name, fn, timeout) {
            var s0 = performance.now();
            return withTimeout(Promise.resolve().then(fn), timeout || 20000, name).then(function (v) {
                st.stages[name] = Math.round(performance.now() - s0);
                return v;
            }, function (e) {
                st.stages[name] = Math.round(performance.now() - s0);
                st.failedStage = name;
                throw new Error(name + ': ' + msg(e));
            });
        }

        return stage('dostęp do mikrofonu', function () {
            return navigator.mediaDevices.getUserMedia({ audio: true });
        }, 60000).then(function (s) {
            stream = s;
            st.mime = pickMime();
            rec = st.mime ? new MediaRecorder(stream, { mimeType: st.mime }) : new MediaRecorder(stream);
            rec.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); st.chunks++; } };
            if (AC && order !== 'nometer') {
                // the app draws a level meter from an analyser while recording
                ctx = new AC();
                var an = ctx.createAnalyser();
                an.fftSize = 256;
                ctx.createMediaStreamSource(stream).connect(an);
                var buf = new Uint8Array(an.frequencyBinCount);
                var tick = function () { an.getByteTimeDomainData(buf); raf = requestAnimationFrame(tick); };
                tick();
            }
            var stopped = new Promise(function (resolve) {
                rec.onstop = function () { resolve(performance.now()); };
            });
            rec.start(1000);
            t0 = performance.now();
            return new Promise(function (resolve) {
                var timer = setInterval(function () {
                    var left = Math.max(0, REC_SECONDS - Math.round((performance.now() - t0) / 1000));
                    h.note('🎙️ Nagrywam… mów teraz. Zostało ' + left + ' s');
                    h.progress(Math.min(1, (performance.now() - t0) / (REC_SECONDS * 1000)));
                }, 200);
                setTimeout(function () { clearInterval(timer); resolve(); }, REC_SECONDS * 1000);
            }).then(function () {
                h.note('Kończę nagranie…');
                h.progress(1);
                resetStall();
                var tStop = performance.now();
                release();
                st.stateBeforeStop = rec.state;
                try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { st.stopError = msg(e); }
                return withTimeout(stopped, 8000, 'nagrywarka nie zakończyła pracy').then(function (tDone) {
                    st.stopMs = Math.round(tDone - tStop);
                }, function (e) {
                    st.stopMs = null;
                    st.failedStage = 'zatrzymanie nagrania';
                    throw new Error('zatrzymanie nagrania: ' + msg(e) + (st.stopError ? ' (stop() rzuciło: ' + st.stopError + ')' : '') + ', stan nagrywarki: ' + rec.state);
                });
            });
        }).then(function () {
            return stage('złożenie pliku', function () {
                st.blob = new Blob(chunks, { type: st.mime || (chunks[0] && chunks[0].type) || '' });
                st.size = st.blob.size;
                st.type = st.blob.type;
                if (!st.size) throw new Error('nagranie ma 0 B (kawałków: ' + st.chunks + ')');
            });
        }).then(function () {
            return stage('dekodowanie dźwięku', function () {
                return decodeTo16k(st.blob).then(function (d) {
                    st.samples = d.samples;
                    st.duration = Math.round(d.duration * 10) / 10;
                    st.peak = Math.round(d.peak * 1000) / 1000;
                });
            }, 30000);
        }).then(function () {
            return stage('kształt fali', function () { st.peaks = computePeaks(st.samples).length; });
        }).then(function () {
            return stage('zapis testowy', function () {
                return openTestDb().then(function (db) {
                    return tx(db, 'blobs', 'readwrite', function (t) { t.objectStore('blobs').put(st.blob, 'rec-' + order); })
                        .then(function () { return tx(db, 'blobs', 'readonly', function (t) { return t.objectStore('blobs').get('rec-' + order); }); })
                        .then(function (back) {
                            db.close();
                            if (!back || back.size !== st.size) throw new Error('po odczycie rozmiar ' + (back ? back.size : 'brak') + ' zamiast ' + st.size);
                        });
                });
            }, 20000);
        }).then(function () {
            st.maxStallMs = Math.round(stall.max);
            return st;
        }, function (e) {
            release();
            st.maxStallMs = Math.round(stall.max);
            e.rec = st;
            throw e;
        });
    }

    // ---- speech worker (our own copy of the app's worker) --------------------------------------------

    var worker = null;
    var workerUrl = null;
    var pending = {};
    var progressLog = null;
    var seq = 1;

    function findWorkerUrl() {
        if (workerUrl) return Promise.resolve(workerUrl);
        var s = document.querySelector('script[type="module"][src]');
        if (!s) return Promise.reject(new Error('nie znaleziono skryptu aplikacji'));
        return fetch(s.src).then(function (r) { return r.text(); }).then(function (txt) {
            var m = /\/app\/asr\.worker-[A-Za-z0-9_-]+\.js/.exec(txt);
            if (!m) throw new Error('w pakiecie aplikacji nie ma adresu workera asr');
            workerUrl = m[0];
            return workerUrl;
        });
    }

    function startWorker() {
        if (worker) return Promise.resolve(worker);
        return findWorkerUrl().then(function (url) {
            worker = new Worker(url, { type: 'module' });
            worker.onmessage = function (e) {
                var d = e.data || {};
                if (d.type === 'progress') {
                    if (progressLog && d.p) progressLog.push({ loaded: d.p.loaded, total: d.p.total });
                    return;
                }
                var key = d.type === 'loaded' ? 'load' : (d.id != null ? d.id : (pending.load ? 'load' : null));
                var waiter = pending[key];
                if (!waiter) return;
                delete pending[key];
                if (d.type === 'error') waiter.reject(new Error(d.error || 'błąd workera'));
                else waiter.resolve(d);
            };
            worker.onerror = function (e) {
                var err = new Error('worker: ' + (e.message || 'błąd ładowania') + (e.filename ? ' @' + e.filename + ':' + e.lineno : ''));
                Object.keys(pending).forEach(function (k) { pending[k].reject(err); delete pending[k]; });
            };
            return worker;
        });
    }

    function stopWorker() {
        if (worker) { worker.terminate(); worker = null; }
        pending = {};
    }

    function loadModel() {
        return startWorker().then(function (w) {
            return new Promise(function (resolve, reject) {
                pending.load = { resolve: resolve, reject: reject };
                w.postMessage({ type: 'load', model: 'nemo-fastconformer-transducer-multi-int8', device: 'wasm' });
            });
        });
    }

    function transcribe(samples) {
        return startWorker().then(function (w) {
            var id = seq++;
            return new Promise(function (resolve, reject) {
                pending[id] = { resolve: resolve, reject: reject };
                var copy = new Float32Array(samples); // the worker takes ownership of the buffer
                w.postMessage({ type: 'transcribe', id: id, audio: copy }, [copy.buffer]);
            });
        });
    }

    // ---- the steps ------------------------------------------------------------------------------------
    // Each step: { icon, title, text (what to do, plain language), button, optional, auto, run(ctx, h) }.
    // run returns { status: ok|warn|fail|skip, say (plain-language result), detail (technical), data }.

    function recDetail(st) {
        var stages = Object.keys(st.stages).map(function (k) { return k + ' ' + st.stages[k] + ' ms'; }).join(', ');
        return 'plik ' + fmtBytes(st.size) + ' ' + st.type + ', ' + st.duration + ' s, głośność ' + st.peak
            + '; zatrzymanie ' + st.stopMs + ' ms; najdłuższe zawieszenie ekranu ' + st.maxStallMs + ' ms; etapy: ' + stages;
    }

    function recData(st) {
        return { order: st.order, mime: st.mime, size: st.size, type: st.type, duration: st.duration, peak: st.peak, chunks: st.chunks,
            stages: st.stages, stopMs: st.stopMs, stateBeforeStop: st.stateBeforeStop, stopError: st.stopError || null, maxStallMs: st.maxStallMs, failedStage: st.failedStage || null };
    }

    function recStep(order, icon, title, text, optional) {
        return {
            icon: icon, title: title, text: text, button: 'Nagraj ' + REC_SECONDS + ' s', optional: optional,
            run: function (ctx, h) {
                return recordTest(order, h).then(function (st) {
                    if (order === 'app' || !ctx.rec || !ctx.rec.samples) ctx.rec = st;
                    var why = [];
                    if (st.maxStallMs > 3000) why.push('ekran był zamrożony ' + Math.round(st.maxStallMs / 1000) + ' s');
                    if (st.peak < 0.001) why.push('nagranie to cisza (czy mikrofon był zasłonięty?)');
                    if (st.duration < REC_SECONDS - 3) why.push('nagranie jest krótsze niż ' + REC_SECONDS + ' s');
                    return {
                        status: why.length ? 'warn' : 'ok',
                        say: why.length ? 'Nagranie się zapisało, ale: ' + why.join(', ') + '.' : 'Nagranie zapisało się poprawnie (' + st.duration + ' s, ' + fmtBytes(st.size) + ').',
                        detail: recDetail(st), data: recData(st)
                    };
                }, function (e) {
                    var st = e.rec;
                    var empty = st && st.failedStage === 'złożenie pliku' && !st.size;
                    return {
                        status: 'fail',
                        say: empty ? 'Nagranie jest puste: telefon nie przekazał żadnego dźwięku.' : 'Nagranie się nie powiodło na etapie: ' + (st && st.failedStage ? st.failedStage : 'nieznany') + '.',
                        detail: msg(e) + (st ? '. Do tej chwili: ' + recDetail({ stages: st.stages, size: st.size, type: st.type, duration: st.duration, peak: st.peak, stopMs: st.stopMs, maxStallMs: st.maxStallMs }) : ''),
                        data: st ? recData(st) : null
                    };
                });
            }
        };
    }

    // The blob of the test recording, or a generated tone when there is none.
    function testBlob(ctx) {
        if (ctx.rec && ctx.rec.blob && ctx.rec.blob.size) return { blob: ctx.rec.blob, synthetic: false, duration: ctx.rec.duration };
        return { blob: synthWav(), synthetic: true, duration: 3 };
    }

    var STEPS = [
        {
            icon: '📱', title: 'Telefon i aplikacja', auto: true,
            run: function (ctx) {
                var standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
                var data = {
                    userAgent: navigator.userAgent, standalone: standalone, language: navigator.language, online: navigator.onLine,
                    screen: screen.width + 'x' + screen.height + '@' + window.devicePixelRatio, secureContext: window.isSecureContext,
                    deviceMemoryGb: navigator.deviceMemory || null, hardwareConcurrency: navigator.hardwareConcurrency || null,
                    webAssembly: typeof WebAssembly === 'object', mediaRecorder: !!window.MediaRecorder, recordMime: pickMime() || null
                };
                ctx.standalone = standalone;
                var done = function (est) {
                    if (est) { data.storageUsage = est.usage; data.storageQuota = est.quota; }
                    var low = est && est.quota - est.usage < 400 * 1048576;
                    var why = [];
                    if (!standalone) why.push('aplikacja działa w karcie przeglądarki, a nie z ikony na ekranie głównym');
                    if (low) why.push('mało wolnego miejsca');
                    if (!data.mediaRecorder) why.push('ta przeglądarka nie umie nagrywać');
                    return {
                        status: why.length ? 'warn' : 'ok',
                        say: why.length ? 'Uwaga: ' + why.join('; ') + '.' : 'Aplikacja działa z ikony, jest miejsce i telefon umie nagrywać.',
                        detail: (standalone ? 'z ikony' : 'karta przeglądarki') + ', online=' + navigator.onLine + ', nagrywanie: ' + (data.recordMime || 'brak MediaRecorder')
                            + (est ? ', pamięć ' + fmtBytes(est.usage) + ' z ' + fmtBytes(est.quota) : ''),
                        data: data
                    };
                };
                if (!navigator.storage || !navigator.storage.estimate) return done(null);
                return navigator.storage.estimate().then(done, function () { return done(null); });
            }
        },
        {
            icon: '🔖', title: 'Wersja aplikacji', auto: true,
            run: function () {
                var app = window.lucidApp;
                var mine = app && app.build ? String(app.build) : null;
                var data = { mine: mine };
                return fetch('/version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
                    data.server = v && v.build ? String(v.build) : null;
                }, function (e) { data.versionError = msg(e); }).then(function () {
                    var why = [];
                    if (!mine) why.push('ta wersja aplikacji nie zgłasza numeru (jest stara)');
                    else if (data.server && data.server !== mine) why.push('na serwerze jest nowsza wersja niż ta w telefonie');
                    if (!data.server) why.push('nie udało się sprawdzić, jaka wersja jest na serwerze');
                    return {
                        status: why.length ? 'warn' : 'ok',
                        say: why.length ? 'Uwaga: ' + why.join('; ') + '.' : 'Masz najnowszą wersję aplikacji.',
                        detail: 'w telefonie ' + mine + ', na serwerze ' + data.server + (data.versionError ? ', błąd: ' + data.versionError : ''),
                        data: data
                    };
                });
            }
        },
        {
            icon: '📁', title: 'Zgoda na zapis plików',
            text: 'Aplikacja musi móc zapisywać nagrania na telefonie. Dotknij przycisku: telefon może zapytać o zgodę na trwały zapis. Potem sprawdzę, czy zapis i odczyt naprawdę działają.',
            button: 'Zezwól i sprawdź zapis',
            run: function () {
                var data = {};
                var persist = navigator.storage && navigator.storage.persisted
                    ? navigator.storage.persisted().then(function (was) {
                        data.persistedBefore = was;
                        if (was) return true;
                        return navigator.storage.persist();
                    }) : Promise.resolve(null);
                return persist.then(function (granted) {
                    data.persisted = granted;
                    var t0 = performance.now();
                    var probe = new Blob([new Uint8Array(2 * 1048576)], { type: 'application/octet-stream' });
                    return withTimeout(openTestDb().then(function (db) {
                        return tx(db, 'blobs', 'readwrite', function (t) { t.objectStore('blobs').put(probe, 'probe'); })
                            .then(function () { return tx(db, 'blobs', 'readonly', function (t) { return t.objectStore('blobs').get('probe'); }); })
                            .then(function (back) {
                                db.close();
                                if (!back || back.size !== probe.size) throw new Error('odczyt zwrócił ' + (back ? back.size : 'nic') + ' B zamiast ' + probe.size);
                                data.indexedDbMs = Math.round(performance.now() - t0);
                            });
                    }), 20000, 'zapis 2 MB do IndexedDB');
                }).then(function () {
                    if (!window.caches) { data.cache = 'niedostępne'; return null; }
                    var t0 = performance.now();
                    return caches.open('lucid-diag-test').then(function (c) {
                        return c.put('/__diag', new Response(new Uint8Array(1048576))).then(function () { return c.match('/__diag'); }).then(function (r) {
                            return r ? r.arrayBuffer() : null;
                        }).then(function (b) {
                            data.cache = b && b.byteLength === 1048576 ? 'ok' : 'błąd odczytu';
                            data.cacheMs = Math.round(performance.now() - t0);
                            return caches.delete('lucid-diag-test');
                        });
                    });
                }).then(function () {
                    return deleteTestDb();
                }).then(function () {
                    var ok = data.cache === 'ok';
                    var why = [];
                    if (data.persisted === false) why.push('telefon nie przyznał trwałego zapisu, Safari może skasować dane (dodaj aplikację do ekranu początkowego i rób kopie zapasowe)');
                    if (!ok) why.push('pamięć na model: ' + data.cache);
                    return {
                        status: why.length ? 'warn' : 'ok',
                        say: why.length ? 'Zapis działa, ale: ' + why.join('; ') + '.' : 'Telefon pozwala zapisywać pliki i odczytuje je poprawnie.',
                        detail: 'trwały zapis: ' + (data.persisted == null ? 'nie do sprawdzenia' : data.persisted ? 'tak' : 'nie') + '; zapis i odczyt 2 MB w bazie ' + data.indexedDbMs + ' ms; pamięć podręczna ' + data.cache,
                        data: data
                    };
                });
            }
        },
        {
            icon: '🎤', title: 'Mikrofon',
            text: 'Dotknij przycisku i zezwól na mikrofon, gdy telefon zapyta.',
            button: 'Zezwól na mikrofon',
            run: function () {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { status: 'fail', say: 'Ta przeglądarka nie pozwala używać mikrofonu.', detail: 'brak getUserMedia' };
                return withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 60000, 'zgoda na mikrofon').then(function (s) {
                    var tracks = s.getAudioTracks().map(function (t) { return { label: t.label, state: t.readyState, settings: t.getSettings ? t.getSettings() : null }; });
                    s.getTracks().forEach(function (t) { t.stop(); });
                    return { say: 'Mikrofon działa: ' + (tracks[0] ? tracks[0].label || 'bez nazwy' : '?') + '.', detail: JSON.stringify(tracks), data: { tracks: tracks } };
                }, function (e) {
                    return { status: 'fail', say: 'Brak dostępu do mikrofonu. Zezwól na niego w Ustawieniach iPhone\'a → Safari → Mikrofon.', detail: msg(e) };
                });
            }
        },
        recStep('app', '⏺️', 'Nagranie ' + REC_SECONDS + ' s (jak w aplikacji)',
            'Dotknij przycisku i przez ' + REC_SECONDS + ' sekund mów coś po polsku, np. opowiedz, co jadłeś dziś na śniadanie. Nie blokuj ekranu.', false),
        recStep('nometer', '🔁', 'Nagranie ' + REC_SECONDS + ' s (bez paska poziomu)',
            'To samo jeszcze raz, ale bez paska poziomu dźwięku, który aplikacja rysuje podczas nagrywania. Pomaga ustalić, czy on psuje nagranie. Znowu mów przez całe ' + REC_SECONDS + ' s.', true),
        {
            icon: '💾', title: 'Zapis w dzienniku',
            text: 'Zapiszę Twoje nagranie w prawdziwej bazie aplikacji jako wpis testowy i sprawdzę, czy wraca bez zmian. Wpis zniknie na końcu diagnostyki.',
            button: 'Zapisz i sprawdź',
            run: function (ctx) {
                var t = testBlob(ctx);
                ctx.test = t;
                var ext = /mp4|m4a/.test(t.blob.type) ? 'm4a' : (/webm/.test(t.blob.type) ? 'webm' : 'wav');
                var name = 'diag_' + Date.now() + '.' + ext;
                var data = { synthetic: t.synthetic, size: t.blob.size, type: t.blob.type, fileName: name };
                return openLucidDb().then(function (db) {
                    ctx.appDb = db;
                    return removeTestEntries(db).then(function () { return getAll(db, 'entries'); }).then(function (before) {
                        ctx.baseEntries = before.length;
                        data.entriesBefore = before.length;
                        var entry = {
                            title: TEST_TITLE, text: '', audioFileName: name, durationMs: Math.round(t.duration * 1000), createdAt: Date.now(),
                            categoryId: null, peaks: new Uint8Array(64), transcriptState: 'none', transcriptError: null,
                            isFavorite: false, isEdited: false, audioMissing: false
                        };
                        var t0 = performance.now();
                        return tx(db, ['audio', 'entries'], 'readwrite', function (tr) {
                            tr.objectStore('audio').put({ fileName: name, blob: t.blob });
                            return tr.objectStore('entries').add(entry);
                        }).then(function (id) {
                            ctx.testId = id;
                            ctx.testName = name;
                            data.writeMs = Math.round(performance.now() - t0);
                            return tx(db, 'entries', 'readonly', function (tr) { return tr.objectStore('entries').get(id); });
                        }).then(function (e) {
                            return getAll(db, 'audio').then(function (all) {
                                var a = all.filter(function (x) { return x.fileName === name; })[0];
                                if (!e) throw new Error('wpisu nie ma w bazie po zapisie');
                                if (!a || !a.blob) throw new Error('nagrania nie ma w bazie po zapisie');
                                if (a.blob.size !== t.blob.size) throw new Error('zapisano ' + a.blob.size + ' B zamiast ' + t.blob.size + ' B');
                                return Promise.all([a.blob.arrayBuffer(), t.blob.arrayBuffer()]).then(function (pair) {
                                    if (!sameBytes(pair[0], pair[1])) throw new Error('zawartość nagrania po zapisie jest inna niż przed');
                                    data.bytesEqual = true;
                                });
                            });
                        });
                    });
                }).then(function () {
                    return {
                        status: t.synthetic ? 'warn' : 'ok',
                        say: t.synthetic
                            ? 'Zapis do dziennika działa (użyłem dźwięku testowego, bo wcześniejsze nagranie się nie udało).'
                            : 'Nagranie zapisuje się w dzienniku i wraca bez zmian (' + fmtBytes(t.blob.size) + ').',
                        detail: 'zapis ' + data.writeMs + ' ms; wpisów w dzienniku przed testem: ' + data.entriesBefore + '; bajty identyczne: tak' + (t.synthetic ? '; DŹWIĘK TESTOWY' : ''),
                        data: data
                    };
                }, function (e) {
                    return { status: 'fail', say: 'Nagranie NIE zapisuje się poprawnie w dzienniku: ' + msg(e) + '.', detail: msg(e), data: data };
                });
            }
        },
        {
            icon: '▶️', title: 'Odtwarzanie zapisanego nagrania',
            text: 'Sprawdzę, czy zapisane nagranie da się otworzyć i odtworzyć w aplikacji.',
            button: 'Sprawdź odtwarzanie',
            run: function (ctx) {
                if (!ctx.appDb || !ctx.testName) return { status: 'skip', say: 'Pominięte, bo zapis w dzienniku się nie udał.', detail: 'brak wpisu testowego' };
                return getAll(ctx.appDb, 'audio').then(function (all) {
                    var a = all.filter(function (x) { return x.fileName === ctx.testName; })[0];
                    if (!a) throw new Error('nagrania nie ma w bazie');
                    var url = URL.createObjectURL(a.blob);
                    var el0 = document.createElement('audio');
                    el0.preload = 'metadata';
                    return withTimeout(new Promise(function (resolve, reject) {
                        el0.onloadedmetadata = function () { resolve(el0.duration); };
                        el0.onerror = function () { reject(new Error('odtwarzacz nie umie otworzyć pliku (kod ' + (el0.error ? el0.error.code : '?') + ')')); };
                        el0.src = url;
                        el0.load();
                    }), 10000, 'otwarcie nagrania w odtwarzaczu').then(function (dur) {
                        URL.revokeObjectURL(url);
                        return dur;
                    }, function (e) { URL.revokeObjectURL(url); throw e; });
                }).then(function (dur) {
                    var expect = ctx.test ? ctx.test.duration : null;
                    var off = isFinite(dur) && expect != null ? Math.abs(dur - expect) : null;
                    var bad = !isFinite(dur) || dur < 0.5 || (off != null && off > 1.5);
                    return {
                        status: bad ? 'warn' : 'ok',
                        say: bad ? 'Odtwarzacz otwiera nagranie, ale długość wygląda dziwnie (' + (isFinite(dur) ? dur.toFixed(1) + ' s' : 'nieznana') + ').' : 'Nagranie otwiera się w odtwarzaczu, długość ' + dur.toFixed(1) + ' s.',
                        detail: 'długość z odtwarzacza ' + dur + ' s, oczekiwana ' + expect + ' s', data: { playerDuration: isFinite(dur) ? dur : null, expected: expect }
                    };
                }, function (e) {
                    return { status: 'fail', say: 'Zapisanego nagrania nie da się odtworzyć: ' + msg(e) + '.', detail: msg(e) };
                });
            }
        },
        {
            icon: '🐘', title: 'Długie nagranie (3 min)', auto: true,
            run: function () {
                var data = {};
                var blob = synthWav(180);
                data.size = blob.size;
                resetStall();
                var t0 = performance.now();
                return openTestDb().then(function (db) {
                    return tx(db, 'blobs', 'readwrite', function (t) { t.objectStore('blobs').put(blob, 'long'); })
                        .then(function () { return tx(db, 'blobs', 'readonly', function (t) { return t.objectStore('blobs').get('long'); }); })
                        .then(function (back) {
                            db.close();
                            if (!back || back.size !== blob.size) throw new Error('po odczycie rozmiar ' + (back ? back.size : 'brak') + ' zamiast ' + blob.size);
                            data.saveMs = Math.round(performance.now() - t0);
                        });
                }).then(function () {
                    var t1 = performance.now();
                    return withTimeout(decodeTo16k(blob), 60000, 'dekodowanie 3 min').then(function (d) {
                        data.decodeMs = Math.round(performance.now() - t1);
                        var t2 = performance.now();
                        computePeaks(d.samples);
                        data.peaksMs = Math.round(performance.now() - t2);
                    });
                }).then(function () {
                    data.maxStallMs = Math.round(stall.max);
                    var slow = data.decodeMs > 15000 || data.maxStallMs > 3000;
                    return {
                        status: slow ? 'warn' : 'ok',
                        say: slow ? 'Długie nagranie przechodzi, ale telefon wyraźnie zwalnia (ekran zamrożony ' + (data.maxStallMs / 1000).toFixed(1) + ' s).' : 'Długie nagranie (3 min, ' + fmtBytes(data.size) + ') zapisuje się i dekoduje bez zawieszeń.',
                        detail: 'zapis ' + data.saveMs + ' ms, dekodowanie ' + data.decodeMs + ' ms, kształt fali ' + data.peaksMs + ' ms, najdłuższe zawieszenie ekranu ' + data.maxStallMs + ' ms',
                        data: data
                    };
                }, function (e) {
                    return { status: 'fail', say: 'Długie nagranie nie przeszło: ' + msg(e) + '.', detail: msg(e), data: data };
                });
            }
        },
        {
            icon: '🧠', title: 'Model mowy: pliki',
            text: 'Sprawdzę, czy model rozpoznawania mowy jest pobrany na telefon i czy jego pliki są kompletne.',
            button: 'Sprawdź model',
            run: function (ctx) {
                if (!window.caches) return { status: 'fail', say: 'Ten telefon nie ma pamięci podręcznej na model.', detail: 'Cache API niedostępne' };
                return caches.open(MODEL_CACHE).then(function (cache) {
                    var chain = Promise.resolve();
                    var files = [];
                    MODEL_FILES.forEach(function (name) {
                        chain = chain.then(function () {
                            return cache.match('/__model/nemo/' + name).then(function (res) {
                                if (!res) { files.push({ file: name, size: null }); return null; }
                                return res.arrayBuffer().then(function (b) { files.push({ file: name, size: b.byteLength }); });
                            });
                        });
                    });
                    return chain.then(function () { return files; });
                }).then(function (files) {
                    var missing = files.filter(function (f) { return !f.size; }).map(function (f) { return f.file; });
                    var enc = files.filter(function (f) { return f.file === 'encoder.int8.onnx'; })[0];
                    var small = enc && enc.size && enc.size < 50 * 1048576;
                    ctx.modelCached = missing.length === 0 && !small;
                    return openLucidDb().then(function (db) {
                        return getAll(db, 'kv').then(function (kv) {
                            var ready = null;
                            kv.forEach(function (r) { if (r.key === 'asrReadyModel') ready = r.value; });
                            return getAll(db, 'entries').then(function (entries) {
                                db.close();
                                var real = entries.filter(function (e) { return e.title !== TEST_TITLE; });
                                return { ready: ready, entries: real.length, queued: real.filter(function (e) { return e.queued; }).length, withError: real.filter(function (e) { return e.transcriptError; }).length };
                            });
                        });
                    }, function (e) { return { dbError: msg(e) }; }).then(function (app) {
                        var problems = [];
                        if (missing.length) problems.push('brakuje: ' + missing.join(', '));
                        if (small) problems.push('główny plik modelu jest za mały (' + fmtBytes(enc.size) + '), pobieranie zostało przerwane');
                        if (app.ready && !ctx.modelCached) problems.push('aplikacja myśli, że model jest gotowy, a pliki są niekompletne');
                        return {
                            status: problems.length ? 'fail' : 'ok',
                            say: problems.length ? 'Model nie jest w pełni pobrany: ' + problems.join('; ') + '. Pobierz go ponownie w Ustawieniach.' : 'Model jest pobrany i kompletny (' + fmtBytes(files.reduce(function (s, f) { return s + (f.size || 0); }, 0)) + ').',
                            detail: files.map(function (f) { return f.file + ' ' + fmtBytes(f.size); }).join(', ') + '; wpisów w dzienniku ' + (app.entries == null ? '?' : app.entries) + ', w kolejce ' + (app.queued == null ? '?' : app.queued) + ', z błędem przepisywania ' + (app.withError == null ? '?' : app.withError),
                            data: { files: files, app: app, problems: problems }
                        };
                    });
                });
            }
        },
        {
            icon: '⚙️', title: 'Model mowy: uruchomienie',
            text: 'Załaduję model do pamięci. Jeśli go nie ma na telefonie, zostanie pobrany (ok. 107 MB, lepiej na Wi-Fi). Może to potrwać minutę lub dwie.',
            button: 'Uruchom model',
            run: function (ctx, h) {
                progressLog = [];
                var t0 = performance.now();
                var timer = setInterval(function () {
                    var last = progressLog[progressLog.length - 1];
                    if (last && last.total) { h.note('Pobieranie… ' + Math.round(last.loaded / last.total * 100) + '%'); h.progress(last.loaded / last.total); }
                    else h.note('Ładuję model… ' + Math.round((performance.now() - t0) / 1000) + ' s');
                }, 400);
                return withTimeout(loadModel(), 300000, 'ładowanie modelu').then(function () {
                    clearInterval(timer);
                    ctx.modelLoaded = true;
                    var downloaded = progressLog.length > 0;
                    var ms = Math.round(performance.now() - t0);
                    return {
                        status: downloaded && ctx.modelCached ? 'warn' : 'ok',
                        say: downloaded ? 'Model został pobrany i uruchomiony (' + (ms / 1000).toFixed(0) + ' s).' : 'Model uruchomił się z pamięci telefonu w ' + (ms / 1000).toFixed(1) + ' s.',
                        detail: 'załadowany w ' + ms + ' ms' + (downloaded ? ', pobrano z sieci' + (ctx.modelCached ? ' mimo kompletnych plików w pamięci' : '') : ', z pamięci telefonu'),
                        data: { ms: ms, downloaded: downloaded }
                    };
                }, function (e) {
                    clearInterval(timer);
                    return { status: 'fail', say: 'Model nie chce się uruchomić: ' + msg(e) + '.', detail: msg(e) };
                });
            }
        },
        {
            icon: '📝', title: 'Model czyta zapisane nagranie',
            text: 'Wczytam nagranie z dziennika (nie prosto z mikrofonu), a model zamieni je na tekst. To dokładnie ta droga, którą idzie każdy Twój wpis.',
            button: 'Przepisz nagranie',
            run: function (ctx) {
                if (!ctx.appDb || !ctx.testName) return { status: 'skip', say: 'Pominięte, bo zapis w dzienniku się nie udał.', detail: 'brak wpisu testowego' };
                return getAll(ctx.appDb, 'audio').then(function (all) {
                    var a = all.filter(function (x) { return x.fileName === ctx.testName; })[0];
                    if (!a) throw new Error('nagrania nie ma w bazie');
                    return decodeTo16k(a.blob);
                }).then(function (d) {
                    var data = { decodedSeconds: Math.round(d.duration * 10) / 10, peak: Math.round(d.peak * 1000) / 1000 };
                    if (!ctx.modelLoaded) return { status: 'skip', say: 'Nagranie z dziennika da się odczytać, ale model nie jest uruchomiony, więc nie przepisałem.', detail: JSON.stringify(data), data: data };
                    if (ctx.test && ctx.test.synthetic) return { status: 'warn', say: 'Dźwięk testowy odczytany, ale bez prawdziwej mowy nie ma czego przepisać.', detail: JSON.stringify(data), data: data };
                    var t0 = performance.now();
                    return withTimeout(transcribe(d.samples), 180000, 'przepisywanie').then(function (r) {
                        var text = String(r.text || '').trim();
                        data.ms = Math.round(performance.now() - t0);
                        data.text = text;
                        data.words = text ? text.split(/\s+/).length : 0;
                        return {
                            status: text ? 'ok' : 'warn',
                            say: text ? 'Model zrozumiał nagranie. Usłyszał: „' + text + '”' : 'Model nic nie rozpoznał (cisza albo za cicho).',
                            detail: data.ms + ' ms dla nagrania ' + data.decodedSeconds + ' s; rozpoznano ' + data.words + ' słów',
                            data: data
                        };
                    });
                }, function (e) {
                    return { status: 'fail', say: 'Model nie mógł odczytać zapisanego nagrania: ' + msg(e) + '.', detail: msg(e) };
                });
            }
        },
        {
            icon: '🔄', title: 'Przepisywanie w aplikacji (cała droga)',
            text: 'Zlecę samej aplikacji przepisanie zapisanego nagrania, dokładnie tak jak po każdym Twoim nagraniu: kolejka, model, tekst zapisany we wpisie. To najważniejszy test. Może potrwać do dwóch minut.',
            button: 'Przepisz jak w aplikacji',
            run: function (ctx, h) {
                var app = window.lucidApp;
                if (!app || !app.enqueue) return { status: 'warn', say: 'Ta wersja aplikacji nie pozwala przetestować kolejki. Zaktualizuj aplikację i powtórz.', detail: 'brak window.lucidApp.enqueue' };
                if (!ctx.appDb || !ctx.testId) return { status: 'skip', say: 'Pominięte, bo zapis w dzienniku się nie udał.', detail: 'brak wpisu testowego' };
                if (ctx.test && ctx.test.synthetic) return { status: 'skip', say: 'Pominięte, bo nie ma prawdziwego nagrania z mową.', detail: 'dźwięk testowy' };
                // free the memory of our own copy of the model before the app loads its own
                stopWorker();
                ctx.modelLoaded = false;
                var t0 = performance.now();
                var data = {};
                function poll() {
                    return tx(ctx.appDb, 'entries', 'readonly', function (t) { return t.objectStore('entries').get(ctx.testId); }).then(function (e) {
                        var waited = Math.round((performance.now() - t0) / 1000);
                        if (e && (e.text || e.transcriptError)) return e;
                        if (waited > 120) throw new Error('aplikacja nie przepisała nagrania w 2 minuty (kolejka: ' + (e ? e.queued : 'brak wpisu') + ')');
                        h.note('Czekam, aż aplikacja przepisze… ' + waited + ' s');
                        return new Promise(function (r) { setTimeout(r, 700); }).then(poll);
                    });
                }
                return Promise.resolve(app.enqueue(ctx.testId)).then(poll).then(function (e) {
                    data.ms = Math.round(performance.now() - t0);
                    data.state = e.transcriptState;
                    data.error = e.transcriptError || null;
                    data.words = e.text ? e.text.trim().split(/\s+/).length : 0;
                    data.text = e.text || '';
                    if (e.transcriptError) return { status: 'fail', say: 'Aplikacja nie przepisała nagrania: ' + e.transcriptError, detail: 'błąd po ' + data.ms + ' ms: ' + e.transcriptError, data: data };
                    return {
                        status: 'ok',
                        say: 'Aplikacja sama przepisała nagranie w ' + (data.ms / 1000).toFixed(1) + ' s i zapisała tekst we wpisie: „' + data.text + '”',
                        detail: data.ms + ' ms, ' + data.words + ' słów, stan ' + data.state,
                        data: data
                    };
                }, function (e) {
                    return { status: 'fail', say: 'Przepisywanie w aplikacji się zawiesiło: ' + msg(e) + '.', detail: msg(e), data: data };
                });
            }
        },
        {
            icon: '🗂️', title: 'Kopia zapasowa',
            text: 'Zrobię prawdziwą kopię zapasową całego dziennika (z nagraniami), sprawdzę, czy jest w niej wpis testowy, i wczytam ją z powrotem. Nic się nie zdubluje. Przy dużym dzienniku to może chwilę potrwać.',
            button: 'Sprawdź kopię zapasową',
            run: function (ctx, h) {
                var app = window.lucidApp;
                if (!app || !app.exportBackup || !app.importBackup) return { status: 'warn', say: 'Ta wersja aplikacji nie pozwala przetestować kopii. Zaktualizuj aplikację i powtórz.', detail: 'brak window.lucidApp' };
                var data = {};
                var t0 = performance.now();
                h.note('Tworzę kopię…');
                return withTimeout(app.exportBackup(true), 180000, 'tworzenie kopii').then(function (blob) {
                    data.exportMs = Math.round(performance.now() - t0);
                    data.size = blob.size;
                    return blob.slice(0, 4).arrayBuffer().then(function (head) {
                        var h4 = new Uint8Array(head);
                        data.isZip = h4[0] === 0x50 && h4[1] === 0x4b;
                        // the file list of a zip is at its end
                        return blob.slice(Math.max(0, blob.size - 262144)).arrayBuffer();
                    }).then(function (tail) {
                        var txt = new TextDecoder('latin1').decode(tail);
                        data.hasJson = txt.indexOf('lucid-data.json') >= 0;
                        data.hasTestAudio = ctx.testName ? txt.indexOf('audio/' + ctx.testName) >= 0 : null;
                        data.canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], 'lucid.zip', { type: 'application/zip' })] }));
                        if (!data.isZip) throw new Error('kopia nie jest poprawnym plikiem zip');
                        if (!data.hasJson) throw new Error('w kopii nie ma pliku z wpisami');
                        if (ctx.testName && !data.hasTestAudio) throw new Error('w kopii brakuje nagrania wpisu testowego');
                        if (ctx.test && blob.size < ctx.test.blob.size) throw new Error('kopia (' + blob.size + ' B) jest mniejsza niż samo nagranie testowe');
                        h.note('Wczytuję kopię z powrotem…');
                        var t1 = performance.now();
                        return withTimeout(app.importBackup(new File([blob], 'lucid-diag.zip', { type: 'application/zip' })), 180000, 'wczytanie kopii').then(function (rep) {
                            data.importMs = Math.round(performance.now() - t1);
                            data.import = rep;
                        });
                    });
                }).then(function () {
                    var rep = data.import;
                    var dup = rep.imported > 0;
                    var why = [];
                    if (rep.failed) why.push(rep.failed + ' wpisów nie dało się wczytać');
                    if (dup) why.push('kopia dodała ' + rep.imported + ' wpisów, które już były (duplikaty)');
                    if (!data.canShare) why.push('ten telefon nie pokaże okna „Zapisz w Plikach”, kopia zapisze się jako pobranie');
                    return {
                        status: rep.failed || dup ? 'fail' : (data.canShare ? 'ok' : 'warn'),
                        say: why.length ? 'Kopia powstaje, ale: ' + why.join('; ') + '.' : 'Kopia zapasowa działa: powstała (' + fmtBytes(data.size) + '), zawiera nagrania i da się ją wczytać z powrotem bez duplikatów.',
                        detail: 'kopia ' + fmtBytes(data.size) + ' w ' + data.exportMs + ' ms; wczytanie ' + data.importMs + ' ms: nowych ' + rep.imported + ', pominiętych ' + rep.skipped + ', błędów ' + rep.failed + ', bez nagrania ' + rep.audioMissing + '; okno udostępniania plików: ' + (data.canShare ? 'tak' : 'nie'),
                        data: data
                    };
                }, function (e) {
                    return { status: 'fail', say: 'Kopia zapasowa nie działa: ' + msg(e) + '.', detail: msg(e), data: data };
                });
            }
        },
        {
            icon: '🧹', title: 'Sprzątanie', auto: true,
            run: function (ctx) {
                return cleanup(ctx).then(function (r) {
                    ctx.cleaned = true;
                    var ok = r.leftover === 0 && (ctx.baseEntries == null || r.entriesNow === ctx.baseEntries);
                    return {
                        status: ok ? 'ok' : 'warn',
                        say: ok ? 'Wpis testowy usunięty, Twój dziennik jest bez zmian (' + r.entriesNow + ' wpisów).' : 'Nie udało się w pełni posprzątać po teście: zostało ' + r.leftover + ' wpisów testowych (tytuł „' + TEST_TITLE + '”). Usuń je ręcznie.',
                        detail: 'usunięto ' + r.removed + ', wpisów teraz ' + r.entriesNow + ', przed testem ' + (ctx.baseEntries == null ? '?' : ctx.baseEntries),
                        data: r
                    };
                }, function (e) {
                    return { status: 'warn', say: 'Nie udało się posprzątać: ' + msg(e) + '. Usuń wpis „' + TEST_TITLE + '” ręcznie.', detail: msg(e) };
                });
            }
        }
    ];

    // What the user should do when a step is not OK (plain language), by step title.
    var FIXES = {
        'Telefon i aplikacja': 'Otwieraj aplikację z ikony na ekranie początkowym, a nie z karty przeglądarki.',
        'Wersja aplikacji': 'Wejdź w Ustawienia → Aktualizacja → Sprawdź aktualizację.',
        'Zgoda na zapis plików': 'Dodaj Lucid do ekranu początkowego (Udostępnij → Do ekranu początkowego) i otwieraj z ikony. Rób kopię zapasową co jakiś czas.',
        'Mikrofon': 'W Ustawieniach iPhone\'a pozwól tej aplikacji (lub przeglądarce) na mikrofon, potem uruchom diagnostykę jeszcze raz.',
        'Zapis w dzienniku': 'Zwolnij miejsce na telefonie (Ustawienia → Ogólne → Pamięć iPhone\'a) i otwórz aplikację z ikony.',
        'Odtwarzanie zapisanego nagrania': 'Nagraj ponownie. Jeśli się powtarza, wyślij mi raport: format nagrania może nie być obsługiwany.',
        'Długie nagranie (3 min)': 'Przy długich nagraniach zamknij inne aplikacje i nie blokuj ekranu.',
        'Model mowy: pliki': 'Wejdź w Ustawienia → Przepisywanie mowy → Pobierz model (najlepiej na Wi-Fi).',
        'Model mowy: uruchomienie': 'Zamknij aplikację całkiem i otwórz ją ponownie. Jeśli to nie pomoże, pobierz model jeszcze raz.',
        'Model czyta zapisane nagranie': 'Powtórz test, mów głośniej i bliżej mikrofonu.',
        'Przepisywanie w aplikacji (cała droga)': 'Zamknij aplikację całkiem, otwórz ją ponownie i powtórz. Jeśli błąd wraca, wyślij mi raport.',
        'Kopia zapasowa': 'Wyślij mi raport. Do czasu naprawy nie polegaj na przywracaniu kopii.',
        'Sprzątanie': 'Usuń ręcznie z dziennika wpisy o tytule „' + TEST_TITLE + '”.'
    };

    FIXES['Nagranie ' + REC_SECONDS + ' s (jak w aplikacji)'] = 'Zrestartuj iPhone\'a (znany błąd Safari: nagrywanie potrafi się zaciąć aż do restartu) i zamknij aplikacje, które używają mikrofonu.';
    FIXES['Nagranie ' + REC_SECONDS + ' s (bez paska poziomu)'] = 'Zrestartuj iPhone\'a i zamknij aplikacje, które używają mikrofonu.';

    // Removes the test entry and audio from the app's database and the test database.
    function cleanup(ctx) {
        return deleteTestDb().then(function () {
            var open = ctx.appDb ? Promise.resolve(ctx.appDb) : openLucidDb();
            return open.then(function (db) {
                ctx.appDb = db;
                return removeTestEntries(db).then(function (removed) {
                    return getAll(db, 'entries').then(function (entries) {
                        var left = entries.filter(function (e) { return e.title === TEST_TITLE; }).length;
                        return { removed: removed, leftover: left, entriesNow: entries.length };
                    });
                });
            });
        }, function () { return { removed: 0, leftover: 0, entriesNow: null }; });
    }

    // ---- running the wizard -----------------------------------------------------------------------------

    function summarize(report) {
        var s = { ok: 0, warn: 0, fail: 0, skip: 0 };
        report.steps.forEach(function (st) { if (s[st.status] != null) s[st.status]++; });
        return s;
    }

    function send(report) {
        return fetch(API + '/lucid/diagnostics/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(report)
        }).then(function (r) {
            if (!r.ok) throw new Error('serwer odpowiedział HTTP ' + r.status);
            return r.json();
        });
    }

    // ---- UI ------------------------------------------------------------------------------------------

    var CSS = ''
        + '#lucid-diag{position:fixed;inset:0;z-index:2147482500;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#000;color:#fff;'
        + 'font:15px/1.5 Outfit,system-ui,-apple-system,Helvetica,Arial,sans-serif;animation:ld-fade .35s ease both}'
        + '#lucid-diag *{box-sizing:border-box}'
        + '#lucid-diag .d-wrap{max-width:600px;margin:0 auto;padding:max(16px,env(safe-area-inset-top)) 16px max(28px,env(safe-area-inset-bottom))}'
        + '#lucid-diag .d-top{position:sticky;top:0;z-index:3;background:rgba(0,0,0,.92);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);padding:max(12px,env(safe-area-inset-top)) 16px 12px;margin:0 -16px}'
        + '#lucid-diag h1{font-size:22px;font-weight:300;margin:0 0 2px}'
        + '#lucid-diag .d-sub{color:#9a9aa6;font-size:13px;margin:0}'
        + '#lucid-diag .d-bar{position:relative;height:8px;border-radius:4px;background:#1f1f26;overflow:hidden;margin:12px 0 6px}'
        + '#lucid-diag .d-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:4px;background:linear-gradient(135deg,#4a00e0,#8e2de2);transition:width .7s cubic-bezier(.2,.8,.2,1)}'
        + '#lucid-diag .d-fill.run::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:ld-shimmer 1.3s linear infinite}'
        + '#lucid-diag .d-barlabel{display:flex;justify-content:space-between;color:#9a9aa6;font-size:12px}'
        + '#lucid-diag .d-dots{display:flex;gap:5px;margin-top:8px}'
        + '#lucid-diag .d-dot{flex:1;height:4px;border-radius:2px;background:#1f1f26;transition:background .4s,transform .4s}'
        + '#lucid-diag .d-dot.ok{background:#34c759;animation:ld-pop .5s ease}#lucid-diag .d-dot.warn{background:#ff9f0a;animation:ld-pop .5s ease}'
        + '#lucid-diag .d-dot.fail{background:#ff453a;animation:ld-pop .5s ease}#lucid-diag .d-dot.skip{background:#55555e}#lucid-diag .d-dot.now{background:#8e2de2}'
        + '#lucid-diag .d-cur{border:1px solid #3b2470;border-radius:20px;padding:20px 18px;margin:16px 0;background:linear-gradient(160deg,rgba(74,0,224,.28),rgba(142,45,226,.12));animation:ld-up .5s cubic-bezier(.2,.8,.2,1) both}'
        + '#lucid-diag .d-ico{font-size:44px;line-height:1;margin-bottom:8px;display:inline-block;animation:ld-float 3s ease-in-out infinite}'
        + '#lucid-diag h2{font-size:19px;font-weight:500;margin:0 0 6px}'
        + '#lucid-diag p{margin:0 0 10px}'
        + '#lucid-diag .d-live{margin:10px 0;font-size:16px;color:#c9a6ff;min-height:24px}'
        + '#lucid-diag .d-mini{height:5px;border-radius:3px;background:#1f1f26;overflow:hidden;margin:10px 0}'
        + '#lucid-diag .d-mini i{display:block;height:100%;width:0;background:linear-gradient(135deg,#4a00e0,#8e2de2);transition:width .25s linear}'
        + '#lucid-diag .d-row{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 0}'
        + '#lucid-diag button{font:inherit;color:#fff;border:1px solid #2a2a33;background:#1a1a1a;border-radius:14px;padding:11px 18px;min-height:46px;transition:transform .15s,opacity .2s}'
        + '#lucid-diag button:active{transform:scale(.96)}'
        + '#lucid-diag button.d-main{background:linear-gradient(135deg,#4a00e0,#8e2de2);border-color:transparent}'
        + '#lucid-diag button:disabled{opacity:.4}'
        + '#lucid-diag .d-res{text-align:center;padding:6px 0}'
        + '#lucid-diag .d-badge{width:76px;height:76px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;font-size:40px;font-weight:700;animation:ld-badge .6s cubic-bezier(.2,1.4,.4,1) both}'
        + '#lucid-diag .d-badge.ok{background:rgba(52,199,89,.18);color:#34c759;box-shadow:0 0 0 0 rgba(52,199,89,.5);animation:ld-badge .6s cubic-bezier(.2,1.4,.4,1) both,ld-ring 1.2s ease-out .3s}'
        + '#lucid-diag .d-badge.warn{background:rgba(255,159,10,.18);color:#ff9f0a}'
        + '#lucid-diag .d-badge.fail{background:rgba(255,69,58,.18);color:#ff453a;animation:ld-badge .6s cubic-bezier(.2,1.4,.4,1) both,ld-shake .5s ease .5s}'
        + '#lucid-diag .d-badge.skip{background:#1f1f26;color:#8e8e93}'
        + '#lucid-diag .d-say{font-size:16px;margin:0 6px 4px}'
        + '#lucid-diag .d-hist{margin-top:6px}'
        + '#lucid-diag .d-step{display:flex;gap:10px;align-items:flex-start;border:1px solid #262626;border-radius:16px;padding:11px 13px;margin:8px 0;background:#121212;animation:ld-up .45s cubic-bezier(.2,.8,.2,1) both}'
        + '#lucid-diag .d-sico{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:14px;font-weight:700;margin-top:1px}'
        + '#lucid-diag .d-sico.ok{background:rgba(52,199,89,.18);color:#34c759}#lucid-diag .d-sico.warn{background:rgba(255,159,10,.18);color:#ff9f0a}'
        + '#lucid-diag .d-sico.fail{background:rgba(255,69,58,.18);color:#ff453a}#lucid-diag .d-sico.skip{background:#1f1f26;color:#8e8e93}'
        + '#lucid-diag .d-sbody{flex:1;min-width:0}#lucid-diag .d-sname{font-weight:500}#lucid-diag .d-ssay{font-size:14px;color:#c9c9d6;word-break:break-word}'
        + '#lucid-diag details{margin-top:4px}#lucid-diag summary{font-size:12px;color:#9a9aa6;cursor:pointer}'
        + '#lucid-diag .d-detail{margin-top:4px;font-size:11px;color:#9a9aa6;word-break:break-word;font-family:ui-monospace,Menlo,monospace}'
        + '#lucid-diag .d-final{text-align:center;border:1px solid #3b2470;border-radius:20px;padding:22px 16px;margin:16px 0;background:linear-gradient(160deg,rgba(74,0,224,.28),rgba(142,45,226,.12));animation:ld-up .5s cubic-bezier(.2,.8,.2,1) both}'
        + '#lucid-diag .d-final .d-row{justify-content:center}'
        + '#lucid-diag .d-sum{text-align:left;margin:14px 0 4px}#lucid-diag .d-sum h2{text-align:center}'
        + '#lucid-diag .d-prob{border:1px solid #262626;border-left:4px solid #ff9f0a;border-radius:14px;padding:10px 12px;margin:8px 0;background:#121212;animation:ld-up .5s cubic-bezier(.2,.8,.2,1) both}#lucid-diag .d-prob.fail{border-left-color:#ff453a}'
        + '#lucid-diag .d-sfix{margin-top:4px;font-size:13px;color:#c9a6ff}'
        + '@keyframes ld-fade{from{opacity:0}to{opacity:1}}'
        + '@keyframes ld-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}'
        + '@keyframes ld-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}'
        + '@keyframes ld-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}'
        + '@keyframes ld-pop{0%{transform:scaleY(1)}50%{transform:scaleY(2.4)}100%{transform:scaleY(1)}}'
        + '@keyframes ld-badge{from{opacity:0;transform:scale(.3) rotate(-25deg)}to{opacity:1;transform:none}}'
        + '@keyframes ld-ring{from{box-shadow:0 0 0 0 rgba(52,199,89,.5)}to{box-shadow:0 0 0 28px rgba(52,199,89,0)}}'
        + '@keyframes ld-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}'
        + '@media (prefers-reduced-motion:reduce){#lucid-diag *{animation-duration:.01ms!important;transition-duration:.01ms!important}}';

    var MARK = { ok: '✓', warn: '!', fail: '✕', skip: '–' };

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function openPanel() {
        if (document.getElementById('lucid-diag')) return;
        var style = el('style');
        style.textContent = CSS;
        var panel = el('div');
        panel.id = 'lucid-diag';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Diagnostyka Lucid');
        panel.appendChild(style);
        var wrap = el('div', 'd-wrap');
        panel.appendChild(wrap);

        var top = el('div', 'd-top');
        top.appendChild(el('h1', null, 'Diagnostyka'));
        top.appendChild(el('p', 'd-sub', 'Przeprowadzę Cię krok po kroku. Treść Twoich snów nie jest wysyłana.'));
        var bar = el('div', 'd-bar');
        var fill = el('div', 'd-fill');
        bar.appendChild(fill);
        top.appendChild(bar);
        var barLabel = el('div', 'd-barlabel');
        var labelL = el('span');
        var labelR = el('span');
        barLabel.appendChild(labelL);
        barLabel.appendChild(labelR);
        top.appendChild(barLabel);
        var dotsEl = el('div', 'd-dots');
        var dots = STEPS.map(function () { var d = el('div', 'd-dot'); dotsEl.appendChild(d); return d; });
        top.appendChild(dotsEl);
        wrap.appendChild(top);

        var cur = el('div');
        var hist = el('div', 'd-hist');
        var sendLine = el('p', 'd-sub');
        sendLine.style.textAlign = 'center';
        wrap.appendChild(cur);
        wrap.appendChild(hist);
        wrap.appendChild(sendLine);
        document.body.appendChild(panel);
        var prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';

        var report = {
            app: 'lucid', version: 3, id: randomId(), startedAt: new Date().toISOString(),
            page: location.href, steps: [], errors: errors.slice(-30)
        };
        var ctx = {};
        var idx = 0;
        var closed = false;
        var sendChain = Promise.resolve();
        var bCopy = null, bResend = null;

        function setProgress(done, running) {
            var frac = Math.min(1, (done + (running ? 0.55 : 0)) / STEPS.length);
            fill.style.width = Math.round(frac * 100) + '%';
            fill.className = 'd-fill' + (running ? ' run' : '');
            labelL.textContent = done >= STEPS.length ? 'Gotowe' : 'Krok ' + (done + 1) + ' z ' + STEPS.length;
            labelR.textContent = Math.round(Math.min(1, done / STEPS.length) * 100) + '%';
        }

        function addHist(entry, step) {
            var box = el('div', 'd-step');
            box.appendChild(el('div', 'd-sico ' + entry.status, MARK[entry.status] || '?'));
            var body = el('div', 'd-sbody');
            body.appendChild(el('div', 'd-sname', step.title));
            body.appendChild(el('div', 'd-ssay', entry.say || ''));
            if (entry.fix) body.appendChild(el('div', 'd-sfix', 'Co zrobić: ' + entry.fix));
            if (entry.detail) {
                var det = el('details');
                det.appendChild(el('summary', null, 'Szczegóły techniczne'));
                det.appendChild(el('div', 'd-detail', entry.detail + (entry.ms ? ' [' + entry.ms + ' ms]' : '')));
                body.appendChild(det);
            }
            box.appendChild(body);
            hist.insertBefore(box, hist.firstChild);
        }

        // One POST at a time, in order; the line shows the state of the latest one.
        function sendNow() {
            report.errors = errors.slice(-30);
            report.summary = summarize(report);
            var snapshot = JSON.parse(JSON.stringify(report));
            sendLine.textContent = 'Wysyłam wynik na serwer…';
            sendChain = sendChain.then(function () { return send(snapshot); }).then(function () {
                sendLine.textContent = '✓ Wynik wysłany na serwer';
            }, function (e) {
                sendLine.textContent = 'Nie udało się wysłać na serwer (' + msg(e) + '). Użyj „Kopiuj raport” i wklej do rozmowy.';
            });
            return sendChain;
        }

        function showFinal() {
            report.finishedAt = new Date().toISOString();
            setProgress(STEPS.length, false);
            var s = summarize(report);
            cur.textContent = '';
            var box = el('div', 'd-final');
            var worst = s.fail ? 'fail' : (s.warn ? 'warn' : 'ok');
            box.appendChild(el('div', 'd-badge ' + worst, MARK[worst]));
            box.appendChild(el('h2', null, worst === 'ok' ? 'Wszystko działa' : (worst === 'warn' ? 'Działa, ale są uwagi' : 'Znaleziono problemy')));
            box.appendChild(el('p', 'd-sub', 'OK: ' + s.ok + '  ·  Uwagi: ' + s.warn + '  ·  Błędy: ' + s.fail + '  ·  Pominięte: ' + s.skip + '. Wszystkie wyniki są na serwerze.'));
            var bad = report.steps.filter(function (st) { return st.status === 'warn' || st.status === 'fail'; });
            report.userSummary = bad.length
                ? bad.map(function (st) { return (st.status === 'fail' ? 'BŁĄD' : 'UWAGA') + ' - ' + st.name + ': ' + st.say + (st.fix ? ' Co zrobić: ' + st.fix : ''); }).join('\n')
                : 'Nic nie wymaga uwagi.';
            var sumBox = el('div', 'd-sum');
            sumBox.appendChild(el('h2', null, bad.length ? 'Co nie działa i co z tym zrobić' : 'Nic nie wymaga uwagi'));
            bad.forEach(function (st) {
                var item = el('div', 'd-prob ' + st.status);
                item.appendChild(el('div', 'd-sname', (st.status === 'fail' ? '✕ ' : '! ') + st.name));
                item.appendChild(el('div', 'd-ssay', st.say));
                if (st.fix) item.appendChild(el('div', 'd-sfix', 'Co zrobić: ' + st.fix));
                sumBox.appendChild(item);
            });
            box.appendChild(sumBox);
            var row = el('div', 'd-row');
            bCopy = el('button', null, 'Kopiuj raport');
            bResend = el('button', null, 'Wyślij ponownie');
            var bClose = el('button', 'd-main', 'Zamknij');
            [bCopy, bResend, bClose].forEach(function (b) { b.type = 'button'; row.appendChild(b); });
            box.appendChild(row);
            cur.appendChild(box);
            panel.scrollTop = 0;
            bResend.addEventListener('click', sendNow);
            bCopy.addEventListener('click', function () {
                var text = JSON.stringify(report, null, 2);
                var ok = function () { bCopy.textContent = 'Skopiowano ✓'; };
                var fallback = function () {
                    var ta = el('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:40%;z-index:5;background:#111;color:#fff';
                    panel.appendChild(ta);
                    ta.focus();
                    ta.select();
                    try { document.execCommand('copy'); ok(); } catch (e) { bCopy.textContent = 'Zaznacz tekst i skopiuj ręcznie'; }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
                else fallback();
            });
            bClose.addEventListener('click', close);
            sendNow();
        }

        function close() {
            closed = true;
            stopWorker();
            var done = ctx.cleaned ? Promise.resolve() : cleanup(ctx);
            done.then(function () { if (ctx.appDb) { try { ctx.appDb.close(); } catch (e) { /* ignore */ } } });
            document.documentElement.style.overflow = prevOverflow;
            if (panel.parentNode) panel.parentNode.removeChild(panel);
        }

        // The top-left close button for leaving in the middle.
        var bX = el('button', null, '✕');
        bX.type = 'button';
        bX.setAttribute('aria-label', 'Zamknij diagnostykę');
        bX.style.cssText = 'position:absolute;right:16px;top:max(12px,env(safe-area-inset-top));min-height:36px;padding:4px 12px;border-radius:12px';
        bX.addEventListener('click', close);
        top.appendChild(bX);

        function showStep() {
            if (closed) return;
            setProgress(idx, false);
            dots.forEach(function (d, i) { if (i === idx) d.classList.add('now'); });
            if (idx >= STEPS.length) { showFinal(); return; }
            var step = STEPS[idx];
            cur.textContent = '';
            var card = el('div', 'd-cur');
            card.appendChild(el('div', 'd-ico', step.icon));
            card.appendChild(el('h2', null, step.title));
            if (step.text) card.appendChild(el('p', null, step.text));
            var live = el('div', 'd-live');
            var mini = el('div', 'd-mini');
            var miniFill = el('i');
            mini.appendChild(miniFill);
            mini.style.display = 'none';
            card.appendChild(live);
            card.appendChild(mini);
            var btns = el('div', 'd-row');
            var bGo = el('button', 'd-main', step.button || 'Dalej');
            bGo.type = 'button';
            btns.appendChild(bGo);
            var bSkip = null;
            if (!step.auto) {
                bSkip = el('button', null, 'Pomiń');
                bSkip.type = 'button';
                btns.appendChild(bSkip);
            }
            card.appendChild(btns);
            cur.appendChild(card);
            panel.scrollTop = 0;

            var entry = null;
            function advance() { idx++; showStep(); }

            function finish(res, t0) {
                var status = res.status || 'ok';
                entry.status = status;
                entry.say = res.say || '';
                entry.detail = res.detail == null ? '' : String(res.detail);
                entry.fix = status === 'warn' || status === 'fail' ? (res.fix || FIXES[step.title] || '') : '';
                if (res.data) entry.data = JSON.parse(JSON.stringify(res.data, function (k, v) { return k.charAt(0) === '_' ? undefined : v; }));
                entry.ms = Math.round(performance.now() - t0);
                dots[idx].classList.remove('now');
                dots[idx].classList.add(status);
                setProgress(idx + 1, false);
                sendNow();
                // result card: animated badge + plain-language sentence; good results move on by themselves
                cur.textContent = '';
                var rc = el('div', 'd-cur');
                var r = el('div', 'd-res');
                r.appendChild(el('div', 'd-badge ' + status, MARK[status]));
                r.appendChild(el('h2', null, step.title));
                r.appendChild(el('p', 'd-say', entry.say));
                rc.appendChild(r);
                var rb = el('div', 'd-row');
                rb.style.justifyContent = 'center';
                var bNext = el('button', 'd-main', idx + 1 >= STEPS.length ? 'Zakończ' : 'Dalej');
                bNext.type = 'button';
                rb.appendChild(bNext);
                rc.appendChild(rb);
                cur.appendChild(rc);
                addHist(entry, step);
                var moved = false;
                var next = function () { if (moved) return; moved = true; advance(); };
                bNext.addEventListener('click', next);
                if (status === 'ok') setTimeout(next, 1600);
                else if (status === 'skip') setTimeout(next, 1600);
            }

            function go() {
                bGo.disabled = true;
                if (bSkip) bSkip.disabled = true;
                var t0 = performance.now();
                entry = { name: step.title, status: 'run', say: '', detail: '', ms: 0 };
                report.steps.push(entry);
                setProgress(idx, true);
                resetStall();
                live.textContent = step.auto ? 'Sprawdzam…' : 'Pracuję…';
                var h = {
                    note: function (t) { live.textContent = t; },
                    progress: function (f) { mini.style.display = ''; miniFill.style.width = Math.round(f * 100) + '%'; }
                };
                var res;
                try { res = Promise.resolve(step.run(ctx, h)); } catch (e) { res = Promise.reject(e); }
                withTimeout(res, 330000, step.title).then(function (r) {
                    finish(r || {}, t0);
                }, function (e) {
                    finish({ status: 'fail', say: 'Ten krok się nie powiódł: ' + msg(e) + '.', detail: msg(e) }, t0);
                });
            }
            bGo.addEventListener('click', go);
            if (bSkip) bSkip.addEventListener('click', function () {
                entry = { name: step.title, status: 'skip', say: 'Pominięte na Twoją prośbę.', detail: '', ms: 0 };
                report.steps.push(entry);
                dots[idx].classList.remove('now');
                dots[idx].classList.add('skip');
                addHist(entry, step);
                sendNow();
                advance();
            });
            if (step.auto) setTimeout(go, 500);
        }

        setProgress(0, false);
        showStep();
    }

    window.lucidDiag = { open: openPanel };

    function autoOpen() {
        if (/[?&]diag=1(&|$)/.test(location.search)) openPanel();
    }
    if (document.body) autoOpen();
    else document.addEventListener('DOMContentLoaded', autoOpen);
})();

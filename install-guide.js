// Lucid PWA - "Add to Home Screen" guide for iPhone / iPad.
//
// Plain script (no build step, no framework): index.html loads it with <script defer src="/install-guide.js">.
// It draws a full-screen overlay with five illustrated steps, but only when Lucid is opened in a normal
// browser tab on iOS. Opened from the home-screen icon (standalone) or on any other device it does nothing,
// so the app itself is never affected. The overlay keeps the page URL at "/", which is what iOS adds to the
// home screen, and the manifest start_url is the same.
//
// Test on a desktop browser: open /?guide=1 (forces the guide). /?guide=0 switches it off.
// This file must live in Lucid\pwa\public\ too, otherwise the next build of the PWA removes it.
(function () {
    'use strict';

    var ua = navigator.userAgent || '';
    var search = location.search || '';
    var force = /[?&]guide=1(&|$)/.test(search);
    var off = /[?&]guide=0(&|$)/.test(search);
    var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    if (off || (standalone && !force)) return;
    if (!isIOS && !force) return;
    try {
        if (!force && sessionStorage.getItem('lucid-guide-skip') === '1') return;
    } catch (e) { /* storage blocked: show the guide */ }

    // Not Safari (Chrome, Firefox, in-app browsers of Messenger, Instagram...): add-to-home-screen is least reliable there.
    var notSafari = /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|FB_IAB|Instagram|Line\/|GSA\/|Snapchat|TikTok|Twitter|MicroMessenger/.test(ua)
        || (isIOS && !/Safari\//.test(ua));

    var pl = (navigator.language || 'pl').toLowerCase().indexOf('pl') === 0;
    var T = pl ? {
        kicker: 'Lucid na iPhonie',
        title: 'Dodaj Lucid do ekranu początkowego',
        lead: 'Lucid nie jest w App Store. Działa jak aplikacja z własną ikoną, ale trzeba ją raz dodać z przeglądarki. To pół minuty i nie wymaga konta.',
        notSafari: 'Wygląda na to, że to nie jest Safari. Aby dodać aplikację, otwórz ten adres w Safari.',
        copy: 'Kopiuj adres',
        copied: 'Skopiowano',
        stepWord: 'Krok',
        s1t: 'Otwórz tę stronę w Safari',
        s1p: 'Dodawanie do ekranu działa z poziomu przeglądarki. Jeśli widzisz tę stronę w innej aplikacji (Messenger, Instagram, poczta), otwórz ją w Safari.',
        s2t: 'Stuknij Udostępnij',
        s2p: 'To kwadrat ze strzałką w górę. Na starszych wersjach iOS jest na dolnym pasku, na nowszych najpierw stuknij trzy kropki w prawym dolnym rogu, a potem Udostępnij.',
        s2a: 'Starsze iOS: ikona na dolnym pasku',
        s2b: 'Nowsze iOS: trzy kropki, potem Udostępnij',
        s3t: 'Wybierz „Dodaj do ekranu początkowego”',
        s3p: 'Jeśli tej pozycji nie widać, przewiń listę w dół. Ma ikonę kwadratu z plusem.',
        s4t: 'Stuknij „Dodaj”',
        s4p: 'Przycisk jest w prawym górnym rogu. Jeśli widzisz opcję „Otwórz jako aplikację internetową”, zostaw ją włączoną. Nazwa może zostać „Lucid”.',
        s5t: 'Otwórz Lucid z ekranu początkowego',
        s5p: 'Zamknij Safari i uruchom Lucid z nowej ikony. Tylko tak działa jak aplikacja: na pełnym ekranie i z trwałym zapisem danych. Przy pierwszym nagraniu zezwól na mikrofon.',
        skip: 'Zostaję w przeglądarce',
        skipNote: 'Bez dodania do ekranu iOS może z czasem usunąć dane zapisane w zwykłej karcie przeglądarki.',
        copyRow: 'Kopiuj',
        bookmark: 'Dodaj zakładkę',
        home: 'Dodaj do ekranu początkowego',
        find: 'Znajdź na stronie',
        cancel: 'Anuluj',
        add: 'Dodaj',
        webApp: 'Otwórz jako aplikację internetową',
        close: 'Zamknij instrukcję'
    } : {
        kicker: 'Lucid on iPhone',
        title: 'Add Lucid to your Home Screen',
        lead: 'Lucid is not in the App Store. It works like an app with its own icon, but you add it once from the browser. It takes half a minute and needs no account.',
        notSafari: 'This does not look like Safari. To add the app, open this address in Safari.',
        copy: 'Copy address',
        copied: 'Copied',
        stepWord: 'Step',
        s1t: 'Open this page in Safari',
        s1p: 'Adding to the Home Screen works from the browser. If you see this page inside another app (Messenger, Instagram, Mail), open it in Safari.',
        s2t: 'Tap Share',
        s2p: 'It is a square with an arrow pointing up. On older iOS it is on the bottom bar; on newer iOS first tap the three dots at the bottom right, then Share.',
        s2a: 'Older iOS: icon on the bottom bar',
        s2b: 'Newer iOS: three dots, then Share',
        s3t: 'Choose "Add to Home Screen"',
        s3p: 'If you do not see it, scroll the list down. It has a square-with-a-plus icon.',
        s4t: 'Tap "Add"',
        s4p: 'The button is in the top right corner. If you see "Open as Web App", leave it on. The name can stay "Lucid".',
        s5t: 'Open Lucid from the Home Screen',
        s5p: 'Close Safari and start Lucid from its new icon. Only then does it work as an app: full screen, with data stored permanently. On your first recording, allow the microphone.',
        skip: 'Stay in the browser',
        skipNote: 'Without adding it to the Home Screen, iOS may delete data saved in a regular browser tab over time.',
        copyRow: 'Copy',
        bookmark: 'Add Bookmark',
        home: 'Add to Home Screen',
        find: 'Find on Page',
        cancel: 'Cancel',
        add: 'Add',
        webApp: 'Open as Web App',
        close: 'Close guide'
    };

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var HOST = esc(location.host || 'lucid-app.youreasysite.pl');
    var ACCENT = '#8E2DE2';
    var FONT = '-apple-system, BlinkMacSystemFont, \'SF Pro Text\', Helvetica, Arial, sans-serif';

    // ---- drawing blocks ---------------------------------------------------------------------------

    function svg(inner) {
        return '<svg viewBox="0 0 280 170" width="280" height="170" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" font-family="' + FONT + '">' + inner + '</svg>';
    }

    // Pulsing ring that marks the thing to tap. cx, cy = centre, r = radius.
    function ring(cx, cy, r) {
        return '<circle class="lg-ring" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="rgba(142,45,226,0.18)" stroke="' + ACCENT + '" stroke-width="2"/>';
    }

    // Rounded rectangle highlight (rows, buttons).
    function box(x, y, w, h, r) {
        return '<rect class="lg-ring" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" fill="rgba(142,45,226,0.16)" stroke="' + ACCENT + '" stroke-width="2"/>';
    }

    // iOS share glyph centred on (0,0), blue.
    function shareGlyph(x, y, color) {
        return '<g transform="translate(' + x + ',' + y + ')" fill="none" stroke="' + color + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M-6 -1.5 V8 H6 V-1.5"/><path d="M0 -11 V3.5"/><path d="M-4 -7 L0 -11 L4 -7"/></g>';
    }

    // Tap hint: a fingertip dot that nudges. Outer group positions it, inner group animates (CSS transform would override the attribute).
    function finger(x, y) {
        return '<g transform="translate(' + x + ',' + y + ')"><g class="lg-tap">'
            + '<circle r="9" fill="rgba(255,255,255,0.9)" stroke="#444" stroke-width="1"/>'
            + '<circle r="3.2" fill="' + ACCENT + '"/></g></g>';
    }

    // The real app icon with rounded corners (the PNG itself is a square).
    var iconSeq = 0;
    function appIcon(x, y, size) {
        var id = 'lgIcon' + (iconSeq++);
        return '<clipPath id="' + id + '"><rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="' + (size * 0.225) + '"/></clipPath>'
            + '<image href="/icons/icon-192.png" x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#' + id + ')"/>'
            + '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="' + (size * 0.225) + '" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>';
    }

    var BLUE = '#007aff';
    var GREY = '#8e8e93';
    var INK = '#1c1c1e';

    // Phone body whose lower part is visible (top cut by the viewBox).
    function phoneBottom() {
        return '<rect x="20" y="-90" width="240" height="238" rx="30" fill="#17171d" stroke="#3a3a48" stroke-width="2"/>'
            + '<rect x="27" y="-90" width="226" height="225" rx="23" fill="#f2f2f7"/>';
    }

    // 1 - Safari in the foreground: compass icon + phone with the address bar.
    function drawSafari() {
        return svg(
            '<defs><linearGradient id="lgCompass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fb4ff"/><stop offset="1" stop-color="#0a64e0"/></linearGradient></defs>'
            + '<rect x="14" y="62" width="58" height="58" rx="14" fill="url(#lgCompass)"/>'
            + '<circle cx="43" cy="91" r="22" fill="none" stroke="#fff" stroke-width="2"/>'
            + '<path d="M43 74 L49 94 L43 108 L37 88 Z" transform="rotate(40 43 91)" fill="#ff3b30"/>'
            + '<path d="M43 108 L37 88 L43 74 L49 94 Z" transform="rotate(40 43 91) rotate(180 43 91)" fill="#fff"/>'
            + '<circle cx="43" cy="91" r="2" fill="#17171d"/>'
            + '<rect x="96" y="14" width="164" height="190" rx="24" fill="#17171d" stroke="#3a3a48" stroke-width="2"/>'
            + '<rect x="102" y="20" width="152" height="178" rx="19" fill="#f2f2f7"/>'
            + '<rect x="110" y="30" width="136" height="22" rx="8" fill="#e3e3e8"/>'
            + '<rect x="119" y="38" width="7" height="7" rx="1.5" fill="none" stroke="' + GREY + '" stroke-width="1.2"/>'
            + '<text x="132" y="45" font-size="8" fill="' + INK + '">' + HOST + '</text>'
            + '<rect x="110" y="60" width="136" height="74" rx="10" fill="#000"/>'
            + '<path d="M110 100 C130 88 150 112 170 100 C190 88 210 112 246 98 V124 a10 10 0 0 1 -10 10 H120 a10 10 0 0 1 -10 -10 Z" fill="rgba(142,45,226,0.55)"/>'
            + '<text x="178" y="82" text-anchor="middle" font-size="15" font-weight="300" fill="#fff" letter-spacing="2">Lucid</text>'
            + box(106, 26, 144, 30, 11)
        );
    }

    // 2a - classic Safari: share icon on the bottom toolbar.
    function drawShareClassic() {
        var xs = [55, 98, 141, 184, 227];
        var out = phoneBottom();
        out += '<rect x="27" y="104" width="226" height="31" fill="#f9f9fb"/><line x1="27" y1="104" x2="253" y2="104" stroke="#d1d1d6" stroke-width="1"/>';
        out += '<path d="M' + (xs[0] + 3) + ' 113 l-6 7 l6 7" fill="none" stroke="' + BLUE + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
        out += '<path d="M' + (xs[1] - 3) + ' 113 l6 7 l-6 7" fill="none" stroke="' + GREY + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>';
        out += ring(xs[2], 120, 17);
        out += shareGlyph(xs[2], 120, BLUE);
        out += '<path d="M' + (xs[3] - 8) + ' 114 h9 a4 4 0 0 1 4 4 v11 l-4 -3 h-9 Z" fill="none" stroke="' + BLUE + '" stroke-width="1.5" stroke-linejoin="round" transform="translate(0,-1)"/>';
        out += '<rect x="' + (xs[4] - 8) + '" y="113" width="12" height="12" rx="2.5" fill="none" stroke="' + BLUE + '" stroke-width="1.6"/><rect x="' + (xs[4] - 4) + '" y="117" width="12" height="12" rx="2.5" fill="#f9f9fb" stroke="' + BLUE + '" stroke-width="1.6"/>';
        out += '<rect x="112" y="140" width="56" height="3" rx="1.5" fill="#1c1c1e" opacity="0.8"/>';
        out += finger(xs[2] + 14, 134);
        return svg(out);
    }

    // 2b - newer Safari: address pill + three dots, which open a menu with Share.
    function drawShareNew() {
        var out = phoneBottom();
        out += '<rect x="36" y="100" width="168" height="30" rx="15" fill="#e3e3e8"/>';
        out += '<text x="52" y="119" font-size="9" fill="' + INK + '">aA</text>';
        out += '<text x="120" y="119" text-anchor="middle" font-size="8" fill="' + INK + '">' + HOST + '</text>';
        out += '<circle cx="226" cy="115" r="15" fill="#e3e3e8"/>';
        out += ring(226, 115, 17);
        out += '<circle cx="219" cy="115" r="1.9" fill="' + INK + '"/><circle cx="226" cy="115" r="1.9" fill="' + INK + '"/><circle cx="233" cy="115" r="1.9" fill="' + INK + '"/>';
        // the menu that opens, with Share first
        out += '<rect x="132" y="-6" width="118" height="72" rx="14" fill="#fff" stroke="#d1d1d6" stroke-width="1"/>';
        out += '<rect x="136" y="2" width="110" height="26" rx="8" fill="rgba(142,45,226,0.16)" stroke="' + ACCENT + '" stroke-width="1.6" class="lg-ring"/>';
        out += '<text x="146" y="19" font-size="9" fill="' + INK + '">' + esc(T.s2t.replace(/^Stuknij /, '').replace(/^Tap /, '')) + '</text>';
        out += shareGlyph(231, 15, BLUE);
        out += '<line x1="140" y1="34" x2="246" y2="34" stroke="#e5e5ea" stroke-width="1"/>';
        out += '<rect x="146" y="42" width="52" height="5" rx="2.5" fill="#d1d1d6"/><rect x="146" y="54" width="36" height="5" rx="2.5" fill="#e5e5ea"/>';
        out += '<path d="M226 79 V90" stroke="' + ACCENT + '" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 4"/>';
        out += '<path d="M222 85 l4 5 l4 -5" fill="none" stroke="' + ACCENT + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        return svg(out);
    }

    // 3 - the share sheet with "Add to Home Screen".
    function drawSheet() {
        function row(y, label, icon, hi) {
            var out = '';
            if (hi) out += box(34, y - 12, 212, 24, 8);
            out += '<text x="46" y="' + (y + 3.5) + '" font-size="8.5" fill="' + INK + '"' + (hi ? ' font-weight="600"' : '') + '>' + esc(label) + '</text>';
            out += icon;
            return out;
        }
        var plusSquare = '<g transform="translate(231,0)" fill="none" stroke="' + INK + '" stroke-width="1.5" stroke-linecap="round"><rect x="-7" y="HH" width="14" height="14" rx="3"/><path d="M0 PP V QQ M-3.5 MM H3.5"/></g>';
        function plus(y) {
            return plusSquare.replace('HH', y - 7).replace('PP', y - 3.5).replace('QQ', y + 3.5).replace('MM', y);
        }
        var out = '<rect x="20" y="8" width="240" height="170" rx="22" fill="#17171d" stroke="#3a3a48" stroke-width="2"/>'
            + '<rect x="27" y="14" width="226" height="170" rx="18" fill="#e9e9ee"/>'
            + '<rect x="130" y="19" width="20" height="3" rx="1.5" fill="#b0b0b8"/>'
            + appIcon(34, 28, 22)
            + '<text x="64" y="37" font-size="8.5" font-weight="600" fill="' + INK + '">Lucid</text>'
            + '<text x="64" y="47" font-size="7" fill="' + GREY + '">' + HOST + '</text>'
            + '<rect x="34" y="56" width="212" height="112" rx="10" fill="#fff"/>'
            + row(70, T.copyRow, '<g transform="translate(231,70)" fill="none" stroke="' + INK + '" stroke-width="1.4"><rect x="-5" y="-6" width="9" height="11" rx="2"/><rect x="-8" y="-3" width="9" height="11" rx="2" fill="#fff"/></g>', false)
            + '<line x1="46" y1="82" x2="246" y2="82" stroke="#e5e5ea" stroke-width="1"/>'
            + row(96, T.bookmark, '<g transform="translate(231,96)" fill="none" stroke="' + INK + '" stroke-width="1.4" stroke-linejoin="round"><path d="M-7 -7 H7 V8 L0 3 L-7 8 Z"/></g>', false)
            + '<line x1="46" y1="108" x2="246" y2="108" stroke="#e5e5ea" stroke-width="1"/>'
            + row(122, T.home, plus(122), true)
            + '<line x1="46" y1="134" x2="246" y2="134" stroke="#e5e5ea" stroke-width="1"/>'
            + row(148, T.find, '<g transform="translate(231,148)" fill="none" stroke="' + INK + '" stroke-width="1.5" stroke-linecap="round"><circle cx="-1" cy="-1" r="5"/><path d="M3 3 L7 7"/></g>', false)
            + finger(190, 138);
        return svg(out);
    }

    // 4 - the "Add to Home Screen" dialog.
    function drawDialog() {
        var out = '<rect x="20" y="8" width="240" height="170" rx="22" fill="#17171d" stroke="#3a3a48" stroke-width="2"/>'
            + '<rect x="27" y="14" width="226" height="170" rx="18" fill="#e9e9ee"/>'
            + '<text x="38" y="39" font-size="9" fill="' + BLUE + '">' + esc(T.cancel) + '</text>'
            + '<text x="138" y="39" text-anchor="middle" font-size="8.5" font-weight="600" fill="' + INK + '">' + esc(T.home) + '</text>'
            + box(204, 24, 46, 22, 11)
            + '<text x="227" y="39" text-anchor="middle" font-size="9.5" font-weight="600" fill="' + BLUE + '">' + esc(T.add) + '</text>'
            + '<rect x="34" y="56" width="212" height="52" rx="10" fill="#fff"/>'
            + appIcon(44, 64, 36)
            + '<text x="92" y="79" font-size="10" fill="' + INK + '">Lucid</text>'
            + '<line x1="88" y1="85" x2="238" y2="85" stroke="#e5e5ea" stroke-width="1"/>'
            + '<text x="92" y="97" font-size="7" fill="' + GREY + '">' + HOST + '</text>'
            + '<rect x="34" y="116" width="212" height="34" rx="10" fill="#fff"/>'
            + '<text x="44" y="130" font-size="8.5" fill="' + INK + '">' + esc(T.webApp) + '</text>'
            + '<text x="44" y="141" font-size="6.5" fill="' + GREY + '">' + HOST + '</text>'
            + '<rect x="204" y="123" width="34" height="20" rx="10" fill="#34c759"/><circle cx="228" cy="133" r="8" fill="#fff"/>'
            + finger(236, 52);
        return svg(out);
    }

    // 5 - the home screen with the Lucid icon.
    function drawHome() {
        var colors = ['#34c759', '#ff9500', '#5ac8fa', '#ff2d55', '#af52de', '#ffcc00', null, '#64d2ff'];
        var out = '<rect x="20" y="-30" width="240" height="196" rx="30" fill="#17171d" stroke="#3a3a48" stroke-width="2"/>'
            + '<defs><linearGradient id="lgWall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a1b6e"/><stop offset="1" stop-color="#0b0b1f"/></linearGradient></defs>'
            + '<rect x="27" y="-30" width="226" height="183" rx="23" fill="url(#lgWall)"/>';
        var cx = [60, 110, 160, 210];
        for (var i = 0; i < 8; i++) {
            var x = cx[i % 4] - 17;
            var y = i < 4 ? 14 : 70;
            if (colors[i] === null) {
                out += ring(cx[i % 4], y + 17, 28);
                out += appIcon(x, y, 34);
                out += '<text x="' + cx[i % 4] + '" y="' + (y + 46) + '" text-anchor="middle" font-size="7.5" font-weight="600" fill="#fff">Lucid</text>';
            } else {
                out += '<rect x="' + x + '" y="' + y + '" width="34" height="34" rx="8" fill="' + colors[i] + '" opacity="0.85"/>';
                out += '<rect x="' + (cx[i % 4] - 10) + '" y="' + (y + 40) + '" width="20" height="4" rx="2" fill="rgba(255,255,255,0.35)"/>';
            }
        }
        out += '<rect x="36" y="116" width="208" height="30" rx="14" fill="rgba(255,255,255,0.16)"/>';
        for (var j = 0; j < 4; j++) out += '<rect x="' + (cx[j] - 12) + '" y="120" width="24" height="22" rx="6" fill="rgba(255,255,255,0.35)"/>';
        out += finger(cx[2] + 16, 98);
        return svg(out);
    }

    // ---- overlay ------------------------------------------------------------------------------------

    var CSS = ''
        + '#lucid-guide{position:fixed;inset:0;z-index:2147483000;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;'
        + 'background:radial-gradient(120% 60% at 50% 0%,rgba(74,0,224,.35),rgba(0,0,0,0) 60%),#000;color:#fff;font-family:' + FONT + ';'
        + 'padding:max(20px,env(safe-area-inset-top)) 20px max(32px,env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}'
        + '#lucid-guide *{box-sizing:border-box}'
        + '#lucid-guide .lg-wrap{max-width:440px;margin:0 auto}'
        + '#lucid-guide .lg-kicker{margin:18px 0 0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.55)}'
        + '#lucid-guide h1{margin:8px 0 0;font-size:28px;line-height:1.2;font-weight:300;letter-spacing:.01em}'
        + '#lucid-guide .lg-lead{margin:14px 0 0;font-size:15px;line-height:1.6;font-weight:300;color:rgba(255,255,255,.78)}'
        + '#lucid-guide .lg-warn{margin:20px 0 0;padding:14px 16px;border-radius:16px;border:1px solid rgba(255,159,10,.5);background:rgba(255,159,10,.08);font-size:14px;line-height:1.55;color:rgba(255,255,255,.9)}'
        + '#lucid-guide .lg-warn button{margin-top:10px}'
        + '#lucid-guide ol{list-style:none;margin:28px 0 0;padding:0;display:flex;flex-direction:column;gap:18px}'
        + '#lucid-guide li{border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:18px 16px 20px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02))}'
        + '#lucid-guide .lg-num{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55)}'
        + '#lucid-guide .lg-num b{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:1px solid rgba(255,255,255,.4);font-weight:400;font-size:12px;letter-spacing:0;color:#fff}'
        + '#lucid-guide h2{margin:10px 0 0;font-size:19px;line-height:1.3;font-weight:400}'
        + '#lucid-guide p.lg-p{margin:8px 0 0;font-size:14.5px;line-height:1.6;font-weight:300;color:rgba(255,255,255,.78)}'
        + '#lucid-guide figure{margin:14px 0 0;display:flex;flex-direction:column;align-items:center;gap:6px}'
        + '#lucid-guide figure svg{width:100%;max-width:340px;height:auto;display:block;border-radius:16px;background:rgba(255,255,255,.04)}'
        + '#lucid-guide figcaption{font-size:12px;color:rgba(255,255,255,.55);text-align:center}'
        + '#lucid-guide button{font-family:inherit;cursor:pointer}'
        + '#lucid-guide .lg-btn{border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.1);color:#fff;border-radius:999px;padding:10px 18px;font-size:14px}'
        + '#lucid-guide .lg-skip{display:block;margin:26px auto 0;border:0;background:none;color:rgba(255,255,255,.55);font-size:13px;text-decoration:underline;text-underline-offset:3px;padding:8px}'
        + '#lucid-guide .lg-note{margin:4px auto 0;max-width:340px;text-align:center;font-size:12px;line-height:1.5;color:rgba(255,255,255,.4)}'
        + '#lucid-guide .lg-ring{transform-box:fill-box;transform-origin:center;animation:lg-pulse 1.8s ease-in-out infinite}'
        + '#lucid-guide .lg-tap{animation:lg-tap 1.8s ease-in-out infinite}'
        + '@keyframes lg-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.07)}}'
        + '@keyframes lg-tap{0%,100%{transform:translate(0,0)}50%{transform:translate(-3px,-3px)}}'
        + '@media (prefers-reduced-motion:reduce){#lucid-guide .lg-ring,#lucid-guide .lg-tap{animation:none}}';

    function stepHtml(n, title, text, figures) {
        var figs = '';
        for (var i = 0; i < figures.length; i++) {
            figs += '<figure>' + figures[i].svg + (figures[i].caption ? '<figcaption>' + esc(figures[i].caption) + '</figcaption>' : '') + '</figure>';
        }
        return '<li><span class="lg-num"><b>' + n + '</b>' + esc(T.stepWord) + ' ' + n + '/5</span>'
            + '<h2>' + esc(title) + '</h2><p class="lg-p">' + esc(text) + '</p>' + figs + '</li>';
    }

    function build() {
        var html = '<div class="lg-wrap">'
            + '<p class="lg-kicker">' + esc(T.kicker) + '</p>'
            + '<h1>' + esc(T.title) + '</h1>'
            + '<p class="lg-lead">' + esc(T.lead) + '</p>'
            + (notSafari ? '<div class="lg-warn" role="note">' + esc(T.notSafari) + '<br><button type="button" class="lg-btn" data-lg="copy">' + esc(T.copy) + '</button></div>' : '')
            + '<ol>'
            + stepHtml(1, T.s1t, T.s1p, [{ svg: drawSafari() }])
            + stepHtml(2, T.s2t, T.s2p, [{ svg: drawShareClassic(), caption: T.s2a }, { svg: drawShareNew(), caption: T.s2b }])
            + stepHtml(3, T.s3t, T.s3p, [{ svg: drawSheet() }])
            + stepHtml(4, T.s4t, T.s4p, [{ svg: drawDialog() }])
            + stepHtml(5, T.s5t, T.s5p, [{ svg: drawHome() }])
            + '</ol>'
            + '<button type="button" class="lg-skip" data-lg="skip">' + esc(T.skip) + '</button>'
            + '<p class="lg-note">' + esc(T.skipNote) + '</p>'
            + '</div>';
        return html;
    }

    var overlay;
    var prevOverflow = '';

    function close(remember) {
        if (remember) {
            try { sessionStorage.setItem('lucid-guide-skip', '1'); } catch (e) { /* ignore */ }
        }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.documentElement.style.overflow = prevOverflow;
        overlay = null;
    }

    function copyAddress(btn) {
        var url = location.origin + '/';
        function done() {
            btn.textContent = T.copied;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, function () { /* clipboard refused: the address is in the bar */ });
            return;
        }
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        try { if (document.execCommand('copy')) done(); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
    }

    function show() {
        var style = document.createElement('style');
        style.textContent = CSS;
        overlay = document.createElement('div');
        overlay.id = 'lucid-guide';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', T.title);
        overlay.lang = pl ? 'pl' : 'en';
        overlay.innerHTML = build();
        overlay.insertBefore(style, overlay.firstChild);
        overlay.addEventListener('click', function (e) {
            var t = e.target;
            while (t && t !== overlay && !(t.getAttribute && t.getAttribute('data-lg'))) t = t.parentNode;
            if (!t || t === overlay) return;
            var action = t.getAttribute('data-lg');
            if (action === 'skip') close(true);
            else if (action === 'copy') copyAddress(t);
        });
        prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        document.body.appendChild(overlay);
    }

    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
})();

/*
 * Planning HaikoRadio.
 *  - Source : <site>/api/planning si le site le propose, sinon la copie fournie avec l'application (data/planning.json).
 *  - Les heures sont celles du fuseau du planning (Paris), quel que soit le fuseau de l'appareil.
 *  - Calcule "en ce moment / ensuite", met en évidence le créneau en cours, remplit la page Planning
 *    et le bloc "Au programme aujourd'hui" de l'accueil.
 */
(function () {
    var DAY_NAMES = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    var WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    var DEFAULT_COLOR = '#64748b';

    var P = null;              // planning prêt à l'emploi (voir build)
    var todayShown = 0;        // jour affiché dans "Au programme"

    // ---------- Données ----------

    function clean(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }
    function color(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_COLOR; }

    // "HH:MM" -> minutes ("24:00" = fin de journée = 1440)
    function minutes(v) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '');
        if (!m) { return null; }
        var total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        return (total <= 1440 && parseInt(m[2], 10) < 60) ? total : null;
    }

    function hm(total) {
        total = total % 1440;
        var h = Math.floor(total / 60), m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // Transforme le fichier du planning en 7 journées complètes (00:00 -> 24:00), trous comblés par la playlist générale.
    function build(raw) {
        if (!raw || typeof raw.shows !== 'object' || typeof raw.week !== 'object') { return null; }

        var tz = typeof raw.timezone === 'string' ? raw.timezone : 'Europe/Paris';
        try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); } catch (e) { tz = 'Europe/Paris'; }

        var def = {
            name: clean(raw.default && raw.default.name) || 'Musique en continu',
            description: clean(raw.default && raw.default.description),
            color: DEFAULT_COLOR
        };

        var shows = {}, showOrder = [];
        Object.keys(raw.shows).forEach(function (key) {
            var s = raw.shows[key];
            if (!s || !/^[a-z0-9_-]+$/i.test(key)) { return; }
            shows[key] = { name: clean(s.name) || key, description: clean(s.description), color: color(s.color) };
            showOrder.push(key);
        });

        var week = {};
        for (var day = 1; day <= 7; day++) {
            var slots = [];
            ((raw.week[String(day)]) || []).forEach(function (slot) {
                var s = minutes(slot && slot.start), e = minutes(slot && slot.end), k = String(slot && slot.show || '');
                if (s === null || e === null || e <= s || !shows[k]) { return; } // créneau invalide ou émission inconnue
                slots.push({ s: s, e: e, k: k });
            });
            slots.sort(function (a, b) { return a.s - b.s; });

            var segs = [], cursor = 0;
            slots.forEach(function (slot) {
                if (slot.s < cursor) { return; } // chevauchement : ignoré
                if (slot.s > cursor) { segs.push({ s: cursor, e: slot.s, k: '', n: def.name, c: def.color }); }
                segs.push({ s: slot.s, e: slot.e, k: slot.k, n: shows[slot.k].name, c: shows[slot.k].color });
                cursor = slot.e;
            });
            if (cursor < 1440) { segs.push({ s: cursor, e: 1440, k: '', n: def.name, c: def.color }); }
            week[day] = segs;
        }
        return { tz: tz, def: def, shows: shows, showOrder: showOrder, week: week };
    }

    function loadPlanning() {
        function bundled() {
            return fetch('data/planning.json').then(function (r) {
                if (!r.ok) { throw new Error('planning'); }
                return r.json();
            });
        }
        return Haiko.getJson(window.HAIKO.siteUrl + '/api/planning')
            .then(function (remote) { return (remote && remote.week && remote.shows) ? remote : bundled(); })
            .catch(bundled);
    }

    // ---------- Heure de Paris ----------

    function zoneNow() {
        try {
            var parts = new Intl.DateTimeFormat('en-GB', {
                timeZone: P.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
            }).formatToParts(new Date());
            var map = {};
            parts.forEach(function (p) { map[p.type] = p.value; });
            if (WEEKDAY[map.weekday]) {
                return { day: WEEKDAY[map.weekday], min: (parseInt(map.hour, 10) % 24) * 60 + parseInt(map.minute, 10) };
            }
        } catch (e) {}
        var d = new Date(); // secours : heure de l'appareil
        return { day: d.getDay() === 0 ? 7 : d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
    }

    function currentIndex(day, min) {
        var segs = P.week[day];
        for (var i = 0; i < segs.length; i++) {
            if (segs[i].s <= min && min < segs[i].e) { return i; }
        }
        return -1;
    }

    // Premier créneau d'une autre émission après celui en cours (peut être demain ou plus tard).
    function nextChange(day, idx) {
        var cur = P.week[day][idx];
        var d = day, i = idx, offset = 0;
        for (var guard = 0; guard < 7 * 30; guard++) {
            i++;
            if (i >= P.week[d].length) { i = 0; d = d % 7 + 1; offset++; }
            var seg = P.week[d][i];
            if (seg.k !== cur.k) { return { seg: seg, day: d, offset: offset }; }
        }
        return null;
    }

    function when(offset, day, total) {
        var prefix = offset === 0 ? '' : (offset === 1 ? 'demain ' : DAY_NAMES[day].toLowerCase() + ' ');
        return prefix + hm(total);
    }

    // ---------- Affichage ----------

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }

    function slotNode(seg, day, inGrid) {
        var node = el(inGrid ? 'div' : 'li', 'slot' + (seg.k === '' ? ' slot-default' : ''));
        node.dataset.day = String(day);
        node.dataset.start = String(seg.s);
        node.dataset.end = String(seg.e);
        node.style.setProperty('--c', seg.c);
        var range = hm(seg.s) + ' – ' + hm(seg.e);
        if (inGrid) {
            node.setAttribute('role', 'listitem');
            node.title = seg.n + ' · ' + range;
            node.style.top = (seg.s / 1440 * 100) + '%';
            node.style.height = ((seg.e - seg.s) / 1440 * 100) + '%';
            node.appendChild(el('span', 'slot-name', seg.n));
            node.appendChild(el('span', 'slot-time', range));
        } else {
            node.appendChild(el('span', 'slot-time', range));
            node.appendChild(el('span', 'slot-name', seg.n));
            node.appendChild(el('span', 'slot-now', 'En direct'));
        }
        return node;
    }

    function dayList(day) {
        var ol = el('ol', 'day-list');
        ol.dataset.day = String(day);
        P.week[day].forEach(function (seg) { ol.appendChild(slotNode(seg, day, false)); });
        return ol;
    }

    function renderWeekGrid() {
        var host = document.getElementById('week-grid');
        host.textContent = '';
        var week = el('div', 'week');
        week.setAttribute('aria-label', 'Planning de la semaine');

        var head = el('div', 'week-head');
        head.appendChild(el('span'));
        for (var d = 1; d <= 7; d++) {
            var title = el('span', 'week-day-title', DAY_NAMES[d].slice(0, 3) + '.');
            title.dataset.day = String(d);
            head.appendChild(title);
        }
        week.appendChild(head);

        var body = el('div', 'week-body');
        var axis = el('div', 'week-axis');
        axis.setAttribute('aria-hidden', 'true');
        for (var h = 0; h < 24; h += 2) {
            var label = el('span', '', (h < 10 ? '0' : '') + h + ':00');
            label.style.top = (h / 24 * 100) + '%';
            axis.appendChild(label);
        }
        body.appendChild(axis);

        for (var day = 1; day <= 7; day++) {
            var col = el('div', 'week-col');
            col.dataset.day = String(day);
            col.setAttribute('role', 'list');
            col.setAttribute('aria-label', DAY_NAMES[day]);
            P.week[day].forEach(function (seg) { col.appendChild(slotNode(seg, day, true)); });
            body.appendChild(col);
        }
        week.appendChild(body);
        host.appendChild(week);
    }

    function renderWeekList() {
        var host = document.getElementById('week-list');
        host.textContent = '';
        for (var day = 1; day <= 7; day++) {
            var card = el('section', 'day-card');
            card.dataset.day = String(day);
            var h2 = el('h2', '', DAY_NAMES[day] + ' ');
            h2.appendChild(el('span', 'day-today', 'Aujourd\'hui'));
            card.appendChild(h2);
            card.appendChild(dayList(day));
            host.appendChild(card);
        }
    }

    function renderLegend() {
        var ul = document.getElementById('legend');
        ul.textContent = '';
        function item(info) {
            var li = el('li');
            li.style.setProperty('--c', info.color);
            li.appendChild(el('span', 'legend-dot'));
            var text = el('span');
            text.appendChild(el('strong', '', info.name));
            if (info.description) { text.appendChild(document.createTextNode(' — ' + info.description)); }
            li.appendChild(text);
            ul.appendChild(li);
        }
        P.showOrder.forEach(function (key) { item(P.shows[key]); });
        item(P.def);
    }

    function setNowboxes(cur, next) {
        var until = next ? 'Jusqu\'à ' + when(next.offset, next.day, next.seg.s) + ' · ensuite : ' + next.seg.n : '';
        document.querySelectorAll('[data-nowbox]').forEach(function (box) {
            box.querySelector('[data-nowbox-show]').textContent = cur.n;
            box.querySelector('[data-nowbox-until]').textContent = until;
            box.hidden = false;
        });
    }

    function update() {
        if (!P) { return; }
        var now = zoneNow();
        var idx = currentIndex(now.day, now.min);
        if (idx < 0) { return; }
        var cur = P.week[now.day][idx];

        setNowboxes(cur, nextChange(now.day, idx));

        // Rappel de l'émission sur la carte du morceau en cours
        var npShow = document.getElementById('np-show');
        if (npShow) { npShow.textContent = cur.k !== '' ? ' · ' + cur.n : ''; }

        // Créneau en cours + jour d'aujourd'hui
        document.querySelectorAll('.slot').forEach(function (node) {
            var on = parseInt(node.dataset.day, 10) === now.day &&
                parseInt(node.dataset.start, 10) <= now.min && now.min < parseInt(node.dataset.end, 10);
            node.classList.toggle('is-now', on);
        });
        document.querySelectorAll('.week-day-title, .week-col, .day-card').forEach(function (node) {
            node.classList.toggle('is-today', parseInt(node.dataset.day, 10) === now.day);
        });

        // Accueil : la journée d'aujourd'hui (reconstruite quand on change de jour)
        if (todayShown !== now.day) {
            var host = document.getElementById('today-list');
            host.textContent = '';
            host.appendChild(dayList(now.day));
            document.getElementById('today-title').textContent = '· ' + DAY_NAMES[now.day].toLowerCase();
            todayShown = now.day;
            update(); // pour mettre en évidence le créneau dans la liste qu'on vient de créer
            return;
        }
        document.getElementById('today-panel').hidden = false;
    }

    function init() {
        loadPlanning().then(function (raw) {
            P = build(raw);
            if (!P) { throw new Error('planning invalide'); }
            renderWeekGrid();
            renderWeekList();
            renderLegend();
            update();
            setInterval(update, 30000);
            document.addEventListener('visibilitychange', function () { if (!document.hidden) { update(); } });
        }).catch(function () {
            document.getElementById('planning-error').hidden = false;
        });
    }

    window.Haiko = window.Haiko || {};
    window.Haiko.planning = { init: init };
})();

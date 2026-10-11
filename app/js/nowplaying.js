/*
 * Morceau en cours + historique, lus sur le site de la radio (/api/now-playing) toutes les 15 s.
 * Le site s'occupe de nettoyer les titres et de trouver les pochettes ; ici on ne fait que les afficher.
 */
(function () {
    var current = null;
    var lastSignature = '';
    var listeners = [];

    var elTitle = document.getElementById('np-title');
    var elArtist = document.getElementById('np-artist');
    var elWork = document.getElementById('np-work');
    var elAlbum = document.getElementById('np-album');
    var elMeta = document.getElementById('np-meta');
    var elCover = document.getElementById('np-cover');
    var elCoverImg = document.getElementById('np-cover-img');
    var elHistory = document.getElementById('history');
    var elHistoryPanel = document.getElementById('history-panel');
    var elOffline = document.getElementById('offline-note');

    function fmtTime(ts) {
        if (!ts) { return ''; }
        try { return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return ''; }
    }

    function fmtDuration(s) {
        if (!s) { return ''; }
        var sec = s % 60;
        return Math.floor(s / 60) + ':' + (sec < 10 ? '0' : '') + sec;
    }

    // "Album · 2025 · Hip-hop/Rap" (uniquement ce qui est connu)
    function albumLine(t) {
        var parts = [];
        if (t.album) { parts.push(t.album); }
        if (t.year) { parts.push(String(t.year)); }
        if (t.genre) { parts.push(t.genre); }
        return parts.join(' · ');
    }

    function setCover(url) {
        url = Haiko.siteAsset(url);
        if (url) {
            elCoverImg.onerror = function () { elCoverImg.hidden = true; elCover.classList.remove('has-image'); };
            if (elCoverImg.getAttribute('src') !== url) { elCoverImg.src = url; }
            elCoverImg.hidden = false;
            elCover.classList.add('has-image');
        } else {
            elCoverImg.hidden = true;
            elCoverImg.removeAttribute('src');
            elCover.classList.remove('has-image');
        }
    }

    function historyThumb(t) {
        var box = document.createElement('span');
        box.className = 'history-cover';
        var url = Haiko.siteAsset(t.cover);
        if (url) {
            var img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.src = url;
            img.onerror = function () { box.removeChild(img); box.textContent = '♪'; };
            box.appendChild(img);
        } else {
            box.textContent = '♪';
        }
        return box;
    }

    function render(data) {
        if (!data || !data.now) { return; }
        // Rien de nouveau (seule l'heure de mise à jour change) : on ne retouche pas l'affichage.
        var signature = JSON.stringify([data.now, data.history]);
        if (signature === lastSignature) { return; }
        lastSignature = signature;
        current = data;

        var now = data.now;
        var hasTrack = now.title !== '' || now.artist !== '';
        elTitle.textContent = hasTrack ? (now.title || now.artist) : 'HaikoRadio en direct';
        elArtist.textContent = (hasTrack && now.title) ? now.artist : '';
        elWork.textContent = now.work || '';
        elAlbum.textContent = albumLine(now);
        elMeta.textContent = now.started ? 'Depuis ' + fmtTime(now.started) : '';
        setCover(now.cover);

        while (elHistory.firstChild) { elHistory.removeChild(elHistory.firstChild); }
        (data.history || []).forEach(function (t) {
            var li = document.createElement('li');

            var time = document.createElement('span');
            time.className = 'history-time';
            time.textContent = fmtTime(t.started);

            var text = document.createElement('span');
            text.className = 'history-text';
            var title = document.createElement('strong');
            title.textContent = t.title || t.artist;
            text.appendChild(title);
            var sub = [];
            if (t.title && t.artist) { sub.push(t.artist); }
            if (t.work) { sub.push(t.work); }
            if (sub.length) {
                var small = document.createElement('small');
                small.textContent = sub.join(' · ');
                text.appendChild(small);
            }

            var dur = document.createElement('span');
            dur.className = 'history-duration';
            dur.textContent = fmtDuration(t.duration);

            li.appendChild(time);
            li.appendChild(historyThumb(t));
            li.appendChild(text);
            li.appendChild(dur);
            elHistory.appendChild(li);
        });
        elHistoryPanel.hidden = !(data.history && data.history.length);

        listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
    }

    function refresh() {
        if (document.hidden && !window.haikoNative) { return; } // une appli de bureau continue à se mettre à jour en arrière-plan
        Haiko.getJson(window.HAIKO.siteUrl + '/api/now-playing')
            .then(function (data) { elOffline.hidden = true; render(data); })
            .catch(function () { elOffline.hidden = false; }); // on garde les derniers titres affichés
    }

    window.Haiko = window.Haiko || {};
    window.Haiko.nowplaying = {
        get current() { return current; },
        onChange: function (fn) { listeners.push(fn); },
        start: function () {
            refresh();
            setInterval(refresh, window.HAIKO.pollMs);
            document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); } });
        }
    };
})();

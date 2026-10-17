/*
 * Lecteur HaikoRadio.
 *  - Qualité standard : flux direct AAC 128 kbit/s. S'il est indisponible, le lecteur
 *    passe tout seul sur le flux HLS à son meilleur débit (128 kbit/s) : même qualité.
 *  - Mode économique  : flux HLS plafonné à 64 kbit/s.
 */
(function () {
    var player = document.getElementById('player');
    var audio = document.getElementById('audio');
    var playBtn = document.getElementById('play-btn');
    var statusEl = document.getElementById('player-status');
    var volume = document.getElementById('volume');
    var qualityBtns = player.querySelectorAll('.quality-btn');

    var URLS = window.HAIKO.streams;
    var HLS_LIB = 'vendor/hls.min.js';
    var ECO_MAX_BANDWIDTH = window.HAIKO.ecoMaxBandwidth;

    var mode = 'aac';          // choix de l'utilisateur : 'aac' (standard) ou 'hls' (économique)
    var wantPlaying = false;   // l'utilisateur a demandé la lecture
    var usingHls = false;      // le flux HLS est utilisé (choix économique, ou secours du standard)
    var startId = 0;           // invalide les démarrages devenus obsolètes (clics rapides)
    var statusWhenPlaying = '';
    var hls = null;
    var hlsRetries = 0;
    var ignorePause = false;
    var listeners = [];

    // Application Android : le son est joué par un service natif (il continue écran éteint). Dans ce cas
    // ce fichier ne lit rien lui-même : il envoie les commandes au pont HaikoNative et affiche l'état reçu.
    // (Le bloc « Application Android » plus bas contient tout ce qui s'y rapporte.)
    var NATIVE = (function () {
        try { return !!(window.HaikoNative && window.HaikoNative.isNative && window.HaikoNative.isNative()); }
        catch (e) { return false; }
    })();
    var PAUSE_TEXT = 'En pause — appuie sur lecture pour revenir en direct.';

    function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
    function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

    function setStatus(text) { statusEl.textContent = text; }

    function notify() {
        listeners.forEach(function (fn) { try { fn(wantPlaying); } catch (e) {} });
    }

    function setState(state) {
        player.classList.toggle('is-playing', state === 'playing');
        player.classList.toggle('is-loading', state === 'loading');
        playBtn.setAttribute('aria-label', wantPlaying ? 'Mettre en pause' : 'Écouter la radio');
        if (state === 'playing') { startEqualizer(); }
    }

    // --- Égaliseur : les 7 barres suivent le son réellement joué (analyse via Web Audio) ---
    // Même principe que sur le site : on sépare le son en 7 bandes de fréquences (graves → aigus) et chaque barre
    // monte avec l'énergie de sa bande. Sans analyse possible (Android, mouvement réduit demandé au système…), les barres
    // gardent leur animation décorative habituelle.

    var eqEl = player.querySelector('.equalizer');
    var eqBars = player.querySelectorAll('.equalizer span');
    // Bandes de fréquences, des graves aux aigus (Hz)
    var EQ_BANDS = [[60, 150], [150, 300], [300, 600], [600, 1200], [1200, 2400], [2400, 4800], [4800, 9600]];
    var audioCtx = null, analyser = null, gainNode = null, freqData = null;
    var graphTried = false;
    var eqFrame = 0, eqDead = false, eqHadSignal = false, eqSilentSince = 0, eqLastTime = 0;
    var eqLevels = [0, 0, 0, 0, 0, 0, 0];
    // Plage récente de chaque barre (plus haut / plus bas niveau des dernières secondes) : chaque barre
    // s'adapte au morceau et aux instruments de sa bande, plutôt que d'être écrasée au maximum.
    var eqPeaks = null, eqFloors = null;

    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Sur Android, le son est joué par le téléphone (pas par cette page) : rien à analyser.
    var eqSupported = !NATIVE && !reduceMotion && !!(window.AudioContext || window.webkitAudioContext);

    // Le volume passe par un « gain » placé APRÈS l'analyse : baisser le son ne réduit donc pas la hauteur des barres.
    function applyVolume() {
        var v = volume.value / 100;
        if (gainNode) { gainNode.gain.value = v; audio.volume = 1; }
        else { audio.volume = v; }
    }

    // À appeler pendant une commande de lecture (le navigateur n'autorise le son Web Audio qu'après une action de l'utilisateur).
    function ensureAudioGraph() {
        if (!eqSupported) { return; }
        if (!graphTried) {
            graphTried = true;
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AC();
                var source = audioCtx.createMediaElementSource(audio);
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = 0.5;
                gainNode = audioCtx.createGain();
                source.connect(analyser);
                analyser.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                freqData = new Uint8Array(analyser.frequencyBinCount);
                applyVolume();
            } catch (e) {
                analyser = null; // pas d'analyse possible : animation décorative
            }
        }
        if (audioCtx && audioCtx.state !== 'running') {
            var p = audioCtx.resume();
            if (p && p.catch) { p.catch(function () {}); }
        }
    }

    function stopEqualizer() {
        if (eqFrame) { cancelAnimationFrame(eqFrame); eqFrame = 0; }
        if (eqEl) { eqEl.classList.remove('is-reactive'); }
        eqBars.forEach(function (b) { b.style.removeProperty('--lvl'); });
        eqLevels = [0, 0, 0, 0, 0, 0, 0];
        eqPeaks = null;
        eqFloors = null;
        eqLastTime = 0;
    }

    function eqTick(now) {
        if (!player.classList.contains('is-playing')) { eqFrame = 0; stopEqualizer(); return; }
        eqFrame = requestAnimationFrame(eqTick);

        analyser.getByteFrequencyData(freqData);
        var binHz = audioCtx.sampleRate / analyser.fftSize;
        var raw = [], total = 0;
        for (var b = 0; b < EQ_BANDS.length; b++) {
            var i0 = Math.max(1, Math.floor(EQ_BANDS[b][0] / binHz));
            var i1 = Math.max(i0 + 1, Math.ceil(EQ_BANDS[b][1] / binHz));
            var sum = 0;
            for (var i = i0; i < i1 && i < freqData.length; i++) { sum += freqData[i]; }
            total += sum;
            raw[b] = sum / ((i1 - i0) * 255);
        }

        if (total > 0) {
            eqHadSignal = true;
            eqSilentSince = 0;
        } else if (!eqHadSignal) {
            // Aucune donnée depuis le début de la lecture : l'analyse est bloquée → animation décorative.
            if (!eqSilentSince) { eqSilentSince = now; }
            if (now - eqSilentSince > 4000) { eqDead = true; eqFrame = 0; stopEqualizer(); return; }
            return;
        }

        // Chaque barre se situe entre le plus bas et le plus haut niveau récents de sa bande.
        // Ces repères se resserrent (≈ 0,3 par seconde) pour suivre le morceau et oublier vite un pic de début de flux.
        var dt = eqLastTime ? Math.min(100, now - eqLastTime) : 16;
        eqLastTime = now;
        var drift = 0.0003 * dt;
        if (!eqPeaks) { eqPeaks = raw.slice(); eqFloors = raw.slice(); }
        eqEl.classList.add('is-reactive');
        for (var k = 0; k < eqBars.length; k++) {
            eqPeaks[k] = Math.max(raw[k], eqPeaks[k] - drift);
            eqFloors[k] = Math.min(raw[k], eqFloors[k] + drift);
            var range = Math.max(eqPeaks[k] - eqFloors[k], 0.1); // évite d'amplifier le simple bruit
            var target = Math.pow(Math.max(0, Math.min(1, (raw[k] - eqFloors[k]) / range)), 1.3);
            var cur = eqLevels[k];
            cur += (target - cur) * (target > cur ? 0.6 : 0.18); // montée rapide, descente douce
            eqLevels[k] = cur;
            eqBars[k].style.setProperty('--lvl', cur.toFixed(3));
        }
    }

    function startEqualizer() {
        if (!analyser || eqDead || eqFrame) { return; }
        eqFrame = requestAnimationFrame(eqTick);
    }

    function showMode(next) {
        qualityBtns.forEach(function (b) {
            b.setAttribute('aria-pressed', b.dataset.mode === next ? 'true' : 'false');
        });
    }

    function destroyHls() {
        if (hls) { hls.destroy(); hls = null; }
    }

    function loadHlsLib(callback) {
        if (window.Hls) { callback(); return; }
        var s = document.createElement('script');
        s.src = HLS_LIB;
        s.onload = callback;
        s.onerror = function () { fail('Le flux de secours est indisponible.'); };
        document.head.appendChild(s);
    }

    function fail(message) {
        wantPlaying = false;
        stopMedia();
        setState('idle');
        setStatus(message);
        notify();
    }

    function stopMedia() {
        destroyHls();
        if (!audio.paused) { ignorePause = true; } // la pause qu'on provoque nous-mêmes n'est pas une pause "extérieure"
        audio.pause();
        audio.removeAttribute('src');
        audio.load(); // coupe vraiment le téléchargement du flux
    }

    // Le flux ne démarre pas : si c'était le flux direct, on bascule sur le HLS, sinon on abandonne.
    function onStreamFailure() {
        if (!usingHls) {
            setStatus('Flux direct indisponible, bascule sur le flux de secours…');
            start(true);
        } else {
            fail('La radio est momentanément injoignable. Réessaie dans un instant.');
        }
    }

    function playAudio() {
        var id = startId;
        var p = audio.play();
        if (p && p.catch) {
            p.catch(function (err) {
                // Interrompue par un changement de flux, ou démarrage déjà remplacé par un autre.
                if ((err && err.name === 'AbortError') || id !== startId || !wantPlaying) { return; }
                if (err && err.name === 'NotAllowedError') {
                    fail('Lecture bloquée. Appuie à nouveau sur lecture.');
                } else {
                    onStreamFailure(); // flux introuvable / illisible (NotSupportedError…)
                }
            });
        }
    }

    /*
     * Choisit dans le manifeste HLS la variante voulue (le manifeste liste 32, 64 et 128 kbit/s) :
     * la meilleure sous le plafond maxBandwidth, ou la meilleure tout court si maxBandwidth est null.
     * Si la lecture du manifeste échoue, on donne le manifeste complet au lecteur (qualité automatique).
     */
    function resolveHlsUrl(maxBandwidth, callback) {
        fetch(URLS.hls, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) { throw new Error('manifest'); } return r.text(); })
            .then(function (text) {
                var lines = text.split(/\r?\n/), variants = [];
                for (var i = 0; i < lines.length - 1; i++) {
                    var m = /^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/.exec(lines[i]);
                    if (m && lines[i + 1] && lines[i + 1].charAt(0) !== '#') {
                        variants.push({ bw: parseInt(m[1], 10), uri: lines[i + 1].trim() });
                    }
                }
                if (!variants.length) { throw new Error('empty'); }
                variants.sort(function (a, b) { return a.bw - b.bw; });
                var pick = variants[variants.length - 1];
                if (maxBandwidth !== null) {
                    var allowed = variants.filter(function (v) { return v.bw <= maxBandwidth; });
                    pick = allowed.length ? allowed[allowed.length - 1] : variants[0];
                }
                callback(new URL(pick.uri, URLS.hls).href);
            })
            .catch(function () { callback(URLS.hls); });
    }

    function playHls(url, id) {
        if (audio.canPlayType('application/vnd.apple.mpegurl')) {
            // Les navigateurs qui lisent le HLS nativement (Safari, iOS, certains Chromium récents).
            audio.src = url;
            playAudio();
            return;
        }
        loadHlsLib(function () {
            if (id !== startId || !wantPlaying) { return; }
            if (!window.Hls || !window.Hls.isSupported()) {
                fail('Impossible de lire le flux de secours.');
                return;
            }
            hls = new window.Hls({ lowLatencyMode: false });
            hls.on(window.Hls.Events.ERROR, onHlsError);
            hls.loadSource(url);
            hls.attachMedia(audio);
            playAudio();
        });
    }

    // useHls : on force le HLS (c'est le secours du mode standard).
    function start(useHls) {
        if (NATIVE) { nativeStart(); return; }
        ensureAudioGraph();
        stopEqualizer(); // repart d'un état propre (annule une animation restée en attente)
        eqHadSignal = false;
        wantPlaying = true;
        hlsRetries = 0;
        var id = ++startId;
        setState('loading');
        setStatus('Connexion…');
        stopMedia();

        usingHls = mode === 'hls' || !!useHls;
        if (!usingHls) {
            statusWhenPlaying = 'En direct · qualité standard';
            audio.src = URLS.aac;
            playAudio();
        } else {
            statusWhenPlaying = mode === 'hls'
                ? 'En direct · mode économique'
                : 'En direct · qualité standard (flux de secours)';
            resolveHlsUrl(mode === 'hls' ? ECO_MAX_BANDWIDTH : null, function (url) {
                if (id !== startId || !wantPlaying) { return; }
                playHls(url, id);
            });
        }
        updateMediaSession();
        notify();
    }

    function stop() {
        if (NATIVE) { nativeStop(); return; }
        wantPlaying = false;
        startId++;
        stopMedia();
        setState('idle');
        setStatus(PAUSE_TEXT);
        notify();
    }

    function onHlsError(event, data) {
        if (!data || !data.fatal) { return; }
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && hlsRetries < 3) {
            hlsRetries++;
            setStatus('Reconnexion…');
            hls.startLoad();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && hlsRetries < 3) {
            hlsRetries++;
            hls.recoverMediaError();
        } else {
            fail('La radio est momentanément injoignable. Réessaie dans un instant.');
        }
    }

    function setMode(next) {
        mode = next;
        showMode(next);
        store('radio-mode', next);
        if (NATIVE) { nativeCall('setMode', next); return; } // le service natif relance tout seul si ça joue
        if (wantPlaying) { start(); }
    }

    // --- Événements du lecteur audio ---

    audio.addEventListener('playing', function () {
        setState('playing');
        setStatus(statusWhenPlaying);
    });

    audio.addEventListener('waiting', function () {
        if (wantPlaying) { setState('loading'); setStatus('Mise en mémoire…'); }
    });

    audio.addEventListener('error', function () {
        if (!wantPlaying || (usingHls && hls)) { return; } // hls.js gère ses propres erreurs
        // Erreur en retard d'un flux déjà remplacé (plus de source) : on l'ignore.
        if (!audio.getAttribute('src')) { return; }
        onStreamFailure();
    });

    // Pause venue de l'extérieur (touche multimédia, autre application).
    audio.addEventListener('pause', function () {
        if (ignorePause) { ignorePause = false; return; }
        if (wantPlaying && !audio.ended) {
            // Un flux en direct n'a pas de "reprise" : on coupe, et un nouvel appui relance au direct.
            stop();
        }
    });

    // --- Commandes ---

    function toggle() {
        if (wantPlaying) { stop(); } else { start(); }
    }

    playBtn.addEventListener('click', toggle);

    qualityBtns.forEach(function (b) {
        b.addEventListener('click', function () {
            if (b.dataset.mode !== mode) { setMode(b.dataset.mode); }
        });
    });

    // Volume de la page (Windows). Sur Android, le curseur pilote le volume du téléphone : voir « Application Android ».
    if (!NATIVE) {
        var savedVolume = parseInt(load('radio-volume') || '', 10);
        if (!isNaN(savedVolume) && savedVolume >= 0 && savedVolume <= 100) { volume.value = String(savedVolume); }
        applyVolume();
    }
    volume.addEventListener('input', function () {
        if (NATIVE) { nativeVolumeInput(); return; }
        applyVolume();
        store('radio-volume', volume.value);
    });

    // --- Touches multimédia / commandes système (verrouillage, casque…) ---

    function updateMediaSession() {
        if (NATIVE || !('mediaSession' in navigator)) { return; } // sur Android, la session média est celle du service natif
        try {
            var now = Haiko.nowplaying && Haiko.nowplaying.current && Haiko.nowplaying.current.now;
            var meta = {
                title: (now && (now.title || now.artist)) || 'HaikoRadio',
                artist: (now && now.title && now.artist) || 'En direct',
                album: (now && (now.work || now.album)) || 'HaikoRadio'
            };
            var cover = now && Haiko.siteAsset(now.cover);
            if (cover) { meta.artwork = [{ src: cover, sizes: '600x600' }]; }
            navigator.mediaSession.metadata = new MediaMetadata(meta);
            navigator.mediaSession.setActionHandler('play', function () { if (!wantPlaying) { start(); } });
            navigator.mediaSession.setActionHandler('pause', stop);
            navigator.mediaSession.setActionHandler('stop', stop);
        } catch (e) {}
    }

    // Le titre change pendant l'écoute : on met à jour les commandes système.
    Haiko.nowplaying.onChange(function () { if (wantPlaying) { updateMediaSession(); } });

    // ===== Application Android (début) =====
    // Contrat : window.HaikoNative (pont injecté par l'application) et l'événement « haiko-native-state ».
    // Voir docs/android.md. L'état affiché suit TOUJOURS l'état natif : une pause peut venir de la
    // notification ou du casque, pas seulement du bouton de la page.

    function nativeCall(name, arg) {
        try {
            // Android refuse un appel dont le nombre d'arguments ne correspond pas : stop() ne doit pas recevoir stop(undefined).
            if (arg === undefined) { window.HaikoNative[name](); } else { window.HaikoNative[name](arg); }
        } catch (e) {
            wantPlaying = false;
            setState('idle');
            setStatus('Lecture indisponible. Réessaie.');
            notify();
        }
    }

    function nativeStart() {
        wantPlaying = true;
        setState('loading');
        setStatus('Connexion…');
        notify();
        nativeCall('play', mode);
    }

    function nativeStop() {
        wantPlaying = false;
        setState('idle');
        setStatus(PAUSE_TEXT);
        notify();
        nativeCall('stop');
    }

    // d = { status, mode, source, fallback, message, playing, active }
    function applyNativeState(d) {
        if (!d || typeof d !== 'object') { return; }
        if ((d.mode === 'aac' || d.mode === 'hls') && d.mode !== mode) {
            mode = d.mode;
            showMode(mode);
            store('radio-mode', mode);
        }
        wantPlaying = !!d.active;
        switch (d.status) {
            case 'connecting':
                setState('loading');
                setStatus('Connexion…');
                break;
            case 'buffering':
                setState('loading');
                setStatus('Mise en mémoire…');
                break;
            case 'playing':
                setState('playing');
                setStatus(d.mode === 'hls'
                    ? 'En direct · mode économique'
                    : 'En direct · qualité standard' + (d.fallback ? ' (flux de secours)' : ''));
                break;
            case 'error':
                setState('idle');
                setStatus(d.message || 'La radio est momentanément injoignable. Réessaie dans un instant.');
                break;
            default: // 'paused', 'idle'
                setState('idle');
                setStatus(PAUSE_TEXT);
        }
        notify();
    }

    // Volume du téléphone. Le curseur envoie un entier 0..100 ; le téléphone renvoie la valeur réellement
    // appliquée (arrondie à ses crans), qu'on affiche sans la renvoyer (sinon boucle).
    var volumeAvailable = false;
    var volumeDragging = false;
    var volumePending = null;
    var volumeTimer = 0;

    function nativeVolumeInput() {
        if (!volumeAvailable) { return; }
        volumePending = Math.round(Number(volume.value));
        if (volumeTimer) { return; }
        // Au plus une commande toutes les 40 ms (la dernière valeur) : glisser le doigt ne doit pas inonder le pont.
        volumeTimer = setTimeout(function () {
            volumeTimer = 0;
            if (volumePending !== null && !isNaN(volumePending)) { nativeCall('setVolume', volumePending); }
            volumePending = null;
        }, 40);
    }

    function setVolumeFromNative(value) {
        var v = Math.round(Number(value));
        if (isNaN(v) || v < 0 || v > 100) { return; }
        if (volumeDragging) { return; } // on ne dispute pas le curseur au doigt de l'utilisateur
        volume.value = String(v);
    }

    function initNativeVolume() {
        var bridge = window.HaikoNative;
        var box = volume.closest('.volume');
        try { volumeAvailable = !!(bridge.hasVolumeControl && bridge.hasVolumeControl()); } catch (e) {}

        // Pas de réglage possible depuis la page : on masque le curseur (le volume se règle avec les touches du téléphone).
        if (!volumeAvailable) {
            if (box) { box.style.display = 'none'; }
            return;
        }

        function endDrag() {
            if (!volumeDragging) { return; }
            volumeDragging = false;
            // Au relâchement, on affiche la valeur réellement appliquée (le téléphone l'arrondit à ses crans).
            setTimeout(function () { try { setVolumeFromNative(bridge.getVolume()); } catch (e) {} }, 200);
        }
        volume.addEventListener('pointerdown', function () { volumeDragging = true; });
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        window.addEventListener('haiko-native-volume', function (event) {
            setVolumeFromNative(event.detail && event.detail.volume);
        });
        try { setVolumeFromNative(bridge.getVolume()); } catch (e) {} // l'événement a pu partir avant le chargement du script
    }

    function initNative() {
        initNativeVolume();

        window.addEventListener('haiko-native-state', function (event) { applyNativeState(event.detail); });

        // L'événement peut être parti avant que ce fichier soit chargé : on lit l'état courant.
        try { applyNativeState(JSON.parse(window.HaikoNative.getState())); } catch (e) {}
    }
    // ===== Application Android (fin) =====

    // --- Prêt ---

    if (load('radio-mode') === 'hls') {
        mode = 'hls';
        showMode('hls');
    }
    playBtn.disabled = false;
    setState('idle');
    setStatus('Appuie sur lecture pour écouter en direct.');
    if (NATIVE) { initNative(); }

    window.Haiko.player = {
        toggle: toggle,
        start: function () { if (!wantPlaying) { start(); } },
        stop: function () { if (wantPlaying) { stop(); } },
        isPlaying: function () { return wantPlaying; },
        onChange: function (fn) { listeners.push(fn); }
    };
})();

/*
 * Égaliseur de l'application Android : les 7 barres suivent le son réellement joué, comme sur le site.
 * Ce script est injecté par l'application (MainActivity) après le chargement de la page ; il n'existe nulle part ailleurs.
 *
 * L'analyse du son est faite par le lecteur Android (AudioLevels.kt), qui envoie à la page l'événement
 * « haiko-native-levels » (detail.bars : 7 niveaux de 0 à 1, des graves aux aigus, environ 30 fois par seconde).
 * Ici on garde la même mise en forme que le site (radio.js) : chaque barre se situe entre le plus bas et le plus haut
 * niveau récents de sa bande, montée rapide, descente douce. Point d'entrée de l'interface partagée, identique à celui du
 * site : la classe « is-reactive » sur .equalizer et la variable --lvl (0 à 1) sur chacun des 7 <span> ; la hauteur des
 * barres est calculée par la feuille de style (app.css).
 */
(function () {
    if (window.__haikoEqInstalled) { return; }
    window.__haikoEqInstalled = true;

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { return; } // l'utilisateur a demandé moins d'animations : on garde l'animation douce d'origine

    var eq = null, bars = null;
    var levels = [0, 0, 0, 0, 0, 0, 0];
    var peaks = null, floors = null;
    var lastTime = 0, lastEvent = 0, hadSignal = false, active = false, lastLog = 0;

    function find() {
        if (!eq || !eq.isConnected) {
            eq = document.querySelector('.player .equalizer') || document.querySelector('.equalizer');
            bars = eq ? eq.querySelectorAll('span') : null;
        }
        return !!(eq && bars && bars.length);
    }

    function isPlaying() {
        var p = document.getElementById('player');
        return !!(p && p.classList.contains('is-playing'));
    }

    // Rend la main à l'animation d'origine (lecture arrêtée, en pause, ou plus de données).
    function reset() {
        active = false;
        hadSignal = false;
        peaks = floors = null;
        lastTime = 0;
        levels = [0, 0, 0, 0, 0, 0, 0];
        if (!eq) { return; }
        eq.classList.remove('is-reactive');
        for (var i = 0; i < bars.length; i++) { bars[i].style.removeProperty('--lvl'); }
    }

    window.addEventListener('haiko-native-levels', function (e) {
        var raw = e && e.detail && e.detail.bars;
        if (!raw || raw.length < 7 || !find() || !isPlaying()) {
            if (active) { reset(); }
            return;
        }

        var total = 0;
        for (var i = 0; i < 7; i++) { total += raw[i]; }
        if (total <= 0 && !hadSignal) { return; } // aucun son encore : on laisse l'animation d'origine
        hadSignal = true;

        var now = performance.now();
        lastEvent = now;
        var dt = lastTime ? Math.min(100, now - lastTime) : 16;
        lastTime = now;
        var drift = 0.0003 * dt;
        if (!peaks) { peaks = raw.slice(0, 7); floors = raw.slice(0, 7); }

        eq.classList.add('is-reactive');
        for (var k = 0; k < 7; k++) {
            peaks[k] = Math.max(raw[k], peaks[k] - drift);
            floors[k] = Math.min(raw[k], floors[k] + drift);
            var range = Math.max(peaks[k] - floors[k], 0.1); // évite d'amplifier le simple bruit
            var target = Math.pow(Math.max(0, Math.min(1, (raw[k] - floors[k]) / range)), 1.3);
            var cur = levels[k];
            cur += (target - cur) * (target > cur ? 0.6 : 0.18); // montée rapide, descente douce
            levels[k] = cur;

            bars[k].style.setProperty('--lvl', cur.toFixed(3));
        }
        active = true;

        if (window.__haikoEqDebug && now - lastLog > 1000) { // versions de test uniquement
            lastLog = now;
            console.log('EQ barres=' + levels.map(function (v) { return v.toFixed(2); }).join(' ') +
                ' brut=' + raw.map(function (v) { return v.toFixed(2); }).join(' '));
        }
    });

    // Plus de nouvelles du lecteur (pause, arrêt) : on rend la main à l'animation d'origine.
    setInterval(function () {
        if (active && (performance.now() - lastEvent > 600 || !isPlaying())) { reset(); }
    }, 300);
})();

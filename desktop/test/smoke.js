'use strict';

/*
 * Test de fumée : lance l'application, vérifie que tout s'affiche et que la radio joue, puis quitte.
 * Utilisation :   cd desktop && HAIKO_SMOKE_DIR=captures npx electron .
 * (code de sortie 0 = tout est bon, 1 = au moins un contrôle a échoué)
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = process.env.HAIKO_SMOKE_DIR ? path.resolve(process.env.HAIKO_SMOKE_DIR) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

app.whenReady().then(async () => {
    let win = null;
    for (let i = 0; i < 50 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
    if (!win) { console.log('ECHEC: aucune fenêtre'); app.exit(1); return; }

    win.webContents.on('console-message', (e) => {
        const level = e.level || e.severity;
        if (level === 'error' || level === 3) { problems.push('console: ' + e.message); }
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => problems.push(`chargement raté ${url}: ${desc}`));

    await new Promise((resolve) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve()));
    await sleep(3500); // le temps de lire le site (morceau en cours, planning)

    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        if (!outDir) { return; }
        fs.mkdirSync(outDir, { recursive: true });
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    };
    const check = (label, ok, detail) => {
        console.log((ok ? 'OK    ' : 'ECHEC ') + label + (detail !== undefined ? '  → ' + detail : ''));
        if (!ok) { problems.push(label); }
    };

    // 1) Interface chargée
    const ui = await js(`(() => ({
        native: !!window.haikoNative,
        title: document.title,
        np: document.getElementById('np-title').textContent,
        artist: document.getElementById('np-artist').textContent,
        history: document.querySelectorAll('#history li').length,
        offline: !document.getElementById('offline-note').hidden,
        cols: document.querySelectorAll('.week-col').length,
        slots: document.querySelectorAll('.week-col .slot').length,
        legend: document.querySelectorAll('#legend li').length,
        nowbox: document.querySelector('#nowbox-radio [data-nowbox-show]').textContent,
        todayVisible: !document.getElementById('today-panel').hidden,
        fontInter: document.fonts.check('16px Inter'),
        fontGrotesk: document.fonts.check('700 16px "Space Grotesk"'),
        version: document.getElementById('app-version').textContent
    }))()`);
    console.log(JSON.stringify(ui));
    check('pont natif présent', ui.native);
    check('morceau en cours affiché', ui.np && ui.np !== 'HaikoRadio', ui.np + ' / ' + ui.artist);
    check('historique affiché', ui.history > 0, ui.history + ' morceaux');
    check('site joignable (pas de message hors-ligne)', !ui.offline);
    check('planning : 7 jours et des créneaux', ui.cols === 7 && ui.slots >= 28, ui.cols + ' jours, ' + ui.slots + ' créneaux');
    check('légende du planning', ui.legend >= 5, ui.legend + ' lignes');
    check('« En ce moment » / aujourd\'hui affichés', ui.todayVisible && ui.nowbox.length > 0, ui.nowbox);
    check('polices embarquées chargées', ui.fontInter && ui.fontGrotesk);
    check('version affichée', /v\d/.test(ui.version), ui.version);
    await shot('01-radio');

    // 1b) Curseur de volume : sous Windows, c'est le volume de la page (mémorisé), pas celui d'un pont natif
    const vol = await js(`(() => {
        const s = document.getElementById('volume');
        s.value = '33';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        const r = { audio: document.getElementById('audio').volume, stored: localStorage.getItem('radio-volume') };
        s.value = '80';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        return r;
    })()`);
    // Deux états valides : avant toute lecture le volume est celui de l'élément audio (0,33) ; dès qu'une lecture a eu lieu,
    // il passe par le « gain » placé après l'analyse du son (l'élément audio reste alors à 1). Dans les deux cas il est mémorisé.
    check('curseur de volume : règle le son de la page et le mémorise',
        (Math.abs(vol.audio - 0.33) < 0.001 || vol.audio === 1) && vol.stored === '33', JSON.stringify(vol));

    // 1c) Mise à jour : sans application installée (développement), rien ne doit s'afficher ni se déclencher
    const upd = await js(`(async () => ({
        state: (await haikoNative.getUpdateState()).status,
        bannerHidden: document.getElementById('update-banner').hidden,
        checkHidden: document.getElementById('update-check').hidden
    }))()`);
    check('mise à jour : désactivée en développement, interface masquée', upd.state === 'disabled' && upd.bannerHidden && upd.checkHidden, JSON.stringify(upd));

    // 2) Lecture réelle : qualité standard, puis mode économique
    const play = async (label, modeSelector) => {
        if (modeSelector) { await js(`document.querySelector('${modeSelector}').click()`); }
        // État réel du lecteur (et non son apparence : pendant la connexion il n'est pas encore « en lecture »).
        const before = await js(`window.Haiko.player.isPlaying()`);
        if (!before) { await js(`document.getElementById('play-btn').click()`); }
        await sleep(7000);
        const s = await js(`(() => { const a = document.getElementById('audio'); return {
            playing: !a.paused, t: +a.currentTime.toFixed(1),
            status: document.getElementById('player-status').textContent,
            cls: document.getElementById('player').className,
            src: (a.currentSrc || '').slice(0, 70)
        }; })()`);
        check('lecture ' + label, s.playing && s.t > 1 && /is-playing/.test(s.cls), `${s.status} · ${s.t}s · ${s.src}`);

        // Égaliseur : les 7 barres doivent suivre le son réellement joué (analyse du flux), pas une animation fixe.
        const sample = () => js(`(() => ({
            reactive: document.querySelector('.equalizer').classList.contains('is-reactive'),
            levels: [...document.querySelectorAll('.equalizer span')].map((b) => parseFloat(b.style.getPropertyValue('--lvl')))
        }))()`);
        const samples = [];
        for (let i = 0; i < 6; i++) { samples.push(await sample()); await sleep(250); }
        const last = samples[samples.length - 1];
        const distinct = new Set(last.levels.map((v) => v.toFixed(2))).size;
        let movement = 0;
        for (let k = 0; k < 7; k++) {
            const vals = samples.map((x) => x.levels[k]).filter((v) => !Number.isNaN(v));
            if (vals.length) { movement = Math.max(movement, Math.max(...vals) - Math.min(...vals)); }
        }
        check('égaliseur ' + label + ' : barres réactives au son', last.reactive && last.levels.length === 7 && distinct >= 3 && movement > 0.05,
            `réactif=${last.reactive}, ${distinct} niveaux distincts, mouvement=${movement.toFixed(2)}, barres=[${last.levels.map((v) => v.toFixed(2)).join(' ')}]`);
        const volumeViaGain = await js(`document.getElementById('audio').volume === 1`);
        check('volume ' + label + ' : réglé après l\'analyse (les barres ne baissent pas avec le volume)', volumeViaGain);
        return s;
    };
    await play('qualité standard', null);
    await shot('02-lecture');
    await play('mode économique', '[data-mode=hls]');
    await js(`document.querySelector('[data-mode=aac]').click()`);
    await sleep(6000);
    const back = await js(`document.getElementById('player-status').textContent`);
    check('retour qualité standard', /standard/.test(back), back);
    const titleWhilePlaying = await js(`document.title`);
    check('titre de fenêtre = morceau en cours', titleWhilePlaying.startsWith('♪'), titleWhilePlaying);

    // 2b) Fermer la fenêtre pendant l'écoute : sous Windows la radio continue (zone de notification).
    // Sous Linux fermer la fenêtre quitte l'application (beaucoup de bureaux n'ont pas de zone de notification) : on ne le teste pas ici.
    if (process.platform === 'win32') {
        win.close();
        await sleep(800);
        const hidden = !win.isDestroyed() && !win.isVisible();
        const stillPlaying = await js(`!document.getElementById('audio').paused`);
        check('fermeture pendant l\'écoute : fenêtre masquée, application toujours active', hidden);
        check('la radio continue de jouer fenêtre masquée', stillPlaying);
        win.show();
        await sleep(300);
    } else {
        console.log('--    fermeture vers la zone de notification : non applicable sous ' + process.platform);
    }

    // 2c) Commande lecture/pause venue de l'icône de la zone de notification
    win.webContents.send('toggle-play');
    await sleep(1200);
    check('menu de l\'icône : « Mettre en pause » arrête la radio', await js(`document.getElementById('audio').paused`));
    win.webContents.send('toggle-play');
    await sleep(6000);
    check('menu de l\'icône : « Écouter la radio » relance la radio', await js(`!document.getElementById('audio').paused && document.getElementById('audio').currentTime > 1`));

    // 3) Arrêt
    await js(`document.getElementById('play-btn').click()`);
    await sleep(600);
    const stopped = await js(`document.getElementById('audio').paused && !document.getElementById('audio').hasAttribute('src')`);
    check('arrêt propre (flux coupé)', stopped);
    const barsReset = await js(`(() => {
        const eq = document.querySelector('.equalizer');
        return !eq.classList.contains('is-reactive') && [...eq.querySelectorAll('span')].every((b) => b.style.getPropertyValue('--lvl') === '');
    })()`);
    check('arrêt : les barres reviennent à leur état de repos', barsReset);

    // 4) Page Planning + thème clair
    await js(`document.querySelector('.topbar [data-view-link=planning]').click()`);
    await sleep(500);
    await shot('03-planning');
    await js(`document.querySelector('[data-theme-toggle]').click()`);
    await sleep(400);
    await shot('04-planning-clair');
    await js(`document.querySelector('.topbar [data-view-link=radio]').click()`);
    await sleep(400);
    await shot('05-radio-clair');
    await js(`document.querySelector('[data-theme-toggle]').click()`); // on remet le thème sombre

    // 5) Petite fenêtre (téléphone / fenêtre étroite)
    win.setSize(420, 800);
    await sleep(700);
    await shot('06-etroit');

    console.log(problems.length ? '\nPROBLEMES :\n - ' + problems.join('\n - ') : '\nTout est bon.');
    app.exit(problems.length ? 1 : 0);
});

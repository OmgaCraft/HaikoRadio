'use strict';

/*
 * Vérifie qu'une application FABRIQUÉE (dossier win-unpacked, AppImage, application installée…) démarre et
 * affiche bien ses données. Contrairement à test/smoke.js (qui lance le code source), ceci teste le résultat final.
 *
 * Utilisation :
 *     node test/packaged-check.js <programme> [options du programme…]
 * Exemples :
 *     node test/packaged-check.js "C:\\...\\win-unpacked\\HaikoRadio.exe"
 *     node test/packaged-check.js ./HaikoRadio-0.1.5.AppImage --appimage-extract-and-run --no-sandbox
 *
 * Variables : HAIKO_CHECK_AUDIO=0 pour ne pas tester la lecture du son (machine sans carte son, serveur de test).
 * Code de sortie : 0 = tout est bon, 1 = au moins un contrôle a échoué.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, ...extra] = process.argv.slice(2);
if (!exe) {
    console.error('Utilisation : node test/packaged-check.js <programme> [options…]');
    process.exit(2);
}

const checkAudio = process.env.HAIKO_CHECK_AUDIO !== '0';
const port = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'haikoradio-check-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

const child = spawn(exe, [...extra, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    stdio: 'ignore',
    detached: process.platform !== 'win32' // sous Linux, un groupe de processus à part : on peut tout arrêter d'un coup
});
let childExited = null;
child.on('exit', (code, signal) => { childExited = `code ${code} signal ${signal}`; });
child.on('error', (error) => { childExited = 'erreur de lancement : ' + error.message; });

function stopApp() {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch (e) { /* déjà arrêté */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* pas grave */ }
}

function check(label, ok, detail) {
    console.log((ok ? 'OK    ' : 'ECHEC ') + label + (detail !== undefined ? '  → ' + detail : ''));
    if (!ok) { failed++; }
}

async function connect() {
    for (let i = 0; i < 80; i++) { // jusqu'à ~40 s : un AppImage se décompresse au premier lancement
        if (childExited) { return null; }
        try {
            const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = pages.find((p) => p.type === 'page' && /^app:\/\/haiko\//.test(p.url));
            if (page) { return page; }
        } catch (e) { /* pas encore prêt */ }
        await sleep(500);
    }
    return null;
}

(async () => {
    const page = await connect();
    if (!page) {
        check('l\'application démarre et ouvre sa fenêtre', false, childExited || 'aucune fenêtre au bout de 40 s');
        stopApp();
        process.exit(1);
    }
    check('l\'application démarre et ouvre sa fenêtre', true, page.url);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    const evaluate = (expression) => new Promise((resolve) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.id === id) { ws.removeEventListener('message', onMessage); resolve(d.result && d.result.result ? d.result.result.value : undefined); }
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });

    await sleep(5000); // le temps de lire le site (morceau en cours, planning)
    const ui = await evaluate(`(() => ({
        native: !!window.haikoNative,
        title: document.getElementById('np-title').textContent,
        history: document.querySelectorAll('#history li').length,
        offline: !document.getElementById('offline-note').hidden,
        slots: document.querySelectorAll('.week-col .slot').length,
        fontInter: document.fonts.check('16px Inter'),
        version: document.getElementById('app-version').textContent
    }))()`);
    console.log('      ' + JSON.stringify(ui));
    check('pont natif présent', ui && ui.native);
    check('morceau en cours affiché', ui && ui.title && ui.title !== 'HaikoRadio', ui && ui.title);
    check('historique affiché', ui && ui.history > 0, ui && ui.history + ' morceaux');
    check('site joignable', ui && !ui.offline);
    check('planning complet', ui && ui.slots >= 28, ui && ui.slots + ' créneaux');
    check('polices embarquées', ui && ui.fontInter);
    check('version affichée', ui && /v\d+\.\d+\.\d+/.test(ui.version), ui && ui.version);

    if (checkAudio) {
        await evaluate(`document.getElementById('play-btn').click()`);
        await sleep(8000);
        const s = await evaluate(`(() => { const a = document.getElementById('audio'); return {
            playing: !a.paused && a.currentTime > 1, t: +a.currentTime.toFixed(1),
            status: document.getElementById('player-status').textContent,
            reactive: document.querySelector('.equalizer').classList.contains('is-reactive') }; })()`);
        check('la radio joue', s && s.playing, s && `${s.status} · ${s.t}s`);
        check('les barres suivent le son', s && s.reactive);
        await evaluate(`document.getElementById('play-btn').click()`);
    } else {
        console.log('--    lecture du son non testée (HAIKO_CHECK_AUDIO=0)');
    }

    ws.close();
    stopApp();
    console.log(failed ? `\nPROBLEMES : ${failed}` : '\nTout est bon.');
    process.exit(failed ? 1 : 0);
})().catch((error) => { console.error('Erreur du contrôle :', error); stopApp(); process.exit(1); });

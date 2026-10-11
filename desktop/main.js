'use strict';

/*
 * Application Windows de HaikoRadio.
 * Rôle : ouvrir une fenêtre qui affiche l'interface (dossier ../app), garder la radio en lecture
 * quand on ferme la fenêtre (icône dans la zone de notification), gérer les touches multimédia
 * et fournir à l'interface un accès réseau limité au site de la radio.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, protocol, net, ipcMain, shell, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const SITE = 'https://radio.omgacraft.fr';
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://haiko`;
// Interface : à côté du code en développement, dans le dossier "resources" une fois installée.
const UI_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..', 'app');
const TRAY_ICON = path.join(__dirname, 'build', 'tray.png');

const startHidden = process.argv.includes('--hidden'); // lancement automatique avec Windows : on démarre dans la zone de notification
const devTools = process.argv.includes('--devtools');
const smokeTest = process.env.HAIKO_SMOKE_DIR !== undefined; // test automatique (voir test/smoke.js)

// Le test automatique utilise un profil jetable : il ne touche ni aux réglages ni à la taille de fenêtre de la vraie application.
if (smokeTest) {
    app.setPath('userData', path.join(require('os').tmpdir(), 'haikoradio-smoke-profile'));
}

let win = null;
let tray = null;
let quitting = false;
let playing = false;
let track = '';
let balloonShown = false;

// Touches multimédia (lecture/pause du clavier, casque…) : transmises à l'interface.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');

protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// Une seule fenêtre : relancer l'application ramène la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
}

// ---------- Mémorisation de la taille / position de la fenêtre ----------

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadWindowState() {
    const fallback = { width: 1040, height: 780 };
    try {
        const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        const state = {
            width: Math.max(380, Math.min(4000, Number(s.width) || fallback.width)),
            height: Math.max(560, Math.min(4000, Number(s.height) || fallback.height)),
            maximized: !!s.maximized
        };
        if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
            // On ne restaure la position que si elle est encore visible (écran débranché, résolution changée…).
            const visible = screen.getAllDisplays().some((d) => {
                const b = d.workArea;
                return s.x + 100 > b.x && s.x < b.x + b.width - 100 && s.y >= b.y - 10 && s.y < b.y + b.height - 100;
            });
            if (visible) { state.x = s.x; state.y = s.y; }
        }
        return state;
    } catch (e) {
        return fallback;
    }
}

function saveWindowState() {
    if (!win || win.isDestroyed()) { return; }
    try {
        const b = win.getNormalBounds();
        fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch (e) { /* pas grave : on repartira sur la taille par défaut */ }
}

// ---------- Fenêtre ----------

function createWindow() {
    const state = loadWindowState();
    win = new BrowserWindow({
        width: state.width,
        height: state.height,
        x: state.x,
        y: state.y,
        minWidth: 380,
        minHeight: 560,
        show: false,
        backgroundColor: '#0a0c11',
        title: 'HaikoRadio',
        icon: TRAY_ICON,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: false // la radio doit continuer à jouer fenêtre masquée ou réduite
        }
    });
    win.removeMenu();
    if (state.maximized) { win.maximize(); }

    win.once('ready-to-show', () => {
        if (!startHidden) { win.show(); }
        if (devTools) { win.webContents.openDevTools({ mode: 'detach' }); }
    });

    // Fermer la fenêtre pendant l'écoute : la radio continue dans la zone de notification.
    win.on('close', (event) => {
        saveWindowState();
        if (!quitting && playing) {
            event.preventDefault();
            win.hide();
            if (!balloonShown && tray && process.platform === 'win32') {
                balloonShown = true;
                tray.displayBalloon({
                    title: 'HaikoRadio continue de jouer',
                    content: 'Clique sur l\'icône près de l\'horloge pour rouvrir la fenêtre ou quitter.',
                    iconType: 'info'
                });
            }
        }
    });
    win.on('resize', debounce(saveWindowState, 800));
    win.on('move', debounce(saveWindowState, 800));
    win.on('closed', () => { win = null; });

    // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application.
    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternalSafely(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(APP_ORIGIN + '/')) {
            event.preventDefault();
            openExternalSafely(url);
        }
    });

    win.loadURL(`${APP_ORIGIN}/index.html`);
}

function showWindow() {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) { win.restore(); }
    win.show();
    win.focus();
}

function openExternalSafely(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'https:' || u.protocol === 'http:') { shell.openExternal(u.toString()); }
    } catch (e) { /* adresse invalide : ignorée */ }
}

function debounce(fn, ms) {
    let timer = null;
    return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

// ---------- Icône de la zone de notification ----------

function buildTrayMenu() {
    return Menu.buildFromTemplate([
        { label: 'Ouvrir HaikoRadio', click: showWindow },
        {
            label: playing ? 'Mettre en pause' : 'Écouter la radio',
            click: () => {
                // L'interface décide (elle sait si le flux est en cours) ; si la fenêtre n'existe plus, on la recrée.
                if (!win) { createWindow(); win.webContents.once('did-finish-load', () => win.webContents.send('toggle-play')); }
                else { win.webContents.send('toggle-play'); }
            }
        },
        { type: 'separator' },
        {
            label: 'Lancer avec Windows',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
        },
        { type: 'separator' },
        { label: 'Quitter', click: () => { quitting = true; app.quit(); } }
    ]);
}

function updateTray() {
    if (!tray) { return; }
    tray.setToolTip(playing && track ? `♪ ${track}` : 'HaikoRadio');
    tray.setContextMenu(buildTrayMenu());
}

function createTray() {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.on('click', () => {
        if (win && win.isVisible() && win.isFocused()) { win.hide(); } else { showWindow(); }
    });
    updateTray();
}

// ---------- Échanges avec l'interface ----------

// Seule l'interface de l'application (app://haiko/…) a le droit de parler au programme principal.
function fromApp(event) {
    const url = event.senderFrame ? event.senderFrame.url : '';
    return url.startsWith(APP_ORIGIN + '/');
}

ipcMain.handle('net:get-json', async (event, url) => {
    if (!fromApp(event)) { throw new Error('refusé'); }
    if (typeof url !== 'string' || !url.startsWith(SITE + '/')) { throw new Error('adresse non autorisée'); }
    // On répond toujours par un objet (même pour une page absente, ce qui est normal pour /api/planning)
    // plutôt que de lever une erreur : sinon Electron l'écrit dans les journaux à chaque fois.
    const res = await net.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) { return { ok: false, status: res.status }; }
    return { ok: true, data: await res.json() };
});

ipcMain.handle('app:version', (event) => (fromApp(event) ? app.getVersion() : ''));

ipcMain.on('player:state', (event, state) => {
    if (!fromApp(event) || !state || typeof state !== 'object') { return; }
    playing = !!state.playing;
    track = typeof state.track === 'string' ? state.track.slice(0, 120) : '';
    updateTray();
});

// ---------- Démarrage ----------

app.whenReady().then(() => {
    // L'interface est servie par app://haiko/… depuis le dossier ../app (avec protection contre les chemins "../").
    protocol.handle(APP_SCHEME, (request) => {
        let rel = decodeURIComponent(new URL(request.url).pathname);
        if (rel === '/') { rel = '/index.html'; }
        const file = path.normalize(path.join(UI_DIR, rel));
        if (!file.startsWith(UI_DIR + path.sep)) { return new Response('Interdit', { status: 403 }); }
        return net.fetch(pathToFileURL(file).toString());
    });

    // Aucune autorisation spéciale (caméra, micro, position…) : l'application n'en a pas besoin.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));

    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
});

// Même fenêtre fermée, l'application reste active tant qu'on n'a pas choisi "Quitter" (ou que la radio ne joue pas).
app.on('window-all-closed', () => {
    if (quitting || !playing) { app.quit(); }
});
app.on('before-quit', () => { quitting = true; });

// Test automatique : lancé par  HAIKO_SMOKE_DIR=<dossier> npx electron .
if (smokeTest) { require('./test/smoke.js'); }

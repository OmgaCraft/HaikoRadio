'use strict';

/*
 * Mise à jour automatique de l'application Windows.
 *
 * Principe : l'application regarde sur GitHub (Releases du dépôt OmgaCraft/HaikoRadio) si une version plus
 * récente existe. Si oui, elle la télécharge en arrière-plan (la radio continue de jouer), vérifie son empreinte
 * (sha512 publiée dans latest.yml), puis propose « Redémarrer et installer ». Si l'utilisateur ne fait rien,
 * la mise à jour s'installe toute seule à la fermeture de l'application.
 *
 * État envoyé à l'interface :  { status, version, percent, manual, message }
 *   status : 'disabled' (version de développement) | 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error'
 *   manual : la vérification a été demandée par l'utilisateur (on lui répond) ; sinon elle est silencieuse.
 */

const { app, ipcMain, net } = require('electron');

const FIRST_CHECK_DELAY_MS = 15 * 1000;       // laisse l'application démarrer tranquillement
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;    // puis toutes les 4 heures
// Pour les tests uniquement : un faux « serveur de mises à jour » sur cet ordinateur (jamais une adresse distante).
const LOCAL_FEED = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

// Fichier que l'outil de mise à jour lit dans la Release (il dépend du système).
const FEED_FILE = process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml';

// Où chercher : la liste des Releases du dépôt, puis le dossier de téléchargement de celle qu'on retient.
const RELEASES_API = 'https://api.github.com/repos/OmgaCraft/HaikoRadio/releases?per_page=20';
const DOWNLOAD_BASE = 'https://github.com/OmgaCraft/HaikoRadio/releases/download';

let autoUpdater = null;
let localFeed = null;      // test : faux serveur de mises à jour local
let releasesApi = RELEASES_API;
let downloadBase = DOWNLOAD_BASE;
let state = { status: 'disabled', version: '', percent: 0, manual: false, message: '' };
let notify = () => {};

function set(patch) {
    state = { ...state, ...patch };
    notify(state);
}

/**
 * Choisit la Release qui sert de source de mise à jour : la plus récente qui contient le fichier d'information de ce
 * système (latest.yml sous Windows, latest-linux.yml sous Linux).
 * Une Release publiée seulement pour Android (APK seul) n'en contient pas : on la saute au lieu de perdre
 * les mises à jour Windows. Brouillons et pré-versions sont ignorés.
 * @returns {string|null} l'étiquette (ex. « v0.1.4 »), ou null si aucune ne convient
 */
function pickFeedTag(releases, feedFile = FEED_FILE) {
    if (!Array.isArray(releases)) { return null; }
    for (const release of releases) {
        if (!release || release.draft || release.prerelease) { continue; }
        if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) { continue; }
        const assets = Array.isArray(release.assets) ? release.assets : [];
        if (assets.some((a) => a && a.name === feedFile)) { return release.tag_name; }
    }
    return null;
}

// Pointe l'outil de mise à jour vers la bonne Release. En cas d'échec (réseau, limite de GitHub…), on garde la source
// précédente ou celle par défaut : une vérification ratée reste sans conséquence.
async function resolveFeed() {
    if (!autoUpdater || (localFeed && !process.env.HAIKO_RELEASES_API)) { return; }
    try {
        const res = await net.fetch(releasesApi, {
            headers: { Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) { return; }
        const tag = pickFeedTag(await res.json());
        if (tag) { autoUpdater.setFeedURL({ provider: 'generic', url: `${downloadBase}/${tag}` }); }
    } catch (error) {
        console.error('[mise à jour] choix de la Release impossible :', error && error.message ? error.message : error);
    }
}

function busy() {
    return state.status === 'checking' || state.status === 'downloading' || state.status === 'ready';
}

async function check(manual) {
    if (!autoUpdater) { return state; }
    if (busy()) {
        if (manual) { set({ manual: true }); }
        return state;
    }
    set({ status: 'checking', manual: !!manual, message: '' });
    try {
        await resolveFeed();
        await autoUpdater.checkForUpdates();
    } catch (error) {
        onError(error);
    }
    return state;
}

function onError(error) {
    // Une vérification automatique qui échoue (pas de réseau, Release sans latest.yml…) reste silencieuse.
    const detail = error && error.message ? error.message : String(error);
    console.error('[mise à jour]', detail);
    // Fichier téléchargé dont l'empreinte ne correspond pas : il est supprimé et jamais installé.
    const corrupted = /sha512|checksum/i.test(detail);
    const message = corrupted
        ? 'Le fichier de mise à jour téléchargé est invalide : il a été refusé et supprimé.'
        : 'Impossible de vérifier les mises à jour pour le moment.';
    if (state.status === 'downloading' && !state.manual) {
        set({ status: 'idle', percent: 0, message });
    } else {
        set({ status: state.manual ? 'error' : 'idle', message });
    }
}

function install(beforeQuit) {
    if (!autoUpdater || state.status !== 'ready') { return; }
    beforeQuit(); // la fermeture de la fenêtre ne doit pas être retenue (« la radio continue dans la zone de notification »)
    // Installation silencieuse, puis relance de l'application.
    autoUpdater.quitAndInstall(true, true);
}

/**
 * @param {{ fromApp: (event) => boolean, onChange: (state) => void, beforeQuit: () => void }} options
 */
function init(options) {
    notify = options.onChange;

    ipcMain.handle('update:get-state', (event) => (options.fromApp(event) ? state : null));
    ipcMain.handle('update:check', (event) => (options.fromApp(event) ? check(true) : null));
    ipcMain.on('update:install', (event) => { if (options.fromApp(event)) { install(options.beforeQuit); } });

    localFeed = process.env.HAIKO_UPDATE_URL && LOCAL_FEED.test(process.env.HAIKO_UPDATE_URL)
        ? process.env.HAIKO_UPDATE_URL : null;
    // Tests : faux « GitHub » local (liste des Releases + dossier de téléchargement), jamais une adresse distante.
    if (process.env.HAIKO_RELEASES_API && LOCAL_FEED.test(process.env.HAIKO_RELEASES_API) &&
        process.env.HAIKO_DOWNLOAD_BASE && LOCAL_FEED.test(process.env.HAIKO_DOWNLOAD_BASE)) {
        releasesApi = process.env.HAIKO_RELEASES_API;
        downloadBase = process.env.HAIKO_DOWNLOAD_BASE.replace(/\/$/, '');
    }

    // En développement (application non installée) il n'y a rien à mettre à jour, sauf pour un test avec un serveur local.
    if (!app.isPackaged && !localFeed) { return; }
    if (process.env.HAIKO_SMOKE_DIR !== undefined && !localFeed) { return; }

    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;           // télécharge dès qu'une version est trouvée
    autoUpdater.autoInstallOnAppQuit = true;   // sinon, installe quand on quitte l'application
    autoUpdater.allowPrerelease = false;       // jamais de version préliminaire
    autoUpdater.allowDowngrade = false;
    if (localFeed) {
        autoUpdater.setFeedURL({ provider: 'generic', url: localFeed });
        autoUpdater.forceDevUpdateConfig = true;
    }

    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => set({ status: 'none', percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', onError);

    set({ status: 'idle' });
    setTimeout(() => check(false), FIRST_CHECK_DELAY_MS);
    setInterval(() => check(false), CHECK_EVERY_MS);
}

module.exports = {
    init,
    pickFeedTag,
    check,
    install,
    getState: () => state
};

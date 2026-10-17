'use strict';

/*
 * Publie la version Windows sur GitHub : crée la Release de la version (si elle n'existe pas) et y envoie
 *   - l'installateur (HaikoRadio-Setup-<version>.exe)
 *   - latest.yml et le fichier .blockmap : indispensables à la mise à jour automatique des applications déjà installées.
 *
 * Par défaut le script SIMULE (il vérifie tout et affiche ce qu'il ferait). Pour publier pour de bon :
 *     npm run publish -- --yes
 *
 * Avant : avoir fabriqué l'installateur (npm run dist), avoir enregistré (commit) et envoyé (push) le code sur GitHub.
 * Le script refuse de publier si l'installateur ne correspond pas au code envoyé.
 * Si l'APK Android doit être dans la même Release, il est envoyé par l'autre procédure (voir docs/android.md).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'OmgaCraft/HaikoRadio';
const root = path.join(__dirname, '..', '..');
const version = require('../package.json').version;
const tagArg = process.argv.indexOf('--tag');
const tag = tagArg > 0 && /^v?[0-9A-Za-z._-]+$/.test(process.argv[tagArg + 1] || '') ? process.argv[tagArg + 1] : `v${version}`;
const notLatest = process.argv.includes('--not-latest'); // la Release créée ne devient pas « la dernière » (les mises à jour d'autres applications lisent « la dernière »)
// Windows par défaut ; « npm run publish -- --linux » envoie les fichiers Linux (fabriqués avec npm run dist:linux, ou par GitHub).
const platform = process.argv.includes('--linux') ? 'linux' : 'win';
const distDir = process.env.HAIKO_DIST_DIR || path.join(os.tmpdir(), platform === 'linux' ? 'haikoradio-dist-linux' : 'haikoradio-dist');
const publish = process.argv.includes('--yes');

function fail(message) {
    console.error('\nARRÊT : ' + message);
    process.exit(1);
}

function git(...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function githubToken() {
    // Le jeton déjà enregistré par Git sur cet ordinateur : on ne l'affiche jamais.
    const out = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    const match = /^password=(.+)$/m.exec(out);
    if (!match) { fail('aucun identifiant GitHub trouvé sur cet ordinateur (connecte-toi d\'abord avec Git).'); }
    return match[1].trim();
}

async function api(token, method, url, body, headers = {}) {
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...headers },
        body
    });
    return res;
}

(async () => {
    console.log(`Version ${version} (étiquette ${tag}) — ${publish ? 'PUBLICATION' : 'simulation, rien n\'est envoyé'}\n`);

    // 1) Les fichiers fabriqués
    // main : le fichier principal (sert à vérifier qu'il est plus récent que le code) ; info : le fichier lu par la mise à jour ;
    // optional : envoyé seulement s'il existe.
    const spec = platform === 'linux'
        ? [
            { name: `HaikoRadio-${version}.AppImage`, role: 'main' },
            { name: `HaikoRadio-${version}.AppImage.blockmap`, optional: true },
            { name: `HaikoRadio-${version}.deb`, optional: true },
            { name: `HaikoRadio-${version}.rpm`, optional: true },
            { name: 'latest-linux.yml', role: 'info', type: 'text/yaml' }
        ]
        : [
            { name: `HaikoRadio-Setup-${version}.exe`, role: 'main' },
            { name: `HaikoRadio-Setup-${version}.exe.blockmap` },
            { name: 'latest.yml', role: 'info', type: 'text/yaml' }
        ];
    const buildCommand = platform === 'linux' ? 'npm run dist:linux' : 'npm run dist';
    const files = [];
    for (const f of spec) {
        const full = { type: 'application/octet-stream', ...f, path: path.join(distDir, f.name) };
        if (!fs.existsSync(full.path)) {
            if (f.optional) { continue; }
            fail(`fichier introuvable : ${full.path}\nFabrique d'abord l'installateur : ${buildCommand}`);
        }
        files.push(full);
        console.log(`  ${full.name}  (${(fs.statSync(full.path).size / 1048576).toFixed(1)} Mo)`);
    }
    const mainFile = files.find((f) => f.role === 'main');
    const infoFile = files.find((f) => f.role === 'info');
    const yml = fs.readFileSync(infoFile.path, 'utf8');
    if (!new RegExp(`^version:\\s*${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(yml)) {
        fail(`${infoFile.name} ne correspond pas à la version ${version} : refabrique l'installateur.`);
    }

    // 2) Le code de l'installateur doit être enregistré, envoyé, et plus ancien que l'installateur.
    // Le dépôt est partagé avec l'application Android : on ne regarde que ce qui entre réellement dans l'installateur
    // (l'interface app/ et les fichiers de l'application Windows), pas android/ ni la documentation.
    const packaged = ['app', 'desktop/main.js', 'desktop/preload.js', 'desktop/updater.js', 'desktop/package.json', 'desktop/package-lock.json', 'desktop/build'];
    if (git('status', '--porcelain', '--', ...packaged) !== '') { fail('des modifications de l\'application ne sont pas enregistrées (commit). Enregistre-les et envoie-les sur GitHub d\'abord.'); }
    git('fetch', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    if (head !== git('rev-parse', 'origin/main')) { fail('le code local n\'est pas celui de GitHub (envoie-le avec git push).'); }
    const commitTime = Number(git('log', '-1', '--format=%ct', 'HEAD', '--', ...packaged)) * 1000;
    if (fs.statSync(mainFile.path).mtimeMs < commitTime) { fail(`l'installateur est plus ancien que le dernier changement de l'application : refabrique-le (${buildCommand}).`); }
    console.log(`\nCode de l'application : identique à GitHub (HEAD ${head.slice(0, 7)}). Installateur fabriqué après le dernier changement.`);

    if (!publish) {
        console.log('\nSimulation terminée : tout est prêt. Pour publier pour de bon :  npm run publish -- --yes');
        return;
    }

    // 3) La Release (créée si besoin), puis les fichiers
    const token = githubToken();
    let res = await api(token, 'GET', `https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
    let release;
    if (res.status === 200) {
        release = await res.json();
        console.log(`\nLa Release ${tag} existe déjà : j'y ajoute les fichiers.`);
    } else if (res.status === 404 && !process.argv.includes('--create-release')) {
        // Par défaut on n'envoie que vers une Release existante (créée avec l'APK Android) : jamais de seconde Release.
        fail(`la Release ${tag} n'existe pas encore. Elle est normalement créée avec l'APK Android ; pour la créer ici, ajoute --create-release.`);
    } else if (res.status === 404) {
        res = await api(token, 'POST', `https://api.github.com/repos/${REPO}/releases`, JSON.stringify({
            tag_name: tag,
            target_commitish: head,
            name: platform === 'linux' ? `HaikoRadio ${version} — Linux` : `HaikoRadio ${version}`,
            body: platform === 'linux'
                ? `Application Linux de HaikoRadio ${version} : AppImage (toutes distributions), paquet .deb (Debian, Ubuntu, Mint…) et paquet .rpm (Fedora, openSUSE…).\n\nFedora : sudo dnf install ./HaikoRadio-${version}.rpm\nAppImage : chmod +x HaikoRadio-${version}.AppImage puis ./HaikoRadio-${version}.AppImage (Fedora : paquet fuse-libs requis, ou option --appimage-extract-and-run).`
                : `Application Windows de HaikoRadio ${version}. Les applications déjà installées se mettent à jour toutes seules.`,
            ...(notLatest ? { make_latest: 'false' } : {}),
            draft: false,
            prerelease: false
        }), { 'Content-Type': 'application/json' });
        if (res.status !== 201) { fail(`création de la Release refusée (HTTP ${res.status}).`); }
        release = await res.json();
        console.log(`\nRelease ${tag} créée.`);
    } else {
        fail(`GitHub a répondu HTTP ${res.status}.`);
    }

    for (const f of files) {
        const existing = (release.assets || []).find((a) => a.name === f.name);
        if (existing) { await api(token, 'DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`); }
        process.stdout.write(`  envoi de ${f.name}… `);
        const up = await api(
            token, 'POST',
            `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f.name)}`,
            fs.readFileSync(f.path),
            { 'Content-Type': f.type }
        );
        if (up.status !== 201) { fail(`envoi refusé (HTTP ${up.status}).`); }
        console.log('ok');
    }
    console.log(`\nPublié : ${release.html_url}`);
})().catch((error) => fail(error && error.message ? error.message : String(error)));

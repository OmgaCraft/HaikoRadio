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
const tag = `v${version}`;
const distDir = process.env.HAIKO_DIST_DIR || path.join(os.tmpdir(), 'haikoradio-dist');
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
    const files = [
        { name: `HaikoRadio-Setup-${version}.exe`, type: 'application/octet-stream' },
        { name: `HaikoRadio-Setup-${version}.exe.blockmap`, type: 'application/octet-stream' },
        { name: 'latest.yml', type: 'text/yaml' }
    ].map((f) => ({ ...f, path: path.join(distDir, f.name) }));
    for (const f of files) {
        if (!fs.existsSync(f.path)) { fail(`fichier introuvable : ${f.path}\nFabrique d'abord l'installateur : npm run dist`); }
        console.log(`  ${f.name}  (${(fs.statSync(f.path).size / 1048576).toFixed(1)} Mo)`);
    }
    const yml = fs.readFileSync(files[2].path, 'utf8');
    if (!new RegExp(`^version:\\s*${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(yml)) {
        fail(`latest.yml ne correspond pas à la version ${version} : refabrique l'installateur.`);
    }

    // 2) Le code doit être enregistré, envoyé, et plus ancien que l'installateur
    if (git('status', '--porcelain') !== '') { fail('des modifications ne sont pas enregistrées (commit). Enregistre-les et envoie-les sur GitHub d\'abord.'); }
    git('fetch', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    if (head !== git('rev-parse', 'origin/main')) { fail('le code local n\'est pas celui de GitHub (envoie-le avec git push).'); }
    const commitTime = Number(git('log', '-1', '--format=%ct', 'HEAD')) * 1000;
    if (fs.statSync(files[0].path).mtimeMs < commitTime) { fail('l\'installateur est plus ancien que le dernier commit : refabrique-le (npm run dist).'); }
    console.log(`\nCode : commit ${head.slice(0, 7)}, identique à GitHub. Installateur fabriqué après ce commit.`);

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
            name: `HaikoRadio ${version}`,
            body: `Application Windows de HaikoRadio ${version}. Les applications déjà installées se mettent à jour toutes seules.`,
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

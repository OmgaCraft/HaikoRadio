'use strict';

/*
 * Fabrique l'installateur.
 *     npm run dist          -> Windows (installateur .exe)
 *     npm run dist:linux    -> Linux (AppImage + paquets .deb et .rpm) : à lancer sous Linux (ou par GitHub, voir .github/workflows)
 * Le résultat est écrit HORS du dossier du projet (par défaut dans le dossier temporaire du système) :
 * quand le projet est dans OneDrive, la synchronisation verrouille les fichiers et la fabrication échoue.
 * Pour choisir un autre dossier :  HAIKO_DIST_DIR=C:\chemin npm run dist
 */

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const target = args[0] === 'linux' ? 'linux' : 'win';
const extra = args[0] === 'linux' ? args.slice(1) : args; // options supplémentaires transmises telles quelles à electron-builder
const defaultDir = path.join(os.tmpdir(), target === 'linux' ? 'haikoradio-dist-linux' : 'haikoradio-dist');
const out = process.env.HAIKO_DIST_DIR || defaultDir;

// « --publish never » : cet outil ne publie jamais rien lui-même (sur GitHub il essaierait de le faire et réclamerait un
// jeton). La publication est une étape volontaire : voir scripts/publish.js. Les fichiers de mise à jour (latest*.yml) sont créés quand même.
const builderArgs = target === 'linux'
    ? ['--linux', 'AppImage', 'deb', 'rpm', '--x64', '--publish', 'never']
    : ['--win', '--x64', '--publish', 'never'];

const result = spawnSync(
    'npx',
    ['electron-builder', ...builderArgs, `--config.directories.output=${out}`, ...extra],
    { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') }
);

if (result.status === 0) {
    console.log(`\nInstallateur prêt dans : ${out}`);
}
process.exit(result.status === null ? 1 : result.status);

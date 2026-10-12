'use strict';

/*
 * Fabrique l'installateur Windows.
 * Le résultat est écrit HORS du dossier du projet (par défaut dans le dossier temporaire de Windows) :
 * quand le projet est dans OneDrive, la synchronisation verrouille les fichiers et la fabrication échoue.
 * Pour choisir un autre dossier :  HAIKO_DIST_DIR=C:\chemin npm run dist
 */

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const out = process.env.HAIKO_DIST_DIR || path.join(os.tmpdir(), 'haikoradio-dist');
const result = spawnSync(
    'npx',
    ['electron-builder', '--win', '--x64', `--config.directories.output=${out}`, ...process.argv.slice(2)],
    { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') }
);

if (result.status === 0) {
    console.log(`\nInstallateur prêt dans : ${out}`);
}
process.exit(result.status === null ? 1 : result.status);

// Génère les icônes de l'application à partir de icon.svg.
// Utilisation (une seule fois, ou si le logo change) :
//   cd tools && npm install --no-save sharp && node make-icons.mjs
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = await readFile(path.join(here, 'icon.svg'));
const out = path.join(here, '..', 'desktop', 'build');

// Icône de l'application (installateur, barre des tâches) et de la zone de notification.
await sharp(svg).resize(512, 512).png().toFile(path.join(out, 'icon.png'));
await sharp(svg).resize(64, 64).png().toFile(path.join(out, 'tray.png'));
console.log('Icônes générées dans', out);

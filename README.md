# HaikoRadio

Les applications de la webradio **HaikoRadio** : Windows (ici) et Android (à venir).
Elles reprennent le site [radio.omgacraft.fr](https://radio.omgacraft.fr) : lecteur en direct, titre et pochette du morceau en cours, historique et planning de la semaine.

## Ce que fait l'application Windows

- Lecture de la radio en **qualité standard** (flux direct 128 kbit/s) ou en **mode économique** (flux HLS plafonné à 64 kbit/s). Si le flux direct tombe, elle passe toute seule sur le flux de secours, sans changer ton choix.
- **Morceau en cours** (titre, artiste, œuvre, album, pochette) et **historique** des 10 derniers morceaux, mis à jour toutes les 15 secondes.
- **Planning** de la semaine, émission en cours et suivante (heures de Paris).
- **Zone de notification** : fermer la fenêtre pendant l'écoute laisse la radio jouer ; clic droit sur l'icône près de l'horloge pour lecture/pause, ouvrir, lancer avec Windows, quitter.
- **Touches multimédia** du clavier (lecture/pause), thème clair/sombre, taille de fenêtre mémorisée.

## Organisation du dépôt

```
app/       L'interface (HTML, CSS, JavaScript), écrite une seule fois et partagée par Windows et Android
desktop/   L'application Windows (Electron) : fenêtre, icône de notification, installateur
android/   L'application Android (à venir) — réutilisera le dossier app/
tools/     Outils : génération des icônes
docs/      Notes techniques
```

## Lancer l'application (développement)

Il faut [Node.js](https://nodejs.org) (version 20 ou plus).

```bash
cd desktop
npm install
npm start
```

## Fabriquer l'installateur Windows

```bash
cd desktop
npm install
npm run dist
```

Le fichier `HaikoRadio-Setup-<version>.exe` est écrit **hors du dossier du projet** (par défaut dans le dossier temporaire de Windows, son emplacement est affiché à la fin) : quand le projet est dans OneDrive, la synchronisation bloque la fabrication. Pour choisir le dossier : `HAIKO_DIST_DIR=C:\chemin npm run dist`.
Ce fichier est l'installateur à publier dans une *Release* GitHub (c'est de là que le site propose le téléchargement).
L'installateur n'est pas signé numériquement : Windows peut afficher un avertissement « SmartScreen » au premier lancement (« Informations complémentaires » puis « Exécuter quand même »).

## Vérifier que tout fonctionne (test automatique)

Ce test ouvre l'application, vérifie l'affichage, joue réellement la radio dans les deux qualités, teste la fermeture vers la zone de notification, puis prend des captures d'écran.
Il utilise un profil temporaire : il ne touche pas aux réglages de ta vraie application. Une vraie fenêtre s'ouvre pendant ~1 minute : ne clique pas dedans.

```bash
cd desktop
HAIKO_SMOKE_DIR=captures npx electron .        # bash
$env:HAIKO_SMOKE_DIR="captures"; npx electron .   # PowerShell
```

## D'où viennent les données

| Donnée | Source |
|---|---|
| Son | Les deux flux Infomaniak (voir `app/js/config.js`) |
| Morceau en cours, historique, pochettes | `https://radio.omgacraft.fr/api/now-playing` |
| Planning | `https://radio.omgacraft.fr/api/planning` si le site le propose, sinon la copie `app/data/planning.json` fournie avec l'application |

Tous les réglages (adresse du site, flux, fréquence de mise à jour) sont dans `app/js/config.js`.

## Sécurité

L'interface ne peut charger que ses propres fichiers, le son des deux flux et les pochettes du site (règle de sécurité dans `app/index.html`). Elle n'a aucun accès au système : seul le programme principal parle au réseau, et uniquement vers `radio.omgacraft.fr`. Les liens externes s'ouvrent dans le navigateur.

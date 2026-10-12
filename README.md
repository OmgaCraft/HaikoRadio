# HaikoRadio

Les applications de la webradio **HaikoRadio** : Windows (ici) et Android (à venir).
Elles reprennent le site [radio.omgacraft.fr](https://radio.omgacraft.fr) : lecteur en direct, titre et pochette du morceau en cours, historique et planning de la semaine.

## Ce que fait l'application Windows

- Lecture de la radio en **qualité standard** (flux direct 128 kbit/s) ou en **mode économique** (flux HLS plafonné à 64 kbit/s). Si le flux direct tombe, elle passe toute seule sur le flux de secours, sans changer ton choix.
- **Morceau en cours** (titre, artiste, œuvre, album, pochette) et **historique** des 10 derniers morceaux, mis à jour toutes les 15 secondes.
- **Planning** de la semaine, émission en cours et suivante (heures de Paris).
- **Zone de notification** : fermer la fenêtre pendant l'écoute laisse la radio jouer ; clic droit sur l'icône près de l'horloge pour lecture/pause, ouvrir, lancer avec Windows, quitter.
- **Touches multimédia** du clavier (lecture/pause), thème clair/sombre, taille de fenêtre mémorisée.
- **Mise à jour automatique** : l'application cherche toute seule une nouvelle version sur GitHub, la télécharge en arrière-plan (la radio continue de jouer) et propose « Redémarrer et installer ». Voir « Publier une nouvelle version ».

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

## Publier une nouvelle version (mise à jour automatique)

Les applications déjà installées se mettent à jour toutes seules, à condition que la nouvelle version soit publiée **correctement** sur GitHub. Marche à suivre, dans l'ordre :

1. Changer le numéro de version dans `desktop/package.json` (champ `"version"`, par ex. `0.1.2`). Il doit être **plus grand** que le précédent.
2. Enregistrer (commit) et envoyer (push) le code sur GitHub.
3. Fabriquer l'installateur : `cd desktop && npm run dist`
4. Simuler la publication (ne publie rien, vérifie tout) : `npm run publish`
5. Publier pour de bon : `npm run publish -- --yes`

Le script envoie trois fichiers vers la Release `v<version>` qui doit **déjà exister** (elle est créée avec l'APK Android ; pour la créer ici : `--create-release`) : : l'installateur, son `.blockmap` et `latest.yml`. **Ces trois fichiers sont indispensables** : sans `latest.yml`, les applications installées ne voient pas la nouvelle version. Il refuse de publier si des modifications ne sont pas enregistrées, si le code n'est pas sur GitHub, ou si l'installateur est plus ancien que le dernier commit.
L'APK Android est ajouté à la même Release (voir `docs/android.md`) : le site de la radio lit la dernière Release et y cherche un `.exe` et un `.apk`. Ne pas passer une Release en « brouillon » ni en « pré-version » : elle ne serait pas proposée.

Comment ça marche côté application : 15 secondes après le démarrage puis toutes les 4 heures, elle lit `latest.yml` dans la dernière Release, télécharge l'installateur si la version est plus récente et **vérifie son empreinte (sha512)** : un fichier modifié ou corrompu est refusé et supprimé. Si tu ne fais rien, la mise à jour s'installe à la fermeture. Un bouton « Rechercher une mise à jour » (pied de page) et un menu de l'icône permettent de vérifier à la main.
La version 0.1.0 (sans ce mécanisme) doit être mise à jour à la main une seule fois ; les suivantes sont automatiques. L'installateur n'étant pas signé, la vérification repose sur l'empreinte publiée dans `latest.yml` (le compte GitHub est donc la clé de la chaîne : le protéger).

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

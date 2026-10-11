# Architecture

## Principe

Une seule interface (`app/`), deux « coques » qui l'affichent : Windows (`desktop/`, Electron) et Android (`android/`, à venir).
L'interface est reprise du site `radio.omgacraft.fr` (même thème, mêmes composants) mais fonctionne sans PHP : elle lit les données du site par son API.

## Fichiers de l'interface (`app/`)

| Fichier | Rôle |
|---|---|
| `index.html` | Les deux pages (Radio, Planning) et la règle de sécurité |
| `js/config.js` | Réglages : adresse du site, flux, fréquence de mise à jour |
| `js/net.js` | Accès au site (par le pont natif sous Windows, sinon `fetch`) |
| `js/nowplaying.js` | Morceau en cours, historique, pochettes |
| `js/player.js` | Lecteur : qualité standard / économique, secours automatique, commandes système |
| `js/planning.js` | Planning : calcul « en ce moment / ensuite », grille, listes, légende |
| `js/app.js` | Navigation, titre de la fenêtre, lien avec l'application Windows |
| `css/theme.css`, `css/site.css` | Thème et composants copiés du site |
| `vendor/hls.min.js` | Lecteur HLS (hls.js, licence Apache 2.0) |
| `data/planning.json` | Copie du planning (secours si le site ne le fournit pas) |

## Application Windows (`desktop/`)

- `main.js` : fenêtre, icône de notification, protocole `app://` qui sert l'interface depuis les fichiers locaux, accès réseau limité à `radio.omgacraft.fr`.
- `preload.js` : les quatre seules fonctions données à l'interface (`getJson`, `setState`, `onTogglePlay`, `getVersion`).
- `test/smoke.js` : test automatique.

## Ce qui est copié du site (à garder en phase)

L'interface est une **copie** de ce qui est sur le site : si le site change (nouvelle émission, nouveau style), il faut reporter le changement ici.
- Planning : le jour où le site propose `/api/planning` (le contenu de son `data/planning.json`), l'application l'utilisera automatiquement, sans nouvelle version.
- Thème et composants : `app/css/theme.css` et `app/css/site.css` viennent de `assets/css/style.css` et `assets/css/radio.css` du site.

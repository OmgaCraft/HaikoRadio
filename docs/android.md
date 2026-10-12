# HaikoRadio — application Android

L'application Android est une **coque** : elle affiche l'interface commune du dossier `app/` (la même que sur PC et que sur le site)
et confie le son à un **lecteur Android natif**. Un lecteur natif est indispensable : une balise `<audio>` dans une page web
s'arrête quand l'écran s'éteint.

```
android/                     projet Gradle (Kotlin)
  shell/src/main/java/…      le code de l'application
  shell/src/debug/assets/dev page de test du pont (versions debug uniquement)
app/                         interface commune, copiée telle quelle dans l'APK à la compilation
```

## Ce que fait l'application

- Joue la radio **écran éteint**, avec une notification (titre, artiste, œuvre, pochette, bouton pause).
- Touches du casque / Bluetooth : pause, lecture (la reprise se reconnecte **au direct**, pas à l'endroit de la pause), stop.
- **Qualité standard** : flux direct AAC 128 kbit/s. S'il ne répond pas, bascule **automatiquement** sur le HLS 128 kbit/s
  (le réglage « standard » reste sélectionné, l'interface précise « flux de secours »).
- **Mode économique** : HLS plafonné à 64 kbit/s (variante annoncée à 70 400 bit/s).
- Reconnexion automatique si le réseau coupe (3 tentatives), puis message d'erreur.
- Pause de plus de 15 minutes : le service se libère tout seul.
- Titre / artiste / pochette de la notification mis à jour toutes les 15 s **côté natif** (la page web peut être suspendue écran éteint).

## Le pont page web ↔ Android (`window.HaikoNative`)

Disponible uniquement dans l'application Android (ne pas confondre avec `window.haikoNative`, avec un *h* minuscule, qui est le pont Windows).

Méthodes (synchrones) :

| Appel | Effet |
|---|---|
| `HaikoNative.isNative()` | toujours `true` : sert à détecter l'application |
| `HaikoNative.platform()` | `"android"` |
| `HaikoNative.hasVolumeControl()` | `true` : la page peut afficher un curseur de volume |
| `HaikoNative.getVolume()` | volume **de l'application** (indépendant de celui du téléphone), entier de 0 à 100 |
| `HaikoNative.setVolume(n)` | règle le volume de l'application ; `n` = **nombre entier** de 0 à 100 |
| `HaikoNative.play(mode)` | lance la radio ; `mode` = `"aac"` (standard) ou `"hls"` (économique) |
| `HaikoNative.stop()` | arrête tout (la notification disparaît) |
| `HaikoNative.setMode(mode)` | change de qualité ; repart tout de suite si la radio joue |
| `HaikoNative.getState()` | état actuel, en texte JSON |

Événement reçu par la page à chaque changement d'état, au chargement et au retour au premier plan :

```js
window.addEventListener('haiko-native-state', function (e) { /* e.detail */ });
// e.detail = { status, mode, source, fallback, message, playing, active }
```

| Champ | Valeurs |
|---|---|
| `status` | `idle` · `connecting` · `buffering` · `playing` · `paused` · `error` |
| `mode` | `aac` ou `hls` : la qualité **choisie** |
| `source` | `aac` ou `hls` : le flux **réellement** lu (peut différer de `mode` en cas de repli) |
| `fallback` | `true` si le flux direct est tombé et que le HLS 128 le remplace |
| `message` | texte d'explication (repli, erreur), sinon vide |
| `playing` / `active` | `playing` : le son sort ; `active` : connexion, mise en mémoire ou lecture |

Second événement, pour le curseur de volume :

```js
window.addEventListener('haiko-native-volume', function (e) { /* e.detail.volume : 0 à 100 */ });
```

Il est émis au chargement, au retour au premier plan et après chaque `setVolume`. Le curseur règle **le volume de l'application,
séparé du volume du téléphone** : les touches de volume du téléphone ne le font pas bouger, et le curseur ne change pas le volume du
téléphone (le son final = volume de l'application × volume du téléphone). Il est mémorisé côté Android (valeur par défaut : 100) : ne pas
le mémoriser dans `localStorage`, ne pas toucher à `audio.volume`, et mettre simplement le curseur à la valeur reçue **sans rappeler
`setVolume`** (sinon boucle). Le curseur suit une courbe douce (le gain appliqué est le carré de la valeur) pour que le milieu du
curseur sonne réellement plus bas que le maximum.

**Règle importante** : l'état affiché par la page doit toujours suivre cet état natif. Une pause peut venir de la notification ou
du casque, pas seulement du bouton de la page.

**Attention aux appels** : Android refuse un appel de méthode dont le nombre d'arguments ne correspond pas. Appeler
`HaikoNative.play(mode)`, `HaikoNative.stop()` sans argument. (`stop(undefined)` est toléré, mais mieux vaut ne rien passer.)

## Mise à jour automatique

L'application se met à jour depuis les **Releases GitHub** du dépôt, sans passer par un magasin d'applications.

1. **Vérification** : à l'ouverture de l'application et à chaque retour dedans, **au plus une fois par heure** (6 h dans la 0.1.1 et la
   0.1.2), l'application lit la dernière Release (`/releases/latest`). **À la demande** : appui long sur l'icône de l'application →
   « Rechercher une mise à jour » (elle répond même s'il n'y a rien de nouveau, et ignore « Plus tard »).
   Elle compare le tag (`v0.1.1`) à sa propre version. Les brouillons et les pré-versions sont ignorés.
2. **Proposition** : si la version est plus récente, une boîte de dialogue propose « Mettre à jour » ou « Plus tard »
   (« Plus tard » repousse de 24 h la même version).
3. **Téléchargement** du premier fichier `.apk` de la Release (uniquement s'il est hébergé par ce dépôt), avec une barre de progression.
4. **Contrôles avant installation** (tout refus est expliqué à l'utilisateur et rien n'est installé) : taille et empreinte SHA-256
   annoncée par GitHub, même nom d'application, version plus récente, et **signature identique à celle de l'application installée**.
5. **Installation** par le système Android, qui demande une confirmation (une installation 100 % silencieuse est impossible hors Play Store).
   La première fois, Android demande aussi d'autoriser HaikoRadio à « installer des applications inconnues » : l'application ouvre
   les réglages et reprend toute seule au retour.

À savoir :
- La version **0.1.0** n'a pas cette fonction : il faut installer une fois la 0.1.1 à la main ; les suivantes seront proposées automatiquement.
- Pour que la mise à jour soit proposée : tag `vX.Y.Z` (supérieur à la version installée) et un fichier `.apk` dans la Release,
  **signé avec la même clé** (voir « Signature et publication »). Ne pas passer la Release en brouillon ni en pré-version.
- Le pont expose `HaikoNative.appVersion()` (version installée) et `HaikoNative.checkForUpdate()` (vérifie tout de suite et répond même
  s'il n'y a rien de nouveau). L'interface s'en sert : en bas de la page, « Application vX.Y.Z » et le lien « Rechercher une mise à jour »
  (bloc « Application Android » de `app/js/updates.js`, actif seulement si `window.HaikoNative` existe ; le bandeau Windows reste masqué).
  Appeler `checkForUpdate()` **sans argument**.
- Certains téléphones (Google Play Protect) affichent leur propre vérification lors d'une installation hors Play Store : c'est normal.

**Tester sans publier** (versions debug) : lancer l'application avec une adresse de faux serveur de versions,
`adb shell am start -n fr.omgacraft.haikoradio/.MainActivity --es release_url http://10.0.2.2:8123/latest.json`,
où `latest.json` imite la réponse de GitHub (`tag_name`, `assets[].name / size / browser_download_url / digest`).
Pour fabriquer la « nouvelle » version : `./gradlew assembleDebug -PhaikoVersionName=9.9.9 -PhaikoVersionCode=2`.

## Réseau

- L'interface est servie par l'application depuis `https://appassets.androidplatform.net/` : `app/index.html` y est `/index.html`,
  `app/css/…` y est `/css/…`. Chemins relatifs et absolus fonctionnent comme sur un site.
- Les appels `fetch('https://radio.omgacraft.fr/api/…')` fonctionnent tels quels : l'application relaie les requêtes `GET /api/…`
  et y ajoute l'autorisation CORS. **Aucune modification du serveur n'est nécessaire.**
- Tout lien vers un autre site s'ouvre dans le navigateur du téléphone, jamais dans l'application.
- L'application n'autorise que le HTTPS.

## Compiler et tester (sur ton PC)

Prérequis déjà installés : Android Studio (pour le SDK et le JDK). Ouvrir un terminal dans `android/` :

```bash
# version de test (installable directement sur un téléphone en mode développeur / un émulateur)
./gradlew assembleDebug

# version finale signée, prête à publier : android/dist/HaikoRadio-<version>.apk
./gradlew exportApk
```

- Les fichiers temporaires de compilation sont rangés dans `C:\Users\<toi>\.haikoradio\build\` (hors OneDrive, qui les verrouillait).
- **Page de test du pont** (version debug) : `adb shell am start -n fr.omgacraft.haikoradio/.MainActivity --es dev_path "bridge-test.html?auto=1"`
  déroule un scénario complet (standard, économique, arrêt, panne simulée du flux direct) et l'écrit dans `adb logcat -s HaikoWeb`.

## Signature et publication

- La clé qui signe l'APK est dans **`C:\Users\<toi>\.haikoradio\`** (`haikoradio-release.jks` + `keystore.properties`). Elle n'est
  **jamais dans le dépôt**. **À sauvegarder** (clé USB, gestionnaire de mots de passe…) : sans elle, impossible de publier une mise à
  jour qui s'installe par-dessus l'ancienne version ; il faudrait désinstaller l'application.
- Pour publier une nouvelle version : augmenter `appVersionName` **et** `appVersionCode` dans `android/shell/build.gradle.kts`,
  lancer `./gradlew exportApk`, puis joindre `android/dist/HaikoRadio-<version>.apk` à une *Release* GitHub du dépôt dont le tag est
  `v<version>` (le site lit la dernière Release pour proposer le téléchargement, et l'application s'en sert pour se mettre à jour).
  La Release doit aussi contenir les fichiers Windows (`HaikoRadio-Setup-<version>.exe`, `.exe.blockmap`, `latest.yml`).

## Dépendances

Media3 1.8.0 (lecteur, session média, notification), AndroidX WebKit (service des fichiers), AndroidX Activity/Core.
Android 8.0 (API 26) minimum.

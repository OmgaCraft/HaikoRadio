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
| `HaikoNative.hasVolumeControl()` | `false` : le volume se règle avec les touches du téléphone |
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

**Règle importante** : l'état affiché par la page doit toujours suivre cet état natif. Une pause peut venir de la notification ou
du casque, pas seulement du bouton de la page.

**Attention aux appels** : Android refuse un appel de méthode dont le nombre d'arguments ne correspond pas. Appeler
`HaikoNative.play(mode)`, `HaikoNative.stop()` sans argument. (`stop(undefined)` est toléré, mais mieux vaut ne rien passer.)

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
  lancer `./gradlew exportApk`, puis joindre `android/dist/HaikoRadio-<version>.apk` à une *Release* GitHub du dépôt
  (le site lit la dernière Release pour proposer le téléchargement).

## Dépendances

Media3 1.8.0 (lecteur, session média, notification), AndroidX WebKit (service des fichiers), AndroidX Activity/Core.
Android 8.0 (API 26) minimum.

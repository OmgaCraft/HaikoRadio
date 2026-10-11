# HaikoRadio — Android

Application Android de la radio : une coque qui affiche l'interface commune du dossier `../app` et joue le son avec un lecteur
Android natif (lecture écran éteint, notification, touches du casque).

Documentation complète (pont `window.HaikoNative`, compilation, signature, publication) : [`../docs/android.md`](../docs/android.md).

Commandes rapides, depuis ce dossier :

```bash
./gradlew assembleDebug   # version de test
./gradlew exportApk       # version finale signée -> dist/HaikoRadio-<version>.apk
```

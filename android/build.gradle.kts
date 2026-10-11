plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}

// Les fichiers temporaires de compilation (des milliers de petits fichiers) sont rangés hors du dépôt,
// dans C:\Users\<toi>\.haikoradio\build : dans un dossier synchronisé par OneDrive, ils se retrouvaient verrouillés
// et la compilation échouait par moments. Seul l'APK final (android/dist/) revient dans le dossier du projet.
allprojects {
    layout.buildDirectory.set(
        File(System.getProperty("user.home"), ".haikoradio/build/${rootProject.name}/${project.name}"),
    )
}

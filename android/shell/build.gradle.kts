import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version de l'application : à augmenter à chaque publication (versionCode doit toujours grandir).
// (Les propriétés haikoVersionName / haikoVersionCode, passées en -P à Gradle, servent uniquement aux tests de mise à jour.)
val appVersionName = (findProperty("haikoVersionName") as String?) ?: "0.1.4"
val appVersionCode = (findProperty("haikoVersionCode") as String?)?.toInt() ?: 5

// La clé de signature (qui authentifie les mises à jour) n'est JAMAIS dans le dépôt :
// elle vit dans C:\Users\<toi>\.haikoradio\ (haikoradio-release.jks + keystore.properties). À sauvegarder précieusement.
val keystoreProps = Properties().apply {
    val file = File(System.getProperty("user.home"), ".haikoradio/keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "fr.omgacraft.haikoradio"
    compileSdk = 36

    defaultConfig {
        applicationId = "fr.omgacraft.haikoradio"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (!keystoreProps.isEmpty) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystoreProps.isEmpty) null else signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // L'interface commune (dossier app/ à la racine du dépôt) est copiée telle quelle dans l'application :
    // c'est la même interface que sur PC, il n'y a rien à dupliquer à la main.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("shared-assets"))
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

val syncSharedApp by tasks.registering(Sync::class) {
    from(rootDir.resolve("../app"))
    into(layout.buildDirectory.dir("shared-assets/app"))
}

tasks.named("preBuild") {
    dependsOn(syncSharedApp)
}

// `./gradlew exportApk` : construit la version signée et la copie en android/dist/HaikoRadio-<version>.apk
// (c'est ce fichier qu'on joint à la "Release" GitHub pour que le site le propose en téléchargement).
tasks.register<Copy>("exportApk") {
    dependsOn("assembleRelease")
    from(layout.buildDirectory.dir("outputs/apk/release")) {
        include("*.apk")
        rename { "HaikoRadio-$appVersionName.apk" }
    }
    into(rootDir.resolve("dist"))
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")

    val media3 = "1.8.0"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-session:$media3")
}

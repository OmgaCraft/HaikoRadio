package fr.omgacraft.haikoradio

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Une version plus récente, annoncée par la dernière « Release » du dépôt GitHub. */
data class UpdateInfo(
    val version: String,
    val apkUrl: String,
    val sizeBytes: Long,
    /** Empreinte SHA-256 annoncée par GitHub (si disponible) : sert à vérifier que le fichier est intact. */
    val sha256: String?,
)

class UpdateException(message: String) : Exception(message)

/**
 * Mise à jour de l'application depuis les Releases GitHub :
 *  1. on lit la dernière Release (tag « v0.1.1 », fichier HaikoRadio-0.1.1.apk) ;
 *  2. si elle est plus récente, on télécharge l'APK dans le cache de l'application ;
 *  3. on le contrôle : même nom d'application, version plus récente, et SURTOUT signé avec la même clé que l'application
 *     installée (Android refuserait de toute façon un fichier signé autrement) ;
 *  4. on lance l'installation (Android demande une confirmation, une seule fois).
 * Aucune de ces étapes ne s'exécute sur le thread de l'écran : à appeler depuis un fil d'arrière-plan.
 */
object AppUpdater {
    private const val TAG = "HaikoUpdate"
    const val INSTALL_ACTION = "fr.omgacraft.haikoradio.INSTALL_STATUS"

    fun currentVersion(): String = BuildConfig.VERSION_NAME

    /** "0.1.10" > "0.1.9" : comparaison numérique, partie par partie ("v" initial et suffixes comme "-beta" ignorés). */
    fun isNewer(candidate: String, current: String): Boolean {
        val a = numericParts(candidate)
        val b = numericParts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun numericParts(version: String): List<Int> =
        version.trim().removePrefix("v").removePrefix("V").substringBefore('-').split('.')
            .map { part -> part.takeWhile { it.isDigit() }.toIntOrNull() ?: 0 }

    /** Lit la dernière Release. Renvoie null s'il n'y a rien d'exploitable (pas de fichier .apk, version illisible…). */
    @Throws(Exception::class)
    fun fetchLatest(): UpdateInfo? {
        val override = if (BuildConfig.DEBUG) RadioConfig.releaseUrlOverride else null
        val connection = (URL(override ?: RadioConfig.RELEASE_API_URL).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 10_000
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "HaikoRadio-Android/${BuildConfig.VERSION_NAME}")
        }
        try {
            if (connection.responseCode != 200) throw UpdateException("Réponse ${connection.responseCode} de GitHub")
            val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            if (json.optBoolean("draft") || json.optBoolean("prerelease")) return null

            val version = json.optString("tag_name").removePrefix("v").removePrefix("V")
            if (version.isBlank()) return null

            val assets = json.optJSONArray("assets") ?: return null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                val name = asset.optString("name")
                val url = asset.optString("browser_download_url")
                // Seuls les fichiers publiés par ce dépôt sont acceptés (sauf pour les tests en version debug).
                val trusted = override != null || url.startsWith(RadioConfig.RELEASE_DOWNLOAD_PREFIX)
                if (name.endsWith(".apk", ignoreCase = true) && trusted) {
                    val digest = asset.optString("digest").takeIf { it.startsWith("sha256:") }?.removePrefix("sha256:")
                    return UpdateInfo(version, url, asset.optLong("size", -1), digest)
                }
            }
            return null
        } finally {
            connection.disconnect()
        }
    }

    /** Télécharge l'APK et le vérifie. [isCancelled] permet d'interrompre ; [onProgress] reçoit (octets reçus, total). */
    @Throws(Exception::class)
    fun download(context: Context, info: UpdateInfo, isCancelled: () -> Boolean, onProgress: (Long, Long) -> Unit): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // anciens téléchargements
        val part = File(dir, "HaikoRadio-${info.version}.apk.part")
        val target = File(dir, "HaikoRadio-${info.version}.apk")

        val connection = (URL(info.apkUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "HaikoRadio-Android/${BuildConfig.VERSION_NAME}")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            if (connection.responseCode != 200) throw UpdateException("Téléchargement refusé (code ${connection.responseCode}).")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: info.sizeBytes
            var received = 0L
            connection.inputStream.use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(32 * 1024)
                    while (true) {
                        if (isCancelled()) throw UpdateException("cancelled")
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        received += n
                        onProgress(received, total)
                    }
                }
            }
            if (info.sizeBytes > 0 && part.length() != info.sizeBytes) {
                throw UpdateException("Le fichier téléchargé est incomplet. Réessaie.")
            }
        } catch (e: Exception) {
            part.delete()
            throw e
        } finally {
            connection.disconnect()
        }

        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (info.sha256 != null && !sha.equals(info.sha256, ignoreCase = true)) {
            part.delete()
            throw UpdateException("Le fichier téléchargé est altéré (empreinte différente). Il n'a pas été installé.")
        }
        if (!part.renameTo(target)) throw UpdateException("Impossible d'enregistrer le fichier téléchargé.")
        verifyApk(context, target)
        return target
    }

    /** Contrôles avant installation : c'est bien HaikoRadio, c'est plus récent, et c'est signé avec NOTRE clé. */
    private fun verifyApk(context: Context, file: File) {
        val pm = context.packageManager
        val archive = pm.getPackageArchiveInfo(file.path, signingFlag())
            ?: throw UpdateException("Le fichier téléchargé n'est pas une application valide.")
        if (archive.packageName != context.packageName) throw UpdateException("Le fichier téléchargé n'est pas HaikoRadio.")

        val installed = pm.getPackageInfo(context.packageName, signingFlag())
        if (versionCodeOf(archive) <= versionCodeOf(installed)) throw UpdateException("Ce fichier n'est pas plus récent que ta version.")

        val mine = signers(installed)
        val theirs = signers(archive)
        if (theirs.isEmpty() || mine.isEmpty() || theirs.intersect(mine).isEmpty()) {
            throw UpdateException("Le fichier n'est pas signé par HaikoRadio : installation refusée par sécurité.")
        }
    }

    @Suppress("DEPRECATION")
    private fun signingFlag(): Int =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return signatures.orEmpty().map { s ->
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    /** Lance l'installation. Android affiche sa confirmation ; l'application est ensuite relancée à la main. */
    @Throws(Exception::class)
    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) {
                // Android 12+ : si les conditions sont réunies, la mise à jour se fait sans nouvelle confirmation.
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("HaikoRadio.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val callback = Intent(context, UpdateInstallReceiver::class.java).setAction(INSTALL_ACTION).setPackage(context.packageName)
            // FLAG_MUTABLE est obligatoire : le système y ajoute le résultat de l'installation.
            val pending = PendingIntent.getBroadcast(context, sessionId, callback, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
        }
        Log.i(TAG, "Installation lancée (session $sessionId)")
    }
}

/** Reçoit le résultat de l'installation : ouvre la confirmation d'Android si elle est demandée, signale les échecs. */
class UpdateInstallReceiver : BroadcastReceiver() {
    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                confirm?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i("HaikoUpdate", "Mise à jour installée")
            else -> {
                val reason = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
                Log.w("HaikoUpdate", "Installation non terminée (code $status) : $reason")
                if (status != PackageInstaller.STATUS_FAILURE_ABORTED) { // « annulé » = l'utilisateur a refusé : pas d'erreur à afficher
                    Toast.makeText(context, "La mise à jour n'a pas pu être installée.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}

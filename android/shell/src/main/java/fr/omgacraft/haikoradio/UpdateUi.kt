package fr.omgacraft.haikoradio

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.util.concurrent.Executors

/**
 * Ce que voit l'utilisateur pendant une mise à jour : une proposition au démarrage (au plus toutes les 6 h),
 * une barre de téléchargement, puis la demande d'autorisation et la confirmation d'Android.
 */
class UpdateUi(private val activity: Activity) {

    private val prefs = activity.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()

    @Volatile
    private var cancelled = false
    private var progressDialog: AlertDialog? = null
    private var progressBar: ProgressBar? = null
    private var progressText: TextView? = null

    /** APK déjà téléchargé qui attend que l'utilisateur autorise l'installation dans les réglages d'Android. */
    private var pendingApk: File? = null

    /** Vérification automatique au lancement : au plus une fois toutes les 6 h, pour ne pas solliciter GitHub à chaque ouverture. */
    fun checkOnStart() {
        if (System.currentTimeMillis() - prefs.getLong(KEY_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return
        check(manual = false)
    }

    /**
     * [manual] : demandée par l'utilisateur (on lui répond même s'il n'y a rien de nouveau, et « plus tard » est ignoré).
     * [ignoreSnooze] : tests uniquement.
     */
    fun check(manual: Boolean, ignoreSnooze: Boolean = false) {
        executor.execute {
            val info = try {
                AppUpdater.fetchLatest()
            } catch (e: Exception) {
                Log.w(TAG, "Vérification impossible : ${e.message}")
                null
            }
            val reached = info != null
            if (reached) prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()

            runOnUi {
                val current = AppUpdater.currentVersion()
                when {
                    !reached -> if (manual) toast("Impossible de vérifier les mises à jour pour le moment.")
                    !AppUpdater.isNewer(info!!.version, current) -> if (manual) toast("HaikoRadio est à jour (version $current).")
                    !manual && !ignoreSnooze && isSnoozed(info.version) -> Log.i(TAG, "Version ${info.version} repoussée par l'utilisateur")
                    else -> offer(info)
                }
            }
        }
    }

    /** À appeler quand l'écran revient au premier plan : reprend l'installation si l'utilisateur vient d'accorder l'autorisation. */
    fun onResume() {
        val apk = pendingApk ?: return
        if (activity.packageManager.canRequestPackageInstalls()) {
            pendingApk = null
            installInBackground(apk)
        }
    }

    // ---- Dialogues ----

    private fun offer(info: UpdateInfo) {
        val size = if (info.sizeBytes > 0) " (%.1f Mo)".format(info.sizeBytes / 1_048_576.0) else ""
        AlertDialog.Builder(activity, DIALOG_THEME)
            .setTitle("Mise à jour disponible")
            .setMessage("HaikoRadio ${info.version} est disponible$size.\nTu utilises la version ${AppUpdater.currentVersion()}.")
            .setPositiveButton("Mettre à jour") { _, _ -> download(info) }
            .setNegativeButton("Plus tard") { _, _ -> snooze(info.version) }
            .setOnCancelListener { snooze(info.version) }
            .show()
    }

    private fun download(info: UpdateInfo) {
        cancelled = false
        showProgress()
        executor.execute {
            try {
                val apk = AppUpdater.download(activity, info, { cancelled }) { done, total ->
                    runOnUi { updateProgress(done, total) }
                }
                runOnUi {
                    hideProgress()
                    askInstallPermissionOrInstall(apk)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Téléchargement échoué : ${e.message}")
                runOnUi {
                    hideProgress()
                    if (e.message != "cancelled") toast(e.message?.takeIf { e is UpdateException } ?: "Le téléchargement a échoué. Vérifie ta connexion.")
                }
            }
        }
    }

    private fun askInstallPermissionOrInstall(apk: File) {
        if (activity.packageManager.canRequestPackageInstalls()) {
            installInBackground(apk)
            return
        }
        pendingApk = apk
        AlertDialog.Builder(activity, DIALOG_THEME)
            .setTitle("Autorisation nécessaire")
            .setMessage("Pour installer la mise à jour, Android demande d'autoriser HaikoRadio à installer des applications.\n\nOuvre les réglages, active l'option, puis reviens ici : l'installation reprendra toute seule.")
            .setPositiveButton("Ouvrir les réglages") { _, _ ->
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            }
            .setNegativeButton("Annuler") { _, _ -> pendingApk = null }
            .setOnCancelListener { pendingApk = null }
            .show()
    }

    private fun installInBackground(apk: File) {
        executor.execute {
            try {
                AppUpdater.install(activity, apk)
            } catch (e: Exception) {
                Log.w(TAG, "Installation impossible : ${e.message}")
                runOnUi { toast("La mise à jour n'a pas pu être lancée.") }
            }
        }
    }

    private fun showProgress() {
        val density = activity.resources.displayMetrics.density
        val pad = (20 * density).toInt()
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = true
        }
        val text = TextView(activity).apply {
            text = "Téléchargement…"
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, pad / 2, 0, 0)
        }
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad / 2)
            addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        progressBar = bar
        progressText = text
        progressDialog = AlertDialog.Builder(activity, DIALOG_THEME)
            .setTitle("Mise à jour de HaikoRadio")
            .setView(box)
            .setCancelable(false)
            .setNegativeButton("Annuler") { _, _ -> cancelled = true }
            .show()
    }

    private fun updateProgress(done: Long, total: Long) {
        val bar = progressBar ?: return
        if (total > 0) {
            bar.isIndeterminate = false
            bar.progress = (done * 100 / total).toInt()
            progressText?.text = "Téléchargement… %.1f / %.1f Mo".format(done / 1_048_576.0, total / 1_048_576.0)
        }
    }

    private fun hideProgress() {
        progressDialog?.dismiss()
        progressDialog = null
        progressBar = null
        progressText = null
    }

    // ---- Divers ----

    /** « Plus tard » : on ne redemande pas cette version avant 24 h (une vérification demandée à la main passe outre). */
    private fun snooze(version: String) {
        prefs.edit().putString(KEY_SNOOZED_VERSION, version).putLong(KEY_SNOOZED_AT, System.currentTimeMillis()).apply()
    }

    private fun isSnoozed(version: String): Boolean =
        prefs.getString(KEY_SNOOZED_VERSION, null) == version &&
            System.currentTimeMillis() - prefs.getLong(KEY_SNOOZED_AT, 0) < SNOOZE_MS

    private fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_LONG).show()

    private fun runOnUi(block: () -> Unit) {
        activity.runOnUiThread {
            if (!activity.isFinishing && !activity.isDestroyed) block()
        }
    }

    fun release() {
        hideProgress()
        executor.shutdownNow()
    }

    companion object {
        private const val TAG = "HaikoUpdate"
        private const val DIALOG_THEME = android.R.style.Theme_DeviceDefault_Dialog_Alert
        private const val KEY_LAST_CHECK = "lastCheck"
        private const val KEY_SNOOZED_VERSION = "snoozedVersion"
        private const val KEY_SNOOZED_AT = "snoozedAt"
        private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
        private const val SNOOZE_MS = 24 * 60 * 60 * 1000L
    }
}

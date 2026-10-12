package fr.omgacraft.haikoradio

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Le pont entre la page web (interface commune de app/) et le lecteur Android.
 * La page y accède par `window.HaikoNative` ; elle sait ainsi qu'elle tourne dans l'application Android
 * et doit laisser le lecteur natif jouer le son (au lieu d'une balise <audio> qui s'arrêterait écran éteint).
 *
 * Voir docs/android.md pour le contrat complet.
 */
class HaikoBridge(private val host: Host) {

    interface Host {
        fun play(mode: RadioMode)
        fun stop()
        fun setMode(mode: RadioMode)
        fun stateJson(): String

        /** Volume média du téléphone, de 0 à 100. */
        fun volume(): Int
        fun setVolume(percent: Int)

        /** Cherche une nouvelle version à la demande de l'utilisateur (répond même s'il n'y en a pas). */
        fun checkForUpdate()
    }

    /** Toujours vrai : sert à détecter l'application. */
    @JavascriptInterface
    fun isNative(): Boolean = true

    @JavascriptInterface
    fun platform(): String = "android"

    /** Vrai : la page peut afficher un curseur de volume, qui règle le volume média du téléphone (voir getVolume / setVolume). */
    @JavascriptInterface
    fun hasVolumeControl(): Boolean = true

    /** Volume média actuel du téléphone, de 0 à 100. Suit aussi les touches de volume : voir l'événement `haiko-native-volume`. */
    @JavascriptInterface
    fun getVolume(): Int = host.volume()

    /** Règle le volume média du téléphone (0 à 100). */
    @JavascriptInterface
    fun setVolume(percent: Int) = host.setVolume(percent)

    /** Version installée de l'application, par exemple "0.1.1" (utile pour un écran « À propos »). */
    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    /**
     * Cherche une mise à jour maintenant. L'application la propose elle-même (boîte de dialogue Android) ;
     * la vérification automatique, elle, a lieu au lancement, au plus toutes les 6 h.
     */
    @JavascriptInterface
    fun checkForUpdate() = host.checkForUpdate()

    /** mode : "aac" (qualité standard) ou "hls" (mode économique). */
    @JavascriptInterface
    fun play(mode: String?) = host.play(RadioMode.from(mode))

    @JavascriptInterface
    fun stop() = host.stop()

    /**
     * Tolérance : Android refuse un appel dont le nombre d'arguments ne correspond pas. Si la page appelle
     * `stop(undefined)` (un argument vide), on l'accepte aussi plutôt que de faire échouer l'arrêt.
     */
    @JavascriptInterface
    fun stop(@Suppress("UNUSED_PARAMETER") ignored: String?) = host.stop()

    @JavascriptInterface
    fun setMode(mode: String?) = host.setMode(RadioMode.from(mode))

    /** État actuel, en JSON : {"status","mode","source","fallback","message","playing"}. */
    @JavascriptInterface
    fun getState(): String = host.stateJson()

    /** Tests uniquement (versions debug) : remplace l'adresse du flux direct pour simuler une panne. */
    @JavascriptInterface
    fun debugSetAacUrl(url: String?) {
        if (BuildConfig.DEBUG) {
            RadioConfig.aacUrlOverride = url?.takeIf { it.isNotBlank() }
        }
    }

    companion object {
        /** Nom de l'événement reçu par la page à chaque changement d'état : `window.addEventListener('haiko-native-state', e => e.detail)`. */
        const val EVENT_NAME = "haiko-native-state"

        /** Reçu par la page quand le volume du téléphone change (touches, curseur, autre application) : `e.detail.volume` (0 à 100). */
        const val VOLUME_EVENT_NAME = "haiko-native-volume"

        fun volumeScript(percent: Int): String =
            "window.dispatchEvent(new CustomEvent('$VOLUME_EVENT_NAME',{detail:{volume:$percent}}));"

        fun eventScript(stateJson: String): String {
            // JSONObject(...).toString() garantit un JSON valide, donc un littéral JavaScript valide.
            val safe = JSONObject(stateJson).toString()
            return "window.dispatchEvent(new CustomEvent('$EVENT_NAME',{detail:$safe}));"
        }
    }
}

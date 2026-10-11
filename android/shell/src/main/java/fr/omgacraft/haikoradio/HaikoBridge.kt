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
    }

    /** Toujours vrai : sert à détecter l'application. */
    @JavascriptInterface
    fun isNative(): Boolean = true

    @JavascriptInterface
    fun platform(): String = "android"

    /** Le volume se règle avec les touches du téléphone : la page n'a pas besoin de son propre curseur. */
    @JavascriptInterface
    fun hasVolumeControl(): Boolean = false

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

        fun eventScript(stateJson: String): String {
            // JSONObject(...).toString() garantit un JSON valide, donc un littéral JavaScript valide.
            val safe = JSONObject(stateJson).toString()
            return "window.dispatchEvent(new CustomEvent('$EVENT_NAME',{detail:$safe}));"
        }
    }
}

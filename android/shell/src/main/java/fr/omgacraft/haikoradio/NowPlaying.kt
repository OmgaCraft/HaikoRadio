package fr.omgacraft.haikoradio

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Le morceau en cours, tel que le site le publie (/api/now-playing). */
data class NowPlaying(
    val title: String,
    val artist: String,
    val work: String,
    val album: String,
    val coverUrl: String?,
) {
    /** Ligne principale de la notification : le titre, ou à défaut l'artiste. */
    val displayTitle: String get() = title.ifBlank { artist }

    /** Seconde ligne : l'artiste (sauf s'il sert déjà de titre). */
    val displayArtist: String get() = if (title.isBlank()) "" else artist

    /** Troisième ligne : l'œuvre (anime, jeu…) ou, à défaut, l'album. */
    val displayAlbum: String get() = work.ifBlank { album }
}

/**
 * Interroge le site toutes les 15 s tant que la radio joue, pour mettre à jour la notification
 * (la page web, elle, peut être suspendue quand l'écran est éteint : c'est donc le côté natif qui s'en charge).
 */
class NowPlayingPoller(private val onUpdate: (NowPlaying) -> Unit) {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var future: ScheduledFuture<*>? = null

    fun start() {
        stop()
        future = executor.scheduleWithFixedDelay(::fetch, 0, RadioConfig.NOW_PLAYING_POLL_MS, TimeUnit.MILLISECONDS)
    }

    fun stop() {
        future?.cancel(false)
        future = null
    }

    fun release() {
        stop()
        executor.shutdownNow()
    }

    private fun fetch() {
        try {
            val connection = (URL(RadioConfig.NOW_PLAYING_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 6_000
                readTimeout = 8_000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "HaikoRadio-Android")
            }
            try {
                if (connection.responseCode != 200) return
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                val now = parse(body) ?: return
                main.post { onUpdate(now) }
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Lecture du morceau en cours impossible : ${e.message}")
        }
    }

    companion object {
        private const val TAG = "HaikoNowPlaying"

        fun parse(json: String): NowPlaying? = try {
            val now = JSONObject(json).getJSONObject("now")
            val cover = now.optString("cover", "").takeIf { it.isNotBlank() && it != "null" }
            NowPlaying(
                title = now.optString("title", ""),
                artist = now.optString("artist", ""),
                work = now.optString("work", ""),
                album = now.optString("album", ""),
                // Les pochettes du site sont des chemins relatifs (/cover/xxxx.jpg).
                coverUrl = cover?.let { if (it.startsWith("http")) it else RadioConfig.BASE_URL + it },
            )
        } catch (e: Exception) {
            null
        }
    }
}

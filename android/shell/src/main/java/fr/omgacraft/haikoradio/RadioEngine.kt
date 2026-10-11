package fr.omgacraft.haikoradio

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.util.Log
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.MediaLoadData

/** Les deux réglages de qualité proposés à l'utilisateur. */
enum class RadioMode(val key: String) {
    /** Flux direct 128 kbit/s (avec repli automatique sur le HLS 128 s'il ne répond pas). */
    STANDARD("aac"),

    /** HLS plafonné à 64 kbit/s, pour les réseaux faibles. */
    ECONOMY("hls");

    companion object {
        fun from(key: String?): RadioMode = entries.firstOrNull { it.key == key } ?: STANDARD
    }
}

enum class RadioStatus(val key: String) {
    IDLE("idle"),
    CONNECTING("connecting"),
    BUFFERING("buffering"),
    PLAYING("playing"),
    PAUSED("paused"),
    ERROR("error"),
}

/**
 * Toute la logique de la radio, indépendante de l'écran :
 *  - qualité standard : flux direct, et si le flux direct tombe, bascule automatique sur le HLS 128 kbit/s ;
 *  - mode économique : HLS plafonné à 64 kbit/s ;
 *  - reconnexion automatique quand le réseau coupe ;
 *  - titre / artiste / pochette du morceau en cours dans la notification.
 * Tout se passe sur le thread principal (celui du lecteur).
 */
class RadioEngine(private val exo: ExoPlayer, private val onChanged: (Bundle) -> Unit) {

    var mode = RadioMode.STANDARD
        private set
    var status = RadioStatus.IDLE
        private set
    private var message = ""
    private var usingHls = false
    private var fellBack = false
    private var retries = 0
    private var nowPlaying: NowPlaying? = null

    private val handler = Handler(Looper.getMainLooper())
    private val poller = NowPlayingPoller(::onNowPlaying)
    private val reloadRunnable = Runnable { load() }
    private val releasePausedRunnable = Runnable { stop() }

    /** Le lecteur que voit le système (notification, casque Bluetooth, écran verrouillé). */
    val sessionPlayer: Player = SessionPlayer(exo)

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (status == RadioStatus.IDLE || status == RadioStatus.PAUSED || status == RadioStatus.ERROR) return
            when {
                playbackState == Player.STATE_BUFFERING -> setStatus(RadioStatus.BUFFERING)
                playbackState == Player.STATE_READY && exo.playWhenReady -> markPlaying()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying && status != RadioStatus.IDLE && status != RadioStatus.PAUSED) markPlaying()
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "Erreur de lecture (${error.errorCodeName}) sur ${if (usingHls) "HLS" else "flux direct"}: ${error.message}")
            onStreamFailure(error)
        }
    }

    private val analytics = object : AnalyticsListener {
        override fun onDownstreamFormatChanged(eventTime: AnalyticsListener.EventTime, mediaLoadData: MediaLoadData) {
            val f = mediaLoadData.trackFormat ?: return
            if (f.sampleMimeType?.startsWith("audio") == true || f.codecs?.startsWith("mp4a") == true) {
                Log.i(TAG, "FORMAT audio: bitrate=${f.bitrate} moyen=${f.averageBitrate} crete=${f.peakBitrate} codecs=${f.codecs}")
            }
        }
    }

    init {
        exo.addListener(playerListener)
        exo.addAnalyticsListener(analytics)
    }

    // ---- Commandes ----

    /** Lance (ou relance) la radio en direct, dans la qualité demandée. */
    fun start(requested: RadioMode = mode) {
        mode = requested
        usingHls = mode == RadioMode.ECONOMY
        fellBack = false
        retries = 0
        message = ""
        load()
    }

    /** Change de qualité ; si la radio joue, elle repart tout de suite dans la nouvelle qualité. */
    fun setMode(requested: RadioMode) {
        val playing = status != RadioStatus.IDLE && status != RadioStatus.PAUSED && status != RadioStatus.ERROR
        if (playing) {
            start(requested)
        } else {
            mode = requested
            publish()
        }
    }

    /** Arrêt complet : la notification disparaît. */
    fun stop() {
        handler.removeCallbacks(reloadRunnable)
        handler.removeCallbacks(releasePausedRunnable)
        poller.stop()
        exo.stop()
        exo.clearMediaItems()
        message = ""
        setStatus(RadioStatus.IDLE)
    }

    /** Pause (bouton de la notification) : une radio en direct n'a pas de "reprise", on relancera au direct. */
    fun pause() {
        if (status == RadioStatus.IDLE) return
        handler.removeCallbacks(reloadRunnable)
        poller.stop()
        exo.pause()
        setStatus(RadioStatus.PAUSED)
        // Après 15 min de pause, on libère tout (la notification disparaît).
        handler.postDelayed(releasePausedRunnable, PAUSE_RELEASE_MS)
    }

    /** Lecture demandée depuis la notification / un casque : on se reconnecte au direct si besoin. */
    fun resume() {
        if (status == RadioStatus.PAUSED || status == RadioStatus.ERROR || status == RadioStatus.IDLE) {
            handler.removeCallbacks(releasePausedRunnable)
            retries = 0
            load()
        } else {
            exo.play()
        }
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        poller.release()
        exo.removeListener(playerListener)
        exo.removeAnalyticsListener(analytics)
    }

    // ---- Interne ----

    private fun load() {
        handler.removeCallbacks(reloadRunnable)
        handler.removeCallbacks(releasePausedRunnable)
        setStatus(RadioStatus.CONNECTING)

        // Mode économique : on interdit les variantes au-dessus de 64 kbit/s. Sinon, aucune limite (jusqu'à 128).
        val cap = if (mode == RadioMode.ECONOMY) RadioConfig.ECONOMY_MAX_BITRATE else Int.MAX_VALUE
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon().setMaxAudioBitrate(cap).build()

        exo.setMediaItem(buildItem(if (usingHls) RadioConfig.STREAM_HLS else (RadioConfig.aacUrlOverride ?: RadioConfig.STREAM_AAC)))
        exo.prepare()
        exo.play()
        poller.start()
    }

    private fun buildItem(url: String): MediaItem {
        val builder = MediaItem.Builder().setUri(url).setMediaMetadata(metadata(nowPlaying))
        if (usingHls) builder.setMimeType(MimeTypes.APPLICATION_M3U8)
        return builder.build()
    }

    private fun metadata(now: NowPlaying?): MediaMetadata = MediaMetadata.Builder()
        .setTitle(now?.displayTitle?.ifBlank { null } ?: "HaikoRadio")
        .setArtist(now?.displayArtist?.ifBlank { null } ?: "En direct")
        .setAlbumTitle(now?.displayAlbum?.ifBlank { null } ?: "HaikoRadio")
        .setArtworkUri(now?.coverUrl?.let(Uri::parse))
        .setMediaType(MediaMetadata.MEDIA_TYPE_RADIO_STATION)
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .build()

    /** Nouveau morceau annoncé par le site : on met à jour la notification sans interrompre le son. */
    private fun onNowPlaying(now: NowPlaying) {
        val changed = nowPlaying != now
        nowPlaying = now
        if (!changed || exo.mediaItemCount != 1 || status == RadioStatus.IDLE) return
        val current = exo.currentMediaItem ?: return
        exo.replaceMediaItem(0, current.buildUpon().setMediaMetadata(metadata(now)).build())
    }

    private fun markPlaying() {
        retries = 0
        setStatus(RadioStatus.PLAYING)
    }

    private fun onStreamFailure(error: PlaybackException) {
        if (status == RadioStatus.IDLE || status == RadioStatus.PAUSED) return

        // Flux HLS : parfois le lecteur est "trop en retard" sur le direct, on se recale simplement.
        if (usingHls && error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            exo.seekToDefaultPosition()
            exo.prepare()
            return
        }

        if (!usingHls) {
            // Le flux direct ne répond plus : on bascule sur le HLS 128 kbit/s, sans toucher au choix de l'utilisateur.
            usingHls = true
            fellBack = true
            retries = 0
            message = "Flux direct indisponible : lecture sur le flux de secours."
            Log.i(TAG, "BASCULE vers le flux de secours (HLS)")
            load()
            return
        }

        if (retries < MAX_RETRIES) {
            retries++
            Log.i(TAG, "Nouvelle tentative $retries/$MAX_RETRIES")
            setStatus(RadioStatus.CONNECTING)
            handler.postDelayed(reloadRunnable, RETRY_DELAY_MS * retries)
        } else {
            poller.stop()
            exo.stop()
            message = "La radio est momentanément injoignable. Réessaie dans un instant."
            setStatus(RadioStatus.ERROR)
        }
    }

    private fun setStatus(newStatus: RadioStatus) {
        status = newStatus
        publish()
    }

    private fun publish() {
        onChanged(Bundle().apply {
            putString(KEY_STATUS, status.key)
            putString(KEY_MODE, mode.key)
            putString(KEY_SOURCE, if (usingHls) "hls" else "aac")
            putBoolean(KEY_FALLBACK, fellBack)
            putString(KEY_MESSAGE, message)
        })
    }

    /**
     * Ce que le système (notification, casque) peut faire avec une radio en direct :
     * lecture / pause, sans avance rapide ni piste suivante, et une reprise qui revient au direct.
     */
    private inner class SessionPlayer(player: Player) : ForwardingPlayer(player) {
        override fun play() = resume()

        override fun pause() = this@RadioEngine.pause()

        override fun stop() = this@RadioEngine.stop()

        // Les infos du morceau viennent du site : on ignore le texte brut envoyé dans le flux audio.
        override fun getMediaMetadata(): MediaMetadata = currentMediaItem?.mediaMetadata ?: super.getMediaMetadata()

        override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
            .removeAll(
                COMMAND_SEEK_BACK, COMMAND_SEEK_FORWARD, COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_PREVIOUS,
                COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_SEEK_TO_MEDIA_ITEM, COMMAND_SEEK_TO_DEFAULT_POSITION,
            )
            .build()

        override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)
    }

    companion object {
        private const val TAG = "HaikoEngine"
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 2_000L
        private const val PAUSE_RELEASE_MS = 15 * 60 * 1000L

        // Clés des informations d'état partagées avec l'écran (via les "extras" de la session).
        const val KEY_STATUS = "status"
        const val KEY_MODE = "mode"
        const val KEY_SOURCE = "source"
        const val KEY_FALLBACK = "fallback"
        const val KEY_MESSAGE = "message"
    }
}

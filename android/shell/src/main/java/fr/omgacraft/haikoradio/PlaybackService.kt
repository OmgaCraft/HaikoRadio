package fr.omgacraft.haikoradio

import android.content.Intent
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Service de lecture : c'est lui qui garde la radio vivante quand l'écran s'éteint ou que l'application
 * passe en arrière-plan, et qui affiche la notification (titre, artiste, pochette, bouton pause).
 */
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null
    private lateinit var engine: RadioEngine

    override fun onCreate() {
        super.onCreate()

        val exo = ExoPlayer.Builder(this)
            // Musique : le lecteur se met en pause si un appel arrive, et reprend la main ensuite.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true) // casque débranché -> pause
            .setWakeMode(C.WAKE_MODE_NETWORK) // garde le processeur et le Wi-Fi actifs écran éteint
            .build()

        // Le moteur publie son état dans la session, et l'écran le lit.
        engine = RadioEngine(exo) { extras -> session?.setSessionExtras(extras) }
        session = MediaSession.Builder(this, engine.sessionPlayer)
            .setCallback(SessionCallback())
            .build()

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelName(R.string.notification_channel_name)
                .build()
                .apply { setSmallIcon(R.drawable.ic_notification) },
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Application fermée depuis la liste des applications récentes : on continue si la radio joue, sinon on s'éteint. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val playing = engine.status == RadioStatus.PLAYING ||
            engine.status == RadioStatus.BUFFERING ||
            engine.status == RadioStatus.CONNECTING
        if (!playing) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        engine.release()
        super.onDestroy()
    }

    private inner class SessionCallback : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(SessionCommand(CMD_START, Bundle.EMPTY))
                .add(SessionCommand(CMD_STOP, Bundle.EMPTY))
                .add(SessionCommand(CMD_SET_MODE, Bundle.EMPTY))
                .build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            when (customCommand.customAction) {
                CMD_START -> engine.start(RadioMode.from(args.getString(ARG_MODE)))
                CMD_STOP -> engine.stop()
                CMD_SET_MODE -> engine.setMode(RadioMode.from(args.getString(ARG_MODE)))
                else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
    }

    companion object {
        const val CMD_START = "haiko.start"
        const val CMD_STOP = "haiko.stop"
        const val CMD_SET_MODE = "haiko.setMode"
        const val ARG_MODE = "mode"
    }
}

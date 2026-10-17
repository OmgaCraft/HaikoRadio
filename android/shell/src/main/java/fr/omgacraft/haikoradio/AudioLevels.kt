package fr.omgacraft.haikoradio

import android.os.SystemClock
import androidx.media3.common.C
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Les 7 barres de l'égaliseur suivent le son réellement joué, comme sur le site.
 *
 * Sur le site, le navigateur analyse la balise <audio> (Web Audio). Dans l'application, le son est joué par le lecteur
 * Android : on « écoute » donc les échantillons audio juste avant leur envoi à la carte son, et on refait la même analyse
 * que le navigateur : fenêtre de Blackman sur 1024 échantillons, FFT, lissage 0,5, conversion en décibels (-100 à -30 dB)
 * puis en valeurs de 0 à 255, moyennées sur les 7 mêmes bandes de fréquences (60 Hz à 9,6 kHz).
 *
 * Rien n'est calculé tant que l'écran n'est pas affiché ([enabled]) : aucune batterie dépensée pour rien.
 */
object AudioLevels {
    private const val FFT_SIZE = 1024
    private const val HALF = FFT_SIZE / 2
    private const val HOP_SECONDS = 0.016f // une analyse toutes les 16 ms, comme une image à 60 Hz
    private const val KEEP_MS = 2_000L
    private const val STALE_MS = 400L // plus de nouvelles données depuis 0,4 s : la lecture est arrêtée

    /** Bandes de fréquences, des graves aux aigus (Hz) : les mêmes que sur le site. */
    private val BANDS = arrayOf(
        floatArrayOf(60f, 150f), floatArrayOf(150f, 300f), floatArrayOf(300f, 600f), floatArrayOf(600f, 1200f),
        floatArrayOf(1200f, 2400f), floatArrayOf(2400f, 4800f), floatArrayOf(4800f, 9600f),
    )

    /** À activer seulement quand l'écran est visible. */
    @Volatile
    var enabled = false
        set(value) {
            field = value
            if (!value) synchronized(lock) { resetLocked() }
        }

    /**
     * Retard entre l'instant où un échantillon passe dans notre analyse et celui où il sort du haut-parleur
     * (mémoire tampon de la carte son). Estimé à l'ouverture de la sortie audio, voir [onAudioOutputReady].
     */
    @Volatile
    var outputDelayMs = 150L

    private val lock = Any()
    private var sampleRate = 48_000
    private var channels = 2
    private var encoding = C.ENCODING_PCM_16BIT

    // Derniers échantillons (moyenne des canaux), en cercle.
    private val ring = FloatArray(FFT_SIZE)
    private var ringPos = 0
    private var ringFilled = 0
    private var sinceLastAnalysis = 0

    private val window = FloatArray(FFT_SIZE) { n ->
        // Fenêtre de Blackman (alpha 0,16), celle de l'analyseur Web Audio.
        val a = 0.16f
        val a0 = (1 - a) / 2
        val a1 = 0.5f
        val a2 = a / 2
        (a0 - a1 * cos(2 * PI * n / FFT_SIZE) + a2 * cos(4 * PI * n / FFT_SIZE)).toFloat()
    }
    private val re = FloatArray(FFT_SIZE)
    private val im = FloatArray(FFT_SIZE)
    private val smoothed = FloatArray(HALF)

    private class Frame(val timeMs: Long, val bands: FloatArray)

    private val frames = ArrayDeque<Frame>()

    /** Branché dans le lecteur : reçoit les échantillons audio à chaque envoi à la carte son. */
    val sink = object : TeeAudioProcessor.AudioBufferSink {
        override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
            synchronized(lock) {
                sampleRate = sampleRateHz
                channels = max(1, channelCount)
                this@AudioLevels.encoding = encoding
                resetLocked()
            }
        }

        override fun handleBuffer(buffer: ByteBuffer) {
            if (!enabled) return
            val arrival = SystemClock.elapsedRealtime()
            val data = buffer.asReadOnlyBuffer().order(ByteOrder.nativeOrder())
            synchronized(lock) { processLocked(data, arrival) }
        }
    }

    /** Appelé à l'ouverture de la sortie audio : la mémoire tampon donne le retard entre l'analyse et le son entendu. */
    fun onAudioOutputReady(bufferDurationMs: Long) {
        // En régime normal la mémoire tampon est pleine : un échantillon sort du haut-parleur environ une mémoire tampon plus tard.
        outputDelayMs = (bufferDurationMs + 20).coerceIn(40, 600)
    }

    /** Les 7 niveaux (0 à 1) à afficher maintenant, ou null si rien ne joue. */
    fun bandsNow(): FloatArray? {
        val displayTime = SystemClock.elapsedRealtime() - outputDelayMs
        synchronized(lock) {
            var found: Frame? = null
            for (f in frames) {
                if (f.timeMs <= displayTime) found = f else break
            }
            val newest = frames.lastOrNull() ?: return null
            if (SystemClock.elapsedRealtime() - newest.timeMs > STALE_MS + outputDelayMs) return null
            return found?.bands
        }
    }

    private fun resetLocked() {
        ringPos = 0
        ringFilled = 0
        sinceLastAnalysis = 0
        smoothed.fill(0f)
        frames.clear()
    }

    private fun processLocked(data: ByteBuffer, arrivalMs: Long) {
        val hop = (sampleRate * HOP_SECONDS).roundToInt().coerceAtLeast(256)
        val float = encoding == C.ENCODING_PCM_FLOAT
        if (!float && encoding != C.ENCODING_PCM_16BIT) return // autre format : pas d'analyse (l'animation décorative reste)

        val bytesPerSample = if (float) 4 else 2
        val frameCount = data.remaining() / (bytesPerSample * channels)
        val start = data.position()
        for (i in 0 until frameCount) {
            var sum = 0f
            for (c in 0 until channels) {
                val index = start + (i * channels + c) * bytesPerSample
                sum += if (float) data.getFloat(index) else data.getShort(index) / 32768f
            }
            ring[ringPos] = sum / channels
            ringPos = (ringPos + 1) % FFT_SIZE
            if (ringFilled < FFT_SIZE) ringFilled++
            if (++sinceLastAnalysis >= hop && ringFilled == FFT_SIZE) {
                sinceLastAnalysis = 0
                // Les analyses d'un même envoi sont étalées sur sa durée, pas empilées à son arrivée.
                val time = arrivalMs + (i * 1000L) / sampleRate
                frames.addLast(Frame(time, analyseLocked()))
            }
        }
        val limit = arrivalMs - KEEP_MS
        while (frames.isNotEmpty() && frames.first().timeMs < limit) frames.removeFirst()
    }

    /** FFT des 1024 derniers échantillons -> 7 niveaux de 0 à 1 (même calcul que l'analyseur du navigateur). */
    private fun analyseLocked(): FloatArray {
        for (n in 0 until FFT_SIZE) {
            re[n] = ring[(ringPos + n) % FFT_SIZE] * window[n]
            im[n] = 0f
        }
        fft(re, im)

        val bytes = IntArray(HALF)
        for (k in 0 until HALF) {
            val magnitude = sqrt(re[k] * re[k] + im[k] * im[k]) / FFT_SIZE
            smoothed[k] = 0.5f * smoothed[k] + 0.5f * magnitude // lissage 0,5, comme l'analyseur du navigateur
            val db = if (smoothed[k] > 0f) 20f * log10(smoothed[k]) else -200f
            bytes[k] = ((db + 100f) / 70f * 255f).roundToInt().coerceIn(0, 255)
        }

        val binHz = sampleRate.toFloat() / FFT_SIZE
        return FloatArray(BANDS.size) { b ->
            val i0 = max(1, (BANDS[b][0] / binHz).toInt())
            val i1 = max(i0 + 1, kotlin.math.ceil(BANDS[b][1] / binHz).toInt())
            var sum = 0
            for (i in i0 until minOf(i1, HALF)) sum += bytes[i]
            sum / ((i1 - i0) * 255f)
        }
    }

    /** FFT classique (Cooley-Tukey, en place) sur FFT_SIZE points. */
    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = FFT_SIZE
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val angle = -2 * PI / len
            val wr = cos(angle).toFloat()
            val wi = sin(angle).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f
                var ci = 0f
                for (k in 0 until len / 2) {
                    val a = i + k
                    val b = i + k + len / 2
                    val xr = real[b] * cr - imag[b] * ci
                    val xi = real[b] * ci + imag[b] * cr
                    real[b] = real[a] - xr
                    imag[b] = imag[a] - xi
                    real[a] += xr
                    imag[a] += xi
                    val ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                i += len
            }
            len = len shl 1
        }
    }
}

package fr.omgacraft.haikoradio

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import androidx.webkit.WebViewAssetLoader
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Écran unique : affiche l'interface commune (dossier app/ du dépôt, copié dans l'application)
 * et la relie au lecteur Android par le pont `window.HaikoNative`.
 */
class MainActivity : ComponentActivity(), HaikoBridge.Host {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var lastExtras: Bundle = Bundle.EMPTY
    private var notificationPermissionAsked = false

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* sans la permission, la radio joue quand même, juste sans notification */ }

    private lateinit var updateUi: UpdateUi

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/__dev/", AssetFolder("dev/")) // page de test (versions debug uniquement)
            .addPathHandler("/", AssetFolder("app/"))       // l'interface commune, servie comme sur un vrai site
            .build()

        webView = WebView(this).also { configure(it) }
        val root = FrameLayout(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // Laisse la place à la barre d'état et à la barre de navigation (Android 15 impose l'affichage bord à bord).
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed() // ferme l'écran ; la radio, elle, continue
                }
            }
        })

        connectToPlayer()
        webView.loadUrl(startUrl(intent))

        updateUi = UpdateUi(this)
        if (!debugUpdateCheck(intent)) updateUi.checkOnStart()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (BuildConfig.DEBUG && intent.hasExtra(EXTRA_DEV_PATH)) {
            webView.loadUrl(startUrl(intent))
        }
        debugUpdateCheck(intent)
    }

    /** Versions debug : `--es release_url http://10.0.2.2:8099/latest.json` teste la mise à jour avec un faux serveur de versions. */
    private fun debugUpdateCheck(intent: Intent): Boolean {
        val url = if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_RELEASE_URL) else null
        if (url == null) return false
        RadioConfig.releaseUrlOverride = url
        updateUi.check(manual = false, ignoreSnooze = true)
        return true
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        emitState()
        emitVolume()
        updateUi.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        updateUi.release()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        webView.removeJavascriptInterface("HaikoNative")
        webView.destroy()
        super.onDestroy()
    }

    // ---- WebView ----

    private fun configure(view: WebView) {
        view.setBackgroundColor(BACKGROUND)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // mémorise le thème et les réglages de l'interface
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view.addJavascriptInterface(HaikoBridge(this), "HaikoNative")

        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.i("HaikoWeb", "${message.message()}  [${message.sourceId().substringAfterLast('/')}:${message.lineNumber()}]")
                return true
            }
        }

        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.host == APP_HOST) {
                    return assetLoader.shouldInterceptRequest(uri)
                        ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
                }
                return proxyRadioApi(request)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                // Tout lien vers l'extérieur s'ouvre dans le navigateur, jamais dans l'application.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: Exception) {
                    Log.w(TAG, "Impossible d'ouvrir ${request.url}")
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                emitState()
                emitVolume()
            }
        }
    }

    /**
     * L'interface est servie depuis appassets.androidplatform.net, donc ses appels vers radio.omgacraft.fr/api/…
     * sont "d'un autre site". Le serveur n'autorise pas ça (CORS) : on relaie l'appel depuis l'application,
     * qui y ajoute l'autorisation. Aucun changement n'est nécessaire sur le serveur.
     */
    private fun proxyRadioApi(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.scheme != "https" || uri.host != RADIO_HOST || request.method != "GET" ||
            uri.path?.startsWith("/api/") != true
        ) return null
        return try {
            val connection = (URL(uri.toString()).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8_000
                readTimeout = 12_000
                setRequestProperty("Accept", request.requestHeaders["Accept"] ?: "application/json")
                setRequestProperty("User-Agent", "HaikoRadio-Android")
            }
            val code = connection.responseCode
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val mime = connection.contentType?.substringBefore(';')?.trim() ?: "application/json"
            WebResourceResponse(
                mime, "utf-8", code, connection.responseMessage?.ifBlank { null } ?: "OK",
                mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store"),
                stream,
            )
        } catch (e: Exception) {
            Log.w(TAG, "Appel ${uri} impossible : ${e.message}")
            WebResourceResponse("application/json", "utf-8", 503, "Service Unavailable",
                mapOf("Access-Control-Allow-Origin" to "*"), "{\"error\":\"unavailable\"}".byteInputStream())
        }
    }

    /** Sert les fichiers du dossier d'assets [prefix] comme s'ils étaient à la racine du site. */
    private inner class AssetFolder(private val prefix: String) : WebViewAssetLoader.PathHandler {
        private val delegate = WebViewAssetLoader.AssetsPathHandler(this@MainActivity)
        override fun handle(path: String): WebResourceResponse? = delegate.handle(prefix + path.ifEmpty { "index.html" })
    }

    private fun startUrl(intent: Intent?): String {
        val devPath = if (BuildConfig.DEBUG) intent?.getStringExtra(EXTRA_DEV_PATH) else null
        if (devPath != null) return "https://$APP_HOST/__dev/$devPath"

        val hasApp = assets.list("app")?.contains("index.html") == true
        if (hasApp) return "https://$APP_HOST/index.html"
        // L'interface commune n'est pas encore là : en debug, on montre la page de test du pont.
        return if (BuildConfig.DEBUG) "https://$APP_HOST/__dev/bridge-test.html" else "https://$APP_HOST/__missing"
    }

    // ---- Lecteur (service de lecture) ----

    private fun connectToPlayer() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token)
            .setListener(object : MediaController.Listener {
                override fun onExtrasChanged(controller: MediaController, extras: Bundle) {
                    lastExtras = extras
                    emitState()
                }
            })
            .buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                lastExtras = future.get().sessionExtras
                emitState()
            } catch (e: Exception) {
                Log.w(TAG, "Connexion au lecteur impossible : ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun withController(block: (MediaController) -> Unit) {
        val future = controllerFuture ?: return
        future.addListener({
            try {
                block(future.get())
            } catch (e: Exception) {
                Log.w(TAG, "Commande impossible : ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun command(action: String, mode: RadioMode? = null) = withController { controller ->
        val args = Bundle().apply { mode?.let { putString(PlaybackService.ARG_MODE, it.key) } }
        controller.sendCustomCommand(SessionCommand(action, Bundle.EMPTY), args)
    }

    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT >= 33 && !notificationPermissionAsked &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionAsked = true
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // ---- HaikoBridge.Host (appelé depuis la page, sur un autre thread) ----

    override fun play(mode: RadioMode) {
        runOnUiThread {
            askNotificationPermissionOnce()
            command(PlaybackService.CMD_START, mode)
        }
    }

    override fun stop() {
        runOnUiThread { command(PlaybackService.CMD_STOP) }
    }

    override fun setMode(mode: RadioMode) {
        runOnUiThread { command(PlaybackService.CMD_SET_MODE, mode) }
    }

    override fun stateJson(): String {
        val status = lastExtras.getString(RadioEngine.KEY_STATUS) ?: RadioStatus.IDLE.key
        return JSONObject().apply {
            put("status", status)
            put("mode", lastExtras.getString(RadioEngine.KEY_MODE) ?: RadioMode.STANDARD.key)
            put("source", lastExtras.getString(RadioEngine.KEY_SOURCE) ?: "aac")
            put("fallback", lastExtras.getBoolean(RadioEngine.KEY_FALLBACK, false))
            put("message", lastExtras.getString(RadioEngine.KEY_MESSAGE) ?: "")
            put("playing", status == RadioStatus.PLAYING.key)
            put("active", status == RadioStatus.CONNECTING.key || status == RadioStatus.BUFFERING.key || status == RadioStatus.PLAYING.key)
        }.toString()
    }

    /** Volume de l'application (0 à 100), mémorisé. Il est indépendant du volume du téléphone : les touches du téléphone n'y touchent pas. */
    override fun volume(): Int = AppVolume.get(this)

    override fun setVolume(percent: Int) {
        val clamped = percent.coerceIn(0, 100)
        AppVolume.set(this, clamped) // mémorisé tout de suite : le service le relira s'il redémarre
        runOnUiThread {
            withController { controller ->
                val args = Bundle().apply { putInt(PlaybackService.ARG_PERCENT, clamped) }
                controller.sendCustomCommand(SessionCommand(PlaybackService.CMD_SET_VOLUME, Bundle.EMPTY), args)
            }
            emitVolume()
        }
    }

    override fun checkForUpdate() {
        runOnUiThread { updateUi.check(manual = true) }
    }

    private fun emitVolume() {
        if (!::webView.isInitialized) return
        val percent = volume()
        runOnUiThread { webView.evaluateJavascript(HaikoBridge.volumeScript(percent), null) }
    }

    private fun emitState() {
        if (!::webView.isInitialized) return
        runOnUiThread { webView.evaluateJavascript(HaikoBridge.eventScript(stateJson()), null) }
    }

    companion object {
        private const val TAG = "HaikoMain"
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val RADIO_HOST = "radio.omgacraft.fr"
        private const val BACKGROUND = 0xFF0A0C11.toInt()

        /** Versions debug : adresse de la page de test à ouvrir (ex. `bridge-test.html?auto=1`). */
        const val EXTRA_DEV_PATH = "dev_path"

        /** Versions debug : adresse d'un faux serveur de versions, pour tester la mise à jour. */
        const val EXTRA_RELEASE_URL = "release_url"
    }
}

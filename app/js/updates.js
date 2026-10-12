/*
 * Mises à jour de l'application Windows : bandeau d'information et bouton « Rechercher une mise à jour ».
 * Rien ne se passe ailleurs (Android, navigateur) : ces fonctions n'existent que dans l'application Windows.
 * La logique (recherche, téléchargement, installation) est dans desktop/updater.js.
 */
(function () {
    var native = window.haikoNative;
    if (!native || !native.onUpdateState) { return; }

    var banner = document.getElementById('update-banner');
    var text = document.getElementById('update-text');
    var installBtn = document.getElementById('update-install');
    var checkBtn = document.getElementById('update-check');
    var hideTimer = 0;

    function show(message, withInstall) {
        clearTimeout(hideTimer);
        text.textContent = message;
        installBtn.hidden = !withInstall;
        banner.hidden = false;
    }

    function hide(afterMs) {
        clearTimeout(hideTimer);
        if (!afterMs) { banner.hidden = true; return; }
        hideTimer = setTimeout(function () { banner.hidden = true; }, afterMs);
    }

    function render(s) {
        if (!s) { return; }
        // Le bouton n'a de sens que si la recherche est possible (pas en version de développement).
        checkBtn.hidden = s.status === 'disabled';
        checkBtn.disabled = s.status === 'checking' || s.status === 'downloading' || s.status === 'ready';

        switch (s.status) {
            case 'checking':
                if (s.manual) { show('Recherche d\'une mise à jour…', false); } else { hide(); }
                break;
            case 'downloading':
                show('Mise à jour ' + s.version + ' : téléchargement… ' + s.percent + ' % (la radio continue de jouer)', false);
                break;
            case 'ready':
                show('La version ' + s.version + ' est prête.', true);
                break;
            case 'none':
                if (s.manual) { show('Vous avez déjà la dernière version.', false); hide(4000); } else { hide(); }
                break;
            case 'error':
                if (s.manual) { show(s.message || 'Impossible de vérifier les mises à jour pour le moment.', false); hide(6000); } else { hide(); }
                break;
            default:
                hide();
        }
    }

    installBtn.addEventListener('click', function () {
        installBtn.disabled = true;
        text.textContent = 'Installation en cours, l\'application va redémarrer…';
        native.installUpdate();
    });

    checkBtn.addEventListener('click', function () { native.checkForUpdates(); });

    native.onUpdateState(render);
    native.getUpdateState().then(render).catch(function () {});
})();

// ===== Application Android (début) =====
// Android : la recherche, le téléchargement et l'installation sont gérés par l'application elle-même (boîtes de dialogue
// d'Android) : la page affiche seulement la version et le bouton « Rechercher une mise à jour ». Le bandeau reste masqué.
// Ce bloc ne s'active que si le pont Android window.HaikoNative (avec un H majuscule) existe ; il ne touche pas au
// pont Windows window.haikoNative. Contrat : docs/android.md.
(function () {
    var bridge = window.HaikoNative;
    var isAndroid = false;
    try { isAndroid = !!(bridge && bridge.isNative && bridge.isNative()); } catch (e) {}
    if (!isAndroid) { return; }

    var versionEl = document.getElementById('app-version');
    var checkBtn = document.getElementById('update-check');

    try {
        if (versionEl && bridge.appVersion) { versionEl.textContent = 'Application v' + bridge.appVersion(); }
    } catch (e) {}

    if (checkBtn && bridge.checkForUpdate) {
        checkBtn.hidden = false;
        // Pas d'argument : Android refuse un appel dont le nombre d'arguments ne correspond pas.
        checkBtn.addEventListener('click', function () {
            try { bridge.checkForUpdate(); } catch (e) {}
        });
    }
})();
// ===== Application Android (fin) =====

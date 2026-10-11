/* Chef d'orchestre : navigation entre les pages, titre de la fenêtre, liens avec l'application Windows. */
(function () {
    var native = window.haikoNative || null;
    var views = {};
    document.querySelectorAll('[data-view]').forEach(function (v) { views[v.dataset.view] = v; });

    // ---------- Navigation Radio / Planning ----------

    function show(name) {
        if (!views[name]) { name = 'radio'; }
        Object.keys(views).forEach(function (key) { views[key].hidden = key !== name; });
        document.querySelectorAll('.topbar .nav-link').forEach(function (link) {
            link.classList.toggle('active', link.dataset.viewLink === name);
        });
        try { history.replaceState(null, '', '#' + name); } catch (e) {}
        window.scrollTo(0, 0);
    }

    document.querySelectorAll('[data-view-link]').forEach(function (link) {
        link.addEventListener('click', function (event) {
            event.preventDefault();
            show(link.dataset.viewLink);
        });
    });

    show((location.hash || '').replace('#', ''));

    // ---------- Pied de page ----------

    document.getElementById('year').textContent = String(new Date().getFullYear());
    if (native && native.getVersion) {
        native.getVersion().then(function (v) {
            if (v) { document.getElementById('app-version').textContent = 'Application v' + v; }
        }).catch(function () {});
    }

    // ---------- Titre de la fenêtre (visible dans la barre des tâches) ----------

    function trackLabel() {
        var data = Haiko.nowplaying.current;
        var now = data && data.now;
        if (!now || (now.title === '' && now.artist === '')) { return ''; }
        return now.title && now.artist ? now.title + ' — ' + now.artist : (now.title || now.artist);
    }

    function refreshTitle() {
        var playing = Haiko.player.isPlaying();
        var label = trackLabel();
        document.title = playing && label ? '♪ ' + label + ' · HaikoRadio' : 'HaikoRadio';
        if (native && native.setState) { native.setState({ playing: playing, track: label }); }
    }

    Haiko.player.onChange(refreshTitle);
    Haiko.nowplaying.onChange(refreshTitle);

    // ---------- Commandes venues de l'application Windows (icône de la zone de notification) ----------

    if (native && native.onTogglePlay) {
        native.onTogglePlay(function () { Haiko.player.toggle(); });
    }

    // ---------- Démarrage ----------

    Haiko.nowplaying.start();
    Haiko.planning.init();
    refreshTitle();
})();

/*
 * Accès réseau vers le site de la radio.
 * Dans l'application Windows, la requête passe par le programme principal (aucune restriction du navigateur).
 * Ailleurs (Android, test dans un navigateur), on utilise fetch() directement.
 */
(function () {
    function getJson(url) {
        if (window.haikoNative && window.haikoNative.getJson) {
            return window.haikoNative.getJson(url);
        }
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.json();
        });
    }

    // Les pochettes sont données par le site en chemin relatif ("/cover/abc.jpg").
    function siteAsset(path) {
        if (!path) { return null; }
        return /^https?:\/\//i.test(path) ? path : window.HAIKO.siteUrl + path;
    }

    window.Haiko = window.Haiko || {};
    window.Haiko.getJson = getJson;
    window.Haiko.siteAsset = siteAsset;
})();

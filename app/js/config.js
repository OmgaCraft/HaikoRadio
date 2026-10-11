/* Réglages de l'application. Le reste du code les lit ici : un seul endroit à modifier. */
window.HAIKO = {
    // Le site de la radio : source du morceau en cours, des pochettes et (si disponible) du planning.
    siteUrl: 'https://radio.omgacraft.fr',

    // Les deux flux de la radio (hébergés par Infomaniak).
    streams: {
        aac: 'https://haikoradio.ice.infomaniak.ch/haikoradio-autodj-128.aac',
        hls: 'https://haikoradio.radiohls.infomaniak.com/haikoradio/manifest.m3u8'
    },

    // Mode économique : on choisit la meilleure variante HLS sous ce débit (64 kbit/s + marge).
    ecoMaxBandwidth: 70400,

    // Rafraîchissement du morceau en cours.
    pollMs: 15000
};

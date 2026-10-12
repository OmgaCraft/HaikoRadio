package fr.omgacraft.haikoradio

/** Adresses de la radio. Ce sont les mêmes que sur le site radio.omgacraft.fr. */
object RadioConfig {
    const val BASE_URL = "https://radio.omgacraft.fr"

    /** Titre, artiste, œuvre, pochette du morceau en cours + historique (fourni par le site). */
    const val NOW_PLAYING_URL = "$BASE_URL/api/now-playing"

    /** Flux direct 128 kbit/s : la qualité standard. */
    const val STREAM_AAC = "https://haikoradio.ice.infomaniak.ch/haikoradio-autodj-128.aac"

    /** Flux HLS (32 / 64 / 128 kbit/s) : le mode économique, et le secours du flux direct. */
    const val STREAM_HLS = "https://haikoradio.radiohls.infomaniak.com/haikoradio/manifest.m3u8"

    /** Plafond du mode économique : la variante 64 kbit/s est annoncée à 70 400 bit/s dans le manifeste HLS. */
    const val ECONOMY_MAX_BITRATE = 70_400

    const val NOW_PLAYING_POLL_MS = 15_000L

    /** Dépôt GitHub qui publie les versions : la dernière « Release » est celle que l'application propose d'installer. */
    const val GITHUB_REPO = "OmgaCraft/HaikoRadio"
    const val RELEASE_API_URL = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"

    /** Les fichiers de mise à jour ne sont acceptés que s'ils viennent de ce dépôt. */
    const val RELEASE_DOWNLOAD_PREFIX = "https://github.com/$GITHUB_REPO/releases/download/"

    /** Uniquement pour les tests (versions debug) : remplace l'adresse du flux direct, par exemple par une adresse cassée. */
    @Volatile
    var aacUrlOverride: String? = null

    /** Uniquement pour les tests (versions debug) : remplace l'adresse qui annonce la dernière version. */
    @Volatile
    var releaseUrlOverride: String? = null
}

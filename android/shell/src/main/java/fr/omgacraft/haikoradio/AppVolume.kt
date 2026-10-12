package fr.omgacraft.haikoradio

import android.content.Context

/**
 * Le volume de l'application (le curseur de la page), réglé SEPAREMENT du volume du téléphone :
 * le son final est « volume de l'application × volume du téléphone ». Les touches de volume du téléphone
 * ne changent que le second, le curseur de la page que le premier.
 * Il est mémorisé : on le retrouve à la réouverture, même après l'arrêt complet de l'application.
 */
object AppVolume {
    private const val PREFS = "player"
    private const val KEY = "volume"
    const val DEFAULT_PERCENT = 100

    fun get(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY, DEFAULT_PERCENT).coerceIn(0, 100)

    fun set(context: Context, percent: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY, percent.coerceIn(0, 100)).apply()
    }

    /**
     * Gain appliqué au lecteur (0,0 à 1,0). L'oreille perçoit le volume de façon logarithmique : avec un gain
     * proportionnel au curseur, la moitié du curseur sonnerait presque aussi fort que le maximum. Le carré donne
     * une progression beaucoup plus naturelle (50 % du curseur ≈ un quart de l'amplitude).
     */
    fun gain(percent: Int): Float {
        val x = percent.coerceIn(0, 100) / 100f
        return x * x
    }
}

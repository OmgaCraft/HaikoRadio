'use strict';

/*
 * Pont entre l'interface et le programme principal.
 * L'interface ne reçoit que ces quatre fonctions, pas d'accès au système.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('haikoNative', {
    // Lit un JSON sur le site de la radio (le programme principal refuse toute autre adresse).
    getJson: (url) => ipcRenderer.invoke('net:get-json', url).then((res) => {
        if (!res || !res.ok) { throw new Error('HTTP ' + (res && res.status)); }
        return res.data;
    }),

    // Informe l'icône de la zone de notification : lecture en cours ou non, et titre du morceau.
    setState: (state) => ipcRenderer.send('player:state', {
        playing: !!(state && state.playing),
        track: String((state && state.track) || '')
    }),

    // Lecture / pause demandée depuis le menu de l'icône.
    onTogglePlay: (callback) => ipcRenderer.on('toggle-play', () => callback()),

    getVersion: () => ipcRenderer.invoke('app:version')
});

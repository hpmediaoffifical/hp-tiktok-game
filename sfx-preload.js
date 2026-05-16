/* Preload cho cửa sổ SoundFX — cầu nối an toàn renderer ↔ Electron main.
 * Chỉ expose đúng các hàm cần: always-on-top, đóng cửa sổ, lấy/đặt bounds. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sfxNative', {
    setAlwaysOnTop: (on) => ipcRenderer.send('sfx:setAlwaysOnTop', !!on),
    closeWindow: () => ipcRenderer.send('sfx:close'),
    getBounds: () => ipcRenderer.sendSync('sfx:getBounds'),
    setBounds: (b) => ipcRenderer.send('sfx:setBounds', b || {})
});

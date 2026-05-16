/* Preload cho cửa sổ SoundFX — cầu nối an toàn renderer ↔ Electron main. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sfxNative', {
    setAlwaysOnTop: (on) => ipcRenderer.send('sfx:setAlwaysOnTop', !!on),
    closeWindow: () => ipcRenderer.send('sfx:close'),
    getBounds: () => ipcRenderer.sendSync('sfx:getBounds'),
    setBounds: (b) => ipcRenderer.send('sfx:setBounds', b || {}),
    // Chọn file audio từ máy → trả { path, name } hoặc null
    pickAudioFile: () => ipcRenderer.invoke('sfx:pickAudio'),
    // Đăng ký phím tắt TOÀN CỤC (hoạt động mọi nơi). list = [{accel, soundId}], play/stop = accel string
    registerHotkeys: (payload) => ipcRenderer.send('sfx:registerHotkeys', payload || {}),
    onHotkey: (cb) => {
        ipcRenderer.removeAllListeners('sfx:hotkeyFired');
        ipcRenderer.on('sfx:hotkeyFired', (_e, data) => { try { cb(data); } catch (_) {} });
    }
});

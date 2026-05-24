// Preload cho cửa sổ Caro Overlay Review (transparent + frameless).
// Expose IPC tối thiểu qua contextBridge — renderer giữ contextIsolation:true để
// vẫn an toàn khi cùng overlay.html được OBS Browser Source load (overlay.html
// trong OBS không có preload → window.hpCaroPreview === undefined, code đã guard).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hpCaroPreview', {
    setAlwaysOnTop: (on) => ipcRenderer.send('caro-preview:setAlwaysOnTop', !!on),
    close: () => ipcRenderer.send('caro-preview:close')
});

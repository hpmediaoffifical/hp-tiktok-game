/* Preload cho cửa sổ Khởi động nhanh — bridge renderer ↔ Electron main IPC. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hpQuickLaunch', {
    setAlwaysOnTop: (on) => ipcRenderer.send('quick-launch:setAlwaysOnTop', !!on),
    close: () => ipcRenderer.send('quick-launch:close'),
    // Main process bắn 'quick-launch:initPin' với giá trị Pin đã lưu khi mở cửa sổ →
    // renderer dùng để sync UI nút 📌 đúng trạng thái persist.
    onInitPin: (cb) => {
        ipcRenderer.removeAllListeners('quick-launch:initPin');
        ipcRenderer.on('quick-launch:initPin', (_e, on) => { try { cb(!!on); } catch (_) {} });
    }
});

/* Preload cho cửa sổ Khởi động nhanh — bridge renderer ↔ Electron main IPC. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hpQuickLaunch', {
    setAlwaysOnTop: (on) => ipcRenderer.send('quick-launch:setAlwaysOnTop', !!on),
    setSize: (w, h) => ipcRenderer.send('quick-launch:setSize', { w, h }),
    setLayout: (mode) => ipcRenderer.send('quick-launch:setLayout', mode),
    onInitLayout: (cb) => {
        ipcRenderer.removeAllListeners('quick-launch:initLayout');
        ipcRenderer.on('quick-launch:initLayout', (_e, mode) => { try { cb(mode); } catch (_) {} });
    },
    close: () => ipcRenderer.send('quick-launch:close'),
    // Main process bắn 'quick-launch:initPin' với giá trị Pin đã lưu khi mở cửa sổ →
    // renderer dùng để sync UI nút 📌 đúng trạng thái persist.
    onInitPin: (cb) => {
        ipcRenderer.removeAllListeners('quick-launch:initPin');
        ipcRenderer.on('quick-launch:initPin', (_e, on) => { try { cb(!!on); } catch (_) {} });
    }
});

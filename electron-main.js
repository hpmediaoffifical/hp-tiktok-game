/*
 * HP Action LIVE — Electron Desktop Wrapper
 * Khởi động server Express + mở cửa sổ Chromium tới http://localhost:PORT
 */
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const APP_URL = `http://localhost:${PORT}`;
const APP_NAME = 'HP Action LIVE';

let mainWindow = null;
let splashWindow = null;
let soundfxWindow = null;
let tray = null;
let serverStarted = false;
let isQuitting = false;

// ============================================================
// PROCESS HYGIENE — Đảm bảo MỌI electron.exe terminate sạch
// ============================================================
// Architecture insight: OBS overlay tự động ẩn (trống/trong suốt) khi socket disconnect.
// Socket chỉ disconnect khi server process (main electron) chết. Nếu helper processes
// (GPU, Crashpad, NetworkService, Utility...) lingering → server vẫn chạy → socket vẫn live
// → OBS không tự ẩn được. Vì vậy MỌI process phải terminate khi user đóng app.
//
// Nghiên cứu Electron + Chromium docs:
//  1. GPU process: tắt bằng disableHardwareAcceleration + --disable-gpu*
//  2. Crashpad handler: --disable-features=Crashpad
//  3. Network service utility: chỉ exit khi main process exit (handled by app.exit(0))
//  4. Renderer processes: BrowserWindow.destroy() kill renderer
//  5. Hard fallback: taskkill /F /T /PID <main> kill cả tree con cháu (Windows)
// ============================================================
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
// Tắt Crashpad handler process (giảm bớt 1 helper process)
app.commandLine.appendSwitch('disable-features', 'Crashpad,DialMediaRouteProvider');
// Giảm renderer code integrity check → renderer thoát nhanh hơn
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// === Single-instance lock ===
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

app.setName(APP_NAME);
app.setAppUserModelId('com.hpmedia.actionlive');

app.on('second-instance', () => {
    if (mainWindow) {
        // Re-launch khi app đang ở tray → mở lại window (restore taskbar icon nữa)
        mainWindow.setSkipTaskbar(false);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

function startServer() {
    if (serverStarted) return;
    serverStarted = true;
    try {
        process.env.PORT = String(PORT);
        // Khi đóng gói (asar archive), __dirname là read-only. Đặt data dir ở userData
        // (vd: C:\Users\<user>\AppData\Roaming\HP Action LIVE\data) để ghi được + persist
        const userDataDir = app.getPath('userData');
        const writableDataDir = path.join(userDataDir, 'data');
        if (!fs.existsSync(writableDataDir)) fs.mkdirSync(writableDataDir, { recursive: true });
        process.env.HP_DATA_DIR = writableDataDir;
        require('./server.js');
    } catch (err) {
        dialog.showErrorBox('Lỗi khởi động server', String(err && err.stack || err));
        app.quit();
    }
}

function waitForServerReady(timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            http.get(APP_URL, (res) => {
                res.destroy();
                resolve();
            }).on('error', () => {
                if (Date.now() - start > timeoutMs) reject(new Error('Server timeout'));
                else setTimeout(tick, 200);
            });
        };
        tick();
    });
}

function getIcon() {
    const p = path.join(__dirname, 'hp-logo.png');
    return nativeImage.createFromPath(p);
}

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 420,
        height: 220,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        icon: getIcon(),
        webPreferences: { contextIsolation: true }
    });
    const html = `
        <!doctype html><html><head><meta charset="utf-8"><style>
            body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:transparent;
                display:flex;align-items:center;justify-content:center;height:100vh;-webkit-app-region:drag;}
            .card{background:linear-gradient(135deg,#161a23,#0f1218);
                border:1px solid #2c3243;border-radius:16px;
                padding:24px 28px;color:#e6e8ee;text-align:center;
                box-shadow:0 20px 60px rgba(0,0,0,0.6);width:360px;}
            .logo{width:64px;height:64px;border-radius:14px;margin:0 auto 12px;
                background:linear-gradient(135deg,#7c3aed,#3b82f6);
                display:flex;align-items:center;justify-content:center;
                font-size:24px;font-weight:800;color:#fff;letter-spacing:1px;
                box-shadow:0 8px 24px rgba(124,58,237,0.45);}
            .title{font-size:18px;font-weight:800;letter-spacing:0.4px;}
            .sub{font-size:12px;color:#8b93a8;margin-top:4px;}
            .bar{margin-top:14px;height:3px;background:#1f2533;border-radius:999px;overflow:hidden;}
            .fill{height:100%;background:linear-gradient(90deg,#ff6b3d,#ff2d55);
                animation:run 1.4s ease-in-out infinite;width:30%;}
            @keyframes run{0%{margin-left:-30%}100%{margin-left:100%}}
        </style></head><body>
        <div class="card">
            <div class="logo">hp</div>
            <div class="title">HP Action LIVE</div>
            <div class="sub">Đang khởi động máy chủ...</div>
            <div class="bar"><div class="fill"></div></div>
        </div></body></html>`;
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    splashWindow.center();
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1100,
        minHeight: 700,
        backgroundColor: '#0b0d12',
        title: APP_NAME,
        icon: getIcon(),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: false
        }
    });
    Menu.setApplicationMenu(null);
    mainWindow.loadURL(APP_URL);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (splashWindow) { splashWindow.close(); splashWindow = null; }
    });

    // Hyperlinks trỏ ra ngoài → mở bằng trình duyệt mặc định
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // /soundfx → mở cửa sổ soundboard nổi riêng (always-on-top, resize)
        if (url === `${APP_URL}/soundfx` || url.startsWith(`${APP_URL}/soundfx`)) {
            openSoundfxWindow();
            return { action: 'deny' };
        }
        if (url.startsWith(APP_URL)) {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // X (close) hoặc minimize → ẨN xuống tray, KHÔNG quit.
    // Server tiếp tục chạy → socket OBS vẫn connect → overlay overlay nhận quà/state bình
    // thường khi user đang dọn màn hình hoặc nhường focus cho app khác trong livestream.
    // Muốn thoát thực sự: chuột phải tray icon → "Thoát" (gọi fullQuit).
    let trayBalloonShown = false;
    mainWindow.on('close', (e) => {
        if (isQuitting) return;
        e.preventDefault();
        mainWindow.hide();
        if (process.platform === 'win32') {
            mainWindow.setSkipTaskbar(true);
            // Lần đầu ẩn → bóng nhắc nhở user app đang chạy ở tray (1 lần / phiên)
            if (!trayBalloonShown && tray && !tray.isDestroyed()) {
                trayBalloonShown = true;
                try {
                    tray.displayBalloon({
                        title: 'HP Action LIVE vẫn đang chạy',
                        content: 'App đã thu xuống tray. OBS overlay vẫn hoạt động bình thường. Chuột phải tray để Thoát.',
                        iconType: 'info'
                    });
                } catch (_) {}
            }
        }
    });
    // Minimize cũng nên xuống tray cho nhất quán (tuỳ chọn — user có thể thích minimize bình
    // thường xuống taskbar). Giữ minimize MẶC ĐỊNH = taskbar (không can thiệp) để không phá
    // workflow của user. Chỉ X mới gửi xuống tray.
}

function showMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
}
function buildTray() {
    try {
        tray = new Tray(getIcon().resize({ width: 16, height: 16 }));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Mở HP Action LIVE', click: showMainWindow },
            { label: '🔊 Mở Sound Effects', click: () => openSoundfxWindow() },
            { label: 'Mở overlay OBS trong trình duyệt', click: () => shell.openExternal(`${APP_URL}/overlay/thuytinh`) },
            { type: 'separator' },
            { label: 'Thoát', click: () => fullQuit() }
        ]);
        tray.setToolTip(`${APP_NAME} (đang chạy — overlay OBS hoạt động)`);
        tray.setContextMenu(contextMenu);
        tray.on('double-click', showMainWindow);
        tray.on('click', showMainWindow);   // single click cũng mở (UX nhanh hơn)
    } catch (e) {}
}

// ============================================================
// fullQuit() — Cleanup TỔNG + force exit MỌI process con
// ============================================================
// 5-tier shutdown để đảm bảo 0 electron.exe sót trong Task Manager:
//   Tier 1: Socket.IO close → disconnect tất cả OBS browser sources
//   Tier 2: forcefullyCrashRenderer + destroy → kill renderer processes
//   Tier 3: tray destroy → release tray icon slot
//   Tier 4: httpServer close → release port + giải phóng node socket lib
//   Tier 5: app.exit(0) → main process exit chính thức
//   Hard fallback: taskkill /F /T /PID → kill TREE (kể cả grandchildren) sau 1.5s
// ============================================================
// Custom confirm popup styled cùng theme app — thay cho dialog.showMessageBoxSync xấu xí.
// Sử dụng BrowserWindow frameless + transparent + IPC để communicate.
function confirmQuitAsync() {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (v) => { if (resolved) return; resolved = true; resolve(v); };
        try {
            const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
            const win = new BrowserWindow({
                width: 460, height: 280,
                frame: false, transparent: true,
                resizable: false, minimizable: false, maximizable: false,
                alwaysOnTop: true, skipTaskbar: true,
                parent, modal: !!parent,
                show: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    sandbox: false
                }
            });
            const html = `<!doctype html><html><head><meta charset="utf-8"><style>
                html,body { margin: 0; padding: 0; height: 100%; background: transparent; font-family: 'Segoe UI', Roboto, sans-serif; overflow: hidden; user-select: none; -webkit-app-region: drag; }
                .overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
                .card {
                    -webkit-app-region: drag;
                    background: linear-gradient(155deg, #1f2230 0%, #181b25 100%);
                    border: 1px solid rgba(239, 68, 68, 0.4);
                    border-radius: 14px;
                    padding: 22px 26px;
                    width: 420px; max-width: 92vw;
                    box-shadow: 0 22px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(239, 68, 68, 0.18);
                    animation: pop 0.25s cubic-bezier(.34,1.56,.64,1);
                }
                @keyframes pop { from { transform: translateY(20px) scale(0.92); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
                .head { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
                .ico {
                    width: 44px; height: 44px; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    background: linear-gradient(135deg, rgba(239, 68, 68, 0.3), rgba(255, 107, 61, 0.18));
                    border-radius: 12px; font-size: 22px;
                }
                .title { font-size: 16px; font-weight: 800; color: #f3f5fa; }
                .body { font-size: 13px; color: #d6dae6; line-height: 1.55; padding: 4px 0 16px; }
                .body .hint { color: #8b93a8; font-size: 12px; }
                .actions { display: flex; justify-content: flex-end; gap: 10px; -webkit-app-region: no-drag; }
                button {
                    -webkit-app-region: no-drag;
                    padding: 9px 22px; font-size: 13px; font-weight: 700;
                    border-radius: 8px; cursor: pointer;
                    transition: transform 0.1s, box-shadow 0.15s;
                    border: 1px solid transparent;
                    font-family: inherit;
                }
                button:hover { transform: translateY(-1px); }
                .cancel { background: rgba(255,255,255,0.07); color: #d6dae6; border-color: rgba(255,255,255,0.12); }
                .cancel:hover { background: rgba(255,255,255,0.14); }
                .ok { background: linear-gradient(135deg, #ef4444, #f97316); color: #fff; box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4); }
                .ok:hover { box-shadow: 0 6px 20px rgba(239, 68, 68, 0.55); }
            </style></head><body>
                <div class="overlay">
                    <div class="card">
                        <div class="head">
                            <div class="ico">⏻</div>
                            <div class="title">Xác nhận thoát HP Action LIVE</div>
                        </div>
                        <div class="body">
                            Bạn có chắc muốn thoát?<br>
                            <span class="hint">Mọi OBS overlay đang kết nối sẽ ngừng nhận tín hiệu khi app thoát. Bấm "Giữ chạy ngầm" để app tiếp tục hoạt động ở tray.</span>
                        </div>
                        <div class="actions">
                            <button id="cancel" class="cancel" autofocus>Giữ chạy ngầm</button>
                            <button id="ok" class="ok">Thoát hẳn</button>
                        </div>
                    </div>
                </div>
                <script>
                    const { ipcRenderer } = require('electron');
                    document.getElementById('ok').addEventListener('click', () => ipcRenderer.send('hp-quit-confirm', true));
                    document.getElementById('cancel').addEventListener('click', () => ipcRenderer.send('hp-quit-confirm', false));
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape') ipcRenderer.send('hp-quit-confirm', false);
                        else if (e.key === 'Enter') ipcRenderer.send('hp-quit-confirm', false);   // Enter default = huỷ
                    });
                    // Focus cancel để Enter mặc định = huỷ
                    setTimeout(() => document.getElementById('cancel').focus(), 50);
                </script>
            </body></html>`;
            win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
            win.once('ready-to-show', () => win.show());
            const { ipcMain } = require('electron');
            const handler = (_evt, result) => { try { win.close(); } catch (e) {} finish(!!result); };
            ipcMain.once('hp-quit-confirm', handler);
            win.on('closed', () => { ipcMain.removeListener('hp-quit-confirm', handler); finish(false); });
        } catch (e) {
            // Fallback dialog nếu BrowserWindow fail
            const choice = dialog.showMessageBoxSync({
                type: 'question', buttons: ['Thoát hẳn', 'Huỷ'], defaultId: 1, cancelId: 1,
                title: 'Xác nhận thoát', message: 'Bạn có chắc muốn thoát HP Action LIVE?'
            });
            finish(choice === 0);
        }
    });
}

function fullQuit(opts) {
    if (isQuitting) return;
    const skipConfirm = !!(opts && opts.skipConfirm);
    if (!skipConfirm) {
        confirmQuitAsync().then((confirmed) => {
            if (confirmed) actualFullQuit();
        });
        return;
    }
    actualFullQuit();
}

function actualFullQuit() {
    if (isQuitting) return;
    isQuitting = true;

    // === Tier 1: Đóng Socket.IO (disconnect mọi OBS client) ===
    try {
        const srv = require('./server.js');
        if (srv && srv.io && typeof srv.io.close === 'function') {
            srv.io.close();           // disconnect all sockets
        }
    } catch (e) {}

    // === Tier 2: Crash + destroy renderer processes ===
    try {
        for (const w of BrowserWindow.getAllWindows()) {
            try {
                if (!w.isDestroyed()) {
                    // forcefullyCrashRenderer() ép renderer process exit ngay
                    if (w.webContents && typeof w.webContents.forcefullyCrashRenderer === 'function') {
                        try { w.webContents.forcefullyCrashRenderer(); } catch (e) {}
                    }
                    w.destroy();
                }
            } catch (e) {}
        }
    } catch (e) {}

    // === Tier 3: Destroy tray ===
    if (tray && !tray.isDestroyed()) {
        try { tray.destroy(); } catch (e) {}
        tray = null;
    }

    // === Tier 4: Close HTTP server ===
    try {
        const srv = require('./server.js');
        if (srv && srv.httpServer && typeof srv.httpServer.close === 'function') {
            srv.httpServer.close();
        }
    } catch (e) {}

    // === Tier 5: app.exit(0) sau 200ms (cho cleanup async hoàn tất) ===
    setTimeout(() => {
        try { app.exit(0); } catch (e) {}

        // === Hard fallback (Windows-specific): taskkill /F /T /PID <main>
        // Kill TREE — terminate main process + tất cả descendants
        // (helper electron.exe, GPU process nếu còn, utility processes, v.v.)
        setTimeout(() => {
            try {
                if (process.platform === 'win32') {
                    const { spawn } = require('child_process');
                    spawn('taskkill', ['/F', '/T', '/PID', String(process.pid)], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    }).unref();
                }
            } catch (e) {}
            // Hard process exit nếu trên đây vẫn không kill được
            try { process.exit(0); } catch (e) {}
        }, 800);
    }, 200);
}

// ============================================================
// 🔊 SoundFX — cửa sổ soundboard nổi, always-on-top, resize có giới hạn
// ============================================================
async function loadSfxWinPrefs() {
    // Đọc bounds đã lưu từ soundfx.json (server lưu qua /api/soundfx/config)
    try {
        const j = await new Promise((resolve) => {
            http.get(`${APP_URL}/api/soundfx/library`, (res) => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            }).on('error', () => resolve(null));
        });
        return (j && j.settings && j.settings.win) ? j.settings.win : {};
    } catch { return {}; }
}
async function openSoundfxWindow() {
    if (soundfxWindow && !soundfxWindow.isDestroyed()) {
        soundfxWindow.show(); soundfxWindow.focus(); return;
    }
    const win = await loadSfxWinPrefs();
    const opts = {
        width: 480,
        height: 760,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'HP Media — Sound Effects',
        icon: getIcon(),
        backgroundColor: '#ffffff',
        alwaysOnTop: win.alwaysOnTop !== false,
        autoHideMenuBar: true,
        skipTaskbar: false,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'sfx-preload.js')
        }
    };
    if (typeof win.x === 'number' && typeof win.y === 'number') { opts.x = win.x; opts.y = win.y; }
    soundfxWindow = new BrowserWindow(opts);
    soundfxWindow.loadURL(`${APP_URL}/soundfx`);
    soundfxWindow.once('ready-to-show', () => soundfxWindow.show());
    soundfxWindow.on('closed', () => { soundfxWindow = null; unregisterSfxHotkeys(); });
    soundfxWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });
}
ipcMain.on('sfx:setAlwaysOnTop', (e, on) => {
    if (soundfxWindow && !soundfxWindow.isDestroyed()) soundfxWindow.setAlwaysOnTop(!!on);
});
ipcMain.on('sfx:close', () => {
    if (soundfxWindow && !soundfxWindow.isDestroyed()) soundfxWindow.close();
});
ipcMain.on('sfx:getBounds', (e) => {
    try {
        const b = soundfxWindow && !soundfxWindow.isDestroyed() ? soundfxWindow.getBounds() : null;
        e.returnValue = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    } catch { e.returnValue = null; }
});
ipcMain.on('sfx:setBounds', (e, b) => {
    if (soundfxWindow && !soundfxWindow.isDestroyed() && b) {
        try { soundfxWindow.setBounds({
            x: b.x ?? soundfxWindow.getBounds().x,
            y: b.y ?? soundfxWindow.getBounds().y,
            width: b.w ?? soundfxWindow.getBounds().width,
            height: b.h ?? soundfxWindow.getBounds().height
        }); } catch {}
    }
});
// Main app mở SoundFX qua IPC
ipcMain.on('open-soundfx', () => openSoundfxWindow());

// 📂 Chọn file audio từ máy
ipcMain.handle('sfx:pickAudio', async () => {
    try {
        const r = await dialog.showOpenDialog(soundfxWindow || mainWindow, {
            title: 'Chọn file âm thanh',
            properties: ['openFile'],
            filters: [{ name: 'Âm thanh', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }]
        });
        if (r.canceled || !r.filePaths[0]) return null;
        const p = r.filePaths[0];
        return { path: p, name: path.basename(p).replace(/\.[a-z0-9]+$/i, '') };
    } catch { return null; }
});

// ⌨️ Global shortcuts — hoạt động MỌI NƠI (không cần focus cửa sổ soundfx)
let _registeredAccels = [];
function unregisterSfxHotkeys() {
    for (const a of _registeredAccels) { try { globalShortcut.unregister(a); } catch (_) {} }
    _registeredAccels = [];
}
ipcMain.on('sfx:registerHotkeys', (e, payload) => {
    unregisterSfxHotkeys();
    if (!payload || !payload.enabled) return;
    const sendFire = (data) => {
        if (soundfxWindow && !soundfxWindow.isDestroyed()) {
            soundfxWindow.webContents.send('sfx:hotkeyFired', data);
        }
    };
    const reg = (accel, data) => {
        if (!accel) return;
        try {
            if (globalShortcut.register(accel, () => sendFire(data))) _registeredAccels.push(accel);
        } catch (_) {}
    };
    for (const it of (payload.sounds || [])) reg(it.accel, { soundId: it.soundId });
    if (payload.play) reg(payload.play, { action: 'play' });
    if (payload.stop) reg(payload.stop, { action: 'stop' });
});

app.whenReady().then(async () => {
    startServer();
    createSplash();
    try {
        await waitForServerReady();
    } catch (e) {
        dialog.showErrorBox('Server không phản hồi', 'Không thể kết nối tới ' + APP_URL);
        fullQuit({ skipConfirm: true });
        return;
    }
    createMainWindow();
    buildTray();
});

app.on('before-quit', () => { isQuitting = true; try { unregisterSfxHotkeys(); } catch (_) {} });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });
app.on('window-all-closed', () => {
    // Theo behavior cũ: macOS auto-quit, Windows giữ ở tray.
    // KHÔNG fullQuit ở đây — nếu GPU crash khiến windows đóng trước khi tray dựng xong,
    // fullQuit sẽ bị trigger nhầm. fullQuit() chỉ từ tray menu "Thoát" hoặc signal.
    if (process.platform === 'darwin') app.quit();
});
app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    else { mainWindow.setSkipTaskbar(false); mainWindow.show(); mainWindow.focus(); }
});

// Kéo signal ctrl+c / kill từ terminal về fullQuit để cleanup đầy đủ
// SIGINT/SIGTERM = user dứt khoát muốn thoát (ctrl+c terminal, OS shutdown) → bỏ qua confirm dialog
process.on('SIGINT', () => fullQuit({ skipConfirm: true }));
process.on('SIGTERM', () => fullQuit({ skipConfirm: true }));

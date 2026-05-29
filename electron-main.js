/*
 * HP Action LIVE — Electron Desktop Wrapper
 * Khởi động server Express + mở cửa sổ Chromium tới http://localhost:PORT
 */
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const APP_URL = `http://localhost:${PORT}`;
const APP_NAME = 'HP Action LIVE';

let mainWindow = null;
let splashWindow = null;
let soundfxWindow = null;
let quickLaunchWindow = null;
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
    try {
        session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
            if (permission !== 'media' && permission !== 'microphone') return false;
            return String(requestingOrigin || '').startsWith(APP_URL);
        });
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
            if (permission !== 'media' && permission !== 'microphone') return callback(false);
            const origin = String(details?.requestingUrl || webContents.getURL() || '');
            callback(origin.startsWith(APP_URL));
        });
    } catch (_) {}

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
        // /quick-launch → cửa sổ điều khiển nhanh tách rời (always-on-top)
        if (url === `${APP_URL}/quick-launch` || url.startsWith(`${APP_URL}/quick-launch`)) {
            openQuickLaunchWindow();
            return { action: 'deny' };
        }
        // /overlay/caro?popout=1 → cửa sổ Overlay Review trong suốt + frameless để
        // OBS dùng Window Capture (WGC) bắt sắc nét hơn so với Browser Source URL.
        if (url.startsWith(`${APP_URL}/overlay/caro`) && url.includes('popout=1')) {
            openCaroPreviewWindow();
            return { action: 'deny' };
        }
        // /overlay/nhietdo → cửa sổ overlay nhiệt độ (nền trong suốt + frame title bar để kéo).
        // Hỗ trợ 2 mode: bình thường, hoặc ?pin=1 (luôn nổi trên top).
        if (url.startsWith(`${APP_URL}/overlay/nhietdo`)) {
            const pin = url.includes('pin=1');
            const edit = url.includes('edit=1');
            openNhietDoPopoutWindow({ pin, edit });
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

// ============================================================
// 🚀 Quick Launch — cửa sổ điều khiển nhanh tách rời, always-on-top
// ============================================================
// Nhỏ gọn, pin-able, lưu bounds + alwaysOnTop qua phiên (file disk dưới userData).
// User minimize main window → vẫn dùng được cửa sổ này để chạy nhanh nút Bắt đầu/Tắt.
function getQuickLaunchPrefsPath() {
    try { return path.join(app.getPath('userData'), 'data', 'quick-launch.json'); }
    catch { return null; }
}
function loadQuickLaunchPrefs() {
    try {
        const p = getQuickLaunchPrefsPath();
        if (!p || !fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch { return {}; }
}
let qlSaveTimer = null;
let qlPendingPatch = {};
function saveQuickLaunchPrefs(patch) {
    // GỘP patch đang chờ — tránh patch sau (vd bounds) ghi đè/hủy patch trước (vd layout)
    qlPendingPatch = { ...qlPendingPatch, ...(patch || {}) };
    // Debounce 250ms — move/resize emit liên tục, tránh ghi disk dồn dập
    if (qlSaveTimer) clearTimeout(qlSaveTimer);
    qlSaveTimer = setTimeout(() => {
        try {
            const p = getQuickLaunchPrefsPath();
            if (!p) return;
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cur = loadQuickLaunchPrefs();
            const next = { ...cur, ...qlPendingPatch };
            fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
            qlPendingPatch = {};
        } catch (e) { /* swallow */ }
    }, 250);
}
function openQuickLaunchWindow() {
    if (quickLaunchWindow && !quickLaunchWindow.isDestroyed()) {
        quickLaunchWindow.show(); quickLaunchWindow.focus(); return;
    }
    const prefs = loadQuickLaunchPrefs();
    const opts = {
        width: Math.max(320, parseInt(prefs.w, 10) || 380),
        height: Math.max(150, parseInt(prefs.h, 10) || 560),
        minWidth: 320,
        minHeight: 150,   // cho phép bố cục Ngang thấp gọn (ôm sát card)
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        title: 'HP — Khởi động nhanh',
        icon: getIcon(),
        backgroundColor: '#0b0d12',
        alwaysOnTop: prefs.alwaysOnTop !== false,   // mặc định Pin = on
        autoHideMenuBar: true,
        frame: false,
        skipTaskbar: false,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'quick-launch-preload.js')
        }
    };
    if (Number.isFinite(prefs.x) && Number.isFinite(prefs.y)) {
        opts.x = prefs.x; opts.y = prefs.y;
    }
    quickLaunchWindow = new BrowserWindow(opts);
    // Truyền chế độ bố cục qua QUERY PARAM → renderer đọc đồng bộ lúc load (không bị race như IPC).
    quickLaunchWindow.loadURL(`${APP_URL}/quick-launch?layout=${prefs.layout === 'ngang' ? 'ngang' : 'doc'}`);
    quickLaunchWindow.once('ready-to-show', () => {
        // Báo renderer biết trạng thái Pin lúc khởi tạo để sync UI nút 📌
        try { quickLaunchWindow.webContents.send('quick-launch:initPin', opts.alwaysOnTop); } catch {}
        // Khôi phục chế độ bố cục Dọc/Ngang đã lưu (mặc định 'doc' nếu chưa có)
        try { quickLaunchWindow.webContents.send('quick-launch:initLayout', prefs.layout === 'ngang' ? 'ngang' : 'doc'); } catch {}
        quickLaunchWindow.show();
    });
    const persistBounds = () => {
        if (!quickLaunchWindow || quickLaunchWindow.isDestroyed()) return;
        try {
            const b = quickLaunchWindow.getBounds();
            saveQuickLaunchPrefs({ x: b.x, y: b.y, w: b.width, h: b.height });
        } catch {}
    };
    quickLaunchWindow.on('moved',  persistBounds);
    quickLaunchWindow.on('resize', persistBounds);
    quickLaunchWindow.on('close', persistBounds);
    quickLaunchWindow.on('closed', () => { quickLaunchWindow = null; });
    quickLaunchWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });
}
ipcMain.on('quick-launch:setAlwaysOnTop', (e, on) => {
    if (quickLaunchWindow && !quickLaunchWindow.isDestroyed()) {
        quickLaunchWindow.setAlwaysOnTop(!!on);
        saveQuickLaunchPrefs({ alwaysOnTop: !!on });
    }
});
ipcMain.on('quick-launch:setLayout', (e, mode) => {
    saveQuickLaunchPrefs({ layout: mode === 'ngang' ? 'ngang' : 'doc' });
});
ipcMain.on('quick-launch:setSize', (e, size) => {
    if (!quickLaunchWindow || quickLaunchWindow.isDestroyed()) return;
    const w = Math.max(320, Math.round(Number(size?.w) || 0));
    const h = Math.max(150, Math.round(Number(size?.h) || 0));
    if (!w || !h) return;
    try { quickLaunchWindow.setSize(w, h, true); } catch {}
});
ipcMain.on('quick-launch:close', () => {
    if (quickLaunchWindow && !quickLaunchWindow.isDestroyed()) quickLaunchWindow.close();
});
ipcMain.on('open-quick-launch', () => openQuickLaunchWindow());

// ============================================================
// 🎯 Caro Overlay Review — cửa sổ trong suốt + frameless cho OBS Window Capture
// ============================================================
// Mục đích: link OBS Browser Source render Caro overlay bị mờ do CEF của OBS down-scale
// canvas 1080×1920 nhỏ hơn nguồn → blur. Cửa sổ rời này render 1:1 ở native DPI →
// OBS dùng "Window Capture (WGC)" bắt pixel trực tiếp → sắc nét hơn. Transparent +
// frameless → OBS WGC giữ alpha → overlay vẫn trong suốt như Browser Source.
let caroPreviewWindow = null;
function getCaroPreviewPrefsPath() {
    try { return path.join(app.getPath('userData'), 'data', 'caro-preview.json'); }
    catch { return null; }
}
function loadCaroPreviewPrefs() {
    try {
        const p = getCaroPreviewPrefsPath();
        if (!p || !fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch { return {}; }
}
let cpSaveTimer = null;
function saveCaroPreviewPrefs(patch) {
    if (cpSaveTimer) clearTimeout(cpSaveTimer);
    cpSaveTimer = setTimeout(() => {
        try {
            const p = getCaroPreviewPrefsPath();
            if (!p) return;
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cur = loadCaroPreviewPrefs();
            const next = { ...cur, ...patch };
            fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
        } catch (e) { /* swallow */ }
    }, 250);
}
function openCaroPreviewWindow() {
    if (caroPreviewWindow && !caroPreviewWindow.isDestroyed()) {
        caroPreviewWindow.show(); caroPreviewWindow.focus(); return;
    }
    const prefs = loadCaroPreviewPrefs();
    // Default 540×960 = 1080×1920 portrait /2 — fitScale() trong overlay tự adapt theo size
    const opts = {
        width:  Math.max(270, parseInt(prefs.w, 10) || 540),
        height: Math.max(480, parseInt(prefs.h, 10) || 960),
        minWidth: 270,
        minHeight: 480,
        resizable: true,
        maximizable: true,
        fullscreenable: false,
        title: 'HP Caro — Overlay Review (OBS Window Capture)',
        icon: getIcon(),
        backgroundColor: '#00000000',   // alpha 00 = transparent — OBS WGC giữ alpha
        transparent: true,
        frame: false,
        hasShadow: false,
        alwaysOnTop: prefs.alwaysOnTop === true,
        skipTaskbar: false,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'caro-preview-preload.js')
        }
    };
    if (Number.isFinite(prefs.x) && Number.isFinite(prefs.y)) {
        opts.x = prefs.x; opts.y = prefs.y;
    }
    caroPreviewWindow = new BrowserWindow(opts);
    caroPreviewWindow.loadURL(`${APP_URL}/overlay/caro?popout=1`);
    caroPreviewWindow.once('ready-to-show', () => caroPreviewWindow.show());
    const persistBounds = () => {
        if (!caroPreviewWindow || caroPreviewWindow.isDestroyed()) return;
        try {
            const b = caroPreviewWindow.getBounds();
            saveCaroPreviewPrefs({ x: b.x, y: b.y, w: b.width, h: b.height });
        } catch {}
    };
    caroPreviewWindow.on('moved',  persistBounds);
    caroPreviewWindow.on('resize', persistBounds);
    caroPreviewWindow.on('close',  persistBounds);
    caroPreviewWindow.on('closed', () => { caroPreviewWindow = null; });
    caroPreviewWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });
}
ipcMain.on('caro-preview:setAlwaysOnTop', (e, on) => {
    if (caroPreviewWindow && !caroPreviewWindow.isDestroyed()) {
        caroPreviewWindow.setAlwaysOnTop(!!on);
        saveCaroPreviewPrefs({ alwaysOnTop: !!on });
    }
});
ipcMain.on('caro-preview:close', () => {
    if (caroPreviewWindow && !caroPreviewWindow.isDestroyed()) caroPreviewWindow.close();
});
ipcMain.on('open-caro-preview', () => openCaroPreviewWindow());

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
    // Auto-mở cửa sổ Khởi động nhanh sau khi main window sẵn sàng.
    // Mặc định BẬT. User có thể tắt qua prefs file (quick-launch.json: autoOpen: false).
    setTimeout(() => {
        try {
            const prefs = loadQuickLaunchPrefs();
            if (prefs.autoOpen === false) return;   // user explicitly disabled
            openQuickLaunchWindow();
        } catch (e) {}
    }, 1500);
});

// ============================================================
// NHIỆT ĐỘ — cửa sổ overlay popout (transparent + title bar để kéo)
// 2 mode: bình thường (frame), hoặc pin (frame + alwaysOnTop)
// ============================================================
let nhietDoPinWindow = null;
let nhietDoPopoutWindow = null;
const NHIETDO_PIN_PREFS_FILE = path.join(app.getPath('userData'), 'nhietdo-pin-prefs.json');
function loadNhietDoPinPrefs() {
    try { return JSON.parse(fs.readFileSync(NHIETDO_PIN_PREFS_FILE, 'utf8')); } catch { return {}; }
}
function saveNhietDoPinPrefs(patch) {
    try {
        const cur = loadNhietDoPinPrefs();
        fs.writeFileSync(NHIETDO_PIN_PREFS_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
    } catch {}
}
function openNhietDoPopoutWindow({ pin = false, edit = false } = {}) {
    // Reuse target window theo mode
    const slotKey = pin ? 'pin' : 'popout';
    let target = pin ? nhietDoPinWindow : nhietDoPopoutWindow;
    if (target && !target.isDestroyed()) {
        try { target.focus(); return; } catch {}
    }
    const prefs = loadNhietDoPinPrefs();
    const sub = prefs[slotKey] || {};
    const opts = {
        width:  Math.max(200, parseInt(sub.w, 10) || (pin ? 360 : 540)),
        height: Math.max(360, parseInt(sub.h, 10) || (pin ? 640 : 960)),
        minWidth: 200, minHeight: 360,
        title: pin ? 'HP Nhiệt Độ — Pinned' : 'HP Nhiệt Độ — Overlay',
        icon: getIcon(),
        backgroundColor: '#00000000',   // alpha 00 = nền hoàn toàn trong suốt
        transparent: true,
        frame: true,                    // title bar để KÉO + đóng cửa sổ (fix bug pin không kéo được)
        hasShadow: false,
        alwaysOnTop: pin,
        skipTaskbar: false,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: false }
    };
    if (Number.isFinite(sub.x) && Number.isFinite(sub.y)) { opts.x = sub.x; opts.y = sub.y; }
    const win = new BrowserWindow(opts);
    const params = [];
    if (pin) params.push('pin=1');
    if (edit) params.push('edit=1');
    win.loadURL(`${APP_URL}/overlay/nhietdo${params.length ? '?' + params.join('&') : ''}`);
    win.once('ready-to-show', () => win.show());
    const persist = () => {
        if (!win || win.isDestroyed()) return;
        try {
            const b = win.getBounds();
            saveNhietDoPinPrefs({ [slotKey]: { x: b.x, y: b.y, w: b.width, h: b.height } });
        } catch {}
    };
    win.on('moved', persist);
    win.on('resize', persist);
    win.on('close', persist);
    win.on('closed', () => {
        if (pin) nhietDoPinWindow = null;
        else nhietDoPopoutWindow = null;
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });
    if (pin) nhietDoPinWindow = win;
    else nhietDoPopoutWindow = win;
}

// ============================================================
// BẮN CUNG — global hotkeys (work even when app not focused)
// Server.js calls global.__bancungApplyHotkeys(cfg) khi config update.
// Mỗi hotkey fired → POST tới /api/games/bancung/control (cùng REST như UI).
// ============================================================
let _bancungAccels = [];
function unregisterBancungHotkeys() {
    for (const a of _bancungAccels) { try { globalShortcut.unregister(a); } catch (_) {} }
    _bancungAccels = [];
}
async function _bancungCallApi(body) {
    try {
        const fetch = require('node-fetch');
        await fetch(`${APP_URL}/api/games/bancung/control`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) { console.warn('[bancung-hotkey] api fail:', e.message); }
}
function applyBancungHotkeys(cfg) {
    unregisterBancungHotkeys();
    const d = cfg?.display || {};
    if (cfg?.enabled === false || cfg?.sessionActive === false) return;
    if (d.globalHotkeys !== true) return;   // only when explicitly enabled
    // Auto-prefix with CommandOrControl+Shift+ so single keys (X, H, B, R) become
    // Ctrl+Shift+X etc. Tránh chặn typing thông thường ở app khác.
    const PREFIX = 'CommandOrControl+Shift+';
    const reg = (key, body) => {
        if (!key) return;
        const accel = PREFIX + key.toUpperCase();
        try {
            if (globalShortcut.register(accel, () => _bancungCallApi(body))) {
                _bancungAccels.push(accel);
            }
        } catch (e) { console.warn('[bancung-hotkey] register fail:', accel, e.message); }
    };
    reg(d.hotkeyFire,   { cmd: 'damage', shots: 1, uniqueId: 'idol', nickname: 'IDOL' });
    reg(d.hotkeyHeal,   { cmd: 'heal', hearts: 1 });
    reg(d.hotkeyShield, { cmd: 'shield', durationSec: 5 });
    reg(d.hotkeyRevive, { cmd: 'revive' });
    reg(d.hotkeyKill,   { cmd: 'killshot' });
    if (_bancungAccels.length) console.log(`[bancung] global hotkeys registered (Ctrl+Shift+): ${_bancungAccels.join(', ')}`);
}
global.__bancungApplyHotkeys = applyBancungHotkeys;

app.on('before-quit', () => { isQuitting = true; try { unregisterSfxHotkeys(); unregisterBancungHotkeys(); } catch (_) {} });
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

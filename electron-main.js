/*
 * HP Action LIVE — Electron Desktop Wrapper
 * Khởi động server Express + mở cửa sổ Chromium tới http://localhost:PORT
 */
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const APP_URL = `http://localhost:${PORT}`;
const APP_NAME = 'HP Action LIVE';

let mainWindow = null;
let splashWindow = null;
let tray = null;
let serverStarted = false;
let isQuitting = false;

// === Single-instance lock ===
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

app.setName(APP_NAME);
app.setAppUserModelId('com.hpmedia.actionlive');

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
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
        if (url.startsWith(APP_URL)) {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
            if (!tray) buildTray();
        }
    });
}

function buildTray() {
    try {
        tray = new Tray(getIcon().resize({ width: 16, height: 16 }));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Mở HP Action LIVE', click: () => { mainWindow.show(); mainWindow.focus(); } },
            { label: 'Mở overlay OBS trong trình duyệt', click: () => shell.openExternal(`${APP_URL}/overlay/thuytinh`) },
            { type: 'separator' },
            { label: 'Thoát', click: () => { isQuitting = true; app.quit(); } }
        ]);
        tray.setToolTip(APP_NAME);
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
    } catch (e) {}
}

app.whenReady().then(async () => {
    startServer();
    createSplash();
    try {
        await waitForServerReady();
    } catch (e) {
        dialog.showErrorBox('Server không phản hồi', 'Không thể kết nối tới ' + APP_URL);
        app.quit();
        return;
    }
    createMainWindow();
    buildTray();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {
    // Giữ app sống ở tray trên Windows; thoát hẳn nếu macOS
    if (process.platform === 'darwin') app.quit();
});
app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    else mainWindow.show();
});

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const fetch = require('node-fetch');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;

// === Google Sheet danh sách quà (public-readable, không nhạy cảm) ===
const SHEET_ID = '1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M';
const SHEET_NAME = 'DANH SACH QUA';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

// === LICENSE VALIDATION ===
// PRODUCTION: trỏ tới license-server riêng (license-server/ hoặc cloudflare-worker/).
//             Sheet ID ẩn ở server, app chỉ POST key → nhận result.
// TEST/DEV:   nếu LICENSE_WORKER_URL chưa được cấu hình (placeholder),
//             app sẽ FALLBACK đọc Google Sheet trực tiếp (như v1.0.4 cũ).
//             Tiện cho test local trước khi deploy license-server.
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://hp-license.YOUR-DOMAIN.workers.dev';   // ← UPDATE sau khi deploy server

const KEY_SHEET_NAME = 'KEY_HP_GAME';
const KEY_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(KEY_SHEET_NAME)}`;
function isWorkerConfigured() {
    return !LICENSE_WORKER_URL.includes('YOUR-DOMAIN') && !LICENSE_WORKER_URL.includes('YOUR-CF-USERNAME');
}
// HP_DATA_DIR được set bởi electron-main.js trong môi trường đóng gói (vì __dirname nằm trong asar read-only).
// Khi chạy dev / node trực tiếp: fallback về data/ cạnh server.js
const DATA_DIR = process.env.HP_DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'app-config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ====== Game registry ======
const GAMES = {
    thuytinh: {
        id: 'thuytinh',
        name: 'Hũ Thủy Tinh',
        description: 'Quà tặng rơi vào hũ thủy tinh theo vật lý realtime — dùng làm overlay OBS.',
        icon: '🫙',
        overlayPath: '/overlay/thuytinh',
        defaultConfig: {
            jar: { xPercent: 50, yPercent: 56, height: 1200 },
            gift: { minSize: 40, maxSize: 220, showName: false, showCount: true },
            physics: { gravity: 1.4, bounce: 0.42, friction: 0.05 },
            jarVisible: true,
            maxCapacity: 0
        }
    }
};

// ====== App config / persistence ======
function loadAppConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
    return { games: {}, license: { key: '', email: '' } };
}
function saveAppConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
}
const appConfig = loadAppConfig();
for (const gId of Object.keys(GAMES)) {
    if (!appConfig.games[gId]) appConfig.games[gId] = { ...GAMES[gId].defaultConfig };
}
saveAppConfig();

// ====== Google Sheet loader ======
let giftMap = {};
let giftList = [];

function parseCsv(text) {
    const rows = [];
    let cur = '';
    let inQuote = false;
    let row = [];
    const flushCell = () => { row.push(cur); cur = ''; };
    const flushRow = () => { row.push(cur); rows.push(row); cur = ''; row = []; };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cur += '"'; i++; }
                else inQuote = false;
            } else cur += ch;
        } else {
            if (ch === '"') inQuote = true;
            else if (ch === ',') flushCell();
            else if (ch === '\n') flushRow();
            else if (ch === '\r') { /* skip */ }
            else cur += ch;
        }
    }
    if (cur.length || row.length) flushRow();
    return rows;
}

async function loadGiftSheet() {
    console.log('[gift-sheet] Tải danh sách quà từ Google Sheet...');
    const res = await fetch(SHEET_CSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    const list = [];
    const map = {};
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 3) continue;
        const id = (r[0] || '').toString().trim();
        const name = (r[1] || '').toString().trim();
        const link = (r[2] || '').toString().trim();
        const webm = (r[3] || '').toString().trim();
        const diamond = parseInt((r[4] || '').toString().replace(/[^\d]/g, ''), 10) || 0;
        if (!id) continue;
        const item = { id, name, image: link, webm, diamond };
        list.push(item);
        map[id] = item;
    }
    giftList = list;
    giftMap = map;
    console.log(`[gift-sheet] Đã tải ${list.length} quà.`);
    io.emit('giftSheet', giftList);
    return giftList;
}

// ============================================================
// LICENSE VALIDATION qua server riêng
// ============================================================
// App POST {key, deviceId?} tới LICENSE_WORKER_URL/activate.
// Server (license-server/ hoặc cloudflare-worker/) đọc Sheet → return result.
// Bảo mật đường truyền: HTTPS (server hardcoded URL trong app build).

function parseDmy(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
}

// Device fingerprint — gom CPU model + Windows MachineGuid + hostname để
// đại diện cho máy. Server dùng để bind key, chống chia sẻ key trên nhiều máy.
let _cachedDeviceId = null;
function getDeviceFingerprint() {
    if (_cachedDeviceId) return _cachedDeviceId;
    try {
        const parts = [
            os.hostname(),
            os.platform(),
            os.arch(),
            os.cpus()?.[0]?.model || '',
            os.totalmem(),
            // userInfo username (per-machine + per-user)
            os.userInfo()?.username || ''
        ].join('|');
        _cachedDeviceId = crypto.createHash('sha256').update(parts).digest('hex').slice(0, 24);
    } catch (e) {
        _cachedDeviceId = 'unknown';
    }
    return _cachedDeviceId;
}

// ===== FALLBACK: đọc Sheet trực tiếp (dùng cho test/dev khi chưa deploy license-server) =====
let _keySheetCache = null;
let _keySheetCachedAt = 0;
const KEY_SHEET_TTL_MS = 5 * 60 * 1000;

function _normalizeRole(raw) {
    const up = String(raw || '').toUpperCase();
    if (up === 'ADMIN' || up === 'CREATOR') return up;
    return 'ADMIN';   // backward compat: VIP/Thường/blank → full access
}

function _parseDmy(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
}

async function _validateLicenseKeyDirect(key) {
    let list = _keySheetCache;
    if (!list || Date.now() - _keySheetCachedAt > KEY_SHEET_TTL_MS) {
        try {
            const r = await fetch(KEY_SHEET_CSV_URL);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const csv = await r.text();
            const rows = parseCsv(csv);
            list = [];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || !row[0]) continue;
                const k = String(row[0]).trim();
                if (!k) continue;
                list.push({
                    key: k,
                    expiry: String(row[1] || '').trim(),
                    role: _normalizeRole(row[2] || ''),
                    roleRaw: String(row[2] || '').trim(),
                    status: String(row[3] || '').trim(),
                    note: String(row[4] || '').trim()
                });
            }
            _keySheetCache = list;
            _keySheetCachedAt = Date.now();
        } catch (e) {
            return { ok: false, error: 'Không kết nối được Google Sheet — kiểm tra mạng', _offline: true };
        }
    }
    const row = list.find(r => r.key.toLowerCase() === key.toLowerCase());
    if (!row) return { ok: false, error: 'Key không tồn tại trong hệ thống' };
    if (/hết hạn|tạm khóa|tam khoa|het han|khoa|locked/i.test(row.status)) {
        return { ok: false, error: 'Key đã bị khoá hoặc hết hạn' };
    }
    const expiryDate = _parseDmy(row.expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
        return { ok: false, error: `Key đã hết hạn từ ${row.expiry}` };
    }
    return {
        ok: true,
        key: row.key,
        role: row.role,
        vip: row.roleRaw,
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        status: 'Đang sử dụng',
        note: row.note
    };
}

async function validateLicenseKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'Vui lòng nhập key bản quyền' };

    // === Test/dev mode: chưa cấu hình LICENSE_WORKER_URL → đọc Sheet trực tiếp ===
    if (!isWorkerConfigured()) {
        console.log('[license] [TEST MODE] LICENSE_WORKER_URL chưa cấu hình — fallback đọc Sheet trực tiếp');
        return _validateLicenseKeyDirect(key);
    }

    // === Production mode: gọi license-server ===
    let body;
    try {
        const res = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, deviceId: getDeviceFingerprint() }),
            timeout: 10000
        });
        body = await res.json();
    } catch (e) {
        return { ok: false, error: 'Không kết nối được hệ thống bản quyền — kiểm tra mạng và thử lại', _offline: true };
    }

    if (!body || body.ok === false) {
        return { ok: false, error: body?.error || 'Key không hợp lệ' };
    }

    if (body.expiryISO && new Date(body.expiryISO).getTime() < Date.now()) {
        return { ok: false, error: `Key đã hết hạn từ ${body.expiry || body.expiryISO}` };
    }

    return {
        ok: true,
        key: body.key,
        role: body.role || 'ADMIN',
        vip: body.vip || body.role || '',
        expiry: body.expiry,
        expiryISO: body.expiryISO,
        status: 'Đang sử dụng',
        note: body.note || ''
    };
}

// ====== TikTok connection ======
let connection = null;
let currentUsername = null;
let connecting = false;
let currentRoomId = null;

function broadcast(type, payload) { io.emit(type, payload); }

function attachConnectionEvents(conn) {
    conn.on(ControlEvent.CONNECTED, (state) => {
        currentRoomId = state?.roomId;
        broadcast('status', { connected: true, username: currentUsername, roomId: currentRoomId });
        console.log(`[tiktok] Connected to roomId=${currentRoomId}`);
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
        broadcast('status', { connected: false, username: currentUsername });
        console.log('[tiktok] Disconnected');
    });
    conn.on(ControlEvent.STREAM_END, () => {
        broadcast('status', { connected: false, username: currentUsername, reason: 'streamEnd' });
    });
    conn.on(ControlEvent.ERROR, (err) => {
        console.error('[tiktok] error:', err?.message || err);
        broadcast('error', { message: err?.message || String(err) });
    });

    conn.on(WebcastEvent.CHAT, (data) => {
        broadcast('chat', {
            uniqueId: data?.user?.uniqueId,
            nickname: data?.user?.nickname,
            userId: data?.user?.userId,
            profilePicture: data?.user?.profilePicture?.url || data?.user?.profilePictureUrl,
            comment: data?.comment,
            createTime: Date.now()
        });
    });

    conn.on(WebcastEvent.GIFT, (data) => {
        const giftType = data?.giftDetails?.giftType ?? data?.gift?.gift_type ?? data?.giftType;
        const isStreak = giftType === 1;
        if (isStreak && !data?.repeatEnd) return;
        emitGift({
            uniqueId: data?.user?.uniqueId,
            nickname: data?.user?.nickname,
            userId: data?.user?.userId,
            profilePicture: data?.user?.profilePicture?.url || data?.user?.profilePictureUrl,
            giftId: String(data?.giftId ?? data?.gift?.gift_id ?? data?.giftDetails?.giftId ?? ''),
            giftName: data?.giftDetails?.giftName || data?.gift?.name || data?.giftName,
            giftPicture: data?.giftDetails?.giftImage?.giftPictureUrl || data?.gift?.image?.url_list?.[0],
            diamondCount: data?.giftDetails?.diamondCount ?? data?.gift?.diamond_count,
            repeatCount: data?.repeatCount ?? 1,
            source: 'tiktok'
        });
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
        broadcast('member', { uniqueId: data?.user?.uniqueId, nickname: data?.user?.nickname });
    });
    conn.on(WebcastEvent.LIKE, (data) => {
        broadcast('like', { uniqueId: data?.user?.uniqueId, nickname: data?.user?.nickname, likeCount: data?.likeCount });
    });
    conn.on(WebcastEvent.SOCIAL, (data) => {
        broadcast('social', { uniqueId: data?.user?.uniqueId, nickname: data?.user?.nickname, label: data?.label });
    });
    conn.on(WebcastEvent.ROOM_USER, (data) => {
        broadcast('roomUser', { viewerCount: data?.viewerCount ?? data?.totalUser });
    });
}

function emitGift(g) {
    const sheetItem = giftMap[String(g.giftId)] || null;
    const enriched = {
        ...g,
        sheetItem,
        image: sheetItem?.image || g.giftPicture,
        coinValue: sheetItem?.diamond ?? g.diamondCount ?? 1,
        ts: Date.now()
    };
    io.emit('gift', enriched);
    // Push to all game overlays
    io.to('overlay').emit('gameGift', enriched);
    io.to('preview').emit('gameGift', enriched);
}

async function connectToUser(username) {
    if (connecting) throw new Error('Đang kết nối, vui lòng chờ...');
    if (connection) { try { await connection.disconnect(); } catch (e) {} connection = null; }
    connecting = true;
    currentUsername = username.replace(/^@/, '').trim();
    try {
        connection = new TikTokLiveConnection(currentUsername, {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            fetchRoomInfoOnConnect: true
        });
        attachConnectionEvents(connection);
        const state = await connection.connect();
        currentRoomId = state?.roomId;
        return { ok: true, roomId: currentRoomId, username: currentUsername };
    } finally {
        connecting = false;
    }
}

// ====== Routes ======
app.get('/api/gifts', (req, res) => res.json(giftList));

app.get('/api/games', (req, res) => {
    const list = Object.values(GAMES).map(g => ({
        id: g.id, name: g.name, description: g.description, icon: g.icon,
        overlayPath: g.overlayPath,
        config: appConfig.games[g.id]
    }));
    res.json(list);
});

app.get('/api/games/:id/config', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    res.json(appConfig.games[g.id]);
});

app.post('/api/games/:id/config', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    appConfig.games[g.id] = { ...appConfig.games[g.id], ...(req.body || {}) };
    saveAppConfig();
    io.emit('gameConfig', { gameId: g.id, config: appConfig.games[g.id] });
    res.json({ ok: true, config: appConfig.games[g.id] });
});

// Cache trạng thái game từng game — đẩy lên overlay khi (re)connect VÀ push realtime mỗi POST.
// QUAN TRỌNG: app preview là authoritative source. Khi caughtList/policeForce/totalDiamonds đổi,
// app POST state → server cache + broadcast tới room 'overlay' → OBS gọi loadState → render lại.
// → OBS LUÔN khớp app, không bị stale, không cần Reset Browser trong OBS.
const gameStateCache = {};
app.post('/api/games/:id/state', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    gameStateCache[g.id] = req.body || {};
    // Live broadcast tới room 'overlay' (KHÔNG echo về 'preview' để tránh ghi đè edits đang gõ)
    io.to('overlay').emit('gameStateSnapshot', { gameId: g.id, state: gameStateCache[g.id] });
    res.json({ ok: true });
});
app.get('/api/games/:id/state', (req, res) => {
    res.json(gameStateCache[req.params.id] || null);
});

// Trả về version app hiện tại (KHÔNG còn expose GitHub repo)
app.get('/api/version', (req, res) => {
    try {
        const pkg = require('./package.json');
        res.json({ version: pkg.version, name: pkg.name });
    } catch (e) { res.json({ version: '0.0.0' }); }
});

// ============================================================
// AUTO-UPDATE: check + download + install
// ============================================================
// Flow:
//   1. App load → GET /api/update/check → so version với license-server
//   2. Có update → modal hỏi user
//   3. User OK → POST /api/update/download → server tải .exe + emit progress
//      qua socket → verify SHA256 → spawn installer silent → app.quit
// KHÔNG show URL ra UI, KHÔNG link GitHub.

app.get('/api/update/check', async (req, res) => {
    try {
        const pkg = require('./package.json');
        const localVer = pkg.version || '0.0.0';
        // Gọi license-server /api/version để biết phiên bản mới
        if (!isWorkerConfigured()) {
            // Test mode: không có license-server, skip update check
            return res.json({ ok: true, localVersion: localVer, hasUpdate: false, testMode: true });
        }
        const r = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 8000 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const remote = await r.json();
        if (!remote.ok || !remote.version) return res.json({ ok: true, localVersion: localVer, hasUpdate: false });
        const isNewer = cmpVersion(remote.version, localVer) > 0;
        res.json({
            ok: true,
            localVersion: localVer,
            hasUpdate: isNewer,
            latestVersion: remote.version,
            notes: remote.notes || '',
            size: remote.size || 0,
            sha256: remote.sha256 || ''
        });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

function cmpVersion(a, b) {
    const aP = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const bP = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(aP.length, bP.length); i++) {
        const da = aP[i] || 0, db = bP[i] || 0;
        if (da > db) return 1;
        if (da < db) return -1;
    }
    return 0;
}

// Lazy require electron app (chỉ có khi chạy trong electron, không có khi node thuần)
let _electronApp = null;
try { _electronApp = require('electron').app; } catch {}

let updateInProgress = false;

app.post('/api/update/download', async (req, res) => {
    if (updateInProgress) return res.json({ ok: false, error: 'Đang cập nhật, vui lòng đợi' });
    if (!isWorkerConfigured()) return res.json({ ok: false, error: 'Server cập nhật chưa cấu hình' });

    updateInProgress = true;
    res.json({ ok: true, started: true });   // Trả response ngay, download chạy background

    // Background process — emit progress qua socket
    (async () => {
        const sendProgress = (data) => io.emit('updateProgress', data);
        try {
            // Step 1: get metadata (size + sha256)
            sendProgress({ phase: 'connecting', percent: 0, message: 'Đang kết nối tới máy chủ cập nhật...' });
            const metaRes = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 8000 });
            const meta = await metaRes.json();
            if (!meta.ok || !meta.version) throw new Error('Không lấy được thông tin phiên bản');
            const expectedSize = meta.size || 0;
            const expectedSha = (meta.sha256 || '').toLowerCase();

            // Step 2: download installer to temp folder
            const os = require('os');
            const tempPath = path.join(os.tmpdir(), `hp-action-live-update-${meta.version}.exe`);
            sendProgress({ phase: 'downloading', percent: 0, message: 'Đang tải bản cập nhật...', total: expectedSize });

            const dlRes = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/download/installer', { timeout: 0 });
            if (!dlRes.ok) throw new Error('Tải về thất bại: HTTP ' + dlRes.status);

            const writer = fs.createWriteStream(tempPath);
            let received = 0;
            let lastEmit = 0;
            await new Promise((resolve, reject) => {
                dlRes.body.on('data', chunk => {
                    received += chunk.length;
                    const now = Date.now();
                    if (now - lastEmit > 200) {   // throttle progress to 5/sec
                        lastEmit = now;
                        const percent = expectedSize ? Math.min(99, Math.floor(received / expectedSize * 100)) : 0;
                        sendProgress({
                            phase: 'downloading',
                            percent,
                            received,
                            total: expectedSize,
                            message: `Đang tải... ${formatBytes(received)} / ${formatBytes(expectedSize)}`
                        });
                    }
                });
                dlRes.body.pipe(writer);
                dlRes.body.on('error', reject);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            sendProgress({ phase: 'verifying', percent: 99, message: 'Đang kiểm tra chữ ký số...' });

            // Step 3: verify SHA-256
            if (expectedSha) {
                const hash = crypto.createHash('sha256');
                await new Promise((resolve, reject) => {
                    const s = fs.createReadStream(tempPath);
                    s.on('data', d => hash.update(d));
                    s.on('end', resolve);
                    s.on('error', reject);
                });
                const actualSha = hash.digest('hex').toLowerCase();
                if (actualSha !== expectedSha) {
                    try { fs.unlinkSync(tempPath); } catch {}
                    throw new Error(`Checksum không khớp — file có thể bị lỗi hoặc giả mạo. (${actualSha.slice(0, 16)} ≠ ${expectedSha.slice(0, 16)})`);
                }
            }

            sendProgress({ phase: 'installing', percent: 100, message: 'Tải xong! Sẽ tự cài và khởi động lại...' });

            // Step 4: spawn installer with delay + silent flag, then quit app
            // NSIS /S = silent install. ping -n 3 = delay ~2s để app hiện tại kịp exit
            // trước khi installer cố ghi đè .exe (Windows không cho overwrite running .exe).
            const { spawn } = require('child_process');
            const cmd = `ping -n 3 127.0.0.1 > nul && "${tempPath}" /S`;
            spawn('cmd.exe', ['/c', cmd], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            }).unref();

            // Cho UI 1.5s để render message xong rồi mới quit
            setTimeout(() => {
                if (_electronApp) {
                    try { _electronApp.exit(0); } catch (e) { process.exit(0); }
                } else process.exit(0);
            }, 1500);
        } catch (e) {
            io.emit('updateProgress', { phase: 'error', percent: 0, message: 'Lỗi: ' + e.message });
            updateInProgress = false;
        }
    })();
});

function formatBytes(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
}

app.get('/api/last-user', (req, res) => {
    res.json({ username: appConfig.lastUsername || '' });
});

// ===== License gate API =====
app.get('/api/license/status', async (req, res) => {
    const stored = appConfig.license || {};
    if (!stored.activated || !stored.key) {
        return res.json({ activated: false });
    }
    // Re-validate against sheet để bắt admin revoke kịp thời (cache 5 phút)
    try {
        const result = await validateLicenseKey(stored.key);
        if (result.ok) {
            // Cập nhật info mới nhất từ sheet (role có thể đổi server-side)
            appConfig.license = {
                ...stored,
                vip: result.vip,
                role: result.role || 'ADMIN',
                expiry: result.expiry,
                note: result.note,
                lastValidated: Date.now()
            };
            saveAppConfig();
            return res.json({
                activated: true,
                key: result.key,
                role: result.role || 'ADMIN',
                vip: result.vip,
                expiry: result.expiry,
                note: result.note
            });
        }
        // Sheet nói invalid (admin đã revoke / key đã expire)
        if (result._offline) {
            // Cho phép offline tối đa 24h kể từ lần validate cuối
            const lastValid = stored.lastValidated || 0;
            if (Date.now() - lastValid < 24 * 3600 * 1000) {
                return res.json({
                    activated: true,
                    key: stored.key,
                    role: stored.role || 'ADMIN',
                    vip: stored.vip || 'Thường',
                    expiry: stored.expiry || '',
                    offline: true,
                    note: 'Offline grace period'
                });
            }
        }
        // Revoke
        appConfig.license = { activated: false, lastError: result.error };
        saveAppConfig();
        return res.json({ activated: false, error: result.error });
    } catch (e) {
        return res.json({ activated: false, error: e.message });
    }
});

app.post('/api/license/activate', async (req, res) => {
    const key = (req.body && req.body.key) || '';
    const result = await validateLicenseKey(key);
    if (!result.ok) return res.json(result);
    appConfig.license = {
        activated: true,
        key: result.key,
        role: result.role || 'ADMIN',          // ADMIN | CREATOR
        vip: result.vip,
        expiry: result.expiry,
        note: result.note,
        activatedAt: Date.now(),
        lastValidated: Date.now()
    };
    saveAppConfig();
    res.json(result);
});

app.post('/api/license/deactivate', (req, res) => {
    appConfig.license = { activated: false };
    saveAppConfig();
    res.json({ ok: true });
});

// Endpoint refresh-sheet đã bỏ — cache key giờ ở Worker phía Cloudflare (TTL 60s tự refresh).
// Không cần admin endpoint trên app side để force reload.
app.post('/api/license/refresh-sheet', async (req, res) => {
    res.json({ ok: true, note: 'Key cache giờ do Cloudflare Worker quản lý (TTL 60s tự refresh)' });
});

app.post('/api/reload-gifts', async (req, res) => {
    try { await loadGiftSheet(); res.json({ ok: true, count: giftList.length }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/connect', async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ ok: false, error: 'Thiếu username' });
    const cleanName = String(username).replace(/^@/, '').trim();

    // === CREATOR role enforcement ===
    // Với role=CREATOR: KEY column A chính là TikTok ID. User phải connect với
    // TikTok username TRÙNG khớp key đang active.
    // Nếu khác → reject. User phải liên hệ HP Media (đổi key tương ứng TikTok ID mới).
    const lic = appConfig.license || {};
    if (lic.activated && lic.role === 'CREATOR' && lic.key) {
        const boundId = String(lic.key).replace(/^@/, '').toLowerCase().trim();
        if (cleanName.toLowerCase() !== boundId) {
            return res.status(403).json({
                ok: false,
                error: 'Bạn đã thay đổi TikTok ID hoặc nhập sai\nLIÊN HỆ HP MEDIA ĐỂ ĐƯỢC HỖ TRỢ',
                _creatorLocked: true,
                boundTiktokId: lic.key
            });
        }
    }

    // Lưu lastUsername (kể cả LIVE chưa bật) — tiện auto-fill lần sau
    if (cleanName) {
        appConfig.lastUsername = cleanName;
        saveAppConfig();
    }
    try {
        const result = await connectToUser(username);
        res.json(result);
    }
    catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});

app.post('/api/disconnect', async (req, res) => {
    try {
        if (connection) await connection.disconnect();
        connection = null; currentUsername = null; currentRoomId = null;
        broadcast('status', { connected: false });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Gửi lệnh điều khiển game (thief, fireworks, tornado...) tới mọi overlay
app.post('/api/games/:id/cmd', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    const { cmd, payload } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false, error: 'Thiếu cmd' });
    io.emit('gameCmd', { gameId: g.id, cmd, payload: payload || null });
    res.json({ ok: true });
});

// Test-spawn a gift (manual drop from UI)
app.post('/api/games/:id/test-gift', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    const body = req.body || {};
    const giftId = String(body.giftId || '');
    const sheetItem = giftMap[giftId];
    const repeatCount = parseInt(body.count, 10) || 1;
    emitGift({
        uniqueId: body.uniqueId || 'tester',
        nickname: body.nickname || 'Test',
        giftId,
        giftName: sheetItem?.name || body.giftName || 'Gift',
        giftPicture: sheetItem?.image,
        diamondCount: sheetItem?.diamond,
        repeatCount,
        source: 'test'
    });
    res.json({ ok: true });
});

// OBS overlay (transparent fullpage)
app.get('/overlay/thuytinh', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'thuytinh', 'overlay.html'));
});

// Default index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====== Socket rooms ======
io.on('connection', (socket) => {
    // Default emits
    socket.emit('giftSheet', giftList);
    socket.emit('status', { connected: !!(connection && connection.isConnected), username: currentUsername, roomId: currentRoomId });

    socket.on('subscribe', (roomName) => {
        if (typeof roomName === 'string' && roomName.length < 32) {
            socket.join(roomName);
            // Khi overlay/preview subscribe → gửi BOTH config + state snapshot.
            // Trước đây chỉ gửi state → OBS có thể render với default config (race).
            // Giờ gửi config trước, state sau → OBS apply config → loadState → khớp App.
            if (roomName === 'overlay' || roomName === 'preview') {
                for (const gid of Object.keys(GAMES)) {
                    // Config trước — overlay setConfig để pick up đúng features/jar position
                    socket.emit('gameConfig', { gameId: gid, config: appConfig.games[gid] });
                    // State sau — loadState để khôi phục caughtList/policeForce/totals
                    if (gameStateCache[gid]) {
                        socket.emit('gameStateSnapshot', { gameId: gid, state: gameStateCache[gid] });
                    }
                }
            }
        }
    });
});

httpServer.listen(PORT, async () => {
    console.log(`[server] HP Action LIVE chạy tại http://localhost:${PORT}`);
    try { await loadGiftSheet(); }
    catch (e) { console.warn('[server] Không tải được Google Sheet:', e.message); }
});

// Export cho electron-main.js gọi httpServer.close() khi quit
module.exports = { httpServer, app, io };

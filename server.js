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

// === LICENSE VALIDATION qua server riêng ===
// App KHÔNG fetch Google Sheet KEY_HP_GAME trực tiếp (tránh lộ Sheet ID + bulk-scrape).
// License server (license-server/ hoặc cloudflare-worker/) đứng giữa: nhận key → đọc Sheet
// (server-side, Sheet ID ẩn) → trả về kết quả validate.
// Bảo mật đường truyền: HTTPS (BẮT BUỘC trong production).
//
// Deploy server (xem license-server/README.md hoặc cloudflare-worker/README.md),
// sau đó update URL bên dưới + rebuild app.
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://hp-license.YOUR-DOMAIN.workers.dev';   // ← UPDATE sau khi deploy server
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

async function validateLicenseKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'Vui lòng nhập key bản quyền' };

    // Cảnh báo nếu chưa cấu hình URL server
    if (LICENSE_WORKER_URL.includes('YOUR-DOMAIN') || LICENSE_WORKER_URL.includes('YOUR-CF-USERNAME')) {
        console.warn('[license] Server URL chưa được cấu hình. Update LICENSE_WORKER_URL trong server.js.');
        return { ok: false, error: 'Hệ thống bản quyền chưa được cấu hình. Vui lòng liên hệ HP Media.' };
    }

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

    // Server từ chối
    if (!body || body.ok === false) {
        return { ok: false, error: body?.error || 'Key không hợp lệ' };
    }

    // Sanity check expiry trên app (defense in depth)
    if (body.expiryISO && new Date(body.expiryISO).getTime() < Date.now()) {
        return { ok: false, error: `Key đã hết hạn từ ${body.expiry || body.expiryISO}` };
    }

    return {
        ok: true,
        key: body.key,
        role: body.role || 'ADMIN',            // ADMIN | CREATOR
        vip: body.vip || body.role || '',      // text display: VIP / Thường / ADMIN / CREATOR
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

// Trả về version app hiện tại + tên GitHub repo để client check update
app.get('/api/version', (req, res) => {
    try {
        const pkg = require('./package.json');
        res.json({
            version: pkg.version,
            name: pkg.name,
            repo: 'hpmediaoffifical/hp-tiktok-game'
        });
    } catch (e) { res.json({ version: '0.0.0', repo: '' }); }
});

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

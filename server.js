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

// === Mọi data source đi qua license-server (HP Media kiểm soát) ===
// App không biết thông tin backend → installer .exe extract ra cũng không lộ gì.
// PRODUCTION URL hardcoded — luôn dùng (không có fallback đọc trực tiếp data nguồn).
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://hp-license.nguyenvu.dev';   // license-server production
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

// Static files: tắt cache cho JS/CSS/HTML để Electron renderer luôn nhận file mới
// sau khi app update (tránh tình trạng renderer cache code cũ → tính năng mới không hiện).
// Ảnh/assets vẫn được cache bình thường (max-age 1h) cho hiệu năng.
app.use((req, res, next) => {
    const p = req.path;
    if (/\.(js|css|html)$/i.test(p)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
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
    },
    caro: {
        id: 'caro',
        name: 'Caro Đối Đầu',
        description: 'Idol đấu Caro với khán giả — user bình luận tọa độ (vd "9F") để đánh.',
        icon: '🎯',
        overlayPath: '/overlay/caro',
        defaultConfig: {
            board: { cols: 12, rows: 12, winLength: 5 },
            match: { bestOf: 3, idolFirst: true, alternateFirst: true },
            registration: { giftId: '', minCount: 1, autoCloseSeconds: 0 },
            undo: { window: 30, maxPerRound: 3, mode: 'idol', giftId: '', cooldown: 60 },
            turnTimer: 0,
            practiceMode: false,
            rolling: { enabled: false, tokensPerSide: 3 },
            audio: { enabled: true, volume: 50 },
            colors: { idol: '#25F4EE', user: '#FE2C55' },
            display: {
                showHistory: true, showInfo: true,
                scale: 100, xPercent: 50, yPercent: 50,
                cellHints: false, cellHintOpacity: 35
            }
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

// ====== Gift list loader (via license-server proxy) ======
let giftMap = {};
let giftList = [];

async function loadGiftSheet() {
    if (!isWorkerConfigured()) {
        console.error('[gift-sheet] LICENSE_WORKER_URL chưa cấu hình — không thể tải gift sheet');
        giftList = []; giftMap = {};
        io.emit('giftSheet', giftList);
        return giftList;
    }
    console.log('[gift-sheet] Tải danh sách quà qua license-server...');
    const url = LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/gift-sheet';
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`License-server HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok || !Array.isArray(body.gifts)) {
        throw new Error('License-server response invalid');
    }
    giftList = body.gifts;
    giftMap = {};
    for (const g of giftList) {
        if (g && g.id) giftMap[String(g.id)] = g;
    }
    console.log(`[gift-sheet] Đã tải ${giftList.length} quà.`);
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

    if (!isWorkerConfigured()) {
        return { ok: false, error: 'Hệ thống bản quyền chưa cấu hình — liên hệ HP Media' };
    }

    // Gọi license-server (HP Media). Không có fallback đọc data nguồn trực tiếp.
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

// ====== Unknown gifts detector ======
// Khi TikTok đẩy gift event với giftId KHÔNG có trong Google Sheet → ghi nhận để user
// biết và bổ sung sau. Persist sang đĩa để không mất qua restart.
// Schema mỗi entry: { id, name, image, diamond, count, firstSeen, lastSeen }
const UNKNOWN_GIFTS_FILE = path.join(DATA_DIR, 'unknown-gifts.json');
let unknownGifts = {};   // id (string) → entry
function loadUnknownGifts() {
    try {
        if (fs.existsSync(UNKNOWN_GIFTS_FILE)) {
            unknownGifts = JSON.parse(fs.readFileSync(UNKNOWN_GIFTS_FILE, 'utf8')) || {};
        }
    } catch (e) { unknownGifts = {}; }
}
function saveUnknownGifts() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(UNKNOWN_GIFTS_FILE, JSON.stringify(unknownGifts, null, 2));
    } catch (e) { /* non-fatal */ }
}
loadUnknownGifts();
// Debounce ghi đĩa — gift events có thể đến dồn dập, không cần flush mỗi event
let _unknownSaveTimer = null;
function scheduleSaveUnknown() {
    clearTimeout(_unknownSaveTimer);
    _unknownSaveTimer = setTimeout(saveUnknownGifts, 1500);
}
// Tra cứu metadata gift từ availableGifts (do TikTok API trả về sau connect).
// Trả về { name, image, diamond } nếu tìm thấy giftId, ngược lại null.
function lookupGiftFromTikTok(id) {
    if (!connection || !connection.availableGifts) return null;
    const list = connection.availableGifts;
    // availableGifts có thể là array hoặc object — handle cả 2 case
    const items = Array.isArray(list) ? list : Object.values(list || {});
    const target = items.find(g => String(g.id) === String(id));
    if (!target) return null;
    // Schema TikTok: { id, name, diamond_count, image: { url_list: [...] }, icon: { url_list: [...] } }
    const imgUrls = target.image?.url_list || target.icon?.url_list || [];
    return {
        name: target.name || '',
        image: imgUrls[0] || '',
        diamond: target.diamond_count || 0
    };
}

function recordUnknownGift(g) {
    const id = String(g.giftId || '').trim();
    if (!id) return null;
    // Đã có trong sheet → skip
    if (giftMap[id]) return null;
    // Thử fallback từ availableGifts của TikTok nếu event đến mà thiếu name/picture
    // (xảy ra với streak gift hoặc khi giftDetails chưa flush) — tra cứu trong cache
    // sẽ điền vào những field còn trống.
    const tt = lookupGiftFromTikTok(id);
    const resolvedName = g.giftName || tt?.name || '';
    const resolvedImage = g.giftPicture || tt?.image || '';
    const resolvedDiamond = parseInt(g.diamondCount, 10) || tt?.diamond || 0;
    // Cần ít nhất 1 trong (name | picture) để hữu ích — tránh ghi entry rỗng hoàn toàn
    if (!resolvedName && !resolvedImage) return null;
    const now = Date.now();
    const prev = unknownGifts[id];
    if (prev) {
        prev.count = (prev.count || 0) + (parseInt(g.repeatCount, 10) || 1);
        prev.lastSeen = now;
        // Update các field nếu lần này có thông tin tốt hơn
        if (!prev.name && resolvedName) prev.name = resolvedName;
        if (!prev.image && resolvedImage) prev.image = resolvedImage;
        if ((!prev.diamond || prev.diamond <= 0) && resolvedDiamond > 0) prev.diamond = resolvedDiamond;
    } else {
        unknownGifts[id] = {
            id,
            name: resolvedName,
            image: resolvedImage,
            diamond: resolvedDiamond,
            count: parseInt(g.repeatCount, 10) || 1,
            firstSeen: now,
            lastSeen: now
        };
    }
    scheduleSaveUnknown();
    // Emit realtime để App show badge ngay
    io.emit('unknownGift', { entry: unknownGifts[id], total: Object.keys(unknownGifts).length });
    return unknownGifts[id];
}

// Quét toàn bộ unknownGifts hiện có, điền lại name/image/diamond từ availableGifts
// (gọi khi user bấm "🔄 Dò icon" hoặc sau khi reconnect).
function refreshUnknownGiftsFromTikTok() {
    if (!connection || !connection.availableGifts) {
        return { ok: false, error: 'Chưa kết nối LIVE — không có availableGifts để tra' };
    }
    let updated = 0;
    for (const id of Object.keys(unknownGifts)) {
        const tt = lookupGiftFromTikTok(id);
        if (!tt) continue;
        const e = unknownGifts[id];
        let touched = false;
        if (!e.name && tt.name) { e.name = tt.name; touched = true; }
        if (!e.image && tt.image) { e.image = tt.image; touched = true; }
        if ((!e.diamond || e.diamond <= 0) && tt.diamond > 0) { e.diamond = tt.diamond; touched = true; }
        if (touched) {
            updated++;
            io.emit('unknownGift', { entry: e, total: Object.keys(unknownGifts).length });
        }
    }
    if (updated > 0) scheduleSaveUnknown();
    return { ok: true, updated, total: Object.keys(unknownGifts).length };
}

function emitGift(g) {
    const sheetItem = giftMap[String(g.giftId)] || null;
    // Quà unknown → ghi vào danh sách phát hiện được
    if (!sheetItem) recordUnknownGift(g);
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
        // Sau khi connect → connection.availableGifts có sẵn metadata cho mọi gift trong room.
        // Quét lại các unknown entry cũ thiếu icon/name → điền từ TikTok metadata cache.
        // Chạy sau 500ms để chắc availableGifts đã fully load.
        setTimeout(() => {
            try {
                const r = refreshUnknownGiftsFromTikTok();
                if (r.ok && r.updated > 0) {
                    console.log(`[unknown-gifts] Tự dò TikTok metadata → điền ${r.updated} entry thiếu.`);
                }
            } catch (e) { /* non-fatal */ }
        }, 500);
        return { ok: true, roomId: currentRoomId, username: currentUsername };
    } finally {
        connecting = false;
    }
}

// ====== Routes ======
app.get('/api/gifts', (req, res) => res.json(giftList));

// ===== Unknown gifts API (quà mới phát hiện ngoài Google Sheet) =====
// Trả về sorted theo lastSeen DESC để quà vừa thấy nằm trên cùng.
app.get('/api/unknown-gifts', (req, res) => {
    const list = Object.values(unknownGifts).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.json({ list, total: list.length });
});
// Xoá 1 entry (sau khi user đã add vào Google Sheet)
app.delete('/api/unknown-gifts/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (unknownGifts[id]) {
        delete unknownGifts[id];
        scheduleSaveUnknown();
        io.emit('unknownGiftCleared', { id, total: Object.keys(unknownGifts).length });
    }
    res.json({ ok: true, total: Object.keys(unknownGifts).length });
});
// Xoá toàn bộ — dùng khi user reload Google Sheet và muốn reset.
// Có option ?keepStillUnknown=1 → giữ lại các entry vẫn không có trong sheet sau reload.
app.post('/api/unknown-gifts/clear', (req, res) => {
    const keepStillUnknown = req.query.keepStillUnknown === '1' || req.body?.keepStillUnknown;
    if (keepStillUnknown) {
        // Sau reload sheet, các giftId đã có trong giftMap có thể xoá khỏi unknown.
        let removed = 0;
        for (const id of Object.keys(unknownGifts)) {
            if (giftMap[id]) { delete unknownGifts[id]; removed++; }
        }
        scheduleSaveUnknown();
        io.emit('unknownGiftCleared', { all: false, removed, total: Object.keys(unknownGifts).length });
        return res.json({ ok: true, removed, total: Object.keys(unknownGifts).length });
    }
    unknownGifts = {};
    scheduleSaveUnknown();
    io.emit('unknownGiftCleared', { all: true, total: 0 });
    res.json({ ok: true, removed: 'all', total: 0 });
});
// Tra cứu metadata từ TikTok availableGifts để điền name/image cho các entry bị thiếu
// (vd: streak gift đến mà event không có giftPicture URL).
app.post('/api/unknown-gifts/refresh-from-tiktok', (req, res) => {
    const r = refreshUnknownGiftsFromTikTok();
    res.json(r);
});

// ===== SCAN: rà soát TOÀN BỘ availableGifts của TikTok room hiện tại so với Google Sheet.
// Logic: với mỗi gift trong availableGifts → check giftMap[id]. Nếu KHÔNG có trong Sheet
// và có đủ name/image → thêm vào unknownGifts (source='scan'). Trả về thống kê.
// → User bấm "📋 Copy all" để batch copy → paste 1 lần vào Sheet.
app.post('/api/scan-tiktok-gifts', (req, res) => {
    if (!connection || !connection.availableGifts) {
        return res.status(400).json({ ok: false, error: 'Chưa kết nối LIVE — không có availableGifts để rà soát. Bấm "Kết nối LIVE" trước.' });
    }
    const items = Array.isArray(connection.availableGifts)
        ? connection.availableGifts
        : Object.values(connection.availableGifts || {});
    const stats = { scanned: items.length, existing: 0, added: 0, updated: 0, skipped: 0 };
    const now = Date.now();
    for (const g of items) {
        const id = String(g.id || '').trim();
        if (!id) { stats.skipped++; continue; }
        if (giftMap[id]) { stats.existing++; continue; }
        const imgUrls = g.image?.url_list || g.icon?.url_list || [];
        const name = g.name || '';
        const image = imgUrls[0] || '';
        const diamond = g.diamond_count || 0;
        if (!name && !image) { stats.skipped++; continue; }
        if (unknownGifts[id]) {
            // Đã từng phát hiện (live event) → chỉ refresh thông tin
            const prev = unknownGifts[id];
            let touched = false;
            if (!prev.name && name) { prev.name = name; touched = true; }
            if (!prev.image && image) { prev.image = image; touched = true; }
            if ((!prev.diamond || prev.diamond <= 0) && diamond > 0) { prev.diamond = diamond; touched = true; }
            prev.lastSeen = now;
            if (touched) stats.updated++; else stats.existing++;   // count "existing" cho entries không cần đổi
        } else {
            // Quà mới — chưa có trong Sheet, cũng chưa từng nhận event
            unknownGifts[id] = {
                id, name, image, diamond,
                count: 0,        // chưa có event nào, chỉ rà từ catalog
                firstSeen: now,
                lastSeen: now,
                source: 'scan'   // đánh dấu để UI hiển thị khác (vd: "từ scan")
            };
            stats.added++;
        }
    }
    if (stats.added > 0 || stats.updated > 0) {
        scheduleSaveUnknown();
        // Emit toàn bộ snapshot — App refetch để render đúng
        io.emit('unknownGiftCleared', { all: false, removed: 0, total: Object.keys(unknownGifts).length });
    }
    stats.totalUnknown = Object.keys(unknownGifts).length;
    res.json({ ok: true, ...stats });
});
// Lookup 1 giftId ngay cả khi CHƯA có trong unknownGifts (user nhập ID thủ công từ UI).
app.get('/api/tiktok-gift/:id', (req, res) => {
    const id = String(req.params.id || '');
    const tt = lookupGiftFromTikTok(id);
    if (!tt) return res.status(404).json({ ok: false, error: 'Không tìm thấy gift ID này trong availableGifts (cần đang kết nối LIVE)' });
    res.json({ ok: true, id, ...tt });
});
// Proxy tải icon: server fetch ảnh từ TikTok CDN rồi stream về client (tránh CORS khi
// download trực tiếp từ browser).
app.get('/api/unknown-gifts/:id/image', async (req, res) => {
    const id = String(req.params.id || '');
    const entry = unknownGifts[id];
    if (!entry || !entry.image) return res.status(404).json({ ok: false, error: 'Không có ảnh' });
    try {
        const r = await fetch(entry.image);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const ct = r.headers.get('content-type') || 'image/png';
        // Suffix file theo content-type
        const ext = ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : 'jpg';
        const safeName = (entry.name || ('gift-' + id)).replace(/[^\w\-]+/g, '_').slice(0, 40);
        res.setHeader('Content-Type', ct);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${id}.${ext}"`);
        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

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
// KHÔNG show URL, KHÔNG link GitHub trong code (repo có thể private — token không nhúng
// vào installer để tránh leak khi attacker extract .exe).
// Auto-update chỉ qua license-server kiểm soát bởi HP Media.

app.get('/api/update/check', async (req, res) => {
    try {
        const pkg = require('./package.json');
        const localVer = pkg.version || '0.0.0';

        if (!isWorkerConfigured()) {
            return res.json({
                ok: false,
                localVersion: localVer,
                error: 'Máy chủ cập nhật chưa cấu hình — liên hệ HP Media'
            });
        }
        try {
            const r = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 8000 });
            if (r.ok) {
                const remote = await r.json();
                if (remote.ok && remote.version) {
                    const isNewer = cmpVersion(remote.version, localVer) > 0;
                    return res.json({
                        ok: true, localVersion: localVer, hasUpdate: isNewer,
                        latestVersion: remote.version, notes: remote.notes || '',
                        size: remote.size || 0, sha256: remote.sha256 || '',
                        source: 'license-server'
                    });
                }
            }
            // Server reachable nhưng chưa có version published → coi như đang dùng latest
            return res.json({ ok: true, localVersion: localVer, hasUpdate: false });
        } catch (e) {
            return res.json({
                ok: false,
                localVersion: localVer,
                error: 'Không kết nối được máy chủ cập nhật — thử lại sau'
            });
        }
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
    updateInProgress = true;
    res.json({ ok: true, started: true });   // Trả response ngay, download chạy background

    // Background process — emit progress qua socket
    (async () => {
        const sendProgress = (data) => io.emit('updateProgress', data);
        try {
            sendProgress({ phase: 'connecting', percent: 0, message: 'Đang kết nối tới máy chủ cập nhật...' });

            // === Tải về CHỈ qua license-server (không dùng GitHub fallback để tránh
            // lộ URL/token; private repo không thể fetch unauth) ===
            let downloadUrl, expectedSize = 0, expectedSha = '', version = 'latest';

            if (!isWorkerConfigured()) {
                throw new Error('Máy chủ cập nhật chưa cấu hình');
            }
            const metaRes = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 8000 });
            const meta = await metaRes.json();
            if (!meta.ok || !meta.version) {
                throw new Error('Máy chủ cập nhật chưa có phiên bản nào published');
            }
            downloadUrl = LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/download/installer';
            expectedSize = meta.size || 0;
            expectedSha = (meta.sha256 || '').toLowerCase();
            version = meta.version;

            // Step 2: download installer to temp folder
            const os = require('os');
            const tempPath = path.join(os.tmpdir(), `hp-action-live-update-${version}.exe`);
            sendProgress({ phase: 'downloading', percent: 0, message: 'Đang tải bản cập nhật...', total: expectedSize });

            const dlRes = await fetch(downloadUrl, { timeout: 0 });
            if (!dlRes.ok) throw new Error('Tải về thất bại: HTTP ' + dlRes.status);

            const writer = fs.createWriteStream(tempPath);
            let received = 0;
            let lastEmit = 0;
            const startedAt = Date.now();
            let lastSampleAt = startedAt;
            let lastSampleBytes = 0;
            let smoothedSpeed = 0;   // EMA cho tốc độ — tránh nhảy số khi network jitter
            await new Promise((resolve, reject) => {
                dlRes.body.on('data', chunk => {
                    received += chunk.length;
                    const now = Date.now();
                    if (now - lastEmit > 200) {   // throttle progress to 5/sec
                        lastEmit = now;
                        const percent = expectedSize ? Math.min(99, Math.floor(received / expectedSize * 100)) : 0;
                        // Tính tốc độ tức thời từ sample 1s gần nhất
                        const sampleDt = (now - lastSampleAt) / 1000;
                        const sampleBytes = received - lastSampleBytes;
                        const instantSpeed = sampleDt > 0 ? sampleBytes / sampleDt : 0;
                        smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.7 + instantSpeed * 0.3 : instantSpeed;
                        lastSampleAt = now;
                        lastSampleBytes = received;
                        // ETA
                        const remaining = expectedSize - received;
                        const etaSec = smoothedSpeed > 1024 ? Math.ceil(remaining / smoothedSpeed) : null;
                        sendProgress({
                            phase: 'downloading',
                            percent,
                            received,
                            total: expectedSize,
                            speed: smoothedSpeed,
                            eta: etaSec,
                            message: `${formatBytes(received)} / ${formatBytes(expectedSize)}  •  ${formatBytes(smoothedSpeed)}/s${etaSec != null ? '  •  còn ~' + formatEta(etaSec) : ''}`
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

            // === Step 4: Launch installer via VBS helper (hoàn toàn ẩn) ===
            // VBS WScript chạy hidden by design — không có console window flash như cmd.exe.
            // VBS sẽ:
            //   1. Đợi 3s cho electron app exit + giải phóng file lock
            //   2. Chạy installer /S (silent NSIS install) VÀ WAIT cho complete
            //   3. Launch app vừa cài lại (vì NSIS wizard mode không trigger runAfterFinish)
            //   4. Self-cleanup VBS + temp installer
            //   5. Log mọi step vào %TEMP%\hp-update-log.txt để debug nếu fail
            const { spawn } = require('child_process');
            const exePath = _electronApp ? _electronApp.getPath('exe') : '';
            const logPath = path.join(os.tmpdir(), 'hp-update-log.txt');
            const vbsPath = path.join(os.tmpdir(), `hp-update-launch-${version}.vbs`);

            // Escape backslashes + double quotes cho VBS string literal
            const escVbs = s => String(s).replace(/"/g, '""');
            const vbsContent = `' HP Action LIVE — Auto-update launcher
On Error Resume Next

Set fso = CreateObject("Scripting.FileSystemObject")
Set log = fso.OpenTextFile("${escVbs(logPath)}", 2, True)
log.WriteLine "[" & Now & "] Bắt đầu update launcher"

' Đợi app cũ exit + Windows release file lock
log.WriteLine "[" & Now & "] Sleep 3000ms..."
WScript.Sleep 3000

Set objShell = CreateObject("WScript.Shell")

' Chạy installer silent (mode 0 = hidden window, True = wait for completion)
log.WriteLine "[" & Now & "] Chạy installer: ${escVbs(tempPath)} /S"
installerExit = objShell.Run("""${escVbs(tempPath)}"" /S", 0, True)
log.WriteLine "[" & Now & "] Installer kết thúc, exit code: " & installerExit

' Sleep ngắn để Windows finalize file system
WScript.Sleep 1500

' Launch app vừa cài (oneClick: false + /S không tự launch — phải làm manual)
If "${escVbs(exePath)}" <> "" Then
    log.WriteLine "[" & Now & "] Launch app: ${escVbs(exePath)}"
    objShell.Run """${escVbs(exePath)}""", 1, False
End If

' Cleanup temp files (best effort)
WScript.Sleep 500
fso.DeleteFile "${escVbs(tempPath)}", True
fso.DeleteFile WScript.ScriptFullName, True

log.WriteLine "[" & Now & "] Done."
log.Close
`;

            fs.writeFileSync(vbsPath, vbsContent, 'utf8');

            // wscript.exe runs VBS — wscript chạy detached + no console by default
            spawn('wscript.exe', [vbsPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            }).unref();

            // Cho UI 1.5s render message xong rồi mới quit
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

function formatEta(sec) {
    if (!sec || sec < 0) return '—';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m${s ? ' ' + s + 's' : ''}`;
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
    try {
        await loadGiftSheet();
        // Sau khi sheet được cập nhật, dọn các unknown gift hiện đã có trong sheet
        let cleaned = 0;
        for (const id of Object.keys(unknownGifts)) {
            if (giftMap[id]) { delete unknownGifts[id]; cleaned++; }
        }
        if (cleaned > 0) {
            scheduleSaveUnknown();
            io.emit('unknownGiftCleared', { all: false, removed: cleaned, total: Object.keys(unknownGifts).length });
        }
        res.json({ ok: true, count: giftList.length, cleanedUnknown: cleaned });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
app.get('/overlay/caro', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'caro', 'overlay.html'));
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

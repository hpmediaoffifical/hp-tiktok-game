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
            enabled: true,
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
            enabled: true,
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
    },
    pktiktok: {
        id: 'pktiktok',
        name: 'Hiệu ứng PK',
        description: 'Gán video/âm thanh cho từng phase trận PK TikTok (start, x2/x3, items, 10s cuối, thắng/thua).',
        icon: '🥊',
        overlayPath: '/overlay/pktiktok',
        defaultConfig: makeDefaultPkTiktokConfig()
    },
    vipwelcome: {
        id: 'vipwelcome',
        name: 'Chào Mừng VIP',
        description: 'Phát video/âm thanh khi user vào phòng LIVE hoặc khi user tặng quà — theo TikTok ID hoặc theo cấp độ.',
        icon: '🎊',
        overlayPath: '/overlay/vipwelcome',
        defaultConfig: makeDefaultVipWelcomeConfig()
    }
};

// 13 events default — đồng bộ với HpGame.pktiktok.defaultConfig() trong client engine.
function makeDefaultPkTiktokConfig() {
    const defs = [
        { key: 'start',    label: 'BẮT ĐẦU PK',           emoji: '🚀', desc: 'Đếm ngược khi bắt đầu trận' },
        { key: 'mission',  label: 'NHIỆM VỤ XUẤT HIỆN',   emoji: '📋', desc: 'Popup nhiệm vụ bonus' },
        { key: 'x2',       label: 'X2 ĐIỂM (Speed)',      emoji: '⚡', desc: 'Bonus mission unlock nhân 2' },
        { key: 'x3',       label: 'X3 ĐIỂM (Speed mạnh)', emoji: '🔥', desc: 'Bonus mission unlock nhân 3' },
        { key: 'glove',    label: 'ITEM Găng Tay',        emoji: '🥊', desc: 'Boosting Glove — 30% chance x5' },
        { key: 'mist',     label: 'ITEM Sương Mù',        emoji: '🌫️', desc: 'Magic Mist phủ đối thủ' },
        { key: 'hammer',   label: 'ITEM Búa Choáng',      emoji: '🔨', desc: 'Stun Hammer trong victory lap' },
        { key: 'time',     label: 'ITEM Thêm Giờ',        emoji: '⏱️', desc: 'Time-Maker' },
        { key: 'warn10s',  label: '10 GIÂY CUỐI',         emoji: '⚠️', desc: 'Đồng hồ chuyển đỏ' },
        { key: 'lead',     label: 'ĐANG DẪN ĐIỂM',        emoji: '📈', desc: 'Đội nhà > đội đối thủ' },
        { key: 'behind',   label: 'ĐANG THUA ĐIỂM',       emoji: '📉', desc: 'Đội nhà < đội đối thủ' },
        { key: 'win',      label: 'KẾT QUẢ: THẮNG',       emoji: '🏆', desc: 'Vinh quang chiến thắng' },
        { key: 'lose',     label: 'KẾT QUẢ: THUA',        emoji: '💔', desc: 'Thất bại' },
    ];
    return {
        enabled: true,
        autoBindPkDuo: true,
        events: defs.map(d => ({
            ...d, mediaUrl: '', mediaName: '', mediaType: '',
            volume: 100, playbackRate: 1.0, interruptCurrent: true, enabled: true,
        })),
        display: { scale: 100, xPercent: 50, yPercent: 50, showLabel: false },
    };
}

// VIP Welcome — default config: nhiều "Nhóm hồ sơ" (profiles) — mỗi nhóm có tên + bật/tắt riêng.
// Nhiều người chia chung máy có thể tạo nhóm riêng. Khi nhiều nhóm cùng "Bật" — server gộp rule từ
// tất cả nhóm enabled (mỗi nhóm độc lập cooldown qua ruleId namespacing 'p:<profileId>:...').
function makeDefaultVipWelcomeProfile(name) {
    return {
        id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name || 'Nhóm mặc định',
        enabled: true,
        userRules: [],          // [{ id, uniqueId, trigger, mediaUrl, mediaName, mediaType, volume, message, minLevel, minDiamond, enabled }]
        globalJoin: {
            enabled: false,
            mediaUrl: '', mediaName: '', mediaType: '',
            volume: 100,
            message: 'Chào mừng {nickname} (cấp {level}) đã ghé phòng!',
            minLevel: 30,
            requireVerified: false    // Chỉ phát cho TikTok có tích xanh
        },
        globalGift: {
            enabled: false,
            mediaUrl: '', mediaName: '', mediaType: '',
            volume: 100,
            message: 'Chúc mừng {nickname} vừa lên cấp {level}!',
            minLevel: 30,
            requireVerified: false
        }
    };
}

function makeDefaultVipWelcomeConfig() {
    const def = makeDefaultVipWelcomeProfile('Nhóm mặc định');
    return {
        enabled: true,
        activeProfileId: def.id,           // panel đang edit profile nào
        profiles: [def],
        queue: {
            maxLen: 20,
            perUserCooldownSec: 60,
            perItemMinMs: 200,           // 200ms — overlay tự queue + play serial nên không cần pace cao
            rejoinThresholdSec: 60        // 60s — vắng mặt N giây = coi như rời phòng → re-fire khi vào lại
        },
        display: {
            scale: 100, xPercent: 50, yPercent: 50,
            showText: true,
            textPosition: 'bottom',
            labelStyle: 'goldpink',
            showAvatar: true             // hiện avatar tròn của user (lấy từ profilePicture TikTok)
        }
    };
}

// Migrate config cũ (single-profile) sang multi-profile schema.
// Config v1 (cũ): { enabled, userRules, globalJoin, globalGift, queue, display }
// Config v2 (mới): { enabled, activeProfileId, profiles: [...], queue, display }
function migrateVipWelcomeConfig(cfg) {
    if (!cfg) return makeDefaultVipWelcomeConfig();
    if (Array.isArray(cfg.profiles) && cfg.profiles.length > 0) {
        // Đã ở schema mới — đảm bảo có activeProfileId hợp lệ + dọn field minDiamond cũ
        const ids = cfg.profiles.map(p => p.id);
        if (!cfg.activeProfileId || !ids.includes(cfg.activeProfileId)) {
            cfg.activeProfileId = cfg.profiles[0].id;
        }
        // Strip legacy minDiamond + minLevel khỏi user rules (user yêu cầu chỉ định ID = không cần level filter)
        for (const p of cfg.profiles) {
            if (Array.isArray(p.userRules)) {
                p.userRules = p.userRules.map(r => {
                    const { minDiamond, minLevel, ...rest } = r || {};
                    return rest;
                });
            }
            if (p.globalGift && 'minDiamond' in p.globalGift) {
                const { minDiamond, ...rest } = p.globalGift;
                p.globalGift = rest;
            }
        }
        // Auto-update perItemMinMs từ default cũ (2500) sang default mới (200) — user không
        // chủ động customize sẽ được nâng cấp tốc độ tự động.
        if (cfg.queue && cfg.queue.perItemMinMs === 2500) {
            cfg.queue.perItemMinMs = 200;
        }
        return cfg;
    }
    // Có rules ở top-level → wrap thành 1 profile "Mặc định"
    const def = makeDefaultVipWelcomeProfile('Nhóm mặc định');
    if (Array.isArray(cfg.userRules)) {
        def.userRules = cfg.userRules.map(r => {
            const { minDiamond, minLevel, ...rest } = r || {};   // strip legacy minDiamond + minLevel
            return rest;
        });
    }
    if (cfg.globalJoin) def.globalJoin = { ...def.globalJoin, ...cfg.globalJoin };
    if (cfg.globalGift) {
        const { minDiamond, ...rest } = cfg.globalGift;
        def.globalGift = { ...def.globalGift, ...rest };
    }
    const out = makeDefaultVipWelcomeConfig();
    out.enabled = cfg.enabled !== false;
    out.profiles = [def];
    out.activeProfileId = def.id;
    if (cfg.queue) out.queue = { ...out.queue, ...cfg.queue };
    if (cfg.display) out.display = { ...out.display, ...cfg.display };
    return out;
}

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
// Migrate vipwelcome config từ schema cũ (single profile) sang multi-profile.
if (appConfig.games.vipwelcome) {
    appConfig.games.vipwelcome = migrateVipWelcomeConfig(appConfig.games.vipwelcome);
}
saveAppConfig();

// ====== Gift list loader (via license-server proxy) ======
let giftMap = {};
let giftList = [];

// Fallback fetch trực tiếp Google Sheet khi license-server trả empty
// (workaround cho lúc env SHEET_ID ở VPS chưa update đúng).
// Schema: A=id | B=name | C=link | D=webm (bỏ qua) | E=diamond
const FALLBACK_SHEET_ID = '1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M';
const FALLBACK_SHEET_NAME = 'DANH SACH QUA';

function parseCsvSimple(text) {
    const rows = [];
    let cur = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { cur.push(field); field = ''; }
            else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
            else if (c !== '\r') field += c;
        }
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }
    return rows;
}

async function fetchGiftSheetDirect() {
    const url = `https://docs.google.com/spreadsheets/d/${FALLBACK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(FALLBACK_SHEET_NAME)}`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`Direct sheet HTTP ${res.status}`);
    const csv = await res.text();
    const rows = parseCsvSimple(csv);
    const list = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 3) continue;
        const id = (r[0] || '').toString().trim();
        const name = (r[1] || '').toString().trim();
        const image = (r[2] || '').toString().trim();
        // Cột D có thể là webm (sheet bản chuẩn) — skip, đọc cột E làm diamond.
        // Nếu D có số → dùng D (sheet cũ có A=id B=name C=link D=diamond).
        const dRaw = (r[3] || '').toString().replace(/[^\d]/g, '');
        let diamond = parseInt(dRaw, 10);
        if (!diamond || isNaN(diamond)) {
            diamond = parseInt((r[4] || '').toString().replace(/[^\d]/g, ''), 10) || 0;
        }
        if (!id) continue;
        list.push({ id, name, image, diamond });
    }
    return list;
}

async function loadGiftSheet() {
    if (!isWorkerConfigured()) {
        console.error('[gift-sheet] LICENSE_WORKER_URL chưa cấu hình — không thể tải gift sheet');
        giftList = []; giftMap = {};
        io.emit('giftSheet', giftList);
        return giftList;
    }
    console.log('[gift-sheet] Tải danh sách quà qua license-server...');
    let listFromServer = [];
    let serverFailed = false;
    try {
        const url = LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/gift-sheet';
        const res = await fetch(url, { timeout: 15000 });
        if (!res.ok) throw new Error(`License-server HTTP ${res.status}`);
        const body = await res.json();
        if (!body.ok || !Array.isArray(body.gifts)) throw new Error('License-server response invalid');
        listFromServer = body.gifts;
    } catch (e) {
        console.warn('[gift-sheet] License-server fail:', e.message);
        serverFailed = true;
    }
    // Fallback: nếu server empty hoặc fail → fetch trực tiếp Google Sheet
    if (serverFailed || listFromServer.length === 0) {
        console.log('[gift-sheet] License-server empty → fallback fetch Google Sheet trực tiếp...');
        try {
            listFromServer = await fetchGiftSheetDirect();
            console.log(`[gift-sheet] Fallback OK: ${listFromServer.length} quà từ Google Sheet`);
        } catch (e) {
            console.error('[gift-sheet] Fallback cũng fail:', e.message);
        }
    }
    // Sort theo Kim Cương ASC (thấp → cao). Áp dụng cho cả nguồn license-server
    // lẫn fallback Google Sheet trực tiếp.
    giftList = listFromServer.slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
    giftMap = {};
    for (const g of giftList) {
        if (g && g.id) giftMap[String(g.id)] = g;
    }
    console.log(`[gift-sheet] Đã tải ${giftList.length} quà (sort theo Kim Cương ASC).`);
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
let currentHostUserId = '';   // owner.userId của room đang connect — dùng để identify host team trong PK
// Hook để emitGift gọi vào PK gift tracking (set bởi attachConnectionEvents khi PK active)
let pktiktokTrackPkGift = null;
// Lưu thông tin TOP 1 contributor khi PK kết thúc — dùng cho rule override
let pkLastTopContributor = null;
// Session stats — counters for connection card display
let liveStats = {
    viewerCount: 0,
    totalDiamond: 0,
    totalLikes: 0,
    totalShares: 0,
    totalFollows: 0,
    followerCount: 0
};
function resetLiveStats() {
    liveStats = { viewerCount: 0, totalDiamond: 0, totalLikes: 0, totalShares: 0, totalFollows: 0, followerCount: 0 };
}
// Broadcast stats với throttle để không spam socket
let lastStatsEmit = 0;
function emitLiveStatsThrottled() {
    const now = Date.now();
    if (now - lastStatsEmit < 500) return;
    lastStatsEmit = now;
    io.emit('liveStats', liveStats);
}
function emitLiveStatsImmediate() {
    lastStatsEmit = Date.now();
    io.emit('liveStats', liveStats);
}

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
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        const comment = data?.comment;
        rememberUserMapping(userId, uniqueId);
        broadcast('chat', {
            uniqueId, nickname,
            userId,
            profilePicture,
            comment,
            createTime: Date.now()
        });
        // First-seen JOIN fallback + dedicated 'comment' trigger
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'chat', verified, userId);
        try { handleVipWelcomeEvent('comment', { uniqueId, nickname, level, profilePicture, verified, comment }); } catch (e) {}
    });

    conn.on(WebcastEvent.GIFT, (data) => {
        const giftType = data?.giftDetails?.giftType ?? data?.gift?.gift_type ?? data?.giftType;
        const isStreak = giftType === 1;
        if (isStreak && !data?.repeatEnd) return;
        rememberUserMapping(data?.user?.userId, data?.user?.uniqueId);
        emitGift({
            uniqueId: data?.user?.uniqueId,
            nickname: data?.user?.nickname,
            userId: data?.user?.userId,
            level: Number(data?.user?.userHonor?.level) || 0,
            verified: !!data?.user?.verified,
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
        // TikTok đôi khi strip user.uniqueId → fallback userId (numeric) + actionDescription
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId || data?.userId;   // MemberMessage có userId riêng
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        const action = data?.action;     // 1=JOINED, 3=SUBSCRIBED
        const actionDesc = data?.actionDescription || '';
        rememberUserMapping(userId, uniqueId);
        broadcast('member', { uniqueId, nickname, level, verified });
        // Verbose log — dump tất cả field hữu ích để user thấy TikTok gửi gì
        console.log(`[vipwelcome] MEMBER event raw: uniqueId="${uniqueId || ''}" userId="${userId || ''}" nickname="${nickname || ''}" level=${level} verified=${verified} action=${action} desc="${actionDesc}"`);
        // Primary join path — fire (resolve uniqueId từ cache nếu thiếu)
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'member', verified, userId);
    });
    conn.on(WebcastEvent.LIKE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        const likeCount = data?.likeCount || 1;
        rememberUserMapping(userId, uniqueId);
        broadcast('like', { uniqueId, nickname, likeCount });
        liveStats.totalLikes += likeCount; emitLiveStatsThrottled();
        // Fire 'join' fallback + dedicated 'like' trigger
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'like', verified, userId);
        try { handleVipWelcomeEvent('like', { uniqueId, nickname, level, profilePicture, verified, likeCount }); } catch (e) {}
    });
    conn.on(WebcastEvent.SOCIAL, (data) => {
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        rememberUserMapping(userId, uniqueId);
        broadcast('social', { uniqueId, nickname, label: data?.label });
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'social', verified, userId);
    });
    // FOLLOW event
    conn.on(WebcastEvent.FOLLOW, (data) => {
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        rememberUserMapping(userId, uniqueId);
        liveStats.totalFollows += 1; emitLiveStatsThrottled();
        console.log(`[vipwelcome] FOLLOW: @${uniqueId} "${nickname || ''}"`);
        try { handleVipWelcomeEvent('follow', { uniqueId, nickname, level, profilePicture, verified }); } catch (e) {}
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'follow', verified, userId);
    });
    // SHARE event
    conn.on(WebcastEvent.SHARE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        rememberUserMapping(userId, uniqueId);
        liveStats.totalShares += 1; emitLiveStatsThrottled();
        console.log(`[vipwelcome] SHARE: @${uniqueId} "${nickname || ''}"`);
        try { handleVipWelcomeEvent('share', { uniqueId, nickname, level, profilePicture, verified }); } catch (e) {}
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'share', verified, userId);
    });
    // ENVELOPE event — TikTok bao lì xì
    conn.on(WebcastEvent.ENVELOPE, (data) => {
        const uniqueId = data?.user?.uniqueId || data?.envelopeInfo?.user?.uniqueId;
        const userId = data?.user?.userId || data?.envelopeInfo?.user?.userId;
        const nickname = data?.user?.nickname || data?.envelopeInfo?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        rememberUserMapping(userId, uniqueId);
        console.log(`[vipwelcome] ENVELOPE (bao lì xì): @${uniqueId}`);
        try { handleVipWelcomeEvent('envelope', { uniqueId, nickname, level, profilePicture, verified }); } catch (e) {}
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'envelope', verified, userId);
    });
    conn.on(WebcastEvent.ROOM_USER, (data) => {
        const v = data?.viewerCount ?? data?.totalUser;
        broadcast('roomUser', { viewerCount: v });
        if (typeof v === 'number') { liveStats.viewerCount = v; emitLiveStatsThrottled(); }
        try {
            const lists = [];
            if (Array.isArray(data?.ranksList)) lists.push(...data.ranksList);
            if (Array.isArray(data?.seatsList)) lists.push(...data.seatsList);
            // Build set uniqueId trong seq hiện tại
            const currentSeqSet = new Set();
            const contributorMeta = [];   // giữ thông tin user để fire
            for (const contributor of lists) {
                const u = contributor?.user;
                if (!u) continue;
                const uniqueId = u.uniqueId;
                const userId = u.userId;
                rememberUserMapping(userId, uniqueId);
                if (uniqueId) {
                    currentSeqSet.add(String(uniqueId).toLowerCase());
                }
                contributorMeta.push({ user: u, uniqueId, userId });
            }
            // Detect DROP-OUT: user trong seq trước nhưng KHÔNG trong seq này → đánh dấu leftSeq
            for (const uid of vipSessionInLatestSeq) {
                if (!currentSeqSet.has(uid)) {
                    vipSessionLeftSeqAt.set(uid, Date.now());
                    console.log(`[vipwelcome] Seq DROP-OUT: @${uid} đã rời top contributors — chờ rejoin`);
                }
            }
            // Update seq snapshot
            vipSessionInLatestSeq = currentSeqSet;
            // Fire (firstTime hoặc rejoin) cho từng user
            for (const meta of contributorMeta) {
                const u = meta.user;
                const level = Number(u.userHonor?.level) || 0;
                const profilePicture = u.profilePicture?.url || u.profilePictureUrl;
                const verified = !!u.verified;
                maybeFireFirstSeenJoin(meta.uniqueId, u.nickname, level, profilePicture, 'roomUserSeq', verified, meta.userId);
            }
            if (lists.length > 0) {
                console.log(`[vipwelcome] ROOM_USER seq: viewer=${data?.viewerCount}, contributors=${lists.length}, seqSize=${currentSeqSet.size}`);
            }
        } catch (e) { console.error('[vipwelcome] ROOM_USER process error:', e); }
    });

    // ====== PK TikTok auto-bind (BETA — refined) ======
    // BattleAction: 4=OPEN, 5=FINISH, 6=CUT_SHORT
    // BattleTaskMessageType: 0=START, 1=UPDATE, 2=SETTLE, 3=REWARD_SETTLE
    //
    // Phase mapping:
    //   start    ← LINK_MIC_BATTLE action=4
    //   mission  ← LINK_MIC_BATTLE_TASK type=0
    //   x2 / x3  ← LINK_MIC_BATTLE_TASK with task config (multiplier in description)
    //   warn10s  ← fallback timer hoặc khi server gửi countdown
    //   lead/behind ← periodic check ARMIES (mỗi 30s)
    //   win/lose ← FINISH + so sánh scores với hostTeamIndex
    //   glove/mist/hammer/time ← chưa map (TikTok không expose enum riêng)

    // Server-side QUEUE — drain serial để effect không overlap
    let pkAutoQueue = [];
    let pkAutoDrainTimer = null;
    const PK_AUTO_DRAIN_GAP_MS = 3500;   // ~3.5s giữa các effect (đủ cho video ngắn)
    function pkAutoEnqueue(key, reason) {
        const cfg = appConfig.games?.pktiktok;
        if (!cfg || cfg.enabled === false || !cfg.autoBindPkDuo) return;
        // Dedupe: nếu phase này đã ở cuối queue, skip
        if (pkAutoQueue.length > 0 && pkAutoQueue[pkAutoQueue.length - 1].key === key) {
            console.log(`[pktiktok] AUTO skip dup "${key}"`);
            return;
        }
        pkAutoQueue.push({ key, reason, ts: Date.now() });
        console.log(`[pktiktok] AUTO queued → ${key} (reason: ${reason}), queue=${pkAutoQueue.length}`);
        if (!pkAutoDrainTimer) drainPkAutoNow();
    }
    function drainPkAutoNow() {
        if (pkAutoQueue.length === 0) { pkAutoDrainTimer = null; return; }
        const item = pkAutoQueue.shift();
        console.log(`[pktiktok] AUTO emit → ${item.key} (reason: ${item.reason})`);
        io.emit('pktiktok:autoTrigger', item);
        pkAutoDrainTimer = setTimeout(drainPkAutoNow, PK_AUTO_DRAIN_GAP_MS);
    }
    function clearPkAutoQueue() {
        pkAutoQueue = [];
        if (pkAutoDrainTimer) { clearTimeout(pkAutoDrainTimer); pkAutoDrainTimer = null; }
    }

    // PK match state
    let pkActive = false;
    let pkStartTs = 0;
    let pkTimers = [];
    let pkHostTeamIndex = -1;
    let pkLastScoreSnap = null;
    let pkLastLeadState = '';
    let pkLastPeriodicScore = 0;
    const PK_PERIODIC_LEAD_CHECK_MS = 30_000;
    // Track gifts gửi vào HOST trong khoảng PK active — để detect TOP 1 khi PK end
    let pkGiftDuringMatch = new Map();
    // Expose tracker cho emitGift
    pktiktokTrackPkGift = (g) => {
        if (!pkActive || !g.uniqueId) return;
        const k = String(g.uniqueId).toLowerCase();
        const cur = pkGiftDuringMatch.get(k) || {
            uniqueId: g.uniqueId, nickname: g.nickname, profilePicture: g.profilePicture, level: g.level || 0,
            totalDiamond: 0, totalCount: 0
        };
        cur.totalDiamond += Number(g.diamond) || 0;
        cur.totalCount += 1;
        if (g.nickname) cur.nickname = g.nickname;
        if (g.profilePicture) cur.profilePicture = g.profilePicture;
        if (g.level) cur.level = g.level;
        pkGiftDuringMatch.set(k, cur);
    };
    function resetPkState() {
        pkActive = false;
        pkHostTeamIndex = -1;
        pkLastScoreSnap = null;
        pkLastLeadState = '';
        pkLastPeriodicScore = 0;
        pkGiftDuringMatch.clear();
        clearPkTimers();
    }
    function clearPkTimers() {
        for (const t of pkTimers) {
            if (t && t._isInterval) clearInterval(t._handle);
            else clearTimeout(t);
        }
        pkTimers = [];
    }

    // Helper: extract teams + scores từ raw armies/battle data — log tất cả để debug
    function parseTeamsArmies(data) {
        const teams = [];
        const raw = data?.battleItems || data?.teams || data?.armies || [];
        if (Array.isArray(raw)) {
            for (let i = 0; i < raw.length; i++) {
                const t = raw[i];
                const score = Number(t?.totalScore ?? t?.score ?? t?.totalUserCount ?? 0);
                const anchorIds = (t?.hostsList || t?.hosts || t?.userList || []).map(u => String(u?.userId || u?.uniqueId || u || ''));
                teams.push({ index: i, score, anchorIds, raw: t });
            }
        }
        return teams;
    }

    conn.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
        const action = data?.battleConfig?.battleAction ?? data?.action ?? null;
        const battleStatus = data?.battleStatus;
        const currentRound = data?.currentRound;
        console.log(`[pktiktok] LINK_MIC_BATTLE action=${action} status=${battleStatus} round=${currentRound} keys=${Object.keys(data || {}).join(',').slice(0,200)}`);
        if (action === 4 /* OPEN */) {
            resetPkState();
            pkActive = true;
            pkStartTs = Date.now();
            clearPkAutoQueue();
            pkAutoEnqueue('start', 'battle_open');
            // Identify host team — match userId của owner
            try {
                const teams = parseTeamsArmies(data?.battleConfig || data);
                const ownerId = String(currentHostUserId || '');
                if (ownerId) {
                    for (const t of teams) {
                        if (t.anchorIds.includes(ownerId)) { pkHostTeamIndex = t.index; break; }
                    }
                }
                if (pkHostTeamIndex < 0 && teams.length > 0) pkHostTeamIndex = 0;
                console.log(`[pktiktok] PK OPEN: hostTeamIndex=${pkHostTeamIndex}, teams=${teams.length}, ownerId=${ownerId}`);
            } catch (e) {}
            // warn10s — TỪ duration của trận PK nếu battleConfig có. Bỏ rigid 110s timer cũ.
            const durationSec = Number(
                data?.battleConfig?.battleSetting?.duration ||
                data?.battleConfig?.duration ||
                data?.duration || 0
            );
            if (durationSec > 20) {
                const warnDelay = (durationSec - 10) * 1000;
                console.log(`[pktiktok] PK duration=${durationSec}s → warn10s scheduled at +${warnDelay/1000}s`);
                pkTimers.push(setTimeout(() => {
                    if (pkActive) pkAutoEnqueue('warn10s', `duration_based (${durationSec}s match)`);
                }, warnDelay));
            } else {
                console.log(`[pktiktok] PK duration không phát hiện được — skip warn10s auto (user trigger thủ công khi cần)`);
            }
            // Periodic lead/behind check (mỗi 30s)
            const periodicCheck = setInterval(() => {
                if (!pkActive) { clearInterval(periodicCheck); return; }
                if (!pkLastScoreSnap || pkHostTeamIndex < 0) return;
                const hostScore = pkLastScoreSnap[pkHostTeamIndex] || 0;
                const others = pkLastScoreSnap.filter((_, i) => i !== pkHostTeamIndex);
                const maxOther = Math.max(0, ...others);
                let newState = '';
                if (hostScore > maxOther) newState = 'lead';
                else if (hostScore < maxOther) newState = 'behind';
                else newState = 'tie';
                if (newState !== pkLastLeadState && (newState === 'lead' || newState === 'behind')) {
                    pkLastLeadState = newState;
                    pkAutoEnqueue(newState, `periodic_30s (host=${hostScore} vs max_opp=${maxOther})`);
                }
            }, PK_PERIODIC_LEAD_CHECK_MS);
            // Lưu interval handle để clear khi PK end
            pkTimers.push({ _isInterval: true, _handle: periodicCheck });
        } else if (action === 5 /* FINISH */ || action === 6 /* CUT_SHORT */) {
            // Determine win/lose
            let resultKey = 'win';
            if (pkLastScoreSnap && pkHostTeamIndex >= 0) {
                const hostScore = pkLastScoreSnap[pkHostTeamIndex] || 0;
                const others = pkLastScoreSnap.filter((_, i) => i !== pkHostTeamIndex);
                const maxOther = Math.max(0, ...others);
                resultKey = hostScore >= maxOther ? 'win' : 'lose';
                console.log(`[pktiktok] PK FINISH: host=${hostScore} vs max_opp=${maxOther} → ${resultKey}`);
            } else {
                console.log(`[pktiktok] PK FINISH: no score data → default 'win' (action=${action})`);
            }
            // Detect TOP 1 contributor và lưu thông tin để rule check khi emit
            const sorted = [...pkGiftDuringMatch.values()].sort((a, b) => b.totalDiamond - a.totalDiamond);
            const top1 = sorted[0] || null;
            if (top1) {
                console.log(`[pktiktok] PK TOP 1 contributor: @${top1.uniqueId} "${top1.nickname || ''}" — ${top1.totalDiamond} 💎 (${top1.totalCount} gifts)`);
                // Save vào last context — phase trigger handler sẽ check rule khi emit
                pkLastTopContributor = top1;
            } else {
                pkLastTopContributor = null;
                console.log(`[pktiktok] PK FINISH: không có gift nào trong trận → không TOP 1`);
            }
            pkAutoEnqueue(resultKey, `battle_finish (action=${action})`);
            // Delay reset state để khi emit còn dùng được pkLastTopContributor
            setTimeout(() => { pkLastTopContributor = null; }, 10_000);
            // Reset pkActive nhưng giữ data tracking
            pkActive = false;
            clearPkTimers();
        }
    });
    conn.on(WebcastEvent.LINK_MIC_BATTLE_TASK, (data) => {
        const type = data?.battleTaskMessageType;
        // Try parse multiplier text từ task description
        const descText = data?.taskDescription || data?.description || data?.text || '';
        console.log(`[pktiktok] LINK_MIC_BATTLE_TASK type=${type} desc="${String(descText).slice(0, 100)}" keys=${Object.keys(data || {}).join(',').slice(0,200)}`);
        if (type === 0 /* START */) {
            pkAutoEnqueue('mission', 'task_start');
            // Heuristic: nếu desc text có x2/x3, queue thêm
            const txt = String(descText).toLowerCase();
            if (/x\s*2|nhân\s*2|speed\s*x?2/.test(txt)) pkAutoEnqueue('x2', 'task_desc_x2');
            else if (/x\s*3|nhân\s*3|speed\s*x?3/.test(txt)) pkAutoEnqueue('x3', 'task_desc_x3');
        } else if (type === 2 /* SETTLE */ || type === 3 /* REWARD_SETTLE */) {
            // Task settled — heuristic guess: nếu reward = multiplier x2/x3 (chưa decode được)
        }
    });
    conn.on(WebcastEvent.LINK_MIC_BATTLE_PUNISH_FINISH, (data) => {
        console.log(`[pktiktok] LINK_MIC_BATTLE_PUNISH_FINISH`);
        resetPkState();
    });
    conn.on(WebcastEvent.LINK_MIC_ARMIES, (data) => {
        // Cập nhật score snapshot mỗi khi armies thay đổi
        try {
            const teams = parseTeamsArmies(data);
            if (teams.length > 0) {
                pkLastScoreSnap = teams.map(t => t.score);
                console.log(`[pktiktok] LINK_MIC_ARMIES scores=[${pkLastScoreSnap.join(', ')}] hostIdx=${pkHostTeamIndex}`);
            }
        } catch (e) { console.error('[pktiktok] armies parse error:', e); }
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
    // TikTok response có nhiều field chứa URL ảnh — thử lần lượt để fix case
    // gift có ID nhưng không có image (vd: streak gift, region gift, gift mới chưa cache)
    const tryUrls = (obj) => {
        if (!obj) return [];
        if (Array.isArray(obj.url_list)) return obj.url_list;
        if (Array.isArray(obj.urlList))  return obj.urlList;
        if (typeof obj.url === 'string') return [obj.url];
        return [];
    };
    const candidates = [
        ...tryUrls(target.image),
        ...tryUrls(target.icon),
        ...tryUrls(target.preview_image),
        ...tryUrls(target.thumbnail),
        target.image_url, target.icon_url, target.url
    ].filter(u => typeof u === 'string' && u.startsWith('http'));
    return {
        name: target.name || target.gift_name || '',
        image: candidates[0] || '',
        diamond: target.diamond_count || target.diamondCount || 0
    };
}

function recordUnknownGift(g) {
    const id = String(g.giftId || '').trim();
    if (!id) return null;
    // Đã có trong sheet → skip
    if (giftMap[id]) return null;
    const tt = lookupGiftFromTikTok(id);
    const resolvedName = g.giftName || g.gift_name || tt?.name || '';
    // Thử nhiều field từ event payload (snake_case, camelCase, alternative names)
    const resolvedImage = g.giftPicture || g.gift_picture || g.giftIcon || g.gift_icon
        || g.image || g.icon || tt?.image || '';
    const resolvedDiamond = parseInt(g.diamondCount, 10) || parseInt(g.diamond_count, 10) || tt?.diamond || 0;
    if (!resolvedName && !resolvedImage) return null;
    const now = Date.now();
    const prev = unknownGifts[id];
    if (prev) {
        prev.count = (prev.count || 0) + (parseInt(g.repeatCount, 10) || 1);
        prev.lastSeen = now;
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
    io.emit('unknownGift', { entry: unknownGifts[id], total: Object.keys(unknownGifts).length });
    // Nếu vẫn thiếu image → schedule retry sau 1-2s (availableGifts có thể chưa load đủ
    // khi event đầu tiên đến). Retry tối đa 3 lần với gap tăng dần.
    if (!unknownGifts[id].image) {
        scheduleGiftIconRetry(id);
    }
    return unknownGifts[id];
}

// Retry lookup icon cho gift chưa có image — quét lại availableGifts sau khi connect ổn định
const giftIconRetryAttempts = new Map();   // id → number of attempts
function scheduleGiftIconRetry(id) {
    const attempts = giftIconRetryAttempts.get(id) || 0;
    if (attempts >= 5) return;   // bỏ cuộc sau 5 lần
    giftIconRetryAttempts.set(id, attempts + 1);
    const delay = 1500 + attempts * 1500;   // 1.5s, 3s, 4.5s, 6s, 7.5s
    setTimeout(() => {
        const entry = unknownGifts[id];
        if (!entry || entry.image) return;   // đã có image hoặc bị xoá
        const tt = lookupGiftFromTikTok(id);
        if (tt?.image) {
            entry.image = tt.image;
            if (!entry.name && tt.name) entry.name = tt.name;
            if ((!entry.diamond || entry.diamond <= 0) && tt.diamond > 0) entry.diamond = tt.diamond;
            scheduleSaveUnknown();
            io.emit('unknownGift', { entry, total: Object.keys(unknownGifts).length });
            console.log(`[unknown-gifts] Retry ${attempts + 1}/5 thành công cho gift ${id}: ${tt.image}`);
            giftIconRetryAttempts.delete(id);
        } else {
            scheduleGiftIconRetry(id);   // try again
        }
    }, delay);
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
    // Track total diamond cho stats card
    const diamond = Number(enriched.coinValue) || 0;
    const repeat = Number(g.repeatCount) || 1;
    if (diamond > 0) {
        liveStats.totalDiamond += diamond * repeat;
        emitLiveStatsThrottled();
    }
    // PK: track gifts gửi cho HOST trong khoảng PK active — để detect TOP 1 contributor khi PK end
    if (pktiktokTrackPkGift && g.uniqueId) {
        pktiktokTrackPkGift({
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            profilePicture: g.profilePicture || enriched.image,
            level: Number(g.level) || 0,
            diamond: diamond * repeat
        });
    }
    // VIP Welcome — kiểm tra rules khi user tặng quà
    try {
        handleVipWelcomeEvent('gift', {
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            level: Number(g.level) || 0,
            verified: !!g.verified,
            profilePicture: g.profilePicture || enriched.image,
            giftName: enriched.giftName || g.giftName,
            giftPicture: enriched.image,
            diamondCount: enriched.coinValue || 0,
            repeatCount: g.repeatCount || 1
        });
    } catch (e) { /* non-fatal */ }
}

async function connectToUser(username) {
    if (connecting) throw new Error('Đang kết nối, vui lòng chờ...');
    if (connection) { try { await connection.disconnect(); } catch (e) {} connection = null; }
    connecting = true;
    currentUsername = username.replace(/^@/, '').trim();
    // Reset session-scoped state cho VIP Welcome + Live stats
    resetVipSession();
    resetLiveStats();
    // Log VIP Welcome config — user xem để verify rules đã load đúng từ disk
    try {
        const vw = appConfig.games.vipwelcome;
        if (vw) {
            const enabledProfiles = (vw.profiles || []).filter(p => p.enabled);
            console.log(`[vipwelcome] === Config snapshot khi connect LIVE ===`);
            console.log(`[vipwelcome]   master enabled: ${vw.enabled !== false}`);
            console.log(`[vipwelcome]   profiles total: ${(vw.profiles || []).length}, enabled: ${enabledProfiles.length}`);
            for (const p of (vw.profiles || [])) {
                const flag = p.enabled ? '✓ ON ' : '✗ off';
                console.log(`[vipwelcome]   ${flag} "${p.name}" — userRules: ${(p.userRules || []).length}, globalJoin: ${p.globalJoin?.enabled ? 'ON' : 'off'}, globalGift: ${p.globalGift?.enabled ? 'ON' : 'off'}`);
                for (const r of (p.userRules || [])) {
                    console.log(`[vipwelcome]     → rule: @${r.uniqueId} (${r.trigger}) ${r.enabled === false ? '[disabled]' : '[active]'} media=${r.mediaUrl ? 'YES' : 'no'}`);
                }
            }
            console.log(`[vipwelcome] === end snapshot ===`);
        }
    } catch (e) {}
    try {
        connection = new TikTokLiveConnection(currentUsername, {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            fetchRoomInfoOnConnect: true
        });
        attachConnectionEvents(connection);
        const state = await connection.connect();
        currentRoomId = state?.roomId;
        // Synthetic "host vào phòng" event — TikTok không fire MEMBER cho HOST tự kết nối live của mình.
        const hostNickname = state?.roomInfo?.owner?.nickname || state?.roomInfo?.owner?.uniqueId || currentUsername;
        const hostLevel = Number(state?.roomInfo?.owner?.userHonor?.level) || 0;
        const hostPic = state?.roomInfo?.owner?.profilePicture?.url || '';
        const hostVerified = !!state?.roomInfo?.owner?.verified;
        currentHostUserId = String(state?.roomInfo?.owner?.userId || '');
        // Lấy followerCount của HOST từ roomInfo
        const followerCount = Number(state?.roomInfo?.owner?.followInfo?.followerCount) || 0;
        if (followerCount > 0) {
            liveStats.followerCount = followerCount;
            emitLiveStatsImmediate();
        }
        setTimeout(() => {
            maybeFireFirstSeenJoin(currentUsername, hostNickname, hostLevel, hostPic, 'hostConnect', hostVerified);
        }, 300);
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
    const prevConfig = appConfig.games[g.id] || {};
    const prevEnabled = prevConfig.enabled !== false;
    appConfig.games[g.id] = { ...appConfig.games[g.id], ...(req.body || {}) };
    if (g.id === 'vipwelcome') {
        appConfig.games.vipwelcome = migrateVipWelcomeConfig(appConfig.games.vipwelcome);
    }
    const newEnabled = appConfig.games[g.id].enabled !== false;
    saveAppConfig();
    io.emit('gameConfig', { gameId: g.id, config: appConfig.games[g.id] });
    // Khi game vừa bị TẮT → gửi stop signal để overlay clear playback ngay lập tức
    if (prevEnabled && !newEnabled) {
        if (g.id === 'pktiktok') {
            io.emit('pktiktok:stop', { ts: Date.now(), reason: 'gameDisabled' });
        } else if (g.id === 'vipwelcome') {
            vipWelcomeQueue = [];
            if (vipWelcomeDrainTimer) { clearTimeout(vipWelcomeDrainTimer); vipWelcomeDrainTimer = null; }
            io.emit('vipwelcome:stop', { ts: Date.now(), reason: 'gameDisabled' });
            io.emit('vipwelcome:queue', { size: 0 });
        }
        // Generic event cho mọi game — overlay nào lắng nghe sẽ tự clear
        io.emit('gameDisabled', { gameId: g.id, ts: Date.now() });
        console.log(`[game-toggle] Game "${g.id}" disabled → emit stop signals`);
    } else if (!prevEnabled && newEnabled) {
        io.emit('gameEnabled', { gameId: g.id, ts: Date.now() });
        console.log(`[game-toggle] Game "${g.id}" enabled`);
    }
    res.json({ ok: true, config: appConfig.games[g.id] });
});

// Cache trạng thái game từng game — đẩy lên overlay khi (re)connect VÀ push realtime mỗi POST.
// PERSISTENCE: lưu vào disk → restart app không mất quà đã tặng.
// QUAN TRỌNG: app preview là authoritative source. Khi caughtList/policeForce/totalDiamonds đổi,
// app POST state → server cache + broadcast tới room 'overlay' → OBS gọi loadState → render lại.
const GAME_STATE_FILE = path.join(DATA_DIR, 'game-state.json');
let gameStateCache = {};
function loadGameStateCache() {
    try {
        if (fs.existsSync(GAME_STATE_FILE)) {
            const raw = fs.readFileSync(GAME_STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && typeof parsed === 'object') gameStateCache = parsed;
            console.log(`[game-state] Loaded ${Object.keys(gameStateCache).length} games từ disk`);
        }
    } catch (e) {
        console.warn('[game-state] Load fail:', e.message);
        gameStateCache = {};
    }
}
let _gameStateSaveTimer = null;
function scheduleSaveGameState() {
    clearTimeout(_gameStateSaveTimer);
    _gameStateSaveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(GAME_STATE_FILE, JSON.stringify(gameStateCache), 'utf8');
        } catch (e) {
            console.warn('[game-state] Save fail:', e.message);
        }
    }, 1500);
}
loadGameStateCache();

app.post('/api/games/:id/state', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    gameStateCache[g.id] = req.body || {};
    scheduleSaveGameState();   // persist to disk debounced
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
// AUTO-UPDATE: check + download + install (đơn giản như v1.0.6-v1.0.9)
// ============================================================
// Flow:
//   1. App load → GET /api/update/check → so version với GitHub Releases
//   2. Có update → modal hỏi user
//   3. User OK → POST /api/update/download → server tải .exe + emit progress
//      qua socket → spawn installer silent (VBS launcher) → app.quit
// Bảo mật ĐƠN GIẢN:
//   - PRIMARY: GitHub Releases API public (https://api.github.com/repos/.../releases/latest)
//   - FALLBACK: license-server (chỉ chạy nếu GitHub fail VÀ license-server có cấu hình)
//   - Không có SHA256 verify cho GitHub (GitHub API không trả hash) → chấp nhận
//     trade-off đơn giản hơn so với license-server (có SHA).

// GitHub repo cho auto-update — PUBLIC để fetch unauth (không cần token).
// Repo phải có Releases với tag vX.Y.Z và asset "HP-Action-LIVE-Setup-X.Y.Z.exe".
// Override qua env HP_GITHUB_REPO=owner/repo nếu user dùng repo khác.
const GITHUB_REPO = process.env.HP_GITHUB_REPO || 'hpmediaoffifical/hp-tiktok-game';

app.get('/api/update/check', async (req, res) => {
    try {
        const pkg = require('./package.json');
        const localVer = pkg.version || '0.0.0';

        // === Primary: GitHub Releases (public repo, source of truth) ===
        try {
            const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { timeout: 8000 });
            if (ghRes.ok) {
                const remote = await ghRes.json();
                if (remote.tag_name) {
                    const remoteVer = String(remote.tag_name).replace(/^v/i, '');
                    const isNewer = cmpVersion(remoteVer, localVer) > 0;
                    const setupAsset = (remote.assets || []).find(a => /Setup.*\.exe$/i.test(a.name))
                                    || (remote.assets || []).find(a => /\.exe$/i.test(a.name));
                    return res.json({
                        ok: true,
                        localVersion: localVer,
                        hasUpdate: isNewer,
                        latestVersion: remoteVer,
                        notes: remote.body || '',
                        size: setupAsset?.size || 0,
                        sha256: '',   // GitHub không có SHA → skip verify
                        source: 'github'
                    });
                }
            }
        } catch (e) { /* GitHub fail → fallback license-server */ }

        // === Fallback: license-server (nếu cấu hình) ===
        if (isWorkerConfigured()) {
            try {
                const r = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 6000 });
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
            } catch (e) { /* both sources failed */ }
        }

        // Cả 2 nguồn fail
        return res.json({ ok: false, localVersion: localVer, error: 'Không kết nối được nguồn cập nhật — thử lại sau' });
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

            // === Xác định nguồn tải: GitHub primary, license-server fallback ===
            let downloadUrl, expectedSize = 0, expectedSha = '', version = 'latest';

            // Primary: GitHub Releases
            try {
                const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { timeout: 8000 });
                if (ghRes.ok) {
                    const remote = await ghRes.json();
                    const setupAsset = (remote.assets || []).find(a => /Setup.*\.exe$/i.test(a.name))
                                    || (remote.assets || []).find(a => /\.exe$/i.test(a.name));
                    if (setupAsset) {
                        downloadUrl = setupAsset.browser_download_url;
                        expectedSize = setupAsset.size || 0;
                        expectedSha = '';   // GitHub không có SHA → skip verify
                        version = String(remote.tag_name).replace(/^v/i, '');
                    }
                }
            } catch (e) { /* GitHub fail → fallback license-server */ }

            // Fallback: license-server
            if (!downloadUrl && isWorkerConfigured()) {
                try {
                    const metaRes = await fetch(LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/version', { timeout: 6000 });
                    const meta = await metaRes.json();
                    if (meta.ok && meta.version) {
                        downloadUrl = LICENSE_WORKER_URL.replace(/\/$/, '') + '/api/download/installer';
                        expectedSize = meta.size || 0;
                        expectedSha = (meta.sha256 || '').toLowerCase();
                        version = meta.version;
                    }
                } catch (e) { /* both sources failed */ }
            }

            if (!downloadUrl) {
                throw new Error('Không kết nối được nguồn cập nhật');
            }

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
// Monotonic sequence ID cho gameCmd — overlay dedup theo seq để tránh
// duplicate spawn khi OBS cache stale code / reconnect re-attach listener.
let _cmdSeq = 0;
app.post('/api/games/:id/cmd', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    const { cmd, payload } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false, error: 'Thiếu cmd' });
    const seq = ++_cmdSeq;
    io.emit('gameCmd', { gameId: g.id, cmd, payload: payload || null, seq });
    res.json({ ok: true, seq });
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
app.get('/overlay/pktiktok', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'pktiktok', 'overlay.html'));
});
app.get('/overlay/vipwelcome', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'vipwelcome', 'overlay.html'));
});

// ============================================================
// PK TikTok — upload / asset serve / trigger broadcast
// ============================================================
// Đường lưu file media: <DATA_DIR>/pktiktok-assets/<id>.<ext>. Tách khỏi appConfig
// để không phình app-config.json. Path tương đối khi serve qua /api/games/pktiktok/asset/<fn>.
const PKTIKTOK_ASSETS_DIR = path.join(DATA_DIR, 'pktiktok-assets');
if (!fs.existsSync(PKTIKTOK_ASSETS_DIR)) fs.mkdirSync(PKTIKTOK_ASSETS_DIR, { recursive: true });
const PKTIKTOK_ALLOWED_EXTS = ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'];

// Upload — body là raw bytes (panel gửi qua fetch with Content-Type của file). Express.json sẽ
// bỏ qua vì không phải application/json. express.raw được attach inline cho route này.
app.post('/api/games/pktiktok/upload',
    express.raw({ limit: '30mb', type: () => true }),
    (req, res) => {
        const ext = String(req.query.ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (!PKTIKTOK_ALLOWED_EXTS.includes(ext)) {
            return res.status(400).json({ ok: false, error: 'invalid_ext' });
        }
        if (!req.body || !req.body.length) {
            return res.status(400).json({ ok: false, error: 'empty_body' });
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const filename = `${id}.${ext}`;
        try {
            fs.writeFileSync(path.join(PKTIKTOK_ASSETS_DIR, filename), req.body);
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'write_failed: ' + e.message });
        }
        res.json({ ok: true, filename, url: `/api/games/pktiktok/asset/${filename}` });
    }
);

app.get('/api/games/pktiktok/asset/:fn', (req, res) => {
    const safe = String(req.params.fn).replace(/[^a-z0-9._-]/gi, '');
    if (!safe || safe.includes('..')) return res.sendStatus(400);
    const p = path.join(PKTIKTOK_ASSETS_DIR, safe);
    if (!fs.existsSync(p)) return res.sendStatus(404);
    res.sendFile(p);
});

// Trigger 1 event PK TikTok — server đọc config event, build payload, emit cho mọi overlay
// client (cả OBS browser source). Trả lại payload cho panel để hiển thị log.
// Path /trigger (KHÔNG /cmd) để tránh đụng generic route /api/games/:id/cmd ở line ~1014.
app.post('/api/games/pktiktok/trigger', (req, res) => {
    const cfg = appConfig.games.pktiktok;
    if (!cfg) return res.status(404).json({ ok: false, error: 'pktiktok config missing' });
    const { type, key, source } = req.body || {};
    if (type === 'trigger') {
        if (cfg.enabled === false) return res.json({ ok: false, error: 'pkfx_disabled' });
        const ev = (cfg.events || []).find(e => e.key === key);
        if (!ev) return res.json({ ok: false, error: 'event_not_found' });
        if (ev.enabled === false) return res.json({ ok: false, error: 'event_disabled' });
        if (!ev.mediaUrl) return res.json({ ok: false, error: 'no_media' });
        // Top-contributor user override (chỉ áp dụng cho phase win/lose/mission khi PK kết thúc)
        let media = { url: ev.mediaUrl, type: ev.mediaType || '', name: '' };
        let topUser = null;
        const isResultPhase = (key === 'win' || key === 'lose');
        if (isResultPhase && pkLastTopContributor && Array.isArray(ev.topContributorRules) && ev.topContributorRules.length > 0) {
            const top = pkLastTopContributor;
            const topUidLower = String(top.uniqueId || '').toLowerCase().replace(/^@/, '');
            const rule = ev.topContributorRules.find(r => {
                const ruleUid = String(r.uniqueId || '').toLowerCase().replace(/^@/, '').trim();
                return ruleUid && ruleUid === topUidLower && r.mediaUrl;
            });
            if (rule) {
                media.url = rule.mediaUrl;
                media.type = rule.mediaType || '';
                media.name = rule.mediaName || '';
                topUser = top;
                console.log(`[pktiktok] TOP 1 rule MATCH for @${top.uniqueId} → override media to ${rule.mediaUrl}`);
            } else {
                console.log(`[pktiktok] TOP 1 @${top.uniqueId} không có rule riêng → dùng default media`);
            }
        }
        const payload = {
            key,
            label: ev.label,
            emoji: ev.emoji,
            mediaUrl: media.url,
            mediaType: media.type || guessMediaType(media.url),
            volume: ev.volume == null ? 100 : ev.volume,
            playbackRate: ev.playbackRate || 1.0,
            interruptCurrent: ev.interruptCurrent !== false,
            showLabel: !!(cfg.display && cfg.display.showLabel),
            source: source || 'manual',
            topUser: topUser ? { uniqueId: topUser.uniqueId, nickname: topUser.nickname, totalDiamond: topUser.totalDiamond } : null,
            ts: Date.now(),
        };
        io.emit('pktiktok:play', payload);
        return res.json({ ok: true, payload });
    }
    if (type === 'stop') {
        io.emit('pktiktok:stop', { ts: Date.now() });
        return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'unknown_type' });
});

// ============================================================
// VIP WELCOME — upload / asset / trigger broadcast / queue manager
// ============================================================
// Cấu trúc tương tự pktiktok: assets folder riêng + route serve.
const VIPWELCOME_ASSETS_DIR = path.join(DATA_DIR, 'vipwelcome-assets');
if (!fs.existsSync(VIPWELCOME_ASSETS_DIR)) fs.mkdirSync(VIPWELCOME_ASSETS_DIR, { recursive: true });
const VIPWELCOME_ALLOWED_EXTS = ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'];

app.post('/api/games/vipwelcome/upload',
    express.raw({ limit: '30mb', type: () => true }),
    (req, res) => {
        const ext = String(req.query.ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (!VIPWELCOME_ALLOWED_EXTS.includes(ext)) {
            return res.status(400).json({ ok: false, error: 'invalid_ext' });
        }
        if (!req.body || !req.body.length) {
            return res.status(400).json({ ok: false, error: 'empty_body' });
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const filename = `${id}.${ext}`;
        try {
            fs.writeFileSync(path.join(VIPWELCOME_ASSETS_DIR, filename), req.body);
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'write_failed: ' + e.message });
        }
        res.json({ ok: true, filename, url: `/api/games/vipwelcome/asset/${filename}` });
    }
);

app.get('/api/games/vipwelcome/asset/:fn', (req, res) => {
    const safe = String(req.params.fn).replace(/[^a-z0-9._-]/gi, '');
    if (!safe || safe.includes('..')) return res.sendStatus(400);
    const p = path.join(VIPWELCOME_ASSETS_DIR, safe);
    if (!fs.existsSync(p)) return res.sendStatus(404);
    res.sendFile(p);
});

// ===== VIP Welcome queue + per-user cooldown =====
// Tracking khi nào (uniqueId, ruleId) được phép trigger lại — chống spam cùng 1 user.
const vipWelcomeCooldown = new Map();   // key="uid|ruleId" → tsExpire
let vipWelcomeQueue = [];                // [{ payload, ts }]
let vipWelcomeLastEmitTs = 0;            // mốc emit gần nhất (rate-limit perItemMinMs)
let vipWelcomeDrainTimer = null;
let vipWelcomeRecentLog = [];            // 50 entry gần nhất cho panel hiển thị

// === Session-scoped state ===
let vipSessionLastLevel = new Map();    // uniqueId(lower) → last seen level
let vipSessionSeen = new Set();         // uniqueId(lower) — đã từng có event trong session này
// REJOIN logic: 2 mech song song
// (1) Time-based: lastSeenAt → nếu now - lastSeen > threshold → user vắng mặt đủ lâu → rejoin
// (2) Seq drop-out: track danh sách user trong ROOM_USER seq gần nhất. Khi user vào seq lần này
//     nhưng KHÔNG trong seq trước = re-entered. Mạnh hơn time-based — fire ngay không cần đợi threshold.
let vipSessionLastFireAt = new Map();   // uniqueId(lower) → ts fire cuối cùng
let vipSessionLastSeenAt = new Map();   // uniqueId(lower) → ts signal cuối cùng (any event)
let vipSessionInLatestSeq = new Set();  // uniqueId(lower) — currently in most recent ROOM_USER seq
let vipSessionLeftSeqAt = new Map();    // uniqueId(lower) → ts khi drop khỏi seq (chờ rejoin)
// === userId ↔ uniqueId cache ===
let vipSessionUserIdToUid = new Map();  // userId(string) → uniqueId
let vipSessionUidToUserId = new Map();  // uniqueId(lower) → userId
// Fire counter per ruleId — chỉ count session, reset khi resetSession/reconnect
let vipSessionRuleFireCount = new Map();   // ruleId (vd "user:r1abc") → count

const DEFAULT_REJOIN_THRESHOLD_SEC = 60;

function getRejoinThresholdMs() {
    const cfg = appConfig.games.vipwelcome || {};
    return Math.max(5, cfg.queue?.rejoinThresholdSec || DEFAULT_REJOIN_THRESHOLD_SEC) * 1000;
}

function resetVipSession() {
    vipSessionLastLevel.clear();
    vipSessionSeen.clear();
    vipSessionLastFireAt.clear();
    vipSessionLastSeenAt.clear();
    vipSessionInLatestSeq.clear();
    vipSessionLeftSeqAt.clear();
    vipSessionUserIdToUid.clear();
    vipSessionUidToUserId.clear();
    vipSessionRuleFireCount.clear();
}

// Ghi nhớ mapping userId ↔ uniqueId từ bất kỳ event nào có cả 2 field
function rememberUserMapping(userId, uniqueId) {
    if (!userId || !uniqueId) return;
    const uid = String(uniqueId);
    const id = String(userId);
    if (!vipSessionUserIdToUid.has(id)) {
        vipSessionUserIdToUid.set(id, uid);
        vipSessionUidToUserId.set(uid.toLowerCase(), id);
        console.log(`[vipwelcome] Cache userId↔uniqueId: ${id} ↔ @${uid}`);
    }
}

// Thử resolve uniqueId khi event chỉ có userId (vd: MEMBER event đôi khi thiếu uniqueId)
function resolveUniqueIdFromUserId(userId) {
    if (!userId) return null;
    return vipSessionUserIdToUid.get(String(userId)) || null;
}

// Fire 'join' với 3 nhánh:
// (A) Lần đầu trong phiên → fire
// (B) Drop-out seq → trở lại (mạnh) → fire ngay bypass threshold
// (C) Time-based: vắng mặt > rejoinThresholdSec → fire
function maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, source, verified, userId) {
    if (!uniqueId && userId) {
        const resolved = resolveUniqueIdFromUserId(userId);
        if (resolved) {
            console.log(`[vipwelcome] Resolved uniqueId từ userId ${userId} → @${resolved} (source=${source})`);
            uniqueId = resolved;
        }
    }
    if (!uniqueId) {
        console.log(`[vipwelcome] ⚠ JOIN skip: thiếu uniqueId (source=${source}, userId="${userId || ''}", nickname="${nickname || ''}").`);
        return;
    }
    const k = String(uniqueId).toLowerCase();
    const now = Date.now();
    const thresholdMs = getRejoinThresholdMs();
    const lastFire = vipSessionLastFireAt.get(k);
    const lastSeen = vipSessionLastSeenAt.get(k);
    const leftSeqAt = vipSessionLeftSeqAt.get(k);

    const isFirstTime = !lastFire;
    const sinceLastSeen = lastSeen ? now - lastSeen : Infinity;
    const isRejoinByTime = lastFire && sinceLastSeen > thresholdMs;
    const isRejoinByDropOut = lastFire && leftSeqAt;   // user từng drop khỏi seq, giờ trở lại

    // Luôn update lastSeenAt
    vipSessionLastSeenAt.set(k, now);

    if (!isFirstTime && !isRejoinByTime && !isRejoinByDropOut) {
        return;   // user vẫn đang trong phòng — không fire lại
    }

    // Clear drop-out marker khi fire
    if (leftSeqAt) vipSessionLeftSeqAt.delete(k);
    vipSessionLastFireAt.set(k, now);

    const note = isRejoinByDropOut
        ? `(REJOIN qua seq drop-and-return — bypass threshold)`
        : isRejoinByTime
        ? `(REJOIN sau ${Math.round(sinceLastSeen / 1000)}s vắng mặt — threshold ${thresholdMs / 1000}s)`
        : '(lần đầu trong phiên)';
    console.log(`[vipwelcome] JOIN fired (source=${source}): @${uniqueId} "${nickname || ''}" (cấp ${level || 0}, verified=${!!verified}) ${note}`);
    try {
        handleVipWelcomeEvent('join', {
            uniqueId, nickname,
            level: Number(level) || 0,
            profilePicture: profilePicture || '',
            verified: !!verified
        });
    } catch (e) { console.error('[vipwelcome] join handler error:', e); }
}

function pruneVipCooldown() {
    const now = Date.now();
    for (const [k, ts] of vipWelcomeCooldown) {
        if (ts <= now) vipWelcomeCooldown.delete(k);
    }
}

function vipWelcomeMatchesUserRule(rule, ctx) {
    // Trả về { matched, reason } để caller có thể log lý do không match (debug)
    if (!rule || rule.enabled === false) return { matched: false, reason: 'rule_disabled' };
    if (!rule.mediaUrl) return { matched: false, reason: 'no_media' };
    if (rule.trigger !== ctx.eventType) return { matched: false, reason: `trigger_mismatch (rule=${rule.trigger}, event=${ctx.eventType})` };
    const targetId = String(rule.uniqueId || '').replace(/^@/, '').toLowerCase().trim();
    if (!targetId) return { matched: false, reason: 'rule_uniqueId_empty' };
    const userId = String(ctx.uniqueId || '').replace(/^@/, '').toLowerCase().trim();
    if (userId !== targetId) return { matched: false, reason: `uniqueId_mismatch (rule="${targetId}" vs event="${userId}")` };
    // User chỉ định: BỎ filter cấp độ + kim cương — đã chỉ định ID rồi nên không cần lọc thêm.
    return { matched: true, reason: 'ok' };
}

function renderVipMessage(template, ctx) {
    if (!template) return '';
    return String(template)
        .replace(/\{nickname\}/g, ctx.nickname || ctx.uniqueId || 'User')
        .replace(/\{uniqueId\}/g, ctx.uniqueId || '')
        .replace(/\{level\}/g, String(ctx.level || 0))
        .replace(/\{gift\}/g, ctx.giftName || '')
        .replace(/\{count\}/g, String(ctx.repeatCount || 1))
        .replace(/\{verified\}/g, ctx.verified ? '✓' : '');
}

function pushVipWelcomeLog(entry) {
    vipWelcomeRecentLog.unshift(entry);
    if (vipWelcomeRecentLog.length > 50) vipWelcomeRecentLog.length = 50;
    io.emit('vipwelcome:log', entry);
}

function scheduleVipDrain() {
    if (vipWelcomeDrainTimer) return;
    const cfg = appConfig.games.vipwelcome || {};
    // KHÔNG còn floor 500ms — user có thể set 0 nếu muốn emit tức thì.
    // Overlay đã có queue nội bộ + play serial → server không cần pace cao.
    const minGap = Math.max(0, (cfg.queue?.perItemMinMs) ?? 200);
    const delay = Math.max(0, vipWelcomeLastEmitTs + minGap - Date.now());
    vipWelcomeDrainTimer = setTimeout(() => {
        vipWelcomeDrainTimer = null;
        drainVipQueueOne();
    }, delay);
}

function drainVipQueueOne() {
    if (vipWelcomeQueue.length === 0) return;
    const item = vipWelcomeQueue.shift();
    vipWelcomeLastEmitTs = Date.now();
    // Verify asset file exists nếu URL là local asset — log warning nếu thiếu
    let mediaExists = true;
    const u = String(item.payload.mediaUrl || '');
    const assetMatch = u.match(/^\/api\/games\/vipwelcome\/asset\/(.+)$/);
    if (assetMatch) {
        const filePath = path.join(VIPWELCOME_ASSETS_DIR, assetMatch[1]);
        mediaExists = fs.existsSync(filePath);
        if (!mediaExists) {
            console.log(`[vipwelcome] ⚠ MEDIA FILE MISSING khi drain: ${filePath} — overlay sẽ không phát được. Tải lại file vào rule "${item.payload.ruleLabel}".`);
        }
    }
    // Verbose drain log
    console.log(`[vipwelcome] 🎬 DRAIN → overlay: rule="${item.payload.ruleLabel}" user=@${item.payload.user?.uniqueId || '?'} mediaUrl=${item.payload.mediaUrl} type=${item.payload.mediaType} (file ok: ${mediaExists})`);
    // Count fire per rule (chỉ khi media tồn tại — coi như đã thật sự phát)
    if (mediaExists && item.payload.ruleId) {
        vipSessionRuleFireCount.set(item.payload.ruleId, (vipSessionRuleFireCount.get(item.payload.ruleId) || 0) + 1);
    }
    io.emit('vipwelcome:play', item.payload);
    io.emit('vipwelcome:queue', { size: vipWelcomeQueue.length });
    pushVipWelcomeLog({
        ts: Date.now(),
        kind: mediaExists ? 'play' : 'mediaMissing',
        ruleLabel: item.payload.ruleLabel || item.payload.source || '',
        eventType: item.payload.eventType,
        uniqueId: item.payload.user?.uniqueId,
        nickname: item.payload.user?.nickname,
        level: item.payload.user?.level || 0,
        mediaUrl: item.payload.mediaUrl
    });
    if (vipWelcomeQueue.length > 0) scheduleVipDrain();
}

function enqueueVipWelcomePayload(payload, priority) {
    const cfg = appConfig.games.vipwelcome || {};
    const maxLen = Math.max(1, cfg.queue?.maxLen || 20);
    if (priority) {
        // User-specific rule: PUSH TO FRONT để drain trước global → user VIP nhận hiệu ứng tức thì
        vipWelcomeQueue.unshift({ payload, ts: Date.now(), priority: true });
        // Vượt limit: drop từ ĐUÔI (giữ priority items ở đầu)
        while (vipWelcomeQueue.length > maxLen) {
            const dropped = vipWelcomeQueue.pop();
            pushVipWelcomeLog({ ts: Date.now(), kind: 'drop', ruleLabel: `Queue đầy (priority) → drop ${dropped.payload.ruleLabel}`, dropped: 1 });
        }
    } else {
        vipWelcomeQueue.push({ payload, ts: Date.now() });
        // Drop từ ĐẦU nhưng SKIP priority items
        while (vipWelcomeQueue.length > maxLen) {
            // Tìm item non-priority đầu tiên để drop
            const idx = vipWelcomeQueue.findIndex(it => !it.priority);
            if (idx === -1) break;   // toàn priority — không drop
            vipWelcomeQueue.splice(idx, 1);
            pushVipWelcomeLog({ ts: Date.now(), kind: 'drop', ruleLabel: `Queue đầy (${maxLen})`, dropped: 1 });
        }
    }
    io.emit('vipwelcome:queue', { size: vipWelcomeQueue.length });
    scheduleVipDrain();
}

function buildVipPayload({ source, ruleId, ruleLabel, eventType, media, message, user, gift }) {
    return {
        source,
        ruleId: ruleId || '',
        ruleLabel: ruleLabel || '',
        eventType,
        mediaUrl: media.mediaUrl,
        mediaType: media.mediaType || guessMediaType(media.mediaUrl),
        volume: media.volume == null ? 100 : media.volume,
        labelStyle: media.labelStyle || '',   // rule-level override → overlay applyLabelStyle ưu tiên
        message: message || '',
        user: user || null,
        gift: gift || null,
        ts: Date.now()
    };
}

function guessMediaType(url) {
    const u = String(url || '').toLowerCase();
    if (/\.(mp4|webm|mov)(\?|$)/.test(u)) return 'video';
    if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/.test(u)) return 'audio';
    return '';
}

function checkAndEnqueueVip(opts) {
    const { ruleId, source, ruleLabel, eventType, media, messageTemplate, user, gift } = opts;
    if (!media || !media.mediaUrl) return;
    // Cooldown CHỈ áp dụng cho gift/Lên cấp (chống spam tặng quà liên tục).
    // Với 'join': KHÔNG dùng cooldown ở đây — vì maybeFireFirstSeenJoin đã có
    // rejoin threshold (30s) làm gatekeeper. User vào lại sau 30s phải fire lại.
    const cfg = appConfig.games.vipwelcome || {};
    if (eventType !== 'join') {
        const cooldownMs = Math.max(0, (cfg.queue?.perUserCooldownSec || 60) * 1000);
        if (cooldownMs > 0 && user?.uniqueId) {
            const k = (user.uniqueId || '').toLowerCase() + '|' + ruleId;
            const exp = vipWelcomeCooldown.get(k);
            if (exp && exp > Date.now()) {
                pushVipWelcomeLog({
                    ts: Date.now(), kind: 'cooldown',
                    ruleLabel, eventType,
                    uniqueId: user.uniqueId, nickname: user.nickname,
                    level: user.level || 0
                });
                return;
            }
            vipWelcomeCooldown.set(k, Date.now() + cooldownMs);
        }
    }
    const ctx = { ...user, giftName: gift?.giftName, diamondCount: gift?.diamondCount, repeatCount: gift?.repeatCount };
    const message = renderVipMessage(messageTemplate, ctx);
    // User-specific rule (chỉ định TikTok ID) = PRIORITY → drain trước global
    const priority = source === 'userRule';
    // Forward rule's labelStyle override (nếu có) qua media object → buildVipPayload
    const mediaWithStyle = { ...media, labelStyle: media.labelStyle || '' };
    enqueueVipWelcomePayload(buildVipPayload({ source, ruleId, ruleLabel, eventType, media: mediaWithStyle, message, user, gift }), priority);
}

function handleVipWelcomeEvent(eventType, evt) {
    const cfg = appConfig.games.vipwelcome;
    if (!cfg || cfg.enabled === false) return;
    pruneVipCooldown();
    const userInfo = {
        uniqueId: evt.uniqueId, nickname: evt.nickname,
        level: evt.level || 0, profilePicture: evt.profilePicture,
        verified: !!evt.verified
    };
    const giftInfo = eventType === 'gift' ? {
        giftName: evt.giftName, giftPicture: evt.giftPicture,
        diamondCount: evt.diamondCount || 0, repeatCount: evt.repeatCount || 1
    } : null;

    // === LEVEL-UP DETECTION cho gift event ===
    // Chỉ fire "Lên cấp" khi level user thật sự TĂNG so với lần thấy trước trong session này.
    // Lần đầu thấy user trong session = treat as level-up tới level hiện tại.
    let leveledUp = false;
    if (eventType === 'gift' && evt.uniqueId) {
        const k = String(evt.uniqueId).toLowerCase();
        const prev = vipSessionLastLevel.has(k) ? vipSessionLastLevel.get(k) : -1;
        const curr = userInfo.level || 0;
        if (prev < 0 || curr > prev) {
            leveledUp = true;
            console.log(`[vipwelcome] LEVEL-UP detected: @${evt.uniqueId} ${prev < 0 ? '(lần đầu thấy)' : prev} → ${curr}`);
        }
        if (curr > prev) vipSessionLastLevel.set(k, curr);
    }
    if (evt.uniqueId) vipSessionSeen.add(String(evt.uniqueId).toLowerCase());

    // Iterate qua TẤT CẢ profiles có enabled=true — nhiều người dùng chung máy có thể bật nhóm
    // của mình song song. Mỗi profile namespace ruleId riêng để cooldown không đè chéo.
    for (const profile of (cfg.profiles || [])) {
        if (profile.enabled === false) continue;
        const pfx = 'p:' + profile.id + ':';
        const profileLabel = profile.name || 'Nhóm';
        // 1. User-specific rules trong profile này
        //    - Nếu trigger='join': fire khi user chỉ định vào phòng
        //    - Nếu trigger='gift' (Lên cấp): fire khi user chỉ định lên cấp
        for (const rule of (profile.userRules || [])) {
            const m = vipWelcomeMatchesUserRule(rule, { eventType, ...evt });
            if (!m.matched) {
                // Debug log — chỉ log khi rule có uniqueId khớp một phần (cùng người target) để
                // tránh spam log với mọi rule khác. Cụ thể: chỉ log nếu eventType khớp + rule có
                // ID + ID rule và event đều có chữ trùng (cùng tên cơ sở).
                const ruleUid = String(rule.uniqueId || '').toLowerCase().replace(/^@/, '');
                const evtUid = String(evt.uniqueId || '').toLowerCase().replace(/^@/, '');
                if (rule.trigger === eventType && ruleUid && evtUid && (ruleUid === evtUid || ruleUid.includes(evtUid) || evtUid.includes(ruleUid))) {
                    console.log(`[vipwelcome] User rule SKIP for @${evt.uniqueId}: ${m.reason}  (rule="${profileLabel}/@${rule.uniqueId}" trigger=${rule.trigger})`);
                }
                continue;
            }
            // Với trigger 'gift', user-specific chỉ fire khi thật sự lên cấp
            if (rule.trigger === 'gift' && !leveledUp) {
                console.log(`[vipwelcome] User rule SKIP (gift no level-up) for @${evt.uniqueId}`);
                continue;
            }
            console.log(`[vipwelcome] User rule MATCH for @${evt.uniqueId}: rule="${profileLabel}/@${rule.uniqueId}" trigger=${rule.trigger}`);
            checkAndEnqueueVip({
                ruleId: pfx + 'user:' + rule.id,
                source: 'userRule',
                ruleLabel: `[${profileLabel}] @${rule.uniqueId}`,
                eventType,
                media: rule,
                messageTemplate: rule.message,
                user: userInfo,
                gift: giftInfo
            });
        }
        // 2. Global rule (toàn bộ user) — có thể filter theo verified (tích xanh)
        if (eventType === 'join') {
            const g = profile.globalJoin;
            if (g && g.enabled && g.mediaUrl
                && (userInfo.level || 0) >= (g.minLevel || 0)
                && (!g.requireVerified || userInfo.verified)) {
                checkAndEnqueueVip({
                    ruleId: pfx + 'global:join',
                    source: 'globalJoin',
                    ruleLabel: `[${profileLabel}] Tất cả user${g.requireVerified ? ' ✓' : ''} (Vào phòng)`,
                    eventType: 'join',
                    media: g,
                    messageTemplate: g.message,
                    user: userInfo
                });
            }
        } else if (eventType === 'gift') {
            const g = profile.globalGift;
            // Global "Lên cấp": chỉ fire khi user thật sự lên cấp + level >= minLevel + (optional verified)
            if (g && g.enabled && g.mediaUrl
                && leveledUp
                && (userInfo.level || 0) >= (g.minLevel || 0)
                && (!g.requireVerified || userInfo.verified)) {
                checkAndEnqueueVip({
                    ruleId: pfx + 'global:gift',
                    source: 'globalGift',
                    ruleLabel: `[${profileLabel}] Tất cả user${g.requireVerified ? ' ✓' : ''} (Lên cấp)`,
                    eventType: 'gift',
                    media: g,
                    messageTemplate: g.message,
                    user: userInfo,
                    gift: giftInfo
                });
            }
        }
    }
}

// Trigger API — panel gọi để test 1 rule (manual / test-all / stop / clear queue).
app.post('/api/games/vipwelcome/trigger', (req, res) => {
    const cfg = appConfig.games.vipwelcome;
    if (!cfg) return res.status(404).json({ ok: false, error: 'vipwelcome config missing' });
    const { type, payload } = req.body || {};
    if (type === 'test') {
        // payload: { profileId, ruleType:'user'|'globalJoin'|'globalGift', ruleId? }
        // profileId default = activeProfileId nếu không truyền
        const profileId = payload?.profileId || cfg.activeProfileId;
        const profile = (cfg.profiles || []).find(p => p.id === profileId);
        if (!profile) return res.json({ ok: false, error: 'profile_not_found' });
        const profileLabel = profile.name || 'Nhóm';
        let media = null, ruleLabel = '', eventType = 'join', messageTemplate = '';
        if (payload?.ruleType === 'user') {
            const rule = (profile.userRules || []).find(r => r.id === payload.ruleId);
            if (!rule) return res.json({ ok: false, error: 'rule_not_found' });
            if (!rule.mediaUrl) return res.json({ ok: false, error: 'no_media' });
            media = rule; ruleLabel = `[${profileLabel}] @${rule.uniqueId}`;
            eventType = rule.trigger || 'join';
            messageTemplate = rule.message;
        } else if (payload?.ruleType === 'globalJoin') {
            if (!profile.globalJoin?.mediaUrl) return res.json({ ok: false, error: 'no_media' });
            media = profile.globalJoin; ruleLabel = `[${profileLabel}] Test: Global Join`;
            eventType = 'join';
            messageTemplate = profile.globalJoin.message;
        } else if (payload?.ruleType === 'globalGift') {
            if (!profile.globalGift?.mediaUrl) return res.json({ ok: false, error: 'no_media' });
            media = profile.globalGift; ruleLabel = `[${profileLabel}] Test: Global Gift`;
            eventType = 'gift';
            messageTemplate = profile.globalGift.message;
        } else {
            return res.json({ ok: false, error: 'unknown_ruleType' });
        }
        const fakeUser = {
            uniqueId: payload?.uniqueId || 'tester',
            nickname: payload?.nickname || 'Người Thử',
            level: payload?.level || 99,
            verified: !!payload?.verified,
            profilePicture: ''
        };
        const fakeGift = eventType === 'gift' ? {
            giftName: payload?.giftName || 'Quà thử', giftPicture: '',
            repeatCount: 1
        } : null;
        const message = renderVipMessage(messageTemplate, { ...fakeUser, giftName: fakeGift?.giftName });
        enqueueVipWelcomePayload(buildVipPayload({
            source: 'manual', ruleId: payload?.ruleId || '', ruleLabel,
            eventType, media, message, user: fakeUser, gift: fakeGift
        }));
        return res.json({ ok: true });
    }
    if (type === 'stop') {
        vipWelcomeQueue = [];
        if (vipWelcomeDrainTimer) { clearTimeout(vipWelcomeDrainTimer); vipWelcomeDrainTimer = null; }
        io.emit('vipwelcome:stop', { ts: Date.now() });
        io.emit('vipwelcome:queue', { size: 0 });
        return res.json({ ok: true });
    }
    if (type === 'clearQueue') {
        vipWelcomeQueue = [];
        io.emit('vipwelcome:queue', { size: 0 });
        return res.json({ ok: true });
    }
    if (type === 'resetCooldown') {
        vipWelcomeCooldown.clear();
        return res.json({ ok: true });
    }
    if (type === 'clearLog') {
        vipWelcomeRecentLog = [];
        io.emit('vipwelcome:logCleared', { ts: Date.now() });
        return res.json({ ok: true });
    }
    if (type === 'resetSession') {
        resetVipSession();
        vipWelcomeCooldown.clear();
        return res.json({ ok: true });
    }
    if (type === 'reloadOverlay') {
        // Force overlay reload (giải quyết cache OBS browser source khi update)
        io.emit('vipwelcome:reload', { ts: Date.now() });
        return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'unknown_type' });
});

// Status per user-rule: cho UI hiển thị "đã fire / sẵn sàng / countdown"
app.get('/api/games/vipwelcome/user-status', (req, res) => {
    const cfg = appConfig.games.vipwelcome || {};
    const thresholdMs = getRejoinThresholdMs();
    const now = Date.now();
    const out = {};
    for (const profile of (cfg.profiles || [])) {
        for (const rule of (profile.userRules || [])) {
            const uid = String(rule.uniqueId || '').replace(/^@/, '').toLowerCase().trim();
            if (!uid) continue;
            const lastFire = vipSessionLastFireAt.get(uid);
            const lastSeen = vipSessionLastSeenAt.get(uid);
            const inSeq = vipSessionInLatestSeq.has(uid);
            const leftSeqAt = vipSessionLeftSeqAt.get(uid);
            // Tính eligibility cho rejoin
            let status = 'idle';
            let secondsSinceFire = null;
            let secondsSinceSeen = null;
            let secondsUntilRejoinEligible = null;
            let readyForRejoin = false;
            if (lastFire) {
                secondsSinceFire = Math.round((now - lastFire) / 1000);
                if (lastSeen) secondsSinceSeen = Math.round((now - lastSeen) / 1000);
                readyForRejoin = !!leftSeqAt || (lastSeen && (now - lastSeen) > thresholdMs);
                if (readyForRejoin) {
                    status = 'readyForRejoin';
                } else if (lastSeen) {
                    secondsUntilRejoinEligible = Math.max(0, Math.round((lastSeen + thresholdMs - now) / 1000));
                    status = 'inRoom';
                } else {
                    status = 'fired';
                }
            }
            // Fire count cho rule này — namespace "p:<profileId>:user:<ruleId>"
            const fireCountKey = 'p:' + profile.id + ':user:' + rule.id;
            const fireCount = vipSessionRuleFireCount.get(fireCountKey) || 0;
            out[rule.id] = {
                uniqueId: rule.uniqueId,
                profileId: profile.id,
                profileName: profile.name,
                status,
                inSeq,
                droppedOutOfSeq: !!leftSeqAt,
                secondsSinceFire,
                secondsSinceSeen,
                secondsUntilRejoinEligible,
                thresholdSec: thresholdMs / 1000,
                fireCount
            };
        }
    }
    res.json({ now, statuses: out });
});

app.get('/api/games/vipwelcome/queue', (req, res) => {
    res.json({
        size: vipWelcomeQueue.length,
        items: vipWelcomeQueue.map(it => ({
            ruleLabel: it.payload.ruleLabel,
            eventType: it.payload.eventType,
            uniqueId: it.payload.user?.uniqueId,
            nickname: it.payload.user?.nickname,
            level: it.payload.user?.level || 0,
            ts: it.ts
        })),
        recent: vipWelcomeRecentLog
    });
});

// Default index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====== Socket rooms ======
io.on('connection', (socket) => {
    // Default emits
    socket.emit('giftSheet', giftList);
    socket.emit('status', { connected: !!(connection && connection.isConnected), username: currentUsername, roomId: currentRoomId });
    socket.emit('liveStats', liveStats);

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

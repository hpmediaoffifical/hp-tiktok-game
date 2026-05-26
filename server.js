const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
const CONFIG_BACKUP_DIR = path.join(DATA_DIR, 'config-backups');

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
app.use(express.json({ limit: '5mb' }));

// ====== Game registry ======
const GAMES = {
    thuytinh: {
        id: 'thuytinh',
        name: 'Hũ Thủy Tinh',
        description: '',
        icon: '🫙',
        overlayPath: '/overlay/thuytinh',
        defaultConfig: {
            enabled: true,
            jar: { xPercent: 50, yPercent: 56, height: 1200 },
            gift: { minSize: 40, maxSize: 220, showName: false, showCount: true },
            physics: { gravity: 1.4, bounce: 0.42, friction: 0.05 },
            jarVisible: true,
            maxCapacity: 0,
            webmFxVolume: 80
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
    },
    votecomment: {
        id: 'votecomment',
        name: 'Vote Bình Luận',
        description: 'Khán giả bình luận từ khoá / tặng quà để bình chọn — thanh máu + % cập nhật realtime.',
        icon: '🗳',
        overlayPath: '/overlay/votecomment',
        defaultConfig: makeDefaultVoteCommentConfig()
    },
    nhietdo: {
        id: 'nhietdo',
        name: 'Biểu Cảm Nhiệt Độ',
        description: 'Thanh nhiệt 0-100°C tăng theo quà, tự giảm khi không có quà — càng nóng càng nhiều lửa trên overlay.',
        icon: '🌡',
        overlayPath: '/overlay/nhietdo',
        defaultConfig: makeDefaultNhietDoConfig()
    },
    'level-quest': {
        id: 'level-quest',
        name: 'LEVEL QUEST',
        description: 'Quest bar Liên Quân-style — KPI 💎/❤/🔄 chia 18 level cho từng NPC creator.',
        icon: '🎯',
        overlayPath: '/_prototype/level-quest.html?mode=overlay',
        defaultConfig: { enabled: true }
    },
    'timer': {
        id: 'timer',
        name: 'THỜI GIAN',
        description: 'Đếm lùi / đếm tới với 9 giao diện (LED, vòng tròn, thanh, đa giác, neon, flip). Quà tặng ± thời gian theo 3 chế độ: cố định / theo xu / chọn phe.',
        icon: '⏱',
        overlayPath: '/_prototype/timer.html?mode=overlay',
        defaultConfig: { enabled: true }
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

// ====== Vote Bình Luận — defaults ======
// Khán giả bình luận đúng từ khoá (vd "1", "A", "đỏ") để bình chọn; quà tặng (XU) cộng dồn theo
// dòng mà user đã vote gần nhất. Server giữ live state in-memory + broadcast realtime.
function makeDefaultVoteCommentConfig() {
    return {
        enabled: true,
        title: 'BIỂU QUYẾT',
        durationSec: 300,
        countingMode: 'both',          // 'comments' | 'gifts' | 'both'
        pointsLabel: 'ĐIỂM',           // nhãn tự đặt: ĐIỂM, TICKER, BÌNH, v.v.
        commentWeight: 1,              // trọng số: 1 comment = N điểm
        giftWeight: 1,                 // trọng số: 1 xu quà = N điểm (vd 2 để ưu tiên người tặng quà)
        joinByGift: false,             // CHỌN PHE: tặng quà chỉ định = gia nhập → mọi quà sau cộng vào phe đó
        // Mỗi row giữ thêm:
        //   giftId / giftName / giftImage : quà cụ thể được gán (optional). Khi có → quà đó chỉ
        //   cộng XU vào row này. Khi rỗng → fallback last-vote-attribution (user comment vote
        //   keyword nào → quà của họ vào row đó).
        rows: [
            { id: 'r1', keyword: '1', label: 'Lựa chọn 1', color: '', giftId: '', giftName: '', giftImage: '' },
            { id: 'r2', keyword: '2', label: 'Lựa chọn 2', color: '', giftId: '', giftName: '', giftImage: '' }
        ],
        display: {
            titleSize: 56,
            itemSize: 36,
            itemHeight: 84,
            showBar: true,
            overlayBg: 'rgba(28,28,28,0.55)',
            itemBg: 'rgba(139,0,0,0.45)',
            barColor: '#ffce4d',
            textColor: '#ffffff',
            scale: 100,
            xPercent: 50,
            yPercent: 50
        }
    };
}

// ====== Biểu Cảm Nhiệt Độ — defaults ======
// Thanh nhiệt 0..100°C. Mỗi quà tăng nhiệt theo công thức trong config (perCoin / perGift /
// specificGifts). Cooling gifts giảm nhiệt ở mọi mode. Tick loop giảm nhiệt khi idle.
// Mốc thưởng (milestones) phát media + ticker khi vượt qua. Top contributor leaderboard.
function makeDefaultNhietDoMilestones() {
    return [
        { temp: 25,  label: '25°C — Ấm rồi!',     tickerText: '🔥 25°C — ẤM RỒI! 🔥',   mediaUrl: '', mediaName: '', mediaType: '', volume: 80,  enabled: true },
        { temp: 50,  label: '50°C — Nóng!',       tickerText: '🔥 50°C — NÓNG QUÁ! 🔥',  mediaUrl: '', mediaName: '', mediaType: '', volume: 85,  enabled: true },
        { temp: 75,  label: '75°C — Rất nóng!',   tickerText: '🔥🔥 75°C — RẤT NÓNG!',   mediaUrl: '', mediaName: '', mediaType: '', volume: 90,  enabled: true },
        { temp: 100, label: '100°C — CHÁY!',      tickerText: '💥 100°C — BÙM! 💥',       mediaUrl: '', mediaName: '', mediaType: '', volume: 100, enabled: true }
    ];
}
function makeDefaultNhietDoConfig() {
    return {
        enabled: true,
        sessionActive: true,         // BẮT ĐẦU/KẾT THÚC phiên — false = overlay ẩn hết
        heatMode: 'perCoin',
        perCoinDegrees: 0.5,
        perGiftDegrees: 5,
        specificGifts: [],
        coolingGifts: [],
        decayPerSecond: 1.0,
        idleSeconds: 5,
        decayShape: 'linear',
        tempMin: 0,
        tempMax: 100,
        initialTemp: 0,
        milestones: makeDefaultNhietDoMilestones(),
        ambientAudio: { url: '', name: '', volume: 50, reactToHeat: true },
        display: {
            xPercent: 50,
            yPercent: 50,
            scale: 100,
            showThermo: true,
            showLabel: true,
            showDegrees: true,
            showEmoji: true,
            showFloatGain: true,
            showFireEffect: true,
            showHaze: true,
            shakeAtMax: true,
            showTopContrib: true,
            topContribPos: 'top-left',
            colorScheme: 'pinkfire',
            shape: 'tube',
            fxIntensity: 100,
            tickerScale: 60
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
    try {
        if (!fs.existsSync(CONFIG_BACKUP_DIR)) fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(CONFIG_BACKUP_DIR, 'app-config-autobackup.json'), JSON.stringify({ exportedAt: new Date().toISOString(), config: appConfig }, null, 2));
    } catch (e) { /* backup is best-effort */ }
}
const appConfig = loadAppConfig();
const DEFAULT_LIVE_TRANSLATE_CONFIG = {
    enabled: false,
    sourceLang: 'auto',
    excludedSourceLang: '',
    targetLang: 'vi',
    ttsEnabled: true,
    ttsVoice: 'auto',
    ttsReadMode: 'nameAndComment',
    ttsCooldownSeconds: 4,
    ttsPriority: 'all',
    ttsPreset: 'auto',
    ttsVolume: 85,
    ttsRate: 1,
    aiFilterEnabled: true,
    ignoreIcons: true,
    cleanUnreadable: true,
    readUsername: true,
    maxItems: 8,
    glossary: [],
    forbiddenWords: []
};
const DEFAULT_CREATOR_CAPTION_CONFIG = {
    enabled: false,
    sourceLang: 'vi-VN',
    targetLang: 'en',
    targetLangs: ['en'],
    whisperLocalExe: '',
    whisperLocalModel: '',
    showOriginal: true,
    maxItems: 3,
    holdSeconds: 12,
    silenceSeconds: 2,
    autoTargetsEnabled: true,
    autoTargetTimeoutSeconds: 60
};
const LIVE_TRANSLATE_LANG_LABELS = {
    auto: 'Tự nhận diện',
    vi: 'Tiếng Việt',
    en: 'English',
    th: 'Thai',
    id: 'Indonesia',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    ru: 'Russian',
    pt: 'Portuguese',
    hi: 'Hindi',
    ar: 'Arabic',
    tr: 'Turkish',
    ms: 'Malay',
    fil: 'Filipino'
};
for (const gId of Object.keys(GAMES)) {
    if (!appConfig.games[gId]) appConfig.games[gId] = { ...GAMES[gId].defaultConfig };
}
// Migrate vipwelcome config từ schema cũ (single profile) sang multi-profile.
if (appConfig.games.vipwelcome) {
    appConfig.games.vipwelcome = migrateVipWelcomeConfig(appConfig.games.vipwelcome);
}
appConfig.liveTranslate = {
    ...DEFAULT_LIVE_TRANSLATE_CONFIG,
    ...(appConfig.liveTranslate || {}),
    glossary: Array.isArray(appConfig.liveTranslate?.glossary) ? appConfig.liveTranslate.glossary : [],
    forbiddenWords: Array.isArray(appConfig.liveTranslate?.forbiddenWords) ? appConfig.liveTranslate.forbiddenWords : []
};
if (appConfig.liveTranslate.manualStartVersion !== 1) {
    appConfig.liveTranslate.enabled = false;
    appConfig.liveTranslate.manualStartVersion = 1;
}
appConfig.creatorCaption = sanitizeCreatorCaptionConfig(appConfig.creatorCaption || {});
saveAppConfig();

// ====== Live Translate MVP ======
const translationCache = new Map();
const TRANSLATION_CACHE_LIMIT = 500;
const COMMENT_RULES_SHEET_ID = '1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M';
const COMMENT_RULES_GID = '211090113';
const COMMENT_RULES_REFRESH_MS = 5 * 60 * 1000;
let commentSheetRules = { forbiddenWords: [], glossary: [], loadedAt: 0, error: '' };
const liveTranslateRecentGifts = new Map();
const liveTranslateRecentMembers = new Map();
const liveTranslateLastSpoken = new Map();
const LIVE_TRANSLATE_PRIORITY_WINDOW_MS = 10 * 60 * 1000;
const LIVE_TRANSLATE_TEST_PHRASE = 'HP Media xin chào, đây là giọng đọc thử bằng tiếng Việt.';
const LIVE_TRANSLATE_TTS_PRESETS = {
    auto: { lang: '', label: 'Tự chọn' },
    vi: { lang: 'vi', label: 'Giọng Việt' },
    en: { lang: 'en', label: 'English voice' },
    zh: { lang: 'zh', label: 'Chinese voice' },
    ko: { lang: 'ko', label: 'Korean voice' },
    ja: { lang: 'ja', label: 'Japanese voice' }
};
const LIVE_TRANSLATE_TOXIC_PATTERNS = [
    /\b(dm|dmm|dit|djt|clm|vl|vcl|cc|lon|cac|buoi)\b/i,
    /\b(fuck|shit|bitch|asshole|cunt|dick|pussy)\b/i,
    /\b(kill yourself|kys|die|tự tử|tu tu|chết đi|chet di)\b/i,
    /\b(ngu|oc cho|óc chó|súc vật|suc vat|đồ chó|do cho)\b/i
];
const liveTranslateStats = {
    chatSeen: 0,
    skippedDisabled: 0,
    skippedEmpty: 0,
    skippedBlocked: 0,
    skippedToxic: 0,
    skippedExcludedLanguage: 0,
    emitted: 0,
    translateErrors: 0,
    lastChatAt: 0,
    lastEmitAt: 0,
    lastSkipReason: '',
    lastBlockedWord: '',
    lastError: ''
};

let liveDashboardState = {
    connected: false,
    username: '',
    roomId: '',
    stats: {},
    lastGift: null,
    lastTranslatedComment: null,
    updatedAt: Date.now()
};

function emitLiveDashboard() {
    liveDashboardState = { ...liveDashboardState, stats: { ...liveStats }, updatedAt: Date.now() };
    io.emit('liveDashboard', liveDashboardState);
}

function setLiveDashboardStatus(connected, extra = {}) {
    liveDashboardState = {
        ...liveDashboardState,
        connected: !!connected,
        username: extra.username ?? currentUsername ?? '',
        roomId: extra.roomId ?? currentRoomId ?? '',
        updatedAt: Date.now()
    };
    emitLiveDashboard();
}

function setLiveDashboardGift(gift) {
    liveDashboardState.lastGift = gift ? {
        nickname: gift.nickname || gift.uniqueId || '',
        uniqueId: gift.uniqueId || '',
        giftName: gift.giftName || gift.sheetItem?.name || '',
        image: gift.image || gift.giftPicture || '',
        repeatCount: gift.repeatCount || 1,
        diamond: gift.coinValue || gift.diamondCount || 0,
        ts: Date.now()
    } : null;
    emitLiveDashboard();
}

function setLiveDashboardTranslatedComment(item) {
    liveDashboardState.lastTranslatedComment = item ? {
        nickname: item.nickname || item.uniqueId || '',
        uniqueId: item.uniqueId || '',
        originalText: item.originalText || '',
        translatedText: item.translatedText || '',
        targetLangLabel: item.targetLangLabel || '',
        toxic: !!item.toxic,
        ts: Date.now()
    } : null;
    emitLiveDashboard();
}

function normalizeModerationText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

async function loadCommentRulesSheet() {
    const url = `https://docs.google.com/spreadsheets/d/${COMMENT_RULES_SHEET_ID}/export?format=csv&gid=${COMMENT_RULES_GID}`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`comment_rules_http_${res.status}`);
    const csv = await res.text();
    const rows = parseCsvSimple(csv);
    const forbiddenWords = [];
    const glossary = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const blocked = String(r[0] || '').trim();
        const from = String(r[2] || '').trim();
        const to = String(r[3] || '').trim();
        if (blocked) forbiddenWords.push(blocked);
        if (from && to) glossary.push(`${from}=${to}`);
    }
    commentSheetRules = { forbiddenWords, glossary, loadedAt: Date.now(), error: '' };
    io.emit('translate:rules', getCommentRulesMeta());
    console.log(`[comment-rules] Đã tải ${forbiddenWords.length} từ cấm, ${glossary.length} cụm thay thế.`);
    return commentSheetRules;
}

function getCommentRulesMeta() {
    return {
        forbiddenCount: commentSheetRules.forbiddenWords.length,
        glossaryCount: commentSheetRules.glossary.length,
        loadedAt: commentSheetRules.loadedAt,
        error: commentSheetRules.error || ''
    };
}

async function refreshCommentRulesSheet() {
    try { return await loadCommentRulesSheet(); }
    catch (e) {
        commentSheetRules.error = e.message || 'comment_rules_failed';
        io.emit('translate:rules', getCommentRulesMeta());
        console.warn('[comment-rules] Không tải được quy tắc:', commentSheetRules.error);
        return commentSheetRules;
    }
}

function sanitizeLiveTranslateConfig(input) {
    const cfg = { ...DEFAULT_LIVE_TRANSLATE_CONFIG, ...(input || {}) };
    cfg.enabled = cfg.enabled === true;
    cfg.ttsEnabled = !!cfg.ttsEnabled;
    cfg.ignoreIcons = cfg.ignoreIcons !== false;
    cfg.cleanUnreadable = cfg.cleanUnreadable !== false;
    cfg.aiFilterEnabled = cfg.aiFilterEnabled !== false;
    cfg.readUsername = cfg.readUsername !== false;
    cfg.sourceLang = String(cfg.sourceLang || 'auto').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12) || 'auto';
    cfg.excludedSourceLang = String(cfg.excludedSourceLang || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12);
    if (cfg.excludedSourceLang === 'auto') cfg.excludedSourceLang = '';
    cfg.targetLang = String(cfg.targetLang || 'vi').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12) || 'vi';
    cfg.ttsVoice = ['auto', 'male', 'female', 'random', 'randomGender', 'variant1', 'variant2', 'variant3', 'variant4', 'variant5'].includes(cfg.ttsVoice) ? cfg.ttsVoice : 'auto';
    cfg.ttsPreset = Object.prototype.hasOwnProperty.call(LIVE_TRANSLATE_TTS_PRESETS, cfg.ttsPreset) ? cfg.ttsPreset : 'auto';
    cfg.ttsReadMode = ['nameAndComment', 'commentOnly', 'nameOnly'].includes(cfg.ttsReadMode) ? cfg.ttsReadMode : (cfg.readUsername === false ? 'commentOnly' : 'nameAndComment');
    cfg.ttsPriority = ['all', 'gifters', 'members', 'giftersOrMembers'].includes(cfg.ttsPriority) ? cfg.ttsPriority : 'all';
    const cooldown = parseInt(cfg.ttsCooldownSeconds, 10);
    cfg.ttsCooldownSeconds = Math.max(0, Math.min(60, Number.isFinite(cooldown) ? cooldown : DEFAULT_LIVE_TRANSLATE_CONFIG.ttsCooldownSeconds));
    const volume = parseInt(cfg.ttsVolume, 10);
    cfg.ttsVolume = Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : DEFAULT_LIVE_TRANSLATE_CONFIG.ttsVolume));
    const rate = parseFloat(cfg.ttsRate);
    cfg.ttsRate = Math.max(0.5, Math.min(2, Number.isFinite(rate) ? rate : DEFAULT_LIVE_TRANSLATE_CONFIG.ttsRate));
    cfg.maxItems = Math.max(3, Math.min(20, parseInt(cfg.maxItems, 10) || DEFAULT_LIVE_TRANSLATE_CONFIG.maxItems));
    if (typeof cfg.glossary === 'string') cfg.glossary = cfg.glossary.split(/\r?\n/);
    cfg.glossary = (Array.isArray(cfg.glossary) ? cfg.glossary : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 300);
    if (typeof cfg.forbiddenWords === 'string') cfg.forbiddenWords = cfg.forbiddenWords.split(/\r?\n|,/);
    cfg.forbiddenWords = (Array.isArray(cfg.forbiddenWords) ? cfg.forbiddenWords : []).map(w => String(w || '').trim()).filter(Boolean).slice(0, 300);
    return cfg;
}

function sanitizeCreatorCaptionConfig(input) {
    const cfg = { ...DEFAULT_CREATOR_CAPTION_CONFIG, ...(input || {}) };
    cfg.enabled = cfg.enabled === true;
    cfg.sourceLang = String(cfg.sourceLang || DEFAULT_CREATOR_CAPTION_CONFIG.sourceLang).trim().replace(/[^a-zA-Z-]/g, '').slice(0, 12) || DEFAULT_CREATOR_CAPTION_CONFIG.sourceLang;
    cfg.targetLang = String(cfg.targetLang || DEFAULT_CREATOR_CAPTION_CONFIG.targetLang).trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12) || DEFAULT_CREATOR_CAPTION_CONFIG.targetLang;
    const allowed = Object.keys(LIVE_TRANSLATE_LANG_LABELS).filter(x => x !== 'auto');
    const rawTargets = Array.isArray(cfg.targetLangs) ? cfg.targetLangs : [cfg.targetLang];
    cfg.targetLangs = rawTargets.map(x => String(x || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12)).filter(x => allowed.includes(x)).slice(0, 8);
    if (!cfg.targetLangs.length) cfg.targetLangs = [cfg.targetLang || DEFAULT_CREATOR_CAPTION_CONFIG.targetLang];
    cfg.targetLang = cfg.targetLangs[0];
    cfg.whisperLocalExe = String(cfg.whisperLocalExe || '').trim().slice(0, 500);
    cfg.whisperLocalModel = String(cfg.whisperLocalModel || '').trim().slice(0, 500);
    cfg.showOriginal = cfg.showOriginal !== false;
    cfg.autoTargetsEnabled = cfg.autoTargetsEnabled !== false;
    cfg.autoTargetTimeoutSeconds = Math.max(5, Math.min(3600, parseInt(cfg.autoTargetTimeoutSeconds, 10) || DEFAULT_CREATOR_CAPTION_CONFIG.autoTargetTimeoutSeconds));
    cfg.maxItems = Math.max(1, Math.min(6, parseInt(cfg.maxItems, 10) || DEFAULT_CREATOR_CAPTION_CONFIG.maxItems));
    cfg.holdSeconds = Math.max(3, Math.min(30, parseInt(cfg.holdSeconds, 10) || DEFAULT_CREATOR_CAPTION_CONFIG.holdSeconds));
    const silence = parseFloat(cfg.silenceSeconds);
    cfg.silenceSeconds = Math.max(0.5, Math.min(8, Number.isFinite(silence) ? silence : DEFAULT_CREATOR_CAPTION_CONFIG.silenceSeconds));
    return cfg;
}

function sourceLangForTranslate(lang) {
    const short = String(lang || '').toLowerCase().split('-')[0];
    return short || 'auto';
}

let lastCreatorCaptionNorm = '';
let lastCreatorCaptionAt = 0;
function normalizeCaptionDedupeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim();
}
function isLikelyWhisperHallucination(text) {
    const norm = normalizeCaptionDedupeText(text);
    if (!norm) return true;
    const words = norm.split(/\s+/).filter(Boolean);
    const exact = new Set([
        'thank you for watching',
        'thanks for watching',
        'see you next time',
        'see you again in the next video',
        'dont forget to like and subscribe',
        'do not forget to like and subscribe',
        'so you dont miss out on interesting videos',
        'this may be of some help',
        'where are you from',
        'what are you from',
        'skip',
        'face name',
        'shall we do something',
        'de khong bo lo nhung video hap dan',
        'de khong bo lo nhung video moi nhat',
        'de khong bo lo nhung video tiep theo',
        'hay dang ky kenh',
        'nho dang ky kenh',
        'cam on cac ban a',
        'cam on moi nguoi',
        'cam on cac ban da theo doi',
        'hen gap lai cac ban trong video tiep theo'
    ]);
    if (exact.has(norm)) return true;
    const suspicious = [
        'dont miss out on interesting videos',
        'miss out on interesting videos',
        'see you again in the next video',
        'in the next video',
        'like and subscribe',
        'thanks for watching',
        'thank you for watching',
        'this may be of some help',
        'where are you from',
        'so you dont miss out',
        'shall we do something',
        'face name',
        'skip',
        'de khong bo lo',
        'nhung video hap dan',
        'nhung video moi nhat',
        'nhung video tiep theo',
        'dang ky kenh',
        'cam on cac ban a',
        'cam on moi nguoi',
        'cam on cac ban da theo doi',
        'hen gap lai cac ban trong video'
    ];
    if (suspicious.some(s => norm.includes(s))) return true;
    // Very short generic English questions often appear from silence in multilingual models.
    if (words.length <= 5 && /^(who|what|where|how|why)\b/.test(norm)) return true;
    return false;
}

function validateCreatorCaptionAudioMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') throw new Error('missing_audio_metrics');
    const peak = Number(metrics.peak) || 0;
    const rms = Number(metrics.rms) || 0;
    const voicedMs = Number(metrics.voicedMs) || 0;
    const durationMs = Number(metrics.durationMs) || 0;
    if (durationMs && durationMs < 400) throw new Error('audio_too_short');
    if (peak < 0.055 || rms < 0.0065 || voicedMs < 260) throw new Error('audio_not_voice_like');
}

function sourceLangForTranscription(lang) {
    const short = sourceLangForTranslate(lang);
    return short === 'auto' ? '' : short;
}

async function transcribeCreatorCaptionAudio(payload) {
    const cfg = sanitizeCreatorCaptionConfig(appConfig.creatorCaption);
    return transcribeCreatorCaptionAudioLocal(payload, cfg);
}

function runWhisperLocal(exePath, args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const child = spawn(exePath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
            reject(new Error('whisper_local_timeout'));
        }, timeoutMs);
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('error', err => { clearTimeout(timer); reject(err); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error((stderr || stdout || `whisper_exit_${code}`).trim()));
            resolve((stdout || stderr || '').trim());
        });
    });
}

function cleanWhisperOutput(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*\[[^\]]+\]\s*/g, '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function bundledResourcePath(...parts) {
    const roots = [__dirname];
    if (process.resourcesPath && process.resourcesPath !== __dirname) roots.push(process.resourcesPath);
    for (const root of roots) {
        const p = path.join(root, ...parts);
        if (fs.existsSync(p)) return p;
    }
    return '';
}

function resolveWhisperLocalExe(cfg) {
    if (cfg.whisperLocalExe && fs.existsSync(cfg.whisperLocalExe)) return cfg.whisperLocalExe;
    return bundledResourcePath('tools', 'whisper', 'Release', 'whisper-cli.exe')
        || bundledResourcePath('tools', 'whisper', 'whisper-cli.exe');
}

function resolveWhisperLocalModel(cfg) {
    if (cfg.whisperLocalModel && fs.existsSync(cfg.whisperLocalModel)) return cfg.whisperLocalModel;
    return bundledResourcePath('tools', 'whisper', 'models', 'ggml-base.bin');
}

async function transcribeCreatorCaptionAudioLocal(payload, cfg) {
    validateCreatorCaptionAudioMetrics(payload?.audioMetrics);
    const whisperExe = resolveWhisperLocalExe(cfg);
    const whisperModel = resolveWhisperLocalModel(cfg);
    if (!whisperExe) throw new Error('missing_whisper_local_exe');
    if (!whisperModel) throw new Error('missing_whisper_local_model');
    const b64 = String(payload?.audioBase64 || '').replace(/^data:audio\/[^;]+;base64,/, '');
    if (!b64) throw new Error('missing_audio');
    const audio = Buffer.from(b64, 'base64');
    if (!audio.length || audio.length > 12 * 1024 * 1024) throw new Error('invalid_audio_size');
    const tmpDir = path.join(DATA_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const wavPath = path.join(tmpDir, `creator-caption-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
    fs.writeFileSync(wavPath, audio);
    try {
        const lang = sourceLangForTranscription(payload?.sourceLang || cfg.sourceLang) || 'auto';
        const args = ['-m', whisperModel, '-f', wavPath, '-nt', '-np', '-nf', '-sns', '-nth', '0.75'];
        if (lang && lang !== 'auto') args.push('-l', lang);
        const out = await runWhisperLocal(whisperExe, args);
        return cleanWhisperOutput(out);
    } finally {
        try { fs.unlinkSync(wavPath); } catch (e) {}
    }
}

function isLiveTranslateExcludedSource(detectedLang, cfg) {
    const excluded = sourceLangForTranslate(cfg.excludedSourceLang);
    if (!excluded || excluded === 'auto') return false;
    return sourceLangForTranslate(detectedLang) === excluded;
}

async function processCreatorCaptionSpeech(payload) {
    const cfg = sanitizeCreatorCaptionConfig(appConfig.creatorCaption);
    if (Array.isArray(payload?.targetLangs) && payload.targetLangs.length) {
        cfg.targetLangs = sanitizeCreatorCaptionConfig({ ...cfg, targetLangs: payload.targetLangs }).targetLangs;
        cfg.targetLang = cfg.targetLangs[0];
    }
    if (payload?.sourceLang) {
        cfg.sourceLang = sanitizeCreatorCaptionConfig({ ...cfg, sourceLang: payload.sourceLang }).sourceLang;
    }
    if (!cfg.enabled) return;
    const originalText = String(payload?.text || '').trim().replace(/\s{2,}/g, ' ').slice(0, 450);
    if (!originalText) return;
    if (isLikelyWhisperHallucination(originalText)) {
        io.emit('creatorCaption:debug', { type: 'status', text: 'Bỏ qua câu nghi ảo giác Whisper: ' + originalText, ts: Date.now() });
        return;
    }
    const norm = normalizeCaptionDedupeText(originalText);
    const now = Date.now();
    if (norm && norm === lastCreatorCaptionNorm && (now - lastCreatorCaptionAt) < 30000) {
        io.emit('creatorCaption:debug', { type: 'status', text: 'Bỏ qua phụ đề trùng lặp: ' + originalText, ts: now });
        return;
    }
    lastCreatorCaptionNorm = norm;
    lastCreatorCaptionAt = now;
    try {
        const translations = await Promise.all(cfg.targetLangs.map(async targetLang => {
            const result = await translateTextToTarget(originalText, sourceLangForTranslate(cfg.sourceLang), targetLang);
            return {
                targetLang,
                targetLangLabel: liveTranslateLangLabel(targetLang),
                translatedText: result.translatedText,
                sourceLang: result.detectedLang || sourceLangForTranslate(cfg.sourceLang),
                sourceLangLabel: liveTranslateLangLabel(result.detectedLang || sourceLangForTranslate(cfg.sourceLang))
            };
        }));
        const first = translations[0] || {};
        io.emit('creatorCaption:line', {
            id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'),
            originalText,
            translatedText: first.translatedText || originalText,
            translations,
            sourceLang: first.sourceLang || sourceLangForTranslate(cfg.sourceLang),
            targetLang: first.targetLang || cfg.targetLang,
            sourceLangLabel: first.sourceLangLabel || liveTranslateLangLabel(sourceLangForTranslate(cfg.sourceLang)),
            targetLangLabel: first.targetLangLabel || liveTranslateLangLabel(cfg.targetLang),
            showOriginal: cfg.showOriginal,
            maxItems: cfg.maxItems,
            holdSeconds: cfg.holdSeconds,
            createTime: Date.now()
        });
    } catch (e) {
        io.emit('creatorCaption:line', {
            id: crypto.randomBytes(12).toString('hex'),
            originalText,
            translatedText: originalText,
            translations: cfg.targetLangs.map(targetLang => ({ targetLang, targetLangLabel: liveTranslateLangLabel(targetLang), translatedText: originalText })),
            sourceLang: sourceLangForTranslate(cfg.sourceLang),
            targetLang: cfg.targetLang,
            sourceLangLabel: liveTranslateLangLabel(sourceLangForTranslate(cfg.sourceLang)),
            targetLangLabel: liveTranslateLangLabel(cfg.targetLang),
            showOriginal: cfg.showOriginal,
            maxItems: cfg.maxItems,
            holdSeconds: cfg.holdSeconds,
            error: e?.message || 'caption_translate_failed',
            createTime: Date.now()
        });
    }
}

function applyLiveTranslateGlossary(text, glossary) {
    let out = String(text || '');
    for (const row of glossary || []) {
        const parts = String(row).split(/=>|=/);
        if (parts.length < 2) continue;
        const from = parts.shift().trim();
        const to = parts.join('=').trim();
        if (!from || !to) continue;
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(escaped, 'gi'), to);
    }
    return out;
}

function stripLiveTranslateIcons(text) {
    return String(text || '')
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function cleanLiveTranslateUnreadableText(text) {
    return String(text || '')
        .replace(/[\[［][^\]］]{0,160}[\]］]/g, ' ')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}\s.,!?;:'"()\-]{3,}/gu, ' ')
        .replace(/([.,!?;:'"()\-])\1{2,}/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function liveTranslateLangLabel(lang) {
    return LIVE_TRANSLATE_LANG_LABELS[String(lang || '').toLowerCase()] || String(lang || '').toUpperCase();
}

function liveTranslateUserKeys(user) {
    return [user?.userId, user?.uniqueId].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
}
function rememberLiveTranslateUser(map, user) {
    const now = Date.now();
    for (const key of liveTranslateUserKeys(user)) map.set(key, now);
}
function wasLiveTranslateUserRecent(map, user) {
    const now = Date.now();
    return liveTranslateUserKeys(user).some(key => (now - (map.get(key) || 0)) <= LIVE_TRANSLATE_PRIORITY_WINDOW_MS);
}

function liveTranslateForbiddenMatch(haystack, word) {
    const needle = normalizeModerationText(word).trim();
    if (!needle) return false;
    if (!/[a-z0-9]/i.test(needle)) return false;
    if (needle.length <= 2) return haystack.trim() === needle;
    if (/\s/.test(needle)) return haystack.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

function findLiveTranslateBlockedWord(chat, cfg) {
    const words = [...(commentSheetRules.forbiddenWords || []), ...(cfg.forbiddenWords || [])];
    if (!words.length) return '';
    const haystack = normalizeModerationText(String(chat.comment || ''));
    for (const word of words) {
        if (liveTranslateForbiddenMatch(haystack, word)) return String(word || '').trim();
    }
    return '';
}

function detectLiveTranslateToxicText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const normalized = normalizeModerationText(raw)
        .replace(/[@#$%^&*_+=~`|\\/]+/g, ' ')
        .replace(/\s{2,}/g, ' ');
    for (const re of LIVE_TRANSLATE_TOXIC_PATTERNS) {
        if (re.test(raw) || re.test(normalized)) return re.source;
    }
    return '';
}

function shouldSpeakLiveTranslate(chat, cfg) {
    if (!cfg.ttsEnabled) return false;
    const user = { userId: chat.userId, uniqueId: chat.uniqueId };
    const isGifter = wasLiveTranslateUserRecent(liveTranslateRecentGifts, user);
    const isMember = wasLiveTranslateUserRecent(liveTranslateRecentMembers, user);
    if (cfg.ttsPriority === 'gifters' && !isGifter) return false;
    if (cfg.ttsPriority === 'members' && !isMember) return false;
    if (cfg.ttsPriority === 'giftersOrMembers' && !isGifter && !isMember) return false;
    const cooldownMs = (cfg.ttsCooldownSeconds || 0) * 1000;
    if (cooldownMs > 0) {
        const key = liveTranslateUserKeys(user)[0] || 'guest';
        const now = Date.now();
        if (now - (liveTranslateLastSpoken.get(key) || 0) < cooldownMs) return false;
        liveTranslateLastSpoken.set(key, now);
    }
    return true;
}

async function translateTextToTarget(text, sourceLang, targetLang) {
    const cleanText = String(text || '').trim().slice(0, 450);
    if (!cleanText) return { translatedText: '', detectedLang: sourceLang || 'auto' };
    const sl = sourceLang && sourceLang !== 'auto' ? sourceLang : 'auto';
    const cacheKey = `${sl}:${targetLang}:${cleanText}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
    let translated = '';
    let detectedLang = sl;
    try {
        const googleUrl = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl='
            + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(targetLang) + '&q=' + encodeURIComponent(cleanText);
        const res = await fetch(googleUrl, { timeout: 10000, headers: { 'User-Agent': 'HP-Action-LIVE/translate-mvp' } });
        if (!res.ok) throw new Error(`google_http_${res.status}`);
        const body = await res.json();
        translated = Array.isArray(body?.[0]) ? body[0].map(part => part?.[0] || '').join('') : '';
        if (body?.[2]) detectedLang = String(body[2]).toLowerCase();
    } catch (e) {
        const fallbackUrl = 'https://api.mymemory.translated.net/get?q='
            + encodeURIComponent(cleanText) + '&langpair=' + encodeURIComponent(sl) + '|' + encodeURIComponent(targetLang);
        const res = await fetch(fallbackUrl, { timeout: 10000, headers: { 'User-Agent': 'HP-Action-LIVE/translate-mvp' } });
        if (!res.ok) throw new Error(`translate_http_${res.status}`);
        const body = await res.json();
        translated = String(body?.responseData?.translatedText || '').trim();
    }
    const result = { translatedText: String(translated || cleanText).trim() || cleanText, detectedLang };
    translationCache.set(cacheKey, result);
    if (translationCache.size > TRANSLATION_CACHE_LIMIT) {
        const firstKey = translationCache.keys().next().value;
        if (firstKey) translationCache.delete(firstKey);
    }
    return result;
}

function processLiveTranslateChat(chat) {
    liveTranslateStats.chatSeen += 1;
    liveTranslateStats.lastChatAt = Date.now();
    const cfg = sanitizeLiveTranslateConfig(appConfig.liveTranslate);
    // CHAT chỉ fire khi TikTok connection còn sống; không chặn thêm bằng state phụ
    // vì một số phiên tiktok-live-connector không cập nhật isConnected ổn định.
    if (!cfg.enabled) {
        liveTranslateStats.skippedDisabled += 1;
        liveTranslateStats.lastSkipReason = 'disabled';
        return;
    }
    if (!chat?.comment) {
        liveTranslateStats.skippedEmpty += 1;
        liveTranslateStats.lastSkipReason = 'empty_comment';
        return;
    }
    const blockedWord = findLiveTranslateBlockedWord(chat, cfg);
    if (blockedWord) {
        liveTranslateStats.skippedBlocked += 1;
        liveTranslateStats.lastSkipReason = 'blocked_rule';
        liveTranslateStats.lastBlockedWord = blockedWord;
        return;
    }
    let textOnlyComment = cfg.ignoreIcons ? stripLiveTranslateIcons(chat.comment) : String(chat.comment || '').trim();
    if (cfg.cleanUnreadable) textOnlyComment = cleanLiveTranslateUnreadableText(textOnlyComment);
    if (!textOnlyComment) {
        liveTranslateStats.skippedEmpty += 1;
        liveTranslateStats.lastSkipReason = 'empty_after_clean';
        return;
    }
    const normalizedComment = applyLiveTranslateGlossary(textOnlyComment, [...(commentSheetRules.glossary || []), ...(cfg.glossary || [])]);
    if (!normalizedComment) {
        liveTranslateStats.skippedEmpty += 1;
        liveTranslateStats.lastSkipReason = 'empty_after_glossary';
        return;
    }
    const toxicReason = cfg.aiFilterEnabled ? detectLiveTranslateToxicText(normalizedComment) : '';
    if (toxicReason) {
        liveTranslateStats.skippedToxic += 1;
        liveTranslateStats.lastSkipReason = 'ai_toxic_read_filter';
    }
    translateTextToTarget(normalizedComment, cfg.sourceLang, cfg.targetLang)
        .then(result => {
            const sourceLang = result.detectedLang || cfg.sourceLang || 'auto';
            if (isLiveTranslateExcludedSource(sourceLang, cfg)) {
                liveTranslateStats.skippedExcludedLanguage += 1;
                liveTranslateStats.lastSkipReason = 'excluded_language';
                return;
            }
            liveTranslateStats.emitted += 1;
            liveTranslateStats.lastEmitAt = Date.now();
            liveTranslateStats.lastSkipReason = '';
            const item = {
                id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'),
                uniqueId: chat.uniqueId,
                nickname: chat.nickname,
                userId: chat.userId,
                profilePicture: chat.profilePicture,
                originalText: chat.comment,
                normalizedText: normalizedComment,
                translatedText: result.translatedText,
                sourceLang,
                targetLang: cfg.targetLang,
                sourceLangLabel: liveTranslateLangLabel(sourceLang),
                targetLangLabel: liveTranslateLangLabel(cfg.targetLang),
                readUsername: cfg.readUsername,
                ttsEnabled: cfg.ttsEnabled,
                ttsVoice: cfg.ttsVoice,
                ttsPreset: cfg.ttsPreset,
                ttsReadMode: cfg.ttsReadMode,
                ttsVolume: cfg.ttsVolume,
                ttsRate: cfg.ttsRate,
                toxic: !!toxicReason,
                canSpeak: !toxicReason && shouldSpeakLiveTranslate(chat, cfg),
                createTime: chat.createTime || Date.now()
            };
            io.emit('translate:comment', item);
            setLiveDashboardTranslatedComment(item);
        })
        .catch(err => {
            liveTranslateStats.translateErrors += 1;
            liveTranslateStats.lastError = err?.message || 'translate_failed';
            liveTranslateStats.emitted += 1;
            liveTranslateStats.lastEmitAt = Date.now();
            const item = {
                id: crypto.randomBytes(12).toString('hex'),
                uniqueId: chat.uniqueId,
                nickname: chat.nickname,
                userId: chat.userId,
                profilePicture: chat.profilePicture,
                originalText: chat.comment,
                normalizedText: normalizedComment,
                translatedText: normalizedComment,
                sourceLang: cfg.sourceLang,
                targetLang: cfg.targetLang,
                sourceLangLabel: liveTranslateLangLabel(cfg.sourceLang),
                targetLangLabel: liveTranslateLangLabel(cfg.targetLang),
                readUsername: cfg.readUsername,
                ttsEnabled: cfg.ttsEnabled,
                ttsVoice: cfg.ttsVoice,
                ttsPreset: cfg.ttsPreset,
                ttsReadMode: cfg.ttsReadMode,
                ttsVolume: cfg.ttsVolume,
                ttsRate: cfg.ttsRate,
                toxic: !!toxicReason,
                canSpeak: !toxicReason && shouldSpeakLiveTranslate(chat, cfg),
                error: err?.message || 'translate_failed',
                createTime: chat.createTime || Date.now()
            };
            io.emit('translate:comment', item);
            setLiveDashboardTranslatedComment(item);
        });
}

// ====== Gift list loader (via license-server proxy) ======
let giftMap = {};
let giftList = [];

// ====== Gift list disk cache ======
// Vì sao: trên 1 số PC, cả license-server (hp-license.nguyenvu.dev) lẫn fallback
// Google Sheet đều bị firewall/AV chặn → loadGiftSheet() trả [] → panel "📦 Danh
// sách quà" rỗng, badge effects mất ảnh quà gốc. Cache đĩa ở DATA_DIR đảm bảo:
//   - Lần đầu fetch thành công → ghi cache
//   - Lần sau (offline / blocked) → đọc cache → vẫn hiển thị đủ
// File ở DATA_DIR (= userData/data trên Electron build, ../data trên dev) cùng
// app-config.json — persist across upgrades.
const GIFT_CACHE_FILE = path.join(DATA_DIR, 'gift-sheet-cache.json');

function loadGiftCacheFromDisk() {
    try {
        if (!fs.existsSync(GIFT_CACHE_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(GIFT_CACHE_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('[gift-sheet] Cache đọc fail:', e.message);
        return [];
    }
}
function saveGiftCacheToDisk(list) {
    try {
        if (!Array.isArray(list) || list.length === 0) return;
        fs.writeFileSync(GIFT_CACHE_FILE, JSON.stringify(list), 'utf8');
    } catch (e) {
        console.warn('[gift-sheet] Cache lưu fail:', e.message);
    }
}

// Eager load cache trên startup — socket client đầu tiên connect đã nhận được
// list ngay, không phải đợi 15s timeout của license-server. loadGiftSheet() sau
// đó refresh nếu network OK.
(function eagerLoadGiftCache() {
    const cached = loadGiftCacheFromDisk();
    if (cached.length > 0) {
        giftList = cached.slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
        for (const g of giftList) {
            if (g && g.id) giftMap[String(g.id)] = g;
        }
        console.log(`[gift-sheet] Eager load cache: ${giftList.length} quà (sẽ refresh từ network)`);
    }
})();

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
        // Vẫn giữ giftList hiện tại (có thể đã eager-load từ cache đĩa) — không
        // emit empty list, vì empty sẽ ghi đè state tốt của client.
        if (giftList.length === 0) io.emit('giftSheet', giftList);
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
    // Cả license-server lẫn Google Sheet đều fail (firewall, AV, no internet)
    // → fall back về cache đĩa nếu có. Không ghi đè giftList hiện tại bằng [].
    if (listFromServer.length === 0) {
        const cached = loadGiftCacheFromDisk();
        if (cached.length > 0) {
            console.warn(`[gift-sheet] Network fail toàn bộ → dùng cache đĩa: ${cached.length} quà`);
            listFromServer = cached;
        } else {
            console.error('[gift-sheet] Network fail VÀ không có cache → giữ giftList hiện tại');
            // Không reset. giftList giữ nguyên (có thể có data eager-load lúc init, hoặc rỗng nếu install mới).
            io.emit('giftSheet', giftList);
            return giftList;
        }
    }
    // Sort theo Kim Cương ASC (thấp → cao). Áp dụng cho cả nguồn license-server
    // lẫn fallback Google Sheet trực tiếp.
    giftList = listFromServer.slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
    giftMap = {};
    for (const g of giftList) {
        if (g && g.id) giftMap[String(g.id)] = g;
    }
    // Ghi cache đĩa MỖI lần load thành công — máy chỉ cần online 1 lần là gift
    // sheet persist mãi mãi cho các lần khởi động sau (kể cả offline).
    saveGiftCacheToDisk(giftList);
    console.log(`[gift-sheet] Đã tải ${giftList.length} quà (sort theo Kim Cương ASC).`);
    io.emit('giftSheet', giftList);
    return giftList;
}

// ============================================================
// LICENSE VALIDATION — HP KEY (hpvn.media)
// ============================================================
// Thay backend cũ (Cloudflare Worker / Google Sheet) bằng HP KEY.
// Cấu hình: hpkey/config.js + hpkey/secret.local.js + hpkey/public-key.js.
// Giữ nguyên interface validateLicenseKey() nên gate + role không phải sửa.
// (gift-sheet & auto-update vẫn dùng LICENSE_WORKER_URL cũ — không đổi)
const { validateLicenseKey } = require('./hpkey/validate');

// ====== TikTok connection ======
let connection = null;
let currentUsername = null;
let connecting = false;
let liveConnected = false;
let currentRoomId = null;
let currentHostUserId = '';   // owner.userId của room đang connect — dùng để identify host team trong PK
let currentHostProfile = null;   // { uniqueId, nickname, profilePic, userId } — broadcast cho Caro avatar mode
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
    emitLiveDashboard();
}
function emitLiveStatsImmediate() {
    lastStatsEmit = Date.now();
    io.emit('liveStats', liveStats);
    emitLiveDashboard();
}

function broadcast(type, payload) { io.emit(type, payload); }
function isTikTokLiveConnected() { return !!(connection && liveConnected); }

function attachConnectionEvents(conn) {
    conn.on(ControlEvent.CONNECTED, (state) => {
        liveConnected = true;
        currentRoomId = state?.roomId;
        broadcast('status', { connected: true, username: currentUsername, roomId: currentRoomId });
        setLiveDashboardStatus(true, { username: currentUsername, roomId: currentRoomId });
        console.log(`[tiktok] Connected to roomId=${currentRoomId}`);
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
        liveConnected = false;
        broadcast('status', { connected: false, username: currentUsername });
        setLiveDashboardStatus(false, { username: currentUsername });
        console.log('[tiktok] Disconnected');
    });
    conn.on(WebcastEvent.STREAM_END, () => {
        liveConnected = false;
        broadcast('status', { connected: false, username: currentUsername, reason: 'streamEnd' });
        setLiveDashboardStatus(false, { username: currentUsername });
    });
    conn.on(ControlEvent.ERROR, (err) => {
        console.error('[tiktok] error:', err?.message || err);
        broadcast('error', { message: err?.message || String(err) });
    });

    conn.on(WebcastEvent.CHAT, (data) => {
        liveConnected = true;
        const uniqueId = data?.user?.uniqueId;
        const userId = data?.user?.userId;
        const nickname = data?.user?.nickname;
        const level = Number(data?.user?.userHonor?.level) || 0;
        const profilePicture = data?.user?.profilePicture?.url || data?.user?.profilePictureUrl;
        const verified = !!data?.user?.verified;
        const comment = data?.comment;
        rememberUserMapping(userId, uniqueId);
        const chatPayload = {
            uniqueId, nickname,
            userId,
            profilePicture,
            comment,
            createTime: Date.now()
        };
        broadcast('chat', chatPayload);
        processLiveTranslateChat(chatPayload);
        // First-seen JOIN fallback + dedicated 'comment' trigger
        maybeFireFirstSeenJoin(uniqueId, nickname, level, profilePicture, 'chat', verified, userId);
        try { handleVipWelcomeEvent('comment', { uniqueId, nickname, level, profilePicture, verified, comment }); } catch (e) {}
        try { handleVoteCommentChat({ uniqueId, comment }); } catch (e) {}
    });

    conn.on(WebcastEvent.GIFT, (data) => {
        const giftType = data?.giftDetails?.giftType ?? data?.gift?.gift_type ?? data?.giftType;
        const isStreak = Number(giftType) === 1;
        maybeTriggerPkItemFromGift(data);
        const repeatEnded = data?.repeatEnd ?? data?.repeat_end ?? data?.isStreakEnd ?? data?.is_streak_end;
        if (isStreak && !repeatEnded) return;
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
            repeatCount: normalizeGiftRepeatCount(data),
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
        rememberLiveTranslateUser(liveTranslateRecentMembers, { userId, uniqueId });
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
    //   x2 / x3  ← LINK_MIC_BATTLE_TASK settle/reward payload có multiplier
    //   warn10s  ← fallback timer hoặc khi server gửi countdown
    //   lead/behind ← periodic check ARMIES (mỗi 30s)
    //   win/lose ← FINISH + so sánh scores với hostTeamIndex
    //   glove/mist/hammer/time ← GIFT item PK theo giftName/describe/label/monitorExtra

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
    let pkMissionTriggered = false;
    let pkBonusTriggered = new Set();
    let pkItemGiftSeen = new Map();
    let pkPendingRewardMultiple = 0;
    let pkWarn10sScheduled = false;
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
        pkMissionTriggered = false;
        pkBonusTriggered = new Set();
        pkItemGiftSeen.clear();
        pkPendingRewardMultiple = 0;
        pkWarn10sScheduled = false;
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

    function prunePkItemSeen(now = Date.now()) {
        for (const [k, ts] of pkItemGiftSeen) {
            if (now - ts > 60_000) pkItemGiftSeen.delete(k);
        }
    }

    function collectTextFields(value, out = []) {
        if (value == null) return out;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            out.push(String(value));
            return out;
        }
        if (Array.isArray(value)) {
            for (const item of value) collectTextFields(item, out);
            return out;
        }
        if (typeof value === 'object') {
            for (const item of Object.values(value)) collectTextFields(item, out);
        }
        return out;
    }

    function detectPkItemFromGift(data) {
        const matchInfo = data?.matchInfo || {};
        if (matchInfo.effectCardInUse || String(matchInfo.critical || '') === '1' || Number(matchInfo.multiplierValue || 0) >= 5) {
            return 'glove';
        }
        return detectPkItemFromAny(data);
    }

    function detectPkItemFromAny(data) {
        const text = collectTextFields({
            giftId: data?.giftId ?? data?.gift?.gift_id ?? data?.giftDetails?.giftId,
            giftName: data?.giftDetails?.giftName || data?.gift?.name || data?.giftName,
            describe: data?.describe,
            label: data?.label,
            displayType: data?.displayType,
            monitorExtra: data?.monitorExtra,
            extendedGiftInfo: data?.extendedGiftInfo,
            prompts: data?.prompts,
            tips: data?.tips,
            subType: data?.subType,
            messageType: data?.messageType,
            data
        }).join(' ').toLowerCase();
        if (!text) return '';
        if (/critical\s*strike|boost(?:ing)?\s*glove|boxing\s*glove|\bglove\b|g[aă]ng\s*tay/.test(text)) return 'glove';
        if (/magic\s*mist|\bmist\b|\bfog\b|s[uư]ơng\s*m[uù]/.test(text)) return 'mist';
        if (/stun\s*hammer|\bhammer\b|b[uú]a\s*(cho[aá]ng|ho[aá]ng)/.test(text)) return 'hammer';
        if (/time[-\s]*maker|add\s*time|extra\s*time|th[eê]m\s*gi[oờ]|\btime\b/.test(text)) return 'time';
        return '';
    }

    function maybeTriggerPkItemFromGift(data) {
        const key = detectPkItemFromGift(data);
        if (!key) return;
        const now = Date.now();
        prunePkItemSeen(now);
        const giftId = String(data?.giftId ?? data?.gift?.gift_id ?? data?.giftDetails?.giftId ?? '');
        const uniqueId = data?.user?.uniqueId || data?.uniqueId || '';
        const msgId = data?.msgId || data?.messageId || data?.common?.msgId || '';
        const groupId = data?.groupId || data?.gift?.group_id || data?.monitorExtra?.log_id || '';
        const dedupeKey = [key, giftId, uniqueId, groupId || msgId || Date.now()].join(':');
        if (pkItemGiftSeen.has(dedupeKey)) return;
        pkItemGiftSeen.set(dedupeKey, now);
        pkAutoEnqueue(key, `gift_item (${key}, giftId=${giftId || 'unknown'}, user=@${uniqueId || 'unknown'})`);
    }

    function maybeTriggerPkItemFromLinkEvent(data, source) {
        const key = detectPkItemFromAny(data);
        if (!key) return;
        const now = Date.now();
        prunePkItemSeen(now);
        const battleId = data?.battleId || data?.channelId || data?.common?.roomId || '';
        const dedupeKey = [source, key, battleId, data?.messageType || '', data?.subType || ''].join(':');
        if (pkItemGiftSeen.has(dedupeKey) && now - pkItemGiftSeen.get(dedupeKey) < 10_000) return;
        pkItemGiftSeen.set(dedupeKey, now);
        pkAutoEnqueue(key, `${source}_item (${key})`);
    }

    function detectPkBonusMultiplier(data) {
        const text = collectTextFields(data).join(' ').toLowerCase();
        if (/x\s*3|3\s*x|nh[aâ]n\s*3|multiplier[^0-9]{0,12}3|score[^0-9]{0,12}3|speed[^0-9]{0,12}3/.test(text)) return 3;
        if (/x\s*2|2\s*x|nh[aâ]n\s*2|multiplier[^0-9]{0,12}2|score[^0-9]{0,12}2|speed[^0-9]{0,12}2/.test(text)) return 2;
        return 0;
    }

    function maybeTriggerPkBonus(data, reason) {
        const multiplier = detectPkBonusMultiplier(data);
        if (multiplier !== 2 && multiplier !== 3) return;
        triggerPkBonus(multiplier, reason);
    }

    function triggerPkBonus(multiplier, reason) {
        const key = multiplier === 3 ? 'x3' : 'x2';
        if (pkBonusTriggered.has(key)) return;
        pkBonusTriggered.add(key);
        pkAutoEnqueue(key, `${reason}_x${multiplier}`);
    }

    function readRewardMultiple(data) {
        const direct = Number(
            data?.taskStart?.battleBonusConfig?.rewardPeriodConfig?.rewardMultiple ||
            data?.battleBonusConfig?.rewardPeriodConfig?.rewardMultiple ||
            data?.rewardPeriodConfig?.rewardMultiple ||
            0
        );
        if (direct === 2 || direct === 3) return direct;
        return detectPkBonusMultiplier(data);
    }

    function isTaskSettleSucceeded(data) {
        const result = data?.taskSettle?.taskResult;
        const rewardStatus = data?.rewardSettle?.status;
        if (result === 0 || result === 2) return true;
        if (rewardStatus === 0) return true;
        return false;
    }

    function getBattleDurationSec(data) {
        return Number(
            data?.battleSetting?.duration ||
            data?.battleSettings?.duration ||
            data?.battleConfig?.battleSetting?.duration ||
            data?.battleConfig?.duration ||
            data?.duration ||
            0
        );
    }

    function getBattleEndDelayMs(data) {
        const endTime = Number(
            data?.battleSetting?.endTimeMs ||
            data?.battleSettings?.endTimeMs ||
            data?.battleConfig?.battleSetting?.endTimeMs ||
            0
        );
        if (endTime > 0) return endTime - Date.now();
        const startTime = Number(
            data?.battleSetting?.startTimeMs ||
            data?.battleSettings?.startTimeMs ||
            data?.battleConfig?.battleSetting?.startTimeMs ||
            0
        );
        const durationSec = getBattleDurationSec(data);
        if (startTime > 0 && durationSec > 0) return (startTime + durationSec * 1000) - Date.now();
        if (durationSec > 20 && pkStartTs > 0) return (pkStartTs + durationSec * 1000) - Date.now();
        return 0;
    }

    function scheduleWarn10s(data, reason) {
        if (!pkActive || pkWarn10sScheduled) return;
        const endDelayMs = getBattleEndDelayMs(data);
        const durationSec = getBattleDurationSec(data);
        let warnDelay = endDelayMs > 0 ? endDelayMs - 10_000 : 0;
        if (warnDelay <= 0 && durationSec > 20) warnDelay = (durationSec - 10) * 1000;
        if (warnDelay > 0) {
            pkWarn10sScheduled = true;
            console.log(`[pktiktok] PK warn10s scheduled in ${(warnDelay / 1000).toFixed(1)}s (reason=${reason}, duration=${durationSec || 'n/a'})`);
            pkTimers.push(setTimeout(() => {
                if (pkActive) pkAutoEnqueue('warn10s', `warn10s_${reason}`);
            }, warnDelay));
        }
    }

    // Helper: extract teams + scores từ raw armies/battle data — log tất cả để debug
    function parseTeamsArmies(data) {
        const teams = [];
        const raw = data?.teamArmies || data?.battleArmies || data?.battleItems || data?.teams || data?.armies || [];
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});
        if (Array.isArray(list)) {
            for (let i = 0; i < list.length; i++) {
                const t = list[i];
                const score = Number(t?.teamTotalScore ?? t?.userArmies?.hostScore ?? t?.hostScore ?? t?.points ?? t?.totalScore ?? t?.score ?? t?.totalDiamondCount ?? t?.totalUserCount ?? 0);
                const linkedUsers = [t?.hostsList, t?.hosts, t?.userList]
                    .flatMap(v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));
                const anchorIds = [
                    t?.hostUserId, t?.anchorIdStr, t?.userArmies?.anchorIdStr, t?.hostUser?.userId, t?.hostUser?.id,
                    ...(t?.teamUsers || []), ...linkedUsers
                ].map(u => String(u?.userId || u?.id || u?.uniqueId || u || '')).filter(Boolean);
                teams.push({ index: i, score, anchorIds, raw: t });
            }
        }
        if (teams.length === 0 && Array.isArray(data?.battleUsers)) {
            for (let i = 0; i < data.battleUsers.length; i++) {
                const u = data.battleUsers[i];
                teams.push({ index: i, score: 0, anchorIds: [String(u?.userId || u?.id || u?.uniqueId || '')].filter(Boolean), raw: u });
            }
        }
        return teams;
    }

    conn.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
        const action = data?.battleConfig?.battleAction ?? data?.action ?? null;
        const battleStatus = data?.battleStatus;
        const currentRound = data?.currentRound;
        console.log(`[pktiktok] LINK_MIC_BATTLE action=${action} status=${battleStatus} round=${currentRound} keys=${Object.keys(data || {}).join(',').slice(0,200)}`);
        if (action === 4 /* OPEN */ || (action == null && !pkActive && (Array.isArray(data?.battleUsers) || data?.anchorInfo || data?.battleId))) {
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
                if (pkHostTeamIndex < 0 && teams.length > 0 && Array.isArray(data?.battleUsers)) {
                    const hostIdx = data.battleUsers.findIndex(u => String(u?.userId || u?.id || '') === ownerId);
                    if (hostIdx >= 0) pkHostTeamIndex = hostIdx;
                }
                if (pkHostTeamIndex < 0 && teams.length > 0) pkHostTeamIndex = 0;
                console.log(`[pktiktok] PK OPEN: hostTeamIndex=${pkHostTeamIndex}, teams=${teams.length}, ownerId=${ownerId}`);
            } catch (e) {}
            scheduleWarn10s(data, 'battle_open');
            if (!pkWarn10sScheduled) console.log(`[pktiktok] PK duration/endTime chưa có trong LINK_MIC_BATTLE — sẽ thử lại ở ARMIES`);
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
        const descText = data?.taskDescription || data?.description || data?.text || '';
        const rewardMultiple = readRewardMultiple(data);
        console.log(`[pktiktok] LINK_MIC_BATTLE_TASK type=${type} rewardMultiple=${rewardMultiple || '-'} pending=${pkPendingRewardMultiple || '-'} success=${isTaskSettleSucceeded(data)} keys=${Object.keys(data || {}).join(',').slice(0,200)}`);
        if (type === 0 /* START */) {
            if (!pkMissionTriggered) {
                pkMissionTriggered = true;
                pkAutoEnqueue('mission', 'task_start');
            }
            if (rewardMultiple === 2 || rewardMultiple === 3) {
                pkPendingRewardMultiple = rewardMultiple;
                console.log(`[pktiktok] PK task rewardMultiple cached: x${pkPendingRewardMultiple}`);
            }
        } else if (type === 2 /* SETTLE */ || type === 3 /* REWARD_SETTLE */) {
            const settledMultiple = rewardMultiple || pkPendingRewardMultiple;
            if ((settledMultiple === 2 || settledMultiple === 3) && isTaskSettleSucceeded(data)) {
                triggerPkBonus(settledMultiple, type === 2 ? 'task_settle_success' : 'task_reward_settle_success');
            } else if (settledMultiple === 2 || settledMultiple === 3) {
                console.log(`[pktiktok] PK task settle không success → không phát x${settledMultiple}`);
            }
        } else {
            if (rewardMultiple === 2 || rewardMultiple === 3) pkPendingRewardMultiple = rewardMultiple;
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
            scheduleWarn10s(data, 'armies');
            if (data?.triggerCriticalStrike) {
                pkAutoEnqueue('glove', `armies_critical_strike (giftId=${data?.giftId || 'unknown'})`);
            }
        } catch (e) { console.error('[pktiktok] armies parse error:', e); }
    });
    conn.on(WebcastEvent.LINK_MIC_METHOD, (data) => {
        try {
            maybeTriggerPkItemFromLinkEvent(data, 'linkmic_method');
            if (!pkWarn10sScheduled) scheduleWarn10s(data, 'linkmic_method');
            console.log(`[pktiktok] LINK_MIC_METHOD messageType=${data?.messageType} subType=${data?.subType || ''} duration=${data?.duration || ''}`);
        } catch (e) { console.error('[pktiktok] linkMicMethod parse error:', e); }
    });
    conn.on(WebcastEvent.LINK_MESSAGE, (data) => {
        try {
            maybeTriggerPkItemFromLinkEvent(data, 'link_message');
        } catch (e) { console.error('[pktiktok] linkMessage parse error:', e); }
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
function normalizeGiftRepeatCount(data) {
    const raw = data?.repeatCount
        ?? data?.repeat_count
        ?? data?.comboCount
        ?? data?.combo_count
        ?? data?.gift?.repeat_count
        ?? data?.gift?.repeatCount
        ?? data?.giftDetails?.repeatCount
        ?? 1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 1;
}
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
    rememberLiveTranslateUser(liveTranslateRecentGifts, g);
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
    console.log(`[gift] emit → ${enriched.nickname || enriched.uniqueId} sent "${enriched.giftName || '?'}" (id=${enriched.giftId}, x${enriched.repeatCount || 1}, ${enriched.coinValue || 0}💎)`);
    io.emit('gift', enriched);
    setLiveDashboardGift(enriched);
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
    // Vote Bình Luận — ưu tiên row có gán giftId; fallback last-vote
    try {
        handleVoteCommentGift({
            uniqueId: g.uniqueId,
            giftId: g.giftId,
            coinValue: enriched.coinValue || 0,
            repeatCount: g.repeatCount || 1
        });
    } catch (e) { /* non-fatal */ }
    // Biểu Cảm Nhiệt Độ — quà tăng/giảm nhiệt theo công thức trong config
    try {
        handleNhietDoGift({
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            profilePicture: g.profilePicture || enriched.image,
            giftId: g.giftId,
            coinValue: enriched.coinValue || 0,
            repeatCount: g.repeatCount || 1
        });
    } catch (e) { /* non-fatal */ }
}

function makeTikTokConnectOptions(extra = {}) {
    return {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        wsClientHeaders: {
            Origin: 'https://www.tiktok.com',
            Referer: 'https://www.tiktok.com/',
            ...(extra.wsClientHeaders || {})
        },
        webClientHeaders: {
            Origin: 'https://www.tiktok.com',
            Referer: 'https://www.tiktok.com/',
            ...(extra.webClientHeaders || {})
        },
        wsClientOptions: { timeout: 20000, ...(extra.wsClientOptions || {}) },
        webClientOptions: { timeout: 20000, ...(extra.webClientOptions || {}) },
        ...extra
    };
}

function hasTikTokMobileAuth() {
    return !!(
        process.env.TIKTOK_X_OAUTH_TOKEN ||
        process.env.TIKTOK_OAUTH_TOKEN ||
        process.env.TIKTOK_X_COOKIE_HEADER ||
        process.env.TIKTOK_COOKIE_HEADER
    );
}

function isRetryableTikTokConnectError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (!msg) return false;
    if (msg.includes("isn't online") || msg.includes('not online') || msg.includes('offline')) return false;
    if (msg.includes('already connected') || msg.includes('already connecting')) return false;
    return msg.includes('websocket') || msg.includes('unexpected server response') || msg.includes('not responding') || msg.includes('sign server') || msg.includes('fetch failed') || msg.includes('timeout');
}

function normalizeTikTokConnectError(err, attempts = []) {
    const msg = String(err?.message || err || 'connect_failed');
    if (/unexpected server response:\s*200/i.test(msg)) {
        return 'TikTok trả HTTP 200 thay vì nâng cấp WebSocket. Thường do TikTok/sign-server đổi route tạm thời hoặc mạng/proxy chặn WebSocket. App đã thử fallback nhưng vẫn chưa kết nối được, hãy thử lại sau vài giây.';
    }
    if (/websocket not responding/i.test(msg)) return 'WebSocket TikTok không phản hồi trong thời gian chờ. Hãy thử kết nối lại.';
    if (attempts.length > 1) return `${msg} (đã thử ${attempts.length} đường kết nối)`;
    return msg;
}

async function createTikTokConnectionWithFallback(username) {
    const attempts = [
        { label: 'web', options: makeTikTokConnectOptions() }
    ];
    if (hasTikTokMobileAuth()) {
        attempts.push(
            { label: 'web-mobile-sign', options: makeTikTokConnectOptions({ useMobile: true }) },
            { label: 'uniqueid-mobile-sign', options: makeTikTokConnectOptions({ connectWithUniqueId: true, useMobile: true }) }
        );
    }
    const errors = [];
    for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const conn = new TikTokLiveConnection(username, attempt.options);
        attachConnectionEvents(conn);
        try {
            console.log(`[tiktok] Connect attempt ${i + 1}/${attempts.length}: ${attempt.label}`);
            const state = await conn.connect();
            return { conn, state, attempt: attempt.label, errors };
        } catch (err) {
            const message = String(err?.message || err || 'connect_failed');
            errors.push({ attempt: attempt.label, message });
            console.warn(`[tiktok] Connect attempt failed (${attempt.label}): ${message}`);
            try { await conn.disconnect(); } catch (e) {}
            if (!isRetryableTikTokConnectError(err) || i === attempts.length - 1) {
                const out = new Error(normalizeTikTokConnectError(err, errors));
                out.cause = err;
                out.attempts = errors;
                throw out;
            }
            await new Promise(resolve => setTimeout(resolve, 900 + i * 700));
        }
    }
}

async function connectToUser(username) {
    if (connecting) throw new Error('Đang kết nối, vui lòng chờ...');
    if (connection) { try { await connection.disconnect(); } catch (e) {} connection = null; }
    liveConnected = false;
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
        const connected = await createTikTokConnectionWithFallback(currentUsername);
        connection = connected.conn;
        const state = connected.state;
        console.log(`[tiktok] Connected via ${connected.attempt}`);
        liveConnected = true;
        currentRoomId = state?.roomId;
        // Synthetic "host vào phòng" event — TikTok không fire MEMBER cho HOST tự kết nối live của mình.
        const hostNickname = state?.roomInfo?.owner?.nickname || state?.roomInfo?.owner?.uniqueId || currentUsername;
        const hostLevel = Number(state?.roomInfo?.owner?.userHonor?.level) || 0;
        const hostPic = state?.roomInfo?.owner?.profilePicture?.url || '';
        const hostVerified = !!state?.roomInfo?.owner?.verified;
        currentHostUserId = String(
            state?.roomInfo?.owner?.userId ||
            state?.roomInfo?.owner?.idStr ||
            state?.roomInfo?.owner?.id_str ||
            state?.roomInfo?.owner?.id ||
            state?.roomInfo?.owner_user_id_str ||
            state?.roomInfo?.owner_user_id ||
            ''
        );
        // Lấy followerCount của HOST từ roomInfo
        const followerCount = Number(state?.roomInfo?.owner?.followInfo?.followerCount) || 0;
        if (followerCount > 0) {
            liveStats.followerCount = followerCount;
            emitLiveStatsImmediate();
        }
        setTimeout(() => {
            maybeFireFirstSeenJoin(currentUsername, hostNickname, hostLevel, hostPic, 'hostConnect', hostVerified);
        }, 300);
        // Lưu host profile vào RAM + emit cho client (Caro panel cần để hiển thị avatar CREATOR)
        currentHostProfile = {
            uniqueId: currentUsername || '',
            nickname: hostNickname || '',
            profilePic: hostPic || '',
            userId: currentHostUserId || '',
            level: hostLevel || 0,
            verified: !!hostVerified
        };
        io.emit('hostInfo', currentHostProfile);
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

app.get('/api/live-translate/config', (req, res) => {
    appConfig.liveTranslate = sanitizeLiveTranslateConfig(appConfig.liveTranslate);
    res.json({ ...appConfig.liveTranslate, sheetRules: getCommentRulesMeta() });
});

app.post('/api/live-translate/config', (req, res) => {
    appConfig.liveTranslate = sanitizeLiveTranslateConfig(req.body || {});
    saveAppConfig();
    io.emit('translate:config', appConfig.liveTranslate);
    res.json({ ok: true, config: appConfig.liveTranslate });
});

app.get('/api/live-translate/rules', (req, res) => {
    res.json(getCommentRulesMeta());
});

app.post('/api/live-translate/rules/reload', async (req, res) => {
    await refreshCommentRulesSheet();
    res.json({ ok: !commentSheetRules.error, ...getCommentRulesMeta() });
});

// Trả về full danh sách từ cấm (cho client lọc nội dung — vd Caro TTS không đọc tên có từ cấm)
app.get('/api/comment-rules/list', (req, res) => {
    res.json({
        ok: !commentSheetRules.error,
        forbiddenWords: commentSheetRules.forbiddenWords || [],
        ...getCommentRulesMeta()
    });
});

app.post('/api/live-translate/test-tts', (req, res) => {
    const cfg = sanitizeLiveTranslateConfig(appConfig.liveTranslate);
    const text = String(req.body?.text || LIVE_TRANSLATE_TEST_PHRASE).trim().slice(0, 220);
    io.emit('translate:testSpeak', {
        translatedText: text,
        normalizedText: text,
        nickname: 'HP Action LIVE',
        uniqueId: 'hpmedia',
        targetLang: cfg.targetLang,
        targetLangLabel: liveTranslateLangLabel(cfg.targetLang),
        readUsername: cfg.readUsername,
        ttsReadMode: cfg.ttsReadMode,
        ttsPreset: cfg.ttsPreset,
        ttsRate: cfg.ttsRate,
        canSpeak: true,
        createTime: Date.now()
    });
    res.json({ ok: true });
});

app.post('/api/live-translate/test-comment', (req, res) => {
    processLiveTranslateChat({
        uniqueId: 'hpmedia',
        nickname: 'HP Action LIVE',
        userId: 'live-translate-test',
        profilePicture: '',
        comment: String(req.body?.text || 'Hello, this is a translated comment test.').trim().slice(0, 220),
        createTime: Date.now()
    });
    res.json({ ok: true });
});

app.get('/api/live-translate/debug', (req, res) => {
    res.json({
        connected: isTikTokLiveConnected(),
        username: currentUsername,
        roomId: currentRoomId,
        config: sanitizeLiveTranslateConfig(appConfig.liveTranslate),
        stats: liveTranslateStats,
        rules: getCommentRulesMeta()
    });
});

app.get('/api/dashboard/state', (req, res) => {
    res.json({ ...liveDashboardState, stats: { ...liveStats } });
});

app.get('/api/backup/export', (req, res) => {
    res.json({
        ok: true,
        exportedAt: new Date().toISOString(),
        app: 'HP Action LIVE',
        version: require('./package.json').version,
        config: appConfig
    });
});

app.post('/api/backup/import', (req, res) => {
    const incoming = req.body?.config || req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok: false, error: 'invalid_backup' });
    const nextGames = incoming.games && typeof incoming.games === 'object' ? incoming.games : {};
    appConfig.games = { ...(appConfig.games || {}), ...nextGames };
    for (const gId of Object.keys(GAMES)) {
        if (!appConfig.games[gId]) appConfig.games[gId] = { ...GAMES[gId].defaultConfig };
    }
    if (appConfig.games.vipwelcome) appConfig.games.vipwelcome = migrateVipWelcomeConfig(appConfig.games.vipwelcome);
    appConfig.liveTranslate = sanitizeLiveTranslateConfig(incoming.liveTranslate || appConfig.liveTranslate || {});
    appConfig.creatorCaption = sanitizeCreatorCaptionConfig(incoming.creatorCaption || appConfig.creatorCaption || {});
    if (incoming.license && typeof incoming.license === 'object') appConfig.license = { ...(appConfig.license || {}), ...incoming.license };
    saveAppConfig();
    io.emit('translate:config', appConfig.liveTranslate);
    io.emit('creatorCaption:config', appConfig.creatorCaption);
    res.json({ ok: true, config: appConfig });
});

app.get('/api/creator-caption/config', (req, res) => {
    appConfig.creatorCaption = sanitizeCreatorCaptionConfig(appConfig.creatorCaption);
    res.json(appConfig.creatorCaption);
});

app.post('/api/creator-caption/config', (req, res) => {
    appConfig.creatorCaption = sanitizeCreatorCaptionConfig(req.body || {});
    saveAppConfig();
    io.emit('creatorCaption:config', appConfig.creatorCaption);
    res.json({ ok: true, config: appConfig.creatorCaption });
});

app.post('/api/creator-caption/transcribe', async (req, res) => {
    try {
        const text = await transcribeCreatorCaptionAudio(req.body || {});
        if (text) {
            io.emit('creatorCaption:debug', { type: 'final', text, ts: Date.now() });
            await processCreatorCaptionSpeech({
                text,
                sourceLang: req.body?.sourceLang,
                targetLangs: req.body?.targetLangs
            });
        }
        res.json({ ok: true, text });
    } catch (e) {
        const error = e?.message || 'transcribe_failed';
        io.emit('creatorCaption:debug', { type: 'error', text: error, ts: Date.now() });
        res.status(502).json({ ok: false, error });
    }
});

app.post('/api/creator-caption/test', (req, res) => {
    processCreatorCaptionSpeech({ text: req.body?.text || 'Xin chào mọi người, hôm nay chúng ta bắt đầu live.' });
    res.json({ ok: true });
});

app.get('/api/live-translate/tts', async (req, res) => {
    const text = String(req.query.text || '').trim().slice(0, 220);
    const lang = String(req.query.lang || 'vi').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12) || 'vi';
    if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
    try {
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='
            + encodeURIComponent(lang)
            + '&q=' + encodeURIComponent(text);
        const r = await fetch(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 HP-Action-LIVE' } });
        if (!r.ok) throw new Error('tts_http_' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message || 'tts_failed' });
    }
});

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
    if (g.id === 'votecomment') {
        // Khi panel save config (title, rows, duration, display) → đồng bộ state.
        // Không reset counters đang chạy — counts giữ theo row.id.
        try { voteCommentApplyConfigToState(appConfig.games.votecomment); } catch (e) {}
        broadcastVoteCommentState({ immediate: true });
    }
    if (g.id === 'nhietdo') {
        // Sync tempMin/Max/active với state — KHÔNG reset nhiệt độ đang có.
        try { nhietDoApplyConfigToState(appConfig.games.nhietdo); } catch (e) {}
        broadcastNhietDoState({ immediate: true });
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
        } else if (g.id === 'votecomment') {
            voteCommentStop({ reason: 'gameDisabled' });
        } else if (g.id === 'nhietdo') {
            // Khi tắt game → giảm temp về min ngay để overlay clear hiệu ứng lửa
            nhietDoState.temp = nhietDoState.tempMin;
            broadcastNhietDoState({ immediate: true });
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
function saveGameStateNow() {
    try {
        fs.writeFileSync(GAME_STATE_FILE, JSON.stringify(gameStateCache), 'utf8');
        return true;
    } catch (e) {
        console.warn('[game-state] Save fail:', e.message);
        return false;
    }
}
function scheduleSaveGameState() {
    clearTimeout(_gameStateSaveTimer);
    _gameStateSaveTimer = setTimeout(() => {
        saveGameStateNow();
    }, 1500);
}
loadGameStateCache();

app.post('/api/games/:id/state', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    gameStateCache[g.id] = req.body || {};
    if (req.query.flush === '1' || req.body?._flush === true) saveGameStateNow();
    else scheduleSaveGameState();   // persist to disk debounced
    // Live broadcast tới room 'overlay' (KHÔNG echo về 'preview' để tránh ghi đè edits đang gõ)
    io.to('overlay').emit('gameStateSnapshot', { gameId: g.id, state: gameStateCache[g.id] });
    res.json({ ok: true });
});
app.get('/api/games/:id/state', (req, res) => {
    res.json(gameStateCache[req.params.id] || null);
});

// Trả về version app hiện tại (KHÔNG còn expose GitHub repo)
// ============================================================
// TikTok avatar fetcher — via tikwm.com public API (TikTok chính chủ block scrape)
// ============================================================
// Endpoint: GET /api/tiktok-user-avatar?username=xxx
// Cache 6 giờ trong RAM tránh hit rate limit của tikwm.
const _ttAvatarCache = new Map();   // username → { url, nickname, ts, error }
const TT_AVATAR_TTL = 6 * 60 * 60 * 1000;
async function fetchTikTokAvatar(username) {
    const uname = String(username || '').toLowerCase().replace(/^@+/, '').trim();
    if (!uname) return { ok: false, error: 'empty_username' };
    // Cache hit?
    const cached = _ttAvatarCache.get(uname);
    if (cached && (Date.now() - cached.ts) < TT_AVATAR_TTL) {
        if (cached.error) return { ok: false, error: cached.error, cached: true };
        return { ok: true, avatarUrl: cached.url, nickname: cached.nickname, cached: true };
    }
    try {
        // tikwm.com public API — scrape TikTok user info
        const res = await fetch(`https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(uname)}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.ok) {
            _ttAvatarCache.set(uname, { error: `HTTP ${res.status}`, ts: Date.now() });
            return { ok: false, error: `HTTP ${res.status}` };
        }
        const body = await res.json();
        if (body?.code !== 0 || !body?.data?.user) {
            _ttAvatarCache.set(uname, { error: body?.msg || 'no_user', ts: Date.now() });
            return { ok: false, error: body?.msg || 'no_user' };
        }
        const u = body.data.user;
        // Prefer avatarLarger > avatarMedium > avatarThumb
        const avatarUrl = u.avatarLarger || u.avatarMedium || u.avatarThumb || '';
        const nickname = u.nickname || u.uniqueId || uname;
        if (!avatarUrl) {
            _ttAvatarCache.set(uname, { error: 'no_avatar', ts: Date.now() });
            return { ok: false, error: 'no_avatar' };
        }
        _ttAvatarCache.set(uname, { url: avatarUrl, nickname, ts: Date.now() });
        return { ok: true, avatarUrl, nickname };
    } catch (e) {
        _ttAvatarCache.set(uname, { error: e.message, ts: Date.now() });
        return { ok: false, error: e.message };
    }
}
app.get('/api/tiktok-user-avatar', async (req, res) => {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });
    const r = await fetchTikTokAvatar(username);
    res.json(r);
});

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
    // Chỉ cần TỪNG có key đã lưu (kể cả khi bị revoke trước đó, activated=false)
    // -> vẫn re-validate để TỰ kích hoạt lại khi admin mở khoá, KHỎI nhập key lại.
    if (!stored.key) {
        return res.json({ activated: false });
    }
    try {
        const result = await validateLicenseKey(stored.key);
        if (result.ok) {
            appConfig.license = {
                ...stored,
                activated: true,
                key: result.key,
                role: result.role || 'ADMIN',
                allowedIds: result.allowedIds || [],
                vip: result.vip,
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
        // Mất mạng + trước đó đã kích hoạt -> cho offline tối đa 24h
        if (result._offline && stored.activated) {
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
        // Đang bị khoá/hết hạn -> KHÔNG xoá key (giữ để lần sau tự vào),
        // trả savedKey để gate điền sẵn (user khỏi gõ lại).
        appConfig.license = { ...stored, activated: false, lastError: result.error };
        saveAppConfig();
        return res.json({ activated: false, error: result.error, savedKey: stored.key });
    } catch (e) {
        return res.json({ activated: false, error: e.message, savedKey: stored.key });
    }
});

app.post('/api/license/activate', async (req, res) => {
    const key = (req.body && req.body.key) || '';
    const result = await validateLicenseKey(key);
    if (!result.ok) return res.json(result);
    appConfig.license = {
        activated: true,
        key: result.key,
        role: result.role || 'ADMIN',          // ADMIN | CREATOR | VIP
        allowedIds: result.allowedIds || [],
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
        // Đồng bộ icon từ TikTok availableGifts cho các quà còn thiếu image
        // (Google Sheet có thể thiếu ảnh; availableGifts là nguồn chính xác hơn từ phòng LIVE đang connect)
        let iconsRefreshed = 0;
        if (connection && connection.availableGifts) {
            const refreshResult = refreshUnknownGiftsFromTikTok();
            if (refreshResult?.ok) iconsRefreshed = refreshResult.updated || 0;
            // Đồng thời update image cho giftList chính nếu sheet entry thiếu image
            for (const g of giftList) {
                if (g.image) continue;
                const tt = lookupGiftFromTikTok(String(g.id));
                if (tt?.image) {
                    g.image = tt.image;
                    iconsRefreshed++;
                }
            }
            if (iconsRefreshed > 0) {
                saveGiftCacheToDisk(giftList);
                io.emit('giftSheet', giftList);
            }
        }
        res.json({ ok: true, count: giftList.length, cleanedUnknown: cleaned, iconsRefreshed });
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

    // === VIP allow-list enforcement ===
    // role=VIP có danh sách ID: chỉ cho kết nối các TikTok ID trong danh sách.
    // Danh sách rỗng → không giới hạn (như trước).
    if (lic.activated && lic.role === 'VIP' && Array.isArray(lic.allowedIds) && lic.allowedIds.length) {
        if (lic.allowedIds.indexOf(cleanName.toLowerCase()) < 0) {
            return res.status(403).json({
                ok: false,
                error: 'TikTok ID này không nằm trong danh sách được phép của key VIP\nLIÊN HỆ HP MEDIA ĐỂ ĐƯỢC HỖ TRỢ',
                _vipNotAllowed: true,
                allowedIds: lic.allowedIds
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
        connection = null; liveConnected = false; currentUsername = null; currentRoomId = null;
        broadcast('status', { connected: false });
        setLiveDashboardStatus(false, { username: '', roomId: '' });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Gửi lệnh điều khiển game (thief, fireworks, tornado...) tới mọi overlay
// Monotonic sequence ID cho gameCmd — overlay dedup theo seq để tránh
// duplicate spawn khi OBS cache stale code / reconnect re-attach listener.
let _cmdSeq = 0;
function applyAuthoritativeGameCmdState(gameId, cmd, payload) {
    if (gameId !== 'thuytinh') return null;
    const incomingState = payload && typeof payload === 'object' && payload._state && typeof payload._state === 'object'
        ? payload._state
        : null;
    if (incomingState) {
        gameStateCache[gameId] = incomingState;
        saveGameStateNow();
        return gameStateCache[gameId];
    }
    if (cmd !== 'clear' && cmd !== 'resetSession') return null;
    const prev = gameStateCache[gameId] && typeof gameStateCache[gameId] === 'object' ? gameStateCache[gameId] : {};
    const next = { ...prev, bodies: [], giftHistory: Array.isArray(prev.giftHistory) ? prev.giftHistory : [] };
    if (cmd === 'resetSession') {
        next.totalDiamonds = 0;
        next.totalGifts = 0;
        next.tippers = [];
        next.seenGiftTypes = [];
        next.caughtList = [];
        next.bannedUntilByUid = [];
        next.policeForce = [];
        next.goalReached = false;
    }
    gameStateCache[gameId] = next;
    saveGameStateNow();
    return next;
}
app.post('/api/games/:id/cmd', (req, res) => {
    const g = GAMES[req.params.id];
    if (!g) return res.status(404).json({ ok: false, error: 'Không tìm thấy game' });
    const { cmd, payload } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false, error: 'Thiếu cmd' });
    const authoritativeState = applyAuthoritativeGameCmdState(g.id, cmd, payload);
    const seq = ++_cmdSeq;
    io.emit('gameCmd', { gameId: g.id, cmd, payload: payload || null, seq });
    if (authoritativeState) io.to('overlay').emit('gameStateSnapshot', { gameId: g.id, state: authoritativeState });
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
        nickname: body.nickname || 'HP Media',
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
app.get('/overlay/votecomment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'votecomment', 'overlay.html'));
});
app.get('/overlay/translate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overlay', 'translate.html'));
});
app.get('/overlay/creator-caption', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overlay', 'creator-caption.html'));
});
app.get('/overlay/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overlay', 'dashboard.html'));
});

// ============================================================
// VOTE BÌNH LUẬN — live state + control + chat/gift hooks
// ============================================================
// In-memory state (không persist) — mỗi lần app restart sẽ reset.
// Mỗi row tính 2 nguồn điểm: comments (số bình luận khớp keyword) + giftXu (XU quà
// của user đã vote dòng đó). Tổng điểm = comments + giftXu (hoặc 1 trong 2 tuỳ countingMode).
let voteCommentState = {
    active: false,
    startedAt: 0,
    endsAt: 0,                        // 0 = chưa start hoặc đã hết
    title: '',
    durationSec: 0,
    countingMode: 'both',
    pointsLabel: 'ĐIỂM',
    commentWeight: 1,
    giftWeight: 1,
    joinByGift: false,
    rows: [],                         // [{ id, keyword, label, color, comments, giftXu }]
    userLastRow: {}                   // { uniqueId(lower) → rowId }
};
let voteCommentAutoStopTimer = null;
let voteCommentLastBroadcast = 0;
let voteCommentPendingBroadcast = null;

function voteCommentSnapshot() {
    return {
        active: voteCommentState.active,
        startedAt: voteCommentState.startedAt,
        endsAt: voteCommentState.endsAt,
        title: voteCommentState.title,
        durationSec: voteCommentState.durationSec,
        countingMode: voteCommentState.countingMode,
        pointsLabel: voteCommentState.pointsLabel || 'ĐIỂM',
        commentWeight: Number(voteCommentState.commentWeight) || 1,
        giftWeight: Number(voteCommentState.giftWeight) || 1,
        joinByGift: !!voteCommentState.joinByGift,
        rows: voteCommentState.rows.map(r => ({
            id: r.id, keyword: r.keyword, label: r.label, color: r.color || '',
            giftId: r.giftId || '', giftName: r.giftName || '', giftImage: r.giftImage || '',
            comments: r.comments | 0, giftXu: r.giftXu | 0, bonus: r.bonus | 0
        }))
    };
}

function broadcastVoteCommentState({ immediate = false } = {}) {
    const send = () => {
        voteCommentLastBroadcast = Date.now();
        voteCommentPendingBroadcast = null;
        io.emit('votecomment:state', voteCommentSnapshot());
    };
    if (immediate) {
        if (voteCommentPendingBroadcast) { clearTimeout(voteCommentPendingBroadcast); voteCommentPendingBroadcast = null; }
        return send();
    }
    // Throttle: tối đa 4 lần/giây để tránh spam socket
    const now = Date.now();
    const wait = Math.max(0, 250 - (now - voteCommentLastBroadcast));
    if (voteCommentPendingBroadcast) return;
    voteCommentPendingBroadcast = setTimeout(send, wait);
}

function clearVoteCommentAutoStop() {
    if (voteCommentAutoStopTimer) { clearTimeout(voteCommentAutoStopTimer); voteCommentAutoStopTimer = null; }
}

function scheduleVoteCommentAutoStop() {
    clearVoteCommentAutoStop();
    if (!voteCommentState.active || !voteCommentState.endsAt) return;
    const ms = voteCommentState.endsAt - Date.now();
    if (ms <= 0) { voteCommentStop({ reason: 'timeout' }); return; }
    voteCommentAutoStopTimer = setTimeout(() => {
        voteCommentStop({ reason: 'timeout' });
    }, ms + 30);
}

function voteCommentResetCounts() {
    for (const r of voteCommentState.rows) { r.comments = 0; r.giftXu = 0; r.bonus = 0; }
    voteCommentState.userLastRow = {};
}

function voteCommentAdjustBonus(rowId, delta) {
    const row = voteCommentState.rows.find(r => r.id === rowId);
    if (!row) return false;
    const d = parseInt(delta, 10) || 0;
    if (d === 0) return false;
    row.bonus = (row.bonus | 0) + d;
    broadcastVoteCommentState({ immediate: true });
    console.log(`[votecomment] ADJUST row=${rowId} delta=${d > 0 ? '+' : ''}${d} → bonus=${row.bonus}`);
    return true;
}

function voteCommentApplyConfigToState(cfg) {
    // Tái sử dụng counts theo row.id nếu chưa start; nếu đang chạy thì giữ counters
    const prev = new Map(voteCommentState.rows.map(r => [r.id, r]));
    voteCommentState.title = String(cfg.title || '').slice(0, 120);
    voteCommentState.durationSec = Math.max(10, Math.min(7200, parseInt(cfg.durationSec, 10) || 300));
    voteCommentState.countingMode = ['comments', 'gifts', 'both'].includes(cfg.countingMode) ? cfg.countingMode : 'both';
    voteCommentState.pointsLabel = String(cfg.pointsLabel || 'ĐIỂM').trim().slice(0, 20) || 'ĐIỂM';
    const cw = parseFloat(cfg.commentWeight); voteCommentState.commentWeight = isFinite(cw) && cw >= 0 ? Math.min(100, cw) : 1;
    const gw = parseFloat(cfg.giftWeight); voteCommentState.giftWeight = isFinite(gw) && gw >= 0 ? Math.min(100, gw) : 1;
    voteCommentState.joinByGift = cfg.joinByGift === true;
    const rows = Array.isArray(cfg.rows) ? cfg.rows : [];
    voteCommentState.rows = rows.slice(0, 24).map(r => {
        const id = String(r?.id || ('r' + Math.random().toString(36).slice(2, 8)));
        const existing = prev.get(id);
        return {
            id,
            keyword: String(r?.keyword || '').trim().slice(0, 40),
            label: String(r?.label || '').slice(0, 120),
            color: String(r?.color || '').slice(0, 32),
            giftId: String(r?.giftId || '').slice(0, 40),
            giftName: String(r?.giftName || '').slice(0, 80),
            giftImage: String(r?.giftImage || '').slice(0, 500),
            comments: existing ? (existing.comments | 0) : 0,
            giftXu: existing ? (existing.giftXu | 0) : 0,
            bonus: existing ? (existing.bonus | 0) : 0
        };
    });
}

function voteCommentStart() {
    const cfg = appConfig.games.votecomment || makeDefaultVoteCommentConfig();
    voteCommentApplyConfigToState(cfg);
    voteCommentResetCounts();
    voteCommentState.active = true;
    voteCommentState.startedAt = Date.now();
    voteCommentState.endsAt = Date.now() + voteCommentState.durationSec * 1000;
    scheduleVoteCommentAutoStop();
    broadcastVoteCommentState({ immediate: true });
    console.log(`[votecomment] START — title="${voteCommentState.title}" rows=${voteCommentState.rows.length} duration=${voteCommentState.durationSec}s mode=${voteCommentState.countingMode}`);
}

function voteCommentStop({ reason } = {}) {
    if (!voteCommentState.active && !voteCommentState.endsAt) return;
    voteCommentState.active = false;
    clearVoteCommentAutoStop();
    broadcastVoteCommentState({ immediate: true });
    console.log(`[votecomment] STOP (${reason || 'manual'})`);
}

function voteCommentReset() {
    clearVoteCommentAutoStop();
    voteCommentState.active = false;
    voteCommentState.startedAt = 0;
    voteCommentState.endsAt = 0;
    const cfg = appConfig.games.votecomment || makeDefaultVoteCommentConfig();
    voteCommentApplyConfigToState(cfg);
    voteCommentResetCounts();
    broadcastVoteCommentState({ immediate: true });
    console.log(`[votecomment] RESET`);
}

function normalizeVoteText(s) {
    return String(s || '').trim().toLowerCase();
}

function handleVoteCommentChat({ uniqueId, comment }) {
    // Game bị TẮT trong Thư viện → bỏ qua mọi comment + gift
    if (appConfig.games?.votecomment?.enabled === false) return;
    if (!voteCommentState.active) return;
    if (!uniqueId || !comment) return;
    const norm = normalizeVoteText(comment);
    if (!norm) return;
    // Match: comment chuẩn hoá EQUAL với keyword chuẩn hoá (case-insensitive, trim)
    const hit = voteCommentState.rows.find(r => r.keyword && normalizeVoteText(r.keyword) === norm);
    if (!hit) return;
    hit.comments = (hit.comments | 0) + 1;
    voteCommentState.userLastRow[String(uniqueId).toLowerCase()] = hit.id;
    broadcastVoteCommentState();
}

function handleVoteCommentGift({ uniqueId, giftId, coinValue, repeatCount }) {
    // Game bị TẮT trong Thư viện → bỏ qua quà cộng vào vote
    if (appConfig.games?.votecomment?.enabled === false) return;
    if (!voteCommentState.active) return;
    const xu = (Number(coinValue) || 0) * (Number(repeatCount) || 1);
    if (xu <= 0) return;
    const uidLower = uniqueId ? String(uniqueId).toLowerCase() : '';
    let row = null;
    // (A) Quà chỉ định khớp giftId → cộng trực tiếp + nếu joinByGift thì GHI NHẬN user vào phe đó
    if (giftId) {
        row = voteCommentState.rows.find(r => r.giftId && String(r.giftId) === String(giftId));
        if (row && voteCommentState.joinByGift && uidLower) {
            voteCommentState.userLastRow[uidLower] = row.id;   // gia nhập phe
        }
    }
    // (B) Không khớp → dùng fallback theo userLastRow (gia nhập trước đó qua comment hoặc qualifying-gift)
    if (!row && uidLower) {
        const rowId = voteCommentState.userLastRow[uidLower];
        if (rowId) {
            const cand = voteCommentState.rows.find(r => r.id === rowId);
            // Mode joinByGift: cho phép dồn vào phe đã gia nhập kể cả row có giftId riêng (đó là "phe" của họ)
            // Mode mặc định: chỉ fallback nếu row đó KHÔNG gán quà riêng (tránh "cướp" XU của row khác)
            if (cand && (voteCommentState.joinByGift || !cand.giftId)) row = cand;
        }
    }
    if (!row) return;
    row.giftXu = (row.giftXu | 0) + xu;
    broadcastVoteCommentState();
}

// Khởi tạo state ban đầu từ config (rows + title) để overlay đầu tiên không trống
try { voteCommentApplyConfigToState(appConfig.games.votecomment || makeDefaultVoteCommentConfig()); } catch (e) {}

// Control endpoint — start/stop/reset/adjustBonus
app.post('/api/games/votecomment/control', (req, res) => {
    const cmd = String(req.body?.cmd || '');
    const c = cmd.toLowerCase();
    if (c === 'start') voteCommentStart();
    else if (c === 'stop') voteCommentStop({ reason: 'manual' });
    else if (c === 'reset') voteCommentReset();
    else if (c === 'adjustbonus') {
        const ok = voteCommentAdjustBonus(req.body?.rowId, req.body?.delta);
        if (!ok) return res.status(400).json({ ok: false, error: 'rowId không tồn tại hoặc delta=0' });
    }
    else return res.status(400).json({ ok: false, error: 'cmd phải là start|stop|reset|adjustBonus' });
    res.json({ ok: true, state: voteCommentSnapshot() });
});

// "livestate" để tránh va với generic /api/games/:id/state — generic ưu tiên match trước
// (server.js convention, xem CLAUDE.md).
app.get('/api/games/votecomment/livestate', (req, res) => {
    res.json(voteCommentSnapshot());
});

// ============================================================
// BIỂU CẢM NHIỆT ĐỘ — live state + gift hook + decay tick + milestones + top contrib
// ============================================================
// In-memory state (không persist) — restart app sẽ reset về initialTemp.
// Temperature 0..tempMax. Gift bumps/cools temp, idle decays temp.
// userContrib tracks tổng °C đẩy lên cho mỗi user trong phiên — reset() xoá hết.
let nhietDoState = {
    temp: 0,
    tempMax: 100,
    tempMin: 0,
    lastGiftAt: 0,
    updatedAt: 0,
    active: true,
    userContrib: {},      // uniqueId(lower) → { totalDegrees, nickname, avatar, lastAt }
    crossedMilestones: {} // temp(int) → ts crossed; reset on reset()
};
let nhietDoLastBroadcast = 0;
let nhietDoPendingBroadcast = null;
let nhietDoLastDecayAt = Date.now();

function nhietDoTopList(limit = 5) {
    const arr = Object.values(nhietDoState.userContrib || {})
        .filter(u => u && u.totalDegrees > 0)
        .sort((a, b) => b.totalDegrees - a.totalDegrees)
        .slice(0, limit)
        .map(u => ({
            uniqueId: u.uniqueId,
            nickname: u.nickname || u.uniqueId,
            avatar: u.avatar || '',
            totalDegrees: Math.round(u.totalDegrees * 10) / 10
        }));
    return arr;
}

function nhietDoSnapshot() {
    const cfg = appConfig.games?.nhietdo;
    return {
        temp: Math.round(nhietDoState.temp * 10) / 10,
        tempMax: nhietDoState.tempMax,
        tempMin: nhietDoState.tempMin,
        lastGiftAt: nhietDoState.lastGiftAt,
        updatedAt: nhietDoState.updatedAt,
        active: nhietDoState.active !== false,
        sessionActive: cfg ? (cfg.sessionActive !== false) : true,
        top: nhietDoTopList(5)
    };
}

function broadcastNhietDoState({ immediate = false } = {}) {
    const send = () => {
        nhietDoLastBroadcast = Date.now();
        nhietDoPendingBroadcast = null;
        io.emit('nhietdo:state', nhietDoSnapshot());
    };
    if (immediate) {
        if (nhietDoPendingBroadcast) { clearTimeout(nhietDoPendingBroadcast); nhietDoPendingBroadcast = null; }
        return send();
    }
    const now = Date.now();
    const wait = Math.max(0, 200 - (now - nhietDoLastBroadcast));
    if (nhietDoPendingBroadcast) return;
    nhietDoPendingBroadcast = setTimeout(send, wait);
}

function nhietDoClamp(v) {
    if (!isFinite(v)) v = 0;
    return Math.max(nhietDoState.tempMin, Math.min(nhietDoState.tempMax, v));
}

function nhietDoApplyConfigToState(cfg) {
    if (!cfg) cfg = makeDefaultNhietDoConfig();
    const prevMax = nhietDoState.tempMax;
    nhietDoState.tempMin = Number(cfg.tempMin) || 0;
    nhietDoState.tempMax = Math.max(10, Number(cfg.tempMax) || 100);
    // Nếu max đổi, scale temp hiện tại để không vượt
    if (prevMax > 0 && prevMax !== nhietDoState.tempMax) {
        nhietDoState.temp = nhietDoClamp(nhietDoState.temp);
    }
    nhietDoState.active = cfg.enabled !== false;
}

function nhietDoReset() {
    const cfg = appConfig.games.nhietdo || makeDefaultNhietDoConfig();
    nhietDoApplyConfigToState(cfg);
    nhietDoState.temp = nhietDoClamp(Number(cfg.initialTemp) || 0);
    nhietDoState.lastGiftAt = 0;
    nhietDoState.updatedAt = Date.now();
    nhietDoState.userContrib = {};
    nhietDoState.crossedMilestones = {};
    broadcastNhietDoState({ immediate: true });
}

function nhietDoSetTemp(temp) {
    const before = nhietDoState.temp;
    nhietDoState.temp = nhietDoClamp(Number(temp) || 0);
    nhietDoState.updatedAt = Date.now();
    checkNhietDoMilestones(before, nhietDoState.temp);
    broadcastNhietDoState({ immediate: true });
}

function nhietDoAddTemp(delta, { fromGift = false, contribUser = null } = {}) {
    const d = Number(delta) || 0;
    if (!d) return 0;
    const before = nhietDoState.temp;
    nhietDoState.temp = nhietDoClamp(before + d);
    const actual = nhietDoState.temp - before;
    if (fromGift) nhietDoState.lastGiftAt = Date.now();
    nhietDoState.updatedAt = Date.now();
    // Top contributor tracking — ONLY positive (heating) gifts count toward leaderboard
    if (fromGift && contribUser && contribUser.uniqueId && actual > 0) {
        const uid = String(contribUser.uniqueId).toLowerCase();
        const u = nhietDoState.userContrib[uid] || { uniqueId: contribUser.uniqueId, totalDegrees: 0, nickname: '', avatar: '', lastAt: 0 };
        u.totalDegrees += actual;
        u.nickname = contribUser.nickname || u.nickname || contribUser.uniqueId;
        u.avatar = contribUser.avatar || u.avatar || '';
        u.lastAt = Date.now();
        nhietDoState.userContrib[uid] = u;
    }
    // Gain popup
    if (Math.abs(actual) >= 0.1) {
        io.emit('nhietdo:gain', { delta: actual, fromGift: !!fromGift, ts: Date.now() });
    }
    // Milestone crossing detection — only on UPWARD crossing
    checkNhietDoMilestones(before, nhietDoState.temp);
    broadcastNhietDoState({ immediate: true });
    return actual;
}

// Check if we crossed any milestone going UP
function checkNhietDoMilestones(before, after) {
    if (after <= before) return;
    const cfg = appConfig.games?.nhietdo;
    if (!cfg || !Array.isArray(cfg.milestones)) return;
    for (const m of cfg.milestones) {
        if (m.enabled === false) continue;
        const t = Number(m.temp);
        if (!isFinite(t)) continue;
        if (before < t && after >= t) {
            // Throttle: same milestone không fire lại trong vòng 5s
            const last = nhietDoState.crossedMilestones[t] || 0;
            if (Date.now() - last < 5000) continue;
            nhietDoState.crossedMilestones[t] = Date.now();
            io.emit('nhietdo:milestone', {
                temp: t,
                label: m.label || `${t}°C`,
                tickerText: m.tickerText || '',
                mediaUrl: m.mediaUrl || '',
                mediaType: m.mediaType || '',
                volume: Number(m.volume) || 80,
                ts: Date.now()
            });
            console.log(`[nhietdo] milestone crossed: ${t}°C — "${m.label}"`);
        }
    }
}

// Compute degrees from heating gift (positive). Returns 0 if no match.
function nhietDoComputeGiftHeat(cfg, { giftId, coinValue, repeatCount }) {
    const repeat = Math.max(1, Number(repeatCount) || 1);
    const coins = Math.max(0, Number(coinValue) || 0);
    const mode = cfg.heatMode || 'perCoin';
    if (mode === 'perCoin') {
        return coins * repeat * (Number(cfg.perCoinDegrees) || 0);
    }
    if (mode === 'perGift') {
        return repeat * (Number(cfg.perGiftDegrees) || 0);
    }
    if (mode === 'specificGifts') {
        const list = Array.isArray(cfg.specificGifts) ? cfg.specificGifts : [];
        const hit = list.find(g => String(g.giftId) === String(giftId));
        if (!hit) return 0;
        return repeat * (Number(hit.degrees) || 0);
    }
    return 0;
}

// Compute negative delta from cooling gift. Returns 0 if not in cooling list.
// Cooling gifts hoạt động ở MỌI heatMode (luôn priority hơn heating).
function nhietDoComputeGiftCool(cfg, { giftId, repeatCount }) {
    const list = Array.isArray(cfg.coolingGifts) ? cfg.coolingGifts : [];
    const hit = list.find(g => String(g.giftId) === String(giftId));
    if (!hit) return 0;
    const repeat = Math.max(1, Number(repeatCount) || 1);
    const deg = Math.abs(Number(hit.degrees) || 0);
    return -1 * deg * repeat;
}

function handleNhietDoGift({ uniqueId, nickname, profilePicture, giftId, coinValue, repeatCount }) {
    if (appConfig.games?.nhietdo?.enabled === false) return;
    if (appConfig.games?.nhietdo?.sessionActive === false) return;   // phiên đã KẾT THÚC
    const cfg = appConfig.games.nhietdo || makeDefaultNhietDoConfig();
    // Check cooling first — cooling gifts override heating ở mọi mode
    const coolDelta = nhietDoComputeGiftCool(cfg, { giftId, repeatCount });
    if (coolDelta < 0) {
        nhietDoAddTemp(coolDelta, { fromGift: true });
        return;
    }
    const heatDelta = nhietDoComputeGiftHeat(cfg, { giftId, coinValue, repeatCount });
    if (heatDelta > 0) {
        nhietDoAddTemp(heatDelta, {
            fromGift: true,
            contribUser: uniqueId ? { uniqueId, nickname, avatar: profilePicture } : null
        });
    }
}

// Decay tick — chạy mỗi 500ms, giảm nhiệt khi idle
function nhietDoDecayTick() {
    const now = Date.now();
    const dt = (now - nhietDoLastDecayAt) / 1000;
    nhietDoLastDecayAt = now;
    if (nhietDoState.active === false) return;
    const cfg = appConfig.games?.nhietdo;
    if (!cfg || cfg.enabled === false) return;
    const idleSec = nhietDoState.lastGiftAt ? (now - nhietDoState.lastGiftAt) / 1000 : Infinity;
    if (idleSec < (Number(cfg.idleSeconds) || 0)) return;
    if (nhietDoState.temp <= nhietDoState.tempMin) return;
    const ratePerSec = Number(cfg.decayPerSecond) || 0;
    if (ratePerSec <= 0) return;
    let dropPerSec = ratePerSec;
    if (cfg.decayShape === 'easeOut') {
        // Càng gần min thì giảm càng chậm: scale theo (temp - min) / (max - min)
        const span = Math.max(1, nhietDoState.tempMax - nhietDoState.tempMin);
        const norm = (nhietDoState.temp - nhietDoState.tempMin) / span;
        dropPerSec = ratePerSec * (0.2 + 0.8 * norm);
    }
    const drop = dropPerSec * dt;
    if (drop <= 0) return;
    const before = nhietDoState.temp;
    nhietDoState.temp = nhietDoClamp(before - drop);
    nhietDoState.updatedAt = now;
    if (Math.abs(before - nhietDoState.temp) > 0.01) {
        broadcastNhietDoState();
    }
}
setInterval(nhietDoDecayTick, 500);

// Initialize state from config on startup
try { nhietDoApplyConfigToState(appConfig.games.nhietdo || makeDefaultNhietDoConfig()); } catch (e) {}
try {
    const cfg0 = appConfig.games.nhietdo || makeDefaultNhietDoConfig();
    nhietDoState.temp = nhietDoClamp(Number(cfg0.initialTemp) || 0);
} catch (e) {}

// Overlay route
app.get('/overlay/nhietdo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'games', 'nhietdo', 'overlay.html'));
});

// Live state (custom path to avoid generic /api/games/:id/state route)
app.get('/api/games/nhietdo/livestate', (req, res) => {
    res.json(nhietDoSnapshot());
});

// Control endpoint — reset / setTemp / addTemp / testGift / testMilestone / start / stop
app.post('/api/games/nhietdo/control', (req, res) => {
    const cmd = String(req.body?.cmd || '').toLowerCase();
    if (cmd === 'start') {
        if (!appConfig.games.nhietdo) appConfig.games.nhietdo = makeDefaultNhietDoConfig();
        appConfig.games.nhietdo.sessionActive = true;
        saveAppConfig();
        io.emit('gameConfig', { gameId: 'nhietdo', config: appConfig.games.nhietdo });
        broadcastNhietDoState({ immediate: true });
        console.log('[nhietdo] SESSION START');
    } else if (cmd === 'stop') {
        if (!appConfig.games.nhietdo) appConfig.games.nhietdo = makeDefaultNhietDoConfig();
        appConfig.games.nhietdo.sessionActive = false;
        saveAppConfig();
        io.emit('gameConfig', { gameId: 'nhietdo', config: appConfig.games.nhietdo });
        broadcastNhietDoState({ immediate: true });
        console.log('[nhietdo] SESSION STOP — overlay ẩn');
    } else if (cmd === 'reset') {
        nhietDoReset();
    } else if (cmd === 'settemp') {
        nhietDoSetTemp(req.body?.temp);
    } else if (cmd === 'addtemp') {
        nhietDoAddTemp(req.body?.delta || 0, { fromGift: false });
    } else if (cmd === 'testgift') {
        handleNhietDoGift({
            uniqueId: req.body?.uniqueId || 'tester',
            nickname: req.body?.nickname || 'Người Thử',
            profilePicture: req.body?.profilePicture || '',
            giftId: req.body?.giftId || '',
            coinValue: req.body?.coinValue || 10,
            repeatCount: req.body?.repeatCount || 1
        });
    } else if (cmd === 'testmilestone') {
        // Fire 1 milestone bất kỳ ngay (test media + ticker)
        const cfg = appConfig.games.nhietdo || makeDefaultNhietDoConfig();
        const idx = parseInt(req.body?.index, 10);
        const m = (Array.isArray(cfg.milestones) && cfg.milestones[idx]) ? cfg.milestones[idx] : null;
        if (!m) return res.status(400).json({ ok: false, error: 'index không hợp lệ' });
        io.emit('nhietdo:milestone', {
            temp: m.temp, label: m.label || '', tickerText: m.tickerText || '',
            mediaUrl: m.mediaUrl || '', mediaType: m.mediaType || '',
            volume: Number(m.volume) || 80, ts: Date.now()
        });
    } else {
        return res.status(400).json({ ok: false, error: 'cmd phải là reset|setTemp|addTemp|testGift|testMilestone' });
    }
    res.json({ ok: true, state: nhietDoSnapshot() });
});

// Upload endpoint cho milestone media + ambient audio — raw bytes, pattern giống pktiktok
const NHIETDO_ASSETS_DIR = path.join(DATA_DIR, 'nhietdo-assets');
if (!fs.existsSync(NHIETDO_ASSETS_DIR)) fs.mkdirSync(NHIETDO_ASSETS_DIR, { recursive: true });
const NHIETDO_ALLOWED_EXTS = ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a', 'png', 'jpg', 'jpeg', 'gif'];
app.post('/api/games/nhietdo/upload',
    express.raw({ limit: '30mb', type: () => true }),
    (req, res) => {
        const ext = String(req.query.ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (!NHIETDO_ALLOWED_EXTS.includes(ext)) return res.status(400).json({ ok: false, error: 'invalid_ext' });
        if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'empty_body' });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const filename = `${id}.${ext}`;
        const filePath = path.join(NHIETDO_ASSETS_DIR, filename);
        try {
            fs.writeFileSync(filePath, req.body);
            res.json({ ok: true, url: `/api/games/nhietdo/asset/${filename}`, filename });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }
);
app.get('/api/games/nhietdo/asset/:fn', (req, res) => {
    const fn = String(req.params.fn || '').replace(/[^a-z0-9._-]/gi, '');
    const fp = path.join(NHIETDO_ASSETS_DIR, fn);
    if (!fs.existsSync(fp)) return res.status(404).end();
    res.sendFile(fp);
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

// ====== TIMER (THỜI GIAN) — media assets cho tính năng "Quà kích hoạt countdown" ======
const TIMER_ASSETS_DIR = path.join(DATA_DIR, 'timer-assets');
if (!fs.existsSync(TIMER_ASSETS_DIR)) fs.mkdirSync(TIMER_ASSETS_DIR, { recursive: true });
const TIMER_ALLOWED_EXTS = ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'];

app.post('/api/games/timer/upload',
    express.raw({ limit: '30mb', type: () => true }),
    (req, res) => {
        const ext = String(req.query.ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (!TIMER_ALLOWED_EXTS.includes(ext)) {
            return res.status(400).json({ ok: false, error: 'invalid_ext' });
        }
        if (!req.body || !req.body.length) {
            return res.status(400).json({ ok: false, error: 'empty_body' });
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const filename = `${id}.${ext}`;
        try {
            fs.writeFileSync(path.join(TIMER_ASSETS_DIR, filename), req.body);
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'write_failed: ' + e.message });
        }
        res.json({ ok: true, filename, url: `/api/games/timer/asset/${filename}` });
    }
);

app.get('/api/games/timer/asset/:fn', (req, res) => {
    const safe = String(req.params.fn).replace(/[^a-z0-9._-]/gi, '');
    if (!safe || safe.includes('..')) return res.sendStatus(400);
    const p = path.join(TIMER_ASSETS_DIR, safe);
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

// ====== 🔊 SoundFX module — soundboard streamer ======
try {
    const { createSoundfxModule } = require('./soundfx-server.js');
    const soundfx = createSoundfxModule(DATA_DIR);
    app.use('/api/soundfx', soundfx.router);
    app.get('/soundfx', (req, res) =>
        res.sendFile(path.join(__dirname, 'public', 'soundfx', 'soundfx.html')));
    console.log('[soundfx] module mounted at /soundfx');
} catch (e) {
    console.warn('[soundfx] không mount được:', e.message);
}

// ====== 🚀 Quick Launch — cửa sổ điều khiển nhanh tách rời, always-on-top ======
app.get('/quick-launch', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'quick-launch.html')));

// Default index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ====== Socket rooms ======
// Cache snapshot cho relay-only events (level-quest / timer) — server cũ chỉ relay
// lab→overlay không lưu lại, nên overlay mở SAU lab không có state, phải Reset OBS
// mới buộc lab broadcast lại. Cache giải quyết: mỗi lần lab broadcast cfg/state,
// server lưu vào RAM; socket mới connect → emit cache ngay.
const relayCache = {
    levelquest: { cfg: null, state: null },
    timer:      { cfg: null, state: null }
};

io.on('connection', (socket) => {
    // Default emits
    socket.emit('giftSheet', giftList);
    socket.emit('status', { connected: isTikTokLiveConnected(), username: currentUsername, roomId: currentRoomId });
    socket.emit('liveStats', liveStats);
    if (currentHostProfile) socket.emit('hostInfo', currentHostProfile);
    socket.emit('translate:config', sanitizeLiveTranslateConfig(appConfig.liveTranslate));
    socket.emit('translate:rules', getCommentRulesMeta());
    socket.emit('creatorCaption:config', sanitizeCreatorCaptionConfig(appConfig.creatorCaption));
    // Quick Launch cần biết Vote Bình Luận đang chạy phiên không — gửi snapshot ngay
    // khi connect (kể cả cửa sổ Khởi động nhanh mở giữa chừng) thay vì chờ broadcast tiếp.
    socket.emit('votecomment:state', voteCommentSnapshot());
    socket.emit('nhietdo:state', nhietDoSnapshot());
    // LEVEL QUEST + TIMER snapshot — overlay mở SAU lab nhận state ngay, không phải
    // Reset OBS mới buộc lab broadcast lại
    if (relayCache.levelquest.cfg)   socket.emit('levelquest:cfg',   relayCache.levelquest.cfg);
    if (relayCache.levelquest.state) socket.emit('levelquest:state', relayCache.levelquest.state);
    if (relayCache.timer.cfg)        socket.emit('timer:cfg',        relayCache.timer.cfg);
    if (relayCache.timer.state)      socket.emit('timer:state',      relayCache.timer.state);

    socket.on('creatorCaption:speech', (payload) => {
        processCreatorCaptionSpeech(payload).catch(e => console.warn('[creator-caption] translate failed:', e.message));
    });
    socket.on('creatorCaption:debug', (payload) => {
        io.emit('creatorCaption:debug', { ...(payload || {}), ts: Date.now() });
    });

    // LEVEL QUEST sync — lab broadcasts cfg/state; cache + relay tới mọi overlay
    socket.on('levelquest:cfg',   (data) => { relayCache.levelquest.cfg   = data; socket.broadcast.emit('levelquest:cfg',   data); });
    socket.on('levelquest:state', (data) => { relayCache.levelquest.state = data; socket.broadcast.emit('levelquest:state', data); });

    // TIMER (THỜI GIAN) sync — lab broadcasts cfg/state; cache + relay tới overlay/preview
    socket.on('timer:cfg',     (data) => { relayCache.timer.cfg   = data; socket.broadcast.emit('timer:cfg',   data); });
    socket.on('timer:state',   (data) => { relayCache.timer.state = data; socket.broadcast.emit('timer:state', data); });
    socket.on('timer:trigger', (data) => { socket.broadcast.emit('timer:trigger', data); });

    // 🚀 Quick Launch — cửa sổ rời emit lệnh start/stop → server forward tới app chính để
    // chạy logic thật của từng game (openRegistration cho caro, postMessage iframe cho
    // level-quest/timer, click translate-toggle cho liveTranslate, control endpoint cho
    // votecomment). Broadcast tới MỌI client (kể cả sender) để app chính phản hồi nếu nó
    // chính là nguồn phát; cửa sổ rời tự ignore (kiểm tra trong handler client).
    socket.on('quickLaunch:cmd', (data) => { io.emit('quickLaunch:cmd', data); });
    // App chính broadcast trạng thái Đang chạy của caro + liveTranslate (heartbeat 2s + on-change).
    // Cửa sổ Khởi động nhanh listen để cập nhật chip "Đang chạy" / "Sẵn sàng".
    socket.on('quickLaunch:status', (data) => { socket.broadcast.emit('quickLaunch:status', data); });

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
                // Vote Bình Luận: state riêng (in-memory) — đẩy snapshot ngay
                socket.emit('votecomment:state', voteCommentSnapshot());
                // Biểu Cảm Nhiệt Độ: state riêng (in-memory)
                socket.emit('nhietdo:state', nhietDoSnapshot());
            }
        }
    });
});

httpServer.listen(PORT, async () => {
    console.log(`[server] HP Action LIVE chạy tại http://localhost:${PORT}`);
    try { await loadGiftSheet(); }
    catch (e) { console.warn('[server] Không tải được Google Sheet:', e.message); }
    await refreshCommentRulesSheet();
    setInterval(refreshCommentRulesSheet, COMMENT_RULES_REFRESH_MS).unref?.();

    // HP KEY - check key real-time: cấm key trên admin -> đóng app trong <= RECHECK_SECONDS
    try {
        require('./hpkey/validate').startWatch({
            getKey: () => (appConfig.license && appConfig.license.key) || '',
            onRevoked: (reason) => {
                console.warn('[hpkey] Key bị thu hồi:', reason, '-> đóng app');
                try {
                    // Giữ key đã lưu (chỉ đánh dấu chưa kích hoạt) -> mở khoá là tự vào lại
                    appConfig.license = { ...(appConfig.license || {}), activated: false, lastError: 'revoked:' + reason };
                    saveAppConfig();
                } catch (_) {}
                try {
                    const { dialog } = require('electron');
                    dialog.showErrorBox('Bản quyền bị thu hồi',
                        'KEY của bạn đã bị khóa/thu hồi hoặc hết hạn (' + reason + ').\n' +
                        'Ứng dụng sẽ đóng. Liên hệ HP Media để được hỗ trợ.');
                } catch (_) {}
                if (_electronApp) { _electronApp.quit(); setTimeout(() => { try { _electronApp.exit(0); } catch (_) {} }, 1500); }
                else process.exit(0);
            },
        });
    } catch (e) { console.warn('[hpkey] watch init failed:', e && e.message); }
});

// Export cho electron-main.js gọi httpServer.close() khi quit
module.exports = { httpServer, app, io };

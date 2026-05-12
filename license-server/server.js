/**
 * HP Action LIVE — Standalone License Validation Server
 * =====================================================
 * Server Node.js độc lập xác thực key bản quyền.
 *
 * App → POST /activate {key, deviceId?} → Server → đọc Google Sheet → validate
 *                                                        ↓
 *                                  ← {ok, key, vip, expiry, ...} ← App
 *
 * Bảo mật trên đường truyền: HTTPS (nginx + Let's Encrypt / Cloudflare proxy).
 * Bảo mật khỏi MITM: HTTPS đã đủ với server trust được (chứng chỉ hợp lệ).
 * Bảo mật khỏi patch app: KHÔNG fixable ở client side (Electron là JS interpret).
 *
 * Deploy: VPS / Render / Railway / Fly.io / Self-host. Xem README.md.
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');

// === Config từ env ===
const PORT = parseInt(process.env.PORT || '8787', 10);
const SHEET_ID = process.env.SHEET_ID || '';
const KEY_SHEET_NAME = process.env.KEY_SHEET_NAME || 'KEY_HP_GAME';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10);
const DEVICE_BIND_ENABLED = process.env.DEVICE_BIND_ENABLED === 'true';
const DEVICE_BIND_MAX = parseInt(process.env.DEVICE_BIND_MAX || '2', 10);
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'data', 'activations.log');
const ACTIVATIONS_FILE = path.join(__dirname, 'data', 'activations.json');

if (!SHEET_ID) {
    console.error('[fatal] SHEET_ID chưa được set trong .env');
    process.exit(1);
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
    console.warn('[warn] ADMIN_TOKEN ngắn hoặc trống — /admin endpoint sẽ KHÔNG hoạt động cho đến khi set token đủ mạnh (≥32 chars).');
}

// === Ensure data dir ===
const dataDir = path.dirname(ACTIVATIONS_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// === Activations store (file-based JSON) ===
let activations = {};
try {
    if (fs.existsSync(ACTIVATIONS_FILE)) {
        activations = JSON.parse(fs.readFileSync(ACTIVATIONS_FILE, 'utf8'));
    }
} catch (e) { console.warn('[warn] Đọc activations.json lỗi, khởi tạo trống:', e.message); }

let saveActivationsDebounce = null;
function saveActivations() {
    clearTimeout(saveActivationsDebounce);
    saveActivationsDebounce = setTimeout(() => {
        try {
            fs.writeFileSync(ACTIVATIONS_FILE, JSON.stringify(activations, null, 2));
        } catch (e) { console.error('[error] Lưu activations.json lỗi:', e.message); }
    }, 200);
}

// === Logging ===
function logLine(line) {
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${line}\n`;
    try { fs.appendFileSync(LOG_FILE, text); } catch {}
    if (process.env.NODE_ENV !== 'production') process.stdout.write(text);
}

// === Google Sheet cache (5 phút) ===
let sheetCache = null;
let sheetCachedAt = 0;
const SHEET_TTL_MS = 5 * 60 * 1000;

async function fetchSheet(force = false) {
    if (!force && sheetCache && (Date.now() - sheetCachedAt) < SHEET_TTL_MS) return sheetCache;
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(KEY_SHEET_NAME)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Sheet HTTP ' + res.status);
    const csv = await res.text();
    sheetCache = parseSheet(csv);
    sheetCachedAt = Date.now();
    return sheetCache;
}

// Sheet cột (chỉ 5 cột, không cần thêm gì):
//   A=Key | B=Expiry | C=Role | D=Status | E=Note
// Role values (cột C):
//   ADMIN     — toàn quyền, connect bất kỳ TikTok ID nào
//   CREATOR   — key CHÍNH LÀ TikTok ID. Connect TikTok phải = key. Khác → reject.
//   VIP       — backward compat, full access (= ADMIN)
//   Thường    — backward compat, full access (= ADMIN)
function parseSheet(csvText) {
    const rows = parseCsv(csvText);
    const list = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;
        const key = String(r[0]).trim();
        if (!key) continue;
        list.push({
            key,
            expiry: String(r[1] || '').trim(),
            role: normalizeRole(String(r[2] || '').trim()),
            roleRaw: String(r[2] || '').trim(),
            status: String(r[3] || '').trim(),
            note: String(r[4] || '').trim()
        });
    }
    return list;
}

function normalizeRole(raw) {
    const up = raw.toUpperCase();
    if (up === 'ADMIN' || up === 'CREATOR') return up;
    // VIP / Thường / blank → backward compat = full access (ADMIN)
    return 'ADMIN';
}

function parseCsv(text) {
    const rows = [];
    let cur = '', inQuote = false, row = [];
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
            else if (ch === '\r') {}
            else cur += ch;
        }
    }
    if (cur.length || row.length) flushRow();
    return rows;
}

function parseDmy(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
}

// === Express app ===
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Rate limit /activate riêng (chống brute force key)
const activateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Quá nhiều yêu cầu — vui lòng thử lại sau 1 phút' }
});

// === GET / — health check ===
app.get('/', (req, res) => {
    res.json({
        service: 'hp-license-server',
        status: 'ok',
        version: '1.0.0',
        activations_count: Object.keys(activations).length
    });
});

// ============================================================
// AUTO-UPDATE ENDPOINTS
// ============================================================
// HP Media upload .exe mới + version.json vào folder releases/
// App electron query /api/version → so version → tải /api/download/installer
// → cài silent → app tự reopen.
//
// KHÔNG expose GitHub URL — toàn bộ flow đi qua license-server (URL bạn kiểm
// soát). Attacker không thấy thông tin dev/repo qua app's network traffic.
// ============================================================

const RELEASES_DIR = process.env.RELEASES_DIR || path.join(__dirname, 'releases');
const VERSION_JSON = path.join(RELEASES_DIR, 'version.json');

function readVersionInfo() {
    try {
        if (fs.existsSync(VERSION_JSON)) {
            return JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
        }
    } catch (e) { console.warn('[update] Đọc version.json lỗi:', e.message); }
    return null;
}

// GET /api/version — trả về phiên bản mới nhất + release notes + checksum
// ============================================================
// GIFT SHEET PROXY — App KHÔNG biết SHEET_ID, chỉ gọi qua license-server.
// SHEET_ID giữ ở server-side env, không leak qua installer.
// Cache 5 phút để tránh hammer Google Sheet.
// Auth: ai gọi cũng được — dữ liệu gift list không nhạy cảm (TikTok public anyway).
//        License key sheet (KEY_HP_GAME) thì KHÔNG expose qua endpoint này.
// ============================================================
let giftSheetCache = null;
let giftSheetCachedAt = 0;
const GIFT_SHEET_TTL_MS = 5 * 60 * 1000;
const GIFT_SHEET_NAME = process.env.GIFT_SHEET_NAME || 'gifts';

async function fetchGiftSheet(force = false) {
    if (!force && giftSheetCache && (Date.now() - giftSheetCachedAt) < GIFT_SHEET_TTL_MS) return giftSheetCache;
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(GIFT_SHEET_NAME)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Gift sheet HTTP ' + res.status);
    const csv = await res.text();
    const rows = parseCsv(csv);
    const list = [];
    // Schema: A=id | B=name | C=image link | D=diamond (E+ = formulas, bỏ qua)
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 3) continue;
        const id = (r[0] || '').toString().trim();
        const name = (r[1] || '').toString().trim();
        const link = (r[2] || '').toString().trim();
        const dRaw = (r[3] || '').toString().replace(/[^\d]/g, '');
        let diamond = parseInt(dRaw, 10);
        if (!diamond || isNaN(diamond)) {
            diamond = parseInt((r[4] || '').toString().replace(/[^\d]/g, ''), 10) || 0;
        }
        if (!id) continue;
        list.push({ id, name, image: link, diamond });
    }
    giftSheetCache = list;
    giftSheetCachedAt = Date.now();
    return giftSheetCache;
}

app.get('/api/gift-sheet', async (req, res) => {
    try {
        const list = await fetchGiftSheet();
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ ok: true, gifts: list, total: list.length });
    } catch (e) {
        res.status(503).json({ ok: false, error: 'Không tải được danh sách quà — thử lại sau' });
    }
});
// Admin force-refresh gift sheet (bỏ qua cache)
app.post('/admin/api/refresh-gift-sheet', requireAdminAuth, async (req, res) => {
    try {
        const list = await fetchGiftSheet(true);
        res.json({ ok: true, total: list.length });
    } catch (e) {
        res.status(503).json({ ok: false, error: e.message });
    }
});

app.get('/api/version', (req, res) => {
    const v = readVersionInfo();
    if (!v) {
        return res.status(503).json({ ok: false, error: 'Chưa có phiên bản nào được publish' });
    }
    // Trả về metadata KHÔNG bao gồm absolute path file
    res.json({
        ok: true,
        version: v.version,
        notes: v.notes || '',
        size: v.size || 0,
        sha256: v.sha256 || '',
        published_at: v.published_at || null
        // Lưu ý: download URL được implicit là /api/download/installer
    });
});

// GET /api/download/installer — stream installer .exe (binary)
app.get('/api/download/installer', (req, res) => {
    const v = readVersionInfo();
    if (!v || !v.filename) {
        return res.status(503).json({ ok: false, error: 'Chưa có phiên bản nào được publish' });
    }
    const filePath = path.join(RELEASES_DIR, v.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ ok: false, error: 'File installer không tồn tại trên server' });
    }
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="HP-Action-LIVE-Setup-${v.version}.exe"`);
    res.setHeader('X-Checksum-SHA256', v.sha256 || '');
    res.setHeader('Cache-Control', 'public, max-age=600');
    fs.createReadStream(filePath).pipe(res);
    logLine(`UPDATE_DOWNLOAD ip=${req.ip} version=${v.version} ua="${(req.headers['user-agent'] || '').slice(0, 60)}"`);
});

// Admin endpoint: UPLOAD file installer .exe (raw binary stream).
// Header: X-Filename: HP-Action-LIVE-Setup-1.0.9.exe
// Body: raw .exe bytes (Content-Type: application/octet-stream)
// → File được ghi vào RELEASES_DIR/<filename>.
// Dùng kết hợp với /admin/api/publish-version (gọi sau khi upload xong).
app.post('/admin/api/upload-installer', requireAdminAuth,
    express.raw({ type: 'application/octet-stream', limit: '300mb' }),
    (req, res) => {
        const filename = String(req.headers['x-filename'] || '').replace(/[^\w\-.]/g, '');
        if (!filename || !filename.endsWith('.exe')) {
            return res.status(400).json({ ok: false, error: 'Header X-Filename phải là tên file .exe hợp lệ' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ ok: false, error: 'Body rỗng — gửi raw .exe bytes với Content-Type: application/octet-stream' });
        }
        try {
            if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });
            const filePath = path.join(RELEASES_DIR, filename);
            fs.writeFileSync(filePath, req.body);
            const size = req.body.length;
            const sha = crypto.createHash('sha256').update(req.body).digest('hex');
            logLine(`ADMIN_UPLOAD file=${filename} size=${size} sha256=${sha.slice(0, 16)}...`);
            res.json({ ok: true, filename, size, sha256: sha });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

// Admin endpoint: publish metadata (sau khi đã upload .exe).
// curl POST /admin/api/publish-version với body JSON: {version, notes, filename, sha256, size}
app.post('/admin/api/publish-version', requireAdminAuth, (req, res) => {
    const { version, notes, filename, sha256, size } = req.body || {};
    if (!version || !filename || !sha256) {
        return res.json({ ok: false, error: 'Thiếu trường bắt buộc: version, filename, sha256' });
    }
    const filePath = path.join(RELEASES_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.json({ ok: false, error: `File ${filename} không có trong releases/. Upload trước rồi mới publish metadata.` });
    }
    const info = {
        version: String(version).replace(/^v/i, ''),
        notes: String(notes || ''),
        filename,
        sha256: String(sha256).toLowerCase(),
        size: size || fs.statSync(filePath).size,
        published_at: Date.now()
    };
    try {
        if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });
        fs.writeFileSync(VERSION_JSON, JSON.stringify(info, null, 2));
        logLine(`ADMIN_PUBLISH version=${info.version} file=${filename} sha256=${info.sha256.slice(0, 16)}...`);
        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// === POST /activate ===
app.post('/activate', activateLimiter, async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const { key, deviceId } = req.body || {};
    const cleanKey = String(key || '').trim();

    if (!cleanKey) return res.json({ ok: false, error: 'Vui lòng nhập key' });
    if (cleanKey.length > 128) return res.json({ ok: false, error: 'Key quá dài' });

    let list;
    try { list = await fetchSheet(); }
    catch (e) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${cleanKey.slice(0, 6)}*** error=sheet_fetch ${e.message}`);
        return res.status(503).json({ ok: false, error: 'Hệ thống bản quyền tạm thời không phản hồi' });
    }

    const row = list.find(r => r.key.toLowerCase() === cleanKey.toLowerCase());
    if (!row) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${cleanKey.slice(0, 6)}*** error=not_found`);
        return res.json({ ok: false, error: 'Key không tồn tại trong hệ thống' });
    }

    if (/hết hạn|tạm khóa|tam khoa|het han|khoa|locked/i.test(row.status)) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${row.key.slice(0, 6)}*** error=locked status="${row.status}"`);
        return res.json({ ok: false, error: 'Key đã bị khoá hoặc hết hạn' });
    }

    const expiryDate = parseDmy(row.expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${row.key.slice(0, 6)}*** error=expired expiry=${row.expiry}`);
        return res.json({ ok: false, error: `Key đã hết hạn từ ${row.expiry}` });
    }

    // Check admin-revoked locally
    const keyLower = row.key.toLowerCase();
    const localRecord = activations[keyLower];
    if (localRecord?.revoked) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${row.key.slice(0, 6)}*** error=admin_revoked`);
        return res.json({ ok: false, error: 'Key đã bị thu hồi bởi quản trị viên' });
    }

    // Device binding
    if (DEVICE_BIND_ENABLED && deviceId) {
        const did = String(deviceId).trim().slice(0, 128);
        if (!localRecord) {
            activations[keyLower] = {
                key: row.key,
                devices: [{ id: did, firstSeen: Date.now(), lastSeen: Date.now(), ip }],
                firstActivatedAt: Date.now(),
                lastActivatedAt: Date.now()
            };
        } else {
            const known = localRecord.devices.find(d => d.id === did);
            if (known) {
                known.lastSeen = Date.now();
                known.ip = ip;
            } else {
                if (localRecord.devices.length >= DEVICE_BIND_MAX) {
                    logLine(`ACTIVATE_FAIL ip=${ip} key=${row.key.slice(0, 6)}*** error=device_limit devices=${localRecord.devices.length}/${DEVICE_BIND_MAX}`);
                    return res.json({
                        ok: false,
                        error: `Key đã đăng ký trên ${localRecord.devices.length} máy (giới hạn ${DEVICE_BIND_MAX}). Liên hệ HP Media để reset.`
                    });
                }
                localRecord.devices.push({ id: did, firstSeen: Date.now(), lastSeen: Date.now(), ip });
            }
            localRecord.lastActivatedAt = Date.now();
        }
        saveActivations();
    } else if (!localRecord) {
        activations[keyLower] = {
            key: row.key,
            devices: [],
            firstActivatedAt: Date.now(),
            lastActivatedAt: Date.now()
        };
        saveActivations();
    }

    // === Flat response ===
    // Với role=CREATOR, key chính là TikTok ID. App kiểm tra
    // username connect === key khi user bấm "Kết nối LIVE".
    logLine(`ACTIVATE_OK ip=${ip} key=${row.key.slice(0, 6)}*** role=${row.role} device=${deviceId ? String(deviceId).slice(0, 8) + '***' : 'none'}`);
    res.json({
        ok: true,
        key: row.key,
        role: row.role,             // ADMIN | CREATOR (normalized)
        vip: row.roleRaw,           // text gốc display: VIP / Thường / ADMIN / CREATOR
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        note: row.note,
        issued_at: Date.now()
    });
});

// === Admin auth middleware ===
function requireAdminAuth(req, res, next) {
    if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
        return res.status(503).json({ ok: false, error: 'Admin token chưa được set trên server' });
    }
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/);
    const token = m ? m[1] : (req.query.token || '');
    if (token !== ADMIN_TOKEN) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
}

// === Admin API ===
app.get('/admin/api/list', requireAdminAuth, (req, res) => {
    const list = Object.values(activations).map(a => ({
        key: a.key.slice(0, 4) + '****' + a.key.slice(-4),
        keyFull: a.key,
        devices: a.devices.length,
        deviceDetails: a.devices,
        firstActivatedAt: a.firstActivatedAt,
        lastActivatedAt: a.lastActivatedAt,
        revoked: !!a.revoked
    }));
    res.json({ ok: true, total: list.length, list });
});

app.post('/admin/api/revoke', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const kl = String(key || '').toLowerCase().trim();
    if (!kl) return res.json({ ok: false, error: 'Thiếu key' });
    const rec = activations[kl];
    if (!rec) return res.json({ ok: false, error: 'Key chưa từng activate' });
    rec.revoked = true;
    rec.revokedAt = Date.now();
    saveActivations();
    logLine(`ADMIN_REVOKE key=${rec.key.slice(0, 6)}***`);
    res.json({ ok: true });
});

app.post('/admin/api/unrevoke', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const kl = String(key || '').toLowerCase().trim();
    const rec = activations[kl];
    if (!rec) return res.json({ ok: false, error: 'Key chưa từng activate' });
    delete rec.revoked;
    delete rec.revokedAt;
    saveActivations();
    logLine(`ADMIN_UNREVOKE key=${rec.key.slice(0, 6)}***`);
    res.json({ ok: true });
});

app.post('/admin/api/reset-devices', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const kl = String(key || '').toLowerCase().trim();
    const rec = activations[kl];
    if (!rec) return res.json({ ok: false, error: 'Key chưa từng activate' });
    rec.devices = [];
    saveActivations();
    logLine(`ADMIN_RESET_DEVICES key=${rec.key.slice(0, 6)}***`);
    res.json({ ok: true });
});

app.post('/admin/api/refresh-sheet', requireAdminAuth, async (req, res) => {
    try {
        const list = await fetchSheet(true);
        res.json({ ok: true, count: list.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// === Static admin dashboard ===
app.use('/admin', express.static(path.join(__dirname, 'public')));

// === Start ===
app.listen(PORT, () => {
    console.log(`[license-server] HP License Server đang chạy http://localhost:${PORT}`);
    console.log(`[license-server] Sheet ID: ${SHEET_ID.slice(0, 8)}...`);
    console.log(`[license-server] Device binding: ${DEVICE_BIND_ENABLED ? `ON (max ${DEVICE_BIND_MAX} máy/key)` : 'OFF'}`);
    console.log(`[license-server] Admin dashboard: http://localhost:${PORT}/admin/?token=YOUR_ADMIN_TOKEN`);
    logLine(`SERVER_START port=${PORT}`);
});

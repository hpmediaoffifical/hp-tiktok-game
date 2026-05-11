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

// Sheet cột:
//   A=Key | B=Expiry | C=Role | D=Status | E=Note | F=TikTok ID (chỉ CREATOR)
// Role values (cột C):
//   ADMIN     — toàn quyền, connect bất kỳ TikTok ID nào
//   CREATOR   — bind TikTok ID ở cột F, không match thì reject
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
            roleRaw: String(r[2] || '').trim(),   // giữ nguyên text để display (VIP / Thường / ADMIN / CREATOR)
            status: String(r[3] || '').trim(),
            note: String(r[4] || '').trim(),
            tiktokId: String(r[5] || '').trim().replace(/^@/, '')   // bỏ @ nếu có
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
    logLine(`ACTIVATE_OK ip=${ip} key=${row.key.slice(0, 6)}*** role=${row.role} tiktok=${row.tiktokId || '-'} device=${deviceId ? String(deviceId).slice(0, 8) + '***' : 'none'}`);
    res.json({
        ok: true,
        key: row.key,
        role: row.role,             // ADMIN | CREATOR (normalized)
        vip: row.roleRaw,           // text gốc để display: VIP / Thường / ADMIN / CREATOR
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        note: row.note,
        tiktokId: row.role === 'CREATOR' ? row.tiktokId : '',   // CREATOR mới có tiktokId, ADMIN bỏ trống
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

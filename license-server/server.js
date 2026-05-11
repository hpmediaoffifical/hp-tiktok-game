/**
 * HP Action LIVE — Standalone License Validation Server
 * =====================================================
 * Server Node.js độc lập xác thực key bản quyền HP Action LIVE.
 *
 * KIẾN TRÚC:
 *   App electron → POST /activate {key, deviceId?} → Server này
 *                                                          ↓
 *                                                  Đọc Google Sheet
 *                                                          ↓
 *                                                  Validate + log
 *                                                          ↓
 *                                                  Sign Ed25519
 *                                                          ↓
 *                                  ← {data, signature} ← App verify
 *
 * THAY THẾ Cloudflare Worker — full control, có database activation,
 * có admin dashboard, có device binding.
 *
 * Deploy: VPS / Render / Railway / Fly.io / Self-host. Xem README.md.
 */

// Load .env (chỉ khi chạy local — production dùng env vars từ Render/Railway/VPS systemd)
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

// === Load private key ===
let privateKeyPem = process.env.SIGN_PRIVATE_KEY || '';
if (process.env.SIGN_PRIVATE_KEY_FILE) {
    try {
        privateKeyPem = fs.readFileSync(process.env.SIGN_PRIVATE_KEY_FILE, 'utf8');
    } catch (e) {
        console.error('[fatal] Không đọc được SIGN_PRIVATE_KEY_FILE:', e.message);
        process.exit(1);
    }
}
// Cho phép env multi-line escape \n
privateKeyPem = privateKeyPem.replace(/\\n/g, '\n');

if (!privateKeyPem.includes('BEGIN PRIVATE KEY')) {
    console.error('[fatal] SIGN_PRIVATE_KEY chưa được set (hoặc sai format PEM). Chạy `node keygen.js` để sinh.');
    process.exit(1);
}
if (!SHEET_ID) {
    console.error('[fatal] SHEET_ID chưa được set trong .env');
    process.exit(1);
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
    console.warn('[warn] ADMIN_TOKEN ngắn hoặc trống — /admin endpoint sẽ KHÔNG hoạt động cho đến khi set token đủ mạnh (≥32 chars).');
}

const signKey = crypto.createPrivateKey(privateKeyPem);

// === Ensure data dir ===
const dataDir = path.dirname(ACTIVATIONS_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// === Activations store (file-based JSON, đủ cho < 100K user) ===
let activations = {};  // { keyLower: { key, devices: [{id, firstSeen, lastSeen, ip}], firstActivatedAt, lastActivatedAt, revoked? } }
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
            vip: String(r[2] || '').trim(),
            status: String(r[3] || '').trim(),
            note: String(r[4] || '').trim()
        });
    }
    return list;
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

// === Crypto sign (Ed25519) ===
function canonicalJSON(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function signPayload(data) {
    const msg = Buffer.from(canonicalJSON(data), 'utf8');
    const sig = crypto.sign(null, msg, signKey);
    return sig.toString('base64');
}

// === Express app ===
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render/Railway/Fly đứng sau reverse proxy
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

    // Fetch sheet
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
        // No device binding — vẫn log lần activate đầu
        activations[keyLower] = {
            key: row.key,
            devices: [],
            firstActivatedAt: Date.now(),
            lastActivatedAt: Date.now()
        };
        saveActivations();
    }

    // Build signed payload
    const now = Date.now();
    const data = {
        ok: true,
        key: row.key,
        vip: row.vip,
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        note: row.note,
        issued_at: now,
        valid_until: now + 24 * 60 * 60 * 1000
    };

    let signature;
    try { signature = signPayload(data); }
    catch (e) {
        logLine(`ACTIVATE_FAIL ip=${ip} key=${row.key.slice(0, 6)}*** error=sign ${e.message}`);
        return res.status(500).json({ ok: false, error: 'Lỗi ký response' });
    }

    logLine(`ACTIVATE_OK ip=${ip} key=${row.key.slice(0, 6)}*** vip=${row.vip} device=${deviceId ? String(deviceId).slice(0, 8) + '***' : 'none'}`);
    res.json({ data, signature });
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

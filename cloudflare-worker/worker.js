/**
 * HP Action LIVE — License Validation Worker
 * ============================================
 * Cloudflare Worker xác thực key bản quyền.
 *
 * Mục đích bảo mật:
 *  - Ẩn Google Sheet ID khỏi app phía client (trước đây nằm trong server.js plain text)
 *  - Ký response bằng Ed25519 → app chỉ verify, không thể forge mà không có private key
 *  - Cloudflare cache + rate limit tự động ở edge → chống brute force key
 *  - Logging request → HP Media có thể audit hoạt động bất thường
 *
 * Endpoints:
 *  POST /activate      → validate key, return signed payload
 *  GET  /              → health check (không expose data)
 *
 * Environment variables (set qua `wrangler secret put`):
 *  - SHEET_ID            : Google Sheet ID
 *  - KEY_SHEET_NAME      : tên sheet chứa key (vd: KEY_HP_GAME)
 *  - SIGN_PRIVATE_KEY    : Ed25519 PEM private key (PKCS8) — DÙNG keygen.js sinh ra
 */

export default {
    async fetch(request, env, ctx) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: corsHeaders()
            });
        }

        const url = new URL(request.url);

        // Health check (không lộ thông tin)
        if (url.pathname === '/' && request.method === 'GET') {
            return jsonResponse({ service: 'hp-license', status: 'ok' });
        }

        // License activate
        if (url.pathname === '/activate' && request.method === 'POST') {
            return handleActivate(request, env, ctx);
        }

        return jsonResponse({ ok: false, error: 'Not found' }, 404);
    }
};

async function handleActivate(request, env, ctx) {
    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ ok: false, error: 'Body không hợp lệ' }, 400); }

    const key = String(body.key || '').trim();
    if (!key) return jsonResponse({ ok: false, error: 'Vui lòng nhập key' });
    if (key.length > 128) return jsonResponse({ ok: false, error: 'Key quá dài' });

    // === Fetch sheet (Cloudflare cache 60s ở edge để giảm tải Google Sheets) ===
    const sheetId = env.SHEET_ID;
    const sheetName = env.KEY_SHEET_NAME || 'KEY_HP_GAME';
    if (!sheetId) return jsonResponse({ ok: false, error: 'Worker chưa cấu hình SHEET_ID' }, 500);

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    let csv;
    try {
        const resp = await fetch(sheetUrl, {
            cf: { cacheTtl: 60, cacheEverything: true }
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        csv = await resp.text();
    } catch (e) {
        return jsonResponse({ ok: false, error: 'Hệ thống bản quyền tạm thời không phản hồi, vui lòng thử lại' }, 503);
    }

    // === Parse CSV + tìm key ===
    const row = findKey(csv, key);
    if (!row) return jsonResponse({ ok: false, error: 'Key không tồn tại trong hệ thống' });

    // Status check
    if (/hết hạn|tạm khóa|tam khoa|het han|khoa|locked/i.test(row.status)) {
        return jsonResponse({ ok: false, error: 'Key đã bị khoá hoặc hết hạn' });
    }

    // Expiry check
    const expiryDate = parseDmy(row.expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
        return jsonResponse({ ok: false, error: `Key đã hết hạn từ ${row.expiry}` });
    }

    // === Build signed payload ===
    const now = Date.now();
    const data = {
        ok: true,
        key: row.key,
        vip: row.vip,
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        note: row.note || '',
        issued_at: now,
        // Token hết hạn sau 24h — app re-validate sau đó
        valid_until: now + 24 * 60 * 60 * 1000
    };

    let signature;
    try {
        signature = await signPayload(data, env.SIGN_PRIVATE_KEY);
    } catch (e) {
        return jsonResponse({ ok: false, error: 'Lỗi ký response — kiểm tra SIGN_PRIVATE_KEY của Worker' }, 500);
    }

    return jsonResponse({ data, signature });
}

// ============================================================
// CSV parser (đồng bộ logic với server.js cũ)
// ============================================================
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
            else if (ch === '\r') { /* skip */ }
            else cur += ch;
        }
    }
    if (cur.length || row.length) flushRow();
    return rows;
}

function findKey(csvText, queryKey) {
    const rows = parseCsv(csvText);
    const q = queryKey.toLowerCase();
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;
        if (String(r[0]).trim().toLowerCase() === q) {
            return {
                key: String(r[0] || '').trim(),
                expiry: String(r[1] || '').trim(),
                vip: String(r[2] || '').trim(),
                status: String(r[3] || '').trim(),
                note: String(r[4] || '').trim()
            };
        }
    }
    return null;
}

function parseDmy(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
}

// ============================================================
// Ed25519 signing (Web Crypto API trên Cloudflare Workers)
// ============================================================
async function signPayload(data, privateKeyPem) {
    if (!privateKeyPem) throw new Error('SIGN_PRIVATE_KEY chưa được set');

    // Import private key từ PEM (PKCS8)
    const pkcs8 = pemToArrayBuffer(privateKeyPem);
    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'Ed25519' },
        false,
        ['sign']
    );

    // Canonical JSON (sort keys) để app verify khớp
    const message = canonicalJSON(data);
    const messageBytes = new TextEncoder().encode(message);

    const sigBuf = await crypto.subtle.sign('Ed25519', cryptoKey, messageBytes);
    return arrayBufferToBase64(sigBuf);
}

function canonicalJSON(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function pemToArrayBuffer(pem) {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    const binStr = atob(b64);
    const buf = new ArrayBuffer(binStr.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binStr.length; i++) view[i] = binStr.charCodeAt(i);
    return buf;
}

function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binStr = '';
    for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
    return btoa(binStr);
}

// ============================================================
// Response helpers
// ============================================================
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders()
        }
    });
}

/**
 * HP Action LIVE — License Validation Worker (Cloudflare)
 * =======================================================
 * Cloudflare Worker xác thực key bản quyền.
 *
 * Endpoints:
 *  POST /activate      → validate key, return result
 *  GET  /              → health check
 *
 * Environment variables (set qua `wrangler secret put` hoặc dashboard):
 *  - SHEET_ID            : Google Sheet ID (secret)
 *  - KEY_SHEET_NAME      : tên sheet chứa key (vd: KEY_HP_GAME)
 *
 * Bảo mật: HTTPS (Cloudflare tự handle), không ký Ed25519 — đơn giản.
 * App tin URL Worker được hardcode trong build.
 */

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }

        const url = new URL(request.url);

        if (url.pathname === '/' && request.method === 'GET') {
            return jsonResponse({ service: 'hp-license', status: 'ok' });
        }

        if (url.pathname === '/activate' && request.method === 'POST') {
            return handleActivate(request, env);
        }

        return jsonResponse({ ok: false, error: 'Not found' }, 404);
    }
};

async function handleActivate(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ ok: false, error: 'Body không hợp lệ' }, 400); }

    const key = String(body.key || '').trim();
    if (!key) return jsonResponse({ ok: false, error: 'Vui lòng nhập key' });
    if (key.length > 128) return jsonResponse({ ok: false, error: 'Key quá dài' });

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
        return jsonResponse({ ok: false, error: 'Hệ thống bản quyền tạm thời không phản hồi' }, 503);
    }

    const row = findKey(csv, key);
    if (!row) return jsonResponse({ ok: false, error: 'Key không tồn tại trong hệ thống' });

    if (/hết hạn|tạm khóa|tam khoa|het han|khoa|locked/i.test(row.status)) {
        return jsonResponse({ ok: false, error: 'Key đã bị khoá hoặc hết hạn' });
    }

    const expiryDate = parseDmy(row.expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
        return jsonResponse({ ok: false, error: `Key đã hết hạn từ ${row.expiry}` });
    }

    // Flat response — không ký, dựa vào HTTPS
    // Với role=CREATOR, key chính là TikTok ID. App check username connect === key.
    return jsonResponse({
        ok: true,
        key: row.key,
        role: row.role,
        vip: row.roleRaw,
        expiry: row.expiry,
        expiryISO: expiryDate ? expiryDate.toISOString() : null,
        note: row.note || '',
        issued_at: Date.now()
    });
}

// ============================================================
// CSV parser
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

// Sheet cột: A=Key | B=Expiry | C=Role | D=Status | E=Note
// Với role=CREATOR, key cột A chính là TikTok ID — app check username connect === key.
function findKey(csvText, queryKey) {
    const rows = parseCsv(csvText);
    const q = queryKey.toLowerCase();
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;
        if (String(r[0]).trim().toLowerCase() === q) {
            const roleRaw = String(r[2] || '').trim();
            const role = normalizeRole(roleRaw);
            return {
                key: String(r[0] || '').trim(),
                expiry: String(r[1] || '').trim(),
                role,
                roleRaw,
                status: String(r[3] || '').trim(),
                note: String(r[4] || '').trim()
            };
        }
    }
    return null;
}

function normalizeRole(raw) {
    const up = String(raw).toUpperCase();
    if (up === 'ADMIN' || up === 'CREATOR') return up;
    return 'ADMIN';   // backward compat: VIP/Thường/blank → full access
}

function parseDmy(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
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

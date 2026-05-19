'use strict';
/**
 * HP KEY - Adapter cho HP Action LIVE (TikTok Game).
 *
 * Thay th? license-server cu (Cloudflare Worker doc Google Sheet) b?ng HP KEY
 * tren hosting hpvn.media. Gi? NGUYEN interface validateLicenseKey() => server.js
 * va toan b? gate / role CREATOR khong c?n s?a gi them.
 *
 * Khac bi?t b?o m?t so v?i ban cu:
 *   - Request ky HMAC (ch?ng gi? client / s?a body)
 *   - Response la TOKEN ky RSA-SHA256, app verify b?ng public-key.js nhung s?n
 *     => server gi? / s?a file hosts tr? "ok" cung VO D?NG.
 */
const https = require('https');
const { URL } = require('url');
const os = require('os');
const crypto = require('crypto');

const cfg = require('./config');
const PUBLIC_KEY_B64 = require('./public-key');
const { getHWID } = require('./hwid');

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* Canonical JSON kh?p PHP json_encode(UNESCAPED_UNICODE|UNESCAPED_SLASHES) */
function canonical(body) {
  const o = {};
  Object.keys(body).filter((k) => k !== 'sig').sort().forEach((k) => { o[k] = body[k]; });
  return JSON.stringify(o);
}
function signBody(body) {
  return crypto.createHmac('sha256', cfg.HMAC_SECRET).update(canonical(body)).digest('hex');
}

function apiCall(action, extra) {
  const body = Object.assign(
    { action, p: cfg.PRODUCT, ts: Math.floor(Date.now() / 1000) },
    extra || {}
  );
  body.sig = signBody(body);
  const data = JSON.stringify(body);
  const u = new URL(cfg.API_URL);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 12000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ net: true, body: JSON.parse(raw) }); }
          catch (_) { resolve({ net: true, body: {} }); }
        });
      }
    );
    req.on('error', () => resolve({ net: false }));
    req.on('timeout', () => { req.destroy(); resolve({ net: false }); });
    req.write(data);
    req.end();
  });
}

function rsaPubKey() {
  // PUBLIC_KEY_B64 = base64(PEM) do install/setup.php in ra
  return Buffer.from(PUBLIC_KEY_B64, 'base64').toString('utf8');
}

function verifyToken(token, hwid) {
  if (!token || token.indexOf('.') < 0) return null;
  const [msg, sig] = token.split('.');
  let okSig;
  try {
    okSig = crypto.verify('sha256', Buffer.from(msg), rsaPubKey(), b64urlToBuf(sig));
  } catch (_) { return null; }
  if (!okSig) return null;
  let p;
  try { p = JSON.parse(b64urlToBuf(msg).toString('utf8')); } catch (_) { return null; }
  if (p.v !== 1 || p.p !== cfg.PRODUCT || p.h !== hwid) return null;
  const now = Math.floor(Date.now() / 1000);
  return { payload: p, expired: p.exp !== 0 && now > p.exp };
}

function fmtDmy(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const ERR = {
  invalid_key: 'Key không tồn tại trong hệ thống',
  key_blocked: 'Key đã bị khoá — liên hệ HP Media',
  key_expired: 'Key đã hết hạn',
  expired: 'Key đã hết hạn',
  device_limit_reached: 'Key đã đạt giới hạn số máy — liên hệ HP Media để thêm/đổi máy',
  device_revoked: 'Thiết bị này đã bị thu hồi quyền — liên hệ HP Media',
  bad_signature: 'Cấu hình bản quyền sai (HMAC secret) — liên hệ HP Media',
  unknown_product: 'Sản phẩm chưa được cấu hình trên hệ thống bản quyền',
  request_expired: 'Đồng hồ máy sai lệch — chỉnh lại giờ hệ thống rồi thử lại',
  server_not_configured: 'Hệ thống bản quyền chưa cấu hình — liên hệ HP Media',
};

/**
 * Gi? nguyen ch? ky ham cu trong server.js.
 * Tr? v?: {ok:true, key, role, vip, expiry, expiryISO, status, note}
 *      ho?c {ok:false, error, _offline?}
 */
async function validateLicenseKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, error: 'Vui lòng nhập key bản quyền' };

  if (!cfg.HMAC_SECRET || cfg.HMAC_SECRET.indexOf('DAN_') === 0
      || PUBLIC_KEY_B64.indexOf('DAN_') === 0) {
    return { ok: false, error: 'Hệ thống bản quyền chưa cấu hình — liên hệ HP Media' };
  }

  const hwid = getHWID();
  const r = await apiCall('activate', { key, hwid, device: os.hostname() });

  if (!r.net) {
    return { ok: false, error: 'Không kết nối được hệ thống bản quyền — kiểm tra mạng và thử lại', _offline: true };
  }
  if (!r.body || r.body.ok !== true || !r.body.token) {
    const code = r.body && r.body.error;
    return { ok: false, error: ERR[code] || ('Key không hợp lệ' + (code ? ` (${code})` : '')) };
  }

  const v = verifyToken(r.body.token, hwid);
  if (!v) return { ok: false, error: 'Phản hồi kích hoạt không hợp lệ (sai chữ ký) — liên hệ HP Media' };
  if (v.expired) return { ok: false, error: 'Key đã hết hạn' };

  const p = v.payload;
  return {
    ok: true,
    key: p.k,                         // CREATOR: chính là TikTok ID
    role: p.r || 'ADMIN',             // ADMIN | CREATOR
    vip: p.r || '',
    expiry: fmtDmy(p.exp),            // '' n?u vinh vi?n
    expiryISO: p.exp ? new Date(p.exp * 1000).toISOString() : null,
    status: 'Đang sử dụng',
    note: '',
  };
}

module.exports = { validateLicenseKey, getHWID };

/*
 * 🔊 SoundFX module — soundboard cho streamer LIVE
 *
 * Bảo mật:
 *  - File mp3 LOCAL (Audio/ trong %AppData%/MFVN) chỉ serve qua /api/soundfx/audio/:id,
 *    path thật resolve server-side, KHÔNG bao giờ lộ ra client.
 *  - Cloud (tiengcuoi.com/qqsound) proxy qua token tạm: client chỉ thấy token,
 *    KHÔNG thấy URL gốc. Stream thẳng (không ghi đĩa) → bảo mật + không tốn disk.
 *  - Google TTS proxy: ẩn endpoint Google, hỗ trợ tách câu dài.
 *
 * Lưu trữ: data/soundfx.json (migrate 1 lần từ DB.sqlite dmmusic).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');

// ===== Đường dẫn nguồn (app .NET cũ MFVN) =====
function mfvnBaseDir() {
    // %AppData%\MFVN\Application\HPMedia
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'MFVN', 'Application', 'HPMedia');
}
function mfvnDbPath()    { return path.join(mfvnBaseDir(), 'DB.sqlite'); }
function mfvnAudioDir()  { return path.join(mfvnBaseDir(), 'Audio'); }

const CLOUD_BASE = 'https://tiengcuoi.com/qqsound/';

// Tab GroupId → tên hiển thị (theo app .NET cũ).
const TAB_NAMES = {
    tab0: 'HP STUDIO',
    tab1: 'NHẠC',
    tab2: 'TIẾNG ĐỘNG',
    tab3: 'SÁNG TẠO',
    tab4: 'THI ĐẤU',
    tab5: 'VUI NHỘN'
};

function createSoundfxModule(DATA_DIR) {
    const SOUNDFX_FILE = path.join(DATA_DIR, 'soundfx.json');
    const router = express.Router();

    // ---- Token map cho cloud stream (ẩn link gốc). Sống trong RAM, TTL 6h ----
    const cloudTokens = new Map();   // token → { url, ts }
    const CLOUD_TOKEN_TTL = 6 * 60 * 60 * 1000;
    function makeCloudToken(absUrl) {
        const token = crypto.createHash('sha1').update(absUrl).digest('hex').slice(0, 24);
        cloudTokens.set(token, { url: absUrl, ts: Date.now() });
        return token;
    }
    function resolveCloudToken(token) {
        let e = cloudTokens.get(token) || _staticTokenMap.get(token);
        if (!e) return null;
        if (Date.now() - e.ts > CLOUD_TOKEN_TTL) { cloudTokens.delete(token); _staticTokenMap.delete(token); return null; }
        return e.url;
    }
    setInterval(() => {
        const now = Date.now();
        for (const [k, v] of cloudTokens) if (now - v.ts > CLOUD_TOKEN_TTL) cloudTokens.delete(k);
    }, 30 * 60 * 1000).unref?.();

    // ---- Library: load / migrate ----
    function defaultLibrary() {
        return {
            version: 1,
            tabs: [],          // [{id, name}]
            sounds: {},        // id → { id, tab, name, relPath, source:'local', hotkey:{ctrl,shift,alt,code}, remoteKey }
            favorites: [],     // [id] — có thứ tự (drag-drop)
            order: {},         // tabId → [id...] thứ tự card tuỳ chỉnh
            settings: {
                volume: 90,
                bgColor: '#ffffff',
                accent: '#2563eb',
                fontSize: 14,
                scale: 1,
                useHotkeys: true,
                showHotkeys: true,
                globalHotkeys: true,     // phím tắt hoạt động MỌI NƠI (không cần focus cửa sổ)
                stopOnNew: true,         // phát sound mới → dừng sound đang chạy
                hotkeyPlay: null,        // {ctrl,shift,alt,code} — phát lại sound cuối
                hotkeyStop: null,        // {ctrl,shift,alt,code} — dừng tất cả
                ttsLang: 'vi',
                ttsSpeed: 1,
                win: { x: null, y: null, w: 480, h: 740, alwaysOnTop: true }
            },
            migratedFrom: null
        };
    }

    function migrateFromSqlite() {
        const lib = defaultLibrary();
        const dbPath = mfvnDbPath();
        if (!fs.existsSync(dbPath)) {
            // Không có app cũ → library rỗng, chỉ tab YÊU THÍCH ảo + dùng Cloud
            lib.migratedFrom = 'none';
            return lib;
        }
        try {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const rows = db.prepare(
                'SELECT GroupId, Id, Name, SoundFilePath, KeyControl, KeyShift, KeyAlt, HotKey, Favorite, RemoteKey FROM dmmusic'
            ).all();
            db.close();
            const tabSet = new Map();
            for (const r of rows) {
                const rel = String(r.SoundFilePath || '').trim();
                // Bỏ slot trống (placeholder "Âm thanh" path rỗng)
                if (!rel || !/\.mp3$/i.test(rel)) continue;
                const gid = r.GroupId || 'tab1';
                if (!tabSet.has(gid)) tabSet.set(gid, true);
                const id = String(r.Id || crypto.randomUUID());
                // relPath chuẩn hoá: bỏ "Audio/" prefix nếu có, dùng / thay \
                let p = rel.replace(/\\/g, '/');
                p = p.replace(/^Audio\//i, '');
                lib.sounds[id] = {
                    id,
                    tab: gid,
                    name: r.Name || 'Âm thanh',
                    relPath: p,
                    source: 'local',
                    hotkey: (r.HotKey > 0) ? {
                        ctrl: !!r.KeyControl, shift: !!r.KeyShift, alt: !!r.KeyAlt, code: r.HotKey
                    } : null,
                    remoteKey: r.RemoteKey || 0
                };
                if (r.Favorite === 1) lib.favorites.push(id);
            }
            // Tabs theo thứ tự tab0..tabN, đặt tên từ TAB_NAMES
            const gids = [...tabSet.keys()].sort();
            lib.tabs = gids.map(g => ({ id: g, name: TAB_NAMES[g] || g.toUpperCase() }));
            lib.migratedFrom = dbPath;
        } catch (e) {
            console.warn('[soundfx] migrate DB.sqlite lỗi:', e.message);
            lib.migratedFrom = 'error:' + e.message;
        }
        return lib;
    }

    let _libCache = null;
    function loadLibrary() {
        if (_libCache) return _libCache;
        if (fs.existsSync(SOUNDFX_FILE)) {
            try {
                _libCache = JSON.parse(fs.readFileSync(SOUNDFX_FILE, 'utf8'));
                // Bổ sung field thiếu (forward-compat)
                const d = defaultLibrary();
                _libCache.settings = Object.assign({}, d.settings, _libCache.settings || {});
                _libCache.settings.win = Object.assign({}, d.settings.win, (_libCache.settings || {}).win || {});
                return _libCache;
            } catch (e) { /* fallthrough → migrate */ }
        }
        _libCache = migrateFromSqlite();
        saveLibrary();
        return _libCache;
    }
    let _saveTimer = null;
    function saveLibrary() {
        if (!_libCache) return;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            try { fs.writeFileSync(SOUNDFX_FILE, JSON.stringify(_libCache, null, 2), 'utf8'); }
            catch (e) { console.warn('[soundfx] save lỗi:', e.message); }
        }, 300);
    }

    // Library cho client — KHÔNG kèm path thật / cloud url (bảo mật)
    function clientLibrary() {
        const lib = loadLibrary();
        const sounds = {};
        for (const [id, s] of Object.entries(lib.sounds)) {
            sounds[id] = {
                id, tab: s.tab, name: s.name,
                source: s.source,
                hotkey: s.hotkey || null,
                remoteKey: s.remoteKey || 0
            };
        }
        return {
            tabs: lib.tabs,
            sounds,
            favorites: lib.favorites,
            order: lib.order || {},
            settings: lib.settings,
            hasLocal: lib.migratedFrom && !String(lib.migratedFrom).startsWith('none') && !String(lib.migratedFrom).startsWith('error')
        };
    }
    function genSoundId() { return 'sfx_' + crypto.randomBytes(7).toString('hex'); }

    // ===== Routes =====
    router.get('/library', (req, res) => {
        res.json(clientLibrary());
    });

    // Lưu config (settings / favorites order / hotkey / rename)
    router.post('/config', express.json({ limit: '512kb' }), (req, res) => {
        const lib = loadLibrary();
        const body = req.body || {};
        if (body.settings && typeof body.settings === 'object') {
            lib.settings = Object.assign({}, lib.settings, body.settings);
            if (body.settings.win) lib.settings.win = Object.assign({}, lib.settings.win, body.settings.win);
        }
        if (Array.isArray(body.favorites)) {
            // Chỉ giữ id hợp lệ
            lib.favorites = body.favorites.filter(id => lib.sounds[id]);
        }
        if (body.hotkeys && typeof body.hotkeys === 'object') {
            for (const [id, hk] of Object.entries(body.hotkeys)) {
                if (lib.sounds[id]) lib.sounds[id].hotkey = hk || null;
            }
        }
        if (body.renames && typeof body.renames === 'object') {
            for (const [id, nm] of Object.entries(body.renames)) {
                if (lib.sounds[id] && typeof nm === 'string' && nm.trim()) {
                    lib.sounds[id].name = nm.trim().slice(0, 60);
                }
            }
        }
        // Thứ tự card theo từng tab (kéo-thả sắp xếp)
        if (body.order && typeof body.order === 'object') {
            lib.order = lib.order || {};
            for (const [tab, arr] of Object.entries(body.order)) {
                if (Array.isArray(arr)) lib.order[tab] = arr.filter(id => lib.sounds[id]);
            }
        }
        saveLibrary();
        res.json({ ok: true });
    });

    // Stream audio — resolve server-side mọi nguồn (path/url ẩn khỏi client):
    //   local     → file trong %AppData% MFVN/Audio (relPath)
    //   localpath → file tuyệt đối user tự chọn (absPath)
    //   cloud     → stream từ cloudUrl đã lưu (ẩn tiengcuoi.com)
    router.get('/audio/:id', async (req, res) => {
        const lib = loadLibrary();
        const s = lib.sounds[req.params.id];
        if (!s) return res.status(404).end();
        if (s.source === 'cloud' && s.cloudUrl) {
            try {
                const headers = {};
                if (req.headers.range) headers.Range = req.headers.range;
                const r = await fetch(s.cloudUrl, { headers, timeout: 20000 });
                res.status(r.status);
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Accept-Ranges', 'bytes');
                const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
                const cr = r.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
                r.body.pipe(res);
            } catch (e) { res.status(502).end(); }
            return;
        }
        let abs;
        if (s.source === 'localpath' && s.absPath) {
            abs = s.absPath;
        } else {
            abs = path.join(mfvnAudioDir(), String(s.relPath || '').replace(/\//g, path.sep));
            if (!abs.startsWith(mfvnAudioDir())) return res.status(403).end();
        }
        if (!abs || !fs.existsSync(abs)) return res.status(404).end();
        streamFileWithRange(abs, req, res);
    });

    // ➕ Thêm sound mới (từ máy / cloud) — lưu vào soundfx.json
    router.post('/sound/add', express.json({ limit: '256kb' }), (req, res) => {
        const lib = loadLibrary();
        const b = req.body || {};
        const tab = String(b.tab || (lib.tabs[0] && lib.tabs[0].id) || 'tab1');
        let name = String(b.name || '').trim();
        const id = genSoundId();
        const entry = { id, tab, name: name || 'Âm thanh', hotkey: null, remoteKey: 0 };
        if (b.source === 'cloud') {
            const url = resolveCloudToken(String(b.cloudToken || ''));
            if (!url) return res.status(400).json({ ok: false, error: 'cloud_token_invalid' });
            entry.source = 'cloud';
            entry.cloudUrl = url;     // lưu BỀN — ẩn khỏi client, regen token mỗi lần list
            if (!name) entry.name = baseNameFromUrl(url);
        } else if (b.source === 'localpath') {
            const ap = String(b.localPath || '');
            if (!ap || !fs.existsSync(ap)) return res.status(400).json({ ok: false, error: 'file_not_found' });
            entry.source = 'localpath';
            entry.absPath = ap;
            if (!name) entry.name = path.basename(ap).replace(/\.[a-z0-9]+$/i, '');
        } else {
            return res.status(400).json({ ok: false, error: 'bad_source' });
        }
        lib.sounds[id] = entry;
        saveLibrary();
        res.json({ ok: true, id, name: entry.name });
    });

    // 🔁 Thay nguồn của sound đang có (giữ id/tab/hotkey/favorite)
    router.post('/sound/replace', express.json({ limit: '256kb' }), (req, res) => {
        const lib = loadLibrary();
        const b = req.body || {};
        const s = lib.sounds[String(b.id || '')];
        if (!s) return res.status(404).json({ ok: false, error: 'not_found' });
        if (b.source === 'cloud') {
            const url = resolveCloudToken(String(b.cloudToken || ''));
            if (!url) return res.status(400).json({ ok: false, error: 'cloud_token_invalid' });
            s.source = 'cloud'; s.cloudUrl = url;
            delete s.absPath; delete s.relPath;
            if (b.useFileName) s.name = baseNameFromUrl(url);
        } else if (b.source === 'localpath') {
            const ap = String(b.localPath || '');
            if (!ap || !fs.existsSync(ap)) return res.status(400).json({ ok: false, error: 'file_not_found' });
            s.source = 'localpath'; s.absPath = ap;
            delete s.cloudUrl; delete s.relPath;
            if (b.useFileName) s.name = path.basename(ap).replace(/\.[a-z0-9]+$/i, '');
        } else {
            return res.status(400).json({ ok: false, error: 'bad_source' });
        }
        saveLibrary();
        res.json({ ok: true, name: s.name });
    });

    // ↔ Chuyển sound sang tab khác
    router.post('/sound/move', express.json(), (req, res) => {
        const lib = loadLibrary();
        const b = req.body || {};
        const s = lib.sounds[String(b.id || '')];
        if (!s) return res.status(404).json({ ok: false });
        s.tab = String(b.tab || s.tab);
        saveLibrary();
        res.json({ ok: true });
    });

    // 🗑 Xoá sound
    router.post('/sound/remove', express.json(), (req, res) => {
        const lib = loadLibrary();
        const id = String((req.body || {}).id || '');
        if (lib.sounds[id]) {
            delete lib.sounds[id];
            lib.favorites = (lib.favorites || []).filter(x => x !== id);
            saveLibrary();
        }
        res.json({ ok: true });
    });

    // Cloud: list 1 thư mục (parse Apache autoindex). path = subpath rel CLOUD_BASE.
    router.get('/cloud/list', async (req, res) => {
        try {
            let sub = String(req.query.path || '').replace(/^\/+/, '');
            // Chặn thoát ra ngoài qqsound/
            if (sub.includes('..')) sub = '';
            const url = CLOUD_BASE + sub;
            const r = await fetch(url, { timeout: 12000 });
            if (!r.ok) return res.status(502).json({ ok: false, error: 'cloud_unreachable' });
            const html = await r.text();
            const parsed = parseAutoindex(html, url);
            res.json({ ok: true, path: sub, ...parsed });
        } catch (e) {
            res.status(502).json({ ok: false, error: e.message });
        }
    });

    // Cloud: stream mp3 qua token (ẩn link gốc). KHÔNG ghi đĩa.
    router.get('/cloud/stream/:token', async (req, res) => {
        const url = resolveCloudToken(req.params.token);
        if (!url) return res.status(404).end();
        try {
            const headers = {};
            if (req.headers.range) headers.Range = req.headers.range;
            const r = await fetch(url, { headers, timeout: 20000 });
            res.status(r.status);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
            const cr = r.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
            r.body.pipe(res);
        } catch (e) {
            res.status(502).end();
        }
    });

    // Google TTS proxy — tách câu dài (Google giới hạn ~200 ký tự/lần)
    router.get('/tts', async (req, res) => {
        const text = String(req.query.text || '').trim();
        const lang = String(req.query.lang || 'vi').slice(0, 8);
        if (!text) return res.status(400).end();
        try {
            const chunks = splitTtsText(text, 190);
            res.setHeader('Content-Type', 'audio/mpeg');
            for (let i = 0; i < chunks.length; i++) {
                const u = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob'
                    + '&tl=' + encodeURIComponent(lang)
                    + '&q=' + encodeURIComponent(chunks[i])
                    + '&textlen=' + chunks[i].length
                    + '&idx=' + i + '&total=' + chunks.length;
                const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://translate.google.com/' }, timeout: 15000 });
                if (!r.ok) { if (i === 0) return res.status(502).end(); break; }
                const buf = await r.buffer();
                res.write(buf);
            }
            res.end();
        } catch (e) {
            if (!res.headersSent) res.status(502).end();
            else res.end();
        }
    });

    // Serve trang soundboard
    router.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'soundfx', 'soundfx.html'));
    });

    return { router, loadLibrary, clientLibrary };
}

// ===== Helpers =====
function streamFileWithRange(abs, req, res) {
    const stat = fs.statSync(abs);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) { res.status(416).end(); return; }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
        res.setHeader('Content-Length', total);
        fs.createReadStream(abs).pipe(res);
    }
}

// Parse Apache/PHP autoindex HTML → { folders:[{name,path}], files:[{name,token}] }
function parseAutoindex(html, baseUrl) {
    const folders = [];
    const files = [];
    // Mỗi <tr> chứa <a href="...">name</a>; folder href kết thúc bằng /
    const re = /<a\s+href="([^"]+)"[^>]*>(?:<img[^>]*>)?\s*([^<]+?)\s*<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(html)) !== null) {
        let href = m[1];
        let name = decodeHtml(m[2]).trim();
        if (!name || /parent directory/i.test(name)) continue;
        if (href.startsWith('?') || href.startsWith('#')) continue;
        // href có thể absolute path "/qqsound/xxx/" hoặc relative
        let absHref;
        try { absHref = new URL(href, baseUrl).href; } catch { continue; }
        if (seen.has(absHref)) continue;
        seen.add(absHref);
        if (href.endsWith('/')) {
            // folder — trả path rel so với qqsound/
            const rel = absHref.split('/qqsound/')[1] || '';
            folders.push({ name, path: decodeURIComponent(rel.replace(/\/$/, '')) });
        } else if (/\.(mp3|wav|ogg|m4a)$/i.test(href)) {
            files.push({ name: name.replace(/\.(mp3|wav|ogg|m4a)$/i, ''), token: makeTokenStatic(absHref) });
        }
    }
    return { folders, files };
}
// Token tĩnh (module-level) — dùng chung map với instance? Đơn giản: hash, lưu vào shared map.
const _staticTokenMap = new Map();
function makeTokenStatic(absUrl) {
    const token = crypto.createHash('sha1').update(absUrl).digest('hex').slice(0, 24);
    _staticTokenMap.set(token, { url: absUrl, ts: Date.now() });
    return token;
}
function baseNameFromUrl(u) {
    try {
        const p = decodeURIComponent(new URL(u).pathname);
        return (p.split('/').pop() || 'Âm thanh').replace(/\.[a-z0-9]+$/i, '');
    } catch { return 'Âm thanh'; }
}
function decodeHtml(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
function splitTtsText(text, maxLen) {
    const out = [];
    // Tách theo câu trước, gộp tới maxLen
    const parts = text.split(/(?<=[.!?。！？\n])\s+/);
    let cur = '';
    for (const p of parts) {
        if ((cur + ' ' + p).trim().length <= maxLen) {
            cur = (cur ? cur + ' ' : '') + p;
        } else {
            if (cur) out.push(cur);
            if (p.length <= maxLen) { cur = p; }
            else {
                // Câu quá dài → cắt cứng theo từ
                let buf = '';
                for (const w of p.split(/\s+/)) {
                    if ((buf + ' ' + w).trim().length <= maxLen) buf = (buf ? buf + ' ' : '') + w;
                    else { if (buf) out.push(buf); buf = w; }
                }
                cur = buf;
            }
        }
    }
    if (cur) out.push(cur);
    return out.length ? out : [text.slice(0, maxLen)];
}

module.exports = { createSoundfxModule, _staticTokenMap };

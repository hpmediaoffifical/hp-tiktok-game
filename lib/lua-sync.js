// lib/lua-sync.js
// LUA Effects auto-sync — fetch manifest từ hpvn.media, cache vào %APPDATA%/hp-action-live/luas/
//
// Workflow:
//   1. App fetch manifest.json từ hpvn.media/luas/
//   2. Compare local cache vs manifest version → detect updates
//   3. User bấm "Download" → fetch .lua file → save to cache + write .meta.json
//   4. User add file from cache vào OBS Scripts (Tools → Scripts → +)
//   5. Auto-check mỗi N giây → notify user nếu có update
//
// Bảo mật: manifest URL hidden khỏi UI, chỉ admin (qua appConfig) đổi được.
// File validation: check size + check syntax "function" before save.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

class LuaSync {
  /**
   * @param {Object} opts
   * @param {string}  opts.cacheDir           Đường dẫn cache .lua files
   * @param {string}  opts.defaultManifestUrl URL manifest.json (default)
   * @param {Function}[opts.isLicensed]       Gate by license — default true
   * @param {Object}  [opts.logger]           Logger { log }
   * @param {number}  [opts.timeoutMs]        HTTP timeout (default 15s)
   * @param {number}  [opts.maxFileSize]      Max file size accept (default 5MB)
   */
  constructor(opts = {}) {
    // ★ SIMPLE MODE (mặc định bật): tên file gốc, không obfuscate, không decoy, folder visible
    //    Lý do: user feedback v1.3.0 — bảo mật nhiều layer làm sync cross-machine khó.
    //    Folder name "luas/" — dễ tìm, dễ nhớ.
    this.simpleMode = opts.simpleMode !== false;   // default true
    this.cacheDir = opts.cacheDir || path.join(
      process.env.APPDATA || '.',
      'hp-action-live',
      this.simpleMode ? 'luas' : '.cache'
    );
    this.manifestUrl = String(opts.defaultManifestUrl || '').trim();
    this.isLicensed = opts.isLicensed || (() => true);
    this.logger = opts.logger || console;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.maxFileSize = opts.maxFileSize || 5 * 1024 * 1024;   // 5MB hard cap

    // State
    this.cachedManifest = null;
    this.lastCheckAt = 0;
    this.lastError = null;
    this.autoCheckTimer = null;
    this.installId = null;   // ★ persist trong file .install-id để obfuscate filename

    // Simple emitter
    this._listeners = {};

    this._ensureCacheDir();
    this._ensureInstallId();
  }

  _ensureCacheDir() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        this.logger.log(`Created cache dir`);
        // Hide folder CHỈ KHI không simpleMode (security mode)
        if (!this.simpleMode) this._hideCacheFolder();
      }
    } catch (e) {
      this.logger.log(`CACHE DIR FAIL: ${e.message}`);
    }
  }

  // Apply Windows Hidden + System attributes (chỉ dùng khi simpleMode = false)
  _hideCacheFolder() {
    if (process.platform !== 'win32') return;
    try {
      const { spawn } = require('child_process');
      const proc = spawn('attrib', ['+H', '+S', this.cacheDir], { windowsHide: true });
      proc.on('error', () => {});
    } catch (_) {}
  }

  // ★ Generate stable install_id (persist trong .install-id file)
  _ensureInstallId() {
    const idPath = path.join(this.cacheDir, '.install-id');
    try {
      this.installId = fs.readFileSync(idPath, 'utf8').trim();
      if (!this.installId || this.installId.length < 16) throw new Error('Invalid id');
    } catch (_) {
      this.installId = crypto.randomBytes(16).toString('hex');
      try {
        fs.writeFileSync(idPath, this.installId);
        this.logger.log(`Generated new install_id`);
      } catch (e) {
        this.logger.log(`Write install_id FAIL: ${e.message}`);
      }
    }
  }

  // ★ Filename builder — simpleMode dùng tên gốc luaId, ngược lại obfuscate hash
  _obfuscatedName(luaId) {
    if (this.simpleMode) {
      return String(luaId).replace(/[^a-z0-9_-]/gi, '');   // tên gốc safe
    }
    if (!this.installId) this._ensureInstallId();
    const h = crypto.createHash('sha256')
      .update((this.installId || '') + ':' + String(luaId))
      .digest('hex');
    return h.slice(0, 10);
  }

  setManifestUrl(url) {
    this.manifestUrl = String(url || '').trim();
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => {
      try { fn(data); } catch (_) {}
    });
  }

  // ===== Fetch helper =====
  _fetch(url, redirectDepth = 0) {
    return new Promise((resolve, reject) => {
      if (redirectDepth > 4) return reject(new Error('Too many redirects'));
      let lib;
      try {
        lib = url.startsWith('https') ? https : http;
      } catch (_) {
        return reject(new Error('URL không hợp lệ'));
      }
      const req = lib.get(url, { timeout: this.timeoutMs, headers: { 'User-Agent': 'HP-Action-LIVE/LuaSync' } }, (res) => {
        // Follow 30x redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();   // drain
          return this._fetch(res.headers.location, redirectDepth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', c => {
          total += c.length;
          if (total > this.maxFileSize) {
            req.destroy();
            return reject(new Error(`File quá lớn (>${this.maxFileSize} bytes)`));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  // ===== Fetch manifest =====
  async fetchManifest() {
    if (!this.isLicensed()) {
      this.lastError = 'unlicensed';
      throw new Error('License chưa kích hoạt');
    }
    if (!this.manifestUrl) {
      this.lastError = 'no-manifest-url';
      throw new Error('Manifest URL trống');
    }
    let buf;
    try {
      buf = await this._fetch(this.manifestUrl);
    } catch (e) {
      this.lastError = e.message;
      throw new Error('Fetch manifest FAIL: ' + e.message);
    }
    let manifest;
    try {
      manifest = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      this.lastError = 'json-parse-error';
      throw new Error('Manifest JSON parse error: ' + e.message);
    }
    if (!manifest || !Array.isArray(manifest.luas)) {
      this.lastError = 'invalid-format';
      throw new Error('Manifest format không hợp lệ — thiếu "luas" array');
    }
    // Sanitize từng entry
    manifest.luas = manifest.luas.filter(l => l && typeof l === 'object' && l.id && l.url);
    this.cachedManifest = manifest;
    this.lastCheckAt = Date.now();
    this.lastError = null;
    this._emit('manifest', manifest);
    this.logger.log(`Manifest loaded — ${manifest.luas.length} LUAs`);
    return manifest;
  }

  // ===== Local state per LUA =====
  // ★ filename ĐÃ obfuscate — chỉ server biết mapping luaId ↔ filename
  getLocalState(luaId) {
    const safeId = String(luaId).replace(/[^a-z0-9_-]/gi, '');
    const obName = this._obfuscatedName(safeId);
    const filePath = path.join(this.cacheDir, `${obName}.lua`);
    const metaPath = path.join(this.cacheDir, `.${obName}.meta`);   // hidden meta (dot prefix)
    let exists = false, version = null, downloadedAt = null, size = 0;
    try {
      const st = fs.statSync(filePath);
      exists = true; size = st.size;
    } catch (_) {}
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      version = meta.version || null;
      downloadedAt = meta.downloadedAt || null;
    } catch (_) {}
    return { id: safeId, exists, version, downloadedAt, size, path: filePath, obName };
  }

  // ===== Status comparison =====
  // 'missing' (chưa tải), 'outdated' (có update), 'latest' (đã có bản mới), 'unknown' (chưa fetch manifest)
  getStatus(luaId) {
    if (!this.cachedManifest) return 'unknown';
    const entry = this.cachedManifest.luas.find(l => l.id === luaId);
    if (!entry) return 'orphan';
    const local = this.getLocalState(luaId);
    if (!local.exists) return 'missing';
    if (!local.version) return 'outdated';   // file tồn tại nhưng không có meta → cần update lại
    if (String(local.version) !== String(entry.version)) return 'outdated';
    return 'latest';
  }

  // ===== Download single LUA =====
  async downloadLua(luaId) {
    if (!this.isLicensed()) throw new Error('License chưa kích hoạt');
    if (!this.cachedManifest) {
      throw new Error('Manifest chưa load — bấm "Check updates" trước');
    }
    const entry = this.cachedManifest.luas.find(l => l.id === luaId);
    if (!entry) throw new Error(`LUA "${luaId}" không có trong manifest`);
    if (!entry.url) throw new Error(`LUA "${luaId}" thiếu URL trong manifest`);

    this._ensureCacheDir();
    let buf;
    try {
      buf = await this._fetch(entry.url);
    } catch (e) {
      throw new Error(`Fetch LUA "${luaId}" FAIL: ${e.message}`);
    }
    if (buf.length < 100) {
      throw new Error(`File quá nhỏ (${buf.length} bytes) — có thể không phải LUA hợp lệ`);
    }
    // Basic syntax check: must contain "function"
    let content = buf.toString('utf8');
    if (!content.includes('function')) {
      throw new Error('File không có syntax LUA (thiếu "function") — kiểm tra URL hosting');
    }

    const safeId = String(luaId).replace(/[^a-z0-9_-]/gi, '');
    const obName = this._obfuscatedName(safeId);

    // Chỉ STRIP COMMENTS + obfuscate prefix trong security mode (simpleMode = false)
    if (!this.simpleMode) {
      content = content.replace(/--\[\[[\s\S]*?\]\]/g, '');
      content = content.replace(/^[ \t]*--[^\r\n]*$/gm, '');
      content = content.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
      const escapedId = safeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prefixRe = new RegExp(`\\[${escapedId}\\]`, 'g');
      content = content.replace(prefixRe, `[fx-${obName}]`);
    }

    const finalBuf = Buffer.from(content, 'utf8');
    const filePath = path.join(this.cacheDir, `${obName}.lua`);
    const metaPath = path.join(this.cacheDir, `.${obName}.meta`);   // hidden meta
    const tmpPath = filePath + '.tmp';

    // Atomic write: write to .tmp → rename
    fs.writeFileSync(tmpPath, finalBuf);
    fs.renameSync(tmpPath, filePath);

    // Compute SHA256 for verification log
    const hash = crypto.createHash('sha256').update(finalBuf).digest('hex');

    const meta = {
      id: safeId,
      version: String(entry.version || 'unknown'),
      hotkey: String(entry.hotkey || ''),
      name: String(entry.name || ''),
      downloadedAt: Date.now(),
      size: finalBuf.length,
      origSize: buf.length,           // size trước khi strip
      sha256: hash,
      // NOTE: sourceUrl ghi vào meta (để debug) nhưng KHÔNG expose qua API tới client
      sourceUrl: entry.url
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    this.logger.log(`✓ Downloaded ${safeId} → ${obName}.lua v${entry.version} (${finalBuf.length} bytes)`);
    this._emit('downloaded', { id: safeId, version: entry.version, size: finalBuf.length, path: filePath });

    // Decoys chỉ generate trong security mode
    if (!this.simpleMode) {
      try { this._ensureDecoys(10); } catch (_) {}
    }

    return { ok: true, id: safeId, version: entry.version, path: filePath, size: finalBuf.length, hash: hash.slice(0, 16) };
  }

  // ★ DECOY GENERATION — tạo file LUA giả mạo cùng folder để đánh lạc hướng
  // Strategy: gen N decoy per real LUA. Tổng = ~50-100 file rác xen lẫn 4-8 file thật.
  // Anyone browsing cache dir sẽ thấy 100 file random hash, không biết file nào thật.
  _ensureDecoys(perRealCount = 10) {
    try {
      // Đếm số real files (file có .meta tương ứng) vs decoy files (không có .meta)
      const allFiles = fs.readdirSync(this.cacheDir);
      const luaFiles = allFiles.filter(f => /^[a-f0-9]{10}\.lua$/i.test(f));
      const realCount = luaFiles.filter(f => {
        const obName = f.replace(/\.lua$/, '');
        return fs.existsSync(path.join(this.cacheDir, `.${obName}.meta`));
      }).length;
      // Decoy = total - real
      const decoyCount = luaFiles.length - realCount;
      const targetDecoyCount = realCount * perRealCount;
      const need = Math.max(0, targetDecoyCount - decoyCount);
      if (need === 0) return;

      const decoyTemplates = [
        'local obs = obslua\nlocal cfg = { source = "" }\nfunction script_description() return "" end\nfunction script_properties() return obs.obs_properties_create() end\nfunction script_update(s) end\n',
        'local obs = obslua\nfunction script_load() end\nfunction script_unload() end\nfunction script_description() return "[placeholder]" end\n',
        'local obs = obslua\nlocal hk = obs.OBS_INVALID_HOTKEY_ID\nfunction script_load(s) hk = obs.obs_hotkey_register_frontend("_decoy_", "", function() end); local a = obs.obs_data_get_array(s, "_h"); obs.obs_hotkey_load(hk, a); obs.obs_data_array_release(a) end\nfunction script_save(s) local a = obs.obs_hotkey_save(hk); obs.obs_data_set_array(s, "_h", a); obs.obs_data_array_release(a) end\n',
        'local obs = obslua\nlocal function tick() end\nfunction script_description() return "" end\nfunction script_load() obs.timer_add(tick, 1000) end\nfunction script_unload() obs.timer_remove(tick) end\n',
        'local obs = obslua\nlocal _ = {}\nfor i = 1, 10 do _[i] = math.random() end\nfunction script_description() return tostring(_[1]) end\n',
      ];

      for (let i = 0; i < need; i++) {
        const fakeName = crypto.randomBytes(5).toString('hex') + '.lua';
        const fakePath = path.join(this.cacheDir, fakeName);
        // Tránh trùng tên thật
        if (fs.existsSync(fakePath)) continue;
        const tpl = decoyTemplates[Math.floor(Math.random() * decoyTemplates.length)];
        // Thêm random vars để mỗi file có hash khác nhau (anti-deduplication)
        const randSuffix = `\n-- ${crypto.randomBytes(8).toString('hex')}\n`;
        fs.writeFileSync(fakePath, tpl + randSuffix);
      }
      this.logger.log(`Generated ${need} decoy files (target: ${targetDecoyCount}, real: ${realCount})`);
    } catch (e) {
      this.logger.log(`Decoy gen FAIL: ${e.message}`);
    }
  }

  // ===== Download all LUAs trong manifest =====
  async downloadAll() {
    if (!this.cachedManifest) await this.fetchManifest();
    const results = [];
    for (const entry of this.cachedManifest.luas) {
      try {
        const r = await this.downloadLua(entry.id);
        results.push(r);
      } catch (e) {
        results.push({ ok: false, id: entry.id, error: e.message });
      }
    }
    return results;
  }

  // ===== Auto-check loop =====
  startAutoCheck(intervalSec) {
    this.stopAutoCheck();
    if (!intervalSec || intervalSec < 30) {
      this.logger.log('auto-check disabled (interval < 30s)');
      return;
    }
    this.autoCheckTimer = setInterval(async () => {
      if (!this.isLicensed()) return;
      try {
        const prevVersions = (this.cachedManifest?.luas || []).reduce((acc, l) => {
          acc[l.id] = l.version; return acc;
        }, {});
        await this.fetchManifest();
        const newVersions = (this.cachedManifest?.luas || []).reduce((acc, l) => {
          acc[l.id] = l.version; return acc;
        }, {});
        const updates = [];
        for (const id of Object.keys(newVersions)) {
          // Updated nếu version trong manifest đổi VÀ local đã có file (đang dùng)
          const local = this.getLocalState(id);
          if (local.exists && this.getStatus(id) === 'outdated') {
            updates.push({ id, oldVersion: prevVersions[id], newVersion: newVersions[id] });
          }
        }
        if (updates.length > 0) {
          this.logger.log(`📢 Updates available: ${updates.map(u => u.id).join(', ')}`);
          this._emit('updates_available', updates);
        }
      } catch (e) {
        this.logger.log(`auto-check FAIL: ${e.message}`);
      }
    }, intervalSec * 1000);
    this.logger.log(`auto-check started: every ${intervalSec}s`);
  }

  stopAutoCheck() {
    if (this.autoCheckTimer) {
      clearInterval(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
  }

  // ===== Full state for API/UI (URL + localPath HIDDEN — bảo mật!) =====
  getFullState() {
    const luas = (this.cachedManifest?.luas || []).map(entry => {
      const local = this.getLocalState(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        description: entry.description,
        version: entry.version,
        hotkey: entry.hotkey,
        durationMs: entry.duration_ms,
        // url: HIDDEN — chỉ server biết
        // localPath: HIDDEN — bảo mật, không expose ra clipboard
        status: this.getStatus(entry.id),
        localVersion: local.version,
        downloadedAt: local.downloadedAt,
        localSize: local.size,
        cached: local.exists,      // chỉ trả boolean
        obfuscatedName: local.obName ? (local.obName + '.lua') : null   // tên file ẨN trên disk
        // → hiển thị nhỏ trên UI để user biết tên file cần tìm khi add vào OBS
      };
    });
    return {
      manifestUrlConfigured: !!this.manifestUrl,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      // cacheDir: HIDDEN — không expose đường dẫn
      luaCount: luas.length,
      luas
    };
  }

  // Get path internally (server-side only, không expose qua API)
  getLocalPath(luaId) {
    const local = this.getLocalState(luaId);
    return local.path;
  }
}

module.exports = { LuaSync };

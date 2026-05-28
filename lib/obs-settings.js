// lib/obs-settings.js
// OBS Scene Collection JSON manipulator — extract/inject script settings
//
// Path OBS scenes: %APPDATA%\obs-studio\basic\scenes\<name>.json
// Structure:
//   {
//     "current_scene": "...",
//     "modules": {
//       "scripts-tool": [
//         { "path": "C:/.../a8f3b2c1.lua", "settings": {...} },
//         ...
//       ]
//     },
//     ...
//   }
//
// Safety:
//  - Backup .json → .json.bak.<timestamp> trước khi modify
//  - Atomic write: ghi .tmp → rename
//  - Validate JSON parse được sau write
//  - Reject nếu OBS WS đang connect (OBS đang chạy)

const fs = require('fs');
const path = require('path');

// ★ Signature keys per known LUA id — dùng để fingerprint khi file path khác (vd user add file gốc)
// Mỗi LUA có settings keys riêng → match script entry có ≥2 keys khớp = chính xác
const LUA_SIGNATURE_KEYS = {
  'mario':     ['idol_a_x', 'idol_a_y', 'idol_a_scale', 'map_a_x', 'mushroom_enabled', 'dur_ab_ms', 'final_hold_ms', 'hold_a_ms'],
  'chao_dap':  ['pan_source', 'pan_to_impact_ms', 'squash_scale_y_pct', 'leaf_fall_distance_px', 'leaf_fall_target_y_px'],
  'ho_den':    ['return_left_source', 'return_right_source', 'stand_duration_ms', 'fall_duration_ms', 'gone_duration_ms'],
  'lo_xo':     ['sit_x', 'sit_y', 'sit_scale_pct', 'enter_duration_ms', 'sit_duration_ms', 'launch_duration_ms'],
  'chay':      ['shrink_pct', 'compress_y_pct', 'bob_amp_px', 'sway_amp_px', 'lower_offset_px'],
  'dap_bua':   ['hole_left_source', 'hole_right_source', 'pop_count', 'hit_total_ms', 'dizzy_duration_ms'],
  'may_giat':  ['drum_source', 'drum_x_px', 'drum_y_px', 'spin_duration_ms'],
  'chao_fall': ['pan_source', 'pan_fall_duration_ms']
};

class OBSSettings {
  /**
   * @param {Object} opts
   * @param {string}   [opts.scenesDir]  Đường dẫn folder scenes (default: %APPDATA%\obs-studio\basic\scenes)
   * @param {Object}   [opts.logger]
   */
  constructor(opts = {}) {
    this.scenesDir = opts.scenesDir || path.join(
      process.env.APPDATA || '',
      'obs-studio', 'basic', 'scenes'
    );
    this.logger = opts.logger || console;
  }

  // ===== Detect scene collections =====
  listSceneCollections() {
    if (!fs.existsSync(this.scenesDir)) {
      throw new Error(`Không tìm thấy folder OBS scenes: ${this.scenesDir}`);
    }
    const files = fs.readdirSync(this.scenesDir)
      .filter(f => f.toLowerCase().endsWith('.json'))
      .filter(f => !f.includes('.bak'))   // skip backup files
      .map(f => {
        const full = path.join(this.scenesDir, f);
        try {
          const st = fs.statSync(full);
          // Try parse name (without .json)
          const name = f.replace(/\.json$/i, '');
          return {
            name,
            filename: f,
            path: full,
            size: st.size,
            modifiedAt: st.mtimeMs,
            modifiedAtStr: new Date(st.mtimeMs).toISOString()
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);   // mới nhất đầu
    return files;
  }

  // Đọc + parse JSON safely
  _readJson(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON parse fail ${path.basename(filePath)}: ${e.message}`);
    }
  }

  // Backup file → .bak.<timestamp>
  _backup(filePath) {
    const ts = Date.now();
    const bakPath = `${filePath}.bak.${ts}`;
    fs.copyFileSync(filePath, bakPath);
    // Cleanup old backups (giữ 5 mới nhất)
    try {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const baks = fs.readdirSync(dir)
        .filter(f => f.startsWith(base + '.bak.'))
        .map(f => ({ name: f, ts: parseInt(f.split('.bak.')[1], 10) }))
        .filter(x => !isNaN(x.ts))
        .sort((a, b) => b.ts - a.ts);
      for (const bak of baks.slice(5)) {
        try { fs.unlinkSync(path.join(dir, bak.name)); } catch (_) {}
      }
    } catch (_) {}
    return bakPath;
  }

  // Atomic write JSON
  _writeJsonAtomic(filePath, obj) {
    const json = JSON.stringify(obj, null, 4);   // OBS dùng 4-space indent
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf8');
    // Validate: parse lại
    try {
      const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      if (!parsed) throw new Error('Empty after write');
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw new Error(`Validate JSON sau write FAIL: ${e.message}`);
    }
    fs.renameSync(tmpPath, filePath);
  }

  // ===== List scripts in collection =====
  listScripts(sceneCollectionFile) {
    const filePath = path.join(this.scenesDir, sceneCollectionFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy file: ${sceneCollectionFile}`);
    }
    const data = this._readJson(filePath);
    const scripts = (data.modules && data.modules['scripts-tool']) || [];
    return scripts.map((s, idx) => ({
      idx,
      path: s.path || '',
      filename: (s.path || '').split(/[\\/]/).pop(),
      settingsKeys: Object.keys(s.settings || {}),
      settingsCount: Object.keys(s.settings || {}).length
    }));
  }

  // ★ Multi-strategy match — trả về { match, strategy }
  // Thứ tự: 1) obfuscated filename → 2) original filename (luaId.lua) → 3) signature keys
  _findScript(scripts, obfuscatedFilename, luaId) {
    const obfFile = String(obfuscatedFilename || '').toLowerCase();
    const origFile = String(luaId || '').toLowerCase() + '.lua';

    // Strategy 1: match bằng obfuscated filename (path ending)
    if (obfFile) {
      const m = scripts.find(s => {
        const p = String(s.path || '').toLowerCase().replace(/\\/g, '/');
        return p.endsWith('/' + obfFile) || p.endsWith(obfFile);
      });
      if (m) return { match: m, strategy: 'obfuscated', matchedFile: (m.path || '').split(/[\\/]/).pop() };
    }

    // Strategy 2: match bằng original filename (vd user add "mario.lua")
    if (luaId) {
      const m = scripts.find(s => {
        const p = String(s.path || '').toLowerCase().replace(/\\/g, '/');
        return p.endsWith('/' + origFile) || p.endsWith(origFile);
      });
      if (m) return { match: m, strategy: 'original', matchedFile: (m.path || '').split(/[\\/]/).pop() };
    }

    // Strategy 3: match bằng signature keys trong settings
    const sigKeys = LUA_SIGNATURE_KEYS[luaId];
    if (sigKeys && sigKeys.length > 0) {
      let bestMatch = null, bestScore = 0;
      for (const s of scripts) {
        const keys = Object.keys(s.settings || {});
        const matched = sigKeys.filter(k => keys.includes(k)).length;
        if (matched >= 2 && matched > bestScore) {
          bestMatch = s;
          bestScore = matched;
        }
      }
      if (bestMatch) return {
        match: bestMatch,
        strategy: 'signature',
        matchedFile: (bestMatch.path || '').split(/[\\/]/).pop(),
        signatureMatched: bestScore
      };
    }

    return null;
  }

  // ===== Extract settings for 1 LUA =====
  // Multi-strategy: obfuscated → original (luaId.lua) → signature keys
  extractSettings(sceneCollectionFile, obfuscatedFilename, luaId) {
    const filePath = path.join(this.scenesDir, sceneCollectionFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy scene collection: ${sceneCollectionFile}`);
    }
    const data = this._readJson(filePath);
    const scripts = (data.modules && data.modules['scripts-tool']) || [];
    const result = this._findScript(scripts, obfuscatedFilename, luaId);
    if (!result) {
      return {
        found: false,
        message: `Không tìm thấy script "${obfuscatedFilename}" (${luaId || '?'}) trong "${sceneCollectionFile}". Đã add vào OBS chưa?`,
        availableScripts: scripts.map(s => (s.path || '').split(/[\\/]/).pop()),
        triedStrategies: ['obfuscated:' + (obfuscatedFilename || '?'), 'original:' + (luaId ? luaId + '.lua' : '?'), 'signature:' + (LUA_SIGNATURE_KEYS[luaId] ? LUA_SIGNATURE_KEYS[luaId].length + ' keys' : 'n/a')]
      };
    }
    return {
      found: true,
      path: result.match.path,
      settings: result.match.settings || {},
      settingsCount: Object.keys(result.match.settings || {}).length,
      strategy: result.strategy,
      matchedFile: result.matchedFile,
      signatureMatched: result.signatureMatched || null
    };
  }

  // ===== Apply settings to OBS scene collection =====
  // Multi-strategy match (giống extract). Nếu không có entry → tạo mới với newScriptPath.
  applySettings(sceneCollectionFile, obfuscatedFilename, newSettings, newScriptPath, luaId) {
    const filePath = path.join(this.scenesDir, sceneCollectionFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy scene collection: ${sceneCollectionFile}`);
    }
    const data = this._readJson(filePath);
    if (!data.modules) data.modules = {};
    if (!Array.isArray(data.modules['scripts-tool'])) data.modules['scripts-tool'] = [];

    const scripts = data.modules['scripts-tool'];

    // Multi-strategy find
    const found = this._findScript(scripts, obfuscatedFilename, luaId);
    let idx, matchStrategy;
    if (found) {
      idx = scripts.indexOf(found.match);
      matchStrategy = found.strategy;
    } else {
      idx = -1;
      matchStrategy = 'created';
    }

    const action = idx >= 0 ? 'updated' : 'created';
    if (idx < 0) {
      // Tạo mới entry
      if (!newScriptPath) {
        throw new Error('Script chưa có trong scene collection và không cung cấp newScriptPath để tạo mới');
      }
      scripts.push({
        path: newScriptPath.replace(/\\/g, '/'),
        settings: newSettings || {}
      });
      idx = scripts.length - 1;
    } else {
      // Update settings (giữ nguyên path)
      scripts[idx].settings = newSettings || {};
    }

    // Backup + atomic write
    const bakPath = this._backup(filePath);
    try {
      this._writeJsonAtomic(filePath, data);
    } catch (e) {
      // Rollback: restore từ backup
      try {
        fs.copyFileSync(bakPath, filePath);
      } catch (rollbackErr) {
        throw new Error(`Write FAIL + rollback FAIL: ${e.message} | rollback: ${rollbackErr.message}`);
      }
      throw new Error(`Write FAIL (đã rollback từ backup): ${e.message}`);
    }

    return {
      ok: true,
      action,
      matchStrategy,
      scriptPath: scripts[idx].path,
      backupPath: bakPath,
      settingsCount: Object.keys(newSettings || {}).length
    };
  }
}

module.exports = { OBSSettings };

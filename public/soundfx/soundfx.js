/* HP Media SoundFX — client logic
 * Tabs + grid + favorites drag-drop + hotkeys + cloud browser + Google TTS.
 * White theme mặc định. Lưu config qua /api/soundfx/config.
 */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const API = '/api/soundfx';
const FAV_TAB = '__fav__';

let LIB = null;                 // { tabs, sounds, favorites, settings, hasLocal }
let activeTab = FAV_TAB;
let audio = $('#sfx-audio');
let mixPool = [];               // các audio đang phát khi bật "trộn âm thanh"
let lastPlayedId = null;
let ctxTargetId = null;
let hkTargetId = null;
let hkCapture = null;           // {ctrl,shift,alt,code,label}
let cloudPath = '';
let saveTimer = null;

// ---------- Config persistence ----------
function queueSave(patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch(API + '/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        }).catch(() => {});
    }, 350);
}
function saveSettings() { queueSave({ settings: LIB.settings }); }
function saveFavorites() { queueSave({ favorites: LIB.favorites }); }

// ---------- Theme / settings apply ----------
function applySettings() {
    const s = LIB.settings;
    document.body.classList.toggle('theme-dark', !!s.dark);
    document.documentElement.style.setProperty('--bg', s.bgColor || '#ffffff');
    document.documentElement.style.setProperty('--accent', s.accent || '#2563eb');
    document.documentElement.style.setProperty('--fs', (s.fontSize || 14) + 'px');
    const sc = (s.scale || 1);
    document.querySelector('.sfx-root').style.transform = sc === 1 ? '' : `scale(${sc})`;
    document.querySelector('.sfx-root').style.width = sc === 1 ? '' : (100 / sc) + 'vw';
    document.querySelector('.sfx-root').style.height = sc === 1 ? '' : (100 / sc) + 'vh';
    audio.volume = (s.volume ?? 90) / 100;
    $('#sfx-volume').value = s.volume ?? 90;
    $('#sfx-vol-val').textContent = s.volume ?? 90;
    // settings modal inputs
    $('#set-useHotkeys').checked = s.useHotkeys !== false;
    const gh = document.getElementById('set-globalHotkeys'); if (gh) gh.checked = s.globalHotkeys !== false;
    $('#set-showHotkeys').checked = s.showHotkeys !== false;
    if (typeof refreshHkSettingLabels === 'function') refreshHkSettingLabels();
    $('#set-mix').checked = !!s.mix;
    $('#set-dark').checked = !!s.dark;
    $('#set-bg').value = s.bgColor || '#ffffff';
    $('#set-accent').value = s.accent || '#2563eb';
    $('#set-fontSize').value = s.fontSize || 14;
    $('#set-fs-val').textContent = s.fontSize || 14;
    $('#set-scale').value = Math.round((s.scale || 1) * 100);
    $('#set-scale-val').textContent = Math.round((s.scale || 1) * 100);
    $('#sfx-pin-btn').classList.toggle('active', s.win?.alwaysOnTop !== false);
}

// ---------- Load library ----------
async function loadLib() {
    const r = await fetch(API + '/library');
    LIB = await r.json();
    LIB.settings = LIB.settings || {};
    applySettings();
    renderTabs();
    if (!LIB.favorites.length && LIB.tabs.length) activeTab = LIB.tabs[0].id;
    selectTab(activeTab);
    pushHotkeysToNative();
    // Nhận sự kiện phím tắt TOÀN CỤC từ Electron main
    if (window.sfxNative?.onHotkey) {
        window.sfxNative.onHotkey(d => {
            if (!d) return;
            if (d.action === 'play') { if (lastPlayedId) playSound(lastPlayedId); }
            else if (d.action === 'stop') stopAll();
            else if (d.soundId && LIB.sounds[d.soundId]) playSound(d.soundId);
        });
    }
}

// ---------- Tabs ----------
function tabSoundIds(tabId) {
    if (tabId === FAV_TAB) return LIB.favorites.filter(id => LIB.sounds[id]);
    const inTab = Object.values(LIB.sounds).filter(s => s.tab === tabId).map(s => s.id);
    const ord = (LIB.order && LIB.order[tabId]) || [];
    // Theo thứ tự đã lưu trước, phần còn lại (mới thêm) nối sau
    const ordered = ord.filter(id => inTab.includes(id));
    const rest = inTab.filter(id => !ordered.includes(id));
    return ordered.concat(rest);
}
function saveOrder(tabId) {
    LIB.order = LIB.order || {};
    LIB.order[tabId] = tabSoundIds(tabId);
    queueSave({ order: { [tabId]: LIB.order[tabId] } });
}
function renderTabs() {
    const nav = $('#sfx-tabs');
    nav.innerHTML = '';
    const mk = (id, label, icon) => {
        const b = document.createElement('button');
        b.className = 'sfx-tab' + (id === activeTab ? ' active' : '');
        b.dataset.tab = id;
        const cnt = tabSoundIds(id).length;
        b.innerHTML = `${icon ? icon + ' ' : ''}${label} <span class="cnt">${cnt}</span>`;
        b.addEventListener('click', () => selectTab(id));
        nav.appendChild(b);
    };
    mk(FAV_TAB, 'YÊU THÍCH', '⭐');
    for (const t of LIB.tabs) mk(t.id, t.name, '');
}
function selectTab(id) {
    activeTab = id;
    $$('.sfx-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    $('#sfx-search').value = '';
    renderGrid();
}

// ---------- Grid ----------
function hotkeyLabel(hk) {
    if (!hk) return '';
    const p = [];
    if (hk.ctrl) p.push('Ctrl');
    if (hk.shift) p.push('Shift');
    if (hk.alt) p.push('Alt');
    p.push(keyName(hk.code));
    return p.join('+');
}
function keyName(code) {
    // code is keyCode number
    if (code >= 48 && code <= 57) return String(code - 48);          // 0-9
    if (code >= 65 && code <= 90) return String.fromCharCode(code);   // A-Z
    if (code >= 96 && code <= 105) return 'Num' + (code - 96);
    if (code >= 112 && code <= 123) return 'F' + (code - 111);
    const map = { 32: 'Space', 13: 'Enter', 27: 'Esc', 37: '←', 38: '↑', 39: '→', 40: '↓' };
    return map[code] || ('#' + code);
}
// {ctrl,shift,alt,code} → Electron accelerator (vd "Ctrl+Shift+A", "Alt+1")
function toAccel(hk) {
    if (!hk || !hk.code) return null;
    const p = [];
    if (hk.ctrl) p.push('Ctrl');
    if (hk.alt) p.push('Alt');
    if (hk.shift) p.push('Shift');
    const c = hk.code;
    let key;
    if (c >= 48 && c <= 57) key = String(c - 48);
    else if (c >= 65 && c <= 90) key = String.fromCharCode(c);
    else if (c >= 96 && c <= 105) key = 'num' + (c - 96);
    else if (c >= 112 && c <= 123) key = 'F' + (c - 111);
    else key = ({ 32: 'Space', 13: 'Return', 27: 'Escape', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 188: ',', 190: '.', 191: '/', 186: ';' })[c];
    if (!key) return null;
    p.push(key);
    return p.join('+');
}
// CHỈ combo có Ctrl HOẶC Alt mới an toàn để đăng ký TOÀN CỤC.
// Phím đơn (a, 1, F2) hoặc chỉ Shift sẽ CHIẾM phím đó toàn hệ thống → KHÔNG gõ chữ được.
// → phím đơn chỉ hoạt động khi cửa sổ SoundFX đang focus (in-window), không đăng ký global.
function isGlobalSafe(hk) {
    return !!(hk && hk.code && (hk.ctrl || hk.alt));
}
// Đẩy phím tắt lên Electron main — CHỈ combo Ctrl/Alt (an toàn, không chặn gõ chữ)
function pushHotkeysToNative() {
    if (!window.sfxNative?.registerHotkeys) return;
    const enabled = LIB.settings.useHotkeys !== false && LIB.settings.globalHotkeys !== false;
    const sounds = [];
    for (const s of Object.values(LIB.sounds)) {
        if (!isGlobalSafe(s.hotkey)) continue;          // phím đơn → KHÔNG global
        const a = toAccel(s.hotkey);
        if (a) sounds.push({ accel: a, soundId: s.id });
    }
    window.sfxNative.registerHotkeys({
        enabled,
        sounds,
        play: isGlobalSafe(LIB.settings.hotkeyPlay) ? toAccel(LIB.settings.hotkeyPlay) : null,
        stop: isGlobalSafe(LIB.settings.hotkeyStop) ? toAccel(LIB.settings.hotkeyStop) : null
    });
}
function renderGrid() {
    const grid = $('#sfx-grid');
    const empty = $('#sfx-empty');
    grid.innerHTML = '';
    let ids = tabSoundIds(activeTab);
    const q = $('#sfx-search').value.trim().toLowerCase();
    if (q) ids = ids.filter(id => (LIB.sounds[id].name || '').toLowerCase().includes(q));
    empty.hidden = true;
    const isFavTab = activeTab === FAV_TAB;
    for (const id of ids) {
        const s = LIB.sounds[id];
        const cell = document.createElement('div');
        cell.className = 'sfx-cell'
            + (LIB.favorites.includes(id) ? ' fav' : '')
            + (s.source === 'cloud' ? ' cloud' : '')
            + (lastPlayedId === id ? ' playing' : '');
        cell.dataset.id = id;
        cell.title = s.name;
        const hk = (LIB.settings.showHotkeys !== false && s.hotkey) ? `<span class="hk">${hotkeyLabel(s.hotkey)}</span>` : '';
        cell.innerHTML = `<span class="lbl">${escapeHtml(s.name)}</span>${hk}`;
        cell.addEventListener('click', () => playSound(id));
        cell.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(e, id); });
        // Kéo-thả sắp xếp MỌI card (fav tab → reorderFav; tab thật → reorder theo tab)
        cell.draggable = true;
        cell.addEventListener('dragstart', e => {
            cell.classList.add('dragging');
            e.dataTransfer.setData('text/sfx-id', id);
            e.dataTransfer.effectAllowed = 'move';
        });
        cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drop-target'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
        cell.addEventListener('drop', e => {
            e.preventDefault(); cell.classList.remove('drop-target');
            const from = e.dataTransfer.getData('text/sfx-id');
            if (from && from !== id) {
                if (isFavTab) reorderFav(from, id);
                else reorderInTab(activeTab, from, id);
            } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
                handleDroppedFiles(e.dataTransfer.files, isFavTab ? (LIB.tabs[0]?.id || 'tab1') : activeTab);
            }
        });
        grid.appendChild(cell);
    }
    // ➕ Pad ô trống "thêm âm thanh" cho đủ 3×8 (24) — tab thật, không phải Yêu thích/search
    if (!isFavTab && !q) {
        const target = Math.max(24, Math.ceil(ids.length / 3) * 3);
        for (let i = ids.length; i < target; i++) {
            const add = document.createElement('div');
            add.className = 'sfx-cell sfx-add';
            add.innerHTML = '<span class="sfx-add-plus">＋</span>';
            add.title = 'Bấm để thêm — hoặc kéo-thả file nhạc vào đây';
            add.addEventListener('click', e => { e.stopPropagation(); openAddMenu(e, activeTab); });
            add.addEventListener('dragover', e => { e.preventDefault(); add.classList.add('drop-target'); });
            add.addEventListener('dragleave', () => add.classList.remove('drop-target'));
            add.addEventListener('drop', e => {
                e.preventDefault(); add.classList.remove('drop-target');
                const from = e.dataTransfer.getData('text/sfx-id');
                if (from && LIB.sounds[from]) moveSoundToTab(from, activeTab);
                else if (e.dataTransfer.files && e.dataTransfer.files.length)
                    handleDroppedFiles(e.dataTransfer.files, activeTab);
            });
            grid.appendChild(add);
        }
    } else if (isFavTab && !ids.length) {
        empty.hidden = false;
    }
}
// Sắp xếp lại trong tab thật
function reorderInTab(tab, fromId, toId) {
    const arr = tabSoundIds(tab);
    const fi = arr.indexOf(fromId), ti = arr.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    arr.splice(fi, 1);
    arr.splice(arr.indexOf(toId), 0, fromId);
    LIB.order = LIB.order || {}; LIB.order[tab] = arr;
    queueSave({ order: { [tab]: arr } });
    renderGrid();
}
// Chuyển sound sang tab khác (kéo card thả lên ô ＋ của tab đang xem)
function moveSoundToTab(id, tab) {
    if (!LIB.sounds[id]) return;
    LIB.sounds[id].tab = tab;
    fetch(API + '/sound/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, tab })
    }).then(() => reloadLib()).then(() => toast('↔ Đã chuyển sang tab này', 'ok')).catch(() => {});
}
// Kéo-thả file mp3 từ ngoài máy vào → thêm
async function handleDroppedFiles(fileList, tab) {
    const files = [...fileList].filter(f => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
    if (!files.length) { toast('Chỉ nhận file âm thanh (mp3/wav/ogg...)', 'err'); return; }
    let ok = 0;
    for (const f of files) {
        // Electron: File có .path tuyệt đối
        const ap = f.path || (window.sfxNative && f.name);
        if (!f.path) { toast('Kéo-thả file chỉ chạy trong app (Electron)', 'err'); break; }
        const nm = f.name.replace(/\.[a-z0-9]+$/i, '');
        try {
            const r = await fetch(API + '/sound/add', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tab, source: 'localpath', localPath: f.path, name: nm })
            });
            if ((await r.json()).ok) ok++;
        } catch (e) {}
    }
    if (ok) { toast('➕ Đã thêm ' + ok + ' âm thanh', 'ok'); await reloadLib(); }
}

// Menu nhỏ chọn nguồn khi bấm ô trống ➕
function openAddMenu(e, tab) {
    closeCtx();
    const m = $('#sfx-ctx');
    m.innerHTML = `
        <button data-add="file">💻 Từ máy tính</button>
        <button data-add="cloud">☁️ Từ kho Cloud</button>`;
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(e.clientX, innerWidth - w - 8) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - h - 8) + 'px';
    m.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
        const how = b.dataset.add; m.hidden = true; restoreCtxButtons();
        if (how === 'file') await addFromFile(tab);
        else openCloud(false, null, tab);   // cloud add mode → tab
    }));
}
async function addFromFile(tab) {
    if (!window.sfxNative?.pickAudioFile) { toast('Chỉ chọn được file khi chạy trong app (Electron)', 'err'); return; }
    const f = await window.sfxNative.pickAudioFile();
    if (!f || !f.path) return;
    const r = await fetch(API + '/sound/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, source: 'localpath', localPath: f.path, name: f.name })
    });
    const j = await r.json();
    if (j.ok) { toast('➕ Đã thêm "' + j.name + '"', 'ok'); await reloadLib(); }
    else toast('Thêm lỗi: ' + (j.error || ''), 'err');
}
function restoreCtxButtons() {
    $('#sfx-ctx').innerHTML = `
        <button data-act="fav">⭐ <span id="ctx-fav-label">Thêm vào Yêu thích</span></button>
        <button data-act="hotkey">⌨️ Đặt phím tắt</button>
        <button data-act="clearhotkey">🚫 Xoá phím tắt</button>
        <button data-act="rename">✏️ Đổi tên</button>
        <button data-act="replace">🔁 Thay hiệu ứng từ Cloud</button>
        <button data-act="replacefile">💻 Thay bằng file máy</button>
        <button data-act="remove">🗑️ Xoá</button>
        <button data-act="preview">▶️ Nghe thử</button>`;
}
async function reloadLib() {
    const keepTab = activeTab;
    const r = await fetch(API + '/library'); LIB = await r.json();
    LIB.settings = LIB.settings || {};
    activeTab = keepTab;
    renderTabs(); renderGrid(); applySettings(); pushHotkeysToNative();
}
function reorderFav(fromId, toId) {
    if (fromId === toId) return;
    const arr = LIB.favorites.slice();
    const fi = arr.indexOf(fromId), ti = arr.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    arr.splice(fi, 1);
    arr.splice(arr.indexOf(toId), 0, fromId);
    LIB.favorites = arr;
    saveFavorites();
    renderGrid();
}

// ---------- Toast (hiển thị lỗi/trạng thái cho user thấy) ----------
let _toastTimer = null;
function toast(msg, kind) {
    let el = document.getElementById('sfx-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'sfx-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:70px;transform:translateX(-50%);' +
            'z-index:2000;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:700;' +
            'box-shadow:0 8px 28px rgba(0,0,0,.35);max-width:90vw;text-align:center;pointer-events:none;' +
            'transition:opacity .2s;white-space:pre-line';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'err' ? '#ef4444' : (kind === 'ok' ? '#16a34a' : '#1f2937');
    el.style.color = '#fff';
    el.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, kind === 'err' ? 6000 : 2500);
}

// ---------- Playback ----------
function srcFor(id) {
    // Server resolve mọi nguồn (local / localpath / cloud) — path/url ẩn hoàn toàn
    return API + '/audio/' + encodeURIComponent(id) + '?t=' + Date.now();
}
function playSound(id) {
    const s = LIB.sounds[id];
    if (!s) return;
    lastPlayedId = id;
    const url = srcFor(id);
    if (LIB.settings.mix) {
        const a = new Audio(url);
        a.volume = audio.volume;
        a.play().catch(err => toast('Không phát được: ' + (err.name || err.message), 'err'));
        a.addEventListener('error', () => toast('Lỗi tải âm thanh "' + s.name + '"', 'err'));
        mixPool.push(a);
        a.addEventListener('ended', () => { mixPool = mixPool.filter(x => x !== a); });
    } else {
        stopAll(false);
        audio.src = url;
        audio.play()
            .then(() => toast('▶ ' + s.name, 'ok'))
            .catch(err => toast('Không phát được "' + s.name + '"\n' + (err.name || '') + ': ' + (err.message || ''), 'err'));
    }
    $('#sfx-now').textContent = s.name;
    markPlaying(id);
}
function markPlaying(id) {
    $$('.sfx-cell').forEach(c => c.classList.toggle('playing', c.dataset.id === id));
}
function stopAll(clearLabel = true) {
    try { audio.pause(); audio.currentTime = 0; } catch (e) {}
    mixPool.forEach(a => { try { a.pause(); } catch (e) {} });
    mixPool = [];
    if (clearLabel) { $('#sfx-now').textContent = '— chưa phát —'; markPlaying(null); }
}
audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $('#sfx-progress-fill').style.width = pct + '%';
});
audio.addEventListener('ended', () => { $('#sfx-progress-fill').style.width = '0%'; markPlaying(null); });
audio.addEventListener('error', () => {
    const e = audio.error;
    const codes = { 1: 'ABORTED', 2: 'NETWORK (server/file lỗi)', 3: 'DECODE (codec mp3?)', 4: 'SRC_NOT_SUPPORTED (404/định dạng)' };
    if (e) toast('❌ Lỗi audio [' + e.code + ' ' + (codes[e.code] || '') + ']\n' + (audio.src.includes('/tts') ? 'TTS: Google có thể bị chặn ở mạng của bạn' : 'Kiểm tra file/đường dẫn'), 'err');
});

// ---------- Context menu ----------
function openCtx(e, id) {
    ctxTargetId = id;
    const ctx = $('#sfx-ctx');
    restoreCtxButtons();   // đảm bảo menu đúng (sau khi từng hiện add-menu)
    const favLbl = ctx.querySelector('#ctx-fav-label');
    if (favLbl) favLbl.textContent = LIB.favorites.includes(id) ? 'Xoá khỏi Yêu thích' : 'Thêm vào Yêu thích';
    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = Math.min(e.clientX, innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(e.clientY, innerHeight - h - 8) + 'px';
}
function closeCtx() { $('#sfx-ctx').hidden = true; ctxTargetId = null; }
document.addEventListener('click', e => {
    if (!$('#sfx-ctx').contains(e.target)) closeCtx();
});
$('#sfx-ctx').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act; const id = ctxTargetId;
    closeCtx();
    if (!id) return;
    if (act === 'fav') {
        const i = LIB.favorites.indexOf(id);
        if (i >= 0) LIB.favorites.splice(i, 1); else LIB.favorites.push(id);
        saveFavorites(); renderTabs(); renderGrid();
    } else if (act === 'hotkey') {
        openHotkeyModal(id);
    } else if (act === 'clearhotkey') {
        LIB.sounds[id].hotkey = null;
        queueSave({ hotkeys: { [id]: null } }); renderGrid(); pushHotkeysToNative();
    } else if (act === 'rename') {
        const nm = prompt('Đổi tên âm thanh:', LIB.sounds[id].name);
        if (nm && nm.trim()) {
            LIB.sounds[id].name = nm.trim();
            queueSave({ renames: { [id]: nm.trim() } });
            renderGrid();
        }
    } else if (act === 'replace') {
        openCloud(true, id);
    } else if (act === 'replacefile') {
        replaceFromFile(id);
    } else if (act === 'remove') {
        if (confirm('Xoá âm thanh "' + LIB.sounds[id].name + '"?')) {
            fetch(API + '/sound/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
                .then(() => reloadLib()).then(() => toast('🗑️ Đã xoá', 'ok'));
        }
    } else if (act === 'preview') {
        playSound(id);
    }
});
async function replaceFromFile(id) {
    if (!window.sfxNative?.pickAudioFile) { toast('Chỉ chọn file khi chạy trong app', 'err'); return; }
    const f = await window.sfxNative.pickAudioFile();
    if (!f || !f.path) return;
    const r = await fetch(API + '/sound/replace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, source: 'localpath', localPath: f.path, useFileName: false })
    });
    const j = await r.json();
    if (j.ok) { toast('🔁 Đã thay bằng file máy', 'ok'); await reloadLib(); }
    else toast('Thay lỗi: ' + (j.error || ''), 'err');
}

// ---------- Hotkey modal ----------
function openHotkeyModal(id) {
    hkTargetId = id;
    let label;
    if (id === '__play__') { hkCapture = LIB.settings.hotkeyPlay || null; label = '▶ Phát lại sound cuối'; }
    else if (id === '__stop__') { hkCapture = LIB.settings.hotkeyStop || null; label = '■ Dừng tất cả'; }
    else { hkCapture = LIB.sounds[id].hotkey || null; label = 'Âm thanh: ' + LIB.sounds[id].name; }
    $('#sfx-hk-target').textContent = label;
    $('#sfx-hk-display').textContent = hkCapture ? hotkeyLabel(hkCapture) : 'Bấm tổ hợp phím...';
    const sc = document.getElementById('sfx-hk-scope');
    if (sc) {
        if (!hkCapture) { sc.textContent = ''; }
        else if (isGlobalSafe(hkCapture)) { sc.textContent = '✅ Toàn cục — chạy mọi nơi, KHÔNG chặn gõ chữ'; sc.style.color = '#16a34a'; }
        else { sc.textContent = '⚠ Phím đơn — chỉ chạy khi cửa sổ này mở'; sc.style.color = '#d97706'; }
    }
    $('#sfx-hk').hidden = false;
}
function refreshHkSettingLabels() {
    const pl = document.getElementById('set-hk-play');
    const st = document.getElementById('set-hk-stop');
    if (pl) pl.textContent = LIB.settings.hotkeyPlay ? hotkeyLabel(LIB.settings.hotkeyPlay) : 'Chưa đặt';
    if (st) st.textContent = LIB.settings.hotkeyStop ? hotkeyLabel(LIB.settings.hotkeyStop) : 'Chưa đặt';
}
function closeHotkeyModal() { $('#sfx-hk').hidden = true; hkTargetId = null; hkCapture = null; }
window.addEventListener('keydown', e => {
    if (!$('#sfx-hk').hidden) {
        // capture mode
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        hkCapture = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.keyCode };
        $('#sfx-hk-display').textContent = hotkeyLabel(hkCapture);
        const hintEl = document.getElementById('sfx-hk-scope');
        if (hintEl) {
            if (isGlobalSafe(hkCapture)) {
                hintEl.textContent = '✅ Toàn cục — chạy mọi nơi, KHÔNG chặn gõ chữ';
                hintEl.style.color = '#16a34a';
            } else {
                hintEl.textContent = '⚠ Phím đơn — chỉ chạy khi cửa sổ này mở. Thêm Ctrl/Alt để dùng mọi nơi.';
                hintEl.style.color = '#d97706';
            }
        }
        return;
    }
    // Phím tắt khi cửa sổ ĐANG FOCUS.
    // - Đang gõ vào ô input/search/TTS → KHÔNG bắt (để gõ chữ bình thường)
    // - Combo Ctrl/Alt + đang bật global → Electron lo toàn cục, bỏ qua đây (tránh double)
    // - Phím đơn / chỉ Shift → CHỈ chạy in-window (không global, không chặn gõ ở app khác)
    if (!LIB || LIB.settings.useHotkeys === false) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    const electronGlobalOn = window.sfxNative?.registerHotkeys && LIB.settings.globalHotkeys !== false;
    const match = hk => hk && hk.code === e.keyCode && !!hk.ctrl === e.ctrlKey &&
        !!hk.shift === e.shiftKey && !!hk.alt === e.altKey;
    const handledByElectron = hk => electronGlobalOn && isGlobalSafe(hk);
    if (match(LIB.settings.hotkeyPlay) && !handledByElectron(LIB.settings.hotkeyPlay)) {
        e.preventDefault(); if (lastPlayedId) playSound(lastPlayedId); return;
    }
    if (match(LIB.settings.hotkeyStop) && !handledByElectron(LIB.settings.hotkeyStop)) {
        e.preventDefault(); stopAll(); return;
    }
    for (const s of Object.values(LIB.sounds)) {
        if (match(s.hotkey) && !handledByElectron(s.hotkey)) { e.preventDefault(); playSound(s.id); break; }
    }
});
$('#sfx-hk-close').addEventListener('click', closeHotkeyModal);
$('#sfx-hk-clear').addEventListener('click', () => { hkCapture = null; $('#sfx-hk-display').textContent = 'Bấm tổ hợp phím...'; });
$('#sfx-hk-save').addEventListener('click', () => {
    if (hkTargetId === '__play__') {
        LIB.settings.hotkeyPlay = hkCapture; saveSettings();
    } else if (hkTargetId === '__stop__') {
        LIB.settings.hotkeyStop = hkCapture; saveSettings();
    } else if (hkTargetId && LIB.sounds[hkTargetId]) {
        LIB.sounds[hkTargetId].hotkey = hkCapture;
        queueSave({ hotkeys: { [hkTargetId]: hkCapture } });
        renderGrid();
    }
    pushHotkeysToNative();
    refreshHkSettingLabels();
    closeHotkeyModal();
});

// ---------- Settings modal ----------
$('#sfx-settings-btn').addEventListener('click', () => $('#sfx-settings').hidden = false);
$('#sfx-settings-close').addEventListener('click', () => $('#sfx-settings').hidden = true);
$('#sfx-settings').addEventListener('click', e => { if (e.target.id === 'sfx-settings') $('#sfx-settings').hidden = true; });
function bindSetting(sel, key, transform) {
    $(sel).addEventListener('input', () => {
        const el = $(sel);
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (transform) v = transform(v);
        LIB.settings[key] = v;
        applySettings(); saveSettings();
    });
}
bindSetting('#set-useHotkeys', 'useHotkeys');
bindSetting('#set-globalHotkeys', 'globalHotkeys');
bindSetting('#set-showHotkeys', 'showHotkeys');
$('#set-useHotkeys')?.addEventListener('change', pushHotkeysToNative);
$('#set-globalHotkeys')?.addEventListener('change', pushHotkeysToNative);
$('#set-hk-play-btn')?.addEventListener('click', () => openHotkeyModal('__play__'));
$('#set-hk-stop-btn')?.addEventListener('click', () => openHotkeyModal('__stop__'));
bindSetting('#set-mix', 'mix');
bindSetting('#set-dark', 'dark');
bindSetting('#set-bg', 'bgColor');
bindSetting('#set-accent', 'accent');
bindSetting('#set-fontSize', 'fontSize', v => parseInt(v, 10));
bindSetting('#set-scale', 'scale', v => parseInt(v, 10) / 100);
$$('.sfx-swatch').forEach(b => b.addEventListener('click', () => {
    LIB.settings.bgColor = b.dataset.bg;
    LIB.settings.dark = (b.dataset.bg === '#0f1218');
    applySettings(); saveSettings();
}));
$('#set-showHotkeys').addEventListener('change', renderGrid);

// ---------- Volume / playback bar ----------
$('#sfx-volume').addEventListener('input', e => {
    LIB.settings.volume = parseInt(e.target.value, 10);
    audio.volume = LIB.settings.volume / 100;
    mixPool.forEach(a => a.volume = audio.volume);
    $('#sfx-vol-val').textContent = LIB.settings.volume;
    saveSettings();
});
let muted = false, preMuteVol = 90;
$('#sfx-mute').addEventListener('click', () => {
    muted = !muted;
    if (muted) { preMuteVol = LIB.settings.volume; LIB.settings.volume = 0; }
    else { LIB.settings.volume = preMuteVol; }
    audio.volume = LIB.settings.volume / 100;
    $('#sfx-volume').value = LIB.settings.volume;
    $('#sfx-vol-val').textContent = LIB.settings.volume;
    $('#sfx-mute').textContent = muted ? '🔇' : '🔊';
    saveSettings();
});
$('#sfx-play').addEventListener('click', () => { if (lastPlayedId) playSound(lastPlayedId); });
$('#sfx-stop').addEventListener('click', () => stopAll());
$('#sfx-pause').addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
});

// ---------- Search ----------
$('#sfx-search').addEventListener('input', renderGrid);

// ---------- TTS ----------
$('#sfx-tts-toggle').addEventListener('click', () => {
    const p = $('#sfx-tts-panel');
    p.hidden = !p.hidden;
    $('#sfx-tts-toggle').classList.toggle('active', !p.hidden);
});
$('#sfx-tts-speak').addEventListener('click', async () => {
    const text = $('#sfx-tts-text').value.trim();
    if (!text) return;
    const lang = $('#sfx-tts-lang').value;
    stopAll(false);
    const ttsUrl = API + '/tts?lang=' + encodeURIComponent(lang) + '&text=' + encodeURIComponent(text);
    toast('🗣️ Đang tạo giọng đọc...', 'info');
    // Fetch trước để biết server lấy được TTS từ Google không (chẩn đoán rõ ràng)
    try {
        const r = await fetch(ttsUrl);
        if (!r.ok) { toast('❌ TTS lỗi: server không lấy được giọng Google (HTTP ' + r.status + ').\nMạng của bạn có thể chặn translate.google.com', 'err'); return; }
        const blob = await r.blob();
        if (!blob.size) { toast('❌ TTS rỗng — Google không trả audio (mạng/khu vực chặn?)', 'err'); return; }
        audio.src = URL.createObjectURL(blob);
        audio.play()
            .then(() => toast('🗣️ Đang đọc...', 'ok'))
            .catch(err => toast('Không phát được TTS: ' + (err.name || err.message), 'err'));
        $('#sfx-now').textContent = '🗣️ ' + text.slice(0, 40);
    } catch (e) {
        toast('❌ TTS lỗi kết nối: ' + e.message, 'err');
    }
});
$('#sfx-tts-stop').addEventListener('click', () => stopAll());

// ---------- Cloud browser ----------
let cloudReplaceId = null;
let cloudAddTab = null;     // tab đích khi thêm mới từ Cloud
$('#sfx-cloud-btn').addEventListener('click', () => openCloud(false));
$('#sfx-cloud-close').addEventListener('click', () => $('#sfx-cloud').hidden = true);
$('#sfx-cloud-search').addEventListener('input', () => renderCloudFiles());
let cloudCacheFiles = [];
function openCloud(replaceMode, replaceId, addTab) {
    cloudReplaceId = replaceMode ? replaceId : null;
    cloudAddTab = (!replaceMode && addTab) ? addTab
        : (activeTab === FAV_TAB ? (LIB.tabs[0]?.id || 'tab1') : activeTab);
    $('#sfx-cloud').hidden = false;
    loadCloud('');
}
async function loadCloud(p) {
    cloudPath = p;
    $('#sfx-cloud-folders').innerHTML = '<div class="sfx-cloud-loading">Đang tải...</div>';
    $('#sfx-cloud-files').innerHTML = '';
    renderCloudNav();
    try {
        const r = await fetch(API + '/cloud/list?path=' + encodeURIComponent(p));
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'fail');
        renderCloudFolders(j.folders || []);
        cloudCacheFiles = j.files || [];
        renderCloudFiles();
    } catch (e) {
        $('#sfx-cloud-folders').innerHTML = '<div class="sfx-cloud-loading">Lỗi tải Cloud</div>';
    }
}
function renderCloudNav() {
    const nav = $('#sfx-cloud-nav');
    const parts = cloudPath ? cloudPath.split('/') : [];
    let acc = '';
    nav.innerHTML = '<a data-p="">🏠 Gốc</a>';
    parts.forEach((seg, i) => {
        acc = acc ? acc + '/' + seg : seg;
        nav.innerHTML += ' / <a data-p="' + encodeURIComponent(acc) + '">' + escapeHtml(decodeURIComponent(seg)) + '</a>';
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => loadCloud(decodeURIComponent(a.dataset.p || ''))));
}
function renderCloudFolders(folders) {
    const box = $('#sfx-cloud-folders');
    box.innerHTML = '';
    if (cloudPath) {
        const up = document.createElement('div');
        up.className = 'sfx-cloud-item';
        up.innerHTML = '<span class="cf-ic">⬆️</span><span class="cf-name">.. lên trên</span>';
        up.addEventListener('click', () => {
            const parts = cloudPath.split('/'); parts.pop();
            loadCloud(parts.join('/'));
        });
        box.appendChild(up);
    }
    for (const f of folders) {
        const d = document.createElement('div');
        d.className = 'sfx-cloud-item';
        d.innerHTML = '<span class="cf-ic">📁</span><span class="cf-name">' + escapeHtml(f.name) + '</span>';
        d.addEventListener('click', () => loadCloud(f.path));
        box.appendChild(d);
    }
    if (!folders.length && !cloudPath) box.innerHTML = '<div class="sfx-cloud-loading">(không có thư mục con)</div>';
}
function renderCloudFiles() {
    const box = $('#sfx-cloud-files');
    const q = $('#sfx-cloud-search').value.trim().toLowerCase();
    let files = cloudCacheFiles;
    if (q) files = files.filter(f => f.name.toLowerCase().includes(q));
    box.innerHTML = '';
    if (!files.length) { box.innerHTML = '<div class="sfx-cloud-loading">Không có file mp3</div>'; return; }
    for (const f of files) {
        const row = document.createElement('div');
        row.className = 'sfx-cloud-item';
        const streamUrl = API + '/cloud/stream/' + encodeURIComponent(f.token);
        row.innerHTML = `<span class="cf-ic">🎵</span>
            <span class="cf-name">${escapeHtml(f.name)}</span>
            <button class="cf-act cf-play">▶</button>
            <button class="cf-act cf-add">${cloudReplaceId ? '🔁 Thay' : '➕ Thêm'}</button>`;
        row.querySelector('.cf-play').addEventListener('click', ev => {
            ev.stopPropagation();
            stopAll(false); audio.src = streamUrl; audio.play().catch(() => {});
            $('#sfx-now').textContent = '☁ ' + f.name;
        });
        row.querySelector('.cf-add').addEventListener('click', ev => {
            ev.stopPropagation();
            addCloudSound(f);
        });
        box.appendChild(row);
    }
}
async function addCloudSound(f) {
    if (cloudReplaceId && LIB.sounds[cloudReplaceId]) {
        // 🔁 Thay nguồn — LƯU BỀN server-side (cloudUrl), regen token mỗi lần load
        const r = await fetch(API + '/sound/replace', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cloudReplaceId, source: 'cloud', cloudToken: f.token, useFileName: false })
        });
        const j = await r.json();
        cloudReplaceId = null;
        $('#sfx-cloud').hidden = true;
        if (j.ok) { toast('🔁 Đã thay từ Cloud', 'ok'); await reloadLib(); }
        else toast('Thay lỗi: ' + (j.error || ''), 'err');
        return;
    }
    // ➕ Thêm mới — LƯU BỀN. Ưu tiên tên file Cloud làm tên mặc định.
    const tab = cloudAddTab || (activeTab === FAV_TAB ? (LIB.tabs[0]?.id || 'tab1') : activeTab);
    const r = await fetch(API + '/sound/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, source: 'cloud', cloudToken: f.token, name: f.name })
    });
    const j = await r.json();
    if (j.ok) { toast('➕ Đã thêm "' + j.name + '"', 'ok'); $('#sfx-cloud').hidden = true; await reloadLib(); }
    else toast('Thêm lỗi: ' + (j.error || ''), 'err');
}

// ---------- Pin (always-on-top) — qua Electron nếu có ----------
$('#sfx-pin-btn').addEventListener('click', () => {
    const on = !$('#sfx-pin-btn').classList.contains('active');
    $('#sfx-pin-btn').classList.toggle('active', on);
    LIB.settings.win = LIB.settings.win || {};
    LIB.settings.win.alwaysOnTop = on;
    saveSettings();
    if (window.sfxNative?.setAlwaysOnTop) window.sfxNative.setAlwaysOnTop(on);
});
$('#sfx-close-btn').addEventListener('click', () => {
    if (window.sfxNative?.closeWindow) window.sfxNative.closeWindow();
    else window.close();
});

// ---------- Save window bounds ----------
window.addEventListener('beforeunload', () => {
    if (window.sfxNative?.getBounds) {
        const b = window.sfxNative.getBounds();
        if (b) { LIB.settings.win = Object.assign(LIB.settings.win || {}, b);
            navigator.sendBeacon?.(API + '/config', new Blob([JSON.stringify({ settings: LIB.settings })], { type: 'application/json' })); }
    }
});

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Chặn Electron mở/điều hướng khi thả file ra ngoài ô (giữ app, không navigate).
// Thả vào vùng lưới trống cũng thêm vào tab hiện tại.
window.addEventListener('dragover', e => { e.preventDefault(); }, false);
window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.target.closest && e.target.closest('.sfx-cell')) return;  // ô đã tự xử lý
    if (e.dataTransfer.files && e.dataTransfer.files.length && LIB) {
        const tab = (activeTab === FAV_TAB) ? (LIB.tabs[0]?.id || 'tab1') : activeTab;
        handleDroppedFiles(e.dataTransfer.files, tab);
    }
}, false);

// ---------- Init ----------
loadLib().catch(e => {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">Lỗi tải SoundFX: ' + e.message + '</div>';
});
})();

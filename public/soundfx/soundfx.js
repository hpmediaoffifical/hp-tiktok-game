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
    $('#set-showHotkeys').checked = s.showHotkeys !== false;
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
}

// ---------- Tabs ----------
function tabSoundIds(tabId) {
    if (tabId === FAV_TAB) return LIB.favorites.filter(id => LIB.sounds[id]);
    return Object.values(LIB.sounds).filter(s => s.tab === tabId).map(s => s.id);
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
function renderGrid() {
    const grid = $('#sfx-grid');
    const empty = $('#sfx-empty');
    grid.innerHTML = '';
    let ids = tabSoundIds(activeTab);
    const q = $('#sfx-search').value.trim().toLowerCase();
    if (q) ids = ids.filter(id => (LIB.sounds[id].name || '').toLowerCase().includes(q));
    if (!ids.length) { empty.hidden = false; return; }
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
        if (isFavTab) {
            cell.draggable = true;
            cell.addEventListener('dragstart', e => { cell.classList.add('dragging'); e.dataTransfer.setData('text/plain', id); });
            cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
            cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drop-target'); });
            cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
            cell.addEventListener('drop', e => {
                e.preventDefault(); cell.classList.remove('drop-target');
                const from = e.dataTransfer.getData('text/plain');
                reorderFav(from, id);
            });
        }
        grid.appendChild(cell);
    }
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

// ---------- Playback ----------
function srcFor(id) {
    const s = LIB.sounds[id];
    if (!s) return null;
    if (s.source === 'cloud') return API + '/cloud/stream/' + encodeURIComponent(s.token);
    return API + '/audio/' + encodeURIComponent(id);
}
function playSound(id) {
    const s = LIB.sounds[id];
    if (!s) return;
    lastPlayedId = id;
    const url = srcFor(id);
    if (LIB.settings.mix) {
        const a = new Audio(url);
        a.volume = audio.volume;
        a.play().catch(() => {});
        mixPool.push(a);
        a.addEventListener('ended', () => { mixPool = mixPool.filter(x => x !== a); });
    } else {
        stopAll(false);
        audio.src = url;
        audio.play().catch(() => {});
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

// ---------- Context menu ----------
function openCtx(e, id) {
    ctxTargetId = id;
    const ctx = $('#sfx-ctx');
    $('#ctx-fav-label').textContent = LIB.favorites.includes(id) ? 'Xoá khỏi Yêu thích' : 'Thêm vào Yêu thích';
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
        queueSave({ hotkeys: { [id]: null } }); renderGrid();
    } else if (act === 'rename') {
        const nm = prompt('Đổi tên âm thanh:', LIB.sounds[id].name);
        if (nm && nm.trim()) {
            LIB.sounds[id].name = nm.trim();
            queueSave({ renames: { [id]: nm.trim() } });
            renderGrid();
        }
    } else if (act === 'replace') {
        openCloud(true, id);
    } else if (act === 'preview') {
        playSound(id);
    }
});

// ---------- Hotkey modal ----------
function openHotkeyModal(id) {
    hkTargetId = id; hkCapture = LIB.sounds[id].hotkey || null;
    $('#sfx-hk-target').textContent = 'Âm thanh: ' + LIB.sounds[id].name;
    $('#sfx-hk-display').textContent = hkCapture ? hotkeyLabel(hkCapture) : 'Bấm tổ hợp phím...';
    $('#sfx-hk').hidden = false;
}
function closeHotkeyModal() { $('#sfx-hk').hidden = true; hkTargetId = null; hkCapture = null; }
window.addEventListener('keydown', e => {
    if (!$('#sfx-hk').hidden) {
        // capture mode
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        hkCapture = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.keyCode };
        $('#sfx-hk-display').textContent = hotkeyLabel(hkCapture);
        return;
    }
    // Global hotkey trigger (when not typing in input)
    if (LIB && LIB.settings.useHotkeys !== false &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
        for (const s of Object.values(LIB.sounds)) {
            const hk = s.hotkey; if (!hk) continue;
            if (hk.code === e.keyCode && !!hk.ctrl === e.ctrlKey &&
                !!hk.shift === e.shiftKey && !!hk.alt === e.altKey) {
                e.preventDefault(); playSound(s.id); break;
            }
        }
    }
});
$('#sfx-hk-close').addEventListener('click', closeHotkeyModal);
$('#sfx-hk-clear').addEventListener('click', () => { hkCapture = null; $('#sfx-hk-display').textContent = 'Bấm tổ hợp phím...'; });
$('#sfx-hk-save').addEventListener('click', () => {
    if (hkTargetId) {
        LIB.sounds[hkTargetId].hotkey = hkCapture;
        queueSave({ hotkeys: { [hkTargetId]: hkCapture } });
        renderGrid();
    }
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
bindSetting('#set-showHotkeys', 'showHotkeys');
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
$('#sfx-tts-speak').addEventListener('click', () => {
    const text = $('#sfx-tts-text').value.trim();
    if (!text) return;
    const lang = $('#sfx-tts-lang').value;
    stopAll(false);
    audio.src = API + '/tts?lang=' + encodeURIComponent(lang) + '&text=' + encodeURIComponent(text);
    audio.play().catch(() => {});
    $('#sfx-now').textContent = '🗣️ ' + text.slice(0, 40);
});
$('#sfx-tts-stop').addEventListener('click', () => stopAll());

// ---------- Cloud browser ----------
let cloudReplaceId = null;
$('#sfx-cloud-btn').addEventListener('click', () => openCloud(false));
$('#sfx-cloud-close').addEventListener('click', () => $('#sfx-cloud').hidden = true);
$('#sfx-cloud-search').addEventListener('input', () => renderCloudFiles());
let cloudCacheFiles = [];
function openCloud(replaceMode, replaceId) {
    cloudReplaceId = replaceMode ? replaceId : null;
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
function addCloudSound(f) {
    if (cloudReplaceId && LIB.sounds[cloudReplaceId]) {
        // Thay hiệu ứng: chuyển sound hiện tại sang cloud source
        const s = LIB.sounds[cloudReplaceId];
        s.source = 'cloud'; s.token = f.token;
        queueSave({}); // trigger nothing server-side for token (ephemeral) — local only
        cloudReplaceId = null;
        renderGrid();
        $('#sfx-cloud').hidden = true;
        return;
    }
    // Thêm mới vào tab hiện tại (hoặc tab đầu nếu đang ở YÊU THÍCH)
    const tab = (activeTab === FAV_TAB) ? (LIB.tabs[0]?.id || 'tab1') : activeTab;
    const id = 'cloud_' + Math.random().toString(36).slice(2, 10);
    LIB.sounds[id] = { id, tab, name: f.name, source: 'cloud', token: f.token, hotkey: null, remoteKey: 0 };
    renderTabs(); renderGrid();
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

// ---------- Init ----------
loadLib().catch(e => {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">Lỗi tải SoundFX: ' + e.message + '</div>';
});
})();

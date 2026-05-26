/* ============================================================
   HP Bắn Cung — Panel controller (app side)
   ============================================================
   Tabs:
     1. Cài đặt máu  (HP / damage / regen / revive)
     2. Quà chỉ định (shot / heal / revive / shield)
     3. Hiển thị     (vị trí, scale, skin cung, skin trái tim)
     4. Live & Test  (manual control + simulate gift)
   Reuse CSS namespace .nd-* (cards/inputs/gift-list/gift-picker)
   Expose: window.HpBanCungPanel.open(socket)
   ============================================================ */
(function () {
    'use strict';
    let socket = null;
    let cfg = null;
    let liveState = null;
    let initialized = false;
    let pendingSave = null;
    let currentTab = 'hp';
    let popoutWindow = null;
    let liveTickTimer = null;

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    function open(sharedSocket) {
        socket = sharedSocket || window.io();
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        $('#view-bancung')?.classList.add('active');
        if (!initialized) {
            initialized = true;
            bindShell();
            ensureSocketSubscribed();
            ensureHotkeys();
        }
        currentTab = 'hp';
        document.querySelectorAll('#view-bancung .bc-tab').forEach(x => x.classList.toggle('active', x.dataset.bcTab === 'hp'));
        document.querySelectorAll('#view-bancung .bc-pane').forEach(p => p.classList.toggle('active', p.dataset.bcPane === 'hp'));
        loadAll().then(() => {
            renderAll();
            ensureLiveTick();
        });
    }

    function ensureSocketSubscribed() {
        if (!socket) return;
        socket.emit('subscribe', 'preview');
        if (socket.__bcAttached) return;
        socket.__bcAttached = true;
        socket.on('bancung:state', (s) => {
            liveState = s;
            if (cfg && s && typeof s.sessionActive === 'boolean' && cfg.sessionActive !== s.sessionActive) {
                cfg.sessionActive = s.sessionActive;
                updateSessionBtn();
            }
            renderLive();
        });
        socket.on('gameConfig', ({ gameId, config: c }) => {
            if (gameId !== 'bancung') return;
            const oldDisplay = cfg ? cfg.display : null;
            cfg = Object.assign({}, cfg || {}, c);
            if (oldDisplay && c.display) {
                Object.keys(oldDisplay).forEach(k => delete oldDisplay[k]);
                Object.assign(oldDisplay, c.display);
                cfg.display = oldDisplay;
            }
            renderForm();
            // Re-render display tab if visible (so position sliders sync after edit-mode drag)
            if (currentTab === 'display') renderDisplayTab();
        });
    }

    async function loadAll() {
        try {
            const r = await fetch('/api/games/bancung/config');
            cfg = r.ok ? await r.json() : window.HpGame.bancung.defaultConfig();
        } catch (e) {
            cfg = window.HpGame.bancung.defaultConfig();
        }
        const def = window.HpGame.bancung.defaultConfig();
        cfg = Object.assign({}, def, cfg || {});
        cfg.display = Object.assign({}, def.display, cfg.display || {});
        ['shotGifts','healGifts','reviveGifts','shieldGifts'].forEach(k => {
            if (!Array.isArray(cfg[k])) cfg[k] = [];
        });
        try {
            const r = await fetch('/api/games/bancung/livestate');
            liveState = r.ok ? await r.json() : null;
        } catch (e) {}
    }

    function schedulePersist() {
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => persistConfig().catch(() => {}), 350);
    }
    async function persistConfig() {
        clearTimeout(pendingSave);
        const r = await fetch('/api/games/bancung/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        if (!r.ok) throw new Error('save_fail');
    }
    function ensureLiveTick() {
        if (liveTickTimer) return;
        liveTickTimer = setInterval(() => renderLive(), 500);
    }

    // ============================================================
    // GLOBAL HOTKEYS — always active when bancung config loaded (regardless of which view is open)
    // ============================================================
    let _hotkeysAttached = false;
    function ensureHotkeys() {
        if (_hotkeysAttached) return;
        _hotkeysAttached = true;
        document.addEventListener('keydown', (e) => {
            // Skip if user is typing in any input/textarea/contenteditable
            const tag = (e.target?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.target?.isContentEditable) return;
            // Skip if modifier keys held (avoid conflicts with browser shortcuts)
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            // Bancung disabled or session inactive → ignore
            if (!cfg || cfg.enabled === false || cfg.sessionActive === false) return;
            const d = cfg.display || {};
            const key = e.key.toUpperCase();
            const action = matchHotkey(d, key);
            if (!action) return;
            e.preventDefault();
            runHotkeyAction(action);
        });
        console.log('[bancung] hotkeys registered (X=bắn, H=hồi, B=giáp, R=hồi sinh)');
    }
    function matchHotkey(d, key) {
        if (d.hotkeyFire && d.hotkeyFire.toUpperCase() === key) return 'fire';
        if (d.hotkeyHeal && d.hotkeyHeal.toUpperCase() === key) return 'heal';
        if (d.hotkeyShield && d.hotkeyShield.toUpperCase() === key) return 'shield';
        if (d.hotkeyRevive && d.hotkeyRevive.toUpperCase() === key) return 'revive';
        if (d.hotkeyKill && d.hotkeyKill.toUpperCase() === key) return 'kill';
        return null;
    }
    function runHotkeyAction(action) {
        switch (action) {
            case 'fire':
                sendControl({ cmd: 'damage', shots: 1, uniqueId: 'idol', nickname: 'IDOL' });
                flashHotkeyToast('🏹 Bắn 1 mũi');
                break;
            case 'heal':
                sendControl({ cmd: 'heal', hearts: 1 });
                flashHotkeyToast('💚 +1 ♥');
                break;
            case 'shield':
                sendControl({ cmd: 'shield', durationSec: 5 });
                flashHotkeyToast('🛡 Giáp 5s');
                break;
            case 'revive':
                sendControl({ cmd: 'revive' });
                flashHotkeyToast('✨ Hồi sinh');
                break;
            case 'kill':
                sendControl({ cmd: 'killshot' });
                flashHotkeyToast('💀 KILL!');
                break;
        }
    }
    function flashHotkeyToast(text) {
        toastOk(text);
    }

    // ============================================================
    // SHELL — top toolbar
    // ============================================================
    function bindShell() {
        document.querySelectorAll('#view-bancung .bc-tab').forEach(t => {
            t.addEventListener('click', () => {
                document.querySelectorAll('#view-bancung .bc-tab').forEach(x => x.classList.remove('active'));
                t.classList.add('active');
                currentTab = t.dataset.bcTab;
                document.querySelectorAll('#view-bancung .bc-pane').forEach(p => {
                    p.classList.toggle('active', p.dataset.bcPane === currentTab);
                });
            });
        });
        $('#bc-cfg-enabled')?.addEventListener('change', e => { cfg.enabled = !!e.target.checked; schedulePersist(); });
        const url = location.origin + '/overlay/bancung';
        $('#bc-btn-copy')?.addEventListener('click', async () => {
            const ok = window.hpCopyText ? await window.hpCopyText(url) : false;
            ok ? toastOk('Đã copy link OBS: ' + url) : toastWarn('Copy thất bại — link: ' + url);
        });
        $('#bc-btn-reload')?.addEventListener('click', () => {
            socket && socket.emit('overlay:reload');
            if (popoutWindow && !popoutWindow.closed) popoutWindow.location.reload();
            toastOk('Đã gửi lệnh reload tới mọi overlay');
        });
        $('#bc-btn-popout-edit')?.addEventListener('click', () => openPopoutWindow(true, true));
        $('#bc-btn-reset')?.addEventListener('click', () => sendControl({ cmd: 'reset' }));
        $('#bc-btn-session')?.addEventListener('click', async () => {
            const cur = cfg.sessionActive !== false;
            await sendControl({ cmd: cur ? 'stop' : 'start' });
            cfg.sessionActive = !cur;
            updateSessionBtn();
        });
        $('#bc-btn-save')?.addEventListener('click', async () => {
            try {
                await persistConfig();
                toastOk('✓ Đã lưu tất cả cài đặt');
            } catch (e) {
                toastWarn('Lưu thất bại: ' + (e?.message || e));
            }
        });
    }

    function updateSessionBtn() {
        const btn = $('#bc-btn-session');
        const status = $('#bc-session-status');
        if (!btn || !cfg) return;
        const active = cfg.sessionActive !== false;
        if (active) {
            btn.textContent = '⏸ KẾT THÚC';
            btn.className = 'danger small';
            btn.title = 'Dừng phiên — overlay ẨN, quà không kích hoạt bắn cung';
            if (status) { status.textContent = '● Đang chạy'; status.className = 'nd-session-status active'; }
        } else {
            btn.textContent = '▶ BẮT ĐẦU';
            btn.className = 'primary small';
            btn.title = 'Bắt đầu phiên — overlay nhận quà + hiển thị';
            if (status) { status.textContent = '⏸ Đã dừng'; status.className = 'nd-session-status stopped'; }
        }
    }

    function openPopoutWindow(editMode, pinMode) {
        if (pinMode) {
            const params = ['pin=1'];
            if (editMode) params.push('edit=1');
            window.open('/overlay/bancung?' + params.join('&'), '_blank');
            return;
        }
        if (popoutWindow && !popoutWindow.closed) {
            try { popoutWindow.focus(); } catch (e) {}
            const wantEdit = !!editMode;
            const curUrl = popoutWindow.location.href || '';
            const curEdit = /\bedit=1\b/.test(curUrl);
            if (wantEdit !== curEdit) {
                popoutWindow.location.href = '/overlay/bancung' + (wantEdit ? '?edit=1' : '');
            }
            return;
        }
        let b = { x: 200, y: 100, w: 540, h: 960 };
        try {
            const saved = JSON.parse(localStorage.getItem('hp-bc-popout-bounds') || 'null');
            if (saved) Object.assign(b, saved);
        } catch (e) {}
        const features = `popup=yes,resizable=yes,scrollbars=no,width=${b.w},height=${b.h},left=${b.x},top=${b.y}`;
        popoutWindow = window.open('/overlay/bancung' + (editMode ? '?edit=1' : ''), 'hp-bc-popout', features);
        if (!popoutWindow) toastWarn('Trình duyệt chặn popup — cho phép popup từ localhost');
    }

    // ============================================================
    // RENDER
    // ============================================================
    function renderAll() {
        renderForm();
        renderHpTab();
        renderGiftsTab();
        renderDisplayTab();
        renderLive();
    }
    function renderForm() {
        if (!cfg) return;
        const en = $('#bc-cfg-enabled'); if (en) en.checked = cfg.enabled !== false;
        updateSessionBtn();
    }

    // ----- Tab 1: HP / Damage / Regen / Revive -----
    function renderHpTab() {
        const host = $('#bc-hp-pane');
        if (!host || !cfg) return;
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">❤ Máu trái tim</div>
                <label class="nd-inline">Số trái tim tối đa <input type="number" id="bc-maxHearts" min="1" max="30" step="1" value="${cfg.maxHearts ?? 10}" /></label>
                <label class="nd-inline">Máu khởi đầu khi RESET <input type="number" id="bc-initialHearts" min="0" step="0.5" value="${cfg.initialHearts ?? cfg.maxHearts ?? 10}" /></label>
                <label class="nd-inline">Sát thương MỖI mũi tên <input type="number" id="bc-damagePerShot" min="0.01" step="0.05" value="${cfg.damagePerShot ?? 0.25}" /> ♥</label>
                <div class="nd-hint">VD: 10 trái tim × 0.25 sát thương = 40 mũi tên mới chết. 0.5 = 20 mũi.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">💚 Tự hồi máu (khi không bị bắn)</div>
                <label class="nd-inline">Tốc độ hồi <input type="number" id="bc-regenPerSecond" min="0" step="0.05" value="${cfg.regenPerSecond ?? 0.2}" /> ♥/giây</label>
                <label class="nd-inline">Sau <input type="number" id="bc-idleBeforeRegen" min="0" step="1" value="${cfg.idleBeforeRegen ?? 3}" /> giây không bị bắn</label>
                <div class="nd-hint">VD: 0.2 ♥/s + idle 3s → 5 giây không bị bắn = +0.4 ♥.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">💀 Hồi sinh khi chết</div>
                <label class="nd-inline">Cửa sổ chờ hồi sinh <input type="number" id="bc-reviveWindowSec" min="1" max="60" step="1" value="${cfg.reviveWindowSec ?? 5}" /> giây</label>
                <label class="nd-inline"><input type="checkbox" id="bc-autoReviveAfterWindow" ${cfg.autoReviveAfterWindow !== false ? 'checked' : ''} /> Tự hồi sinh nếu không ai cứu</label>
                <label class="nd-inline">Máu khi tự hồi sinh <input type="number" id="bc-autoReviveHearts" min="0.5" step="0.5" value="${cfg.autoReviveHearts ?? 5}" /> ♥</label>
                <label class="nd-inline">Giáp bất tử sau khi hồi sinh <input type="number" id="bc-reviveProtectionSec" min="0" step="1" value="${cfg.reviveProtectionSec ?? 3}" /> giây</label>
                <div class="nd-hint">Trong 5s sau khi chết: ai tặng quà "hồi sinh" (tab Quà chỉ định) sẽ cứu. Nếu không, tự hồi sinh sau 5s với máu cấu hình.</div>
            </div>
        `;
        const wireNum = (id, key, opts = {}) => {
            const min = opts.min ?? 0;
            const isFloat = opts.float !== false;
            $('#' + id, host)?.addEventListener('input', e => {
                const v = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                cfg[key] = Math.max(min, isFinite(v) ? v : 0);
                schedulePersist();
            });
        };
        wireNum('bc-maxHearts', 'maxHearts', { min: 1, float: false });
        wireNum('bc-initialHearts', 'initialHearts', { min: 0 });
        wireNum('bc-damagePerShot', 'damagePerShot', { min: 0.01 });
        wireNum('bc-regenPerSecond', 'regenPerSecond', { min: 0 });
        wireNum('bc-idleBeforeRegen', 'idleBeforeRegen', { min: 0, float: false });
        wireNum('bc-reviveWindowSec', 'reviveWindowSec', { min: 1, float: false });
        wireNum('bc-autoReviveHearts', 'autoReviveHearts', { min: 0.5 });
        wireNum('bc-reviveProtectionSec', 'reviveProtectionSec', { min: 0, float: false });
        $('#bc-autoReviveAfterWindow', host)?.addEventListener('change', e => {
            cfg.autoReviveAfterWindow = !!e.target.checked;
            schedulePersist();
        });
    }

    // ----- Tab 2: GIFTS (4 categories) -----
    function renderGiftsTab() {
        const host = $('#bc-gifts-pane');
        if (!host || !cfg) return;
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🏹 Quà BẮN CUNG (gây sát thương)</div>
                <div class="nd-hint">
                    Mỗi quà mặc định bắn <b>1 mũi tên</b>. Đặt thành <b>3</b> nếu muốn quà đó bắn liên tục 3 phát.
                    Nếu user tặng combo (repeatCount > 1) thì số mũi nhân lên tương ứng.
                </div>
                <div class="nd-row">
                    <button class="primary small" id="bc-add-shot">➕ Thêm quà bắn</button>
                    <button class="ghost small" id="bc-clear-shot">🗑 Xoá tất cả</button>
                </div>
                <div id="bc-list-shot" class="nd-gifts-list"></div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">💚 Quà HỒI MÁU NHANH</div>
                <div class="nd-hint">Tặng quà = cộng máu ngay lập tức. Không kích hoạt khi đang chết (phải dùng quà hồi sinh).</div>
                <div class="nd-row">
                    <button class="primary small" id="bc-add-heal">➕ Thêm quà hồi máu</button>
                    <button class="ghost small" id="bc-clear-heal">🗑 Xoá tất cả</button>
                </div>
                <div id="bc-list-heal" class="nd-gifts-list"></div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">✨ Quà HỒI SINH (chỉ khi chết)</div>
                <div class="nd-hint">Chỉ kích hoạt trong cửa sổ ${cfg.reviveWindowSec ?? 5}s sau khi HP về 0. Hồi với 50% máu × số combo.</div>
                <div class="nd-row">
                    <button class="primary small" id="bc-add-revive">➕ Thêm quà hồi sinh</button>
                    <button class="ghost small" id="bc-clear-revive">🗑 Xoá tất cả</button>
                </div>
                <div id="bc-list-revive" class="nd-gifts-list"></div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🛡 Quà GIÁP BẤT TỬ</div>
                <div class="nd-hint">Tặng quà = bất tử N giây. Trong thời gian này mọi mũi tên đều bị chặn.</div>
                <div class="nd-row">
                    <button class="primary small" id="bc-add-shield">➕ Thêm quà giáp</button>
                    <button class="ghost small" id="bc-clear-shield">🗑 Xoá tất cả</button>
                </div>
                <div id="bc-list-shield" class="nd-gifts-list"></div>
            </div>
        `;
        renderShotList(); renderHealList(); renderReviveList(); renderShieldList();
        $('#bc-add-shot', host).addEventListener('click', () => openGiftPicker('shot'));
        $('#bc-add-heal', host).addEventListener('click', () => openGiftPicker('heal'));
        $('#bc-add-revive', host).addEventListener('click', () => openGiftPicker('revive'));
        $('#bc-add-shield', host).addEventListener('click', () => openGiftPicker('shield'));
        $('#bc-clear-shot', host).addEventListener('click', () => clearList('shotGifts', 'Xoá tất cả quà bắn cung?', renderShotList));
        $('#bc-clear-heal', host).addEventListener('click', () => clearList('healGifts', 'Xoá tất cả quà hồi máu?', renderHealList));
        $('#bc-clear-revive', host).addEventListener('click', () => clearList('reviveGifts', 'Xoá tất cả quà hồi sinh?', renderReviveList));
        $('#bc-clear-shield', host).addEventListener('click', () => clearList('shieldGifts', 'Xoá tất cả quà giáp?', renderShieldList));
    }

    async function clearList(key, msg, rerender) {
        const ok = window.hpConfirm
            ? await window.hpConfirm({ title: msg, confirmText: 'Xoá', dangerous: true })
            : confirm(msg);
        if (!ok) return;
        cfg[key] = [];
        rerender();
        persistConfig();
    }

    function renderShotList()   { renderGiftRow('#bc-list-shot',   cfg.shotGifts,   'shotGifts',   'shots',        { label: 'Số phát / quà', min: 1, max: 20, step: 1, default: 1, suffix: 'mũi' }); }
    function renderHealList()   { renderGiftRow('#bc-list-heal',   cfg.healGifts,   'healGifts',   'healHearts',   { label: '♥ hồi mỗi quà', min: 0.5, step: 0.5, default: 2, suffix: '♥' }); }
    function renderReviveList() { renderGiftRow('#bc-list-revive', cfg.reviveGifts, 'reviveGifts', null,           {}); }
    function renderShieldList() { renderGiftRow('#bc-list-shield', cfg.shieldGifts, 'shieldGifts', 'durationSec',  { label: 'Giây bất tử', min: 1, step: 1, default: 5, suffix: 'giây' }); }

    function renderGiftRow(sel, list, key, valueField, valueOpts) {
        const wrap = document.querySelector(sel);
        if (!wrap) return;
        if (!list || !list.length) {
            wrap.innerHTML = '<div class="nd-empty">Chưa có quà nào.</div>';
            return;
        }
        wrap.innerHTML = list.map((g, i) => {
            const img = g.giftImage
                ? `<img class="nd-gift-icon" src="${escapeHtml(g.giftImage)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🎁',className:'nd-gift-icon'}))" />`
                : `<span class="nd-gift-icon">🎁</span>`;
            const valField = valueField ? `
                <label class="nd-inline">${escapeHtml(valueOpts.label || '')}
                    <input type="number" class="bc-gift-val" min="${valueOpts.min ?? 0}" ${valueOpts.max != null ? `max="${valueOpts.max}"` : ''} step="${valueOpts.step ?? 1}" value="${g[valueField] ?? valueOpts.default ?? 1}" />
                    ${valueOpts.suffix || ''}
                </label>
            ` : '<span class="nd-hint" style="padding:0">(Không có tham số — kích hoạt khi chết)</span>';
            return `
                <div class="nd-gift-row" data-idx="${i}">
                    ${img}
                    <span class="nd-gift-name">${escapeHtml(g.giftName || ('Quà #' + g.giftId))}</span>
                    <span class="nd-gift-id">ID: ${escapeHtml(g.giftId || '?')}</span>
                    ${valField}
                    <button class="danger small bc-gift-del">🗑</button>
                </div>
            `;
        }).join('');
        wrap.querySelectorAll('.nd-gift-row').forEach(row => {
            const idx = parseInt(row.dataset.idx, 10);
            if (valueField) {
                row.querySelector('.bc-gift-val')?.addEventListener('input', e => {
                    const v = parseFloat(e.target.value) || 0;
                    cfg[key][idx][valueField] = Math.max(valueOpts.min ?? 0, v);
                    schedulePersist();
                });
            }
            row.querySelector('.bc-gift-del')?.addEventListener('click', () => {
                cfg[key].splice(idx, 1);
                // Re-render same list
                if (key === 'shotGifts') renderShotList();
                else if (key === 'healGifts') renderHealList();
                else if (key === 'reviveGifts') renderReviveList();
                else if (key === 'shieldGifts') renderShieldList();
                persistConfig();
            });
        });
    }

    // ----- Gift picker modal (reuses .nd-gp-* styles) -----
    let _pickerMode = 'shot';
    const PICKER_CONFIG = {
        shot:   { title: '🏹 Chọn quà BẮN CUNG',   key: 'shotGifts',   defaults: { shots: 1 } },
        heal:   { title: '💚 Chọn quà HỒI MÁU',    key: 'healGifts',   defaults: { healHearts: 2 } },
        revive: { title: '✨ Chọn quà HỒI SINH',   key: 'reviveGifts', defaults: {} },
        shield: { title: '🛡 Chọn quà GIÁP',       key: 'shieldGifts', defaults: { durationSec: 5 } }
    };

    async function openGiftPicker(mode) {
        _pickerMode = mode || 'shot';
        if (!Array.isArray(window.__giftSheet) || !window.__giftSheet.length) {
            try {
                const r = await fetch('/api/gifts');
                if (r.ok) window.__giftSheet = (await r.json()).slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
            } catch (e) {}
        }
        const el = ensurePicker();
        el.hidden = false;
        el.querySelector('.nd-gp-search').value = '';
        const titleEl = el.querySelector('.nd-gp-title');
        if (titleEl) titleEl.textContent = PICKER_CONFIG[_pickerMode].title;
        renderPickerList('');
        setTimeout(() => el.querySelector('.nd-gp-search').focus(), 30);
    }
    let _pickerEl = null;
    function ensurePicker() {
        if (_pickerEl) return _pickerEl;
        const el = document.createElement('div');
        el.className = 'nd-gp-overlay';
        el.hidden = true;
        el.innerHTML = `
            <div class="nd-gp-modal">
                <div class="nd-gp-head">
                    <div class="nd-gp-title">🎁 Chọn quà</div>
                    <button class="nd-gp-close ghost small">✕</button>
                </div>
                <input class="nd-gp-search" type="text" placeholder="🔍 Tìm tên quà hoặc ID..." />
                <div class="nd-gp-list"></div>
                <div class="nd-gp-hint">Bấm vào quà để thêm vào danh sách.</div>
            </div>
        `;
        document.body.appendChild(el);
        el.addEventListener('click', e => { if (e.target === el) el.hidden = true; });
        el.querySelector('.nd-gp-close').addEventListener('click', () => el.hidden = true);
        el.querySelector('.nd-gp-search').addEventListener('input', e => renderPickerList(e.target.value));
        _pickerEl = el;
        return el;
    }
    function renderPickerList(filter) {
        const list = _pickerEl.querySelector('.nd-gp-list');
        const sheet = Array.isArray(window.__giftSheet) ? window.__giftSheet : [];
        const f = String(filter || '').toLowerCase().trim();
        const conf = PICKER_CONFIG[_pickerMode];
        const used = new Set((cfg[conf.key] || []).map(g => String(g.giftId)));
        const items = !f ? sheet : sheet.filter(g => (g.name || '').toLowerCase().includes(f) || String(g.id || '').includes(f));
        list.innerHTML = items.slice(0, 200).map(g => `
            <div class="nd-gp-row${used.has(String(g.id)) ? ' active' : ''}" data-gid="${escapeHtml(String(g.id))}" data-gn="${escapeHtml(g.name || '')}" data-gi="${escapeHtml(g.image || '')}">
                ${g.image ? `<img class="nd-gp-img" src="${escapeHtml(g.image)}" />` : `<span class="nd-gp-icon">🎁</span>`}
                <span class="nd-gp-name">${escapeHtml(g.name || ('Quà #' + g.id))}</span>
                <span class="nd-gp-dia">${g.diamond || 0}💎</span>
                ${used.has(String(g.id)) ? '<span class="nd-gp-tick">✓</span>' : ''}
            </div>
        `).join('') || '<div class="nd-empty">Không tìm thấy quà.</div>';
        list.querySelectorAll('.nd-gp-row').forEach(r => {
            r.addEventListener('click', () => {
                const id = r.dataset.gid;
                if (used.has(id)) return;
                const c = PICKER_CONFIG[_pickerMode];
                cfg[c.key] = cfg[c.key] || [];
                cfg[c.key].push(Object.assign({
                    giftId: id, giftName: r.dataset.gn, giftImage: r.dataset.gi
                }, c.defaults));
                if (_pickerMode === 'shot') renderShotList();
                else if (_pickerMode === 'heal') renderHealList();
                else if (_pickerMode === 'revive') renderReviveList();
                else if (_pickerMode === 'shield') renderShieldList();
                persistConfig();
                _pickerEl.hidden = true;
            });
        });
    }

    // ----- Tab 3: DISPLAY -----
    function renderDisplayTab() {
        const host = $('#bc-display-pane');
        if (!host || !cfg) return;
        const d = cfg.display;
        const skins = window.HpGame.bancung.BOW_SKINS || [];
        const heartStyles = window.HpGame.bancung.HEART_STYLES || [];
        const skinRadios = skins.map(s => `
            <label class="nd-radio nd-scheme-radio" title="${escapeHtml(s.label)}">
                <input type="radio" name="bc-skin" value="${s.id}" ${d.bowSkin === s.id ? 'checked' : ''} />
                <span class="nd-scheme-emoji">${s.emoji}</span>
                <span class="nd-scheme-label">${escapeHtml(s.label)}</span>
            </label>
        `).join('');
        const heartRadios = heartStyles.map(s => `
            <label class="nd-radio nd-scheme-radio">
                <input type="radio" name="bc-heart-style" value="${s.id}" ${d.heartStyle === s.id ? 'checked' : ''} />
                <span class="nd-scheme-emoji">${s.emoji}</span>
                <span class="nd-scheme-label">${escapeHtml(s.label)}</span>
            </label>
        `).join('');
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🏹 Skin CUNG TÊN (8 kiểu)</div>
                <div class="nd-scheme-grid">${skinRadios}</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">❤ Kiểu TRÁI TIM</div>
                <div class="nd-scheme-grid">${heartRadios}</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">📐 Vị trí HÀNG TRÁI TIM</div>
                <label class="nd-inline">X (ngang) <input type="range" id="bc-hx" min="0" max="100" step="1" value="${d.heartsXPercent ?? 50}" /><span id="bc-hx-v">${d.heartsXPercent ?? 50}%</span></label>
                <label class="nd-inline">Y (dọc) <input type="range" id="bc-hy" min="0" max="100" step="1" value="${d.heartsYPercent ?? 14}" /><span id="bc-hy-v">${d.heartsYPercent ?? 14}%</span></label>
                <label class="nd-inline">Scale <input type="range" id="bc-hs" min="30" max="250" step="5" value="${d.heartsScale ?? 100}" /><span id="bc-hs-v">${d.heartsScale ?? 100}%</span></label>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🏹 Vị trí WIDGET CUNG TÊN</div>
                <label class="nd-inline">X (ngang) <input type="range" id="bc-bx" min="0" max="100" step="1" value="${d.bowXPercent ?? 85}" /><span id="bc-bx-v">${d.bowXPercent ?? 85}%</span></label>
                <label class="nd-inline">Y (dọc) <input type="range" id="bc-by" min="0" max="100" step="1" value="${d.bowYPercent ?? 80}" /><span id="bc-by-v">${d.bowYPercent ?? 80}%</span></label>
                <label class="nd-inline">Scale <input type="range" id="bc-bs" min="30" max="250" step="5" value="${d.bowScale ?? 100}" /><span id="bc-bs-v">${d.bowScale ?? 100}%</span></label>
                <label class="nd-inline"><input type="checkbox" id="bc-autoAim" ${d.autoAimBow !== false ? 'checked' : ''} /> Tự xoay cung hướng về điểm trúng</label>
                <div class="nd-hint">💡 Bấm <b>✏ Sửa vị trí</b> rồi kéo chuột để di chuyển, cuộn để zoom.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🎯 ĐIỂM TRÚNG (vị trí mũi tên cắm)</div>
                <div class="nd-hint">
                    Mũi tên bay từ widget cung → vùng này. Đặt vào <b>mặt/thân streamer</b> để cảm giác đang bắn vào idol.
                    <br><b>Cách dễ nhất:</b> bấm <b>✏ Sửa vị trí</b> trên thanh công cụ → kéo vòng tròn đỏ "🎯 ĐIỂM TRÚNG" đến chỗ muốn.
                </div>
                <div class="nd-row">
                    <span style="color:#8b93a8;font-size:12px;font-weight:600;align-self:center">Đặt nhanh:</span>
                    <button class="ghost small bc-impact-preset" data-x="50" data-y="10">⬆ Trên hàng tim</button>
                    <button class="ghost small bc-impact-preset" data-x="50" data-y="22">😊 Mặt streamer</button>
                    <button class="ghost small bc-impact-preset" data-x="50" data-y="40">👤 Thân streamer</button>
                    <button class="ghost small bc-impact-preset" data-x="50" data-y="60">🦶 Dưới streamer</button>
                </div>
                <label class="nd-inline">X (ngang)
                    <input type="range" id="bc-ix" min="0" max="100" step="1" value="${d.impactXPercent ?? 50}" />
                    <span id="bc-ix-v">${d.impactXPercent ?? 50}%</span>
                    <small style="color:#6a7080">(0=trái, 50=giữa, 100=phải)</small>
                </label>
                <label class="nd-inline">Y (dọc)
                    <input type="range" id="bc-iy" min="0" max="100" step="1" value="${d.impactYPercent ?? 18}" />
                    <span id="bc-iy-v">${d.impactYPercent ?? 18}%</span>
                    <small style="color:#6a7080">(0=trên cùng, 100=dưới cùng)</small>
                </label>
                <label class="nd-inline">Tản đạn <input type="range" id="bc-ispread" min="0" max="30" step="1" value="${d.impactSpread ?? 6}" /><span id="bc-ispread-v">${d.impactSpread ?? 6}%</span></label>
                <div class="nd-hint">Tản đạn 0% = mọi mũi vào đúng tâm. 30% = bay tản loạn quanh tâm 30% màn hình.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">👁 Hiện / ẩn</div>
                <label class="nd-inline"><input type="checkbox" id="bc-showHearts" ${d.showHearts !== false ? 'checked' : ''} /> Hàng trái tim</label>
                <label class="nd-inline"><input type="checkbox" id="bc-showBow" ${d.showBowWidget !== false ? 'checked' : ''} /> Widget cung tên</label>
                <label class="nd-inline"><input type="checkbox" id="bc-showShooter" ${d.showShooterName !== false ? 'checked' : ''} /> Tên người bắn bay lên</label>
                <label class="nd-inline"><input type="checkbox" id="bc-showDmgText" ${d.showDamageText !== false ? 'checked' : ''} /> Số sát thương (−0.25 ♥)</label>
                <label class="nd-inline"><input type="checkbox" id="bc-showTop" ${d.showTopContrib !== false ? 'checked' : ''} /> 🎯 Bảng top cung thủ</label>
                <label class="nd-inline">Góc bảng top
                    <select id="bc-topPos">
                        <option value="top-left" ${d.topContribPos === 'top-left' ? 'selected' : ''}>Trên-trái</option>
                        <option value="top-right" ${d.topContribPos === 'top-right' ? 'selected' : ''}>Trên-phải</option>
                        <option value="bottom-left" ${(d.topContribPos || 'bottom-left') === 'bottom-left' ? 'selected' : ''}>Dưới-trái</option>
                        <option value="bottom-right" ${d.topContribPos === 'bottom-right' ? 'selected' : ''}>Dưới-phải</option>
                    </select>
                </label>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🎚 Cường độ hiệu ứng</div>
                <label class="nd-inline">Chớp đỏ khi bị bắn <input type="range" id="bc-flash" min="0" max="100" step="5" value="${d.redFlashIntensity ?? 60}" /><span id="bc-flash-v">${d.redFlashIntensity ?? 60}%</span></label>
                <label class="nd-inline">Mờ đen khi chết <input type="range" id="bc-death" min="0" max="100" step="5" value="${d.deathTintOpacity ?? 75}" /><span id="bc-death-v">${d.deathTintOpacity ?? 75}%</span></label>
                <label class="nd-inline">Tốc độ bay mũi tên <input type="range" id="bc-arrowDur" min="200" max="2000" step="50" value="${d.arrowDurationMs ?? 700}" /><span id="bc-arrowDur-v">${d.arrowDurationMs ?? 700}ms</span></label>
                <label class="nd-inline">Delay giữa mũi (burst 3) <input type="range" id="bc-burstDelay" min="100" max="1000" step="20" value="${d.burstDelayMs ?? 280}" /><span id="bc-burstDelay-v">${d.burstDelayMs ?? 280}ms</span></label>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">✨ HIỆU ỨNG NÂNG CAO</div>
                <div class="nd-hint">Polish visuals cho stream hấp dẫn hơn — tắt từng cái nếu thấy phiền.</div>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-trail" ${d.showArrowTrail !== false ? 'checked' : ''} /> 💫 Streak đuôi mũi tên</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-username" ${d.showArrowUsername !== false ? 'checked' : ''} /> 🏷 Tên TikTok bay theo mũi tên</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-particles" ${d.showHitParticles !== false ? 'checked' : ''} /> 🪶 Lông + bụi văng khi trúng</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-shake-low" ${d.heartShakeLowHp !== false ? 'checked' : ''} /> ❤️ Hàng tim rung khi HP < 30%</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-slowmo" ${d.slowMotionOnKill !== false ? 'checked' : ''} /> 🎬 Slo-motion phát kết liễu</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-vp-shake" ${d.viewportShakeOnHit !== false ? 'checked' : ''} /> 📳 Viewport rung khi trúng</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-deathcam" ${d.deathCamZoom !== false ? 'checked' : ''} /> 💀 Death cam (grayscale + dim)</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-killing" ${d.showKillingBlow !== false ? 'checked' : ''} /> ⚔ Banner "PHÁT KẾT LIỄU"</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-podium" ${d.showPodium !== false ? 'checked' : ''} /> 🏆 Podium top-3 cuối phiên</label>
                <label class="nd-inline"><input type="checkbox" id="bc-fx-survival" ${d.showSurvivalTimer !== false ? 'checked' : ''} /> ⏱ Đồng hồ sống sót (góc trên-phải)</label>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🎯 GAMEPLAY DEPTH</div>
                <div class="nd-hint">Cơ chế làm game hấp dẫn hơn — combo, critical, headshot, charge meter.</div>
                <label class="nd-inline"><input type="checkbox" id="bc-gp-combo" ${d.comboEnabled !== false ? 'checked' : ''} /> 🔥 Combo system (chuỗi bắn liên tiếp)</label>
                <label class="nd-inline">Cửa sổ combo <input type="number" id="bc-gp-combo-win" min="1" max="20" step="1" value="${d.comboWindowSec ?? 4}" /> giây</label>
                <label class="nd-inline">% Chí mạng (critical) <input type="range" id="bc-gp-crit" min="0" max="50" step="1" value="${d.criticalChance ?? 5}" /><span id="bc-gp-crit-v">${d.criticalChance ?? 5}%</span></label>
                <label class="nd-inline">Critical x sát thương <input type="number" id="bc-gp-crit-mul" min="1" max="10" step="0.5" value="${d.criticalMultiplier ?? 3}" /></label>
                <hr style="border:0;border-top:1px solid #2a2e3a;width:100%;margin:6px 0" />
                <label class="nd-inline"><input type="checkbox" id="bc-gp-hs" ${d.headshotEnabled === true ? 'checked' : ''} /> 🎯 Headshot zone (x2 damage)</label>
                <label class="nd-inline">% Headshot <input type="range" id="bc-gp-hs-chance" min="0" max="100" step="1" value="${d.headshotChance ?? 0}" /><span id="bc-gp-hs-chance-v">${d.headshotChance ?? 0}%</span></label>
                <label class="nd-inline">Headshot x sát thương <input type="number" id="bc-gp-hs-mul" min="1" max="10" step="0.5" value="${d.headshotMultiplier ?? 2}" /></label>
                <hr style="border:0;border-top:1px solid #2a2e3a;width:100%;margin:6px 0" />
                <label class="nd-inline"><input type="checkbox" id="bc-gp-charge" ${d.bowChargeEnabled === true ? 'checked' : ''} /> ⚡ Bow charge meter (gift → nạp, full → auto-burst)</label>
                <label class="nd-inline">% nạp mỗi quà <input type="number" id="bc-gp-charge-per" min="1" max="100" step="1" value="${d.bowChargePerGift ?? 12}" /> %</label>
                <label class="nd-inline">Số mũi khi auto-burst <input type="number" id="bc-gp-charge-shots" min="1" max="30" step="1" value="${d.bowChargeFullShots ?? 10}" /></label>
            </div>
        `;
        // Wire
        $$('input[name="bc-skin"]', host).forEach(r => r.addEventListener('change', () => {
            d.bowSkin = r.value; schedulePersist();
        }));
        $$('input[name="bc-heart-style"]', host).forEach(r => r.addEventListener('change', () => {
            d.heartStyle = r.value; schedulePersist();
        }));
        const wireRange = (id, key, sfx) => {
            const el = $('#' + id, host), v = $('#' + id + '-v', host);
            el?.addEventListener('input', () => {
                const n = parseInt(el.value, 10);
                d[key] = n;
                if (v) v.textContent = n + (sfx || '');
                schedulePersist();
            });
        };
        wireRange('bc-hx', 'heartsXPercent', '%');
        wireRange('bc-hy', 'heartsYPercent', '%');
        wireRange('bc-hs', 'heartsScale', '%');
        wireRange('bc-bx', 'bowXPercent', '%');
        wireRange('bc-by', 'bowYPercent', '%');
        wireRange('bc-bs', 'bowScale', '%');
        wireRange('bc-ix', 'impactXPercent', '%');
        wireRange('bc-iy', 'impactYPercent', '%');
        wireRange('bc-ispread', 'impactSpread', '%');
        wireRange('bc-flash', 'redFlashIntensity', '%');
        wireRange('bc-death', 'deathTintOpacity', '%');
        wireRange('bc-arrowDur', 'arrowDurationMs', 'ms');
        wireRange('bc-burstDelay', 'burstDelayMs', 'ms');
        $('#bc-autoAim', host)?.addEventListener('change', e => { d.autoAimBow = !!e.target.checked; schedulePersist(); });
        // Advanced visual toggles
        [['bc-fx-trail','showArrowTrail'],['bc-fx-username','showArrowUsername'],['bc-fx-particles','showHitParticles'],
         ['bc-fx-shake-low','heartShakeLowHp'],['bc-fx-slowmo','slowMotionOnKill'],['bc-fx-vp-shake','viewportShakeOnHit'],
         ['bc-fx-deathcam','deathCamZoom'],['bc-fx-killing','showKillingBlow'],['bc-fx-podium','showPodium'],
         ['bc-fx-survival','showSurvivalTimer'],
         ['bc-gp-combo','comboEnabled'],['bc-gp-hs','headshotEnabled'],['bc-gp-charge','bowChargeEnabled']]
        .forEach(([id, key]) => $('#' + id, host)?.addEventListener('change', e => { d[key] = !!e.target.checked; schedulePersist(); }));
        // Range inputs
        wireRange('bc-gp-crit', 'criticalChance', '%');
        wireRange('bc-gp-hs-chance', 'headshotChance', '%');
        // Number inputs
        [['bc-gp-combo-win','comboWindowSec',1],['bc-gp-crit-mul','criticalMultiplier',1],
         ['bc-gp-hs-mul','headshotMultiplier',1],['bc-gp-charge-per','bowChargePerGift',1],
         ['bc-gp-charge-shots','bowChargeFullShots',1]]
        .forEach(([id, key, min]) => $('#' + id, host)?.addEventListener('input', e => {
            d[key] = Math.max(min, parseFloat(e.target.value) || min);
            schedulePersist();
        }));
        // Impact zone presets — set X/Y + update sliders + push to overlay immediately
        $$('.bc-impact-preset', host).forEach(b => {
            b.addEventListener('click', () => {
                const x = parseInt(b.dataset.x, 10);
                const y = parseInt(b.dataset.y, 10);
                d.impactXPercent = x;
                d.impactYPercent = y;
                const $ix = $('#bc-ix', host); if ($ix) $ix.value = x;
                const $iy = $('#bc-iy', host); if ($iy) $iy.value = y;
                const $ixv = $('#bc-ix-v', host); if ($ixv) $ixv.textContent = x + '%';
                const $iyv = $('#bc-iy-v', host); if ($iyv) $iyv.textContent = y + '%';
                persistConfig();
                toastOk(`✓ Điểm trúng: ${b.textContent.trim()}`);
            });
        });
        const wireToggle = (id, key) => $('#' + id, host)?.addEventListener('change', e => { d[key] = !!e.target.checked; schedulePersist(); });
        wireToggle('bc-showHearts', 'showHearts');
        wireToggle('bc-showBow', 'showBowWidget');
        wireToggle('bc-showShooter', 'showShooterName');
        wireToggle('bc-showDmgText', 'showDamageText');
        wireToggle('bc-showTop', 'showTopContrib');
        $('#bc-topPos', host)?.addEventListener('change', e => { d.topContribPos = e.target.value; schedulePersist(); });
    }

    // ----- Tab 4: LIVE & TEST -----
    function renderLive() {
        const host = $('#bc-live-pane');
        if (!host || !cfg) return;
        if (!host.dataset.wired) {
            host.dataset.wired = '1';
            host.innerHTML = `
                <div class="nd-card">
                    <div class="nd-card-title">❤ Máu hiện tại <span id="bc-live-status">—</span></div>
                    <div class="nd-live-row">
                        <div class="nd-bigtemp" id="bc-live-hp">— ♥</div>
                        <div class="nd-live-meta">
                            <div>Trạng thái: <b id="bc-live-mode">—</b></div>
                            <div>Giáp: <span id="bc-live-shield">—</span></div>
                            <div>Cập nhật: <span id="bc-live-since">—</span></div>
                        </div>
                    </div>
                    <div class="nd-live-bar"><div class="nd-live-bar-fill" id="bc-live-bar"></div></div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🎮 Điều khiển thủ công</div>
                    <div class="nd-row">
                        <button class="primary small" id="bc-ctl-shot1">🏹 +1 mũi</button>
                        <button class="primary small" id="bc-ctl-shot3">🏹 BURST 3 mũi</button>
                        <button class="ghost small" id="bc-ctl-heal2">💚 +2 ♥</button>
                        <button class="ghost small" id="bc-ctl-shield">🛡 Giáp 5s</button>
                        <button class="danger small" id="bc-ctl-kill">💀 GỤC NGAY</button>
                        <button class="primary small" id="bc-ctl-revive">✨ Hồi sinh</button>
                        <button class="danger small" id="bc-ctl-reset">↺ Reset full máu</button>
                    </div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">⚡ PRESET nhanh — bấm 1 phát set cấu hình</div>
                    <div class="nd-hint">Áp dụng tức thì: max HP, sát thương, hồi máu, % chí mạng — tùy độ khó bạn muốn.</div>
                    <div class="bc-preset-grid">
                        <button class="bc-preset-btn" data-preset="easy">
                            <span class="bc-preset-emoji">😌</span>
                            <span class="bc-preset-name">Dễ thở</span>
                            <span class="bc-preset-desc">HP 20 · DMG 0.2 · Regen 0.3 · Crit 3%</span>
                        </button>
                        <button class="bc-preset-btn" data-preset="normal">
                            <span class="bc-preset-emoji">⚖</span>
                            <span class="bc-preset-name">Cân bằng</span>
                            <span class="bc-preset-desc">HP 10 · DMG 0.25 · Regen 0.2 · Crit 5%</span>
                        </button>
                        <button class="bc-preset-btn" data-preset="hardcore">
                            <span class="bc-preset-emoji">💀</span>
                            <span class="bc-preset-name">Hardcore</span>
                            <span class="bc-preset-desc">HP 5 · DMG 1.0 · No regen · Crit 10%</span>
                        </button>
                        <button class="bc-preset-btn" data-preset="boss">
                            <span class="bc-preset-emoji">👹</span>
                            <span class="bc-preset-name">Boss</span>
                            <span class="bc-preset-desc">HP 50 · DMG 0.5 · Headshot 20%</span>
                        </button>
                        <button class="bc-preset-btn" data-preset="sandbox">
                            <span class="bc-preset-emoji">🧪</span>
                            <span class="bc-preset-name">Sandbox</span>
                            <span class="bc-preset-desc">HP 999 · DMG 0 — test mode</span>
                        </button>
                    </div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🧪 Bắn quà thử (giả lập)</div>
                    <div class="nd-hint">Chọn 1 quà đã gán và phát thử — đi qua hook đầy đủ giống quà thật.</div>
                    <div class="nd-row" id="bc-test-buttons"></div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">⌨ Phím tắt cho streamer</div>
                    <div class="nd-hint">Bấm phím (khi không gõ trong ô input) để kích hoạt ngay. Để trống = tắt phím đó.</div>
                    <label class="nd-inline" style="background:#1a2a35;border:1.5px solid #25f4ee;padding:8px 12px;border-radius:8px;margin:6px 0">
                        <input type="checkbox" id="bc-global-hk" ${cfg.display?.globalHotkeys === true ? 'checked' : ''} />
                        <b style="color:#25f4ee">⚡ Phím tắt GLOBAL — bấm <kbd style="background:#0c0e15;padding:2px 6px;border-radius:4px;color:#ff8ec0">Ctrl+Shift+&lt;phím&gt;</kbd> ở MỌI NƠI</b>
                    </label>
                    <div class="nd-hint" style="color:#4ade80">
                        ✓ <b>An toàn:</b> single key (X, H, B...) vẫn gõ bình thường ở Chrome/OBS/chat.
                        Chỉ bấm <b>Ctrl+Shift+X</b>, <b>Ctrl+Shift+H</b>, <b>Ctrl+Shift+B</b>, <b>Ctrl+Shift+R</b> để kích hoạt.
                        Không bật = chỉ hoạt động khi app này focus.
                    </div>
                    <div class="bc-hk-grid">
                        <label class="bc-hk-cell"><span class="bc-hk-emoji">🏹</span><span class="bc-hk-label">Bắn 1 mũi</span><input type="text" class="bc-hk-input" data-hk="hotkeyFire" maxlength="1" value="${(cfg.display?.hotkeyFire||'X')}" /></label>
                        <label class="bc-hk-cell"><span class="bc-hk-emoji">💚</span><span class="bc-hk-label">Hồi 1 ♥</span><input type="text" class="bc-hk-input" data-hk="hotkeyHeal" maxlength="1" value="${(cfg.display?.hotkeyHeal||'H')}" /></label>
                        <label class="bc-hk-cell"><span class="bc-hk-emoji">🛡</span><span class="bc-hk-label">Giáp 5s</span><input type="text" class="bc-hk-input" data-hk="hotkeyShield" maxlength="1" value="${(cfg.display?.hotkeyShield||'B')}" /></label>
                        <label class="bc-hk-cell"><span class="bc-hk-emoji">✨</span><span class="bc-hk-label">Hồi sinh</span><input type="text" class="bc-hk-input" data-hk="hotkeyRevive" maxlength="1" value="${(cfg.display?.hotkeyRevive||'R')}" /></label>
                        <label class="bc-hk-cell"><span class="bc-hk-emoji">💀</span><span class="bc-hk-label">Gục ngay</span><input type="text" class="bc-hk-input" data-hk="hotkeyKill" maxlength="1" value="${(cfg.display?.hotkeyKill||'')}" placeholder="(tắt)" /></label>
                    </div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🎯 Top cung thủ (phiên hiện tại)</div>
                    <div id="bc-top-table" class="nd-top-table"></div>
                </div>
            `;
            // Hotkey inputs — accept single key, store uppercase
            host.querySelectorAll('.bc-hk-input').forEach(inp => {
                inp.addEventListener('input', e => {
                    const k = (e.target.value || '').toUpperCase().slice(0, 1);
                    e.target.value = k;
                    cfg.display = cfg.display || {};
                    cfg.display[e.target.dataset.hk] = k;
                    schedulePersist();
                });
            });
            // Global hotkeys toggle
            $('#bc-global-hk', host)?.addEventListener('change', e => {
                cfg.display = cfg.display || {};
                cfg.display.globalHotkeys = !!e.target.checked;
                persistConfig();   // persist NOW so Electron re-registers immediately
                toastOk(e.target.checked ? '⚡ Phím tắt GLOBAL đã BẬT' : '🔇 Phím tắt GLOBAL đã TẮT');
            });
            $('#bc-ctl-shot1', host).addEventListener('click', () => sendControl({ cmd: 'damage', shots: 1, uniqueId: 'tester', nickname: 'Tester' }));
            $('#bc-ctl-shot3', host).addEventListener('click', () => sendControl({ cmd: 'damage', shots: 3, uniqueId: 'tester', nickname: 'Tester' }));
            $('#bc-ctl-heal2', host).addEventListener('click', () => sendControl({ cmd: 'heal', hearts: 2 }));
            $('#bc-ctl-shield', host).addEventListener('click', () => sendControl({ cmd: 'shield', durationSec: 5 }));
            $('#bc-ctl-kill', host).addEventListener('click', () => sendControl({ cmd: 'killshot' }));
            $('#bc-ctl-revive', host).addEventListener('click', () => sendControl({ cmd: 'revive' }));
            $('#bc-ctl-reset', host).addEventListener('click', () => sendControl({ cmd: 'reset' }));
            // Preset buttons
            host.querySelectorAll('.bc-preset-btn').forEach(b => {
                b.addEventListener('click', async () => {
                    const id = b.dataset.preset;
                    await sendControl({ cmd: 'preset', preset: id });
                    toastOk(`✓ Áp dụng preset: ${b.querySelector('.bc-preset-name')?.textContent || id}`);
                    // Reload config + re-render tabs
                    await loadAll();
                    renderAll();
                });
            });
        }
        // Update top table
        const $tt = $('#bc-top-table');
        if ($tt) {
            const top = (liveState?.top) || [];
            $tt.innerHTML = top.length
                ? top.map((u, i) => `<div class="nd-tt-row">
                    <span class="nd-tt-rank">#${i + 1}</span>
                    ${u.avatar ? `<img class="nd-tt-avatar" src="${escapeHtml(u.avatar)}" />` : '<span class="nd-tt-avatar">👤</span>'}
                    <span class="nd-tt-name">${escapeHtml(u.nickname || u.uniqueId)}</span>
                    <span class="nd-tt-deg">−${(u.totalDamage || 0).toFixed(2)} ♥ (${u.totalShots || 0} mũi)</span>
                </div>`).join('')
                : '<div class="nd-empty">Chưa có ai bắn — phát quà để xuất hiện top!</div>';
        }
        // Test gift buttons
        const $tb = $('#bc-test-buttons');
        if ($tb) {
            const groups = [
                { label: '🏹 BẮN', list: cfg.shotGifts, color: 'primary' },
                { label: '💚 HỒI', list: cfg.healGifts, color: 'ghost' },
                { label: '✨ HỒI SINH', list: cfg.reviveGifts, color: 'ghost' },
                { label: '🛡 GIÁP', list: cfg.shieldGifts, color: 'ghost' }
            ];
            const html = groups.map(g => {
                if (!g.list || !g.list.length) return '';
                return g.list.map(gift => `<button class="${g.color} small bc-test-gift" data-gid="${escapeHtml(gift.giftId)}" title="${escapeHtml(gift.giftName || '')}">${g.label}: ${escapeHtml(gift.giftName || gift.giftId)}</button>`).join('');
            }).filter(Boolean).join('');
            $tb.innerHTML = html || '<div class="nd-empty">Chưa gán quà nào — sang tab "Quà chỉ định" để gán trước.</div>';
            $tb.querySelectorAll('.bc-test-gift').forEach(b => {
                b.addEventListener('click', () => {
                    sendControl({ cmd: 'testGift', giftId: b.dataset.gid, uniqueId: 'tester', nickname: 'Tester', repeatCount: 1 });
                });
            });
        }
        if (!liveState) return;
        const hp = liveState.hp || 0;
        const max = liveState.maxHp || cfg.maxHearts || 10;
        const pct = Math.max(0, Math.min(100, hp / max * 100));
        $('#bc-live-hp').textContent = hp.toFixed(2) + ' / ' + max + ' ♥';
        $('#bc-live-bar').style.width = pct.toFixed(1) + '%';
        const mode = liveState.deadAt
            ? `💀 ĐÃ GỤC (còn ${Math.ceil(liveState.reviveWindowMsLeft / 1000)}s)`
            : (liveState.shielded ? '🛡 BẤT TỬ' : '✅ Sống');
        $('#bc-live-mode').textContent = mode;
        const shieldLeft = liveState.shielded ? Math.ceil(Math.max(0, liveState.shieldUntil - Date.now()) / 1000) : 0;
        $('#bc-live-shield').textContent = shieldLeft > 0 ? (shieldLeft + 's') : '—';
        $('#bc-live-status').textContent = liveState.sessionActive === false ? '(PHIÊN DỪNG)' : (liveState.enabled === false ? '(TẮT)' : '');
        $('#bc-live-since').textContent = new Date(liveState.updatedAt || Date.now()).toLocaleTimeString('vi-VN');
    }

    // ============================================================
    // Control commands
    // ============================================================
    async function sendControl(body) {
        try {
            const r = await fetch('/api/games/bancung/control', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {})
            });
            if (r.ok) {
                const data = await r.json();
                if (data?.state) { liveState = data.state; renderLive(); }
            }
        } catch (e) { console.warn('[bancung] control fail:', e); }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toast(text, kind) {
        const el = document.createElement('div');
        el.className = 'caro-toast ' + (kind === 'ok' ? 'ok' : 'warn');
        el.textContent = (kind === 'ok' ? '✓ ' : '⚠️ ') + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
    }
    function toastOk(t) { toast(t, 'ok'); }
    function toastWarn(t) { toast(t, 'warn'); }

    window.HpBanCungPanel = { open };
})();

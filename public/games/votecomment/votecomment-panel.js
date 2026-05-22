/* ============================================================
   HP Vote Bình Luận — App-side panel controller
   ============================================================
   Khởi tạo khi user mở view-votecomment trong app.
   Bridge giữa:
     - HpGame.votecomment helpers (defaultConfig, formatClock, rowPoints)
     - Server (POST /api/games/votecomment/config + /control)
     - Socket realtime (votecomment:state)

   Expose: window.HpVoteCommentPanel.open(socket)
   ============================================================ */
(function () {
    'use strict';
    let socket = null;
    let initialized = false;
    let cfg = null;
    let liveState = null;
    let pendingSave = null;
    let clockTimer = null;

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    function open(sharedSocket) {
        socket = sharedSocket;
        showView('view-votecomment');
        if (!initialized) {
            initialized = true;
            bindUI();
        }
        loadConfig().then(() => {
            renderAll();
            ensureClockTick();
        });
        ensureSocketSubscribed();
    }

    function showView(id) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(id)?.classList.add('active');
    }

    function ensureSocketSubscribed() {
        if (!socket) return;
        socket.emit('subscribe', 'preview');
        if (!socket.__vcAttached) {
            socket.__vcAttached = true;
            socket.on('votecomment:state', (st) => {
                liveState = st;
                renderLive();
            });
            socket.on('gameConfig', ({ gameId, config }) => {
                if (gameId !== 'votecomment') return;
                cfg = config;
                renderForm();
            });
        }
    }

    async function loadConfig() {
        try {
            const r = await fetch('/api/games/votecomment/config');
            cfg = r.ok ? await r.json() : window.HpGame.votecomment.defaultConfig();
        } catch (e) {
            cfg = window.HpGame.votecomment.defaultConfig();
        }
        try {
            const r = await fetch('/api/games/votecomment/livestate');
            liveState = r.ok ? await r.json() : null;
        } catch (e) {}
        // Đảm bảo có đủ field default (forward-compat cho config cũ)
        const def = window.HpGame.votecomment.defaultConfig();
        cfg.display = Object.assign({}, def.display, cfg.display || {});
        if (cfg.commentWeight == null) cfg.commentWeight = def.commentWeight;
        if (cfg.giftWeight == null) cfg.giftWeight = def.giftWeight;
        if (cfg.joinByGift == null) cfg.joinByGift = def.joinByGift;
    }

    function scheduleSave() {
        if (pendingSave) clearTimeout(pendingSave);
        pendingSave = setTimeout(saveConfig, 400);
    }

    async function saveConfig() {
        pendingSave = null;
        if (!cfg) return;
        try {
            await fetch('/api/games/votecomment/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            });
        } catch (e) { console.warn('[votecomment] save fail:', e); }
    }

    function bindUI() {
        // Title
        $('#vc-cfg-title').addEventListener('input', (e) => { cfg.title = e.target.value; scheduleSave(); });
        // Duration
        $('#vc-cfg-duration').addEventListener('input', (e) => {
            cfg.durationSec = Math.max(10, Math.min(7200, parseInt(e.target.value, 10) || 300));
            scheduleSave();
        });
        // Points label — tên đơn vị điểm tuỳ chỉnh
        $('#vc-cfg-points-label').addEventListener('input', (e) => {
            cfg.pointsLabel = String(e.target.value || '').slice(0, 20);
            scheduleSave();
        });
        // Trọng số chấm điểm
        $('#vc-cfg-comment-weight').addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            cfg.commentWeight = isFinite(v) && v >= 0 ? Math.min(100, v) : 1;
            scheduleSave();
        });
        $('#vc-cfg-gift-weight').addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            cfg.giftWeight = isFinite(v) && v >= 0 ? Math.min(100, v) : 1;
            scheduleSave();
        });
        // Chọn Phe
        $('#vc-cfg-join-by-gift').addEventListener('change', (e) => {
            cfg.joinByGift = !!e.target.checked;
            scheduleSave();
        });
        // Counting mode (radio)
        $$('input[name="vc-count-mode"]').forEach(r => {
            r.addEventListener('change', () => {
                cfg.countingMode = r.value;
                scheduleSave();
                renderLive();
                updateCountModeWarn();
            });
        });
        // Display controls
        $('#vc-disp-titleSize').addEventListener('input', e => { cfg.display.titleSize = parseInt(e.target.value, 10) || 56; updateSliderLabel('titleSize'); scheduleSave(); });
        $('#vc-disp-itemSize').addEventListener('input', e => { cfg.display.itemSize = parseInt(e.target.value, 10) || 36; updateSliderLabel('itemSize'); scheduleSave(); });
        $('#vc-disp-itemHeight').addEventListener('input', e => { cfg.display.itemHeight = parseInt(e.target.value, 10) || 84; updateSliderLabel('itemHeight'); scheduleSave(); });
        $('#vc-disp-showBar').addEventListener('change', e => { cfg.display.showBar = e.target.checked; scheduleSave(); });
        // Màu + alpha: combine vào rgba(...) khi 1 trong 2 đổi
        const onBgChange = (kind) => {
            const hex = $('#vc-disp-' + kind + 'Bg').value || '#000000';
            const alpha = parseInt($('#vc-disp-' + kind + 'Alpha').value, 10);
            const a = Math.max(0, Math.min(100, isFinite(alpha) ? alpha : 50)) / 100;
            cfg.display[kind + 'Bg'] = hexAlphaToRgba(hex, a);
            $('#vc-disp-' + kind + 'Alpha-val').textContent = Math.round(a * 100) + '%';
            scheduleSave();
        };
        $('#vc-disp-overlayBg').addEventListener('input', () => onBgChange('overlay'));
        $('#vc-disp-overlayAlpha').addEventListener('input', () => onBgChange('overlay'));
        $('#vc-disp-itemBg').addEventListener('input', () => onBgChange('item'));
        $('#vc-disp-itemAlpha').addEventListener('input', () => onBgChange('item'));
        $('#vc-disp-barColor').addEventListener('input', e => { cfg.display.barColor = e.target.value; scheduleSave(); });
        $('#vc-disp-textColor').addEventListener('input', e => { cfg.display.textColor = e.target.value; scheduleSave(); });
        // Add row button
        $('#vc-add-row').addEventListener('click', () => {
            if (!cfg.rows) cfg.rows = [];
            if (cfg.rows.length >= 24) return alert('Tối đa 24 dòng');
            cfg.rows.push(window.HpGame.votecomment.newRow({
                keyword: String(cfg.rows.length + 1),
                label: 'Lựa chọn ' + (cfg.rows.length + 1)
            }));
            renderRows();
            scheduleSave();
        });
        // Toggle Start/Stop (1 nút — đổi theo state.active)
        $('#vc-btn-toggle').addEventListener('click', () => {
            const cmd = liveState?.active ? 'stop' : 'start';
            sendControl(cmd);
        });
        $('#vc-btn-reset').addEventListener('click', () => sendControl('reset'));
        // Save settings (manual flush)
        $('#vc-btn-save').addEventListener('click', async () => {
            if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
            await saveConfig();
            const flash = $('#vc-save-flash');
            if (flash) { flash.hidden = false; clearTimeout(flash.__t); flash.__t = setTimeout(() => { flash.hidden = true; }, 1400); }
        });
        // Master enable toggle
        $('#vc-cfg-enabled').addEventListener('change', e => { cfg.enabled = e.target.checked; scheduleSave(); });
        // Copy overlay URL — hardcoded path, không cần input ẩn
        // v1.0.79 fix: dùng hpCopyText (có fallback execCommand) thay vì navigator.clipboard
        // trực tiếp → tránh silent fail trên 1 số máy khi clipboard API bị từ chối.
        $('#vc-btn-copy').addEventListener('click', async () => {
            const url = location.origin + '/overlay/votecomment';
            const ok = window.hpCopyText ? await window.hpCopyText(url) : false;
            if (ok) flashCopy();
            else alert('Copy thất bại — link: ' + url);
        });
        $('#vc-btn-reload').addEventListener('click', () => {
            // OBS browser source phải tự refresh — gửi tín hiệu chỉ là gợi ý
            socket && socket.emit('overlay:reload');
            if (popoutWindow && !popoutWindow.closed) popoutWindow.location.reload();
        });
        // POPOUT — mở overlay ra window riêng, restore bounds từ localStorage
        $('#vc-btn-popout').addEventListener('click', () => openPopoutWindow());
    }

    let popoutWindow = null;
    function openPopoutWindow() {
        // Nếu đã mở → focus thay vì mở mới
        if (popoutWindow && !popoutWindow.closed) {
            try { popoutWindow.focus(); return; } catch (e) {}
        }
        let bounds = { x: 200, y: 100, w: 1080, h: 700 };
        try {
            const saved = JSON.parse(localStorage.getItem('hp-vc-popout-bounds') || 'null');
            if (saved && typeof saved === 'object') {
                bounds = {
                    x: Math.max(0, Math.min(3000, parseInt(saved.x, 10) || bounds.x)),
                    y: Math.max(0, Math.min(2000, parseInt(saved.y, 10) || bounds.y)),
                    w: Math.max(400, Math.min(4000, parseInt(saved.w, 10) || bounds.w)),
                    h: Math.max(200, Math.min(3000, parseInt(saved.h, 10) || bounds.h))
                };
            }
        } catch (e) {}
        const features = `popup=yes,resizable=yes,scrollbars=no,width=${bounds.w},height=${bounds.h},left=${bounds.x},top=${bounds.y}`;
        popoutWindow = window.open('/overlay/votecomment?popout=1', 'hp-vc-popout', features);
        if (!popoutWindow) {
            alert('Trình duyệt chặn popup. Cho phép popup từ localhost để mở overlay riêng.');
        }
    }

    function flashCopy() {
        const btn = $('#vc-btn-copy');
        const old = btn.textContent;
        btn.textContent = '✓ Đã copy';
        setTimeout(() => { btn.textContent = old; }, 1200);
    }

    function updateCountModeWarn() {
        const el = document.getElementById('vc-count-mode-warn');
        if (!el) return;
        const m = cfg?.countingMode || 'both';
        if (m === 'comments') { el.hidden = false; el.textContent = '⚠ Đang BỎ QUA xu của quà — chỉ đếm bình luận khớp keyword.'; }
        else if (m === 'gifts') { el.hidden = false; el.textContent = '⚠ Đang BỎ QUA bình luận — chỉ đếm xu từ quà.'; }
        else { el.hidden = true; el.textContent = ''; }
    }

    function updateSliderLabel(key) {
        const map = {
            titleSize: { v: cfg.display.titleSize, sfx: 'px', label: 'vc-disp-titleSize-val' },
            itemSize: { v: cfg.display.itemSize, sfx: 'px', label: 'vc-disp-itemSize-val' },
            itemHeight: { v: cfg.display.itemHeight, sfx: 'px', label: 'vc-disp-itemHeight-val' }
        };
        const m = map[key];
        if (!m) return;
        const el = document.getElementById(m.label);
        if (el) el.textContent = m.v + m.sfx;
    }

    function renderForm() {
        if (!cfg) return;
        $('#vc-cfg-enabled').checked = cfg.enabled !== false;
        $('#vc-cfg-title').value = cfg.title || '';
        $('#vc-cfg-duration').value = cfg.durationSec || 300;
        $('#vc-cfg-points-label').value = cfg.pointsLabel || 'ĐIỂM';
        $('#vc-cfg-comment-weight').value = cfg.commentWeight ?? 1;
        $('#vc-cfg-gift-weight').value = cfg.giftWeight ?? 1;
        $('#vc-cfg-join-by-gift').checked = !!cfg.joinByGift;
        $$('input[name="vc-count-mode"]').forEach(r => { r.checked = r.value === (cfg.countingMode || 'both'); });
        updateCountModeWarn();
        $('#vc-disp-titleSize').value = cfg.display.titleSize;
        $('#vc-disp-itemSize').value = cfg.display.itemSize;
        $('#vc-disp-itemHeight').value = cfg.display.itemHeight;
        $('#vc-disp-showBar').checked = cfg.display.showBar !== false;
        $('#vc-disp-overlayBg').value = rgbaToHex(cfg.display.overlayBg) || '#1c1c1c';
        $('#vc-disp-itemBg').value = rgbaToHex(cfg.display.itemBg) || '#8b0000';
        const overlayA = rgbaAlpha(cfg.display.overlayBg || 'rgba(28,28,28,0.55)', 0.55);
        const itemA = rgbaAlpha(cfg.display.itemBg || 'rgba(139,0,0,0.45)', 0.45);
        $('#vc-disp-overlayAlpha').value = Math.round(overlayA * 100);
        $('#vc-disp-itemAlpha').value = Math.round(itemA * 100);
        $('#vc-disp-overlayAlpha-val').textContent = Math.round(overlayA * 100) + '%';
        $('#vc-disp-itemAlpha-val').textContent = Math.round(itemA * 100) + '%';
        $('#vc-disp-barColor').value = cfg.display.barColor || '#ffce4d';
        $('#vc-disp-textColor').value = cfg.display.textColor || '#ffffff';
        updateSliderLabel('titleSize');
        updateSliderLabel('itemSize');
        updateSliderLabel('itemHeight');
    }

    function rgbaToHex(s) {
        if (!s) return '';
        const m = String(s).match(/^#([0-9a-f]{6})/i);
        if (m) return '#' + m[1];
        const rgba = String(s).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (rgba) {
            const hex = (n) => ('0' + (+n).toString(16)).slice(-2);
            return '#' + hex(rgba[1]) + hex(rgba[2]) + hex(rgba[3]);
        }
        return '';
    }
    function rgbaAlpha(s, defaultIfHex = 1) {
        // Extract alpha 0..1 from a CSS color string. For hex (no alpha info) → defaultIfHex.
        if (!s) return defaultIfHex;
        const rgba = String(s).match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/i);
        if (rgba) return Math.max(0, Math.min(1, parseFloat(rgba[1])));
        return defaultIfHex;
    }
    function hexAlphaToRgba(hex, alpha) {
        const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
        if (!m) return `rgba(0,0,0,${alpha})`;
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[1].slice(2, 4), 16);
        const b = parseInt(m[1].slice(4, 6), 16);
        return `rgba(${r},${g},${b},${(+alpha).toFixed(2)})`;
    }

    function renderRows() {
        const host = $('#vc-rows-host');
        if (!host) return;
        host.innerHTML = '';
        (cfg.rows || []).forEach((row, idx) => {
            const live = (liveState?.rows || []).find(r => r.id === row.id);
            const card = document.createElement('div');
            card.className = 'vc-row-card';
            card.dataset.id = row.id;
            const giftBtnLabel = row.giftId
                ? (row.giftImage
                    ? `<img src="${escapeHtml(row.giftImage)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🎁'}))" /><span>${escapeHtml(row.giftName || ('Quà #' + row.giftId))}</span>`
                    : `<span>🎁 ${escapeHtml(row.giftName || ('#' + row.giftId))}</span>`)
                : `<span>🎁 Chọn quà</span>`;
            card.innerHTML = `
                <div class="vc-row-line">
                    <span class="vc-row-pos">${idx + 1}</span>
                    <input class="vc-row-keyword" type="text" placeholder="Từ khoá (vd: 1, A, đỏ)" maxlength="40" value="${escapeHtml(row.keyword || '')}" />
                    <input class="vc-row-label" type="text" placeholder="Nội dung hiển thị" maxlength="120" value="${escapeHtml(row.label || '')}" />
                    <button class="vc-row-giftbtn ghost small ${row.giftId ? 'has-gift' : ''}" title="Chọn quà TikTok cụ thể — chỉ quà này mới cộng XU vào dòng. Bỏ trống = cộng theo last-vote.">${giftBtnLabel}</button>
                    <div class="vc-row-bonus" title="Cộng/trừ điểm thủ công vào dòng — dùng để bù khi cần">
                        <button class="vc-bonus-minus ghost small" title="−1">−</button>
                        <input class="vc-bonus-input" type="number" step="1" value="0" placeholder="0" title="Nhập số rồi bấm + hoặc − để cộng/trừ điểm" />
                        <button class="vc-bonus-plus ghost small" title="+1">＋</button>
                    </div>
                    <button class="vc-row-up ghost small" title="Lên">▲</button>
                    <button class="vc-row-down ghost small" title="Xuống">▼</button>
                    <button class="vc-row-del danger small" title="Xoá">🗑</button>
                </div>
                <div class="vc-row-stats">
                    <span>💬 <b>${live ? (live.comments | 0) : 0}</b> bình luận</span>
                    <span>🎁 <b>${live ? (live.giftXu | 0) : 0}</b> xu</span>
                    <span>✋ <b>${live ? (live.bonus | 0) : 0}</b> bù tay</span>
                    <span class="vc-row-points"></span>
                </div>
            `;
            host.appendChild(card);

            card.querySelector('.vc-row-keyword').addEventListener('input', e => { row.keyword = e.target.value; scheduleSave(); });
            card.querySelector('.vc-row-label').addEventListener('input', e => { row.label = e.target.value; scheduleSave(); });
            card.querySelector('.vc-row-giftbtn').addEventListener('click', () => openGiftPickerModal(row));
            const bonusInput = card.querySelector('.vc-bonus-input');
            card.querySelector('.vc-bonus-plus').addEventListener('click', () => adjustBonus(row.id, +parseInt(bonusInput.value, 10) || 1));
            card.querySelector('.vc-bonus-minus').addEventListener('click', () => adjustBonus(row.id, -(parseInt(bonusInput.value, 10) || 1)));
            card.querySelector('.vc-row-up').addEventListener('click', () => {
                if (idx === 0) return;
                const [m] = cfg.rows.splice(idx, 1); cfg.rows.splice(idx - 1, 0, m); renderRows(); scheduleSave();
            });
            card.querySelector('.vc-row-down').addEventListener('click', () => {
                if (idx >= cfg.rows.length - 1) return;
                const [m] = cfg.rows.splice(idx, 1); cfg.rows.splice(idx + 1, 0, m); renderRows(); scheduleSave();
            });
            card.querySelector('.vc-row-del').addEventListener('click', async () => {
                if (window.hpConfirm) {
                    const ok = await window.hpConfirm({ title: 'Xoá dòng?', message: `Xoá "${row.label || row.keyword || idx + 1}"?`, confirmText: 'Xoá', dangerous: true });
                    if (!ok) return;
                }
                cfg.rows.splice(idx, 1); renderRows(); scheduleSave();
            });
        });
        renderLive();
    }

    function renderLive() {
        // Counter chips in row cards
        const host = $('#vc-rows-host');
        if (!host) return;
        const mode = cfg?.countingMode || 'both';
        const rows = liveState?.rows || [];
        const total = window.HpGame.votecomment.totalPoints(rows, mode);
        $$('.vc-row-card', host).forEach(card => {
            const id = card.dataset.id;
            const live = rows.find(r => r.id === id);
            if (!live) return;
            card.querySelector('.vc-row-stats').innerHTML = `
                <span>💬 <b>${live.comments | 0}</b> bình luận</span>
                <span>🎁 <b>${live.giftXu | 0}</b> xu</span>
                <span class="vc-row-points">${total > 0 ? (window.HpGame.votecomment.rowPoints(live, mode) / total * 100).toFixed(0) : 0}%</span>
            `;
        });
        // Status pill
        const statusEl = $('#vc-status');
        if (statusEl) {
            if (liveState?.active) statusEl.innerHTML = `<span class="vc-pill vc-pill-on">● Đang chạy</span>`;
            else if ((liveState?.rows || []).some(r => (r.comments | 0) + (r.giftXu | 0) > 0)) statusEl.innerHTML = `<span class="vc-pill vc-pill-done">⏸ Kết thúc</span>`;
            else statusEl.innerHTML = `<span class="vc-pill">⏸ Sẵn sàng</span>`;
        }
        // Toggle button: nhãn + style đổi theo trạng thái
        const tgl = $('#vc-btn-toggle');
        if (tgl) {
            if (liveState?.active) {
                tgl.textContent = '⏸ Dừng';
                tgl.className = 'danger vc-btn-toggle';
                tgl.title = 'Dừng tính điểm (giữ kết quả hiển thị)';
            } else {
                tgl.textContent = '▶ Bắt đầu';
                tgl.className = 'primary vc-btn-toggle';
                tgl.title = 'Bắt đầu phiên bình chọn — reset điểm + chạy đồng hồ';
            }
        }
        renderClockDisplay();
    }

    function renderClockDisplay() {
        const clockEl = $('#vc-clock');
        if (!clockEl) return;
        if (liveState?.active) {
            const left = (liveState.endsAt || 0) - Date.now();
            clockEl.textContent = window.HpGame.votecomment.formatClock(Math.max(0, left));
            clockEl.className = left > 0 && left <= 10000 ? 'vc-clock urgent' : 'vc-clock';
        } else if (liveState?.endsAt && (liveState.endsAt < Date.now())) {
            clockEl.textContent = '00:00';
            clockEl.className = 'vc-clock done';
        } else {
            const dur = (cfg?.durationSec || liveState?.durationSec || 0) * 1000;
            clockEl.textContent = window.HpGame.votecomment.formatClock(dur);
            clockEl.className = 'vc-clock';
        }
    }

    function ensureClockTick() {
        if (clockTimer) return;
        clockTimer = setInterval(renderClockDisplay, 300);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ===== Gift picker modal — lazy load giftSheet 1 lần, search + chọn =====
    let giftPickerEl = null;
    function ensureGiftPickerModal() {
        if (giftPickerEl) return giftPickerEl;
        const el = document.createElement('div');
        el.className = 'vc-giftpicker-overlay';
        el.hidden = true;
        el.innerHTML = `
            <div class="vc-giftpicker-modal">
                <div class="vc-giftpicker-head">
                    <div class="vc-giftpicker-title">🎁 Chọn quà TikTok cho dòng</div>
                    <button class="vc-giftpicker-close ghost small" title="Đóng">✕</button>
                </div>
                <input class="vc-giftpicker-search" type="text" placeholder="🔍 Tìm tên quà hoặc ID..." />
                <div class="vc-giftpicker-list"></div>
                <div class="vc-giftpicker-hint">Quà đã chọn sẽ chỉ cộng XU vào dòng này (1 XU = 1 điểm). Bỏ chọn = dùng last-vote: ai comment vote dòng nào, quà của họ vào dòng đó.</div>
            </div>
        `;
        document.body.appendChild(el);
        el.addEventListener('click', e => { if (e.target === el) closeGiftPicker(); });
        el.querySelector('.vc-giftpicker-close').addEventListener('click', closeGiftPicker);
        el.querySelector('.vc-giftpicker-search').addEventListener('input', e => renderGiftPickerList(e.target.value));
        giftPickerEl = el;
        return el;
    }
    let pickerTargetRow = null;
    async function openGiftPickerModal(row) {
        pickerTargetRow = row;
        const el = ensureGiftPickerModal();
        el.hidden = false;
        el.querySelector('.vc-giftpicker-search').value = '';
        // Lazy-load giftSheet nếu chưa có (vd user mở thẳng vào view này, chưa qua Hũ)
        if (!Array.isArray(window.__giftSheet) || !window.__giftSheet.length) {
            try {
                const r = await fetch('/api/gifts');
                if (r.ok) {
                    const list = await r.json();
                    if (Array.isArray(list)) window.__giftSheet = list.slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
                }
            } catch (e) {}
        }
        renderGiftPickerList('');
        setTimeout(() => el.querySelector('.vc-giftpicker-search').focus(), 30);
    }
    function closeGiftPicker() { if (giftPickerEl) giftPickerEl.hidden = true; pickerTargetRow = null; }
    function renderGiftPickerList(filter) {
        const list = giftPickerEl.querySelector('.vc-giftpicker-list');
        list.innerHTML = '';
        const sheet = Array.isArray(window.__giftSheet) ? window.__giftSheet : [];
        const f = String(filter || '').toLowerCase().trim();
        const items = !f ? sheet : sheet.filter(g => (g.name || '').toLowerCase().includes(f) || String(g.id || '').includes(f));
        // Row "Bỏ chọn" sticky
        const noneRow = document.createElement('div');
        noneRow.className = 'vc-giftpicker-row vc-giftpicker-row-none' + (!pickerTargetRow?.giftId ? ' active' : '');
        noneRow.innerHTML = `<span class="vc-gp-icon">✕</span><span class="vc-gp-name">— Bỏ chọn quà (dùng last-vote) —</span>`;
        noneRow.addEventListener('click', () => pickGift(null));
        list.appendChild(noneRow);
        items.slice(0, 200).forEach(g => {
            const sel = pickerTargetRow?.giftId === String(g.id);
            const row = document.createElement('div');
            row.className = 'vc-giftpicker-row' + (sel ? ' active' : '');
            const img = g.image
                ? `<img class="vc-gp-icon-img" src="${escapeHtml(g.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'vc-gp-icon',textContent:'🎁'}))" alt="" />`
                : `<span class="vc-gp-icon">🎁</span>`;
            row.innerHTML = `${img}<span class="vc-gp-name">${escapeHtml(g.name || ('Quà #' + g.id))}</span><span class="vc-gp-dia">${g.diamond || 0}💎</span>`;
            row.addEventListener('click', () => pickGift(g));
            list.appendChild(row);
        });
        if (!items.length && f) {
            const empty = document.createElement('div');
            empty.className = 'vc-giftpicker-empty';
            empty.textContent = 'Không tìm thấy quà — danh sách quà chưa load? Mở Hũ Thuỷ Tinh 1 lần để app fetch sheet.';
            list.appendChild(empty);
        }
    }
    function pickGift(g) {
        if (!pickerTargetRow) return;
        if (!g) {
            pickerTargetRow.giftId = '';
            pickerTargetRow.giftName = '';
            pickerTargetRow.giftImage = '';
        } else {
            pickerTargetRow.giftId = String(g.id);
            pickerTargetRow.giftName = g.name || '';
            pickerTargetRow.giftImage = g.image || '';
        }
        closeGiftPicker();
        renderRows();
        scheduleSave();
    }

    async function adjustBonus(rowId, delta) {
        const d = parseInt(delta, 10) || 0;
        if (d === 0) return;
        try {
            const r = await fetch('/api/games/votecomment/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd: 'adjustBonus', rowId, delta: d })
            });
            if (r.ok) {
                const data = await r.json();
                liveState = data.state || liveState;
                renderLive();
            }
        } catch (e) { console.warn('[votecomment] adjustBonus fail:', e); }
    }

    async function sendControl(cmd) {
        try {
            const r = await fetch('/api/games/votecomment/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd })
            });
            if (r.ok) {
                const data = await r.json();
                liveState = data.state || liveState;
                renderLive();
            }
        } catch (e) { console.warn('[votecomment] control fail:', e); }
    }

    function renderAll() {
        renderForm();
        renderRows();
        renderLive();
    }

    window.HpVoteCommentPanel = { open };
})();

/* ============================================================
   HP Nhiệt Độ (Biểu Cảm) — Panel controller (app side)
   ============================================================
   Tabs:
     1. Cài đặt nhiệt (tăng / giảm / idle / giới hạn)
     2. Hiển thị overlay (vị trí, scale, scheme, toggle layers)
     3. Quà chỉ định (mode specificGifts)
     4. Live preview + test (slider chỉnh nhiệt thủ công, bắn quà thử)

   Server authoritative — panel chỉ POST config + control commands.
   Expose: window.HpNhietDoPanel.open(socket)
   ============================================================ */
(function () {
    'use strict';

    let socket = null;
    let cfg = null;
    let liveState = null;
    let initialized = false;
    let pendingSave = null;
    let currentTab = 'heat';
    let popoutWindow = null;
    let liveTickTimer = null;

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    function open(sharedSocket) {
        socket = sharedSocket || window.io();
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        $('#view-nhietdo')?.classList.add('active');
        if (!initialized) {
            initialized = true;
            bindShell();
            ensureSocketSubscribed();
        }
        // Reset to heat tab on every open (defensive — external CSS/JS may toggle .active)
        currentTab = 'heat';
        document.querySelectorAll('#view-nhietdo .nd-tab').forEach(x => x.classList.toggle('active', x.dataset.ndTab === 'heat'));
        document.querySelectorAll('#view-nhietdo .nd-pane').forEach(p => p.classList.toggle('active', p.dataset.ndPane === 'heat'));
        loadAll().then(() => {
            renderAll();
            ensureLiveTick();
        });
    }

    function ensureSocketSubscribed() {
        if (!socket) return;
        socket.emit('subscribe', 'preview');
        if (socket.__ndAttached) return;
        socket.__ndAttached = true;
        socket.on('nhietdo:state', (s) => {
            liveState = s;
            // Defensive sync — sessionActive có thể đổi từ Quick Launch hoặc client khác.
            // Đồng bộ ngay từ state để button BẮT ĐẦU/KẾT THÚC luôn khớp, kể cả nếu
            // event gameConfig bị miss (rare race condition khi socket reconnect).
            if (cfg && s && typeof s.sessionActive === 'boolean' && cfg.sessionActive !== s.sessionActive) {
                cfg.sessionActive = s.sessionActive;
                updateSessionBtn();
            }
            renderLive();
        });
        socket.on('gameConfig', ({ gameId, config }) => {
            if (gameId !== 'nhietdo') return;
            // Merge thay vì replace để không phá closure trong các tab đang render
            const oldDisplay = cfg ? cfg.display : null;
            cfg = Object.assign({}, cfg || {}, config);
            // Giữ reference object display cho closure (chỉ patch keys)
            if (oldDisplay && config.display) {
                Object.keys(oldDisplay).forEach(k => delete oldDisplay[k]);
                Object.assign(oldDisplay, config.display);
                cfg.display = oldDisplay;
            }
            renderForm();
        });
    }

    async function loadAll() {
        try {
            const r = await fetch('/api/games/nhietdo/config');
            cfg = r.ok ? await r.json() : window.HpGame.nhietdo.defaultConfig();
        } catch (e) {
            cfg = window.HpGame.nhietdo.defaultConfig();
        }
        // Forward-compat: fill defaults
        const def = window.HpGame.nhietdo.defaultConfig();
        cfg = Object.assign({}, def, cfg || {});
        cfg.display = Object.assign({}, def.display, cfg.display || {});
        if (!Array.isArray(cfg.specificGifts)) cfg.specificGifts = [];
        if (!Array.isArray(cfg.coolingGifts)) cfg.coolingGifts = [];
        if (!Array.isArray(cfg.milestones) || !cfg.milestones.length) cfg.milestones = window.HpGame.nhietdo.defaultMilestones();
        if (!cfg.ambientAudio || typeof cfg.ambientAudio !== 'object') cfg.ambientAudio = Object.assign({}, def.ambientAudio);
        try {
            const r = await fetch('/api/games/nhietdo/livestate');
            liveState = r.ok ? await r.json() : null;
        } catch (e) {}
    }

    function schedulePersist() {
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => persistConfig().catch(() => {}), 350);
    }

    async function persistConfig() {
        clearTimeout(pendingSave);
        const r = await fetch('/api/games/nhietdo/config', {
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
    // SHELL — toolbar (copy / popout / reset / enable)
    // ============================================================
    function bindShell() {
        // Tabs
        document.querySelectorAll('#view-nhietdo .nd-tab').forEach(t => {
            t.addEventListener('click', () => {
                document.querySelectorAll('#view-nhietdo .nd-tab').forEach(x => x.classList.remove('active'));
                t.classList.add('active');
                currentTab = t.dataset.ndTab;
                document.querySelectorAll('#view-nhietdo .nd-pane').forEach(p => {
                    p.classList.toggle('active', p.dataset.ndPane === currentTab);
                });
            });
        });
        $('#nd-cfg-enabled')?.addEventListener('change', e => { cfg.enabled = !!e.target.checked; schedulePersist(); });
        // Overlay URL — copy to clipboard
        const url = location.origin + '/overlay/nhietdo';
        $('#nd-btn-copy')?.addEventListener('click', async () => {
            const ok = window.hpCopyText ? await window.hpCopyText(url) : false;
            ok ? toastOk('Đã copy link OBS: ' + url) : toastWarn('Copy thất bại — link: ' + url);
        });
        $('#nd-btn-reload')?.addEventListener('click', () => {
            socket && socket.emit('overlay:reload');
            if (popoutWindow && !popoutWindow.closed) popoutWindow.location.reload();
            toastOk('Đã gửi lệnh reload tới mọi overlay');
        });
        // "Sửa vị trí thanh" mở pin window + edit mode → user kéo title bar di chuyển CỬA SỔ,
        // kéo chuột trong overlay di chuyển THANH NHIỆT (config xPercent/yPercent), cuộn zoom.
        $('#nd-btn-popout-edit')?.addEventListener('click', () => openPopoutWindow(true, true));
        $('#nd-btn-popout-pin')?.addEventListener('click', () => openPopoutWindow(false, true));
        $('#nd-btn-reset')?.addEventListener('click', () => sendControl({ cmd: 'reset' }));
        // BẮT ĐẦU / KẾT THÚC phiên
        $('#nd-btn-session')?.addEventListener('click', async () => {
            const cur = cfg.sessionActive !== false;
            await sendControl({ cmd: cur ? 'stop' : 'start' });
            cfg.sessionActive = !cur;
            updateSessionBtn();
        });
        // 💾 Lưu tất cả — flush ngay, không đợi debounce
        $('#nd-btn-save')?.addEventListener('click', async () => {
            try {
                await persistConfig();
                toastOk('✓ Đã lưu tất cả cài đặt');
            } catch (e) {
                toastWarn('Lưu thất bại: ' + (e?.message || e));
            }
        });
    }

    function updateSessionBtn() {
        const btn = $('#nd-btn-session');
        const status = $('#nd-session-status');
        if (!btn || !cfg) return;
        const active = cfg.sessionActive !== false;
        if (active) {
            btn.textContent = '⏸ KẾT THÚC';
            btn.className = 'danger small';
            btn.title = 'Dừng phiên — overlay ẨN hoàn toàn, quà không tăng nhiệt';
            if (status) { status.textContent = '● Đang chạy'; status.className = 'nd-session-status active'; }
        } else {
            btn.textContent = '▶ BẮT ĐẦU';
            btn.className = 'primary small';
            btn.title = 'Bắt đầu phiên — overlay nhận quà + hiển thị';
            if (status) { status.textContent = '⏸ Đã dừng'; status.className = 'nd-session-status stopped'; }
        }
    }

    function openPopoutWindow(editMode, pinMode) {
        // Pin mode: Electron main process intercepts the URL → creates a NEW always-on-top window.
        // For pin mode we don't reuse popoutWindow (Electron handles its own lifecycle).
        if (pinMode) {
            // window.open trigger → electron-main setWindowOpenHandler bắt URL có pin=1
            const params = ['pin=1'];
            if (editMode) params.push('edit=1');
            window.open('/overlay/nhietdo?' + params.join('&'), '_blank');
            return;
        }
        if (popoutWindow && !popoutWindow.closed) {
            try { popoutWindow.focus(); } catch (e) {}
            const wantEdit = !!editMode;
            const curUrl = popoutWindow.location.href || '';
            const curEdit = /\bedit=1\b/.test(curUrl);
            if (wantEdit !== curEdit) {
                popoutWindow.location.href = '/overlay/nhietdo' + (wantEdit ? '?edit=1' : '');
            }
            return;
        }
        let b = { x: 200, y: 100, w: 540, h: 960 };
        try {
            const saved = JSON.parse(localStorage.getItem('hp-nd-popout-bounds') || 'null');
            if (saved) Object.assign(b, saved);
        } catch (e) {}
        const features = `popup=yes,resizable=yes,scrollbars=no,width=${b.w},height=${b.h},left=${b.x},top=${b.y}`;
        popoutWindow = window.open('/overlay/nhietdo' + (editMode ? '?edit=1' : ''), 'hp-nd-popout', features);
        if (!popoutWindow) toastWarn('Trình duyệt chặn popup — cho phép popup từ localhost');
    }

    // ============================================================
    // RENDER
    // ============================================================
    function renderAll() {
        renderForm();
        renderHeatTab();
        renderDisplayTab();
        renderGiftsTab();
        renderMilestonesTab();
        renderAudioTab();
        renderLive();
    }
    function renderForm() {
        if (!cfg) return;
        const en = $('#nd-cfg-enabled'); if (en) en.checked = cfg.enabled !== false;
        updateSessionBtn();
    }

    // ----- Tab 1: HEAT -----
    function renderHeatTab() {
        const host = $('#nd-heat-pane');
        if (!host || cfg == null) return;
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🔥 Cách TĂNG nhiệt</div>
                <div class="nd-row">
                    <label class="nd-radio"><input type="radio" name="nd-heat-mode" value="perCoin" ${cfg.heatMode === 'perCoin' ? 'checked' : ''} /> Theo XU quà</label>
                    <label class="nd-radio"><input type="radio" name="nd-heat-mode" value="perGift" ${cfg.heatMode === 'perGift' ? 'checked' : ''} /> Theo MỖI QUÀ</label>
                    <label class="nd-radio"><input type="radio" name="nd-heat-mode" value="specificGifts" ${cfg.heatMode === 'specificGifts' ? 'checked' : ''} /> Chỉ QUÀ CHỈ ĐỊNH</label>
                </div>
                <div class="nd-mode-perCoin" ${cfg.heatMode === 'perCoin' ? '' : 'hidden'}>
                    <label class="nd-inline">1 xu = <input type="number" id="nd-perCoinDeg" min="0" step="0.05" value="${cfg.perCoinDegrees ?? 0.5}" /> °C</label>
                    <div class="nd-hint">VD: 0.5°C/xu → 200 xu (hoa hồng) tăng 100°C, 1 xu (rose nhỏ) +0.5°C.</div>
                </div>
                <div class="nd-mode-perGift" ${cfg.heatMode === 'perGift' ? '' : 'hidden'}>
                    <label class="nd-inline">Mỗi quà bất kỳ +<input type="number" id="nd-perGiftDeg" min="0" step="0.5" value="${cfg.perGiftDegrees ?? 5}" /> °C</label>
                    <div class="nd-hint">Áp dụng cho mọi loại quà — bỏ qua giá xu. 1 combo (repeatCount=5) tính 5 quà.</div>
                </div>
                <div class="nd-mode-specificGifts" ${cfg.heatMode === 'specificGifts' ? '' : 'hidden'}>
                    <div class="nd-hint">Chỉ những quà trong tab "Quà chỉ định" mới làm tăng nhiệt. Mỗi quà có mức tăng riêng.</div>
                    <button class="ghost small" id="nd-jump-specific">→ Sang tab Quà chỉ định</button>
                </div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">❄ Cách GIẢM nhiệt (auto)</div>
                <label class="nd-inline">Giảm <input type="number" id="nd-decay" min="0" step="0.1" value="${cfg.decayPerSecond ?? 1}" /> °C / giây</label>
                <label class="nd-inline">Bắt đầu giảm sau <input type="number" id="nd-idle" min="0" step="1" value="${cfg.idleSeconds ?? 5}" /> giây không có quà</label>
                <label class="nd-inline">Kiểu giảm
                    <select id="nd-decayShape">
                        <option value="linear" ${cfg.decayShape === 'linear' ? 'selected' : ''}>Tuyến tính (đều)</option>
                        <option value="easeOut" ${cfg.decayShape === 'easeOut' ? 'selected' : ''}>Dịu dần (chậm khi gần 0)</option>
                    </select>
                </label>
                <div class="nd-hint">VD: 1°C/s + idle 5s → quà cuối tặng 7s trước → đã giảm 2°C.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">📏 Giới hạn nhiệt độ</div>
                <label class="nd-inline">Min <input type="number" id="nd-tempMin" min="-50" max="100" step="1" value="${cfg.tempMin ?? 0}" /> °C</label>
                <label class="nd-inline">Max <input type="number" id="nd-tempMax" min="10" max="500" step="1" value="${cfg.tempMax ?? 100}" /> °C</label>
                <label class="nd-inline">Nhiệt khởi đầu khi RESET <input type="number" id="nd-initialTemp" min="0" step="1" value="${cfg.initialTemp ?? 0}" /> °C</label>
            </div>
        `;
        // Wire
        $$('input[name="nd-heat-mode"]', host).forEach(r => r.addEventListener('change', () => {
            cfg.heatMode = r.value;
            renderHeatTab();
            schedulePersist();
        }));
        $('#nd-perCoinDeg', host)?.addEventListener('input', e => { cfg.perCoinDegrees = parseFloat(e.target.value) || 0; schedulePersist(); });
        $('#nd-perGiftDeg', host)?.addEventListener('input', e => { cfg.perGiftDegrees = parseFloat(e.target.value) || 0; schedulePersist(); });
        $('#nd-decay', host)?.addEventListener('input', e => { cfg.decayPerSecond = Math.max(0, parseFloat(e.target.value) || 0); schedulePersist(); });
        $('#nd-idle', host)?.addEventListener('input', e => { cfg.idleSeconds = Math.max(0, parseInt(e.target.value, 10) || 0); schedulePersist(); });
        $('#nd-decayShape', host)?.addEventListener('change', e => { cfg.decayShape = e.target.value; schedulePersist(); });
        $('#nd-tempMin', host)?.addEventListener('input', e => { cfg.tempMin = parseFloat(e.target.value) || 0; schedulePersist(); });
        $('#nd-tempMax', host)?.addEventListener('input', e => { cfg.tempMax = Math.max(10, parseFloat(e.target.value) || 100); schedulePersist(); });
        $('#nd-initialTemp', host)?.addEventListener('input', e => { cfg.initialTemp = parseFloat(e.target.value) || 0; schedulePersist(); });
        $('#nd-jump-specific', host)?.addEventListener('click', () => {
            document.querySelector('#view-nhietdo .nd-tab[data-nd-tab="gifts"]')?.click();
        });
    }

    // ----- Tab 2: DISPLAY -----
    function renderDisplayTab() {
        const host = $('#nd-display-pane');
        if (!host || cfg == null) return;
        const d = cfg.display;
        const schemeList = (window.HpGame.nhietdo.SCHEME_LIST || []);
        const schemeRadios = schemeList.map(s => `
            <label class="nd-radio nd-scheme-radio" title="Đối tượng gợi ý: ${s.target}">
                <input type="radio" name="nd-scheme" value="${s.id}" ${d.colorScheme === s.id ? 'checked' : ''} />
                <span class="nd-scheme-emoji">${s.emoji}</span>
                <span class="nd-scheme-label">${s.label}</span>
                <span class="nd-scheme-target">${s.target}</span>
            </label>
        `).join('');
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🎨 Phong cách (12 chủ đề — phù hợp NAM / NỮ / NPC)</div>
                <div class="nd-scheme-grid">
                    ${schemeRadios}
                </div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">📐 Vị trí &amp; kích thước thanh nhiệt</div>
                <label class="nd-inline">X (ngang) <input type="range" id="nd-x" min="0" max="100" step="1" value="${d.xPercent ?? 50}" /><span id="nd-x-v">${d.xPercent ?? 50}%</span></label>
                <label class="nd-inline">Y (dọc) <input type="range" id="nd-y" min="0" max="100" step="1" value="${d.yPercent ?? 50}" /><span id="nd-y-v">${d.yPercent ?? 50}%</span></label>
                <label class="nd-inline">Scale <input type="range" id="nd-scale" min="30" max="250" step="5" value="${d.scale ?? 100}" /><span id="nd-scale-v">${d.scale ?? 100}%</span></label>
                <div class="nd-hint">💡 Hoặc bấm <b>🪟 Mở overlay (Sửa)</b> rồi <b>kéo chuột</b> để di chuyển, <b>cuộn chuột</b> để zoom.</div>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">👁 Hiện / ẩn lớp</div>
                <label class="nd-inline"><input type="checkbox" id="nd-showThermo" ${d.showThermo !== false ? 'checked' : ''} /> Khung thanh nhiệt kế</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showLabel" ${d.showLabel !== false ? 'checked' : ''} /> Chữ "NHIỆT ĐỘ"</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showDegrees" ${d.showDegrees !== false ? 'checked' : ''} /> Số °C trên bầu</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showEmoji" ${d.showEmoji !== false ? 'checked' : ''} /> Emoji biểu cảm</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showFloatGain" ${d.showFloatGain !== false ? 'checked' : ''} /> +X°C bay lên khi nhận quà</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showFireEffect" ${d.showFireEffect !== false ? 'checked' : ''} /> Hiệu ứng lửa toàn màn</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showHaze" ${d.showHaze !== false ? 'checked' : ''} /> Hơi nóng (méo nền)</label>
                <label class="nd-inline"><input type="checkbox" id="nd-shakeAtMax" ${d.shakeAtMax !== false ? 'checked' : ''} /> Rung màn khi ≥ 95°C</label>
                <label class="nd-inline"><input type="checkbox" id="nd-showTopContrib" ${d.showTopContrib !== false ? 'checked' : ''} /> 🏆 Bảng top contributor</label>
                <label class="nd-inline">Góc bảng top
                    <select id="nd-topPos">
                        <option value="top-left" ${(d.topContribPos || 'top-left') === 'top-left' ? 'selected' : ''}>Trên-trái</option>
                        <option value="top-right" ${d.topContribPos === 'top-right' ? 'selected' : ''}>Trên-phải</option>
                        <option value="bottom-left" ${d.topContribPos === 'bottom-left' ? 'selected' : ''}>Dưới-trái</option>
                        <option value="bottom-right" ${d.topContribPos === 'bottom-right' ? 'selected' : ''}>Dưới-phải</option>
                    </select>
                </label>
            </div>

            <div class="nd-card">
                <div class="nd-card-title">🎚 Cường độ hiệu ứng tổng</div>
                <label class="nd-inline">Intensity <input type="range" id="nd-fx" min="0" max="150" step="5" value="${d.fxIntensity ?? 100}" /><span id="nd-fx-v">${d.fxIntensity ?? 100}%</span></label>
                <div class="nd-hint">Nhân chung cho tint, hơi nóng, lửa, tàn lửa. 0% = tắt mọi hiệu ứng (giữ thanh nhiệt).</div>
            </div>
            <div class="nd-card">
                <div class="nd-card-title">💬 Kích thước CHỮ ticker mốc thưởng</div>
                <label class="nd-inline">Ticker scale <input type="range" id="nd-tickerScale" min="30" max="150" step="5" value="${d.tickerScale ?? 60}" /><span id="nd-tickerScale-v">${d.tickerScale ?? 60}%</span></label>
                <div class="nd-hint">100% ≈ 64px font. Mặc định 60% phù hợp khu vực OBS portrait 1080×1920. Tăng lên nếu muốn chiếm full màn.</div>
            </div>
        `;
        // Wire
        $$('input[name="nd-scheme"]', host).forEach(r => r.addEventListener('change', () => {
            d.colorScheme = r.value; schedulePersist();
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
        wireRange('nd-x', 'xPercent', '%');
        wireRange('nd-y', 'yPercent', '%');
        wireRange('nd-scale', 'scale', '%');
        wireRange('nd-fx', 'fxIntensity', '%');
        wireRange('nd-tickerScale', 'tickerScale', '%');
        const wireToggle = (id, key) => $('#' + id, host)?.addEventListener('change', e => { d[key] = !!e.target.checked; schedulePersist(); });
        wireToggle('nd-showThermo', 'showThermo');
        wireToggle('nd-showLabel', 'showLabel');
        wireToggle('nd-showDegrees', 'showDegrees');
        wireToggle('nd-showEmoji', 'showEmoji');
        wireToggle('nd-showFloatGain', 'showFloatGain');
        wireToggle('nd-showFireEffect', 'showFireEffect');
        wireToggle('nd-showHaze', 'showHaze');
        wireToggle('nd-shakeAtMax', 'shakeAtMax');
        wireToggle('nd-showTopContrib', 'showTopContrib');
        $('#nd-topPos', host)?.addEventListener('change', e => { d.topContribPos = e.target.value; schedulePersist(); });
    }

    // ----- Tab 3: SPECIFIC GIFTS (heating + cooling) -----
    function renderGiftsTab() {
        const host = $('#nd-gifts-pane');
        if (!host || cfg == null) return;
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🔥 Quà TĂNG nhiệt</div>
                <div class="nd-hint">
                    Khi <b>Cách tăng nhiệt = "Chỉ quà chỉ định"</b>, chỉ các quà trong danh sách này mới làm tăng nhiệt.
                    Mỗi quà có mức tăng riêng (°C / lần tặng × repeatCount).
                </div>
                <div class="nd-row">
                    <button class="primary small" id="nd-gift-add">➕ Thêm quà tăng</button>
                    <button class="ghost small" id="nd-gift-clear">🗑 Xoá tất cả</button>
                </div>
                <div id="nd-gifts-list" class="nd-gifts-list"></div>
            </div>
            <div class="nd-card">
                <div class="nd-card-title">❄ Quà LÀM MÁT (giảm nhiệt)</div>
                <div class="nd-hint">
                    Quà trong danh sách này sẽ <b>GIẢM</b> nhiệt độ mỗi lần được tặng.
                    Hoạt động ở <b>mọi chế độ tăng nhiệt</b> (luôn ưu tiên hơn quà tăng nếu user tặng đồng thời).
                    Dùng để tạo thế đối kháng: nhóm khán giả đẩy nhiệt vs nhóm hạ nhiệt.
                </div>
                <div class="nd-row">
                    <button class="primary small" id="nd-cool-add">➕ Thêm quà mát</button>
                    <button class="ghost small" id="nd-cool-clear">🗑 Xoá tất cả</button>
                </div>
                <div id="nd-cool-list" class="nd-gifts-list"></div>
            </div>
        `;
        renderHeatingList();
        renderCoolingList();
        $('#nd-gift-add', host).addEventListener('click', () => openGiftPicker('heating'));
        $('#nd-cool-add', host).addEventListener('click', () => openGiftPicker('cooling'));
        $('#nd-gift-clear', host).addEventListener('click', async () => {
            const ok = window.hpConfirm
                ? await window.hpConfirm({ title: 'Xoá tất cả quà tăng?', confirmText: 'Xoá', dangerous: true })
                : confirm('Xoá tất cả quà tăng?');
            if (!ok) return;
            cfg.specificGifts = [];
            renderHeatingList();
            persistConfig();
        });
        $('#nd-cool-clear', host).addEventListener('click', async () => {
            const ok = window.hpConfirm
                ? await window.hpConfirm({ title: 'Xoá tất cả quà mát?', confirmText: 'Xoá', dangerous: true })
                : confirm('Xoá tất cả quà mát?');
            if (!ok) return;
            cfg.coolingGifts = [];
            renderCoolingList();
            persistConfig();
        });
    }
    function renderHeatingList() { _renderGiftList('#nd-gifts-list', cfg.specificGifts, '+', () => renderHeatingList(), 'specificGifts'); }
    function renderCoolingList() { _renderGiftList('#nd-cool-list',  cfg.coolingGifts,  '−', () => renderCoolingList(), 'coolingGifts'); }
    function _renderGiftList(sel, list, sign, rerender, key) {
        const wrap = document.querySelector(sel);
        if (!wrap) return;
        if (!list || !list.length) {
            wrap.innerHTML = `<div class="nd-empty">Chưa có quà nào.</div>`;
            return;
        }
        wrap.innerHTML = list.map((g, i) => `
            <div class="nd-gift-row" data-idx="${i}">
                ${g.giftImage ? `<img class="nd-gift-icon" src="${escapeHtml(g.giftImage)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🎁',className:'nd-gift-icon'}))" />` : `<span class="nd-gift-icon">🎁</span>`}
                <span class="nd-gift-name">${escapeHtml(g.giftName || ('Quà #' + g.giftId))}</span>
                <span class="nd-gift-id">ID: ${escapeHtml(g.giftId || '?')}</span>
                <label class="nd-inline">${sign}<input type="number" class="nd-gift-deg" min="0" step="0.5" value="${g.degrees ?? 5}" /> °C / lần</label>
                <button class="danger small nd-gift-del">🗑</button>
            </div>
        `).join('');
        wrap.querySelectorAll('.nd-gift-row').forEach(row => {
            const idx = parseInt(row.dataset.idx, 10);
            row.querySelector('.nd-gift-deg')?.addEventListener('input', e => {
                cfg[key][idx].degrees = Math.max(0, parseFloat(e.target.value) || 0);
                schedulePersist();
            });
            row.querySelector('.nd-gift-del')?.addEventListener('click', () => {
                cfg[key].splice(idx, 1);
                rerender();
                persistConfig();
            });
        });
    }
    let _pickerMode = 'heating';   // 'heating' | 'cooling'
    async function openGiftPicker(mode) {
        _pickerMode = mode || 'heating';
        if (!Array.isArray(window.__giftSheet) || !window.__giftSheet.length) {
            try {
                const r = await fetch('/api/gifts');
                if (r.ok) window.__giftSheet = (await r.json()).slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
            } catch (e) {}
        }
        const el = ensureGiftPicker();
        el.hidden = false;
        el.querySelector('.nd-gp-search').value = '';
        const titleEl = el.querySelector('.nd-gp-title');
        if (titleEl) titleEl.textContent = _pickerMode === 'cooling' ? '❄ Chọn quà LÀM MÁT' : '🔥 Chọn quà TĂNG nhiệt';
        renderPickerList('');
        setTimeout(() => el.querySelector('.nd-gp-search').focus(), 30);
    }
    let _pickerEl = null;
    function ensureGiftPicker() {
        if (_pickerEl) return _pickerEl;
        const el = document.createElement('div');
        el.className = 'nd-gp-overlay';
        el.hidden = true;
        el.innerHTML = `
            <div class="nd-gp-modal">
                <div class="nd-gp-head">
                    <div class="nd-gp-title">🎁 Chọn quà tăng nhiệt</div>
                    <button class="nd-gp-close ghost small">✕</button>
                </div>
                <input class="nd-gp-search" type="text" placeholder="🔍 Tìm tên quà hoặc ID..." />
                <div class="nd-gp-list"></div>
                <div class="nd-gp-hint">Quà chọn sẽ được thêm vào danh sách với mức tăng mặc định 5°C — có thể chỉnh ngay sau.</div>
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
        const targetKey = (_pickerMode === 'cooling') ? 'coolingGifts' : 'specificGifts';
        const used = new Set((cfg[targetKey] || []).map(g => String(g.giftId)));
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
                cfg[targetKey] = cfg[targetKey] || [];
                cfg[targetKey].push({ giftId: id, giftName: r.dataset.gn, giftImage: r.dataset.gi, degrees: 5 });
                if (_pickerMode === 'cooling') renderCoolingList(); else renderHeatingList();
                persistConfig();
                _pickerEl.hidden = true;
            });
        });
    }

    // ============================================================
    // Tab 4: MILESTONES — mốc thưởng (kèm media + ticker)
    // ============================================================
    function renderMilestonesTab() {
        const host = $('#nd-milestones-pane');
        if (!host || cfg == null) return;
        const list = cfg.milestones || [];
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🎯 Mốc thưởng nhiệt độ</div>
                <div class="nd-hint">
                    Khi nhiệt độ <b>vượt qua</b> mốc, overlay sẽ hiện <b>chữ ticker</b> + phát <b>video/âm thanh</b> bạn upload (nếu có).
                    Mỗi mốc chỉ fire 1 lần cho đến khi nhiệt giảm xuống dưới rồi lên lại (chống spam khi nhiệt dao động).
                </div>
                <div class="nd-row">
                    <button class="primary small" id="nd-ms-add">➕ Thêm mốc</button>
                    <button class="ghost small" id="nd-ms-reset">↺ Reset mặc định (25/50/75/100)</button>
                </div>
                <div id="nd-ms-list" class="nd-ms-list"></div>
            </div>
        `;
        renderMilestonesList();
        $('#nd-ms-add', host).addEventListener('click', () => {
            cfg.milestones = cfg.milestones || [];
            cfg.milestones.push({ temp: 50, label: 'Mốc mới', tickerText: '🔥 50°C!', mediaUrl: '', mediaName: '', mediaType: '', volume: 80, enabled: true });
            renderMilestonesList();
            schedulePersist();
        });
        $('#nd-ms-reset', host).addEventListener('click', async () => {
            const ok = window.hpConfirm
                ? await window.hpConfirm({ title: 'Reset danh sách mốc?', confirmText: 'Reset' })
                : confirm('Reset 4 mốc mặc định (25/50/75/100)?');
            if (!ok) return;
            cfg.milestones = window.HpGame.nhietdo.defaultMilestones();
            renderMilestonesList();
            persistConfig();
        });
    }
    function renderMilestonesList() {
        const wrap = $('#nd-ms-list');
        if (!wrap) return;
        const list = cfg.milestones || [];
        if (!list.length) {
            wrap.innerHTML = `<div class="nd-empty">Chưa có mốc nào. Bấm "➕ Thêm mốc".</div>`;
            return;
        }
        // Sort ascending by temp for visual
        const sorted = list.map((m, i) => ({ m, i })).sort((a, b) => (a.m.temp || 0) - (b.m.temp || 0));
        wrap.innerHTML = sorted.map(({ m, i }) => {
            const hasFile = !!m.mediaUrl;
            const fname = m.mediaName || (m.mediaUrl ? m.mediaUrl.split('/').pop() : '');
            const badge = hasFile ? (m.mediaType === 'video' ? '🎞 VIDEO' : (m.mediaType === 'audio' ? '🔊 ÂM' : (m.mediaType === 'image' ? '🖼 ẢNH' : '📄'))) : '';
            return `
            <div class="nd-ms-card${m.enabled === false ? ' disabled' : ''}" data-idx="${i}">
                <div class="nd-ms-head">
                    <label class="nd-inline">Nhiệt độ <input type="number" class="nd-ms-temp" min="0" max="500" step="1" value="${m.temp ?? 50}" /> °C</label>
                    <label class="nd-inline nd-ms-label-wrap">Nhãn <input type="text" class="nd-ms-label" maxlength="60" value="${escapeHtml(m.label || '')}" placeholder="VD: 50°C — Nóng!" /></label>
                    <label class="nd-inline"><input type="checkbox" class="nd-ms-enabled" ${m.enabled !== false ? 'checked' : ''} /> Bật</label>
                    <button class="danger small nd-ms-del">🗑</button>
                </div>
                <label class="nd-inline nd-ms-ticker-wrap">💬 Chữ chạy ngang <input type="text" class="nd-ms-ticker" maxlength="100" value="${escapeHtml(m.tickerText || '')}" placeholder="🔥 50°C — NÓNG QUÁ!" /></label>
                <div class="nd-ms-file">
                    ${hasFile
                        ? `<span class="nd-file-badge">${badge}</span><span class="nd-file-name">${escapeHtml(fname)}</span>`
                        : '<span class="nd-file-empty">Chưa có file media — bấm "📁 Chọn" để upload video/âm thanh/ảnh</span>'
                    }
                </div>
                <div class="nd-ms-row">
                    <label class="nd-inline">🔊 Volume <input type="range" class="nd-ms-vol" min="0" max="100" step="5" value="${m.volume ?? 80}" /><span class="nd-ms-vol-v">${m.volume ?? 80}%</span></label>
                    <button class="ghost small nd-ms-pick">📁 Chọn file</button>
                    <button class="primary small nd-ms-test">▶ TEST</button>
                    ${hasFile ? '<button class="danger small nd-ms-clear">🗑 Xoá file</button>' : ''}
                </div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('.nd-ms-card').forEach(card => {
            const idx = parseInt(card.dataset.idx, 10);
            const get = () => cfg.milestones[idx];
            card.querySelector('.nd-ms-temp')?.addEventListener('input', e => { get().temp = Math.max(0, parseFloat(e.target.value) || 0); schedulePersist(); });
            card.querySelector('.nd-ms-label')?.addEventListener('input', e => { get().label = e.target.value; schedulePersist(); });
            card.querySelector('.nd-ms-ticker')?.addEventListener('input', e => { get().tickerText = e.target.value; schedulePersist(); });
            card.querySelector('.nd-ms-enabled')?.addEventListener('change', e => {
                get().enabled = !!e.target.checked;
                card.classList.toggle('disabled', !e.target.checked);
                schedulePersist();
            });
            const vol = card.querySelector('.nd-ms-vol');
            const volV = card.querySelector('.nd-ms-vol-v');
            vol?.addEventListener('input', () => { get().volume = +vol.value; if (volV) volV.textContent = vol.value + '%'; schedulePersist(); });
            card.querySelector('.nd-ms-pick')?.addEventListener('click', () => pickMilestoneFile(idx));
            card.querySelector('.nd-ms-clear')?.addEventListener('click', () => {
                const m = get(); if (!m.mediaUrl) return;
                m.mediaUrl = ''; m.mediaName = ''; m.mediaType = '';
                renderMilestonesList();
                persistConfig();
            });
            card.querySelector('.nd-ms-test')?.addEventListener('click', () => sendControl({ cmd: 'testMilestone', index: idx }));
            card.querySelector('.nd-ms-del')?.addEventListener('click', async () => {
                const ok = window.hpConfirm
                    ? await window.hpConfirm({ title: 'Xoá mốc?', confirmText: 'Xoá', dangerous: true })
                    : confirm('Xoá mốc?');
                if (!ok) return;
                cfg.milestones.splice(idx, 1);
                renderMilestonesList();
                persistConfig();
            });
        });
    }
    function pickMilestoneFile(idx) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,image/png,image/jpeg,image/gif,.mp4,.webm,.mp3,.wav,.ogg,.m4a,.png,.jpg,.jpeg,.gif';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = async () => {
            const f = inp.files?.[0]; inp.remove();
            if (!f) return;
            const m = cfg.milestones[idx]; if (!m) return;
            await uploadFile(f, (meta) => {
                m.mediaUrl = meta.url;
                m.mediaName = f.name;
                m.mediaType = meta.type;
            }, () => renderMilestonesList());
        };
        inp.click();
    }

    // ============================================================
    // Tab 5: AMBIENT AUDIO — âm thanh nền loop, volume scale theo nhiệt
    // ============================================================
    function renderAudioTab() {
        const host = $('#nd-audio-pane');
        if (!host || cfg == null) return;
        const a = cfg.ambientAudio || {};
        const has = !!a.url;
        host.innerHTML = `
            <div class="nd-card">
                <div class="nd-card-title">🎵 Âm thanh nền (loop)</div>
                <div class="nd-hint">
                    Phát một file âm thanh lặp lại trong suốt phiên. Mặc định, volume sẽ tăng dần theo nhiệt độ
                    (0°C = im lặng, 100°C = volume max). Bỏ tick "Theo nhiệt" để giữ volume cố định.
                </div>
                <div class="nd-ms-file">
                    ${has
                        ? `<span class="nd-file-badge">🔊 ÂM</span><span class="nd-file-name">${escapeHtml(a.name || a.url.split('/').pop())}</span>`
                        : '<span class="nd-file-empty">Chưa có file — bấm "📁 Chọn" để upload mp3/wav/ogg</span>'
                    }
                </div>
                <div class="nd-row">
                    <button class="ghost small" id="nd-amb-pick">📁 Chọn file</button>
                    ${has ? '<button class="danger small" id="nd-amb-clear">🗑 Xoá</button>' : ''}
                </div>
                <label class="nd-inline">🔊 Volume tối đa <input type="range" id="nd-amb-vol" min="0" max="100" step="5" value="${a.volume ?? 50}" /><span id="nd-amb-vol-v">${a.volume ?? 50}%</span></label>
                <label class="nd-inline"><input type="checkbox" id="nd-amb-react" ${a.reactToHeat !== false ? 'checked' : ''} /> Volume tăng theo nhiệt độ (recommended)</label>
            </div>
        `;
        $('#nd-amb-pick', host)?.addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg,.m4a';
            inp.onchange = async () => {
                const f = inp.files?.[0]; if (!f) return;
                await uploadFile(f, (meta) => {
                    cfg.ambientAudio = cfg.ambientAudio || {};
                    cfg.ambientAudio.url = meta.url;
                    cfg.ambientAudio.name = f.name;
                }, () => renderAudioTab());
            };
            inp.click();
        });
        $('#nd-amb-clear', host)?.addEventListener('click', () => {
            cfg.ambientAudio.url = ''; cfg.ambientAudio.name = '';
            renderAudioTab(); persistConfig();
        });
        const vol = $('#nd-amb-vol', host);
        const volV = $('#nd-amb-vol-v', host);
        vol?.addEventListener('input', () => {
            cfg.ambientAudio = cfg.ambientAudio || {};
            cfg.ambientAudio.volume = +vol.value;
            if (volV) volV.textContent = vol.value + '%';
            schedulePersist();
        });
        $('#nd-amb-react', host)?.addEventListener('change', e => {
            cfg.ambientAudio = cfg.ambientAudio || {};
            cfg.ambientAudio.reactToHeat = !!e.target.checked;
            schedulePersist();
        });
    }

    // ============================================================
    // Upload helper — POST raw bytes to /api/games/nhietdo/upload
    // ============================================================
    async function uploadFile(file, applyMeta, onDone) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a', 'png', 'jpg', 'jpeg', 'gif'].includes(ext)) {
            toastWarn('Chỉ chấp nhận: mp4, webm, mp3, wav, ogg, m4a, png, jpg, gif');
            return;
        }
        if (file.size > 30 * 1024 * 1024) { toastWarn('File quá 30MB — vui lòng nén'); return; }
        try {
            const url = `/api/games/nhietdo/upload?ext=${encodeURIComponent(ext)}`;
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file
            });
            const json = await r.json();
            if (!r.ok || !json.ok) throw new Error(json?.error || 'upload_fail');
            const type = ['mp4', 'webm'].includes(ext) ? 'video'
                       : ['png', 'jpg', 'jpeg', 'gif'].includes(ext) ? 'image'
                       : 'audio';
            applyMeta({ url: json.url, type });
            await persistConfig();
            if (typeof onDone === 'function') onDone();
            toastOk(`Đã tải lên ${file.name}`);
        } catch (e) {
            toastWarn('Lỗi upload: ' + e.message);
        }
    }

    // ----- Live preview block at bottom -----
    function renderLive() {
        const host = $('#nd-live-pane');
        if (!host || cfg == null) return;
        if (!host.dataset.wired) {
            host.dataset.wired = '1';
            host.innerHTML = `
                <div class="nd-card">
                    <div class="nd-card-title">🌡 Nhiệt độ hiện tại <span id="nd-live-status">—</span></div>
                    <div class="nd-live-row">
                        <div class="nd-bigtemp" id="nd-live-bigtemp">0°</div>
                        <div class="nd-live-meta">
                            <div>Stage: <b id="nd-live-stage">—</b></div>
                            <div>Idle: <span id="nd-live-idle">—</span></div>
                            <div>Cập nhật: <span id="nd-live-since">—</span></div>
                        </div>
                    </div>
                    <div class="nd-live-bar"><div class="nd-live-bar-fill" id="nd-live-bar"></div></div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🎮 Điều khiển thủ công</div>
                    <div class="nd-row">
                        <button class="primary small" id="nd-ctl-add5">+5°C</button>
                        <button class="primary small" id="nd-ctl-add10">+10°C</button>
                        <button class="primary small" id="nd-ctl-add25">+25°C</button>
                        <button class="ghost small" id="nd-ctl-sub5">−5°C</button>
                        <button class="ghost small" id="nd-ctl-sub25">−25°C</button>
                        <button class="danger small" id="nd-ctl-reset">↺ Reset về ${cfg.initialTemp ?? 0}°</button>
                        <button class="danger small" id="nd-ctl-max">🔥 Đẩy max</button>
                    </div>
                    <label class="nd-inline">Đặt nhiệt độ trực tiếp <input type="range" id="nd-ctl-slider" min="0" max="100" step="1" value="0" /><span id="nd-ctl-slider-v">0°</span></label>
                    <div class="nd-hint">Slider gửi lệnh "setTemp" tới server — dùng để test hiệu ứng tại từng mức nhiệt.</div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🧪 Bắn quà thử (giả lập)</div>
                    <div class="nd-row">
                        <label class="nd-inline">Xu / quà <input id="nd-test-coins" type="number" min="1" value="10" /></label>
                        <label class="nd-inline">Repeat <input id="nd-test-repeat" type="number" min="1" value="1" /></label>
                        <label class="nd-inline">Username giả <input id="nd-test-uid" type="text" value="tester" /></label>
                        <button class="primary small" id="nd-test-gift">🎁 Bắn quà</button>
                    </div>
                </div>
                <div class="nd-card">
                    <div class="nd-card-title">🏆 Top contributor (phiên hiện tại)</div>
                    <div id="nd-top-table" class="nd-top-table"></div>
                </div>
            `;
            // Wire controls
            $('#nd-ctl-add5', host).addEventListener('click', () => sendControl({ cmd: 'addTemp', delta: 5 }));
            $('#nd-ctl-add10', host).addEventListener('click', () => sendControl({ cmd: 'addTemp', delta: 10 }));
            $('#nd-ctl-add25', host).addEventListener('click', () => sendControl({ cmd: 'addTemp', delta: 25 }));
            $('#nd-ctl-sub5', host).addEventListener('click', () => sendControl({ cmd: 'addTemp', delta: -5 }));
            $('#nd-ctl-sub25', host).addEventListener('click', () => sendControl({ cmd: 'addTemp', delta: -25 }));
            $('#nd-ctl-reset', host).addEventListener('click', () => sendControl({ cmd: 'reset' }));
            $('#nd-ctl-max', host).addEventListener('click', () => sendControl({ cmd: 'setTemp', temp: cfg.tempMax || 100 }));
            const slider = $('#nd-ctl-slider', host);
            const sliderV = $('#nd-ctl-slider-v', host);
            slider.max = cfg.tempMax || 100;
            slider.addEventListener('input', () => {
                sliderV.textContent = slider.value + '°';
            });
            slider.addEventListener('change', () => {
                sendControl({ cmd: 'setTemp', temp: parseFloat(slider.value) });
            });
            $('#nd-test-gift', host).addEventListener('click', () => {
                const coins = Math.max(1, parseInt($('#nd-test-coins', host).value, 10) || 10);
                const repeat = Math.max(1, parseInt($('#nd-test-repeat', host).value, 10) || 1);
                const uid = ($('#nd-test-uid', host).value || 'tester').trim();
                sendControl({ cmd: 'testGift', uniqueId: uid, nickname: uid, coinValue: coins, repeatCount: repeat });
            });
        }
        // Update top contributor table
        const $tt = $('#nd-top-table');
        if ($tt) {
            const top = (liveState?.top) || [];
            $tt.innerHTML = top.length
                ? top.map((u, i) => `<div class="nd-tt-row">
                    <span class="nd-tt-rank">#${i + 1}</span>
                    ${u.avatar ? `<img class="nd-tt-avatar" src="${escapeHtml(u.avatar)}" />` : '<span class="nd-tt-avatar">👤</span>'}
                    <span class="nd-tt-name">${escapeHtml(u.nickname || u.uniqueId)}</span>
                    <span class="nd-tt-deg">+${Math.round(u.totalDegrees)}°C</span>
                </div>`).join('')
                : '<div class="nd-empty">Chưa có user nào đẩy nhiệt — phát quà để xuất hiện top!</div>';
        }
        if (!liveState) return;
        const temp = liveState.temp || 0;
        const max = liveState.tempMax || 100;
        const pct = Math.max(0, Math.min(100, temp / max * 100));
        $('#nd-live-bigtemp').textContent = Math.round(temp) + '°';
        $('#nd-live-bar').style.width = pct.toFixed(1) + '%';
        const st = window.HpGame.nhietdo.stageOf(temp, max);
        $('#nd-live-stage').textContent = `${st.emoji} ${st.name}`;
        const idleSecs = liveState.lastGiftAt ? Math.max(0, Math.floor((Date.now() - liveState.lastGiftAt) / 1000)) : '∞';
        $('#nd-live-idle').textContent = idleSecs === '∞' ? 'Chưa có quà' : (idleSecs + 's');
        $('#nd-live-status').textContent = liveState.active === false ? '(TẮT)' : '';
        $('#nd-live-since').textContent = new Date(liveState.updatedAt || Date.now()).toLocaleTimeString('vi-VN');
    }

    // ============================================================
    // Control commands
    // ============================================================
    async function sendControl(body) {
        try {
            const r = await fetch('/api/games/nhietdo/control', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {})
            });
            if (r.ok) {
                const data = await r.json();
                if (data?.state) {
                    liveState = data.state;
                    renderLive();
                }
            }
        } catch (e) { console.warn('[nhietdo] control fail:', e); }
    }

    // ============================================================
    // Helpers
    // ============================================================
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

    window.HpNhietDoPanel = { open };
})();

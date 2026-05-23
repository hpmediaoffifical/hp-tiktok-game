/* ============================================================
   HP Caro LIVE — App-side panel controller
   ============================================================
   Khởi tạo khi user mở view-caro trong app.
   Bridge giữa:
     - HpGame.caro engine (đặt quân, undo, win-detect)
     - Server (POST state/config/cmd → broadcast tới OBS)
     - TikTok comments + gifts (socket events)

   Expose: window.HpCaroPanel.open()  // gọi từ app.js openGame('caro')
   ============================================================ */
(function () {
    'use strict';

    let game = null;       // HpGame.caro instance
    let socket = null;     // shared io() — reuse từ app.js
    let initialized = false;
    let cfg = null;
    let pendingSave = null;
    let opponentSource = '';  // 'reg' (qua ghi danh) hoặc 'freeid' (nhập tay)
    const giftPickers = {};  // { reg: GiftPicker, undo: GiftPicker }
    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    // ============ SoundManager — Web Audio synth ============
    // Sinh tone bằng OscillatorNode, không cần file audio asset.
    // Idol = pitch cao + sine (mềm/sáng), User = pitch thấp + triangle (ấm/đậm)
    const SoundManager = {
        ctx: null,
        ensureCtx() {
            if (this.ctx) return this.ctx;
            try {
                const Ctor = window.AudioContext || window.webkitAudioContext;
                if (Ctor) this.ctx = new Ctor();
            } catch (e) { /* unsupported */ }
            return this.ctx;
        },
        play(kind, side) {
            if (!cfg?.audio?.enabled) return;
            const ctx = this.ensureCtx();
            if (!ctx) return;
            // Resume context nếu bị suspended (chính sách autoplay browser)
            if (ctx.state === 'suspended') ctx.resume();
            const vol = Math.max(0, Math.min(1, (cfg.audio.volume ?? 50) / 100));
            if (vol === 0) return;

            const now = ctx.currentTime;
            if (kind === 'place') {
                // Tone ngắn 0.12s — idol 880Hz, user 440Hz
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                if (side === 'idol') { osc.frequency.value = 880; osc.type = 'sine'; }
                else { osc.frequency.value = 440; osc.type = 'triangle'; }
                gain.gain.setValueAtTime(0, now);
                gain.gain.linearRampToValueAtTime(0.25 * vol, now + 0.005);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(now); osc.stop(now + 0.18);
            }
            else if (kind === 'win') {
                // Fanfare 3 nốt nhanh
                const notes = side === 'idol' ? [880, 1108, 1318] : [440, 554, 659]; // C5/E5/G5 vs C4/E4/G4
                notes.forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.frequency.value = freq;
                    osc.type = 'sine';
                    const t = now + i * 0.1;
                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.3 * vol, t + 0.01);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.start(t); osc.stop(t + 0.35);
                });
            }
            else if (kind === 'draw') {
                // 2 nốt giáng nhẹ (hoà)
                [440, 392].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.frequency.value = freq;
                    osc.type = 'sine';
                    const t = now + i * 0.18;
                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.25 * vol, t + 0.01);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.start(t); osc.stop(t + 0.3);
                });
            }
        }
    };

    // ============ Custom Gift Picker (thay cho <select>) ============
    function createGiftPicker(host, onChange) {
        host.innerHTML = `
            <div class="cgp">
                <button type="button" class="cgp-trigger">
                    <span class="cgp-current">
                        <span class="cgp-placeholder">— Chọn quà —</span>
                    </span>
                    <span class="cgp-clear" title="Bỏ chọn quà này">✕</span>
                    <span class="cgp-arrow">▾</span>
                </button>
                <div class="cgp-pop">
                    <input class="cgp-search" placeholder="🔍 Tìm tên quà..." />
                    <div class="cgp-list"></div>
                </div>
            </div>`;
        const root = host.querySelector('.cgp');
        const trigger = host.querySelector('.cgp-trigger');
        const pop = host.querySelector('.cgp-pop');
        const search = host.querySelector('.cgp-search');
        const list = host.querySelector('.cgp-list');
        const current = host.querySelector('.cgp-current');
        const clearBtn = host.querySelector('.cgp-clear');
        let allGifts = [];
        let selectedId = '';

        // Nút ✕ — bỏ chọn quà (stopPropagation để không mở dropdown)
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            choose('');
        });

        function render(filter) {
            const f = (filter || '').toLowerCase().trim();
            const items = !f ? allGifts
                : allGifts.filter(g => (g.name || '').toLowerCase().includes(f) || (g.id || '').toString().includes(f));
            list.innerHTML = '';
            // Hàng "Bỏ chọn" — sticky, rõ ràng
            const none = document.createElement('div');
            none.className = 'cgp-row cgp-row-none' + (selectedId === '' ? ' active' : '');
            none.innerHTML = `<span class="cgp-icon none">✕</span><span class="cgp-name">— Bỏ chọn quà —</span>`;
            none.addEventListener('click', () => choose(''));
            list.appendChild(none);
            items.forEach(g => {
                const row = document.createElement('div');
                row.className = 'cgp-row' + (selectedId === String(g.id) ? ' active' : '');
                const img = g.image ? `<img class="cgp-icon" src="${escapeHtml(g.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cgp-icon none',textContent:'🎁'}))" alt="" />`
                    : `<span class="cgp-icon none">🎁</span>`;
                row.innerHTML = `${img}<span class="cgp-name">${escapeHtml(g.name || g.id)}</span><span class="cgp-dia">${g.diamond || 0}💎</span>`;
                row.addEventListener('click', () => choose(String(g.id)));
                list.appendChild(row);
            });
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'cgp-empty';
                empty.textContent = 'Không tìm thấy quà';
                list.appendChild(empty);
            }
        }

        function renderCurrent() {
            if (!selectedId) {
                current.innerHTML = `<span class="cgp-placeholder">— Chọn quà —</span>`;
                clearBtn.classList.remove('show');
                return;
            }
            const g = allGifts.find(x => String(x.id) === selectedId);
            if (!g) {
                current.innerHTML = `<span class="cgp-placeholder">— Quà không tồn tại —</span>`;
                clearBtn.classList.add('show');
                return;
            }
            const img = g.image ? `<img class="cgp-icon" src="${escapeHtml(g.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cgp-icon none',textContent:'🎁'}))" alt="" />`
                : `<span class="cgp-icon none">🎁</span>`;
            current.innerHTML = `${img}<span class="cgp-name">${escapeHtml(g.name || g.id)}</span><span class="cgp-dia">${g.diamond || 0}💎</span>`;
            clearBtn.classList.add('show');
        }

        function choose(id) {
            selectedId = id;
            renderCurrent();
            close();
            if (typeof onChange === 'function') onChange(id);
        }

        function positionPopup() {
            // .cgp-pop dùng position:fixed nên cần JS đặt top/left khớp trigger.
            const r = trigger.getBoundingClientRect();
            const popH = Math.min(400, window.innerHeight - r.bottom - 12);
            pop.style.left = r.left + 'px';
            pop.style.width = r.width + 'px';
            // Nếu chỗ dưới quá ít → mở lên trên trigger
            if (window.innerHeight - r.bottom < 200 && r.top > 240) {
                pop.style.top = '';
                pop.style.bottom = (window.innerHeight - r.top + 4) + 'px';
                pop.style.maxHeight = Math.min(400, r.top - 12) + 'px';
            } else {
                pop.style.bottom = '';
                pop.style.top = (r.bottom + 4) + 'px';
                pop.style.maxHeight = Math.max(220, popH) + 'px';
            }
        }
        function open() {
            pop.classList.add('show');
            root.classList.add('open');
            search.value = '';
            render('');
            positionPopup();
            setTimeout(() => search.focus(), 30);
        }
        function close() {
            pop.classList.remove('show');
            root.classList.remove('open');
        }
        // Re-position khi scroll/resize trong lúc dropdown mở.
        window.addEventListener('scroll', () => { if (isOpen()) positionPopup(); }, true);
        window.addEventListener('resize', () => { if (isOpen()) positionPopup(); });
        function isOpen() { return pop.classList.contains('show'); }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isOpen()) open(); else close();
        });
        search.addEventListener('input', () => render(search.value));
        document.addEventListener('click', (e) => {
            if (!root.contains(e.target)) close();
        });

        return {
            setList(list) { allGifts = list || []; render(search.value || ''); renderCurrent(); },
            setValue(id) { selectedId = id || ''; renderCurrent(); },
            getValue() { return selectedId; }
        };
    }

    // ---------- Public API ----------
    window.HpCaroPanel = {
        async open(sharedSocket) {
            socket = sharedSocket || window.io();
            if (!initialized) await init();
            // hiển thị view
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            $('#view-caro')?.classList.add('active');
            // Re-sync UI mỗi lần mở panel → button states không bị stuck từ lần trước
            updateUI();
            // fit canvas resize
            requestAnimationFrame(() => game && fitCanvasContainer());
        },
        instance() { return game; }
    };

    // ---------- Init ----------
    async function init() {
        // Fetch config
        try {
            const r = await fetch('/api/games/caro/config');
            cfg = await r.json();
        } catch (e) { cfg = HpGame.caro.defaultConfig(); }

        // Create game instance bound to preview canvas
        const canvas = $('#caro-canvas');
        game = HpGame.caro.create({
            canvas,
            mirrorMode: false,
            config: cfg
        });

        // Canvas tap → đặt quân
        game.on('tap', (ev) => {
            if (!ev.cell) return;
            // === CHẾ ĐỘ CHƠI THỬ — bypass mọi check, đặt luân phiên 2 màu ===
            if (cfg && cfg.practiceMode) {
                const result = game.practicePlace(ev.cell.c, ev.cell.r);
                if (!result.ok) flashWarn(translateReason(result.reason));
                else pushState();
                return;
            }
            // === Mode chính thức: chỉ Idol mới tap, cần đúng phase ===
            const st = game.getState();
            if (st.phase !== 'playing') {
                flashWarn('Chưa vào pha chơi — bật "🧪 CHƠI THỬ" hoặc mở ghi danh & chọn đối thủ');
                return;
            }
            if (st.round.turn !== 'idol') {
                flashWarn('Chưa tới lượt CREATOR');
                return;
            }
            const result = game.placeStone(ev.cell.c, ev.cell.r, 'idol');
            if (!result.ok) flashWarn(translateReason(result.reason));
            else pushState();
        });
        // Notification sau khi đặt quân (idol hoặc user) — log
        game.on('placed', (ev) => {
            logMove(ev.side, ev.cell);
        });
        // Âm thanh phân biệt 2 màu
        game.on('sound', (ev) => {
            SoundManager.play(ev.kind, ev.side);
        });
        // Bàn đầy → popup hỏi Idol
        game.on('draw', (ev) => {
            showDrawModal(ev.isPractice);
        });
        game.on('change', () => {
            updateUI();
        });
        game.on('win', (info) => {
            logSystem(`🏆 ${info.side === 'idol' ? 'CREATOR' : (game.getState().opponent?.nickname || 'USER')} thắng!`);
            pushState();
        });

        // Wire UI (do once)
        wireSetupTab();
        wireMatchTab();
        wireUndoTab();
        wireTabs();
        wireCopyOverlay();
        wireSave();

        // Listen socket events
        bindSocket();

        // Fill gift selects from giftSheet (cached in window if app.js set)
        refreshGiftOptions();

        // Initial UI sync
        applyConfigToUI();
        updateUI();

        // canvas auto-fit
        window.addEventListener('resize', () => game && fitCanvasContainer());
        requestAnimationFrame(fitCanvasContainer);

        initialized = true;
    }

    function fitCanvasContainer() {
        const frame = $('#caro-stage-frame');
        const canvas = $('#caro-canvas');
        if (!frame || !canvas) return;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        const ratio = 1080 / 1920;
        let w, h;
        if (fw / fh > ratio) { h = fh; w = h * ratio; }
        else { w = fw; h = w / ratio; }
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
    }

    // ---------- Tabs ----------
    function wireTabs() {
        const card = $('#view-caro .caro-card');
        const tabs = $$('[data-caro-tab]', card);
        const panes = $$('[data-caro-pane]', card);
        tabs.forEach(t => t.addEventListener('click', () => {
            tabs.forEach(x => x.classList.toggle('active', x === t));
            const id = t.dataset.caroTab;
            panes.forEach(p => p.classList.toggle('active', p.dataset.caroPane === id));
        }));
    }

    // ---------- Setup tab ----------
    function wireSetupTab() {
        const cols = $('#caro-cols'), colsV = $('#caro-cols-v');
        const rows = $('#caro-rows'), rowsV = $('#caro-rows-v');
        const scale = $('#caro-scale'), scaleV = $('#caro-scale-v');
        cols.addEventListener('input', () => {
            colsV.textContent = cols.value;
            updateCfg({ board: { cols: +cols.value } });
            // Sync winLength + active button khi clamp tự động
            cfg.board.winLength = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            selectSegValue('#caro-winlen-seg', cfg.board.winLength);
            updateWinLenButtons();
        });
        rows.addEventListener('input', () => {
            rowsV.textContent = rows.value;
            updateCfg({ board: { rows: +rows.value } });
            cfg.board.winLength = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            selectSegValue('#caro-winlen-seg', cfg.board.winLength);
            updateWinLenButtons();
        });
        scale.addEventListener('input', () => { scaleV.textContent = scale.value + '%'; updateCfg({ display: { scale: +scale.value } }); });

        wireSeg('#caro-winlen-seg', (v) => updateCfg({ board: { winLength: +v } }));
        wireSeg('#caro-bo-seg', (v) => updateCfg({ match: { bestOf: +v } }));
        wireSeg('#caro-first-seg', (v) => updateCfg({ match: { idolFirst: v === 'idol' } }));

        $('#caro-alternate-first').addEventListener('change', (e) => {
            updateCfg({ match: { alternateFirst: e.target.checked } });
        });
        $('#caro-show-history').addEventListener('change', (e) => {
            updateCfg({ display: { showHistory: e.target.checked } });
        });
        // Cell hints
        $('#caro-cell-hints').addEventListener('change', (e) => {
            updateCfg({ display: { cellHints: e.target.checked } });
        });
        const cellHintOp = $('#caro-cell-hint-op'), cellHintOpV = $('#caro-cell-hint-op-v');
        cellHintOp.addEventListener('input', () => {
            cellHintOpV.textContent = cellHintOp.value + '%';
            updateCfg({ display: { cellHintOpacity: +cellHintOp.value } });
        });
        // Audio
        $('#caro-audio-enabled').addEventListener('change', (e) => {
            updateCfg({ audio: { enabled: e.target.checked } });
            if (e.target.checked) SoundManager.play('place', 'idol'); // test sound
        });
        const audioVol = $('#caro-audio-volume'), audioVolV = $('#caro-audio-volume-v');
        audioVol.addEventListener('input', () => {
            audioVolV.textContent = audioVol.value + '%';
            updateCfg({ audio: { volume: +audioVol.value } });
        });
        audioVol.addEventListener('change', () => {
            // play test khi thả slider
            SoundManager.play('place', 'user');
        });
        // Practice mode toggle — bật là reset bàn để tap được liền
        $('#caro-practice-mode').addEventListener('change', (e) => {
            updateCfg({ practiceMode: e.target.checked });
            if (e.target.checked) {
                game.practiceReset();
                pushState();
                logSystem('🧪 Bật CHƠI THỬ — tap bàn để đặt quân luân phiên');
            } else {
                game.newGame();
                pushState();
                logSystem('🧪 Tắt CHƠI THỬ — về setup');
            }
        });
        // Rolling mode (tích điểm — N quân/bên)
        $('#caro-rolling-enabled').addEventListener('change', (e) => {
            updateCfg({ rolling: { enabled: e.target.checked } });
            logSystem(e.target.checked
                ? `♻️ Bật TÍCH ĐIỂM — mỗi bên ${cfg.rolling.tokensPerSide} quân, cũ tự mất`
                : '♻️ Tắt TÍCH ĐIỂM');
            // Reset hiệp hiện tại để áp luật mới
            if (game.getState().phase === 'playing') {
                game.resetCurrentRound();
                pushState();
            }
        });
        const rollTok = $('#caro-rolling-tokens'), rollTokV = $('#caro-rolling-tokens-v');
        rollTok.addEventListener('input', () => {
            rollTokV.textContent = rollTok.value;
            updateCfg({ rolling: { tokensPerSide: +rollTok.value } });
        });
        // Custom gift picker — registration
        giftPickers.reg = createGiftPicker($('#caro-reg-gift'), (id) => {
            updateCfg({ registration: { giftId: id } });
        });
    }

    function wireSeg(selector, cb) {
        const seg = $(selector);
        if (!seg) return;
        seg.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-v]');
            if (!btn) return;
            $$('button', seg).forEach(b => b.classList.toggle('active', b === btn));
            cb(btn.dataset.v);
        });
    }
    function selectSegValue(selector, value) {
        const seg = $(selector);
        if (!seg) return;
        $$('button', seg).forEach(b => b.classList.toggle('active', String(b.dataset.v) === String(value)));
    }
    // Disable nút winLength > min(cols, rows) để user không thể chọn invalid
    function updateWinLenButtons() {
        if (!cfg) return;
        const maxWin = Math.min(cfg.board.cols, cfg.board.rows);
        $$('#caro-winlen-seg button[data-v]').forEach(b => {
            const v = +b.dataset.v;
            if (v > maxWin) {
                b.disabled = true;
                b.style.opacity = '0.3';
                b.title = `Bàn ${cfg.board.cols}×${cfg.board.rows} không đủ ${v} ô liên tiếp`;
            } else {
                b.disabled = false;
                b.style.opacity = '';
                b.title = '';
            }
        });
    }

    function applyConfigToUI() {
        if (!cfg) return;
        $('#caro-cols').value = cfg.board.cols;
        $('#caro-cols-v').textContent = cfg.board.cols;
        $('#caro-rows').value = cfg.board.rows;
        $('#caro-rows-v').textContent = cfg.board.rows;
        $('#caro-scale').value = cfg.display.scale;
        $('#caro-scale-v').textContent = cfg.display.scale + '%';
        selectSegValue('#caro-winlen-seg', cfg.board.winLength);
        updateWinLenButtons();
        selectSegValue('#caro-bo-seg', cfg.match.bestOf);
        selectSegValue('#caro-first-seg', cfg.match.idolFirst ? 'idol' : 'user');
        $('#caro-alternate-first').checked = !!cfg.match.alternateFirst;
        $('#caro-show-history').checked = !!cfg.display.showHistory;
        $('#caro-practice-mode').checked = !!cfg.practiceMode;
        // Cell hints + audio
        $('#caro-cell-hints').checked = !!cfg.display.cellHints;
        $('#caro-cell-hint-op').value = cfg.display.cellHintOpacity ?? 35;
        $('#caro-cell-hint-op-v').textContent = (cfg.display.cellHintOpacity ?? 35) + '%';
        $('#caro-audio-enabled').checked = cfg.audio?.enabled !== false;
        $('#caro-audio-volume').value = cfg.audio?.volume ?? 50;
        $('#caro-audio-volume-v').textContent = (cfg.audio?.volume ?? 50) + '%';
        // Rolling mode
        if ($('#caro-rolling-enabled')) {
            $('#caro-rolling-enabled').checked = !!cfg.rolling?.enabled;
            $('#caro-rolling-tokens').value = cfg.rolling?.tokensPerSide ?? 3;
            $('#caro-rolling-tokens-v').textContent = cfg.rolling?.tokensPerSide ?? 3;
        }

        // Undo tab
        selectSegValue('#caro-undo-mode-seg', cfg.undo.mode || 'idol');
        $('#caro-undo-window').value = cfg.undo.window;
        $('#caro-undo-window-v').textContent = cfg.undo.window + 's';
        $('#caro-undo-max').value = cfg.undo.maxPerRound;
        $('#caro-undo-max-v').textContent = cfg.undo.maxPerRound;
        $('#caro-undo-cooldown').value = cfg.undo.cooldown;
        $('#caro-undo-cooldown-v').textContent = cfg.undo.cooldown + 's';

        // BO label
        $('#caro-bo-label').textContent = cfg.match.bestOf;
        // Accordion hints — summary text bên phải cho biết nhanh cấu hình
        updateAccordionHints();
    }
    function updateAccordionHints() {
        if (!cfg) return;
        const $h = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        $h('acc-hint-board', `${cfg.board.cols}×${cfg.board.rows} · Win ${cfg.board.winLength}`);
        $h('acc-hint-match', `BO${cfg.match.bestOf} · ${cfg.match.idolFirst ? '🩵 CREATOR' : '🩷 User'} đi`);
        // Reg: tên quà nếu chọn
        const giftId = cfg.registration?.giftId;
        const gift = (window.__giftSheet || []).find(g => String(g.id) === String(giftId));
        $h('acc-hint-reg', gift ? gift.name : 'Chưa chọn quà');
        // Mode
        const modes = [];
        if (cfg.practiceMode) modes.push('🧪 Thử');
        if (cfg.rolling?.enabled) modes.push(`♻️ Tích ${cfg.rolling.tokensPerSide}`);
        $h('acc-hint-mode', modes.length ? modes.join(' · ') : '—');
        // Display
        const dispBits = [`Scale ${cfg.display.scale}%`];
        if (cfg.display.cellHints) dispBits.push(`Hint ${cfg.display.cellHintOpacity}%`);
        $h('acc-hint-display', dispBits.join(' · '));
        // Audio
        $h('acc-hint-audio', cfg.audio?.enabled ? `Bật · ${cfg.audio?.volume || 0}%` : 'Tắt');
    }

    // ---------- Match tab ----------
    function wireMatchTab() {
        $('#caro-btn-open-reg').addEventListener('click', () => {
            if (!cfg.registration.giftId) {
                flashWarn('Vui lòng chọn quà ghi danh ở tab Cấu hình');
                return;
            }
            game.openRegistration();
            logSystem('🏁 Đã mở vòng ghi danh');
            pushState();
            // updateUI tự được gọi qua game.on('change') trong openRegistration()
        });
        $('#caro-btn-close-reg').addEventListener('click', () => {
            game.closeRegistration();
            logSystem('⏹ Đóng vòng ghi danh');
            pushState();
        });
        $('#caro-btn-pick-top').addEventListener('click', () => {
            const st = game.getState();
            if (!st.registration.entries.length) { flashWarn('Chưa có ai ghi danh'); return; }
            const top = st.registration.entries[0];
            game.pickOpponent(top.uniqueId);
            opponentSource = 'reg';
            logSystem(`🎯 Chọn đối thủ: ${top.nickname} (${top.totalDiamond}💎)`);
            pushState();
            updateUI();
        });
        $('#caro-btn-change-opponent').addEventListener('click', () => {
            const st = game.getState();
            if (!st.registration.entries.length) return;
            // Hiện modal chọn — đơn giản: prompt index
            showOpponentPickerModal(st.registration.entries, (uid) => {
                game.pickOpponent(uid);
                opponentSource = 'reg';
                pushState();
                updateUI();
            });
        });
        $('#caro-btn-replay').addEventListener('click', () => {
            game.resetMatch(true);
            $('#caro-end-actions').style.display = 'none';
            logSystem('🔁 Tái đấu với user cũ');
            pushState();
        });
        $('#caro-btn-newreg').addEventListener('click', () => {
            game.newGame();
            game.openRegistration();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem('📋 Mở vòng ghi danh mới');
            pushState();
        });
        $('#caro-btn-close-game').addEventListener('click', () => {
            game.newGame();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem('❌ Đóng game');
            pushState();
        });

        // === HUỶ ĐỐI THỦ — nút (X) ở card "Đang đấu với" ===
        // Bỏ opponent, về setup → Idol chọn người khác (free-ID hoặc ghi danh).
        // Confirm nếu đang playing để tránh huỷ nhầm giữa hiệp.
        $('#caro-btn-clear-opponent')?.addEventListener('click', () => {
            const st = game.getState();
            if (!st.opponent) return;
            const opName = st.opponent.nickname || st.opponent.uniqueId;
            if (st.phase === 'playing') {
                const score = `${st.match.score.idol}–${st.match.score.user}`;
                if (!window.confirm(`Huỷ "${opName}" giữa trận?\nTỉ số ${score} sẽ mất.`)) return;
            }
            game.newGame();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem(`✕ Huỷ đối thủ "${opName}"`);
            flashOk('Đã huỷ — chọn đối thủ mới');
            pushState();
            updateUI();   // button states derived từ phase=setup
        });
        // === FREE-ID — Idol nhập @username để đấu trực tiếp, bỏ qua ghi danh ===
        const freeIdGo = () => {
            const inp = $('#caro-freeid-input');
            const raw = (inp?.value || '').trim();
            if (!raw) { flashWarn('Nhập @username hoặc tên TikTok của khán giả'); inp?.focus(); return; }
            const ok = game.pickOpponentManual(raw, raw);
            if (!ok) { flashWarn('ID không hợp lệ'); return; }
            opponentSource = 'freeid';
            logSystem(`🎯 Đấu trực tiếp với "${raw}" (bỏ qua ghi danh)`);
            flashOk(`Đã chọn đối thủ: ${raw}`);
            if (inp) inp.value = '';
            pushState();
            updateUI();   // button states derived từ phase=playing + opponent
        };
        $('#caro-btn-freeid-go')?.addEventListener('click', freeIdGo);
        $('#caro-freeid-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); freeIdGo(); }
        });

        // === TEST QUÀ GIẢ — debug ghi danh khi không có gifter thật ===
        // Bắn 1 gift event giả vào chính handler socket.on('gift') để verify flow.
        // Quà giả dùng đúng giftId đang chọn trong cfg → phải match isRegGift=true.
        $('#caro-btn-test-gift')?.addEventListener('click', () => {
            const giftId = cfg?.registration?.giftId;
            if (!giftId) { flashWarn('Chưa chọn quà ghi danh — chọn trong tab Đối đầu'); return; }
            const sheet = window.__giftSheet || [];
            const gift = sheet.find(x => String(x.id) === String(giftId));
            const giftName = gift?.name || 'Test Gift';
            const fakeUid = 'test_' + Math.floor(Math.random() * 10000);
            const fakeRepeat = 1 + Math.floor(Math.random() * 20);
            const fakeGift = {
                uniqueId: fakeUid,
                nickname: `Test ${fakeUid.slice(5)}`,
                profilePicture: '',
                giftId: String(giftId),
                giftName,
                coinValue: gift?.diamond ?? 1,
                repeatCount: fakeRepeat,
                source: 'test'
            };
            handleGiftEvent(fakeGift);
            flashOk(`Test: bắn ${giftName} × ${fakeRepeat} từ ${fakeGift.nickname}`);
        });

        // Reset hiệp hiện tại — KHÔNG đổi tỉ số, không sang round mới.
        // Wire cả nút trong tab Match LẪN nút header (vị trí dễ thấy hơn).
        const resetRoundHandler = () => {
            const st = game.getState();
            if (st.phase === 'setup') { flashWarn('Chưa bắt đầu hiệp nào'); return; }
            const moveCount = st.round.moves.length;
            if (moveCount > 0 && !window.confirm(`Xoá ${moveCount} nước đi của hiệp ${st.round.idx} và bắt đầu lại?\n\nTỉ số ${st.match.score.idol}–${st.match.score.user} sẽ GIỮ NGUYÊN.`)) return;
            game.resetCurrentRound();
            logSystem(`🔁 Reset hiệp ${st.round.idx}`);
            pushState();
        };
        $('#caro-btn-reset-round')?.addEventListener('click', resetRoundHandler);
        $('#caro-btn-reset-round-header')?.addEventListener('click', resetRoundHandler);
    }

    // ============ DRAW MODAL — bàn đầy không ai thắng ============
    function showDrawModal(isPractice) {
        const existing = $('#caro-draw-modal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.id = 'caro-draw-modal';
        div.className = 'caro-modal-backdrop';
        // Practice: chỉ có Replay. Match: 3 lựa chọn.
        const matchButtons = isPractice ? '' : `
            <button class="ghost block" data-act="half">⏭️ Tính hoà 0.5–0.5 · Sang hiệp sau</button>
            <button class="ghost block" data-act="end">✋ Kết thúc match luôn</button>`;
        div.innerHTML = `
            <div class="caro-modal caro-draw-modal">
                <div class="caro-modal-head"><span>🤝 BÀN ĐẦY — HOÀ!</span></div>
                <div class="caro-modal-body" style="text-align:center; padding: 20px 24px;">
                    <div style="font-size:64px; margin: 8px 0 16px;">🤝</div>
                    <div style="font-size:14px; color: rgba(255,255,255,0.7); margin-bottom: 16px;">
                        Không ai đạt được ${cfg.board.winLength} quân liên tiếp.<br/>
                        Bạn muốn xử lý hiệp này thế nào?
                    </div>
                    <div class="caro-actions">
                        <button class="primary block" data-act="replay">🔁 Đánh lại hiệp này (khuyến nghị)</button>
                        ${matchButtons}
                    </div>
                </div>
            </div>`;
        document.body.appendChild(div);
        div.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'replay') { game.drawReplay(); logSystem('🔁 Đánh lại hiệp ' + game.getState().round.idx); }
            else if (act === 'half') { game.drawHalfPoint(); logSystem('⏭️ Tính hoà 0.5–0.5'); }
            else if (act === 'end') { game.drawEndMatch(); logSystem('✋ Kết thúc match theo tỉ số hiện tại'); }
            pushState();
            div.remove();
        });
    }

    function showOpponentPickerModal(entries, onPick) {
        // Modal đơn giản inline
        const existing = $('#caro-picker-modal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.id = 'caro-picker-modal';
        div.className = 'caro-modal-backdrop';
        div.innerHTML = `
            <div class="caro-modal">
                <div class="caro-modal-head">
                    <span>📋 Chọn đối thủ</span>
                    <button class="modal-close" id="caro-picker-close">✕</button>
                </div>
                <div class="caro-modal-body" id="caro-picker-list"></div>
            </div>`;
        document.body.appendChild(div);
        const list = $('#caro-picker-list', div);
        entries.forEach((e, i) => {
            const row = document.createElement('div');
            row.className = 'caro-picker-row';
            row.innerHTML = `
                <span class="rank">#${i + 1}</span>
                <img class="avatar" src="${e.profilePic || '/favicon.ico'}" alt="" />
                <span class="name">${escapeHtml(e.nickname)}</span>
                <span class="dia">${e.totalDiamond}💎</span>
                <button class="primary small">Chọn</button>`;
            row.querySelector('button').addEventListener('click', () => {
                onPick(e.uniqueId);
                div.remove();
            });
            list.appendChild(row);
        });
        $('#caro-picker-close', div).addEventListener('click', () => div.remove());
        div.addEventListener('click', (ev) => { if (ev.target === div) div.remove(); });
    }

    // ---------- Undo tab ----------
    function wireUndoTab() {
        wireSeg('#caro-undo-mode-seg', (v) => updateCfg({ undo: { mode: v } }));
        const win = $('#caro-undo-window'), winV = $('#caro-undo-window-v');
        const max = $('#caro-undo-max'), maxV = $('#caro-undo-max-v');
        const cd = $('#caro-undo-cooldown'), cdV = $('#caro-undo-cooldown-v');
        win.addEventListener('input', () => { winV.textContent = win.value + 's'; updateCfg({ undo: { window: +win.value } }); });
        max.addEventListener('input', () => { maxV.textContent = max.value; updateCfg({ undo: { maxPerRound: +max.value } }); });
        cd.addEventListener('input', () => { cdV.textContent = cd.value + 's'; updateCfg({ undo: { cooldown: +cd.value } }); });
        // Custom gift picker — undo
        giftPickers.undo = createGiftPicker($('#caro-undo-gift'), (id) => updateCfg({ undo: { giftId: id } }));

        $('#caro-btn-undo').addEventListener('click', () => {
            if (cfg.undo.mode === 'off') { flashWarn('Hoàn nước đang bị tắt'); return; }
            const res = game.undoLastMove();
            if (!res.ok) flashWarn(translateReason(res.reason, res));
            else {
                logSystem(`🔄 Đã hoàn nước cuối (${res.undone.side === 'idol' ? '🩵' : '🩷'})`);
                pushState();
            }
        });
    }

    // ---------- Save / overlay copy ----------
    function wireCopyOverlay() {
        const inp = $('#caro-overlay-url');
        const url = location.origin + '/overlay/caro';
        if (inp) inp.value = url;
        $('#caro-btn-copy').addEventListener('click', async () => {
            const ok = window.hpCopyText ? await window.hpCopyText(url) : false;
            if (ok) flashOk('Đã copy link OBS overlay Caro');
            else flashWarn('Copy thất bại — link: ' + url);
        });
    }

    function wireSave() {
        $('#caro-btn-save').addEventListener('click', () => {
            saveConfig().then(() => flashOk('Đã lưu cài đặt Caro')).catch(e => flashWarn(e.message));
        });
    }

    async function saveConfig() {
        const r = await fetch('/api/games/caro/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        if (!r.ok) throw new Error('Save fail');
    }

    // Debounced auto-save
    function updateCfg(patch) {
        cfg = deepMerge(cfg, patch);
        if (game) game.setConfig(cfg);
        updateAccordionHints();
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => {
            saveConfig().catch(() => {});
        }, 500);
    }

    function deepMerge(target, src) {
        const out = Object.assign({}, target);
        for (const k of Object.keys(src)) {
            if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
                out[k] = deepMerge(target[k] || {}, src[k]);
            } else {
                out[k] = src[k];
            }
        }
        return out;
    }

    // ---------- Server bridge ----------
    function pushState() {
        if (!game) return;
        const state = game.getState();
        fetch('/api/games/caro/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).catch(() => {});
    }

    function bindSocket() {
        if (!socket) return;
        // Comment listener — parse coord khi đến lượt user
        socket.on('chat', (data) => {
            // Game bị TẮT trong Thư viện → bỏ qua mọi comment để game không nhận nước cờ
            if (cfg && cfg.enabled === false) return;
            if (!game) return;
            const st = game.getState();
            if (st.phase !== 'playing') return;
            if (!st.opponent) return;
            // Chỉ xử lý comment từ ĐÚNG opponent
            if ((data.uniqueId || '').toLowerCase() !== (st.opponent.uniqueId || '').toLowerCase()) return;
            const text = data.comment || '';
            const coord = game.parseCoord(text);
            if (!coord) {
                appendComment(data, text, 'unparsed');
                return;
            }
            // === CẢNH BÁO "CHƯA TỚI LƯỢT" ===
            // Comment là TỌA ĐỘ HỢP LỆ nhưng đang là lượt CREATOR → reject + báo rõ.
            if (st.round.turn !== 'user') {
                appendComment(data, text, 'rejected');
                flashWarn(`${data.nickname || data.uniqueId}: "${text}" — Bạn chưa đến lượt`);
                logSystem(`⚠️ ${data.nickname || data.uniqueId} đánh "${text}" nhưng chưa tới lượt`);
                return;
            }
            const res = game.placeStone(coord.c, coord.r, 'user');
            if (!res.ok) {
                appendComment(data, text, 'rejected');
                flashWarn(`Cmt "${text}" — ${translateReason(res.reason)}`);
                return;
            }
            appendComment(data, text, 'accepted');
            // logMove được trigger qua game.on('placed') ở init
            pushState();
        });

        // Gift listener — registration phase
        socket.on('gift', handleGiftEvent);

        // Gift sheet load → fill selects
        socket.on('giftSheet', (list) => {
            window.__giftSheet = list;
            refreshGiftOptions();
        });
    }

    // ---------- Gift event handler (gọi từ socket VÀ từ nút Test) ----------
    function handleGiftEvent(g) {
        const st0 = game ? game.getState() : null;
        const giftIdIn = String(g.giftId ?? '').trim();
        const giftIdCfg = String(cfg?.registration?.giftId ?? '').trim();
        let isRegGift = giftIdIn !== '' && giftIdCfg !== '' && giftIdIn === giftIdCfg;
        // Fallback: id không khớp NHƯNG tên trùng tên quà đã chọn → vẫn nhận
        if (!isRegGift && giftIdCfg) {
            const cfgGift = (window.__giftSheet || []).find(x => String(x.id) === giftIdCfg);
            const inName = String(g.giftName || '').trim().toLowerCase();
            const cfgName = String(cfgGift?.name || '').trim().toLowerCase();
            if (cfgName && inName && cfgName === inName) isRegGift = true;
        }
        // === DIAGNOSTIC LOG — luôn ghi mọi gift event tới panel ===
        console.log('[caro] gift event', {
            giftId: giftIdIn, expected: giftIdCfg, match: isRegGift,
            phase: st0?.phase, regOpen: st0?.registration?.open,
            nickname: g.nickname, giftName: g.giftName,
            coinValue: g.coinValue, repeat: g.repeatCount, source: g.source
        });
        logSystem(`🎁 ${g.nickname || g.uniqueId}: ${g.giftName || g.giftId} (id=${giftIdIn}, cần=${giftIdCfg || 'chưa chọn'}) ${isRegGift ? '✓' : '✗'}`);

        if (cfg && cfg.enabled === false) { logSystem('⛔ Game đang tắt — bỏ qua'); return; }
        if (!game) return;
        let st = st0;
        // AUTO-OPEN ghi danh khi phase=setup và có quà đúng
        if (isRegGift && st.phase === 'setup') {
            game.openRegistration();
            logSystem('🏁 Tự mở ghi danh (có quà ghi danh đầu tiên)');
            st = game.getState();
            // Button states tự sync qua game.on('change') → updateUI()
        }
        if (st.phase !== 'registration' && st.phase !== 'picking') {
            logSystem(`⏸ Bỏ qua (phase=${st.phase}, chưa ở pha ghi danh/picking)`);
            return;
        }
        if (!isRegGift && st.phase === 'registration') return;
        const entriesBefore = game.getState().registration.entries.length;
        game.addGift({
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            profilePicture: g.profilePicture,
            coinValue: g.coinValue,
            repeatCount: g.repeatCount,
            giftId: g.giftId
        }, isRegGift);
        const stAfter = game.getState();
        const entriesAfter = stAfter.registration.entries.length;
        if (entriesAfter > entriesBefore) {
            logSystem(`📝 ${g.nickname || g.uniqueId} GHI DANH (${g.giftName || 'quà'} × ${g.repeatCount || 1})`);
            flashOk(`Ghi danh: ${g.nickname || g.uniqueId}`);
        } else if (isRegGift) {
            const diamond = (Number(g.coinValue) || 1) * (Number(g.repeatCount) || 1);
            logSystem(`➕ ${g.nickname || g.uniqueId} cộng +${diamond}💎`);
        } else {
            logSystem(`💎 ${g.nickname || g.uniqueId} tip thêm`);
        }
        pushState();
        updateUI();
    }

    function refreshGiftOptions() {
        const list = window.__giftSheet || [];
        if (giftPickers.reg) {
            giftPickers.reg.setList(list);
            giftPickers.reg.setValue(cfg?.registration?.giftId || '');
        }
        if (giftPickers.undo) {
            giftPickers.undo.setList(list);
            giftPickers.undo.setValue(cfg?.undo?.giftId || '');
        }
    }

    // ---------- UI updaters ----------
    function updateOpponentCard(st) {
        const card = $('#caro-opponent-card');
        if (!card) return;
        const op = st.opponent;
        if (!op) {
            card.style.display = 'none';
            return;
        }
        card.style.display = '';
        const nameEl = $('#caro-opponent-name');
        const uidEl = $('#caro-opponent-uid');
        const avEl = $('#caro-opponent-avatar');
        const diaEl = $('#caro-opponent-dia');
        const srcEl = $('#caro-opponent-source');
        if (nameEl) nameEl.textContent = op.nickname || op.uniqueId || '—';
        if (uidEl) uidEl.textContent = op.uniqueId ? '@' + op.uniqueId : '';
        if (avEl) {
            avEl.src = op.profilePic || '/favicon.ico';
        }
        if (diaEl) {
            const d = Number(op.totalDiamond) || 0;
            diaEl.textContent = d > 0 ? `${d}💎` : '';
        }
        if (srcEl) {
            srcEl.textContent = opponentSource === 'freeid' ? '🆔 Nhập tay' : (opponentSource === 'reg' ? '🎁 Qua ghi danh' : '');
        }
    }

    function updateUI() {
        if (!game) return;
        const st = game.getState();
        // Phase pill
        const phaseNames = {
            setup: 'Setup', registration: 'Ghi danh',
            picking: 'Đang chọn đối thủ', playing: `Đối đầu — Hiệp ${st.round.idx}`,
            roundEnd: `Kết thúc hiệp ${st.round.idx}`, matchEnd: 'Match kết thúc'
        };
        $('#caro-phase-pill').innerHTML = 'Đang ở pha: <b>' + (phaseNames[st.phase] || st.phase) + '</b>';

        // Persistent opponent card
        updateOpponentCard(st);

        // Turn label
        const turnLab = st.phase === 'playing'
            ? (st.round.turn === 'idol' ? '🩵 CREATOR' : `🩷 ${st.opponent?.nickname || 'USER'}`)
            : '—';
        $('#caro-turn-label').textContent = turnLab;
        $('#caro-round-label').textContent = st.round.idx;
        $('#caro-score-label').textContent = `${st.match.score.idol} - ${st.match.score.user}`;

        // Undo status
        $('#caro-undo-used').textContent = st.round.undosUsed;
        $('#caro-undo-cap').textContent = cfg.undo.maxPerRound;

        // Leaderboard
        renderLeaderboard(st.registration.entries, st.opponent?.uniqueId);

        // Match end?
        if (st.phase === 'matchEnd') {
            $('#caro-end-actions').style.display = 'block';
        }

        // === ROOT-CAUSE FIX: button states DERIVED từ game state ===
        // Trước đây tự bật/tắt trong click handlers → stuck khi user reload panel
        // hoặc đổi flow giữa chừng (vd pick gift sau khi đã Mở ghi danh).
        // Giờ source-of-truth là game state, updateUI() sync mỗi khi state đổi.
        const isSetup = st.phase === 'setup';
        const isReg = st.phase === 'registration';
        const isPicking = st.phase === 'picking';
        const isRegOpen = !!st.registration.open;
        const hasEntries = st.registration.entries.length > 0;
        const hasOpponent = !!st.opponent;
        // Mở ghi danh: enabled trong setup HOẶC reg-đã-đóng (cho phép mở lại vòng mới).
        // Disabled khi đang playing/picking/matchEnd hoặc reg đang mở.
        $('#caro-btn-open-reg').disabled = !(isSetup || (isReg && !isRegOpen)) || hasOpponent;
        // Đóng ghi danh: chỉ enabled khi reg đang mở
        $('#caro-btn-close-reg').disabled = !(isReg && isRegOpen);
        // Chọn Top 1: cần entries + đang ở reg/picking + chưa có opponent
        $('#caro-btn-pick-top').disabled = !hasEntries || !(isReg || isPicking) || hasOpponent;
        // Đổi đối thủ: cần entries để chọn người khác
        $('#caro-btn-change-opponent').disabled = !hasEntries;
    }

    function renderLeaderboard(entries, currentOpponentUid) {
        const host = $('#caro-leaderboard');
        if (!host) return;
        if (!entries.length) {
            host.innerHTML = '<div class="caro-lb-empty">Chưa có ai ghi danh</div>';
            return;
        }
        host.innerHTML = '';
        entries.slice(0, 20).forEach((e, idx) => {
            const row = document.createElement('div');
            row.className = 'caro-lb-row' + (e.uniqueId === currentOpponentUid ? ' active' : '');
            row.innerHTML = `
                <span class="rank">#${idx + 1}</span>
                <img class="avatar" src="${e.profilePic || '/favicon.ico'}" alt="" onerror="this.src='/favicon.ico'" />
                <span class="name">${escapeHtml(e.nickname)}</span>
                <span class="dia">${e.totalDiamond}💎</span>`;
            host.appendChild(row);
        });
    }

    // ---------- Logs ----------
    function appendComment(data, text, status) {
        const host = $('#caro-comments');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-comment ' + status;
        const tag = { accepted: '✓', rejected: '✕', unparsed: '?' }[status] || '·';
        div.innerHTML = `<span class="tag">${tag}</span>
            <img class="avatar" src="${data.profilePicture || '/favicon.ico'}" onerror="this.src='/favicon.ico'" />
            <span class="name">${escapeHtml(data.nickname || data.uniqueId)}</span>
            <span class="text">${escapeHtml(text)}</span>`;
        // Prepend — cmt MỚI nhất nằm TRÊN cùng
        host.insertBefore(div, host.firstChild);
        // Cap số cmt giữ trong DOM
        while (host.children.length > 80) host.removeChild(host.lastChild);
    }
    function logMove(side, cell) {
        const host = $('#caro-log');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-log-line ' + side;
        const tag = side === 'idol' ? '🩵 CREATOR' : '🩷 USER';
        const c = cell.c + 1, r = String.fromCharCode(65 + cell.r);
        div.textContent = `${game.getState().round.moves.length}. ${tag} → ${c}${r}`;
        host.appendChild(div);
        host.scrollTop = host.scrollHeight;
        while (host.children.length > 50) host.removeChild(host.firstChild);
    }
    function logSystem(text) {
        const host = $('#caro-log');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-log-line system';
        div.textContent = text;
        host.appendChild(div);
        host.scrollTop = host.scrollHeight;
    }

    function translateReason(reason, info) {
        const map = {
            not_playing: 'Không trong pha chơi',
            not_turn: 'Chưa tới lượt',
            not_user_turn: 'Chưa tới lượt user',
            not_opponent: 'Không phải đối thủ được chọn',
            round_over: 'Hiệp đã kết thúc',
            occupied: 'Ô đã có quân',
            oob: 'Ngoài bàn cờ',
            empty: 'Không có nước để hoàn',
            limit_reached: 'Đã hết lượt hoàn',
            window_expired: 'Quá thời gian hoàn',
            cooldown: `Cooldown — chờ ${info?.remain || ''}s`,
            parse_fail: 'Không đọc được tọa độ'
        };
        return map[reason] || reason;
    }

    function flashWarn(text) {
        const el = document.createElement('div');
        el.className = 'caro-toast warn';
        el.textContent = '⚠️ ' + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
    }
    function flashOk(text) {
        const el = document.createElement('div');
        el.className = 'caro-toast ok';
        el.textContent = '✓ ' + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2000);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
})();

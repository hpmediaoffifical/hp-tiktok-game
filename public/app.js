(function () {
    const socket = io();
    const $ = (sel) => document.querySelector(sel);

    // ===== State =====
    let giftSheet = [];
    let giftMap = {};
    let games = [];
    let currentGame = null;
    let gameInstance = null;
    const placeholderImg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="%231f2533"/><text x="32" y="38" text-anchor="middle" fill="%23ff6b3d" font-size="14" font-family="Arial">QUÀ</text></svg>';

    // ===== Effects list (trigger map) =====
    // Mỗi effect chỉ gán cho 1 quà duy nhất (1 hiệu ứng ↔ 1 quà).
    // (Trước đây shape có multi:true nhưng đã bỏ theo phản hồi user — đơn giản hoá UX.)
    const EFFECTS = [
        { key: 'thief',      ico: '🥷', label: 'Trộm' },
        { key: 'joinPolice', ico: '🚓', label: 'Gia nhập CS' },
        { key: 'osin',       ico: '🧹', label: 'Osin nhặt quà' },
        { key: 'ufo',        ico: '🛸', label: 'UFO hút 5-10 quà' },
        { key: 'kickJar',    ico: '🦵', label: 'OSIN giận đá hũ' },
        { key: 'throwJar',   ico: '💪', label: 'OSIN ném hũ lên trời' },
        { key: 'shape',      ico: '🎨', label: 'Tạo hình quà' },
        { key: 'fireworks',  ico: '🎆', label: 'Pháo hoa' },
        { key: 'megaboom',   ico: '💥', label: 'Megaboom' },
        { key: 'tornado',    ico: '🌀', label: 'Lốc xoáy' },
        { key: 'tilt',       ico: '⚖',  label: 'Nghiêng hũ' },
        { key: 'pourOut',    ico: '🔄', label: 'Dốc ngược hũ (đổ hết)' },
        { key: 'gravflip',   ico: '🔄', label: 'Đảo trọng lực' },
        { key: 'shake',      ico: '💢', label: 'Lắc hũ' },
        { key: 'slow',       ico: '🐢', label: 'Slow motion' },
        { key: 'rain',       ico: '☔', label: 'Mưa quà' },
        { key: 'geyser',     ico: '🚀', label: 'Phun trào' },
        { key: 'magnet',     ico: '🧲', label: 'Nam châm' },
        { key: 'crackJar',   ico: '🪟', label: 'Nứt hũ' },
        { key: 'stealJar',   ico: '🚚', label: 'Trộm cả hũ' },
        { key: 'combo',      ico: '⛓', label: 'Combo (chuỗi)' },
        { key: 'clear',      ico: '🗑', label: 'Xoá hết hũ' }
    ];
    function isMultiEffect(key) {
        const ef = EFFECTS.find(e => e.key === key);
        return !!(ef && ef.multi);
    }
    function giftIdsForEffect(key) {
        return Object.keys(currentTriggers).filter(id => currentTriggers[id] === key);
    }
    // Đẩy giftId lên đầu danh sách "vừa gán" → catalog hiển thị quà này trước.
    function bumpRecent(giftId) {
        const id = String(giftId);
        recentAssignments = recentAssignments.filter(x => x !== id);
        recentAssignments.unshift(id);
        if (recentAssignments.length > 50) recentAssignments.length = 50;
    }
    function dropRecent(giftId) {
        const id = String(giftId);
        recentAssignments = recentAssignments.filter(x => x !== id);
    }
    // Đồng bộ danh sách giftIds trong editingDraft (multi) → currentTriggers.
    // Dùng để auto-commit ngay khi user pick/bỏ trong modal — tránh "save xong vẫn mất".
    function commitMultiDraftToTriggers() {
        if (!editingEffect || !editingEffect.multi || !editingDraft) return;
        // Snapshot trước-sau để tính diff: quà mới thêm → bump, quà bỏ → drop khỏi recent.
        const oldIds = new Set(giftIdsForEffect(editingEffect.key));
        for (const k of Object.keys(currentTriggers)) {
            if (currentTriggers[k] === editingEffect.key) delete currentTriggers[k];
        }
        const newIds = new Set();
        const ids = (editingDraft.giftIds || []).map(String);
        for (const id of ids) {
            if (currentTriggers[id] && currentTriggers[id] !== editingEffect.key) continue;
            currentTriggers[id] = editingEffect.key;
            newIds.add(id);
        }
        // Diff: thêm mới → bump; bỏ → drop
        for (const id of newIds) if (!oldIds.has(id)) bumpRecent(id);
        for (const id of oldIds) if (!newIds.has(id)) dropRecent(id);
    }

    // ===== Feature toggles map =====
    const FEATURE_KEYS = ['audio','welcome','crown','leaderboard','sessionTotals','goalBar','combo','tierBorder','bigGiftFx','autoShake','randomEvents','thiefAuto','police'];
    const FEATURE_INPUT = {
        audio:'ft-audio', welcome:'ft-welcome', crown:'ft-crown', leaderboard:'ft-leaderboard',
        sessionTotals:'ft-totals', goalBar:'ft-goalbar', combo:'ft-combo', tierBorder:'ft-tier',
        bigGiftFx:'ft-bigfx', autoShake:'ft-autoshake', randomEvents:'ft-random', thiefAuto:'ft-thiefauto',
        police:'ft-police'
    };

    // ===== DOM =====
    const dom = {
        usernameInput: $('#username'),
        connRow: $('#conn-row'),
        btnConnect: $('#btn-connect'),
        btnReloadGifts: $('#btn-reload-gifts'),
        // License: handle qua biến cục bộ licStatusText/licMeta/btnLicLogout phía dưới
        dot: $('#dot'),
        statusText: $('#status-text'),
        // Old stat refs (no longer rendered, kept defensively for backward compat in other code paths)
        statRoom: { textContent: '' },
        statViewer: { textContent: '' },
        // New live stats grid
        liveStatsGrid: $('#live-stats-grid'),
        lstatViewer: $('#lstat-viewer'),
        lstatDiamond: $('#lstat-diamond'),
        lstatFollow: $('#lstat-follow'),
        lstatShare: $('#lstat-share'),
        gameList: $('#game-list'),
        homeGrid: $('#home-grid'),
        giftCountHint: $('#gift-count-hint'),
        // Game view
        gTitle: $('#g-title'),
        gSub: $('#g-sub'),
        overlayUrl: $('#overlay-url'),
        btnCopyOverlay: $('#btn-copy-overlay'),
        // btnOpenOverlay: đã bỏ (không cần thiết)
        btnSaveAll: $('#btn-save-all'),
        commentsEl: $('#comments'),
        giftStreamEl: $('#gift-stream'),
        giftCatalogEl: $('#gift-catalog'),
        giftSearchInput: $('#gift-search'),
        btnClearComments: $('#btn-clear-comments'),
        btnClearGifts: $('#btn-clear-gifts'),
        // Game canvas (Thuytinh)
        canvas: $('#game-canvas'),
        fxCanvas: $('#fx-canvas'),
        stageOverlays: $('#stage-overlays'),
        stageFrame: $('#stage-frame'),
        stageInfo: $('#stage-info'),
        // Cfg
        cfgGravity: $('#cfg-gravity'),
        cfgGravityV: $('#cfg-gravity-v'),
        cfgBounce: $('#cfg-bounce'),
        cfgBounceV: $('#cfg-bounce-v'),
        cfgFriction: $('#cfg-friction'),
        cfgFrictionV: $('#cfg-friction-v'),
        cfgJarH: $('#cfg-jar-h'),
        cfgJarHV: $('#cfg-jar-h-v'),
        cfgGmin: $('#cfg-gmin'),
        cfgGminV: $('#cfg-gmin-v'),
        cfgGmax: $('#cfg-gmax'),
        cfgGmaxV: $('#cfg-gmax-v'),
        cfgShowCount: $('#cfg-show-count'),
        cfgJarVisible: $('#cfg-jar-visible'),
        cfgJarLocked: $('#cfg-jar-locked'),
        btnResetSessionTop: $('#btn-reset-session-top'),
        btnThief: $('#btn-thief'),
        btnOsin: $('#btn-osin'),
        btnFxFirework: $('#btn-fx-firework'),
        btnFxTornado: $('#btn-fx-tornado'),
        btnFxShape: $('#btn-fx-shape'),
        cfgGoal: $('#cfg-goal'),
        cfgGoalV: $('#cfg-goal-v'),
        cfgShakeAt: $('#cfg-shake-at'),
        cfgShakeAtV: $('#cfg-shake-at-v'),
        cfgGoalGap: $('#cfg-goal-gap'),
        cfgGoalGapV: $('#cfg-goal-gap-v'),
        cfgThiefMiss: $('#cfg-thief-miss'),
        cfgThiefMissV: $('#cfg-thief-miss-v'),
        cfgPoliceRate: $('#cfg-police-rate'),
        cfgPoliceRateV: $('#cfg-police-rate-v'),
        cfgPoliceBan: $('#cfg-police-ban'),
        cfgPoliceBanV: $('#cfg-police-ban-v'),
        cfgPoliceName: $('#cfg-police-name'),
        cfgScaleLb: $('#cfg-scale-lb'),
        cfgScaleLbV: $('#cfg-scale-lb-v'),
        cfgScaleCaught: $('#cfg-scale-caught'),
        cfgScaleCaughtV: $('#cfg-scale-caught-v'),
        cfgScaleThief: $('#cfg-scale-thief'),
        cfgScaleThiefV: $('#cfg-scale-thief-v'),
        cfgScalePolice: $('#cfg-scale-police'),
        cfgScalePoliceV: $('#cfg-scale-police-v'),
        cfgScaleOsin: $('#cfg-scale-osin'),
        cfgScaleOsinV: $('#cfg-scale-osin-v'),
        cfgScaleUfo: $('#cfg-scale-ufo'),
        cfgScaleUfoV: $('#cfg-scale-ufo-v'),
        cfgJarAccessory: $('#cfg-jar-accessory'),
        cfgJarTheme: $('#cfg-jar-theme'),
        cfgBadgesEnabled: $('#cfg-badges-enabled'),
        cfgBadgesLayout: $('#cfg-badges-layout'),
        cfgBadgesNamepos: $('#cfg-badges-namepos'),
        cfgBadgesScale: $('#cfg-badges-scale'),
        cfgBadgesScaleV: $('#cfg-badges-scale-v'),
        cfgBadgesIconScale: $('#cfg-badges-iconscale'),
        cfgBadgesIconScaleV: $('#cfg-badges-iconscale-v'),
        saveStatus: $('#save-status'),
        triggerList: $('#trigger-list'),
        giftOptions: $('#gift-options'),
    };
    let currentTriggers = {};  // giftId → action
    let currentBadgeItems = {};   // giftId → { customLabel, namePos, enabled }
    // Track thứ tự gán mới nhất (giftId) — dùng để sort catalog: quà mới gán lên đầu.
    // Tồn tại trong phiên app, không persist. Mở app lại thì dùng thứ tự key trong triggers.
    let recentAssignments = [];   // giftIds, mới nhất ở đầu

    // ===== Helpers =====
    function setStatus(state, text) {
        dom.dot.classList.remove('online', 'connecting', 'error');
        if (state) dom.dot.classList.add(state);
        dom.statusText.textContent = text;
    }
    function showView(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        $('#' + viewId)?.classList.add('active');
    }
    function appendSystem(text) {
        if (!dom.commentsEl) return;
        const div = document.createElement('div');
        div.className = 'system-line';
        div.textContent = text;
        dom.commentsEl.appendChild(div);
        dom.commentsEl.scrollTop = dom.commentsEl.scrollHeight;
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // hpConfirm — modal styled theo theme app, thay thế cho window.confirm() xấu xí.
    // tone: 'normal' | 'danger' (default 'normal')
    function hpConfirm({ icon, title, body, okLabel, cancelLabel, tone }) {
        return new Promise((resolve) => {
            let overlay = document.getElementById('hp-confirm-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'hp-confirm-overlay';
                overlay.className = 'hp-confirm-overlay';
                overlay.innerHTML = `
                    <div class="hp-confirm-card">
                        <div class="hp-confirm-head">
                            <div class="hp-confirm-icon" id="hp-confirm-icon"></div>
                            <div class="hp-confirm-title" id="hp-confirm-title"></div>
                        </div>
                        <div class="hp-confirm-body" id="hp-confirm-body"></div>
                        <div class="hp-confirm-actions">
                            <button class="hp-confirm-btn cancel" id="hp-confirm-cancel"></button>
                            <button class="hp-confirm-btn ok" id="hp-confirm-ok"></button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);
            }
            const card = overlay.querySelector('.hp-confirm-card');
            card.classList.toggle('tone-danger', tone === 'danger');
            overlay.querySelector('#hp-confirm-icon').textContent = icon || '?';
            overlay.querySelector('#hp-confirm-title').textContent = title || 'Xác nhận';
            overlay.querySelector('#hp-confirm-body').innerHTML = body || '';
            const okBtn = overlay.querySelector('#hp-confirm-ok');
            const cancelBtn = overlay.querySelector('#hp-confirm-cancel');
            okBtn.textContent = okLabel || 'OK';
            cancelBtn.textContent = cancelLabel || 'Huỷ';
            overlay.classList.add('show');
            setTimeout(() => cancelBtn.focus(), 30);
            function cleanup(val) {
                overlay.classList.remove('show');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                document.removeEventListener('keydown', onKey);
                overlay.removeEventListener('click', onBackdrop);
                resolve(val);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
            }
            function onBackdrop(e) { if (e.target === overlay) onCancel(); }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            document.addEventListener('keydown', onKey);
            overlay.addEventListener('click', onBackdrop);
        });
    }
    // Expose để các module khác dùng
    window.hpConfirm = hpConfirm;

    // ===== Games =====
    async function loadGames() {
        const res = await fetch('/api/games');
        games = await res.json();
        renderGameList();
        renderHomeGrid();
    }
    function renderGameList() {
        dom.gameList.innerHTML = '';
        for (const g of games) {
            const div = document.createElement('div');
            div.className = 'game-item';
            div.dataset.id = g.id;
            // Determine if game has 'enabled' field in its config (pktiktok + vipwelcome)
            const cfg = g.config || {};
            const hasEnabledField = ('enabled' in cfg);
            const isEnabled = !hasEnabledField || cfg.enabled !== false;
            div.innerHTML = `<span class="ico">${g.icon}</span>
                <div class="meta">
                    <div class="gn">${g.name}</div>
                    <div class="gd">${g.description.length > 38 ? g.description.slice(0, 38) + '…' : g.description}</div>
                </div>
                <button class="game-toggle ${isEnabled ? 'on' : 'off'}" data-game-toggle="${g.id}" title="${isEnabled ? 'Đang BẬT — bấm để TẮT' : 'Đang TẮT — bấm để BẬT'} game chạy ngầm (overlay sẽ không phát hiệu ứng)">⏻</button>`;
            // Click toàn thân (trừ toggle) → mở game
            div.addEventListener('click', (e) => {
                if (e.target.closest('[data-game-toggle]')) return;
                openGame(g.id);
            });
            // Click toggle → bật/tắt game
            div.querySelector('[data-game-toggle]')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                const cur = !btn.classList.contains('off');   // currently on?
                const next = !cur;
                btn.classList.toggle('on', next);
                btn.classList.toggle('off', !next);
                btn.title = next ? 'Đang BẬT — bấm để TẮT' : 'Đang TẮT — bấm để BẬT';
                // POST update to server
                try {
                    await fetch(`/api/games/${g.id}/config`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: next })
                    });
                    if (g.config) g.config.enabled = next;
                } catch (err) {
                    // revert
                    btn.classList.toggle('on', !next);
                    btn.classList.toggle('off', next);
                }
            });
            dom.gameList.appendChild(div);
        }
    }
    function renderHomeGrid() {
        dom.homeGrid.innerHTML = '';
        for (const g of games) {
            const card = document.createElement('div');
            card.className = 'home-card';
            card.innerHTML = `<div class="ico">${g.icon}</div>
                <div class="gn">${g.name}</div>
                <div class="gd">${g.description}</div>`;
            card.addEventListener('click', () => openGame(g.id));
            dom.homeGrid.appendChild(card);
        }
    }
    function highlightActiveGame(gameId) {
        document.querySelectorAll('.game-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === gameId);
        });
    }

    function openGame(gameId) {
        const game = games.find(g => g.id === gameId);
        if (!game) return;
        currentGame = game;
        highlightActiveGame(gameId);
        // Body class: dùng để CSS ẩn/hiện FAB/popup theo game
        document.body.classList.remove('game-thuytinh', 'game-caro', 'game-pktiktok', 'game-vipwelcome');
        document.body.classList.add('game-' + gameId);
        // Đóng các popup Hũ khi rời sang game khác (tránh popup mở treo)
        if (gameId !== 'thuytinh') {
            document.getElementById('police-popup')?.setAttribute('hidden', '');
            document.getElementById('caught-popup')?.setAttribute('hidden', '');
        }
        if (gameId === 'thuytinh') openThuytinh(game);
        else if (gameId === 'caro') openCaro(game);
        else if (gameId === 'pktiktok') openPkTiktok(game);
        else if (gameId === 'vipwelcome') openVipWelcome(game);
    }

    function openVipWelcome(game) {
        if (window.HpVipWelcomePanel && typeof window.HpVipWelcomePanel.open === 'function') {
            window.HpVipWelcomePanel.open(socket);
        } else {
            console.error('[vipwelcome] HpVipWelcomePanel chưa load');
        }
    }

    function openCaro(game) {
        // Cache giftSheet để caro-panel có thể dùng (nếu chưa cache)
        if (!window.__giftSheet) window.__giftSheet = giftSheet;
        if (window.HpCaroPanel && typeof window.HpCaroPanel.open === 'function') {
            window.HpCaroPanel.open(socket);
        } else {
            console.error('[caro] HpCaroPanel chưa load');
        }
    }

    function openPkTiktok(game) {
        if (window.HpPkTiktokPanel && typeof window.HpPkTiktokPanel.open === 'function') {
            window.HpPkTiktokPanel.open(socket);
        } else {
            console.error('[pktiktok] HpPkTiktokPanel chưa load');
        }
    }

    // ===== Thuytinh game =====
    function openThuytinh(game) {
        showView('view-thuytinh');
        dom.gTitle.textContent = `${game.icon} ${game.name}`;
        dom.gSub.textContent = game.description;
        const overlayUrl = location.origin + game.overlayPath;
        dom.overlayUrl.value = overlayUrl;

        // Tạo lớp ảnh hũ overlay vào stage (nằm sau canvas qua DOM order, nhưng z-index nâng cao)
        if (!dom.stageFrame.querySelector('.jar-bottom')) {
            const jbot = document.createElement('img');
            jbot.className = 'jar-bottom';
            jbot.src = '/assets/thuytinh/jar-bottom.png';
            jbot.style.position = 'absolute';
            jbot.style.zIndex = '2';
            jbot.style.pointerEvents = 'none';
            dom.stageFrame.appendChild(jbot);

            const jglass = document.createElement('img');
            jglass.className = 'jar-glass';
            jglass.src = '/assets/thuytinh/ben-ngoai/jar-glass.png';
            jglass.style.position = 'absolute';
            jglass.style.zIndex = '4';
            jglass.style.pointerEvents = 'none';
            dom.stageFrame.appendChild(jglass);

            const countDisp = document.createElement('div');
            countDisp.className = 'jar-count';
            countDisp.style.position = 'absolute';
            countDisp.style.zIndex = '5';
            countDisp.style.transform = 'translate(-50%, 0)';
            countDisp.style.color = '#fff';
            countDisp.style.fontSize = '28px';
            countDisp.style.fontWeight = '800';
            countDisp.style.textShadow = '0 2px 6px rgba(0,0,0,0.7)';
            countDisp.style.pointerEvents = 'none';
            dom.stageFrame.appendChild(countDisp);

            // Đảm bảo canvas nằm giữa hai lớp jar (bottom z2, canvas z3, glass z4)
            dom.canvas.style.zIndex = '3';
        }

        if (gameInstance) {
            try { gameInstance.clearAll(); } catch (e) {}
        }

        gameInstance = HpGame.thuytinh.create({
            canvas: dom.canvas,
            fxCanvas: dom.fxCanvas,
            overlayLayer: dom.stageOverlays,
            jarBottomEl: dom.stageFrame.querySelector('.jar-bottom'),
            jarGlassEl: dom.stageFrame.querySelector('.jar-glass'),
            countDisplay: dom.stageFrame.querySelector('.jar-count'),
            config: game.config,
            onCountChange: (n) => { dom.stageInfo.textContent = `Trong hũ: ${n}`; },
            onBail: (uid) => {
                if (!currentGame || !uid) return;
                sendCmd('bail', { uid: String(uid) });
            },
            onPanelMoved: (panelKey, pos) => {
                if (!currentGame) return;
                const cfg = gameInstance.getConfig();
                cfg.panelPositions = cfg.panelPositions || {};
                cfg.panelPositions[panelKey] = pos;
                clearTimeout(saveCfgTimer);
                saveCfgTimer = setTimeout(() => {
                    fetch(`/api/games/${currentGame.id}/config`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(cfg)
                    }).catch(() => {});
                }, 400);
            },
            // App là authoritative — khi runTriggerAction chạy xong → broadcast cmd cho OBS replay
            // → OBS mirror chính xác mọi action (trộm, OSIN, fxFireworks, joinPolice, v.v.)
            onTrigger: (action, userInfo) => {
                if (!currentGame) return;
                sendCmd(action, userInfo || {});
                // forceSync ngay khi action liên quan tới state (caughtList, policeForce)
                if (action === 'joinPolice' || action === 'thief' || action === 'clear') {
                    forceSyncState();
                }
            }
        });

        applyConfigToUI(game.config);
        enableJarDragging();
        socket.emit('subscribe', 'preview');

        // RESTORE state from disk on first load (persist qua restart)
        // Server đã loadGameStateCache() từ disk vào memory rồi → fetch về và loadState
        fetch(`/api/games/${currentGame.id}/state`)
            .then(r => r.json())
            .then(state => {
                if (state && typeof state === 'object') {
                    try { gameInstance.loadState(state); } catch (e) { console.warn('loadState fail:', e); }
                }
            })
            .catch(() => {});

        startStateSync();
    }

    // ===== Định kỳ push state lên server (overlay nhận realtime) =====
    // Server sẽ tự broadcast state mỗi lần nhận POST → OBS luôn theo App, không cần refresh.
    let stateSyncTimer = null;
    let lastStateHash = '';
    function pushStateNow() {
        if (!gameInstance || !currentGame) return;
        const state = gameInstance.serializeState();
        const hash = JSON.stringify([
            state.totalDiamonds, state.totalGifts,
            (state.caughtList || []).length,
            (state.policeForce || []).length,
            (state.tippers || []).length,
            (state.bodies || []).length   // include bodies count → state push khi quà thêm/bớt
        ]);
        if (hash === lastStateHash) return;
        lastStateHash = hash;
        fetch(`/api/games/${currentGame.id}/state`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).catch(() => {});
    }
    // Force sync (bỏ qua dedupe hash) — dùng khi clear/reset, OBS phải biết NGAY
    function forceSyncState() {
        lastStateHash = '';
        pushStateNow();
    }
    function startStateSync() {
        stopStateSync();
        pushStateNow();   // push ngay khi vào game
        stateSyncTimer = setInterval(pushStateNow, 1500);
    }
    function stopStateSync() {
        if (stateSyncTimer) { clearInterval(stateSyncTimer); stateSyncTimer = null; }
    }

    // ===== Kéo hũ bằng chuột trong vùng 1080x1920 =====
    let jarDragWired = false;
    function enableJarDragging() {
        if (jarDragWired) return;
        jarDragWired = true;
        const stage = dom.stageFrame;

        function clientToCanvas(ev) {
            const rect = stage.getBoundingClientRect();
            const x = (ev.clientX - rect.left) * (gameInstance.CANVAS_W / rect.width);
            const y = (ev.clientY - rect.top) * (gameInstance.CANVAS_H / rect.height);
            return { x, y };
        }
        function isInsideJar(p) {
            const r = gameInstance.getJarRect();
            return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
        }

        let dragging = false;
        let grabOffset = { x: 0, y: 0 };

        function jarIsLocked() {
            return !!(gameInstance && gameInstance.getConfig && gameInstance.getConfig().jarLocked);
        }

        stage.addEventListener('mousemove', (ev) => {
            if (!gameInstance) return;
            if (dragging) return;
            const p = clientToCanvas(ev);
            stage.style.cursor = (isInsideJar(p) && !jarIsLocked()) ? 'grab' : 'default';
        });

        stage.addEventListener('mousedown', (ev) => {
            if (!gameInstance || ev.button !== 0) return;
            if (jarIsLocked()) return;  // 🔒 khoá hũ → bỏ qua drag
            const p = clientToCanvas(ev);
            if (!isInsideJar(p)) return;
            dragging = true;
            stage.style.cursor = 'grabbing';
            const r = gameInstance.getJarRect();
            grabOffset.x = p.x - r.cx;
            grabOffset.y = p.y - r.cy;
            ev.preventDefault();
        });

        window.addEventListener('mousemove', (ev) => {
            if (!dragging || !gameInstance) return;
            const p = clientToCanvas(ev);
            const cx = p.x - grabOffset.x;
            const cy = p.y - grabOffset.y;
            const xPercent = (cx / gameInstance.CANVAS_W) * 100;
            const yPercent = (cy / gameInstance.CANVAS_H) * 100;
            gameInstance.setJarPosition(xPercent, yPercent);
        });

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            stage.style.cursor = 'default';
            // Lưu vị trí mới vào server (overlay nhận luôn)
            if (!currentGame || !gameInstance) return;
            const r = gameInstance.getJarRect();
            const cfg = gameInstance.getConfig();
            cfg.jar.xPercent = (r.cx / gameInstance.CANVAS_W) * 100;
            cfg.jar.yPercent = (r.cy / gameInstance.CANVAS_H) * 100;
            fetch(`/api/games/${currentGame.id}/config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            }).catch(() => {});
        }
        window.addEventListener('mouseup', endDrag);
        window.addEventListener('mouseleave', endDrag);
    }

    function applyConfigToUI(cfg) {
        if (!cfg) return;
        const bindRange = (el, val, valDisp) => {
            if (!el) return;
            el.value = String(val);
            if (valDisp) valDisp.textContent = val;
        };
        bindRange(dom.cfgGravity, cfg.physics.gravity, dom.cfgGravityV);
        bindRange(dom.cfgBounce, cfg.physics.bounce, dom.cfgBounceV);
        bindRange(dom.cfgFriction, cfg.physics.friction, dom.cfgFrictionV);
        bindRange(dom.cfgJarH, cfg.jar.height, dom.cfgJarHV);
        bindRange(dom.cfgGmin, cfg.gift.minSize, dom.cfgGminV);
        bindRange(dom.cfgGmax, cfg.gift.maxSize, dom.cfgGmaxV);
        // cfg-goal đã chuyển từ slider sang number input — set value trực tiếp
        if (dom.cfgGoal) dom.cfgGoal.value = cfg.goal?.target ?? 5000;
        if (dom.cfgGoalV) dom.cfgGoalV.textContent = cfg.goal?.target ?? 5000;
        bindRange(dom.cfgShakeAt, cfg.autoShakeAt ?? 200, dom.cfgShakeAtV);
        bindRange(dom.cfgGoalGap, cfg.goalBarGap ?? -1.2, dom.cfgGoalGapV);
        const missPct = Math.round((cfg.thiefMissRate ?? 0.1) * 100);
        bindRange(dom.cfgThiefMiss, missPct, dom.cfgThiefMissV);
        const polPct = Math.round((cfg.policeCatchRate ?? 0.25) * 100);
        bindRange(dom.cfgPoliceRate, polPct, dom.cfgPoliceRateV);
        bindRange(dom.cfgPoliceBan, cfg.policeBanSec ?? 30, dom.cfgPoliceBanV);
        if (dom.cfgPoliceName) dom.cfgPoliceName.value = cfg.policeName || '';
        const sLb = cfg.panelScales?.leaderboard ?? 1;
        const sCa = cfg.panelScales?.caught ?? 1;
        bindRange(dom.cfgScaleLb, sLb, dom.cfgScaleLbV);
        bindRange(dom.cfgScaleCaught, sCa, dom.cfgScaleCaughtV);
        if (dom.cfgScaleLbV) dom.cfgScaleLbV.textContent = sLb;
        if (dom.cfgScaleCaughtV) dom.cfgScaleCaughtV.textContent = sCa;
        const sTh = cfg.actorScales?.thief ?? 1;
        const sPo = cfg.actorScales?.police ?? 1;
        const sOs = cfg.actorScales?.osin ?? 1;
        const sUf = cfg.actorScales?.ufo ?? 1;
        bindRange(dom.cfgScaleThief, sTh, dom.cfgScaleThiefV);
        bindRange(dom.cfgScalePolice, sPo, dom.cfgScalePoliceV);
        bindRange(dom.cfgScaleOsin, sOs, dom.cfgScaleOsinV);
        bindRange(dom.cfgScaleUfo, sUf, dom.cfgScaleUfoV);
        if (dom.cfgScaleThiefV) dom.cfgScaleThiefV.textContent = sTh;
        if (dom.cfgScalePoliceV) dom.cfgScalePoliceV.textContent = sPo;
        if (dom.cfgScaleOsinV) dom.cfgScaleOsinV.textContent = sOs;
        if (dom.cfgScaleUfoV) dom.cfgScaleUfoV.textContent = sUf;
        if (dom.cfgJarAccessory) dom.cfgJarAccessory.value = cfg.jarAccessory || 'none';
        if (dom.cfgJarTheme) dom.cfgJarTheme.value = cfg.jarTheme || 'default';
        const bdg = cfg.badges || {};
        if (dom.cfgBadgesEnabled) dom.cfgBadgesEnabled.checked = !!bdg.enabled;
        if (dom.cfgBadgesLayout) dom.cfgBadgesLayout.value = bdg.layout || 'vertical';
        if (dom.cfgBadgesNamepos) dom.cfgBadgesNamepos.value = bdg.defaultNamePos || (bdg.layout === 'horizontal' ? 'top' : 'right');
        const bScale = bdg.scale ?? 1;
        if (dom.cfgBadgesScale) dom.cfgBadgesScale.value = String(bScale);
        if (dom.cfgBadgesScaleV) dom.cfgBadgesScaleV.textContent = bScale;
        const bIconScale = bdg.iconScale ?? 1;
        if (dom.cfgBadgesIconScale) dom.cfgBadgesIconScale.value = String(bIconScale);
        if (dom.cfgBadgesIconScaleV) dom.cfgBadgesIconScaleV.textContent = bIconScale;
        // Lưu items + extras để gatherConfig giữ nguyên (chỉ edit qua modal per-gift)
        currentBadgeItems = JSON.parse(JSON.stringify(bdg.items || {}));
        currentBadgeExtras = Array.isArray(bdg.extras) ? JSON.parse(JSON.stringify(bdg.extras)) : [];
        renderBadgeExtrasList();
        if (dom.cfgShowCount) dom.cfgShowCount.checked = !!cfg.gift.showCount;
        if (dom.cfgJarVisible) dom.cfgJarVisible.checked = !!cfg.jarVisible;
        if (dom.cfgJarLocked) dom.cfgJarLocked.checked = !!cfg.jarLocked;
        const f = cfg.features || {};
        for (const key of FEATURE_KEYS) {
            const el = document.getElementById(FEATURE_INPUT[key]);
            if (el) el.checked = !!f[key];
        }
        currentTriggers = JSON.parse(JSON.stringify(cfg.triggers || {}));
        currentEffectsConfig = JSON.parse(JSON.stringify(cfg.effects || {}));
        // Migration cleanup: bảo đảm mỗi effect chỉ có 1 quà (kể cả config cũ từ thời shape
        // có multi). Giữ entry đầu tiên cho mỗi effect, xoá phần thừa.
        {
            const seen = new Set();
            const cleaned = {};
            for (const id of Object.keys(currentTriggers)) {
                const eff = currentTriggers[id];
                if (seen.has(eff)) continue;
                seen.add(eff);
                cleaned[id] = eff;
            }
            const removedCount = Object.keys(currentTriggers).length - Object.keys(cleaned).length;
            if (removedCount > 0) {
                currentTriggers = cleaned;
                // Đẩy lại cleanup config lên server để overlay cũng sync (không gọi
                // pushConfigUpdate vì game chưa được create xong — chỉ POST trực tiếp).
                setTimeout(() => {
                    if (currentGame) {
                        fetch(`/api/games/${currentGame.id}/config`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(gatherConfig())
                        }).catch(() => {});
                    }
                }, 500);
            }
        }
        // Khởi tạo recentAssignments theo thứ tự key trong cfg.triggers (giữ relative order
        // sau khi reload). User mới gán quà nào trong phiên hiện tại thì bumpRecent sẽ đẩy lên đầu.
        recentAssignments = Object.keys(currentTriggers);
        renderTriggerList();
        // Re-render catalog để badge has-trigger hiện đúng theo state mới
        if (dom.giftCatalogEl) renderGiftCatalog(dom.giftSearchInput?.value || '');
    }

    function gatherConfig() {
        const features = {};
        for (const key of FEATURE_KEYS) {
            const el = document.getElementById(FEATURE_INPUT[key]);
            features[key] = !!(el && el.checked);
        }
        const cur = gameInstance ? gameInstance.getJarRect() : null;
        const xPercent = cur ? (cur.cx / 1080) * 100 : (currentGame?.config?.jar?.xPercent ?? 50);
        const yPercent = cur ? (cur.cy / 1920) * 100 : (currentGame?.config?.jar?.yPercent ?? 56);
        return {
            jar: { height: parseInt(dom.cfgJarH.value, 10), xPercent, yPercent },
            gift: {
                minSize: parseInt(dom.cfgGmin.value, 10),
                maxSize: parseInt(dom.cfgGmax.value, 10),
                showName: false,
                showCount: dom.cfgShowCount.checked
            },
            physics: {
                gravity: parseFloat(dom.cfgGravity.value),
                bounce: parseFloat(dom.cfgBounce.value),
                friction: parseFloat(dom.cfgFriction.value)
            },
            jarVisible: dom.cfgJarVisible.checked,
            jarLocked: !!(dom.cfgJarLocked && dom.cfgJarLocked.checked),
            features,
            goal: { target: Math.max(100, parseInt(dom.cfgGoal.value, 10) || 5000) },
            goalBarGap: parseFloat(dom.cfgGoalGap?.value ?? -1.2),
            autoShakeAt: parseInt(dom.cfgShakeAt.value, 10) || 0,
            thiefMissRate: (parseInt(dom.cfgThiefMiss.value, 10) || 0) / 100,
            policeCatchRate: (parseInt(dom.cfgPoliceRate.value, 10) || 0) / 100,
            policeBanSec: parseInt(dom.cfgPoliceBan.value, 10) || 30,
            policeName: (dom.cfgPoliceName?.value || '').trim(),
            panelScales: {
                leaderboard: parseFloat(dom.cfgScaleLb.value) || 1,
                caught: parseFloat(dom.cfgScaleCaught.value) || 1
            },
            actorScales: {
                thief: parseFloat(dom.cfgScaleThief?.value) || 1,
                police: parseFloat(dom.cfgScalePolice?.value) || 1,
                osin: parseFloat(dom.cfgScaleOsin?.value) || 1,
                ufo: parseFloat(dom.cfgScaleUfo?.value) || 1
            },
            jarAccessory: dom.cfgJarAccessory?.value || 'none',
            jarTheme: dom.cfgJarTheme?.value || 'default',
            badges: {
                enabled: !!dom.cfgBadgesEnabled?.checked,
                layout: dom.cfgBadgesLayout?.value || 'vertical',
                defaultNamePos: dom.cfgBadgesNamepos?.value || 'right',
                scale: parseFloat(dom.cfgBadgesScale?.value) || 1,
                iconScale: parseFloat(dom.cfgBadgesIconScale?.value) || 1,
                items: JSON.parse(JSON.stringify(currentBadgeItems || {})),
                extras: JSON.parse(JSON.stringify(currentBadgeExtras || []))
            },
            triggers: JSON.parse(JSON.stringify(currentTriggers || {})),
            effects: JSON.parse(JSON.stringify(currentEffectsConfig || {}))
        };
    }

    let saveCfgTimer = null;
    let lastOwnSaveTs = 0;  // timestamp lần POST cuối — dùng để bỏ qua echo từ socket
    function pushConfigUpdate(immediate) {
        if (!gameInstance || !currentGame) return;
        const cfg = gatherConfig();
        gameInstance.setConfig(cfg);
        dom.cfgGravityV.textContent = cfg.physics.gravity;
        dom.cfgBounceV.textContent = cfg.physics.bounce;
        dom.cfgFrictionV.textContent = cfg.physics.friction;
        dom.cfgJarHV.textContent = cfg.jar.height;
        dom.cfgGminV.textContent = cfg.gift.minSize;
        dom.cfgGmaxV.textContent = cfg.gift.maxSize;
        if (dom.cfgGoalV) dom.cfgGoalV.textContent = cfg.goal.target;
        if (dom.cfgShakeAtV) dom.cfgShakeAtV.textContent = cfg.autoShakeAt;
        if (dom.cfgThiefMissV) dom.cfgThiefMissV.textContent = Math.round((cfg.thiefMissRate || 0) * 100);
        if (dom.cfgPoliceRateV) dom.cfgPoliceRateV.textContent = Math.round((cfg.policeCatchRate || 0) * 100);
        if (dom.cfgPoliceBanV) dom.cfgPoliceBanV.textContent = cfg.policeBanSec;
        if (dom.cfgScaleLbV) dom.cfgScaleLbV.textContent = cfg.panelScales.leaderboard;
        if (dom.cfgScaleCaughtV) dom.cfgScaleCaughtV.textContent = cfg.panelScales.caught;
        if (dom.cfgScaleThiefV) dom.cfgScaleThiefV.textContent = cfg.actorScales.thief;
        if (dom.cfgScalePoliceV) dom.cfgScalePoliceV.textContent = cfg.actorScales.police;
        if (dom.cfgScaleOsinV) dom.cfgScaleOsinV.textContent = cfg.actorScales.osin;
        if (dom.cfgScaleUfoV) dom.cfgScaleUfoV.textContent = cfg.actorScales.ufo;
        if (dom.cfgBadgesScaleV) dom.cfgBadgesScaleV.textContent = cfg.badges?.scale ?? 1;
        if (dom.cfgBadgesIconScaleV) dom.cfgBadgesIconScaleV.textContent = cfg.badges?.iconScale ?? 1;
        setSaveStatus('saving');
        clearTimeout(saveCfgTimer);
        const doSave = () => {
            lastOwnSaveTs = Date.now();
            return fetch(`/api/games/${currentGame.id}/config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            })
            .then(r => r.ok ? setSaveStatus('saved') : setSaveStatus('error'))
            .catch(() => setSaveStatus('error'));
        };
        if (immediate) doSave();
        else saveCfgTimer = setTimeout(doSave, 400);
    }
    // Toast nhanh khi gán/xoá trigger — không đè save-status
    let triggerToastEl = null;
    let triggerToastTimer = null;
    function flashTriggerToast(text) {
        if (!triggerToastEl) {
            triggerToastEl = document.createElement('div');
            triggerToastEl.className = 'trigger-toast';
            document.body.appendChild(triggerToastEl);
        }
        triggerToastEl.textContent = text;
        triggerToastEl.classList.add('show');
        clearTimeout(triggerToastTimer);
        triggerToastTimer = setTimeout(() => triggerToastEl.classList.remove('show'), 2500);
    }
    function setSaveStatus(state) {
        if (!dom.saveStatus) return;
        dom.saveStatus.classList.remove('saving', 'saved');
        if (state === 'saving') {
            dom.saveStatus.classList.add('saving');
            dom.saveStatus.textContent = '💾 Đang lưu...';
        } else if (state === 'saved') {
            dom.saveStatus.classList.add('saved');
            dom.saveStatus.textContent = '✓ Đã lưu cài đặt (đồng bộ overlay OBS)';
            clearTimeout(setSaveStatus._t);
            setSaveStatus._t = setTimeout(() => {
                dom.saveStatus.classList.remove('saved');
                dom.saveStatus.textContent = 'Cài đặt tự động lưu';
            }, 2000);
        } else if (state === 'error') {
            dom.saveStatus.textContent = '⚠ Lưu thất bại';
        }
    }

    // ===== Trigger UI (compact: icon + preview + ⚙) =====
    // Render quick-test grid trong tab Thử — hiện các quà đã gán hiệu ứng để test nhanh
    function renderQuickTestGrid() {
        const grid = document.getElementById('quick-test-grid');
        const empty = document.getElementById('quick-test-empty');
        if (!grid) return;
        grid.innerHTML = '';
        const entries = Object.entries(currentTriggers || {});
        if (!entries.length) {
            if (empty) empty.hidden = false;
            return;
        }
        if (empty) empty.hidden = true;
        const frag = document.createDocumentFragment();
        for (const [giftId, action] of entries) {
            const g = giftMap[String(giftId)];
            const ef = EFFECTS.find(e => e.key === action);
            if (!g) continue;
            const card = document.createElement('div');
            card.className = 'quick-test-card';
            card.title = `${g.name || 'Quà'} (ID ${giftId}) → ${ef?.label || action}`;
            const img = document.createElement('img');
            img.src = g.image || '';
            img.alt = g.name || '';
            img.onerror = () => { img.style.display = 'none'; };
            const name = document.createElement('div');
            name.className = 'qt-name';
            name.textContent = g.name || `ID ${giftId}`;
            const actBadge = document.createElement('div');
            actBadge.className = 'qt-action';
            // Hiển thị icon to + tooltip text khi hover
            actBadge.textContent = ef?.ico || '?';
            actBadge.title = ef?.label || action;
            card.appendChild(actBadge);
            card.appendChild(img);
            card.appendChild(name);
            card.addEventListener('click', () => {
                if (!currentGame) return;
                fetch(`/api/games/${currentGame.id}/test-gift`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ giftId, count: 1, nickname: 'Test' })
                }).catch(() => {});
            });
            frag.appendChild(card);
        }
        grid.appendChild(frag);
    }

    function renderTriggerList() {
        if (!dom.triggerList) return;
        renderQuickTestGrid();   // sync quick-test khi triggers thay đổi
        dom.triggerList.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const ef of EFFECTS) {
            const row = document.createElement('div');
            row.className = 'trigger-row';
            const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = ef.ico;
            const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = ef.label;
            const prev = document.createElement('span'); prev.className = 'preview';
            if (ef.multi) {
                // Multi: hiện stack thumbnail (tối đa 3) + count badge nếu nhiều hơn
                const ids = giftIdsForEffect(ef.key);
                prev.classList.add('preview-multi');
                const show = ids.slice(0, 3);
                for (const id of show) {
                    const g = giftMap[String(id)];
                    if (g?.image) {
                        const im = document.createElement('img');
                        im.src = g.image; im.title = g.name;
                        prev.appendChild(im);
                    }
                }
                if (ids.length > 3) {
                    const more = document.createElement('span');
                    more.className = 'more';
                    more.textContent = '+' + (ids.length - 3);
                    prev.appendChild(more);
                }
            } else {
                const giftId = Object.keys(currentTriggers).find(id => currentTriggers[id] === ef.key) || '';
                const g = giftMap[String(giftId)];
                if (g?.image) {
                    const im = document.createElement('img'); im.src = g.image; im.title = g.name; prev.appendChild(im);
                }
            }
            const gear = document.createElement('button');
            gear.className = 'gear'; gear.title = `Cài đặt ${ef.label}`; gear.textContent = '⚙';
            gear.addEventListener('click', () => openEffectModal(ef));
            row.appendChild(ico); row.appendChild(lbl); row.appendChild(prev); row.appendChild(gear);
            frag.appendChild(row);
        }
        dom.triggerList.appendChild(frag);
    }
    function populateGiftDatalist() { /* legacy noop — modal có picker riêng */ }

    // ===== Modal: cài đặt riêng cho từng effect =====
    const modal = document.getElementById('effect-modal');
    const modalIco = document.getElementById('ef-modal-ico');
    const modalName = document.getElementById('ef-modal-name');
    const efCurrent = document.getElementById('ef-current-gift');
    const efPicker = document.getElementById('ef-gift-picker');
    const efParams = document.getElementById('ef-params');
    const btnPick = document.getElementById('ef-pick-gift');
    const btnClearGift = document.getElementById('ef-clear-gift');
    const btnClose = document.getElementById('ef-modal-close');
    const btnCancel = document.getElementById('ef-modal-cancel');
    const btnSave = document.getElementById('ef-modal-save');
    let editingEffect = null;       // ef object
    let editingDraft = null;        // { giftId, params }
    let currentEffectsConfig = {};  // local copy

    function openEffectModal(ef) {
        editingEffect = ef;
        if (ef.multi) {
            // Multi-effect: edit danh sách giftIds
            editingDraft = {
                giftIds: giftIdsForEffect(ef.key).slice(),
                params: JSON.parse(JSON.stringify(currentEffectsConfig[ef.key] || {}))
            };
            if (btnPick) btnPick.textContent = 'Thêm quà';
            if (btnClearGift) btnClearGift.textContent = 'Xoá tất cả';
        } else {
            const existingGift = Object.keys(currentTriggers).find(id => currentTriggers[id] === ef.key) || '';
            editingDraft = {
                giftId: existingGift,
                params: JSON.parse(JSON.stringify(currentEffectsConfig[ef.key] || {}))
            };
            if (btnPick) btnPick.textContent = 'Chọn quà';
            if (btnClearGift) btnClearGift.textContent = 'Xoá';
        }
        modalIco.textContent = ef.ico;
        modalName.textContent = ef.label;
        renderModalGift();
        renderModalParams();
        renderBadgeFields(ef);
        efPicker.hidden = true;
        modal.hidden = false;
    }
    // Render trường badge config cho gift đang gán (chỉ hiện nếu có gift được chỉ định)
    function renderBadgeFields(ef) {
        const section = document.getElementById('ef-badge-section');
        if (!section) return;
        const giftId = editingDraft?.giftId;
        if (!giftId || ef.multi) {
            section.hidden = true;
            return;
        }
        section.hidden = false;
        const item = currentBadgeItems[giftId] || { customLabel: '', namePos: '', enabled: true };
        const enabledEl = document.getElementById('ef-badge-enabled');
        const labelEl = document.getElementById('ef-badge-label');
        const nameposEl = document.getElementById('ef-badge-namepos');
        if (enabledEl) enabledEl.checked = item.enabled !== false;
        if (labelEl) labelEl.value = item.customLabel || '';
        if (labelEl) labelEl.placeholder = ef.label;
        // Default = '' (theo global). User chỉ chọn override khi muốn khác global.
        if (nameposEl) nameposEl.value = item.namePos || '';
    }
    // Lưu badge config từ modal vào currentBadgeItems — chỉ lưu namePos nếu KHÔNG rỗng
    function saveBadgeFieldsFromModal() {
        const giftId = editingDraft?.giftId;
        if (!giftId || editingEffect?.multi) return;
        const enabledEl = document.getElementById('ef-badge-enabled');
        const labelEl = document.getElementById('ef-badge-label');
        const nameposEl = document.getElementById('ef-badge-namepos');
        const namePosValue = nameposEl?.value || '';
        const entry = {
            enabled: enabledEl ? !!enabledEl.checked : true,
            customLabel: (labelEl?.value || '').trim()
        };
        // Chỉ lưu namePos nếu user explicit chọn (KHÔNG là "Theo mặc định")
        if (namePosValue) entry.namePos = namePosValue;
        currentBadgeItems[giftId] = entry;
    }
    function closeEffectModal() {
        modal.hidden = true;
        editingEffect = null;
        editingDraft = null;
    }
    function renderModalGift() {
        if (editingEffect?.multi) {
            // Render danh sách chip giftIds + nút × để xoá
            efCurrent.classList.add('ef-current-multi');
            efCurrent.innerHTML = '';
            const ids = editingDraft.giftIds || [];
            if (!ids.length) {
                const note = document.createElement('span');
                note.className = 'ef-empty';
                note.textContent = '— Chưa gán quà nào — Bấm "Thêm quà" →';
                efCurrent.appendChild(note);
                return;
            }
            for (const id of ids) {
                const g = giftMap[String(id)];
                const chip = document.createElement('div');
                chip.className = 'ef-chip';
                chip.title = g?.name || ('ID ' + id);
                if (g?.image) {
                    const im = document.createElement('img'); im.src = g.image; chip.appendChild(im);
                }
                const nm = document.createElement('span'); nm.className = 'nm';
                nm.textContent = g?.name || ('ID ' + id); chip.appendChild(nm);
                const rm = document.createElement('button');
                rm.className = 'rm'; rm.title = 'Bỏ quà này'; rm.textContent = '×';
                rm.addEventListener('click', () => {
                    editingDraft.giftIds = (editingDraft.giftIds || []).filter(x => x !== id);
                    // AUTO-COMMIT — đồng bộ với cách pick ở picker (không cần bấm Lưu)
                    commitMultiDraftToTriggers();
                    pushConfigUpdate(true);
                    renderModalGift();
                    renderTriggerList();
                    if (dom.giftCatalogEl) renderGiftCatalog(dom.giftSearchInput.value);
                });
                chip.appendChild(rm);
                efCurrent.appendChild(chip);
            }
            return;
        }
        efCurrent.classList.remove('ef-current-multi');
        if (!editingDraft?.giftId) {
            efCurrent.textContent = '— Chưa gán —';
            return;
        }
        const g = giftMap[String(editingDraft.giftId)];
        if (!g) { efCurrent.textContent = `ID ${editingDraft.giftId}`; return; }
        efCurrent.innerHTML = '';
        const im = document.createElement('img'); im.src = g.image;
        const info = document.createElement('div'); info.className = 'info';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = g.name;
        const id = document.createElement('span'); id.className = 'id'; id.textContent = `ID ${g.id} · ${g.diamond}⭐`;
        info.appendChild(nm); info.appendChild(id);
        efCurrent.appendChild(im); efCurrent.appendChild(info);
    }
    function renderModalParams() {
        const k = editingEffect.key;
        const defs = paramDefsFor(k);
        efParams.innerHTML = '';
        if (!defs.length) {
            const note = document.createElement('div');
            note.className = 'hint'; note.style.padding = '4px 0';
            note.textContent = 'Hiệu ứng này không có thông số tuỳ chỉnh.';
            efParams.appendChild(note);
            return;
        }
        const title = document.createElement('div');
        title.className = 'modal-sec-title'; title.textContent = '⚙ Thông số';
        efParams.appendChild(title);
        // Helper: render 1 control trong row (return DOM nodes append). Dùng cho cả row đơn lẫn
        // row gộp 2 control trong 1 hàng (vd: 'Hiện tên user' + 'Màu chữ' cùng dòng cho gọn).
        const renderControl = (d, container) => {
            const lbl = document.createElement('label'); lbl.textContent = d.label;
            const cur = (editingDraft.params[d.key] !== undefined) ? editingDraft.params[d.key] : d.default;
            if (d.type === 'checkbox') {
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = !!cur;
                cb.addEventListener('change', () => { editingDraft.params[d.key] = cb.checked; });
                // Tight layout: checkbox kẹp sát label
                const wrap = document.createElement('span');
                wrap.className = 'ef-inline-cb';
                wrap.appendChild(cb); wrap.appendChild(lbl);
                container.appendChild(wrap);
                return;
            }
            if (d.type === 'color') {
                const cp = document.createElement('input');
                cp.type = 'color'; cp.value = String(cur || '#ffd166');
                cp.addEventListener('input', () => { editingDraft.params[d.key] = cp.value; });
                const wrap = document.createElement('span');
                wrap.className = 'ef-inline-color';
                wrap.appendChild(lbl); wrap.appendChild(cp);
                container.appendChild(wrap);
                return;
            }
        };

        for (const d of defs) {
            // 'row' = gộp nhiều control inline (compact)
            if (d.type === 'row') {
                const row = document.createElement('div');
                row.className = 'ef-param-row ef-param-row-inline';
                for (const sub of (d.items || [])) renderControl(sub, row);
                efParams.appendChild(row);
                continue;
            }
            const row = document.createElement('div'); row.className = 'ef-param-row';
            const lbl = document.createElement('label'); lbl.textContent = d.label;
            const cur = (editingDraft.params[d.key] !== undefined) ? editingDraft.params[d.key] : d.default;
            if (d.type === 'text') {
                row.classList.add('ef-param-text');
                const input = document.createElement('input');
                input.type = 'text';
                input.value = String(cur || '');
                if (d.placeholder) input.placeholder = d.placeholder;
                input.addEventListener('input', () => { editingDraft.params[d.key] = input.value; });
                row.appendChild(lbl); row.appendChild(input);
                efParams.appendChild(row);
                if (d.hint) {
                    const hint = document.createElement('div');
                    hint.className = 'ef-param-hint';
                    hint.textContent = d.hint;
                    efParams.appendChild(hint);
                }
                continue;
            }
            if (d.type === 'select') {
                const sel = document.createElement('select');
                for (const op of (d.options || [])) {
                    const o = document.createElement('option');
                    o.value = op.v; o.textContent = op.label;
                    if (String(cur) === String(op.v)) o.selected = true;
                    sel.appendChild(o);
                }
                sel.addEventListener('change', () => { editingDraft.params[d.key] = sel.value; });
                row.appendChild(lbl); row.appendChild(sel);
                efParams.appendChild(row);
                continue;
            }
            if (d.type === 'checkbox') {
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = !!cur;
                cb.addEventListener('change', () => { editingDraft.params[d.key] = cb.checked; });
                row.appendChild(lbl); row.appendChild(cb);
                efParams.appendChild(row);
                continue;
            }
            if (d.type === 'color') {
                const cp = document.createElement('input');
                cp.type = 'color'; cp.value = String(cur || '#ffd166');
                cp.addEventListener('input', () => { editingDraft.params[d.key] = cp.value; });
                row.appendChild(lbl); row.appendChild(cp);
                efParams.appendChild(row);
                continue;
            }
            const input = document.createElement('input');
            input.type = 'range'; input.min = String(d.min); input.max = String(d.max); input.step = String(d.step);
            input.value = String(cur);
            const v = document.createElement('span'); v.className = 'v'; v.textContent = formatVal(d, cur);
            input.addEventListener('input', () => {
                const val = d.parser ? d.parser(input.value) : parseFloat(input.value);
                editingDraft.params[d.key] = val;
                v.textContent = formatVal(d, val);
            });
            row.appendChild(lbl); row.appendChild(input); row.appendChild(v);
            efParams.appendChild(row);
        }
    }
    function formatVal(d, val) {
        return d.suffix ? (val + d.suffix) : String(val);
    }
    function paramDefsFor(key) {
        switch (key) {
            case 'tornado':
            case 'megaboom':
            case 'fireworks':
            case 'shake':
            case 'tilt':
                return [{ key: 'intensity', label: 'Cường độ', min: 0.2, max: 3, step: 0.1, default: 1 }];
            case 'gravflip':
                return [{ key: 'durationMs', label: 'Thời gian', min: 500, max: 6000, step: 100, default: 2200, suffix: 'ms' }];
            case 'slow':
                return [
                    { key: 'timeScale', label: 'Hệ số chậm', min: 0.05, max: 0.9, step: 0.05, default: 0.25 },
                    { key: 'durationMs', label: 'Thời gian', min: 500, max: 8000, step: 100, default: 3000, suffix: 'ms' }
                ];
            case 'crackJar':
                return [
                    { key: 'durationSec', label: 'Thời gian', min: 1, max: 30, step: 1, default: 5, suffix: 's' },
                    { key: 'count', label: 'Số đường nứt', min: 2, max: 20, step: 1, default: 6 },
                    { key: 'shatterAt', label: 'Vỡ khi đạt', min: 2, max: 20, step: 1, default: 3, suffix: ' lần' }
                ];
            case 'stealJar':
                return [
                    { key: 'durationSec', label: 'Thời gian', min: 3, max: 60, step: 1, default: 8, suffix: 's' }
                ];
            case 'combo':
                return [
                    { key: 'sequence', label: 'Chuỗi', type: 'text', default: 'crackJar:0,crackJar:1.5,crackJar:3,stealJar:5',
                      hint: 'effect:giâyDelay, cách nhau bằng dấu phẩy. VD: crackJar:0,stealJar:2' }
                ];
            case 'shape':
                return [
                    { key: 'type', label: 'Kiểu hình', type: 'select', default: 'heart',
                      options: [
                          { v: 'heart',    label: '❤️ Trái tim' },
                          { v: 'star',     label: '⭐ Ngôi sao' },
                          { v: 'circle',   label: '⚪ Tròn' },
                          { v: 'triangle', label: '🔺 Tam giác' },
                          { v: 'diamond',  label: '🔷 Kim cương' },
                          { v: 'smile',    label: '😊 Mặt cười' },
                          { v: 'text',     label: '🔤 Chữ tuỳ ý' }
                      ] },
                    { key: 'customText', label: 'Chữ (khi chọn Chữ)', type: 'text', default: '',
                      placeholder: 'VD: LOVE, HP, Cảm ơn (≤16 ký tự, hỗ trợ tiếng Việt)',
                      hint: 'Chỉ áp dụng khi "Kiểu hình" = Chữ tuỳ ý' },
                    { key: 'sizePercent', label: 'Kích thước hình', min: 20, max: 95, step: 5, default: 65, suffix: '%' },
                    { key: 'durationMs', label: 'Thời gian giữ', min: 1000, max: 10000, step: 250, default: 3000, suffix: 'ms' },
                    { key: 'nameSize', label: 'Cỡ chữ tên', min: 24, max: 200, step: 4, default: 64, suffix: 'px' },
                    // Gộp 2 control thành 1 hàng (compact)
                    { type: 'row', items: [
                        { key: 'showName', label: 'Hiện tên user', type: 'checkbox', default: true },
                        { key: 'color',    label: 'Màu chữ',       type: 'color',    default: '#ffd166' }
                    ] }
                ];
            default: return [];
        }
    }
    function openModalPicker() {
        efPicker.hidden = false;
        efPicker.innerHTML = '';
        const frag = document.createDocumentFragment();
        const isMulti = !!editingEffect.multi;
        const draftMultiIds = isMulti ? new Set((editingDraft.giftIds || []).map(String)) : null;
        // Hiển thị toàn bộ; quà đã gán cho hiệu ứng KHÁC sẽ bị disable.
        // Multi: quà đã có trong draft hiển thị "Đã thêm" (active) — bấm để bỏ.
        for (const g of giftSheet) {
            const assignedTo = currentTriggers[String(g.id)];
            const isTakenByOther = assignedTo && assignedTo !== editingEffect.key;
            const alreadyInDraft = isMulti && draftMultiIds.has(String(g.id));
            const pg = document.createElement('div'); pg.className = 'pg';
            if (isTakenByOther) {
                const otherEf = EFFECTS.find(e => e.key === assignedTo);
                pg.classList.add('pg-disabled');
                pg.title = `Đã gán cho ${otherEf?.label || assignedTo}`;
            } else if (alreadyInDraft) {
                pg.classList.add('pg-active');
                pg.title = `Đang được thêm vào ${editingEffect.label}. Bấm để bỏ.`;
            } else {
                pg.title = g.name;
            }
            const badge = isTakenByOther
                ? `<div class="pg-badge">${(EFFECTS.find(e => e.key === assignedTo)?.ico || '·')}</div>`
                : (alreadyInDraft ? `<div class="pg-badge">✓</div>` : '');
            pg.innerHTML = `${badge}<img src="${g.image}" /><div class="nm">${g.name || ''}</div><div class="di">${g.diamond}⭐</div>`;
            if (isTakenByOther) {
                pg.addEventListener('click', () => {
                    const otherEf = EFFECTS.find(e => e.key === assignedTo);
                    alert(`Quà "${g.name}" đã được gán cho hiệu ứng "${otherEf?.label || assignedTo}". Hãy xoá gán cũ trước.`);
                });
            } else if (isMulti) {
                pg.addEventListener('click', () => {
                    const id = String(g.id);
                    const arr = editingDraft.giftIds || (editingDraft.giftIds = []);
                    const idx = arr.indexOf(id);
                    if (idx >= 0) arr.splice(idx, 1);
                    else arr.push(id);
                    // AUTO-COMMIT cho multi: mỗi lần thêm/bớt quà thì lưu NGAY vào currentTriggers
                    // + push lên server. Tránh tình trạng user pick xong tưởng đã lưu mà thực ra
                    // chưa bấm "Lưu" → mở lại modal là mất.
                    commitMultiDraftToTriggers();
                    pushConfigUpdate(true);
                    renderModalGift();
                    renderTriggerList();
                    if (dom.giftCatalogEl) renderGiftCatalog(dom.giftSearchInput.value);
                    openModalPicker();   // re-render picker để cập nhật trạng thái active
                });
            } else {
                pg.addEventListener('click', () => {
                    editingDraft.giftId = String(g.id);
                    renderModalGift();
                    renderBadgeFields(editingEffect);   // refresh badge fields cho gift mới
                    efPicker.hidden = true;
                });
            }
            frag.appendChild(pg);
        }
        efPicker.appendChild(frag);
    }
    btnPick?.addEventListener('click', () => {
        if (efPicker.hidden) openModalPicker();
        else efPicker.hidden = true;
    });
    btnClearGift?.addEventListener('click', () => {
        if (editingEffect?.multi) {
            editingDraft.giftIds = [];
            // Auto-commit: clear ngay trong currentTriggers + push
            commitMultiDraftToTriggers();
            pushConfigUpdate(true);
            renderTriggerList();
            if (dom.giftCatalogEl) renderGiftCatalog(dom.giftSearchInput.value);
        } else {
            editingDraft.giftId = '';
        }
        renderModalGift();
        efPicker.hidden = true;
    });
    btnClose?.addEventListener('click', closeEffectModal);
    btnCancel?.addEventListener('click', closeEffectModal);
    btnSave?.addEventListener('click', () => {
        if (!editingEffect || !editingDraft) return closeEffectModal();
        // 1) Cập nhật triggers
        if (editingEffect.multi) {
            // Multi: commit helper tự diff giữa old/new + bump/drop recent đúng cách
            commitMultiDraftToTriggers();
        } else {
            // Single: xoá toàn bộ assignment cũ của effect này, drop khỏi recent, rồi gán mới
            for (const k of Object.keys(currentTriggers)) {
                if (currentTriggers[k] === editingEffect.key) {
                    dropRecent(k);
                    delete currentTriggers[k];
                }
            }
            if (editingDraft.giftId) {
                currentTriggers[String(editingDraft.giftId)] = editingEffect.key;
                bumpRecent(editingDraft.giftId);
            }
        }
        // 2) Cập nhật effects params
        currentEffectsConfig[editingEffect.key] = editingDraft.params;
        // 2b) Cập nhật badge config cho gift này (nếu single + có gift)
        saveBadgeFieldsFromModal();
        // 3) Save NGAY
        renderTriggerList();
        renderGiftCatalog(dom.giftSearchInput.value);
        pushConfigUpdate(true);
        if (editingEffect.multi) {
            const count = (editingDraft.giftIds || []).length;
            flashTriggerToast(count
                ? `✓ Đã gán ${count} quà → ${editingEffect.ico} ${editingEffect.label}`
                : `✓ Đã lưu cài đặt ${editingEffect.label}`);
        } else {
            const g = editingDraft.giftId ? giftMap[String(editingDraft.giftId)] : null;
            flashTriggerToast(g
                ? `✓ Đã gán ${g.name} → ${editingEffect.ico} ${editingEffect.label}`
                : `✓ Đã lưu cài đặt ${editingEffect.label}`);
        }
        closeEffectModal();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !modal.hidden) closeEffectModal(); });

    // ===== Comments / gifts =====
    function appendComment(c) {
        if (!dom.commentsEl) return;
        // Bumps unread badge khi popup đang đóng
        if (!isPopupOpen()) setUnread(unreadComments + 1);
        const div = document.createElement('div');
        div.className = 'comment-item';
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (c.profilePicture) {
            const img = document.createElement('img');
            img.src = c.profilePicture;
            img.onerror = () => avatar.removeChild(img);
            avatar.appendChild(img);
        }
        const body = document.createElement('div');
        body.className = 'body';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = c.nickname || c.uniqueId || 'guest';
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = c.comment || '';
        body.appendChild(name);
        body.appendChild(text);
        div.appendChild(avatar);
        div.appendChild(body);
        dom.commentsEl.appendChild(div);
        if (dom.commentsEl.children.length > 200) dom.commentsEl.removeChild(dom.commentsEl.firstChild);
        dom.commentsEl.scrollTop = dom.commentsEl.scrollHeight;
    }

    function appendGiftEvent(g) {
        if (!dom.giftStreamEl) return;
        const sheet = giftMap[String(g.giftId)];
        const item = document.createElement('div');
        item.className = 'gift-event';
        item.title = 'Bấm để thả vào hũ';
        const img = document.createElement('img');
        img.src = sheet?.image || g.image || g.giftPicture || placeholderImg;
        img.onerror = () => { img.src = placeholderImg; };
        const info = document.createElement('div');
        info.className = 'info';
        const who = document.createElement('div'); who.className = 'who';
        who.textContent = g.nickname || g.uniqueId || 'guest';
        const what = document.createElement('div'); what.className = 'what';
        what.textContent = sheet?.name || g.giftName || 'Quà';
        const idLine = document.createElement('div'); idLine.className = 'id';
        idLine.textContent = `ID ${g.giftId} · ${g.coinValue || sheet?.diamond || ''}⭐`;
        info.appendChild(who); info.appendChild(what); info.appendChild(idLine);
        const qty = document.createElement('div'); qty.className = 'qty';
        qty.textContent = `x${g.repeatCount || 1}`;
        item.appendChild(img); item.appendChild(info); item.appendChild(qty);

        // Click thả thử vào game preview
        item.addEventListener('click', () => spawnInGame(g));
        dom.giftStreamEl.appendChild(item);
        if (dom.giftStreamEl.children.length > 80) dom.giftStreamEl.removeChild(dom.giftStreamEl.firstChild);
        dom.giftStreamEl.scrollTop = dom.giftStreamEl.scrollHeight;
    }

    function spawnInGame(g) {
        if (!gameInstance) return;
        const sheet = giftMap[String(g.giftId)];
        gameInstance.drop({
            giftId: String(g.giftId),
            giftName: sheet?.name || g.giftName,
            image: sheet?.image || g.image || g.giftPicture,
            coinValue: g.coinValue || sheet?.diamond || 1,
            userId: g.userId,
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            profilePicture: g.profilePicture
        }, g.repeatCount || 1);
    }

    function renderGiftCatalog(filter = '') {
        if (!dom.giftCatalogEl) return;
        dom.giftCatalogEl.innerHTML = '';
        const f = filter.trim().toLowerCase();
        // ẨN các quà đã gán hiệu ứng (đã hiển thị ở quick-test grid bên trái tab Thử)
        // → Tránh hiển thị 2 lần và làm giảm số card trong DANH SÁCH QUÀ
        let list = giftSheet.filter(g => !currentTriggers[String(g.id)]);
        if (f) {
            list = list.filter(g =>
                g.id.toLowerCase().includes(f) || (g.name || '').toLowerCase().includes(f)
            );
        }
        const frag = document.createDocumentFragment();
        // Render toàn bộ list (DOM grid 619 cards vẫn nhẹ). Trước đây slice(0,400)
        // khiến sort ASC theo Kim Cương bị cắt mất 219 quà cao nhất.
        for (const g of list) {
            const card = document.createElement('div');
            card.className = 'gift-card';
            if (g.custom) card.classList.add('is-custom');
            const im = document.createElement('img');
            im.loading = 'lazy';
            im.src = g.image || placeholderImg;
            im.onerror = () => { im.src = placeholderImg; };
            const nm = document.createElement('div');
            nm.className = 'name';
            nm.title = g.name || '';
            nm.textContent = g.name || '';
            const idL = document.createElement('div');
            idL.className = 'id';
            idL.textContent = `ID ${g.id}`;
            const di = document.createElement('div');
            di.className = 'diamond';
            di.textContent = `${g.diamond || 0}⭐`;
            card.appendChild(im);
            card.appendChild(nm);
            card.appendChild(idL);
            card.appendChild(di);
            // Hiển thị badge nếu đã gán effect
            const action = currentTriggers[String(g.id)];
            if (action) {
                card.classList.add('has-trigger');
                const ef = EFFECTS.find(e => e.key === action);
                if (ef) {
                    const badge = document.createElement('div');
                    badge.className = 'trigger-badge';
                    badge.textContent = ef.ico;
                    badge.title = `Đang gán: ${ef.label}`;
                    card.appendChild(badge);
                }
            }
            card.addEventListener('click', () => {
                fetch(`/api/games/${currentGame?.id || 'thuytinh'}/test-gift`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ giftId: g.id, count: 1, nickname: 'preview' })
                }).catch(() => {});
            });
            // Chuột phải → mở context menu gán effect
            card.addEventListener('contextmenu', (ev) => {
                ev.preventDefault();
                openGiftContextMenu(g, ev.clientX, ev.clientY);
            });
            frag.appendChild(card);
        }
        dom.giftCatalogEl.appendChild(frag);
    }

    // ===== Gift context menu =====
    const ctxMenu = document.getElementById('gift-context-menu');
    const cmCurrent = document.getElementById('cm-current');
    const cmList = document.getElementById('cm-list');
    const cmClear = document.getElementById('cm-clear');
    let cmGift = null;
    function openGiftContextMenu(gift, clientX, clientY) {
        if (!ctxMenu) return;
        cmGift = gift;
        const currentAction = currentTriggers[String(gift.id)];
        const ef = EFFECTS.find(e => e.key === currentAction);
        cmCurrent.innerHTML = `<b>${escHtml(gift.name)}</b> · ID ${gift.id} · ${gift.diamond || 0}⭐`
            + (ef ? `<br/>Đang gán: <span style="color:#ffd166">${ef.ico} ${ef.label}</span>` : '');
        cmList.innerHTML = '';
        for (const e of EFFECTS) {
            const btn = document.createElement('button');
            btn.dataset.effect = e.key;
            btn.innerHTML = `<span>${e.ico}</span> ${e.label}`;
            if (currentAction === e.key) btn.classList.add('active');
            btn.addEventListener('click', () => assignTrigger(gift.id, e.key));
            cmList.appendChild(btn);
        }
        ctxMenu.hidden = false;
        // Đảm bảo menu không tràn khỏi viewport
        const vw = window.innerWidth, vh = window.innerHeight;
        ctxMenu.style.left = '0px'; ctxMenu.style.top = '0px';
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.min(vw - w - 8, clientX) + 'px';
        ctxMenu.style.top = Math.min(vh - h - 8, clientY) + 'px';
    }
    function closeGiftContextMenu() {
        if (ctxMenu) ctxMenu.hidden = true;
        cmGift = null;
    }
    function assignTrigger(giftId, effect) {
        const multi = isMultiEffect(effect);
        if (!multi) {
            // Single: xoá assignment cũ của effect này (1 effect → 1 quà).
            // Cũng xoá khỏi recent vì quà cũ không còn được gán nữa.
            for (const k of Object.keys(currentTriggers)) {
                if (currentTriggers[k] === effect) {
                    dropRecent(k);
                    delete currentTriggers[k];
                }
            }
        }
        currentTriggers[String(giftId)] = effect;
        bumpRecent(giftId);   // Quà vừa gán → lên đầu catalog
        closeGiftContextMenu();
        renderTriggerList();
        renderGiftCatalog(dom.giftSearchInput.value);
        pushConfigUpdate(true); // save NGAY, không debounce
        const ef = EFFECTS.find(e => e.key === effect);
        const g = giftMap[String(giftId)];
        flashTriggerToast(`✓ Đã gán ${g?.name || 'quà'} → ${ef?.ico || ''} ${ef?.label || effect}`);
    }
    cmClear?.addEventListener('click', () => {
        if (!cmGift) return;
        const removed = currentTriggers[String(cmGift.id)];
        delete currentTriggers[String(cmGift.id)];
        dropRecent(cmGift.id);
        closeGiftContextMenu();
        renderTriggerList();
        renderGiftCatalog(dom.giftSearchInput.value);
        pushConfigUpdate(true);
        if (removed) flashTriggerToast(`✗ Đã xoá gán cho ${cmGift.name}`);
    });
    document.addEventListener('click', (ev) => {
        if (!ctxMenu || ctxMenu.hidden) return;
        if (!ctxMenu.contains(ev.target)) closeGiftContextMenu();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeGiftContextMenu(); });
    function escHtml(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

    // ===== Wire UI =====
    let isLiveConnected = false;
    let liveUsername = '';

    function setConnectedUI(connected, username) {
        isLiveConnected = !!connected;
        liveUsername = username || '';
        const statusRow = document.getElementById('status-row');
        if (connected) {
            if (dom.connRow) dom.connRow.style.display = 'none';
            dom.btnConnect.classList.remove('primary');
            dom.btnConnect.classList.add('secondary');
            dom.btnConnect.disabled = false;
            dom.btnConnect.innerHTML = `<span class="conn-dot"></span><span class="conn-name">@${escAttrInline(liveUsername)}</span><span class="conn-eject" title="Ngắt kết nối">⏻</span>`;
            if (dom.liveStatsGrid) dom.liveStatsGrid.hidden = false;
            // Ẩn status-row khi connected (button + stats đã đủ thông tin)
            if (statusRow) statusRow.style.display = 'none';
        } else {
            if (dom.connRow) dom.connRow.style.display = '';
            dom.btnConnect.classList.add('primary');
            dom.btnConnect.classList.remove('secondary');
            dom.btnConnect.disabled = false;
            dom.btnConnect.textContent = 'Kết nối LIVE';
            if (dom.liveStatsGrid) dom.liveStatsGrid.hidden = true;
            // Hiện lại status-row khi disconnected
            if (statusRow) statusRow.style.display = '';
            ['lstatViewer','lstatDiamond','lstatFollow','lstatShare'].forEach(k => { if (dom[k]) dom[k].textContent = '0'; });
        }
    }
    function escAttrInline(s) { return String(s ?? '').replace(/[<>"]/g, ''); }

    async function doConnect() {
        const username = (dom.usernameInput.value || '').trim().replace(/^@/, '');
        if (!username) { dom.usernameInput.focus(); return; }
        dom.btnConnect.disabled = true;
        setStatus('connecting', `Đang kết nối @${username}...`);
        try {
            const res = await fetch('/api/connect', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            // === CREATOR lock — server reject username không khớp bound TikTok ID ===
            if (res.status === 403 && data._creatorLocked) {
                setStatus(null, 'Username không khớp với key');
                setConnectedUI(false);
                appendSystem(`⚠️ ${data.error}`);
                // Show explicit alert vì đây là lỗi quan trọng cần liên hệ HP Media
                alert(data.error);
                // Auto-fill username field với bound ID để user dễ thấy đúng tên cần dùng
                if (data.boundTiktokId) {
                    dom.usernameInput.value = data.boundTiktokId;
                }
                return;
            }
            if (!data.ok) throw new Error(data.error || 'Lỗi không xác định');
            setStatus('online', `@${data.username}`);
            dom.statRoom.textContent = data.roomId ? `Room ${data.roomId}` : '';
            setConnectedUI(true, data.username);
            appendSystem(`Đã kết nối @${data.username}`);
        } catch (e) {
            setStatus('error', 'Lỗi: ' + e.message);
            setConnectedUI(false);
            appendSystem('Lỗi kết nối: ' + e.message);
        }
    }
    async function doDisconnect() {
        const ok = await hpConfirm({
            icon: '⏻',
            title: 'Ngắt kết nối TikTok LIVE',
            body: `Bạn có chắc muốn ngắt kết nối khỏi <b>@${escHtml(liveUsername)}</b>?<br><span style="color:#8b93a8">OBS overlay sẽ ngừng nhận sự kiện cho đến khi kết nối lại.</span>`,
            okLabel: 'Ngắt kết nối',
            cancelLabel: 'Giữ kết nối',
            tone: 'danger'
        });
        if (!ok) return;
        dom.btnConnect.disabled = true;
        await fetch('/api/disconnect', { method: 'POST' });
        setStatus(null, 'Đã ngắt kết nối');
        dom.statRoom.textContent = '';
        dom.statViewer.textContent = '';
        setConnectedUI(false);
    }
    dom.btnConnect.addEventListener('click', () => {
        if (isLiveConnected) doDisconnect();
        else doConnect();
    });

    dom.btnReloadGifts.addEventListener('click', async () => {
        dom.btnReloadGifts.disabled = true;
        try {
            const res = await fetch('/api/reload-gifts', { method: 'POST' });
            const data = await res.json();
            appendSystem(data.ok ? `Đã tải ${data.count} quà` : `Lỗi: ${data.error}`);
        } finally {
            dom.btnReloadGifts.disabled = false;
        }
    });

    // Old license save handler đã chuyển sang gate flow (xem phần License Gate ở cuối file)

    dom.btnCopyOverlay.addEventListener('click', () => {
        dom.overlayUrl.select();
        navigator.clipboard.writeText(dom.overlayUrl.value).then(() => {
            const t = dom.btnCopyOverlay.textContent;
            dom.btnCopyOverlay.textContent = '✓ Đã copy';
            setTimeout(() => dom.btnCopyOverlay.textContent = t, 1500);
        });
    });
    // (Nút "↗ Mở" đã bỏ — user dùng Copy link + paste vào OBS browser source)
    dom.btnSaveAll?.addEventListener('click', async () => {
        if (!gameInstance || !currentGame) return;
        pushConfigUpdate(true);
        // Đợi xíu rồi báo hoàn tất
        setTimeout(() => flashTriggerToast('💾 Đã lưu toàn bộ cài đặt'), 80);
    });

    dom.btnClearComments.addEventListener('click', () => dom.commentsEl.innerHTML = '');
    dom.btnClearGifts.addEventListener('click', () => dom.giftStreamEl.innerHTML = '');

    dom.giftSearchInput.addEventListener('input', () => renderGiftCatalog(dom.giftSearchInput.value));
    dom.usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.btnConnect.click(); });

    // Config range inputs
    ['cfgGravity', 'cfgBounce', 'cfgFriction', 'cfgJarH', 'cfgGmin', 'cfgGmax', 'cfgGoal', 'cfgGoalGap', 'cfgShakeAt', 'cfgThiefMiss', 'cfgPoliceRate', 'cfgPoliceBan', 'cfgScaleLb', 'cfgScaleCaught', 'cfgScaleThief', 'cfgScalePolice', 'cfgScaleOsin', 'cfgScaleUfo']
        .forEach(k => dom[k]?.addEventListener('input', pushConfigUpdate));
    dom.cfgPoliceName?.addEventListener('input', pushConfigUpdate);
    dom.cfgShowCount?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarVisible?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarLocked?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarAccessory?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarTheme?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesEnabled?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesLayout?.addEventListener('change', () => {
        // Khi đổi layout (dọc/ngang) — clear panelPositions.badges để pos-* dropdown re-take effect
        // (nếu user đã drag badge tới vị trí khác, drag pos sẽ override pos-* class)
        if (currentGame) {
            const cfg = gameInstance?.getConfig() || {};
            if (cfg.panelPositions?.badges) {
                cfg.panelPositions.badges = null;
            }
        }
        pushConfigUpdate();
    });
    dom.cfgBadgesNamepos?.addEventListener('change', () => {
        // Khi đổi GLOBAL namePos → clear all per-card overrides (cả items + extras)
        // để TẤT CẢ badges đồng loạt theo global. Nếu user muốn per-card khác, edit lại.
        // Fix vấn đề: card cũ giữ namePos override → không follow global khi đổi.
        for (const id of Object.keys(currentBadgeItems)) {
            if (currentBadgeItems[id]) delete currentBadgeItems[id].namePos;
        }
        for (const ex of currentBadgeExtras) {
            if (ex) delete ex.namePos;
        }
        renderBadgeExtrasList();   // refresh extras list display
        pushConfigUpdate(true);
    });
    dom.cfgBadgesScale?.addEventListener('input', pushConfigUpdate);
    dom.cfgBadgesIconScale?.addEventListener('input', pushConfigUpdate);

    // ===== Extra badges — thêm quà thủ công vào danh sách badge (KHÔNG cần gán effect) =====
    // Lưu vào config.badges.extras = [{id, name, image, customLabel, namePos, enabled}]
    let currentBadgeExtras = [];   // array của extras objects

    const ebmModal = document.getElementById('extra-badge-modal');
    const EBM_DIAMOND_VALUES = [10, 20, 199, 299, 399, 499, 599, 799, 1000, 2000, 3000, 5000, 10000, 20000];
    let ebmMinDiamond = 0;   // ngưỡng MIN — chip 299⭐ = lọc quà có diamond >= 299
    function fmtDiamond(v) {
        // 10000 → 10,000 cho dễ đọc
        return Number(v || 0).toLocaleString('en-US');
    }
    function openExtraBadgeModal() {
        if (!ebmModal) return;
        document.getElementById('ebm-id').value = '';
        document.getElementById('ebm-name').value = '';
        document.getElementById('ebm-image').value = '';
        document.getElementById('ebm-label').value = '';
        document.getElementById('ebm-namepos').value = '';   // 'Theo mặc định'
        document.getElementById('ebm-search').value = '';
        ebmMinDiamond = 0;
        renderDiamondChips();
        renderEbmPicker();
        ebmModal.hidden = false;
    }
    function closeExtraBadgeModal() { if (ebmModal) ebmModal.hidden = true; }
    function renderDiamondChips() {
        const wrap = document.getElementById('ebm-diamond-chips');
        if (!wrap) return;
        wrap.innerHTML = '';
        // 'Tất cả' = ngưỡng 0 (hiện hết)
        const allBtn = document.createElement('div');
        allBtn.className = 'ebm-chip chip-all' + (ebmMinDiamond === 0 ? ' active' : '');
        allBtn.textContent = 'Tất cả';
        allBtn.addEventListener('click', () => {
            ebmMinDiamond = 0;
            renderDiamondChips();
            renderEbmPicker();
        });
        wrap.appendChild(allBtn);
        for (const v of EBM_DIAMOND_VALUES) {
            const chip = document.createElement('div');
            chip.className = 'ebm-chip' + (ebmMinDiamond === v ? ' active' : '');
            chip.textContent = `${fmtDiamond(v)}⭐`;   // 10000 → 10,000
            chip.title = `Quà có ít nhất ${fmtDiamond(v)} sao`;
            chip.addEventListener('click', () => {
                ebmMinDiamond = (ebmMinDiamond === v) ? 0 : v;   // toggle
                renderDiamondChips();
                renderEbmPicker();
            });
            wrap.appendChild(chip);
        }
    }

    function renderEbmPicker() {
        const picker = document.getElementById('ebm-picker');
        const countEl = document.getElementById('ebm-result-count');
        if (!picker) return;
        picker.innerHTML = '';
        const f = (document.getElementById('ebm-search')?.value || '').trim().toLowerCase();
        const excludeAssigned = !!document.getElementById('ebm-exclude-assigned')?.checked;
        // Set các gift IDs đã được gán effect (triggers) hoặc đã có trong extras
        const assignedIds = new Set();
        if (excludeAssigned) {
            for (const id of Object.keys(currentTriggers || {})) assignedIds.add(String(id));
            for (const ex of (currentBadgeExtras || [])) if (ex.id) assignedIds.add(String(ex.id));
        }
        const list = (giftSheet || []).filter(g => {
            if (excludeAssigned && assignedIds.has(String(g.id))) return false;
            if (f && !(g.id.toLowerCase().includes(f) || (g.name || '').toLowerCase().includes(f))) return false;
            // Chip Sao: lọc quà có diamond >= ngưỡng min (tự động tăng dần)
            if (ebmMinDiamond > 0 && Number(g.diamond || 0) < ebmMinDiamond) return false;
            return true;
        });
        if (countEl) countEl.textContent = `${list.length} quà / ${(giftSheet || []).length} tổng`;
        const frag = document.createDocumentFragment();
        for (const g of list) {
            const card = document.createElement('div');
            card.className = 'pg';
            card.innerHTML = `
                <img src="${g.image || ''}" onerror="this.style.display='none'"/>
                <div class="nm">${(g.name || '').replace(/[<>]/g,'')}</div>
                <div class="di">ID ${g.id}</div>
                <div class="st">${fmtDiamond(g.diamond || 0)}⭐</div>
            `;
            card.addEventListener('click', () => {
                document.getElementById('ebm-id').value = g.id;
                document.getElementById('ebm-name').value = g.name || '';
                document.getElementById('ebm-image').value = g.image || '';
                // highlight selected
                picker.querySelectorAll('.pg.pg-active').forEach(el => el.classList.remove('pg-active'));
                card.classList.add('pg-active');
            });
            frag.appendChild(card);
        }
        picker.appendChild(frag);
    }

    document.getElementById('btn-add-extra-badge')?.addEventListener('click', openExtraBadgeModal);
    document.getElementById('ebm-close')?.addEventListener('click', closeExtraBadgeModal);
    document.getElementById('ebm-cancel')?.addEventListener('click', closeExtraBadgeModal);
    document.getElementById('ebm-search')?.addEventListener('input', () => renderEbmPicker());
    document.getElementById('ebm-exclude-assigned')?.addEventListener('change', () => renderEbmPicker());
    document.getElementById('ebm-save')?.addEventListener('click', () => {
        const id = (document.getElementById('ebm-id').value || '').trim();
        const name = (document.getElementById('ebm-name').value || '').trim();
        const image = (document.getElementById('ebm-image').value || '').trim();
        const customLabel = (document.getElementById('ebm-label').value || '').trim();
        const namePosValue = document.getElementById('ebm-namepos').value || '';
        if (!id || !name) return flashTriggerToast('⚠ Cần Gift ID và Tên quà (chọn từ danh sách hoặc nhập tay)');
        // Avoid duplicate by id
        const existsIdx = currentBadgeExtras.findIndex(e => String(e.id) === id);
        const entry = { id, name, image, customLabel, enabled: true };
        // Chỉ lưu namePos nếu user explicit chọn (không là 'Theo mặc định')
        if (namePosValue) entry.namePos = namePosValue;
        if (existsIdx >= 0) currentBadgeExtras[existsIdx] = entry;
        else currentBadgeExtras.push(entry);
        renderBadgeExtrasList();
        pushConfigUpdate(true);
        flashTriggerToast(`✓ Đã thêm badge "${name}" vào danh sách`);
        closeExtraBadgeModal();
    });

    function renderBadgeExtrasList() {
        const list = document.getElementById('badges-extras-list');
        if (!list) return;
        list.innerHTML = '';
        if (!currentBadgeExtras.length) {
            list.innerHTML = '<div class="hint" style="font-size:11px;color:#6b7390;padding:4px 0">Chưa có badge thủ công nào</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        for (const [idx, e] of currentBadgeExtras.entries()) {
            const row = document.createElement('div');
            row.className = 'badges-extra-row';
            row.innerHTML = `
                <img src="${e.image || ''}" onerror="this.style.display='none'"/>
                <div class="be-info">
                    <div class="be-name">${(e.customLabel || e.name).replace(/[<>]/g,'')}</div>
                    <div class="be-id">ID ${e.id} · ${e.namePos}</div>
                </div>
                <label class="be-toggle"><input type="checkbox" ${e.enabled !== false ? 'checked' : ''} data-idx="${idx}"/></label>
                <button class="be-remove ghost mini" data-idx="${idx}" title="Xoá">✕</button>
            `;
            frag.appendChild(row);
        }
        list.appendChild(frag);
        list.querySelectorAll('.be-toggle input').forEach(cb => {
            cb.addEventListener('change', () => {
                const i = parseInt(cb.dataset.idx, 10);
                if (currentBadgeExtras[i]) {
                    currentBadgeExtras[i].enabled = cb.checked;
                    pushConfigUpdate(true);
                }
            });
        });
        list.querySelectorAll('.be-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = parseInt(btn.dataset.idx, 10);
                currentBadgeExtras.splice(i, 1);
                renderBadgeExtrasList();
                pushConfigUpdate(true);
            });
        });
    }
    // Feature toggles
    for (const key of FEATURE_KEYS) {
        const el = document.getElementById(FEATURE_INPUT[key]);
        el?.addEventListener('change', pushConfigUpdate);
    }
    // Action buttons — gọi local + đồng bộ overlay OBS
    function sendCmd(cmd, payload) {
        if (!currentGame) return;
        fetch(`/api/games/${currentGame.id}/cmd`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd, payload: payload || null })
        }).catch(() => {});
    }
    function resetSessionAll() {
        // Phiên mới: reset stats + clear bodies trong hũ + đồng bộ OBS qua 2 cmd
        gameInstance?.resetSession();
        gameInstance?.clearAll();
        sendCmd('resetSession');
        sendCmd('clear');
        forceSyncState();
    }
    dom.btnResetSessionTop?.addEventListener('click', resetSessionAll);
    dom.btnThief?.addEventListener('click', () => {
        if (!gameInstance) return;
        // 1 lần nhấn = 1 tên trộm. Chọn ngẫu nhiên 1 tipper gần đây để đặt tên.
        const stats = gameInstance.getStats();
        const pool = (stats?.tippers || []);
        const recent = pool.filter(t => Date.now() - (t.lastTs || 0) < 5 * 60 * 1000);
        const list = recent.length ? recent : pool;
        const pick = list.length ? list[Math.floor(Math.random() * list.length)] : null;
        const thief = pick
            ? { name: pick.nickname || pick.uniqueId || 'Khách', avatar: pick.avatar, uid: pick.uid }
            : { name: 'Khách' };
        // triggerThief mutate thief.mode (rope/runner) — sendCmd sau đó sẽ gồm mode cho OBS
        gameInstance.triggerThief(thief);
        sendCmd('thief', { thieves: [thief] });
    });
    dom.btnFxFirework?.addEventListener('click', () => { gameInstance?.fxFireworks(); sendCmd('fireworks'); });
    dom.btnFxTornado?.addEventListener('click', () => { gameInstance?.fxTornado(); sendCmd('tornado'); });
    dom.btnFxShape?.addEventListener('click', () => {
        if (!gameInstance) return;
        // Bấm test = chọn 1 tipper gần đây để hiện tên ở giữa hình
        const stats = gameInstance.getStats();
        const pool = (stats?.tippers || []);
        const recent = pool.filter(t => Date.now() - (t.lastTs || 0) < 5 * 60 * 1000);
        const list = recent.length ? recent : pool;
        const pick = list.length ? list[Math.floor(Math.random() * list.length)] : null;
        const userInfo = pick
            ? { name: pick.nickname || pick.uniqueId || 'Khách', avatar: pick.avatar, uid: pick.uid }
            : { name: 'Khách' };
        gameInstance.fxShape(userInfo);
        sendCmd('shape', userInfo);
    });
    dom.btnOsin?.addEventListener('click', () => {
        if (!gameInstance) return;
        // Bấm test = chọn 1 tipper gần đây làm OSIN
        const stats = gameInstance.getStats();
        const pool = (stats?.tippers || []);
        const recent = pool.filter(t => Date.now() - (t.lastTs || 0) < 5 * 60 * 1000);
        const list = recent.length ? recent : pool;
        const pick = list.length ? list[Math.floor(Math.random() * list.length)] : null;
        const osin = pick
            ? { name: pick.nickname || pick.uniqueId || 'Khách', avatar: pick.avatar, uid: pick.uid }
            : { name: 'Khách' };
        gameInstance.triggerOsin(osin);
        sendCmd('osin', osin);
    });

    // ===== Socket =====
    socket.on('connect', () => appendSystem('Server đã kết nối.'));
    socket.on('disconnect', () => appendSystem('Mất kết nối server.'));

    socket.on('giftSheet', (data) => {
        giftSheet = (data || []).slice().sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
        giftMap = {};
        for (const g of giftSheet) giftMap[String(g.id)] = g;
        renderGiftCatalog(dom.giftSearchInput.value);
        populateGiftDatalist();
        renderTriggerList();
        dom.giftCountHint.textContent = `${giftSheet.length} quà sẵn sàng`;
        // Share with caro-panel (and any other future game panels)
        window.__giftSheet = giftSheet;
        // Sau khi sheet mới load, server cũng đã dọn các entry đã có trong sheet.
        // Refresh local danh sách unknown.
        fetchUnknownGifts();
    });

    // ===== Unknown gifts (quà mới phát hiện) =====
    let unknownList = [];
    const unknownFab = document.getElementById('unknown-fab');
    const unknownBadge = document.getElementById('unknown-badge');
    const unknownPopup = document.getElementById('unknown-popup');
    const unknownListEl = document.getElementById('unknown-list');
    const unknownCountInline = document.getElementById('unknown-count-inline');
    function updateUnknownBadge(n) {
        if (!unknownFab) return;
        // FAB luôn hiện để user truy cập được — chỉ toggle badge số đếm.
        // Khi có quà mới: badge đỏ + pulse animation thu hút sự chú ý.
        // Khi rỗng: badge ẩn, FAB vẫn ở góc dưới (mờ hơn qua CSS).
        if (n > 0) {
            unknownBadge.hidden = false;
            unknownBadge.textContent = n > 99 ? '99+' : String(n);
            unknownFab.classList.add('has-new');
        } else {
            unknownBadge.hidden = true;
            unknownFab.classList.remove('has-new');
        }
        if (unknownCountInline) unknownCountInline.textContent = `(${n})`;
    }
    async function fetchUnknownGifts() {
        try {
            const r = await fetch('/api/unknown-gifts');
            const j = await r.json();
            unknownList = j.list || [];
            updateUnknownBadge(unknownList.length);
            if (unknownPopup && !unknownPopup.hidden) renderUnknownList();
        } catch (e) { /* ignore */ }
    }
    function fmtAgo(ts) {
        if (!ts) return '';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        return Math.floor(s / 86400) + 'd';
    }
    // Build TSV (tab-separated) row khớp cột Google Sheet: A=ID | B=Name | C=Image link | D=Diamond
    // (Schema mới — bỏ cột Webm. Cột E trở đi là formula sort/dropdown, không paste vào.)
    function buildSheetRow(entry) {
        return [entry.id, entry.name || '', entry.image || '', entry.diamond || 0].join('\t');
    }
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // Fallback dùng textarea + execCommand
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); document.body.removeChild(ta); return true; }
            catch (_) { document.body.removeChild(ta); return false; }
        }
    }
    function renderUnknownList() {
        if (!unknownListEl) return;
        unknownListEl.innerHTML = '';
        if (!unknownList.length) {
            unknownListEl.innerHTML = '<div class="unknown-empty">✓ Chưa phát hiện quà mới nào ngoài Google Sheet.</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        for (const e of unknownList) {
            const row = document.createElement('div');
            row.className = 'unknown-row';
            // Source: 'scan' = phát hiện qua nút Quét (chưa có event); else = từ live gift event
            const isScan = e.source === 'scan' || (e.count || 0) === 0;
            const sourceLabel = isScan
                ? `<span class="ug-src ug-src-scan" title="Từ rà soát TikTok catalog (chưa nhận event live)">🔎 scan</span>`
                : `<span class="ug-src ug-src-live" title="Từ gift event trực tiếp">📡 live ×${e.count}</span>`;
            row.innerHTML = `
                <div class="ug-img">${e.image ? `<img src="${escAttrInline(e.image)}" loading="lazy" onerror="this.style.display='none'"/>` : '<span class="ph">?</span>'}</div>
                <div class="ug-main">
                    <div class="ug-name" title="${escAttrInline(e.name || '')}">${escHtml(e.name || '(chưa có tên)')}</div>
                    <div class="ug-meta">
                        <span class="ug-id">ID <b>${escHtml(e.id)}</b></span>
                        <span class="ug-dia">${e.diamond || 0}⭐</span>
                        ${sourceLabel}
                        <span class="ug-time" title="${new Date(e.lastSeen || 0).toLocaleString('vi-VN')}">${fmtAgo(e.lastSeen)}</span>
                    </div>
                </div>
                <div class="ug-actions">
                    <button class="ghost mini" data-action="copy" data-id="${escAttrInline(e.id)}" title="Copy dòng tab-separated cho Google Sheet">📋 Copy</button>
                    <button class="ghost mini" data-action="download" data-id="${escAttrInline(e.id)}" title="Tải icon về máy" ${e.image ? '' : 'disabled'}>💾 Icon</button>
                    <button class="ghost mini" data-action="done" data-id="${escAttrInline(e.id)}" style="color:#22c55e" title="Đã thêm vào Sheet — xoá khỏi danh sách">✓</button>
                </div>
            `;
            frag.appendChild(row);
        }
        unknownListEl.appendChild(frag);
    }
    // Delegate clicks trên danh sách
    unknownListEl?.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        const entry = unknownList.find(x => String(x.id) === String(id));
        if (!entry) return;
        if (action === 'copy') {
            const row = buildSheetRow(entry);
            const ok = await copyText(row);
            flashTriggerToast(ok ? `📋 Đã copy dòng "${entry.name || entry.id}" — paste vào Sheet` : 'Lỗi copy');
        }
        else if (action === 'download') {
            // Mở endpoint server proxy → trigger download
            window.open(`/api/unknown-gifts/${encodeURIComponent(id)}/image`, '_blank');
        }
        else if (action === 'done') {
            await fetch(`/api/unknown-gifts/${encodeURIComponent(id)}`, { method: 'DELETE' });
            // unknownGiftCleared event sẽ tự refresh; but optimistic update:
            unknownList = unknownList.filter(x => String(x.id) !== String(id));
            updateUnknownBadge(unknownList.length);
            renderUnknownList();
            flashTriggerToast(`✓ Đã xoá "${entry.name || entry.id}" khỏi danh sách`);
        }
    });
    function openUnknownPopup() {
        if (!unknownPopup) return;
        closeAllPopupsExcept('unknown');
        unknownPopup.hidden = false;
        renderUnknownList();
    }
    function closeUnknownPopup() { if (unknownPopup) unknownPopup.hidden = true; }
    unknownFab?.addEventListener('click', () => {
        if (unknownPopup.hidden) openUnknownPopup(); else closeUnknownPopup();
    });
    document.getElementById('unknown-close')?.addEventListener('click', closeUnknownPopup);
    document.getElementById('btn-unknown-clear')?.addEventListener('click', async () => {
        if (!window.confirm(`Xoá toàn bộ ${unknownList.length} quà khỏi danh sách phát hiện?`)) return;
        await fetch('/api/unknown-gifts/clear', { method: 'POST' });
        unknownList = []; updateUnknownBadge(0); renderUnknownList();
    });
    document.getElementById('btn-unknown-reload')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-unknown-reload');
        if (btn) { btn.disabled = true; btn.textContent = '↻ Đang tải...'; }
        try {
            const r = await fetch('/api/reload-gifts', { method: 'POST' });
            const j = await r.json();
            await fetchUnknownGifts();
            flashTriggerToast(`✓ Đã tải ${j.count} quà · Dọn ${j.cleanedUnknown || 0} quà unknown đã có trong Sheet`);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '↻ Đồng bộ'; }
        }
    });
    document.getElementById('btn-unknown-scan')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-unknown-scan');
        if (btn) { btn.disabled = true; btn.textContent = '🔎 Đang quét...'; }
        try {
            const r = await fetch('/api/scan-tiktok-gifts', { method: 'POST' });
            const j = await r.json();
            if (!j.ok) {
                flashTriggerToast(`⚠️ ${j.error || 'Lỗi quét'}`);
            } else {
                await fetchUnknownGifts();
                // Báo cáo chi tiết: tổng quà TikTok, đã có / mới thêm / cập nhật / skip
                const lines = [
                    `🔎 Quét xong ${j.scanned} quà TikTok:`,
                    `  ✓ ${j.existing} đã có trong Sheet`,
                    `  + ${j.added} mới thêm vào danh sách`,
                    j.updated > 0 ? `  🔄 ${j.updated} cập nhật icon/tên` : null,
                    j.skipped > 0 ? `  · ${j.skipped} thiếu thông tin (bỏ qua)` : null,
                    '',
                    `Tổng danh sách: ${j.totalUnknown} quà cần thêm vào Sheet`
                ].filter(Boolean).join('\n');
                // Toast ngắn + alert chi tiết nếu added > 0
                if (j.added > 0) {
                    flashTriggerToast(`🔎 Đã quét: thêm ${j.added} quà mới vào danh sách`);
                    setTimeout(() => alert(lines), 50);
                } else {
                    flashTriggerToast(`🔎 Quét xong: ${j.existing}/${j.scanned} đã có trong Sheet · không có gì mới`);
                }
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔎 Quét'; }
        }
    });
    document.getElementById('btn-unknown-refresh-tt')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-unknown-refresh-tt');
        if (btn) { btn.disabled = true; btn.textContent = '🔄 Đang dò...'; }
        try {
            const r = await fetch('/api/unknown-gifts/refresh-from-tiktok', { method: 'POST' });
            const j = await r.json();
            if (!j.ok) {
                flashTriggerToast(`⚠️ ${j.error || 'Lỗi dò TikTok'}`);
            } else {
                await fetchUnknownGifts();
                flashTriggerToast(j.updated > 0
                    ? `🔄 Đã điền ${j.updated} icon/tên từ TikTok`
                    : '🔄 Không có entry nào cần update — đã đủ thông tin'
                );
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 Dò icon'; }
        }
    });
    document.getElementById('btn-unknown-copy-all')?.addEventListener('click', async () => {
        if (!unknownList.length) return;
        const lines = unknownList.map(buildSheetRow).join('\n');
        const ok = await copyText(lines);
        flashTriggerToast(ok ? `📋 Đã copy ${unknownList.length} dòng — paste 1 lần vào Sheet` : 'Lỗi copy');
    });
    // Socket events realtime
    socket.on('unknownGift', ({ entry, total }) => {
        // Insert hoặc update entry
        const idx = unknownList.findIndex(x => String(x.id) === String(entry.id));
        if (idx >= 0) unknownList[idx] = entry;
        else unknownList.unshift(entry);   // mới phát hiện → lên đầu
        updateUnknownBadge(total);
        if (unknownPopup && !unknownPopup.hidden) renderUnknownList();
    });
    socket.on('unknownGiftCleared', () => fetchUnknownGifts());
    // Khởi tạo ngay khi load app
    fetchUnknownGifts();

    socket.on('status', (s) => {
        if (s?.connected) {
            setStatus('online', `@${s.username || ''}`);
            dom.statRoom.textContent = s.roomId ? `Room ${s.roomId}` : '';
            setConnectedUI(true, s.username || liveUsername);
        } else {
            setStatus(null, s?.reason === 'streamEnd' ? 'LIVE đã kết thúc' : 'Chưa kết nối');
            setConnectedUI(false);
        }
    });

    socket.on('gameConfig', ({ gameId, config }) => {
        if (!gameInstance || gameId !== currentGame?.id) return;
        // Bỏ qua echo của save vừa thực hiện (1.5s) — tránh overwrite local state đang edit
        if (Date.now() - lastOwnSaveTs < 1500) return;
        gameInstance.setConfig(config);
        applyConfigToUI(config);
        renderGiftCatalog(dom.giftSearchInput.value);
    });
    socket.on('error', (e) => appendSystem('Lỗi: ' + (e?.message || '')));
    socket.on('chat', appendComment);
    socket.on('gift', (g) => {
        appendGiftEvent(g);
        // Cũng spawn vào preview thực (overlay nhận qua room 'overlay')
        if (currentGame) spawnInGame(g);
    });
    socket.on('gameGift', (g) => {
        // tin từ server đẩy cho preview/overlay — preview cũng đã xử lý qua 'gift' event
    });
    socket.on('member', (m) => appendSystem(`👋 ${m.nickname || m.uniqueId} đã vào LIVE`));
    socket.on('social', (s) => appendSystem(`💗 ${s.nickname || s.uniqueId} ${s.label || ''}`));
    socket.on('roomUser', (r) => {
        if (typeof r.viewerCount === 'number' && dom.lstatViewer) dom.lstatViewer.textContent = fmtNum(r.viewerCount);
    });
    // Live stats — viewer, diamond, follow, share
    function fmtNum(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }
    socket.on('liveStats', (s) => {
        if (!s) return;
        if (dom.lstatViewer) dom.lstatViewer.textContent = fmtNum(s.viewerCount);
        if (dom.lstatDiamond) dom.lstatDiamond.textContent = fmtNum(s.totalDiamond);
        if (dom.lstatFollow) dom.lstatFollow.textContent = fmtNum(s.totalFollows);
        if (dom.lstatShare) dom.lstatShare.textContent = fmtNum(s.totalShares);
    });

    // ===== Bình luận popup toggle + badge =====
    const commentsFab = document.getElementById('comments-fab');
    const commentsBadge = document.getElementById('comments-badge');
    const commentsPopup = document.getElementById('comments-popup');
    const commentsClose = document.getElementById('comments-close');
    let unreadComments = 0;
    function isPopupOpen() { return commentsPopup && !commentsPopup.hidden; }
    function setUnread(n) {
        unreadComments = Math.max(0, n);
        if (!commentsBadge) return;
        if (unreadComments <= 0) {
            commentsBadge.hidden = true;
            commentsBadge.textContent = '0';
        } else {
            commentsBadge.hidden = false;
            commentsBadge.textContent = unreadComments > 99 ? '99+' : String(unreadComments);
        }
    }
    // Helper: đóng tất cả popup FAB khác (mutual exclusive — chỉ 1 popup mở 1 lúc)
    function closeAllPopupsExcept(name) {
        const map = {
            comments: 'comments-popup',
            unknown: 'unknown-popup',
            police: 'police-popup',
            caught: 'caught-popup',
        };
        for (const k of Object.keys(map)) {
            if (k === name) continue;
            const el = document.getElementById(map[k]);
            if (el && !el.hidden) el.hidden = true;
        }
    }
    function openCommentsPopup() {
        closeAllPopupsExcept('comments');
        if (commentsPopup) commentsPopup.hidden = false;
        setUnread(0);
        const list = document.getElementById('comments');
        if (list) list.scrollTop = list.scrollHeight;
    }
    function closeCommentsPopup() { if (commentsPopup) commentsPopup.hidden = true; }
    // Đảm bảo popup ẩn lúc khởi động
    if (commentsPopup) commentsPopup.hidden = true;
    commentsFab?.addEventListener('click', () => {
        if (isPopupOpen()) closeCommentsPopup();
        else openCommentsPopup();
    });
    commentsClose?.addEventListener('click', closeCommentsPopup);
    setUnread(0);

    // ===== Tab switching trong tabbed-card =====
    document.querySelectorAll('.tabbed-card .tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            const card = btn.closest('.tabbed-card');
            card.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
            card.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target));
        });
    });

    // ===== Update checker — CHỈ check 1 lần lúc mở app + khi user bấm thủ công =====
    // KHÔNG có setInterval định kỳ trong khi app đang chạy
    function cmpVersion(a, b) {
        const aP = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const bP = String(b).split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(aP.length, bP.length); i++) {
            const da = aP[i] || 0, db = bP[i] || 0;
            if (da > db) return 1;
            if (da < db) return -1;
        }
        return 0;
    }
    let dismissedUpdateVer = '';
    let currentLocalVersion = '0.0.0';
    let pendingUpdateInfo = null;

    async function fetchVersionInfo() {
        try {
            const local = await (await fetch('/api/version')).json();
            currentLocalVersion = local?.version || '0.0.0';
            const cur = document.getElementById('vb-current');
            const foot = document.getElementById('footer-version');
            if (cur) cur.textContent = 'v' + currentLocalVersion;
            if (foot) foot.textContent = 'v' + currentLocalVersion;
            return local;
        } catch { return null; }
    }

    // === Auto-update — gọi license-server qua app's /api/update/check ===
    // KHÔNG còn link GitHub. App's internal server proxy tới license-server.
    async function checkForUpdate(opts = {}) {
        const manual = !!opts.manual;
        try {
            await fetchVersionInfo();
            const r = await (await fetch('/api/update/check')).json();
            if (!r.ok) {
                if (manual) toastInfo(r.error || 'Không kiểm tra được phiên bản');
                return;
            }
            if (!r.hasUpdate) {
                pendingUpdateInfo = null;
                renderVersionRow(null);
                if (manual) toastInfo('Bạn đang dùng bản mới nhất ✓');
                return;
            }
            pendingUpdateInfo = {
                version: r.latestVersion,
                notes: r.notes || '',
                size: r.size || 0,
                sha256: r.sha256 || ''
            };
            renderVersionRow(pendingUpdateInfo);
            if (manual || pendingUpdateInfo.version !== dismissedUpdateVer) {
                showUpdateModal(pendingUpdateInfo);
            }
        } catch (e) {
            if (manual) toastInfo('Không kết nối được máy chủ cập nhật');
        }
    }

    function renderVersionRow(info) {
        const row = document.getElementById('vb-row-latest');
        const latestEl = document.getElementById('vb-latest');
        const btnShow = document.getElementById('btn-show-update');
        if (info) {
            if (row) row.hidden = false;
            if (latestEl) latestEl.textContent = 'v' + info.version;
            if (btnShow) btnShow.hidden = false;
        } else {
            if (row) row.hidden = true;
            if (btnShow) btnShow.hidden = true;
        }
    }

    function showUpdateModal(info) {
        const modal = document.getElementById('update-modal');
        if (!modal) return;
        document.getElementById('um-current').textContent = 'v' + currentLocalVersion;
        document.getElementById('um-new').textContent = 'v' + info.version;
        document.getElementById('um-notes').textContent = (info.notes || '').trim();
        // Ẩn nút "Xem trang chi tiết" — không show GitHub URL nữa
        const btnDetails = document.getElementById('um-btn-details');
        if (btnDetails) btnDetails.style.display = 'none';
        modal.classList.add('show');

        const btnConfirm = document.getElementById('um-btn-confirm');
        const btnSkip = document.getElementById('um-btn-skip');
        const close = () => modal.classList.remove('show');

        btnConfirm.onclick = async () => {
            close();
            startAutoUpdate(info);
        };
        btnSkip.onclick = () => {
            dismissedUpdateVer = info.version;
            close();
        };
    }

    // === Auto-update download flow ===
    // 1. Tạo overlay full-screen có progress bar
    // 2. POST /api/update/download → server tải + emit socket events
    // 3. Update overlay theo events (downloading → verifying → installing)
    // 4. Server tự spawn installer + quit electron app
    async function startAutoUpdate(info) {
        showUpdateOverlay();
        socket.on('updateProgress', onUpdateProgress);
        try {
            const r = await (await fetch('/api/update/download', { method: 'POST' })).json();
            if (!r.ok) {
                onUpdateProgress({ phase: 'error', percent: 0, message: 'Lỗi: ' + (r.error || 'Không khởi tạo được tải về') });
            }
        } catch (e) {
            onUpdateProgress({ phase: 'error', percent: 0, message: 'Lỗi: ' + e.message });
        }
    }

    function onUpdateProgress(data) {
        const ov = document.getElementById('update-overlay');
        if (!ov) return;
        const bar = ov.querySelector('.uo-bar-fill');
        const pct = ov.querySelector('.uo-percent');
        const msg = ov.querySelector('.uo-message');
        const phase = ov.querySelector('.uo-phase');
        const phaseLabel = {
            connecting: '🔌 Đang kết nối',
            downloading: '⬇️ Đang tải về',
            verifying: '🔐 Đang xác minh',
            installing: '⚙️ Đang cài đặt',
            error: '⚠️ Lỗi'
        }[data.phase] || '⏳ Đang xử lý';
        if (phase) phase.textContent = phaseLabel;
        if (bar) bar.style.width = (data.percent || 0) + '%';
        if (pct) pct.textContent = (data.percent || 0) + '%';
        if (msg) msg.textContent = data.message || '';
        if (data.phase === 'error') {
            ov.classList.add('error');
            // Cho user nút đóng overlay nếu lỗi
            const closeBtn = ov.querySelector('.uo-close');
            if (closeBtn) closeBtn.style.display = 'block';
        }
    }

    function showUpdateOverlay() {
        let ov = document.getElementById('update-overlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'update-overlay';
            ov.className = 'update-overlay';
            ov.innerHTML = `
                <div class="uo-card">
                    <div class="uo-logo">
                        <img src="/hp-logo.png" alt="HP" onerror="this.style.display='none'"/>
                    </div>
                    <div class="uo-title">Đang cập nhật HP Action LIVE</div>
                    <div class="uo-phase">⏳ Đang xử lý</div>
                    <div class="uo-bar"><div class="uo-bar-fill"></div></div>
                    <div class="uo-percent">0%</div>
                    <div class="uo-message">Vui lòng đợi...</div>
                    <div class="uo-warning">⚠️ KHÔNG đóng cửa sổ này khi đang cập nhật</div>
                    <button class="uo-close" style="display:none" onclick="document.getElementById('update-overlay').remove()">Đóng</button>
                </div>`;
            document.body.appendChild(ov);
        }
        ov.classList.add('show');
    }

    function toastInfo(msg) {
        let t = document.getElementById('version-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'version-toast';
            t.style.cssText = 'position:fixed;left:50%;top:22px;transform:translateX(-50%);background:#1a1f2c;color:#e6e8ee;border:1px solid #2c3243;padding:9px 16px;border-radius:10px;font-size:13px;z-index:10004;box-shadow:0 12px 32px rgba(0,0,0,0.5);opacity:0;transition:opacity .2s ease;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._h);
        t._h = setTimeout(() => t.style.opacity = '0', 2500);
    }

    // ===== Settings popup =====
    const settingsPopup = document.getElementById('settings-popup');
    const openSettingsPopup = () => { if (settingsPopup) settingsPopup.hidden = false; };
    document.getElementById('btn-open-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('caro-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('settings-close')?.addEventListener('click', () => {
        if (settingsPopup) settingsPopup.hidden = true;
    });

    // ===== Xóa KEY đang dùng (logout) =====
    // Gọi /api/license/deactivate → reset config.license → reload → license gate hiện lại
    document.getElementById('btn-lic-logout')?.addEventListener('click', async () => {
        const ok = window.confirm(
            '⚠️ Xác nhận xóa KEY đang dùng?\n\n' +
            'App sẽ thoát chế độ đã kích hoạt, yêu cầu nhập KEY mới lần sau mở.\n' +
            'Cài đặt khác (vị trí hũ, triggers quà, v.v.) sẽ được giữ lại.'
        );
        if (!ok) return;
        try {
            await fetch('/api/license/deactivate', { method: 'POST' });
            // Reload trang để license gate hiện ra
            location.reload();
        } catch (e) {
            alert('Lỗi xóa KEY: ' + e.message);
        }
    });
    // Universal ESC — đóng bất kỳ popup/modal nào đang mở
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // Ưu tiên đóng từ trong ra (modal cao nhất trước)
        const updateModalEl = document.getElementById('update-modal');
        if (updateModalEl && updateModalEl.classList.contains('show')) {
            updateModalEl.classList.remove('show');
            return;
        }
        const effectModalEl = document.getElementById('effect-modal');
        if (effectModalEl && !effectModalEl.hidden) {
            effectModalEl.hidden = true;
            return;
        }
        if (settingsPopup && !settingsPopup.hidden) { settingsPopup.hidden = true; return; }
        const caughtPopupEl = document.getElementById('caught-popup');
        if (caughtPopupEl && !caughtPopupEl.hidden) { caughtPopupEl.hidden = true; return; }
        const policePopupEl = document.getElementById('police-popup');
        if (policePopupEl && !policePopupEl.hidden) { policePopupEl.hidden = true; return; }
        const commentsPopupEl = document.getElementById('comments-popup');
        if (commentsPopupEl && !commentsPopupEl.hidden) { commentsPopupEl.hidden = true; return; }
        const ctxMenuEl = document.getElementById('gift-context-menu');
        if (ctxMenuEl && !ctxMenuEl.hidden) { ctxMenuEl.hidden = true; return; }
    });

    // Wire nút Kiểm tra + Cập nhật trong Settings popup
    document.getElementById('btn-check-update')?.addEventListener('click', () => checkForUpdate({ manual: true }));
    document.getElementById('btn-show-update')?.addEventListener('click', () => {
        if (pendingUpdateInfo) showUpdateModal(pendingUpdateInfo);
    });

    fetchVersionInfo();  // điền version hiện tại ngay khi load

    // ===== Police Force popup (FAB) =====
    const policeFab = document.getElementById('police-fab');
    const policePopup = document.getElementById('police-popup');
    const policeBadge = document.getElementById('police-badge');
    const policeListEl = document.getElementById('police-list');
    policeFab?.addEventListener('click', () => {
        if (!policePopup) return;
        const willOpen = policePopup.hidden;
        if (willOpen) closeAllPopupsExcept('police');
        policePopup.hidden = !willOpen;
        if (willOpen) syncPoliceFromGame();   // force re-render khi mở
    });
    document.getElementById('police-close')?.addEventListener('click', () => {
        if (policePopup) policePopup.hidden = true;
    });

    function renderPoliceList(members) {
        if (!policeListEl) return;
        if (!members.length) {
            policeListEl.innerHTML = '<div class="police-empty">Chưa có ai gia nhập lực lượng cảnh sát.</div>';
            if (policeBadge) policeBadge.hidden = true;
            return;
        }
        if (policeBadge) {
            policeBadge.hidden = false;
            policeBadge.textContent = String(members.length);
        }
        policeListEl.innerHTML = members.map(p => {
            const since = p.joinedAt ? new Date(p.joinedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
            const av = p.avatar
                ? `<img class="pp-avatar" src="${escAttrInline(p.avatar)}" alt="">`
                : `<div class="pp-avatar ph">👮</div>`;
            return `<div class="pp-row">
                ${av}
                <div class="pp-name" title="${escAttrInline(p.name || 'CS')}">${escHtml(p.name || 'CS')}</div>
                <div class="pp-since">${escHtml(since)}</div>
            </div>`;
        }).join('');
    }
    function syncPoliceFromGame() {
        if (!gameInstance || typeof gameInstance.getPoliceForce !== 'function') return;
        renderPoliceList(gameInstance.getPoliceForce());
    }
    // Sync nhanh (500ms) — đảm bảo badge cập nhật gần như realtime sau toggle/bail
    setInterval(syncPoliceFromGame, 500);

    // ===== Caught (Bị Tóm) popup — quản lý + BẢO LÃNH =====
    const caughtFab = document.getElementById('caught-fab');
    const caughtPopup = document.getElementById('caught-popup');
    const caughtBadge = document.getElementById('caught-badge');
    const caughtListEl = document.getElementById('caught-popup-list');
    caughtFab?.addEventListener('click', () => {
        if (!caughtPopup) return;
        const willOpen = caughtPopup.hidden;
        if (willOpen) closeAllPopupsExcept('caught');
        caughtPopup.hidden = !willOpen;
        if (willOpen) syncCaughtFromGame();   // force re-render khi mở
    });
    document.getElementById('caught-close')?.addEventListener('click', () => {
        if (caughtPopup) caughtPopup.hidden = true;
    });
    // Event delegation cho nút BẢO LÃNH trong popup
    caughtListEl?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.cp-bail');
        if (!btn) return;
        const uid = btn.dataset.uid;
        if (!uid) return;
        // Bảo lãnh: gọi local + broadcast cmd để OBS cũng xoá khỏi danh sách
        gameInstance?.bailUser(uid);
        sendCmd('bail', { uid: String(uid) });
        forceSyncState();
        syncCaughtFromGame();
    });

    function renderCaughtList(list) {
        if (!caughtListEl) return;
        const now = Date.now();
        const active = list.filter(c => c.releaseAt > now);
        if (!active.length) {
            caughtListEl.innerHTML = '<div class="caught-empty">Chưa có ai bị tóm.</div>';
            if (caughtBadge) caughtBadge.hidden = true;
            return;
        }
        if (caughtBadge) {
            caughtBadge.hidden = false;
            caughtBadge.textContent = String(active.length);
        }
        caughtListEl.innerHTML = active.map(c => {
            const left = Math.max(0, Math.ceil((c.releaseAt - now) / 1000));
            const av = c.avatar
                ? `<img class="cp-avatar" src="${escAttrInline(c.avatar)}" alt="">`
                : `<div class="cp-avatar ph">🥷</div>`;
            const meta = c.copName
                ? `<div class="cp-meta">do <span class="cop-name">${escHtml(c.copName)}</span> tóm</div>`
                : '';
            return `<div class="cp-row">
                ${av}
                <div class="cp-info">
                    <div class="cp-name" title="${escAttrInline(c.name || 'Trộm')}">${escHtml(c.name || 'Trộm')}</div>
                    ${meta}
                    <span class="cp-cd">${left}s</span>
                </div>
                <button class="cp-bail" data-uid="${escAttrInline(c.uid || '')}" title="Bảo lãnh trộm này ra sớm">BẢO LÃNH</button>
            </div>`;
        }).join('');
    }
    function syncCaughtFromGame() {
        if (!gameInstance || typeof gameInstance.getCaughtList !== 'function') return;
        renderCaughtList(gameInstance.getCaughtList());
    }
    setInterval(syncCaughtFromGame, 500);   // cập nhật countdown + badge nhanh

    // ===== License Gate =====
    const gateEl = document.getElementById('license-gate');
    const gateInput = document.getElementById('lg-key-input');
    const gateBtn = document.getElementById('lg-activate-btn');
    const gateMsg = document.getElementById('lg-message');
    const licStatusText = document.getElementById('lic-status-text');
    const licMeta = document.getElementById('lic-meta');
    // (Nút Đăng xuất key đã bỏ — bản quyền chỉ là badge thông tin trong Settings)

    function showGate(errorMsg) {
        if (gateEl) {
            gateEl.hidden = false;
            if (errorMsg) {
                gateMsg.textContent = errorMsg;
                gateMsg.className = 'lg-message';
            } else {
                gateMsg.textContent = '';
                gateMsg.className = 'lg-message';
            }
            setTimeout(() => gateInput?.focus(), 50);
        }
    }
    function hideGate() {
        if (gateEl) gateEl.hidden = true;
    }
    function updateLicenseBadge(info) {
        if (!licStatusText) return;
        const role = String(info.role || '').toUpperCase();
        const vipText = String(info.vip || '').trim();
        const isAdmin = role === 'ADMIN';
        const isCreator = role === 'CREATOR';
        const isVip = /vip/i.test(vipText);

        // Tag: role mới (ADMIN/CREATOR) → fallback VIP/Thường cho key cũ
        let tagIco, tagText;
        if (isCreator) { tagIco = '🎥'; tagText = 'CREATOR'; }
        else if (isAdmin) { tagIco = '👑'; tagText = 'ADMIN'; }
        else if (isVip) { tagIco = '⭐'; tagText = 'VIP'; }
        else { tagIco = ''; tagText = vipText || 'Bản quyền'; }

        const offlinePrefix = info.offline ? '🌐 Offline · ' : '';
        const tag = offlinePrefix + (tagIco ? tagIco + ' ' : '') + tagText;
        // CREATOR: key chính là TikTok ID → hiển thị full để user dễ thấy
        // ADMIN/VIP: mask key cho bảo mật
        const keyDisplay = isCreator
            ? '@' + (info.key || '')
            : (info.key ? info.key.slice(0, 4) + '****' + info.key.slice(-4) : '');
        const expiry = info.expiry || '—';

        let html = `${escAttrInline(tag)} <span class="lic-sep">·</span> <span class="lic-keymask">${escAttrInline(keyDisplay)}</span> <span class="lic-sep">·</span> HSD <b>${escAttrInline(expiry)}</b>`;

        // Hàng 2 (CREATOR): nhắc TikTok ID cần connect
        if (isCreator && info.key) {
            html += `<div class="lic-creator-bind">🔗 Chỉ kết nối được với TikTok <b>@${escAttrInline(info.key)}</b></div>`;
        }

        licStatusText.innerHTML = html;
        const cls = info.offline ? 'offline' : (isCreator ? 'creator' : (isAdmin ? 'admin' : (isVip ? 'vip' : 'normal')));
        licStatusText.className = 'lic-status compact ' + cls;
        if (licMeta) licMeta.innerHTML = '';

        // === CREATOR auto-fill username ===
        // Key CREATOR = TikTok ID. Auto-fill field username nếu đang trống.
        if (isCreator && info.key && dom.usernameInput && !dom.usernameInput.value.trim()) {
            dom.usernameInput.value = info.key;
        }
    }
    async function tryActivate() {
        const key = (gateInput.value || '').trim();
        if (!key) {
            gateMsg.textContent = 'Vui lòng nhập key';
            gateMsg.className = 'lg-message';
            gateInput.focus();
            return;
        }
        gateBtn.disabled = true;
        gateMsg.textContent = '⏳ Đang kiểm tra với server...';
        gateMsg.className = 'lg-message info';
        try {
            const res = await fetch('/api/license/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            });
            const data = await res.json();
            if (!data.ok) {
                gateMsg.textContent = '❌ ' + (data.error || 'Key không hợp lệ');
                gateMsg.className = 'lg-message';
                gateBtn.disabled = false;
                return;
            }
            gateMsg.textContent = `✓ Kích hoạt thành công · ${data.vip} · HSD ${data.expiry}`;
            gateMsg.className = 'lg-message ok';
            await new Promise(r => setTimeout(r, 700));
            hideGate();
            updateLicenseBadge(data);
            startApp();
        } catch (e) {
            gateMsg.textContent = '❌ Lỗi kết nối: ' + e.message;
            gateMsg.className = 'lg-message';
            gateBtn.disabled = false;
        }
    }
    gateBtn?.addEventListener('click', tryActivate);
    gateInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryActivate(); });

    let appStarted = false;
    async function startApp() {
        if (appStarted) return;
        appStarted = true;
        setStatus(null, 'Chưa kết nối');
        try {
            const u = await (await fetch('/api/last-user')).json();
            if (u?.username) dom.usernameInput.value = u.username;
        } catch (e) {}
        await loadGames();
        if (games.length) openGame(games[0].id);
        initSidebarToggle();
        // CHỈ check 1 lần khi mở app — KHÔNG có setInterval định kỳ
        setTimeout(() => checkForUpdate(), 3000);
    }

    // ===== Sidebar toggle thu/mở =====
    // Manual toggle (không auto hover) + persist qua localStorage.
    // Class .sidebar.collapsed cho child styling, .app.sidebar-collapsed cho grid track.
    function initSidebarToggle() {
        const btn = document.getElementById('sidebar-toggle');
        const sidebar = document.querySelector('.sidebar');
        const app = document.querySelector('.app');
        if (!btn || !sidebar || !app) return;
        const KEY = 'hp-sidebar-collapsed';
        // Default thu gọn khi lần đầu mở app (chưa có localStorage entry).
        // User toggle 1 lần → preference được nhớ qua KEY ('0' = mở rộng, '1' = thu).
        const savedRaw = localStorage.getItem(KEY);
        const saved = savedRaw === null ? true : savedRaw === '1';
        applyState(saved);
        btn.addEventListener('click', () => {
            const willCollapse = !sidebar.classList.contains('collapsed');
            applyState(willCollapse);
            localStorage.setItem(KEY, willCollapse ? '1' : '0');
        });
        function applyState(collapsed) {
            sidebar.classList.toggle('collapsed', collapsed);
            app.classList.toggle('sidebar-collapsed', collapsed);
            // Toggle ở body để FAB ngoài .app cũng pick up --fab-base-left.
            document.body.classList.toggle('sidebar-collapsed', collapsed);
            btn.textContent = collapsed ? '›' : '‹';
            btn.title = collapsed ? 'Mở rộng menu' : 'Thu gọn menu';
        }
    }

    // ===== Init: license gate trước, app sau =====
    (async function bootstrap() {
        try {
            const lic = await (await fetch('/api/license/status')).json();
            if (lic.activated) {
                updateLicenseBadge(lic);
                startApp();
            } else {
                showGate(lic.error);
            }
        } catch (e) {
            showGate('Không kết nối được server: ' + e.message);
        }
    })();
})();

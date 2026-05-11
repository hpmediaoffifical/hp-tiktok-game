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
    const EFFECTS = [
        { key: 'thief',      ico: '🥷', label: 'Trộm' },
        { key: 'joinPolice', ico: '🚓', label: 'Gia nhập CS' },
        { key: 'osin',       ico: '🧹', label: 'Osin nhặt quà' },
        { key: 'fireworks',  ico: '🎆', label: 'Pháo hoa' },
        { key: 'megaboom',   ico: '💥', label: 'Megaboom' },
        { key: 'tornado',    ico: '🌀', label: 'Lốc xoáy' },
        { key: 'tilt',       ico: '⚖',  label: 'Nghiêng hũ' },
        { key: 'gravflip',   ico: '🔄', label: 'Đảo trọng lực' },
        { key: 'shake',      ico: '💢', label: 'Lắc hũ' },
        { key: 'slow',       ico: '🐢', label: 'Slow motion' },
        { key: 'crackJar',   ico: '🪟', label: 'Nứt hũ' },
        { key: 'stealJar',   ico: '🚚', label: 'Trộm cả hũ' },
        { key: 'combo',      ico: '⛓', label: 'Combo (chuỗi)' },
        { key: 'clear',      ico: '🗑', label: 'Xoá hết hũ' }
    ];

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
        statRoom: $('#stat-room'),
        statViewer: $('#stat-viewer'),
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
        btnClearJar: $('#btn-clear-jar'),
        btnShake: $('#btn-shake'),
        btnResetSession: $('#btn-reset-session'),
        btnThief: $('#btn-thief'),
        btnOsin: $('#btn-osin'),
        btnFxFirework: $('#btn-fx-firework'),
        btnFxTornado: $('#btn-fx-tornado'),
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
        saveStatus: $('#save-status'),
        triggerList: $('#trigger-list'),
        giftOptions: $('#gift-options'),
    };
    let currentTriggers = {};  // giftId → action

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
            div.innerHTML = `<span class="ico">${g.icon}</span>
                <div class="meta">
                    <div class="gn">${g.name}</div>
                    <div class="gd">${g.description.length > 38 ? g.description.slice(0, 38) + '…' : g.description}</div>
                </div>`;
            div.addEventListener('click', () => openGame(g.id));
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
        if (gameId === 'thuytinh') openThuytinh(game);
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
            jglass.src = '/assets/thuytinh/jar-glass.png';
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
            (state.tippers || []).length
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
        bindRange(dom.cfgGoal, cfg.goal?.target ?? 1000, dom.cfgGoalV);
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
            goal: { target: parseInt(dom.cfgGoal.value, 10) || 1000 },
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
    function renderTriggerList() {
        if (!dom.triggerList) return;
        dom.triggerList.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const ef of EFFECTS) {
            const giftId = Object.keys(currentTriggers).find(id => currentTriggers[id] === ef.key) || '';
            const row = document.createElement('div');
            row.className = 'trigger-row';
            const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = ef.ico;
            const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = ef.label;
            const prev = document.createElement('span'); prev.className = 'preview';
            const g = giftMap[String(giftId)];
            if (g?.image) {
                const im = document.createElement('img'); im.src = g.image; im.title = g.name; prev.appendChild(im);
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
        const existingGift = Object.keys(currentTriggers).find(id => currentTriggers[id] === ef.key) || '';
        editingDraft = {
            giftId: existingGift,
            params: JSON.parse(JSON.stringify(currentEffectsConfig[ef.key] || {}))
        };
        modalIco.textContent = ef.ico;
        modalName.textContent = ef.label;
        renderModalGift();
        renderModalParams();
        efPicker.hidden = true;
        modal.hidden = false;
    }
    function closeEffectModal() {
        modal.hidden = true;
        editingEffect = null;
        editingDraft = null;
    }
    function renderModalGift() {
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
        for (const d of defs) {
            const row = document.createElement('div'); row.className = 'ef-param-row';
            const lbl = document.createElement('label'); lbl.textContent = d.label;
            const cur = (editingDraft.params[d.key] !== undefined) ? editingDraft.params[d.key] : d.default;
            if (d.type === 'text') {
                // Text input chiếm 2 cột
                row.classList.add('ef-param-text');
                const input = document.createElement('input');
                input.type = 'text';
                input.value = String(cur || '');
                if (d.placeholder) input.placeholder = d.placeholder;
                input.addEventListener('input', () => {
                    editingDraft.params[d.key] = input.value;
                });
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
            default: return [];
        }
    }
    function openModalPicker() {
        efPicker.hidden = false;
        efPicker.innerHTML = '';
        const frag = document.createDocumentFragment();
        // Hiển thị toàn bộ; quà đã gán cho hiệu ứng KHÁC sẽ bị disable
        for (const g of giftSheet) {
            const assignedTo = currentTriggers[String(g.id)];
            const isTakenByOther = assignedTo && assignedTo !== editingEffect.key;
            const pg = document.createElement('div'); pg.className = 'pg';
            if (isTakenByOther) {
                const otherEf = EFFECTS.find(e => e.key === assignedTo);
                pg.classList.add('pg-disabled');
                pg.title = `Đã gán cho ${otherEf?.label || assignedTo}`;
            } else {
                pg.title = g.name;
            }
            const badge = isTakenByOther
                ? `<div class="pg-badge">${(EFFECTS.find(e => e.key === assignedTo)?.ico || '·')}</div>`
                : '';
            pg.innerHTML = `${badge}<img src="${g.image}" /><div class="nm">${g.name || ''}</div><div class="di">${g.diamond}⭐</div>`;
            if (!isTakenByOther) {
                pg.addEventListener('click', () => {
                    editingDraft.giftId = String(g.id);
                    renderModalGift();
                    efPicker.hidden = true;
                });
            } else {
                pg.addEventListener('click', () => {
                    const otherEf = EFFECTS.find(e => e.key === assignedTo);
                    alert(`Quà "${g.name}" đã được gán cho hiệu ứng "${otherEf?.label || assignedTo}". Hãy xoá gán cũ trước.`);
                });
            }
            frag.appendChild(pg);
        }
        efPicker.appendChild(frag);
    }
    btnPick?.addEventListener('click', openModalPicker);
    btnClearGift?.addEventListener('click', () => { editingDraft.giftId = ''; renderModalGift(); efPicker.hidden = true; });
    btnClose?.addEventListener('click', closeEffectModal);
    btnCancel?.addEventListener('click', closeEffectModal);
    btnSave?.addEventListener('click', () => {
        if (!editingEffect || !editingDraft) return closeEffectModal();
        // 1) Cập nhật triggers: xoá assignment cũ cho effect này + cho gift này
        for (const k of Object.keys(currentTriggers)) {
            if (currentTriggers[k] === editingEffect.key) delete currentTriggers[k];
        }
        if (editingDraft.giftId) {
            delete currentTriggers[String(editingDraft.giftId)];
            currentTriggers[String(editingDraft.giftId)] = editingEffect.key;
        }
        // 2) Cập nhật effects params
        currentEffectsConfig[editingEffect.key] = editingDraft.params;
        // 3) Save NGAY
        renderTriggerList();
        renderGiftCatalog(dom.giftSearchInput.value);
        pushConfigUpdate(true);
        const g = editingDraft.giftId ? giftMap[String(editingDraft.giftId)] : null;
        flashTriggerToast(g
            ? `✓ Đã gán ${g.name} → ${editingEffect.ico} ${editingEffect.label}`
            : `✓ Đã lưu cài đặt ${editingEffect.label}`);
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
        const list = (!f ? giftSheet : giftSheet.filter(g =>
            g.id.toLowerCase().includes(f) || (g.name || '').toLowerCase().includes(f)
        ));
        const frag = document.createDocumentFragment();
        for (const g of list.slice(0, 400)) {
            const card = document.createElement('div');
            card.className = 'gift-card';
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
        // Xoá assignment cũ của effect này (1 effect → 1 quà)
        for (const k of Object.keys(currentTriggers)) {
            if (currentTriggers[k] === effect) delete currentTriggers[k];
        }
        currentTriggers[String(giftId)] = effect;
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
        if (connected) {
            // Ẩn input, đổi nút thành dạng toggle disconnect
            if (dom.connRow) dom.connRow.style.display = 'none';
            dom.btnConnect.classList.remove('primary');
            dom.btnConnect.classList.add('secondary');
            dom.btnConnect.disabled = false;
            dom.btnConnect.innerHTML = `<span style="color:#22c55e">●</span> @${escAttrInline(liveUsername)} · Bấm để ngắt`;
        } else {
            if (dom.connRow) dom.connRow.style.display = '';
            dom.btnConnect.classList.add('primary');
            dom.btnConnect.classList.remove('secondary');
            dom.btnConnect.disabled = false;
            dom.btnConnect.textContent = 'Kết nối LIVE';
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
        const ok = window.confirm(`Ngắt kết nối khỏi @${liveUsername}?`);
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
    // QUAN TRỌNG: btnClearJar / btnShake phải sendCmd ra OBS, không chỉ chạy local
    // (lỗi v1.0.2: chỉ gọi local → OBS không xoá hũ theo)
    dom.btnClearJar.addEventListener('click', () => { gameInstance?.clearAll(); sendCmd('clear'); forceSyncState(); });
    dom.btnShake.addEventListener('click', () => { gameInstance?.shake(); sendCmd('shake'); });

    dom.giftSearchInput.addEventListener('input', () => renderGiftCatalog(dom.giftSearchInput.value));
    dom.usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.btnConnect.click(); });

    // Config range inputs
    ['cfgGravity', 'cfgBounce', 'cfgFriction', 'cfgJarH', 'cfgGmin', 'cfgGmax', 'cfgGoal', 'cfgGoalGap', 'cfgShakeAt', 'cfgThiefMiss', 'cfgPoliceRate', 'cfgPoliceBan', 'cfgScaleLb', 'cfgScaleCaught']
        .forEach(k => dom[k]?.addEventListener('input', pushConfigUpdate));
    dom.cfgPoliceName?.addEventListener('input', pushConfigUpdate);
    dom.cfgShowCount?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarVisible?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarLocked?.addEventListener('change', pushConfigUpdate);
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
    dom.btnResetSession?.addEventListener('click', () => {
        // Phiên mới: reset stats + clear bodies trong hũ + đồng bộ OBS qua 2 cmd
        gameInstance?.resetSession();
        gameInstance?.clearAll();
        sendCmd('resetSession');
        sendCmd('clear');
        forceSyncState();
    });
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
    });

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
        if (typeof r.viewerCount === 'number') dom.statViewer.textContent = `👥 ${r.viewerCount}`;
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
    function openCommentsPopup() {
        if (commentsPopup) commentsPopup.hidden = false;
        setUnread(0);
        // scroll xuống dưới
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
    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
        if (settingsPopup) settingsPopup.hidden = false;
    });
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
        policePopup.hidden = !policePopup.hidden;
        if (!policePopup.hidden) syncPoliceFromGame();   // force re-render khi mở
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
        caughtPopup.hidden = !caughtPopup.hidden;
        if (!caughtPopup.hidden) syncCaughtFromGame();   // force re-render khi mở
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
        // CHỈ check 1 lần khi mở app — KHÔNG có setInterval định kỳ
        setTimeout(() => checkForUpdate(), 3000);
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

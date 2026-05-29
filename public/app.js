(function () {
    const socket = io();

    // ★ Overlay resolution helper — append ?res=4k khi user chọn 4K
    // Apply globally cho TẤT CẢ overlay URLs (thuytinh, caro, vipwelcome, translate, ...)
    function getOverlayResolution() {
        return localStorage.getItem('hp-overlay-res') === '4k' ? '4k' : 'hd';
    }
    function setOverlayResolution(res) {
        localStorage.setItem('hp-overlay-res', res === '4k' ? '4k' : 'hd');
        // Re-render tất cả overlay URL inputs đang hiển thị
        document.querySelectorAll('input[id$="-overlay-url"], #overlay-url').forEach(inp => {
            if (inp._baseOverlayPath) {
                inp.value = buildOverlayURL(inp._baseOverlayPath);
            } else if (inp.value && inp.value.includes('/overlay/')) {
                // Re-apply on existing URL
                const baseUrl = inp.value.replace(/\?res=[^&]*&?/, '').replace(/[?&]$/, '');
                inp.value = buildOverlayURL(baseUrl.replace(location.origin, ''));
            }
        });
    }
    function buildOverlayURL(pathOrFull) {
        if (!pathOrFull) return '';
        let url = pathOrFull.startsWith('http') ? pathOrFull : (location.origin + pathOrFull);
        const res = getOverlayResolution();
        if (res === '4k') {
            // Append ?res=4k (xử lý nếu URL đã có query khác)
            url += (url.includes('?') ? '&' : '?') + 'res=4k';
        }
        return url;
    }
    // Expose ra window để game panels (bancung, caro, ...) dùng được
    window.buildOverlayURL = buildOverlayURL;
    window.getOverlayResolution = getOverlayResolution;
    // Wire up resolution toggle (chỉ có ở header thuytinh nhưng global cho tất cả)
    document.addEventListener('DOMContentLoaded', () => {
        const sel = document.getElementById('overlay-resolution-select');
        if (sel) {
            sel.value = getOverlayResolution();
            sel.addEventListener('change', () => {
                setOverlayResolution(sel.value);
                if (typeof toast === 'function') toast(`✓ Đã đổi sang ${sel.value === '4k' ? '4K 2160' : 'HD 1080'}`, 'success', 2000);
            });
        }

        // ★ Toggle ẩn/hiện preview thuytinh (giảm lag khi không cần thấy hũ animation)
        const previewBtn = document.getElementById('btn-toggle-thuytinh-preview');
        const gameBody = document.querySelector('#view-thuytinh .game-body');
        if (previewBtn && gameBody) {
            // Default: ẨN preview (giảm lag), localStorage nhớ user choice
            const isHidden = localStorage.getItem('hp-thuytinh-preview-hidden') !== 'false';
            const updateUI = () => {
                const hidden = gameBody.classList.contains('preview-hidden');
                previewBtn.textContent = hidden ? '👁 Hiện preview' : '🙈 Ẩn preview';
                previewBtn.classList.toggle('preview-shown', !hidden);
                previewBtn.title = hidden
                    ? 'Preview đang ẩn — bấm để hiện khi cần config hũ position'
                    : 'Preview đang hiện — bấm để ẩn cho đỡ lag';
            };
            if (isHidden) gameBody.classList.add('preview-hidden');
            updateUI();
            previewBtn.addEventListener('click', () => {
                gameBody.classList.toggle('preview-hidden');
                const nowHidden = gameBody.classList.contains('preview-hidden');
                localStorage.setItem('hp-thuytinh-preview-hidden', String(nowHidden));
                updateUI();
                // ẨN preview → DỪNG vẽ quà + hiệu ứng trong app (giảm lag thật sự). Physics vẫn chạy
                // nên OBS overlay KHÔNG bị ảnh hưởng. HIỆN lại → vẽ tiếp từ state hiện tại.
                if (gameInstance && currentGame?.id === 'thuytinh') {
                    try { gameInstance.setRenderActive(!nowHidden); } catch (e) {}
                }
                if (typeof toast === 'function') {
                    toast(nowHidden ? '🙈 Đã ẨN preview — dừng vẽ quà/hiệu ứng trong app (OBS vẫn chạy)' : '👁 Đã HIỆN preview', 'info', 2200);
                }
            });
        }
    });
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
        { key: 'spinJar',    ico: '🌀', label: 'OSIN xoay hũ' },
        { key: 'osinKickOut',ico: '🥾', label: 'OSIN đá tung quà' },
        { key: 'dragonFire', ico: '🐉', label: 'Rồng phun lửa (5s)' },
        { key: 'zigzagLuck', ico: '🎰', label: 'Zikzak may mắn' },
        { key: 'shape',      ico: '🎨', label: 'Tạo hình quà' },
        { key: 'megaboom',   ico: '💥', label: 'Megaboom' },
        { key: 'pourOut',    ico: '🫗', label: 'Dốc ngược hũ (đổ hết)' },
        { key: 'gravflip',   ico: '🔃', label: 'Đảo trọng lực' },
        { key: 'shake',      ico: '💢', label: 'Rung hũ' },
        { key: 'rain',       ico: '☔', label: 'Mưa quà' },
        { key: 'magnet',     ico: '🧲', label: 'Nam châm' },
        { key: 'wind',       ico: '🪁', label: 'Thả diều Avatar Gió' },
        { key: 'crackJar',   ico: '🪟', label: 'Nứt hũ' },
        { key: 'stealJar',   ico: '🚚', label: 'Trộm cả hũ' },
        { key: 'combo',      ico: '⛓', label: 'Combo (chuỗi)' },
        { key: 'clear',      ico: '🗑', label: 'Xoá hết hũ' }
    ];
    const REMOVED_EFFECTS = new Set(['tilt', 'fireworks', 'tornado', 'geyser', 'slow']);
    function isMultiEffect(key) {
        const ef = EFFECTS.find(e => e.key === key);
        return !!(ef && ef.multi);
    }
    function giftIdsForEffect(key) {
        return Object.keys(currentTriggers).filter(id => currentTriggers[id] === key);
    }
    function findAssignedGiftId(gift) {
        const directId = String(gift?.id ?? gift?.giftId ?? '');
        if (directId && currentTriggers[directId]) return directId;
        const giftName = String(gift?.name || gift?.giftName || '').trim().toLowerCase();
        const giftImage = String(gift?.image || gift?.giftPicture || '').trim();
        for (const id of Object.keys(currentTriggers || {})) {
            const meta = giftMap[String(id)];
            if (!meta) continue;
            if (giftName && String(meta.name || '').trim().toLowerCase() === giftName) return String(id);
            if (giftImage && String(meta.image || '').trim() === giftImage) return String(id);
        }
        return directId;
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
    function cleanupUnassignedGiftState(giftId) {
        const id = String(giftId || '');
        if (!id || currentTriggers[id]) return;
        dropRecent(id);
        if (currentBadgeItems[id]) delete currentBadgeItems[id];
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
        for (const id of oldIds) if (!newIds.has(id)) cleanupUnassignedGiftState(id);
    }

    // ===== Feature toggles map =====
    const FEATURE_KEYS = ['audio','welcome','crown','leaderboard','sessionTotals','goalBar','combo','tierBorder','bigGiftFx','autoShake','randomEvents','thiefAuto','police','topHangers','defaultHpAvatar','dropWithTrigger'];
    const FEATURE_INPUT = {
        audio:'ft-audio', welcome:'ft-welcome', crown:'ft-crown', leaderboard:'ft-leaderboard',
        sessionTotals:'ft-totals', goalBar:'ft-goalbar', combo:'ft-combo', tierBorder:'ft-tier',
        bigGiftFx:'ft-bigfx', autoShake:'ft-autoshake', randomEvents:'ft-random', thiefAuto:'ft-thiefauto',
        police:'ft-police', topHangers:'ft-tophangers', defaultHpAvatar:'ft-default-hp',
        // 🪂 Global toggle: khi quà kích hoạt hiệu ứng, vẫn thả icon quà gốc vào
        // hũ (mặc định OFF = chỉ chạy effect, không thả). 1 nút cho TẤT CẢ effects
        // → không phải setup per-effect.
        dropWithTrigger:'ft-drop-with-trigger'
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
        quickLaunchGrid: $('#quick-launch-grid'),
        quickLaunchFab: $('#quick-launch-fab'),
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
        cfgGdrop: $('#cfg-gdrop'),
        cfgGdropV: $('#cfg-gdrop-v'),
        cfgShowCount: $('#cfg-show-count'),
        cfgJarVisible: $('#cfg-jar-visible'),
        cfgJarLocked: $('#cfg-jar-locked'),
        btnResetSessionTop: $('#btn-reset-session-top'),
        btnThief: $('#btn-thief'),
        btnOsin: $('#btn-osin'),
        btnFxFirework: $('#btn-fx-firework'),
        btnFxTornado: $('#btn-fx-tornado'),
        btnFxShape: $('#btn-fx-shape'),
        btnFxWind: $('#btn-fx-wind'),
        cfgGoal: $('#cfg-goal'),
        cfgGoalV: $('#cfg-goal-v'),
        cfgShakeAt: $('#cfg-shake-at'),
        cfgShakeAtV: $('#cfg-shake-at-v'),
        cfgGoalGap: $('#cfg-goal-gap'),
        cfgGoalGapV: $('#cfg-goal-gap-v'),
        cfgWebmVol: $('#cfg-webm-vol'),
        cfgWebmVolV: $('#cfg-webm-vol-v'),
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
        cfgBadgesGap: $('#cfg-badges-gap'),
        cfgBadgesGapV: $('#cfg-badges-gap-v'),
        cfgBadgesNameScale: $('#cfg-badges-name-scale'),
        cfgBadgesNameScaleV: $('#cfg-badges-name-scale-v'),
        cfgBadgesLocked: $('#cfg-badges-locked'),
        cfgBadgesAutoscroll: $('#cfg-badges-autoscroll'),
        cfgBadgesVisible: $('#cfg-badges-visible'),
        cfgBadgesVisibleV: $('#cfg-badges-visible-v'),
        cfgBadgesScrollDir: $('#cfg-badges-scroll-dir'),
        cfgBadgesSpeed: $('#cfg-badges-speed'),
        cfgBadgesSpeedV: $('#cfg-badges-speed-v'),
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
    const GAME_DEVELOPMENT_NOTICE = 'Đang phát triển, có thể gặp sự cố...';
    // Whitelist game đã ổn định — không hiển thị cảnh báo "Đang phát triển"
    const STABLE_GAMES = new Set(['thuytinh', 'caro', 'votecomment', 'nhietdo', 'bancung', 'level-quest', 'timer', 'liveTranslate']);

    function renderGameDevelopmentNotice(game) {
        if (STABLE_GAMES.has(game.id)) return '';
        return `<div class="gd game-dev-notice game-dev-${game.id}">${GAME_DEVELOPMENT_NOTICE}</div>`;
    }

    async function loadGames() {
        const res = await fetch('/api/games');
        games = await res.json();
        games.push({
            id: 'liveTranslate',
            name: 'Dịch Thuật LIVE',
            description: 'Dịch bình luận, đọc bình luận và phụ đề giọng Creator cho OBS.',
            icon: '🌐',
            virtual: true,
            config: { enabled: localStorage.getItem('hp-live-translate-tool-enabled') !== 'false' }
        });
        games.push({
            id: 'obs-effects',
            name: 'Hiệu ứng OBS',
            description: 'Bridge WebSocket → OBS Studio. Trigger Lua effects khi nhận gift TikTok.',
            icon: '🎬',
            virtual: true,
            config: { enabled: localStorage.getItem('hp-obs-effects-enabled') !== 'false' }
        });
        // ★ Đẩy trạng thái master obs-effects (theo UI/localStorage) lên server NGAY khi khởi động —
        // server là nơi gate quà. Sửa drift của user đã tắt từ trước (localStorage=false nhưng server
        // mặc định true → trước đây vẫn nhận quà dù UI hiện tắt).
        try {
            const obsOn = localStorage.getItem('hp-obs-effects-enabled') !== 'false';
            fetch('/api/obs-bridge/config', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: obsOn })
            }).catch(() => {});
        } catch (e) {}
        renderGameList();
        renderHomeGrid();
        renderQuickLaunch();
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
                    ${renderGameDevelopmentNotice(g)}
                </div>
                <button class="game-toggle ${isEnabled ? 'on' : 'off'}" data-game-toggle="${g.id}" title="${isEnabled ? 'Đang BẬT — bấm để TẮT' : 'Đang TẮT — bấm để BẬT'} ${g.virtual ? 'tool' : 'game'} chạy ngầm">⏻</button>`;
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
                if (g.virtual) {
                    // Mỗi virtual game có localStorage key riêng (tool-level enable/disable)
                    const lsKey = g.id === 'obs-effects' ? 'hp-obs-effects-enabled' : 'hp-live-translate-tool-enabled';
                    localStorage.setItem(lsKey, next ? 'true' : 'false');
                    if (g.config) g.config.enabled = next;
                    updateQuickLaunchCardState(g.id);
                    // ★ obs-effects: trạng thái bật/tắt PHẢI lên server vì việc nhận quà/trigger effect
                    // chạy ở server. Không đẩy lên → tắt UI nhưng server vẫn enqueue (bug cũ).
                    if (g.id === 'obs-effects') {
                        fetch('/api/obs-bridge/config', {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled: next })
                        }).catch(() => {});
                    }
                    // Side effects khi tắt — chỉ áp dụng cho liveTranslate (giữ behavior cũ)
                    if (!next && g.id === 'liveTranslate') {
                        if (ltEnabled) ltEnabled.checked = false;
                        if (ccEnabled) ccEnabled.checked = false;
                        stopCreatorCaptionListening?.();
                        saveLiveTranslateConfig?.({ silent: true });
                        saveCreatorCaptionConfig?.().catch(() => {});
                    }
                    return;
                }
                // POST update to server
                try {
                    await fetch(`/api/games/${g.id}/config`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: next })
                    });
                    if (g.config) g.config.enabled = next;
                    if (currentGame?.id === g.id) {
                        currentGame.config = { ...(currentGame.config || {}), enabled: next };
                        if (gameInstance && g.id === 'thuytinh') gameInstance.setConfig({ enabled: next });
                    }
                    updateQuickLaunchCardState(g.id);
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
                ${renderGameDevelopmentNotice(g)}`;
            card.addEventListener('click', () => openGame(g.id));
            dom.homeGrid.appendChild(card);
        }
    }

    // ===== 🚀 Khởi động nhanh =====
    // Grid chỉ chứa các game đã ổn định (STABLE_GAMES). Mỗi card:
    //   ▶ Bắt đầu  → POST enabled=true (hoặc set localStorage cho liveTranslate virtual)
    //   ⏹ Tắt     → POST enabled=false
    //   ⚙ Mở      → vào game view chi tiết
    // State indicator tự re-render khi config thay đổi (qua updateQuickLaunchCardState).
    function quickLaunchEntries() {
        return games.filter(g => STABLE_GAMES.has(g.id));
    }
    function isGameEnabled(g) {
        const cfg = g.config || {};
        return !('enabled' in cfg) || cfg.enabled !== false;
    }
    function buildQuickLaunchCard(g) {
        const enabled = isGameEnabled(g);
        const card = document.createElement('div');
        card.className = 'ql-card ' + (enabled ? 'is-on' : 'is-off');
        card.dataset.gameId = g.id;
        card.innerHTML = `
            <div class="ql-card-head">
                <span class="ql-card-ico">${g.icon}</span>
                <div class="ql-card-meta">
                    <div class="ql-card-name">${g.name}</div>
                    <span class="ql-card-state ${enabled ? 'on' : 'off'}">
                        <span class="dot"></span>
                        <span class="ql-card-state-text">${enabled ? 'Đang BẬT' : 'Đang TẮT'}</span>
                    </span>
                </div>
            </div>
            <div class="ql-card-actions">
                <button class="ql-btn ql-btn-start" data-action="start" ${enabled ? 'disabled' : ''} title="Bật game ngay">▶ Bắt đầu</button>
                <button class="ql-btn ql-btn-stop"  data-action="stop"  ${enabled ? '' : 'disabled'} title="Tắt game">⏹ Tắt</button>
                <button class="ql-btn ql-btn-open"  data-action="open"  title="Mở cài đặt chi tiết">⚙</button>
            </div>
        `;
        card.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'open') { openGame(g.id); return; }
            // Đọc state HIỆN TẠI (g.config có thể đã đổi sau khi user vừa bấm) — KHÔNG dùng closure `enabled`
            const curOn = isGameEnabled(g);
            if (action === 'start' && !curOn) setGameEnabled(g, true);
            else if (action === 'stop' && curOn) setGameEnabled(g, false);
        });
        return card;
    }
    function renderQuickLaunch() {
        const host = dom.quickLaunchGrid;
        if (!host) return;
        host.innerHTML = '';
        for (const g of quickLaunchEntries()) host.appendChild(buildQuickLaunchCard(g));
    }
    function updateQuickLaunchCardState(gameId) {
        // Cả 2 grid (Home + popup) phải sync — selectAll thay vì querySelector
        const cards = document.querySelectorAll(`.ql-card[data-game-id="${gameId}"]`);
        if (!cards.length) return;
        const g = games.find(x => x.id === gameId);
        if (!g) return;
        const enabled = isGameEnabled(g);
        cards.forEach(card => {
            card.classList.toggle('is-on', enabled);
            card.classList.toggle('is-off', !enabled);
            const state = card.querySelector('.ql-card-state');
            const stateText = card.querySelector('.ql-card-state-text');
            if (state) { state.classList.toggle('on', enabled); state.classList.toggle('off', !enabled); }
            if (stateText) stateText.textContent = enabled ? 'Đang BẬT' : 'Đang TẮT';
            const startBtn = card.querySelector('.ql-btn-start');
            const stopBtn = card.querySelector('.ql-btn-stop');
            if (startBtn) startBtn.disabled = enabled;
            if (stopBtn) stopBtn.disabled = !enabled;
        });
    }
    // FAB click → mở cửa sổ Khởi động nhanh tách rời. Trong Electron, setWindowOpenHandler
    // catch URL /quick-launch và tạo BrowserWindow always-on-top (xem electron-main.js).
    // Trong browser thường → window.open mở tab/popup mới với size hint.
    function bindQuickLaunchFab() {
        const fab = dom.quickLaunchFab;
        if (!fab) return;
        fab.addEventListener('click', (e) => {
            e.stopPropagation();
            window.open('/quick-launch', '_blank', 'width=380,height=560,resizable=yes,scrollbars=no');
        });
    }
    bindQuickLaunchFab();

    // === Quick Launch action dispatcher — 3 action: start / stop / reset
    //   start  = bấm BẮT ĐẦU / tiếp tục phiên (resume từ paused)
    //   stop   = bấm DỪNG (pause, giữ tiến trình)
    //   reset  = chạy lại từ đầu (xóa tiến trình)
    // KHÔNG đụng sidebar toggle ⏻ (Bật/Tắt overlay OBS — khác việc start session). ===
    async function handleQuickLaunchCmd({ gameId, action }) {
        switch (gameId) {
            case 'thuytinh':
                // Game không có khái niệm "start/stop session" — quà tự rơi khi enabled.
                // reset = "↺ HŨ MỚI" (xóa quà + reset counters). start/stop = no-op.
                if (action === 'reset') {
                    try {
                        gameInstance?.resetSession?.();
                        sendCmd?.('resetSession');   // broadcast OBS overlay
                    } catch (e) { console.warn('[quick-launch] thuytinh reset fail:', e); }
                }
                break;
            case 'caro':
                try {
                    const caro = window.HpCaroPanel?.instance?.();
                    if (!caro) break;
                    if (action === 'start') caro.openRegistration?.();
                    else if (action === 'stop')  caro.closeRegistration?.();
                    else if (action === 'reset') caro.newGame?.();   // về phase setup
                } catch (e) { console.warn('[quick-launch] caro action fail:', e); }
                break;
            case 'votecomment':
                try {
                    await fetch('/api/games/votecomment/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cmd: action })   // 'start' | 'stop' | 'reset'
                    });
                } catch (e) { console.warn('[quick-launch] votecomment control fail:', e); }
                break;
            case 'nhietdo':
                try {
                    await fetch('/api/games/nhietdo/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cmd: action })   // 'start' | 'stop' | 'reset'
                    });
                } catch (e) { console.warn('[quick-launch] nhietdo control fail:', e); }
                break;
            case 'bancung':
                try {
                    await fetch('/api/games/bancung/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cmd: action })   // 'start' | 'stop' | 'reset'
                    });
                } catch (e) { console.warn('[quick-launch] bancung control fail:', e); }
                break;
            case 'level-quest': {
                const f = document.getElementById('lq-frame');
                try { f?.contentWindow?.postMessage({ type: 'quickLaunch', action }, '*'); } catch (e) {}
                break;
            }
            case 'timer': {
                const f = document.getElementById('timer-frame');
                try { f?.contentWindow?.postMessage({ type: 'quickLaunch', action }, '*'); } catch (e) {}
                break;
            }
            case 'liveTranslate':
                // Không có session "running" — chỉ on/off. start = bật + tick lt-tts.
                // stop + reset = tắt (reset không có thêm semantics khác).
                if (action === 'start') {
                    if (ltTts) ltTts.checked = true;
                    try { await setLiveTranslateRunning(true);  } catch (e) {}
                } else {
                    try { await setLiveTranslateRunning(false); } catch (e) {}
                }
                break;
        }
    }
    socket.on('quickLaunch:cmd', handleQuickLaunchCmd);

    // === Broadcast trạng thái Đang chạy của caro + liveTranslate ===
    // Cửa sổ Khởi động nhanh cần biết game nào đang trong phiên active. Các game khác đã có
    // socket event riêng (votecomment:state, timer:state, levelquest:state). Caro + liveTranslate
    // là client-side → main app phải tự broadcast. Dùng heartbeat 2s để bắt cả case cửa sổ rời
    // mở giữa chừng (snapshot tới ngay trong vòng 2s).
    function caroIsRunning() {
        try {
            const caro = window.HpCaroPanel?.instance?.();
            const st = caro?.getState?.();
            if (!st) return false;
            // Đang trong vòng ghi danh mở, đang chọn đối thủ, hoặc đang thi đấu → coi là RUNNING
            if (st.phase === 'registration' && st.registration?.open) return true;
            if (st.phase === 'picking' || st.phase === 'playing') return true;
            return false;
        } catch { return false; }
    }
    function liveTranslateIsRunning() {
        try {
            // ltEnabled checkbox = nguồn sự thật cho "đang dịch + đọc TTS"
            return !!ltEnabled?.checked;
        } catch { return false; }
    }
    function emitQuickLaunchStatus() {
        if (!socket.connected) return;
        socket.emit('quickLaunch:status', { gameId: 'caro',          running: caroIsRunning() });
        socket.emit('quickLaunch:status', { gameId: 'liveTranslate', running: liveTranslateIsRunning() });
    }
    setInterval(emitQuickLaunchStatus, 2000);
    // Emit ngay khi 1 trong 2 thay đổi để không bị delay 2s
    socket.on('translate:config', () => emitQuickLaunchStatus());
    async function setGameEnabled(g, next) {
        // Optimistic UI
        if (g.config) g.config.enabled = next;
        updateQuickLaunchCardState(g.id);
        // Sync với sidebar toggle (cùng UI state)
        const sideBtn = document.querySelector(`[data-game-toggle="${g.id}"]`);
        if (sideBtn) {
            sideBtn.classList.toggle('on', next);
            sideBtn.classList.toggle('off', !next);
            sideBtn.title = next ? 'Đang BẬT — bấm để TẮT' : 'Đang TẮT — bấm để BẬT';
        }
        // Virtual tool (liveTranslate) dùng localStorage thay vì server config
        if (g.virtual) {
            localStorage.setItem('hp-live-translate-tool-enabled', next ? 'true' : 'false');
            if (!next) {
                if (typeof ltEnabled !== 'undefined' && ltEnabled) ltEnabled.checked = false;
                if (typeof ccEnabled !== 'undefined' && ccEnabled) ccEnabled.checked = false;
                if (typeof stopCreatorCaptionListening === 'function') stopCreatorCaptionListening();
                if (typeof saveLiveTranslateConfig === 'function') saveLiveTranslateConfig({ silent: true });
                if (typeof saveCreatorCaptionConfig === 'function') saveCreatorCaptionConfig().catch(() => {});
            }
            return;
        }
        try {
            await fetch(`/api/games/${g.id}/config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next })
            });
            if (currentGame?.id === g.id) {
                currentGame.config = { ...(currentGame.config || {}), enabled: next };
                if (gameInstance && g.id === 'thuytinh') gameInstance.setConfig({ enabled: next });
            }
        } catch (err) {
            // Revert UI on failure
            if (g.config) g.config.enabled = !next;
            updateQuickLaunchCardState(g.id);
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
        document.body.classList.remove('game-thuytinh', 'game-caro', 'game-pktiktok', 'game-vipwelcome', 'game-votecomment', 'game-nhietdo', 'game-bancung', 'game-liveTranslate');
        document.body.classList.add('game-' + gameId);
        // Auto-reload OBS overlay của game này — tránh cache stale khi user mới mở game
        try { socket && socket.emit('overlay:reload', { gameId }); } catch (e) {}
        // Đóng các popup Hũ khi rời sang game khác (tránh popup mở treo)
        if (gameId !== 'thuytinh') {
            document.getElementById('police-popup')?.setAttribute('hidden', '');
            document.getElementById('caught-popup')?.setAttribute('hidden', '');
        }
        if (gameId === 'thuytinh') openThuytinh(game);
        else if (gameId === 'caro') openCaro(game);
        else if (gameId === 'pktiktok') openPkTiktok(game);
        else if (gameId === 'vipwelcome') openVipWelcome(game);
        else if (gameId === 'votecomment') openVoteComment(game);
        else if (gameId === 'nhietdo') openNhietDo(game);
        else if (gameId === 'bancung') openBanCung(game);
        else if (gameId === 'liveTranslate') openLiveTranslateView();
        else if (gameId === 'level-quest') showView('view-level-quest');
        else if (gameId === 'timer') showView('view-timer');
        else if (gameId === 'obs-effects') showView('view-obs-effects');
    }

    function openVoteComment(game) {
        if (window.HpVoteCommentPanel && typeof window.HpVoteCommentPanel.open === 'function') {
            window.HpVoteCommentPanel.open(socket);
        } else {
            console.error('[votecomment] HpVoteCommentPanel chưa load');
        }
    }

    function openNhietDo(game) {
        if (!window.__giftSheet) window.__giftSheet = giftSheet;
        if (window.HpNhietDoPanel && typeof window.HpNhietDoPanel.open === 'function') {
            window.HpNhietDoPanel.open(socket);
        } else {
            console.error('[nhietdo] HpNhietDoPanel chưa load');
        }
    }

    function openBanCung(game) {
        if (!window.__giftSheet) window.__giftSheet = giftSheet;
        if (window.HpBanCungPanel && typeof window.HpBanCungPanel.open === 'function') {
            window.HpBanCungPanel.open(socket);
        } else {
            console.error('[bancung] HpBanCungPanel chưa load');
        }
    }

    function openLiveTranslateView() {
        showView('view-live-translate');
        const host = document.getElementById('live-translate-workspace');
        if (!host) return;
        const translate = document.getElementById('translate-popup');
        const caption = document.getElementById('creator-caption-popup');
        if (translate && translate.parentElement !== host) host.appendChild(translate);
        if (caption && caption.parentElement !== host) host.appendChild(caption);
        if (translate) translate.hidden = false;
        if (caption) caption.hidden = false;
        loadLiveTranslateConfig?.();
        loadCreatorCaptionConfig?.();
        autoSyncTranslateRules?.();
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
        mountThuySidePanel?.('police');
        dom.gTitle.textContent = `${game.icon} ${game.name}`;
        if (dom.gSub) dom.gSub.textContent = '';
        dom.overlayUrl._baseOverlayPath = game.overlayPath;
        dom.overlayUrl.value = buildOverlayURL(game.overlayPath);

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

        const firstCreate = !gameInstance;
        if (firstCreate) {
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
        } else {
            gameInstance.setConfig(game.config);
            dom.stageInfo.textContent = `Trong hũ: ${gameInstance.getCount?.() || 0}`;
        }

        applyConfigToUI(game.config);
        enableJarDragging();
        socket.emit('subscribe', 'preview');

        // RESTORE state from disk on first load (persist qua restart)
        // Server đã loadGameStateCache() từ disk vào memory rồi → fetch về và loadState
        if (firstCreate) {
            fetch(`/api/games/${currentGame.id}/state`)
                .then(r => r.json())
                .then(state => {
                    if (state && typeof state === 'object') {
                        try { gameInstance.loadState(state); } catch (e) { console.warn('loadState fail:', e); }
                    }
                })
                .catch(() => {});
        }

        startStateSync();

        // Đồng bộ render với nút 🙈 Ẩn preview: đang ẩn → tắt vẽ canvas trong app (giảm lag),
        // physics vẫn chạy nên OBS không đổi. Áp mỗi lần mở game phòng khi state đổi giữa các lần.
        try {
            const previewHidden = document.querySelector('#view-thuytinh .game-body')?.classList.contains('preview-hidden');
            gameInstance.setRenderActive?.(!previewHidden);
        } catch (e) {}
    }

    // ===== Định kỳ push state lên server (overlay nhận realtime) =====
    // Server sẽ tự broadcast state mỗi lần nhận POST → OBS luôn theo App, không cần refresh.
    let stateSyncTimer = null;
    let lastStateHash = '';
    function pushStateNow() {
        if (!gameInstance || currentGame?.id !== 'thuytinh') return Promise.resolve(false);
        const state = gameInstance.serializeState();
        const hash = JSON.stringify([
            state.totalDiamonds, state.totalGifts,
            (state.caughtList || []).length,
            (state.policeForce || []).length,
            (state.tippers || []).length,
            (state.bodies || []).length,   // include bodies count → state push khi quà thêm/bớt
            (state.giftHistory || [])[0]?.id || ''
        ]);
        if (hash === lastStateHash) return Promise.resolve(false);
        lastStateHash = hash;
        return fetch(`/api/games/${currentGame.id}/state`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).then(() => true).catch(() => false);
    }
    // Force sync (bỏ qua dedupe hash) — dùng khi clear/reset, OBS phải biết NGAY
    function forceSyncState() {
        lastStateHash = '';
        return pushStateNow();
    }
    async function syncStateForCmd() {
        if (!gameInstance || currentGame?.id !== 'thuytinh') return null;
        try {
            const state = gameInstance.serializeState();
            lastStateHash = '';
            await fetch(`/api/games/${currentGame.id}/state`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state)
            });
            return state;
        } catch (e) { return null; }
    }
    async function flushStateBeforeUpdate() {
        if (!gameInstance || currentGame?.id !== 'thuytinh') return true;
        try {
            gameInstance.captureGiftHistory?.('Trước cập nhật', true);
            const state = gameInstance.serializeState();
            const res = await fetch(`/api/games/${currentGame.id}/state?flush=1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state)
            });
            lastStateHash = JSON.stringify([
                state.totalDiamonds, state.totalGifts,
                (state.caughtList || []).length,
                (state.policeForce || []).length,
                (state.tippers || []).length,
                (state.bodies || []).length,
                (state.giftHistory || [])[0]?.id || ''
            ]);
            return res.ok;
        } catch (e) {
            console.warn('flushStateBeforeUpdate failed:', e);
            return false;
        }
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
        bindRange(dom.cfgGdrop, cfg.gift.dropHeight ?? 220, dom.cfgGdropV);
        // cfg-goal đã chuyển từ slider sang number input — set value trực tiếp
        if (dom.cfgGoal) dom.cfgGoal.value = cfg.goal?.target ?? 5000;
        if (dom.cfgGoalV) dom.cfgGoalV.textContent = cfg.goal?.target ?? 5000;
        bindRange(dom.cfgShakeAt, cfg.autoShakeAt ?? 200, dom.cfgShakeAtV);
        bindRange(dom.cfgGoalGap, cfg.goalBarGap ?? -1.2, dom.cfgGoalGapV);
        bindRange(dom.cfgWebmVol, cfg.webmFxVolume ?? 80, dom.cfgWebmVolV);
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
        if (dom.cfgBadgesLocked)  dom.cfgBadgesLocked.checked  = !!bdg.locked;
        if (dom.cfgBadgesLayout) dom.cfgBadgesLayout.value = bdg.layout || 'vertical';
        if (dom.cfgBadgesNamepos) dom.cfgBadgesNamepos.value = bdg.defaultNamePos || (bdg.layout === 'horizontal' ? 'top' : 'right');
        const bScale = bdg.scale ?? 1;
        if (dom.cfgBadgesScale) dom.cfgBadgesScale.value = String(bScale);
        if (dom.cfgBadgesScaleV) dom.cfgBadgesScaleV.textContent = bScale;
        const bIconScale = bdg.iconScale ?? 1;
        if (dom.cfgBadgesIconScale) dom.cfgBadgesIconScale.value = String(bIconScale);
        if (dom.cfgBadgesIconScaleV) dom.cfgBadgesIconScaleV.textContent = bIconScale;
        const bGap = bdg.gap ?? 0.8;
        if (dom.cfgBadgesGap) dom.cfgBadgesGap.value = String(bGap);
        if (dom.cfgBadgesGapV) dom.cfgBadgesGapV.textContent = bGap;
        const bNameScale = bdg.nameScale ?? 1;
        if (dom.cfgBadgesNameScale)  dom.cfgBadgesNameScale.value = String(bNameScale);
        if (dom.cfgBadgesNameScaleV) dom.cfgBadgesNameScaleV.textContent = bNameScale;
        // Auto-scroll
        const as = bdg.autoScroll || {};
        if (dom.cfgBadgesAutoscroll) dom.cfgBadgesAutoscroll.checked = !!as.enabled;
        const bVis = as.visibleCount ?? 5;
        if (dom.cfgBadgesVisible)  dom.cfgBadgesVisible.value = String(bVis);
        if (dom.cfgBadgesVisibleV) dom.cfgBadgesVisibleV.textContent = bVis;
        if (dom.cfgBadgesScrollDir) dom.cfgBadgesScrollDir.value = as.direction || 'up';
        const bSpeed = as.speed ?? 2;
        if (dom.cfgBadgesSpeed)  dom.cfgBadgesSpeed.value = String(bSpeed);
        if (dom.cfgBadgesSpeedV) dom.cfgBadgesSpeedV.textContent = bSpeed;
        // Lưu items + extras để gatherConfig giữ nguyên (chỉ edit qua modal per-gift)
        currentBadgeItems = JSON.parse(JSON.stringify(bdg.items || {}));
        currentBadgeExtras = Array.isArray(bdg.extras) ? JSON.parse(JSON.stringify(bdg.extras)) : [];
        renderBadgeExtrasList();
        if (dom.cfgShowCount) dom.cfgShowCount.checked = !!cfg.gift.showCount;
        if (dom.cfgJarVisible) dom.cfgJarVisible.checked = !!cfg.jarVisible;
        if (dom.cfgJarLocked) dom.cfgJarLocked.checked = !!cfg.jarLocked;
        const hist = cfg.history || {};
        const histInterval = document.getElementById('jar-history-interval');
        const histRetention = document.getElementById('jar-history-retention');
        if (histInterval) histInterval.value = String(hist.intervalSec ?? 10);
        if (histRetention) histRetention.value = String(hist.retentionHours ?? 6);
        const f = cfg.features || {};
        for (const key of FEATURE_KEYS) {
            const el = document.getElementById(FEATURE_INPUT[key]);
            if (el) el.checked = key === 'topHangers' && f[key] == null ? true : !!f[key];
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
                if (REMOVED_EFFECTS.has(eff)) continue;
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
        for (const id of Object.keys(currentBadgeItems || {})) cleanupUnassignedGiftState(id);
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
                dropHeight: Math.max(80, Math.min(700, parseInt(dom.cfgGdrop?.value, 10) || 220)),
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
            history: {
                intervalSec: Math.max(5, Math.min(300, parseInt(document.getElementById('jar-history-interval')?.value, 10) || 10)),
                retentionHours: Math.max(1, Math.min(24, parseInt(document.getElementById('jar-history-retention')?.value, 10) || 6))
            },
            features,
            goal: { target: Math.max(100, parseInt(dom.cfgGoal.value, 10) || 5000) },
            goalBarGap: parseFloat(dom.cfgGoalGap?.value ?? -1.2),
            webmFxVolume: Math.max(0, Math.min(100, parseInt(dom.cfgWebmVol?.value, 10) || 80)),
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
                locked: !!dom.cfgBadgesLocked?.checked,
                layout: dom.cfgBadgesLayout?.value || 'vertical',
                defaultNamePos: dom.cfgBadgesNamepos?.value || 'right',
                scale: parseFloat(dom.cfgBadgesScale?.value) || 1,
                iconScale: parseFloat(dom.cfgBadgesIconScale?.value) || 1,
                gap: isNaN(parseFloat(dom.cfgBadgesGap?.value)) ? 0.8 : parseFloat(dom.cfgBadgesGap.value),
                nameScale: parseFloat(dom.cfgBadgesNameScale?.value) || 1,
                autoScroll: {
                    enabled: !!dom.cfgBadgesAutoscroll?.checked,
                    visibleCount: parseInt(dom.cfgBadgesVisible?.value, 10) || 5,
                    direction: dom.cfgBadgesScrollDir?.value || 'up',
                    speed: parseFloat(dom.cfgBadgesSpeed?.value) || 2
                },
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
        if (dom.cfgGdropV) dom.cfgGdropV.textContent = cfg.gift.dropHeight ?? 220;
        if (dom.cfgGoalV) dom.cfgGoalV.textContent = cfg.goal.target;
        if (dom.cfgShakeAtV) dom.cfgShakeAtV.textContent = cfg.autoShakeAt;
        if (dom.cfgWebmVolV) dom.cfgWebmVolV.textContent = cfg.webmFxVolume ?? 80;
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
        if (dom.cfgBadgesGapV) dom.cfgBadgesGapV.textContent = cfg.badges?.gap ?? 0.8;
        if (dom.cfgBadgesNameScaleV) dom.cfgBadgesNameScaleV.textContent = cfg.badges?.nameScale ?? 1;
        if (dom.cfgBadgesVisibleV) dom.cfgBadgesVisibleV.textContent = cfg.badges?.autoScroll?.visibleCount ?? 5;
        if (dom.cfgBadgesSpeedV)   dom.cfgBadgesSpeedV.textContent   = cfg.badges?.autoScroll?.speed ?? 2;
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
        const countEl = document.getElementById('quick-test-count');
        if (!grid) return;
        grid.innerHTML = '';
        const entries = Object.entries(currentTriggers || {});
        if (countEl) countEl.textContent = String(entries.length);
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
                    body: JSON.stringify({ giftId, count: 1, nickname: 'HP Media' })
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
            // 🏷 Badge visibility toggle — bật/tắt badge từng quà trên overlay (không cần mở modal)
            const ids = ef.multi ? giftIdsForEffect(ef.key)
                                 : [Object.keys(currentTriggers).find(id => currentTriggers[id] === ef.key)].filter(Boolean);
            const badgeWrap = document.createElement('label');
            badgeWrap.className = 'trigger-badge-toggle';
            badgeWrap.title = ids.length
                ? `Hiện badge trên overlay (${ids.length} quà${ef.multi ? ' — tất cả' : ''})`
                : 'Chưa gán quà — không thể bật badge';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.disabled = ids.length === 0;
            // Default checked = true; chỉ uncheck nếu MỌI gift đều enabled === false
            cb.checked = ids.length === 0 ? false : ids.some(id => currentBadgeItems[id]?.enabled !== false);
            cb.addEventListener('change', () => {
                for (const id of ids) {
                    if (!currentBadgeItems[id]) currentBadgeItems[id] = {};
                    currentBadgeItems[id].enabled = cb.checked;
                }
                pushConfigUpdate(true);
            });
            badgeWrap.appendChild(cb);
            const gear = document.createElement('button');
            gear.className = 'gear'; gear.title = `Cài đặt ${ef.label}`; gear.textContent = '⚙';
            gear.addEventListener('click', () => openEffectModal(ef));
            row.appendChild(ico); row.appendChild(lbl); row.appendChild(badgeWrap); row.appendChild(prev); row.appendChild(gear);
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
        const item = currentBadgeItems[giftId] || { customLabel: '', namePos: '', enabled: true, borderStyle: 'none' };
        const enabledEl = document.getElementById('ef-badge-enabled');
        const labelEl = document.getElementById('ef-badge-label');
        const nameposEl = document.getElementById('ef-badge-namepos');
        const borderEl = document.getElementById('ef-badge-border');
        if (enabledEl) enabledEl.checked = item.enabled !== false;
        if (labelEl) labelEl.value = item.customLabel || '';
        if (labelEl) labelEl.placeholder = ef.label;
        // Default = '' (theo global). User chỉ chọn override khi muốn khác global.
        if (nameposEl) nameposEl.value = item.namePos || '';
        if (borderEl) borderEl.value = item.borderStyle || 'none';
    }
    // Lưu badge config từ modal vào currentBadgeItems — chỉ lưu namePos nếu KHÔNG rỗng
    function saveBadgeFieldsFromModal() {
        const giftId = editingDraft?.giftId;
        if (!giftId || editingEffect?.multi) return;
        const enabledEl = document.getElementById('ef-badge-enabled');
        const labelEl = document.getElementById('ef-badge-label');
        const nameposEl = document.getElementById('ef-badge-namepos');
        const borderEl = document.getElementById('ef-badge-border');
        const namePosValue = nameposEl?.value || '';
        const borderValue = borderEl?.value || 'none';
        const entry = {
            enabled: enabledEl ? !!enabledEl.checked : true,
            customLabel: (labelEl?.value || '').trim()
        };
        // Chỉ lưu namePos nếu user explicit chọn (KHÔNG là "Theo mặc định")
        if (namePosValue) entry.namePos = namePosValue;
        if (borderValue && borderValue !== 'none') entry.borderStyle = borderValue;
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
                    { key: 'durationSec', label: 'Thời gian', min: 3, max: 60, step: 1, default: 10, suffix: 's' }
                ];
            case 'spinJar':
                return [
                    { key: 'spinSpeed', label: 'Tốc độ xoay', min: 0.5, max: 4, step: 0.1, default: 1.4 },
                    { key: 'holdMs', label: 'Giữ trên cao', min: 500, max: 6000, step: 100, default: 1800, suffix: 'ms' },
                    { key: 'flyHeight', label: 'Độ cao bay', min: 15, max: 55, step: 1, default: 34, suffix: '%' },
                    { key: 'scatterForce', label: 'Lực văng quà', min: 0.4, max: 3, step: 0.1, default: 1.2 }
                ];
            case 'zigzagLuck':
                return [
                    { key: 'durationSec', label: 'Thời gian', min: 10, max: 180, step: 5, default: 60, suffix: 's' },
                    { key: 'rows', label: 'Số hàng lỗ', min: 5, max: 13, step: 1, default: 6 },
                    { key: 'cols', label: 'Số cột lỗ', min: 4, max: 11, step: 1, default: 9 },
                    { key: 'boardWidthPct', label: 'Rộng bàn', min: 55, max: 98, step: 1, default: 92, suffix: '%' },
                    { key: 'iconSize', label: 'Cỡ icon an toàn', min: 24, max: 64, step: 2, default: 42, suffix: 'px' },
                    { key: 'dropHeight', label: 'Độ cao thả', min: 40, max: 700, step: 20, default: 180, suffix: 'px' }
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
                    delete currentTriggers[k];
                    cleanupUnassignedGiftState(k);
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
        // Quà TEST/preview (bấm thử từ DANH SÁCH QUÀ) → KHÔNG ghi vào "🎁 Quà nhận từ LIVE".
        // Danh sách này chỉ dành cho quà THẬT từ viewer. (Quà test vẫn rơi vào hũ để test.)
        if (g.source === 'test') return;
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
        item.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            openGiftContextMenu({
                id: String(g.giftId),
                name: sheet?.name || g.giftName || 'Quà',
                image: sheet?.image || g.image || g.giftPicture,
                diamond: g.coinValue || sheet?.diamond || 0
            }, ev.clientX, ev.clientY);
        });
        dom.giftStreamEl.appendChild(item);
        if (dom.giftStreamEl.children.length > 80) dom.giftStreamEl.removeChild(dom.giftStreamEl.firstChild);
        dom.giftStreamEl.scrollTop = dom.giftStreamEl.scrollHeight;
    }

    // Toast "game đang TẮT" — throttle 2.5s để quà về dồn dập không spam.
    let _thuyDisabledToastTs = 0;
    function notifyThuyDisabled() {
        const now = Date.now();
        if (now - _thuyDisabledToastTs < 2500) return;
        _thuyDisabledToastTs = now;
        if (typeof toast === 'function') {
            toast('🫙 HŨ THỦY TINH ĐANG TẮT — bật ở 🎮 Thư viện Game để quà rơi vào hũ', 'warn', 3500);
        }
    }
    function spawnInGame(g) {
        if (!gameInstance) return;
        if (currentGame?.id === 'thuytinh' && currentGame.config?.enabled === false) {
            notifyThuyDisabled();   // thả tay từ danh sách quà khi game tắt
            return;
        }
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
        const giftId = String(gift?.id ?? gift?.giftId ?? '');
        if (!giftId) return;
        const assignedGiftId = findAssignedGiftId(gift);
        cmGift = { ...gift, id: assignedGiftId || giftId };
        const currentAction = currentTriggers[assignedGiftId] || '';
        const ef = EFFECTS.find(e => e.key === currentAction);
        cmCurrent.innerHTML = `<b>${escHtml(gift.name || 'Quà')}</b> · ID ${giftId} · ${gift.diamond || 0}⭐`
            + (ef ? `<br/>Đang gán: <span style="color:#ffd166">${ef.ico} ${ef.label}</span>` : '');
        if (cmClear) cmClear.hidden = !currentAction;
        cmList.innerHTML = '';
        for (const e of EFFECTS) {
            const btn = document.createElement('button');
            btn.dataset.effect = e.key;
            const assignedIds = giftIdsForEffect(e.key);
            const hasAnyGift = assignedIds.length > 0;
            const isCurrent = currentAction === e.key;
            const checkmark = hasAnyGift
                ? (e.multi ? `<span class="cm-check">✓×${assignedIds.length}</span>` : `<span class="cm-check">✓</span>`)
                : '';
            btn.innerHTML = `<span>${e.ico}</span> ${e.label}${checkmark}`;
            if (isCurrent) btn.classList.add('active');
            else if (hasAnyGift) btn.classList.add('assigned');
            btn.addEventListener('click', () => assignTrigger(giftId, e.key));
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
                    delete currentTriggers[k];
                    cleanupUnassignedGiftState(k);
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
        const giftId = String(cmGift.id);
        const giftName = cmGift.name;
        const removed = currentTriggers[giftId];
        delete currentTriggers[giftId];
        cleanupUnassignedGiftState(giftId);
        closeGiftContextMenu();
        renderTriggerList();
        renderGiftCatalog(dom.giftSearchInput.value);
        pushConfigUpdate(true);
        if (removed) flashTriggerToast(`✗ Đã xoá gán cho ${giftName}`);
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
        updateTranslateControls();
        if (connected) setTimeout(() => autoSyncTranslateRules(), 0);
    }
    function escAttrInline(s) { return String(s ?? '').replace(/[<>"]/g, ''); }

    // ============================================
    // 🔗 Lịch sử TikTok ID — autocomplete + remove
    // ============================================
    // Chia sẻ localStorage key với cửa sổ Khởi động nhanh. Chỉ ghi khi connect
    // THÀNH CÔNG (theo yêu cầu) — không lưu khi nhập sai/user offline/CREATOR lock.
    const TIKTOK_HISTORY_KEY = 'hp-tiktok-id-history';
    function loadTiktokHistory() {
        try {
            const raw = localStorage.getItem(TIKTOK_HISTORY_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
        } catch (_) { return []; }
    }
    function saveTiktokHistory(list) {
        try { localStorage.setItem(TIKTOK_HISTORY_KEY, JSON.stringify(list.slice(0, 20))); } catch (_) {}
    }
    function addTiktokHistory(id) {
        const clean = String(id || '').replace(/^@/, '').trim().toLowerCase();
        if (!clean) return;
        let list = loadTiktokHistory();
        list = list.filter(x => x.toLowerCase() !== clean);
        list.unshift(clean);
        saveTiktokHistory(list);
    }
    function removeTiktokHistory(id) {
        const clean = String(id || '').toLowerCase();
        saveTiktokHistory(loadTiktokHistory().filter(x => x.toLowerCase() !== clean));
    }
    function escRegexInline(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function renderTiktokSuggestions(query) {
        const sugg = document.getElementById('username-sugg');
        if (!sugg) return;
        // Không show dropdown khi đã connect (input đang khoá hiển thị tên đã connect)
        if (isLiveConnected) { sugg.classList.remove('show'); sugg.innerHTML = ''; return; }
        const list = loadTiktokHistory();
        const q = String(query || '').replace(/^@/, '').trim().toLowerCase();
        const matches = q ? list.filter(x => x.toLowerCase().includes(q)) : list;
        if (matches.length === 0) { sugg.classList.remove('show'); sugg.innerHTML = ''; return; }
        sugg.innerHTML = matches.map(id => {
            const safe = escAttrInline(id);
            const highlighted = q
                ? safe.replace(new RegExp('(' + escRegexInline(q) + ')', 'gi'), '<b>$1</b>')
                : safe;
            return `<div class="user-sugg-item" data-id="${safe}">
                <span class="sugg-name">@${highlighted}</span>
                <button class="sugg-del" data-act="del" data-id="${safe}" title="Xóa khỏi lịch sử">×</button>
            </div>`;
        }).join('');
        sugg.classList.add('show');
    }
    function hideTiktokSuggestions() {
        const sugg = document.getElementById('username-sugg');
        if (sugg) sugg.classList.remove('show');
    }
    (() => {
        const sugg = document.getElementById('username-sugg');
        if (!sugg) return;
        dom.usernameInput.addEventListener('focus', () => renderTiktokSuggestions(dom.usernameInput.value));
        dom.usernameInput.addEventListener('input', () => renderTiktokSuggestions(dom.usernameInput.value));
        // Click ngoài conn-row → ẩn
        document.addEventListener('click', (e) => {
            const row = document.getElementById('conn-row');
            if (row && !row.contains(e.target)) hideTiktokSuggestions();
        });
        sugg.addEventListener('click', (e) => {
            const delBtn = e.target.closest('[data-act="del"]');
            if (delBtn) {
                e.stopPropagation();
                removeTiktokHistory(delBtn.dataset.id || '');
                renderTiktokSuggestions(dom.usernameInput.value);
                return;
            }
            const item = e.target.closest('.user-sugg-item');
            if (item) {
                dom.usernameInput.value = item.dataset.id || '';
                hideTiktokSuggestions();
                dom.usernameInput.focus();
            }
        });
    })();

    // Auto-reset khi đổi ID — sau khi connect thành công, so sánh ID mới với phiên
    // trước. Khác → popup confirm reset toàn bộ game state (totals/leaderboard/bàn cờ/
    // timer/quest progress) để bắt đầu phiên với streamer mới. Giữ lại comments/gift
    // stream/unknown gifts vì là dữ liệu reference, không phải session state.
    const LAST_SESSION_USER_KEY = 'hp-last-session-user';
    async function maybeResetOnIdChange(newUsername) {
        const clean = String(newUsername || '').replace(/^@/, '').trim().toLowerCase();
        if (!clean) return;
        let prev = '';
        try { prev = String(localStorage.getItem(LAST_SESSION_USER_KEY) || '').toLowerCase(); } catch (_) {}
        // Lưu username phiên hiện tại — kể cả khi không trigger reset (lần đầu cài / cùng ID)
        try { localStorage.setItem(LAST_SESSION_USER_KEY, clean); } catch (_) {}
        // Lần đầu (chưa có prev) hoặc cùng ID → bỏ qua
        if (!prev || prev === clean) return;
        const ok = await hpConfirm({
            icon: '🔄',
            title: 'Phát hiện đổi TikTok ID',
            body: `Bạn vừa kết nối <b>@${escHtml(clean)}</b> — khác với phiên trước <b>@${escHtml(prev)}</b>.<br><br>Reset toàn bộ <b>tiến trình game</b> (hũ thủy tinh, caro, vote, level quest, timer) để bắt đầu phiên mới với streamer này?<br><span style="color:#8b93a8">Lịch sử bình luận / quà / unknown gifts sẽ được giữ lại.</span>`,
            okLabel: 'Reset & bắt đầu mới',
            cancelLabel: 'Giữ tiến trình cũ',
            tone: 'warn'
        });
        if (!ok) return;
        // Dùng lại handleQuickLaunchCmd để reset từng game — đảm bảo logic đúng theo
        // game-specific implementation (mỗi game có cách reset riêng).
        const games = ['thuytinh', 'caro', 'votecomment', 'level-quest', 'timer'];
        for (const gid of games) {
            try { await handleQuickLaunchCmd({ gameId: gid, action: 'reset' }); }
            catch (e) { console.warn(`[id-change-reset] ${gid} reset fail:`, e); }
        }
        appendSystem(`🔄 Đã reset tiến trình game cho phiên @${clean}`);
        flashTriggerToast?.(`🔄 Reset cho phiên mới @${clean}`);
    }

    async function doConnect() {
        const username = (dom.usernameInput.value || '').trim().replace(/^@/, '');
        if (!username) { dom.usernameInput.focus(); return; }
        hideTiktokSuggestions();
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
            // Chỉ lưu lịch sử khi connect THÀNH CÔNG (yêu cầu user)
            addTiktokHistory(data.username || username);
            // Phát hiện đổi ID phiên — popup confirm reset toàn bộ game state để bắt đầu phiên mới
            await maybeResetOnIdChange(data.username || username);
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
            if (data.ok) {
                // iconsRefreshed = số quà thiếu image được khôi phục từ TikTok availableGifts
                // (chỉ chạy được khi đang connect LIVE — sheet không có ảnh thì cần phòng LIVE tra)
                const parts = [`Đã tải ${data.count} quà`];
                if (data.iconsRefreshed > 0) parts.push(`khôi phục ${data.iconsRefreshed} icon`);
                appendSystem(parts.join(' · '));
            } else {
                appendSystem(`Lỗi: ${data.error}`);
            }
        } finally {
            dom.btnReloadGifts.disabled = false;
        }
    });

    // Old license save handler đã chuyển sang gate flow (xem phần License Gate ở cuối file)

    dom.btnCopyOverlay.addEventListener('click', async () => {
        const url = dom.overlayUrl?.value || buildOverlayURL('/overlay/thuytinh');
        const ok = await copyText(url);
        const t = dom.btnCopyOverlay.textContent;
        dom.btnCopyOverlay.textContent = ok ? '✓ Đã copy' : 'Copy lỗi';
        if (!ok) flashTriggerToast('Không copy tự động được. Link: ' + url);
        setTimeout(() => dom.btnCopyOverlay.textContent = t, 1500);
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
    ['cfgGravity', 'cfgBounce', 'cfgFriction', 'cfgJarH', 'cfgGmin', 'cfgGmax', 'cfgGdrop', 'cfgGoal', 'cfgGoalGap', 'cfgWebmVol', 'cfgShakeAt', 'cfgThiefMiss', 'cfgPoliceRate', 'cfgPoliceBan', 'cfgScaleLb', 'cfgScaleCaught', 'cfgScaleThief', 'cfgScalePolice', 'cfgScaleOsin', 'cfgScaleUfo']
        .forEach(k => dom[k]?.addEventListener('input', pushConfigUpdate));
    dom.cfgPoliceName?.addEventListener('input', pushConfigUpdate);
    dom.cfgShowCount?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarVisible?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarLocked?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarAccessory?.addEventListener('change', pushConfigUpdate);
    dom.cfgJarTheme?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesEnabled?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesLocked?.addEventListener('change', pushConfigUpdate);
    // Preset cỡ card / icon / gap / chữ đẹp cho từng combo layout — auto-fill khi đổi layout
    const BADGE_PRESETS = {
        vertical:   { scale: 1.25, iconScale: 1.6,  gap: 2.5, nameScale: 1.0 },
        horizontal: { scale: 1.2,  iconScale: 1.75, gap: 0.8, nameScale: 1.0 }
    };
    dom.cfgBadgesLayout?.addEventListener('change', () => {
        // Khi đổi layout (dọc/ngang) — clear panelPositions.badges để pos-* dropdown re-take effect
        if (currentGame) {
            const cfg = gameInstance?.getConfig() || {};
            if (cfg.panelPositions?.badges) {
                cfg.panelPositions.badges = null;
            }
        }
        // Auto-apply preset cỡ/icon/gap cho layout vừa chọn
        const preset = BADGE_PRESETS[dom.cfgBadgesLayout.value];
        if (preset) {
            if (dom.cfgBadgesScale)     dom.cfgBadgesScale.value     = String(preset.scale);
            if (dom.cfgBadgesIconScale) dom.cfgBadgesIconScale.value = String(preset.iconScale);
            if (dom.cfgBadgesGap)       dom.cfgBadgesGap.value       = String(preset.gap);
            if (dom.cfgBadgesNameScale) dom.cfgBadgesNameScale.value = String(preset.nameScale);
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
    dom.cfgBadgesGap?.addEventListener('input', pushConfigUpdate);
    dom.cfgBadgesNameScale?.addEventListener('input', pushConfigUpdate);
    dom.cfgBadgesAutoscroll?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesVisible?.addEventListener('input', pushConfigUpdate);
    dom.cfgBadgesScrollDir?.addEventListener('change', pushConfigUpdate);
    dom.cfgBadgesSpeed?.addEventListener('input', pushConfigUpdate);

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
        const ebmBorder = document.getElementById('ebm-border');
        if (ebmBorder) ebmBorder.value = 'none';
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
        const borderValue = document.getElementById('ebm-border')?.value || 'none';
        if (!id || !name) return flashTriggerToast('⚠ Cần Gift ID và Tên quà (chọn từ danh sách hoặc nhập tay)');
        // Avoid duplicate by id
        const existsIdx = currentBadgeExtras.findIndex(e => String(e.id) === id);
        const entry = { id, name, image, customLabel, enabled: true };
        // Chỉ lưu namePos nếu user explicit chọn (không là 'Theo mặc định')
        if (namePosValue) entry.namePos = namePosValue;
        if (borderValue && borderValue !== 'none') entry.borderStyle = borderValue;
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
    // 🔊 Mở SoundFX — Electron bắt /soundfx → cửa sổ nổi; trình duyệt → tab mới
    document.getElementById('btn-open-soundfx')?.addEventListener('click', () => {
        window.open('/soundfx', '_blank');
    });

    // ⚙ Cài đặt: handler đã có ở dưới (line ~4160) — openSettingsPopup() mở #settings-popup
    // có sẵn (BẢN QUYỀN / PHIÊN BẢN / DANH SÁCH QUÀ). Không cần custom modal riêng.

    // Feature toggles
    for (const key of FEATURE_KEYS) {
        const el = document.getElementById(FEATURE_INPUT[key]);
        el?.addEventListener('change', pushConfigUpdate);
    }
    // Action buttons — gọi local + đồng bộ overlay OBS
    const STATE_SYNC_BEFORE_CMD = new Set([
        'pourOut', 'kickJar', 'throwJar', 'spinJar', 'stealJar',
        'crackJar', 'tornado', 'geyser', 'magnet', 'gravflip', 'shake'
    ]);
    async function sendCmd(cmd, payload) {
        if (!currentGame) return;
        let finalPayload = payload || null;
        if (currentGame.id === 'thuytinh' && STATE_SYNC_BEFORE_CMD.has(cmd)) {
            const state = await syncStateForCmd();
            if (state) finalPayload = { ...(payload || {}), _state: state };
        }
        return fetch(`/api/games/${currentGame.id}/cmd`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd, payload: finalPayload })
        }).catch(() => {});
    }
    async function resetSessionAll() {
        // Phiên mới: reset stats + clear bodies trong hũ + đồng bộ OBS qua 2 cmd
        gameInstance?.resetSession();
        gameInstance?.clearAll();
        await sendCmd('resetSession');
        await sendCmd('clear');
        await forceSyncState();
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
            ? { name: pick.nickname || pick.uniqueId || 'HP Media', avatar: pick.avatar, uid: pick.uid }
            : { name: 'HP Media' };
        // triggerThief mutate thief.mode (rope/runner) — sendCmd sau đó sẽ gồm mode cho OBS
        gameInstance.triggerThief(thief);
        sendCmd('thief', { thieves: [thief] });
    });
    dom.btnFxFirework?.addEventListener('click', () => { gameInstance?.fxFireworks(); sendCmd('fireworks'); });
    dom.btnFxTornado?.addEventListener('click', () => { gameInstance?.fxTornado(); sendCmd('tornado'); });
    dom.btnFxWind?.addEventListener('click', () => { gameInstance?.fxWind(); sendCmd('wind'); });
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

    const jarHistoryModal = document.getElementById('jar-history-modal');
    const jarHistoryList = document.getElementById('jar-history-list');
    function formatHistoryTime(ts) {
        const d = new Date(ts || Date.now());
        return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function renderJarHistory() {
        if (!jarHistoryList) return;
        const list = gameInstance?.getGiftHistory?.() || [];
        if (!list.length) {
            jarHistoryList.innerHTML = '<div class="jar-history-empty">Chưa có mốc lịch sử. Bấm “Lưu mốc ngay” hoặc chờ app tự lưu khi hũ có quà.</div>';
            return;
        }
        jarHistoryList.innerHTML = list.map(s => {
            const chips = (s.summary || []).slice(0, 5).map(g => `<span class="jar-history-chip" title="${escAttrInline(g.name || 'Quà')}">${escHtml(g.name || 'Quà')} ×${g.count}</span>`).join('');
            return `<div class="jar-history-row" data-id="${escAttrInline(s.id)}">
                <div class="jar-history-main">
                    <div class="jar-history-title">${escHtml(s.label || 'Mốc lưu')} · ${formatHistoryTime(s.ts)}</div>
                    <div class="jar-history-meta">${s.count || 0} quà · ${s.totalDiamonds || 0} KC · ${s.totalGifts || 0} lượt quà</div>
                    <div class="jar-history-summary">${chips || '<span class="jar-history-chip">Không có quà</span>'}</div>
                </div>
                <div class="jar-history-actions">
                    <button class="ghost mini" data-action="restore">♻️ Khôi phục</button>
                </div>
            </div>`;
        }).join('');
    }
    function openJarHistoryModal() {
        if (!jarHistoryModal) return;
        renderJarHistory();
        jarHistoryModal.hidden = false;
    }
    function closeJarHistoryModal() { if (jarHistoryModal) jarHistoryModal.hidden = true; }
    document.getElementById('btn-jar-history')?.addEventListener('click', openJarHistoryModal);
    document.getElementById('jar-history-close')?.addEventListener('click', closeJarHistoryModal);
    document.getElementById('jar-history-cancel')?.addEventListener('click', closeJarHistoryModal);
    document.getElementById('jar-history-save-now')?.addEventListener('click', () => {
        if (!gameInstance?.captureGiftHistory) return;
        gameInstance.captureGiftHistory('Lưu thủ công', true);
        forceSyncState();
        renderJarHistory();
    });
    document.getElementById('jar-history-interval')?.addEventListener('change', () => pushConfigUpdate(true));
    document.getElementById('jar-history-retention')?.addEventListener('change', () => {
        pushConfigUpdate(true);
        forceSyncState();
        renderJarHistory();
    });
    jarHistoryList?.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-action="restore"]');
        if (!btn || !gameInstance?.restoreGiftSnapshot) return;
        const row = btn.closest('.jar-history-row');
        const id = row?.dataset?.id;
        if (!id) return;
        const ok = await hpConfirm({
            icon: '♻️',
            title: 'Khôi phục lịch sử hũ?',
            body: 'Hũ hiện tại sẽ được thay bằng mốc đã chọn, quà sẽ rơi lại vào hũ với hiệu ứng khôi phục.',
            okLabel: 'Khôi phục', cancelLabel: 'Hủy'
        });
        if (!ok) return;
        gameInstance.restoreGiftSnapshot(id, true);
        forceSyncState();
        renderJarHistory();
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
            if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
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
    window.hpCopyText = copyText;
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
        // Sync config trong games[] để quick-launch + sidebar phản ánh đúng state
        const targetGame = games.find(x => x.id === gameId);
        if (targetGame) {
            targetGame.config = config;
            updateQuickLaunchCardState(gameId);
        }
        if (!gameInstance || gameId !== currentGame?.id) return;
        currentGame.config = config;
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
        // Cũng spawn vào preview thực (overlay nhận qua room 'overlay').
        // Gate: nếu game hiện tại đang TẮT trong Thư viện → KHÔNG spawn (tránh quà rơi vào hũ
        // khi user đã tắt). Áp dụng cho mọi game có field enabled.
        if (currentGame && currentGame.config?.enabled !== false) {
            spawnInGame(g);
        } else if (currentGame?.id === 'thuytinh') {
            // Quà THẬT/TEST tới khi Hũ đang TẮT → quà bị chặn ở đây (trước spawnInGame) nên
            // toast trong spawnInGame không chạy. Báo trực tiếp tại điểm chặn này.
            notifyThuyDisabled();
        }
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
            translate: 'translate-popup',
            creatorCaption: 'creator-caption-popup',
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

    // ===== Live Translate MVP =====
    const translateFab = document.getElementById('translate-fab');
    const translateBadge = document.getElementById('translate-badge');
    const translatePopup = document.getElementById('translate-popup');
    const translateClose = document.getElementById('translate-close');
    const creatorCaptionFab = document.getElementById('creator-caption-fab');
    const creatorCaptionPopup = document.getElementById('creator-caption-popup');
    const creatorCaptionClose = document.getElementById('creator-caption-close');
    const ltEnabled = document.getElementById('lt-enabled');
    const ltTts = document.getElementById('lt-tts');
    const ltIgnoreIcons = document.getElementById('lt-ignore-icons');
    const ltCleanUnreadable = document.getElementById('lt-clean-unreadable');
    const ltAiFilter = document.getElementById('lt-ai-filter');
    const ltSource = document.getElementById('lt-source');
    const ltExcludedSource = document.getElementById('lt-excluded-source');
    const ltTarget = document.getElementById('lt-target');
    const ltVoice = document.getElementById('lt-voice');
    const ltTtsSource = document.getElementById('lt-tts-source');
    const ltTtsPreset = document.getElementById('lt-tts-preset');
    const ltReadMode = document.getElementById('lt-read-mode');
    const ltPriority = document.getElementById('lt-priority');
    const ltCooldown = document.getElementById('lt-cooldown');
    const ltVolume = document.getElementById('lt-volume');
    const ltVolumeV = document.getElementById('lt-volume-v');
    const ltRate = document.getElementById('lt-rate');
    const ltRateV = document.getElementById('lt-rate-v');
    const ltGlossary = document.getElementById('lt-glossary');
    const ltForbidden = document.getElementById('lt-forbidden');
    const ltOverlayUrl = document.getElementById('lt-overlay-url');
    const ltStatus = document.getElementById('lt-status');
    const ltSheetStatus = document.getElementById('lt-sheet-status');
    const btnTranslateToggle = document.getElementById('btn-translate-toggle');
    const btnTranslateSyncSheet = document.getElementById('btn-translate-sync-sheet');
    const btnTranslateTestVoice = document.getElementById('btn-translate-test-voice');
    const btnTranslateSave = document.getElementById('btn-translate-save');
    const btnTranslateCopy = document.getElementById('btn-translate-copy');
    const btnCopyDashboard = document.getElementById('btn-copy-dashboard');
    const btnBackupExport = document.getElementById('btn-backup-export');
    const btnBackupImport = document.getElementById('btn-backup-import');
    const backupImportFile = document.getElementById('backup-import-file');
    const ccEnabled = document.getElementById('cc-enabled');
    const ccOriginal = document.getElementById('cc-original');
    const ccSource = document.getElementById('cc-source');
    const ccWhisperExe = document.getElementById('cc-whisper-exe');
    const ccWhisperModel = document.getElementById('cc-whisper-model');
    const ccMic = document.getElementById('cc-mic');
    const btnCcMicTest = document.getElementById('btn-cc-mic-test');
    const ccWave = document.getElementById('cc-wave');
    const ccTranscript = document.getElementById('cc-transcript');
    const ccSilence = document.getElementById('cc-silence');
    const ccSilenceV = document.getElementById('cc-silence-v');
    const ccAutoTargets = document.getElementById('cc-auto-targets');
    const ccAutoTargetTimeout = document.getElementById('cc-auto-target-timeout');
    const ccTargets = Array.from(document.querySelectorAll('input[name="cc-targets"]'));
    const btnCcToggle = document.getElementById('btn-cc-toggle');
    const btnCcCopy = document.getElementById('btn-cc-copy');
    const btnCcTest = document.getElementById('btn-cc-test');
    const ccStatus = document.getElementById('cc-status');
    let unreadTranslations = 0;
    let liveTranslateConfig = null;
    let liveTranslateAutoSaving = false;
    let creatorCaptionConfig = null;
    let creatorCaptionRecognition = null;
    let creatorCaptionListening = false;
    let creatorCaptionRestarting = false;
    let creatorCaptionBuffer = '';
    let creatorCaptionSilenceTimer = null;
    let creatorCaptionMicStream = null;
    let creatorCaptionAudioCtx = null;
    let creatorCaptionAnalyser = null;
    let creatorCaptionWaveRaf = 0;
    let creatorCaptionLastResultAt = 0;
    let creatorCaptionNoResultTimer = null;
    let creatorCaptionRecorder = null;
    let creatorCaptionRecordTimer = null;
    let creatorCaptionChunkPeak = 0;
    let creatorCaptionChunkLevelSum = 0;
    let creatorCaptionChunkLevelCount = 0;
    let creatorCaptionChunkActiveFrames = 0;
    let creatorCaptionTranscribing = false;
    let creatorCaptionLastTranscribeAt = 0;
    let creatorCaptionRateLimitedUntil = 0;
    let creatorCaptionLastSkipNoticeAt = 0;
    const creatorCaptionAutoTargetTimers = new Map();
    const creatorCaptionAutoTargets = new Set();
    const missingCreatorCaptionTargetLangs = new Set();
    let translateRulesAutoSynced = false;

    function setTranslateStatus(text, cls) {
        if (!ltStatus) return;
        ltStatus.textContent = text || '';
        ltStatus.className = 'translate-status' + (cls ? ' ' + cls : '');
    }
    function setCreatorCaptionStatus(text, cls) {
        if (!ccStatus) return;
        ccStatus.textContent = text || '';
        ccStatus.className = 'translate-status' + (cls ? ' ' + cls : '');
    }
    function setCreatorCaptionTranscript(text, cls) {
        if (!ccTranscript) return;
        ccTranscript.textContent = text || 'Bấm BẮT ĐẦU NGHE rồi nói. Câu nghe được sẽ hiện ở đây trước khi dịch.';
        ccTranscript.className = 'cc-transcript' + (cls ? ' ' + cls : '');
    }
    function updateCreatorCaptionProviderUi() {
        document.querySelectorAll('.cc-local-row').forEach(row => { row.hidden = true; });
    }
    function scheduleCreatorCaptionNoResultCheck(stage) {
        if (creatorCaptionNoResultTimer) clearTimeout(creatorCaptionNoResultTimer);
        const startAt = Date.now();
        creatorCaptionNoResultTimer = setTimeout(() => {
            if (!creatorCaptionListening) return;
            if (creatorCaptionLastResultAt >= startAt) return;
            setCreatorCaptionTranscript(
                `${stage || 'Có tín hiệu âm thanh'} nhưng chưa chuyển được thành chữ.\n` +
                'Nếu sóng âm vẫn nhảy, micro OK; lỗi nằm ở engine Speech-to-Text của Chromium/Electron hoặc ngôn ngữ nhận giọng.',
                'err'
            );
            setCreatorCaptionStatus('Micro có tín hiệu nhưng chưa nhận được chữ. Thử nói rõ hơn hoặc đổi Creator nói sang đúng ngôn ngữ.', 'err');
        }, 8000);
    }
    function setTranslateUnread(n) {
        unreadTranslations = Math.max(0, n);
        if (!translateBadge) return;
        if (unreadTranslations <= 0) {
            translateBadge.hidden = true;
            translateBadge.textContent = '0';
        } else {
            translateBadge.hidden = false;
            translateBadge.textContent = unreadTranslations > 99 ? '99+' : String(unreadTranslations);
        }
    }
    function updateTranslateControls() {
        const enabled = liveTranslateConfig?.enabled === true;
        if (btnTranslateToggle) {
            btnTranslateToggle.disabled = !isLiveConnected;
            btnTranslateToggle.textContent = enabled ? 'DỪNG' : 'BẮT ĐẦU';
            btnTranslateToggle.classList.toggle('primary', !enabled);
            btnTranslateToggle.classList.toggle('ghost', enabled);
            btnTranslateToggle.classList.toggle('translate-running', enabled && isLiveConnected);
        }
        if (!isLiveConnected && translatePopup && !translatePopup.hidden) {
            setTranslateStatus(enabled ? 'Đã bật sẵn, sẽ tự dịch/đọc sau khi kết nối LIVE' : 'Cần kết nối LIVE thành công trước khi bắt đầu dịch/đọc', enabled ? 'ok' : 'err');
        }
    }
    function updateTranslateSheetStatus(meta) {
        if (!ltSheetStatus) return;
        const m = meta || liveTranslateConfig?.sheetRules || {};
        if (m.error) {
            ltSheetStatus.className = 'err';
            ltSheetStatus.textContent = 'Quy tắc lỗi: ' + m.error;
            return;
        }
        const loaded = m.loadedAt ? new Date(m.loadedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'chưa tải';
        ltSheetStatus.className = m.loadedAt ? 'ok' : '';
        ltSheetStatus.textContent = `Quy tắc: ${m.forbiddenCount || 0} cấm, ${m.glossaryCount || 0} thay thế · ${loaded}`;
    }
    function isTranslatePopupOpen() { return translatePopup && !translatePopup.hidden; }
    function isCreatorCaptionPopupOpen() { return creatorCaptionPopup && !creatorCaptionPopup.hidden; }
    function applyLiveTranslateConfig(cfg) {
        liveTranslateConfig = cfg || {};
        if (ltEnabled) ltEnabled.checked = liveTranslateConfig.enabled === true;
        if (ltTts) ltTts.checked = !!liveTranslateConfig.ttsEnabled;
        if (ltIgnoreIcons) ltIgnoreIcons.checked = liveTranslateConfig.ignoreIcons !== false;
        if (ltCleanUnreadable) ltCleanUnreadable.checked = liveTranslateConfig.cleanUnreadable !== false;
        if (ltAiFilter) ltAiFilter.checked = liveTranslateConfig.aiFilterEnabled !== false;
        if (ltSource) ltSource.value = liveTranslateConfig.sourceLang || 'auto';
        if (ltExcludedSource) ltExcludedSource.value = liveTranslateConfig.excludedSourceLang || '';
        if (ltTarget) ltTarget.value = liveTranslateConfig.targetLang || 'vi';
        if (ltVoice) ltVoice.value = liveTranslateConfig.ttsVoice || 'auto';
        if (ltTtsSource) ltTtsSource.value = ['browser', 'remote'].includes(liveTranslateConfig.ttsSource) ? liveTranslateConfig.ttsSource : 'browser';
        if (ltTtsPreset) ltTtsPreset.value = liveTranslateConfig.ttsPreset || 'auto';
        if (ltReadMode) ltReadMode.value = liveTranslateConfig.ttsReadMode || (liveTranslateConfig.readUsername === false ? 'commentOnly' : 'nameAndComment');
        if (ltPriority) ltPriority.value = liveTranslateConfig.ttsPriority || 'all';
        if (ltCooldown) ltCooldown.value = String(liveTranslateConfig.ttsCooldownSeconds == null ? 4 : liveTranslateConfig.ttsCooldownSeconds);
        const vol = liveTranslateConfig.ttsVolume == null ? 85 : liveTranslateConfig.ttsVolume;
        if (ltVolume) ltVolume.value = String(vol);
        if (ltVolumeV) ltVolumeV.textContent = vol + '%';
        const rate = liveTranslateConfig.ttsRate == null ? 1 : Number(liveTranslateConfig.ttsRate);
        if (ltRate) ltRate.value = String(rate);
        if (ltRateV) ltRateV.textContent = rate.toFixed(1) + 'x';
        if (ltGlossary) ltGlossary.value = (liveTranslateConfig.glossary || []).join('\n');
        if (ltForbidden) ltForbidden.value = (liveTranslateConfig.forbiddenWords || []).join('\n');
        updateTranslateSheetStatus(liveTranslateConfig.sheetRules);
        updateTranslateControls();
    }
    async function loadLiveTranslateConfig() {
        try { applyLiveTranslateConfig(await (await fetch('/api/live-translate/config')).json()); }
        catch (e) { setTranslateStatus('Không tải được cấu hình dịch', 'err'); }
    }
    async function ensureLiveTranslateAutoRunning() {
        if (!isLiveConnected || liveTranslateAutoSaving) return;
        if (!liveTranslateConfig) await loadLiveTranslateConfig();
        if (liveTranslateConfig?.enabled === true && liveTranslateConfig?.ttsEnabled === true) return;
        liveTranslateAutoSaving = true;
        try {
            if (ltEnabled) ltEnabled.checked = true;
            if (ltTts) ltTts.checked = true;
            await saveLiveTranslateConfig({ silent: true });
            setTranslateStatus('Dịch bình luận đã tự bật theo LIVE', 'ok');
        } finally {
            liveTranslateAutoSaving = false;
        }
    }
    async function saveLiveTranslateConfig(options = {}) {
        const body = {
            enabled: !!ltEnabled?.checked,
            ttsEnabled: !!ltTts?.checked,
            ignoreIcons: ltIgnoreIcons ? !!ltIgnoreIcons.checked : true,
            cleanUnreadable: ltCleanUnreadable ? !!ltCleanUnreadable.checked : true,
            aiFilterEnabled: ltAiFilter ? !!ltAiFilter.checked : true,
            readUsername: (ltReadMode?.value || 'nameAndComment') === 'nameAndComment',
            sourceLang: ltSource?.value || 'auto',
            excludedSourceLang: ltExcludedSource?.value || '',
            targetLang: ltTarget?.value || 'vi',
            ttsVoice: ltVoice?.value || 'auto',
            ttsSource: ['browser', 'remote'].includes(ltTtsSource?.value) ? ltTtsSource.value : 'browser',
            ttsPreset: ltTtsPreset?.value || 'auto',
            ttsReadMode: ltReadMode?.value || 'nameAndComment',
            ttsPriority: ltPriority?.value || 'all',
            ttsCooldownSeconds: parseInt(ltCooldown?.value || '4', 10) || 0,
            ttsVolume: Number.isFinite(parseInt(ltVolume?.value || '', 10)) ? parseInt(ltVolume.value, 10) : 85,
            ttsRate: Number.isFinite(parseFloat(ltRate?.value || '')) ? parseFloat(ltRate.value) : 1,
            glossary: (ltGlossary?.value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean),
            forbiddenWords: (ltForbidden?.value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)
        };
        if (!options.silent) setTranslateStatus('Đang lưu...', '');
        try {
            const res = await fetch('/api/live-translate/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'save_failed');
            applyLiveTranslateConfig(json.config);
            if (!options.silent) setTranslateStatus('Đã lưu cấu hình dịch', 'ok');
        } catch (e) { setTranslateStatus('Lưu thất bại: ' + e.message, 'err'); }
    }
    async function setLiveTranslateRunning(running) {
        if (running && !isLiveConnected) {
            setTranslateStatus('Hãy kết nối LIVE thành công trước', 'err');
            updateTranslateControls();
            return;
        }
        const rulesSynced = running ? await syncTranslateSheetRules({ finalStatus: false }) : false;
        if (ltEnabled) ltEnabled.checked = !!running;
        await saveLiveTranslateConfig();
        setTranslateStatus(running ? (rulesSynced ? 'Đã đồng bộ quy tắc và bắt đầu dịch/đọc bình luận LIVE' : 'Đã bắt đầu dịch/đọc, nhưng đồng bộ quy tắc có lỗi') : 'Đã dừng dịch/đọc', running ? (rulesSynced ? 'ok' : 'err') : '');
        updateTranslateControls();
    }
    function openTranslatePopup() {
        closeAllPopupsExcept('translate');
        if (translatePopup) translatePopup.hidden = false;
        setTranslateUnread(0);
        loadLiveTranslateConfig();
    }
    function closeTranslatePopup() { if (translatePopup) translatePopup.hidden = true; }
    function openCreatorCaptionPopup() {
        closeAllPopupsExcept('creatorCaption');
        if (creatorCaptionPopup) creatorCaptionPopup.hidden = false;
        loadCreatorCaptionConfig();
    }
    function closeCreatorCaptionPopup() { if (creatorCaptionPopup) creatorCaptionPopup.hidden = true; }
    function refreshTranslateOverlayUrl() { if (ltOverlayUrl) { ltOverlayUrl._baseOverlayPath = '/overlay/translate'; ltOverlayUrl.value = buildOverlayURL('/overlay/translate'); } }
    async function copyTranslateOverlayUrl() {
        refreshTranslateOverlayUrl();
        const url = ltOverlayUrl?.value || buildOverlayURL('/overlay/translate');
        const ok = await copyText(url);
        if (ok) setTranslateStatus('Đã copy link OBS dịch', 'ok');
        else setTranslateStatus('Không copy tự động được. Link: ' + url, 'err');
    }
    async function copyDashboardOverlayUrl() {
        const url = buildOverlayURL('/overlay/dashboard');
        const ok = await copyText(url);
        setTranslateStatus(ok ? 'Đã copy link OBS dashboard' : 'Không copy tự động được. Link: ' + url, ok ? 'ok' : 'err');
    }
    async function exportBackupConfig() {
        try {
            const data = await (await fetch('/api/backup/export')).json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `hp-action-live-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            a.remove();
            setTranslateStatus('Đã export backup cấu hình', 'ok');
        } catch (e) { setTranslateStatus('Export backup lỗi: ' + e.message, 'err'); }
    }
    async function importBackupConfig(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const payload = JSON.parse(text);
            const res = await fetch('/api/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'import_failed');
            await loadLiveTranslateConfig();
            await loadCreatorCaptionConfig();
            setTranslateStatus('Đã import backup cấu hình', 'ok');
        } catch (e) { setTranslateStatus('Import backup lỗi: ' + e.message, 'err'); }
        finally { if (backupImportFile) backupImportFile.value = ''; }
    }
    async function syncTranslateSheetRules(options = {}) {
        const showFinalStatus = options.finalStatus !== false;
        if (btnTranslateSyncSheet) btnTranslateSyncSheet.disabled = true;
        setTranslateStatus('Đang đồng bộ quy tắc...', '');
        try {
            const json = await (await fetch('/api/live-translate/rules/reload', { method: 'POST' })).json();
            updateTranslateSheetStatus(json);
            if (showFinalStatus) setTranslateStatus(json.ok ? 'Đã đồng bộ quy tắc' : 'Đồng bộ quy tắc có lỗi', json.ok ? 'ok' : 'err');
            return !!json.ok;
        } catch (e) { setTranslateStatus('Không đồng bộ được quy tắc: ' + e.message, 'err'); }
        finally { if (btnTranslateSyncSheet) btnTranslateSyncSheet.disabled = false; }
        return false;
    }
    async function autoSyncTranslateRules() {
        if (translateRulesAutoSynced) return;
        translateRulesAutoSynced = true;
        await syncTranslateSheetRules();
    }
    async function testTranslateVoice() {
        setTranslateStatus('Đang gửi câu test sang overlay...', '');
        try {
            await saveLiveTranslateConfig();
            const res = await fetch('/api/live-translate/test-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'HP Media xin chào, đây là giọng đọc thử bằng tiếng Việt.' }) });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'test_failed');
            setTranslateStatus('Đã phát test giọng trên overlay', 'ok');
        } catch (e) { setTranslateStatus('Test giọng lỗi: ' + e.message, 'err'); }
    }

    function applyCreatorCaptionConfig(cfg) {
        creatorCaptionConfig = cfg || {};
        if (ccEnabled) ccEnabled.checked = creatorCaptionConfig.enabled === true;
        if (ccOriginal) ccOriginal.checked = creatorCaptionConfig.showOriginal !== false;
        if (ccSource) ccSource.value = creatorCaptionConfig.sourceLang || 'vi-VN';
        if (ccWhisperExe) ccWhisperExe.value = creatorCaptionConfig.whisperLocalExe || '';
        if (ccWhisperModel) ccWhisperModel.value = creatorCaptionConfig.whisperLocalModel || '';
        updateCreatorCaptionProviderUi();
        if (ccSilence) ccSilence.value = String(creatorCaptionConfig.silenceSeconds == null ? 2 : creatorCaptionConfig.silenceSeconds);
        if (ccSilenceV) ccSilenceV.textContent = (creatorCaptionConfig.silenceSeconds == null ? 2 : creatorCaptionConfig.silenceSeconds) + 's';
        if (ccAutoTargets) ccAutoTargets.checked = creatorCaptionConfig.autoTargetsEnabled !== false;
        if (ccAutoTargetTimeout) ccAutoTargetTimeout.value = String(creatorCaptionConfig.autoTargetTimeoutSeconds == null ? 60 : creatorCaptionConfig.autoTargetTimeoutSeconds);
        const targets = Array.isArray(creatorCaptionConfig.targetLangs) && creatorCaptionConfig.targetLangs.length ? creatorCaptionConfig.targetLangs : [creatorCaptionConfig.targetLang || 'en'];
        ccTargets.forEach(input => { input.checked = targets.includes(input.value); });
        if (btnCcToggle) {
            btnCcToggle.textContent = creatorCaptionListening ? 'DỪNG NGHE' : 'BẮT ĐẦU NGHE';
            btnCcToggle.classList.toggle('listening', creatorCaptionListening);
        }
    }
    async function loadCreatorCaptionConfig() {
        try { applyCreatorCaptionConfig(await (await fetch('/api/creator-caption/config')).json()); }
        catch (e) { setCreatorCaptionStatus('Không tải được cấu hình phụ đề', 'err'); }
    }
    async function saveCreatorCaptionConfig() {
        const body = {
            enabled: !!ccEnabled?.checked,
            sourceLang: ccSource?.value || 'vi-VN',
            whisperLocalExe: ccWhisperExe?.value || '',
            whisperLocalModel: ccWhisperModel?.value || '',
            targetLangs: ccTargets.filter(input => input.checked).map(input => input.value),
            showOriginal: ccOriginal ? !!ccOriginal.checked : true,
            silenceSeconds: Number.isFinite(parseFloat(ccSilence?.value || '')) ? parseFloat(ccSilence.value) : 2,
            autoTargetsEnabled: ccAutoTargets ? !!ccAutoTargets.checked : true,
            autoTargetTimeoutSeconds: Number.isFinite(parseInt(ccAutoTargetTimeout?.value || '', 10)) ? parseInt(ccAutoTargetTimeout.value, 10) : 60
        };
        if (!body.targetLangs.length) body.targetLangs = ['en'];
        body.targetLang = body.targetLangs[0];
        const res = await fetch('/api/creator-caption/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || 'caption_config_failed');
        applyCreatorCaptionConfig(json.config);
        return json.config;
    }
    function getSpeechRecognitionCtor() {
        return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }
    function getSelectedCreatorCaptionTargets() {
        const targets = ccTargets.filter(input => input.checked).map(input => input.value);
        return targets.length ? targets : ['en'];
    }
    function flushCreatorCaptionBuffer(cfg) {
        const text = creatorCaptionBuffer.trim().replace(/\s{2,}/g, ' ');
        creatorCaptionBuffer = '';
        if (creatorCaptionSilenceTimer) clearTimeout(creatorCaptionSilenceTimer);
        creatorCaptionSilenceTimer = null;
        if (text) {
            setCreatorCaptionTranscript(`Đã nhận giọng:\n${text}\n\nĐang gửi đi dịch...`, 'ok');
            socket.emit('creatorCaption:speech', { text, sourceLang: cfg.sourceLang, targetLangs: getSelectedCreatorCaptionTargets() });
        }
    }
    function clearCreatorCaptionAutoTarget(lang) {
        const timer = creatorCaptionAutoTargetTimers.get(lang);
        if (timer) clearTimeout(timer);
        creatorCaptionAutoTargetTimers.delete(lang);
        creatorCaptionAutoTargets.delete(lang);
    }
    async function saveCreatorCaptionConfigSilent() {
        try { await saveCreatorCaptionConfig(); }
        catch (e) { setCreatorCaptionStatus('Lưu tự động ngôn ngữ phụ đề lỗi: ' + e.message, 'err'); }
    }
    function autoDeactivateCreatorCaptionTarget(lang) {
        clearCreatorCaptionAutoTarget(lang);
        const input = ccTargets.find(x => x.value === lang);
        if (!input) return;
        input.checked = false;
        if (!ccTargets.some(x => x.checked)) {
            const english = ccTargets.find(x => x.value === 'en');
            if (english) english.checked = true;
        }
        saveCreatorCaptionConfigSilent();
        const timeoutSeconds = Math.max(5, Math.min(3600, parseInt(ccAutoTargetTimeout?.value || '60', 10) || 60));
        setCreatorCaptionStatus(`Đã tự tắt phụ đề ${input.parentElement?.textContent?.trim() || lang} vì ${timeoutSeconds}s không có phản hồi`, '');
    }
    function scheduleCreatorCaptionAutoTargetOff(lang) {
        const timeoutSeconds = Math.max(5, Math.min(3600, parseInt(ccAutoTargetTimeout?.value || '60', 10) || 60));
        const oldTimer = creatorCaptionAutoTargetTimers.get(lang);
        if (oldTimer) clearTimeout(oldTimer);
        creatorCaptionAutoTargetTimers.set(lang, setTimeout(() => autoDeactivateCreatorCaptionTarget(lang), timeoutSeconds * 1000));
    }
    function handleCreatorCaptionAutoTarget(item) {
        if (!ccAutoTargets?.checked) return;
        if (!item || item.canSpeak !== true) return;
        const lang = String(item.sourceLang || '').toLowerCase().split('-')[0];
        if (!lang || lang === 'auto') return;
        const input = ccTargets.find(x => x.value === lang);
        if (!input) {
            if (!missingCreatorCaptionTargetLangs.has(lang)) {
                missingCreatorCaptionTargetLangs.add(lang);
                const label = item.sourceLangLabel || lang.toUpperCase();
                setCreatorCaptionStatus(`Ngôn ngữ ${label} chưa có trong danh sách phụ đề. Nên bổ sung mã: ${lang}`, 'err');
            }
            return;
        }
        if (input.checked && !creatorCaptionAutoTargets.has(lang)) return;
        if (!input.checked) {
            input.checked = true;
            creatorCaptionAutoTargets.add(lang);
            saveCreatorCaptionConfigSilent();
        }
        scheduleCreatorCaptionAutoTargetOff(lang);
        setCreatorCaptionStatus(`Đã tự bật phụ đề ${input.parentElement?.textContent?.trim() || lang} theo bình luận người xem`, 'ok');
    }
    function scheduleCreatorCaptionFlush(cfg) {
        if (creatorCaptionSilenceTimer) clearTimeout(creatorCaptionSilenceTimer);
        const waitMs = Math.max(500, Math.min(8000, (parseFloat(cfg.silenceSeconds || ccSilence?.value || 2) || 2) * 1000));
        creatorCaptionSilenceTimer = setTimeout(() => flushCreatorCaptionBuffer(cfg), waitMs);
    }
    async function refreshCreatorCaptionMicrophones() {
        if (!ccMic || !navigator.mediaDevices?.enumerateDevices) return;
        try {
            const selected = ccMic.value || 'default';
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput');
            ccMic.innerHTML = '<option value="default">Micro mặc định của máy</option>' + mics.map((d, i) => `<option value="${d.deviceId}">${d.label || `Micro ${i + 1}`}</option>`).join('');
            if (Array.from(ccMic.options).some(opt => opt.value === selected)) ccMic.value = selected;
        } catch (e) {}
    }
    function resetCreatorCaptionWave() {
        ccWave?.classList.remove('listening');
        ccWave?.querySelectorAll('span').forEach(bar => { bar.style.height = '6px'; bar.style.opacity = '0.38'; });
    }
    function stopCreatorCaptionMicMonitor() {
        if (creatorCaptionWaveRaf) cancelAnimationFrame(creatorCaptionWaveRaf);
        creatorCaptionWaveRaf = 0;
        if (creatorCaptionNoResultTimer) clearTimeout(creatorCaptionNoResultTimer);
        creatorCaptionNoResultTimer = null;
        try { creatorCaptionMicStream?.getTracks().forEach(t => t.stop()); } catch (e) {}
        creatorCaptionMicStream = null;
        try { creatorCaptionAudioCtx?.close(); } catch (e) {}
        creatorCaptionAudioCtx = null;
        creatorCaptionAnalyser = null;
        resetCreatorCaptionWave();
    }
    async function startCreatorCaptionMicMonitor() {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Máy này không hỗ trợ micro');
        stopCreatorCaptionMicMonitor();
        const selectedMic = ccMic?.value || 'default';
        const audio = selectedMic && selectedMic !== 'default'
            ? { deviceId: { exact: selectedMic }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        creatorCaptionMicStream = await navigator.mediaDevices.getUserMedia({ audio });
        await refreshCreatorCaptionMicrophones();
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx || !ccWave) return;
        creatorCaptionAudioCtx = new AudioCtx();
        if (creatorCaptionAudioCtx.state === 'suspended') await creatorCaptionAudioCtx.resume();
        creatorCaptionAnalyser = creatorCaptionAudioCtx.createAnalyser();
        creatorCaptionAnalyser.fftSize = 256;
        creatorCaptionAudioCtx.createMediaStreamSource(creatorCaptionMicStream).connect(creatorCaptionAnalyser);
        const data = new Uint8Array(creatorCaptionAnalyser.frequencyBinCount);
        const bars = Array.from(ccWave.querySelectorAll('span'));
        ccWave.classList.add('listening');
        const draw = () => {
            if (!creatorCaptionAnalyser || !bars.length) return;
            creatorCaptionAnalyser.getByteFrequencyData(data);
            const step = Math.max(1, Math.floor(data.length / bars.length));
            bars.forEach((bar, i) => {
                let sum = 0;
                for (let j = 0; j < step; j++) sum += data[i * step + j] || 0;
                const level = sum / step / 255;
                creatorCaptionChunkPeak = Math.max(creatorCaptionChunkPeak, level);
                creatorCaptionChunkLevelSum += level;
                creatorCaptionChunkLevelCount += 1;
                if (level >= 0.09) creatorCaptionChunkActiveFrames += 1;
                const height = Math.max(6, Math.round(6 + level * 28));
                bar.style.height = height + 'px';
                bar.style.opacity = String(0.42 + Math.min(0.58, level * 1.6));
            });
            creatorCaptionWaveRaf = requestAnimationFrame(draw);
        };
        draw();
    }
    async function testCreatorCaptionMicrophone() {
        if (!navigator.mediaDevices?.getUserMedia) { setCreatorCaptionStatus('Máy này không hỗ trợ kiểm tra micro', 'err'); return; }
        try {
            const deviceId = ccMic?.value && ccMic.value !== 'default' ? { exact: ccMic.value } : undefined;
            const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true });
            stream.getTracks().forEach(t => t.stop());
            await refreshCreatorCaptionMicrophones();
            setCreatorCaptionStatus('Micro đã sẵn sàng. App sẽ chỉ gửi đoạn có giọng rõ vào Whisper local.', 'ok');
        } catch (e) { setCreatorCaptionStatus('Không truy cập được micro: ' + e.message, 'err'); }
    }
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
            reader.onerror = () => reject(reader.error || new Error('read_audio_failed'));
            reader.readAsDataURL(blob);
        });
    }
    function encodeWavFromAudioBuffer(audioBuffer) {
        const channels = Math.min(2, audioBuffer.numberOfChannels || 1);
        const sampleRate = audioBuffer.sampleRate;
        const samples = audioBuffer.length;
        const bytesPerSample = 2;
        const blockAlign = channels * bytesPerSample;
        const buffer = new ArrayBuffer(44 + samples * blockAlign);
        const view = new DataView(buffer);
        function writeString(offset, text) {
            for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        }
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples * blockAlign, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, samples * blockAlign, true);
        const data = [];
        for (let ch = 0; ch < channels; ch++) data.push(audioBuffer.getChannelData(ch));
        let offset = 44;
        for (let i = 0; i < samples; i++) {
            for (let ch = 0; ch < channels; ch++) {
                const s = Math.max(-1, Math.min(1, data[ch][i] || 0));
                view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
                offset += 2;
            }
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }
    function analyzeCreatorCaptionAudio(audioBuffer) {
        const channels = Math.min(2, audioBuffer.numberOfChannels || 1);
        const sampleRate = audioBuffer.sampleRate || 48000;
        const samples = audioBuffer.length || 0;
        const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
        let peak = 0;
        let sumSquares = 0;
        let voicedMs = 0;
        let frameSquares = 0;
        let frameCount = 0;
        for (let i = 0; i < samples; i++) {
            let sample = 0;
            for (let ch = 0; ch < channels; ch++) sample += audioBuffer.getChannelData(ch)[i] || 0;
            sample /= channels;
            const abs = Math.abs(sample);
            peak = Math.max(peak, abs);
            const square = sample * sample;
            sumSquares += square;
            frameSquares += square;
            frameCount += 1;
            if (frameCount >= frameSize || i === samples - 1) {
                const frameRms = Math.sqrt(frameSquares / Math.max(1, frameCount));
                if (frameRms >= 0.012) voicedMs += (frameCount / sampleRate) * 1000;
                frameSquares = 0;
                frameCount = 0;
            }
        }
        return {
            durationMs: samples ? (samples / sampleRate) * 1000 : 0,
            peak,
            rms: samples ? Math.sqrt(sumSquares / samples) : 0,
            voicedMs
        };
    }
    async function convertBlobToWav(blob) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) throw new Error('browser_no_audio_context');
        const ctx = new AudioCtx();
        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
            return { blob: encodeWavFromAudioBuffer(audioBuffer), metrics: analyzeCreatorCaptionAudio(audioBuffer) };
        } finally {
            try { await ctx.close(); } catch (e) {}
        }
    }
    async function sendCreatorCaptionAudio(blob, metrics, cfg) {
        // Whisper hallucinates from silence/noise. Require sustained voice-like energy, not just one spike.
        const peak = metrics?.peak || 0;
        const avgLevel = metrics?.avgLevel || 0;
        const activeFrames = metrics?.activeFrames || 0;
        if (!blob || blob.size < 6000 || creatorCaptionTranscribing) return;
        if (peak < 0.10 || avgLevel < 0.012 || activeFrames < 6) {
            if (peak >= 0.06 && Date.now() - creatorCaptionLastSkipNoticeAt > 5000) {
                creatorCaptionLastSkipNoticeAt = Date.now();
                setCreatorCaptionTranscript('Đã nghe thấy âm thanh nhưng chưa đủ rõ để nhận giọng. Hãy nói gần mic/rõ hơn.', 'pending');
            }
            return;
        }
        const now = Date.now();
        if (now < creatorCaptionRateLimitedUntil) return;
        if (now - creatorCaptionLastTranscribeAt < 2500) return;
        creatorCaptionTranscribing = true;
        const providerLabel = 'Whisper local';
        try {
            setCreatorCaptionTranscript(`Đang gửi audio sang ${providerLabel} để nhận chữ...`, 'pending');
            creatorCaptionLastTranscribeAt = Date.now();
            const converted = await convertBlobToWav(blob);
            const sendBlob = converted.blob;
            const audioMetrics = converted.metrics || {};
            if (audioMetrics.peak < 0.055 || audioMetrics.rms < 0.0065 || audioMetrics.voicedMs < 260) {
                if (audioMetrics.peak >= 0.035 && Date.now() - creatorCaptionLastSkipNoticeAt > 5000) {
                    creatorCaptionLastSkipNoticeAt = Date.now();
                    setCreatorCaptionTranscript('Đã nghe âm thanh nhưng chưa đủ giống giọng nói. Bỏ qua để tránh phụ đề ảo.', 'pending');
                }
                return;
            }
            const audioBase64 = await blobToBase64(sendBlob);
            const res = await fetch('/api/creator-caption/transcribe', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audioBase64,
                    mimeType: sendBlob.type || blob.type || 'audio/webm',
                    audioMetrics,
                    sourceLang: cfg.sourceLang,
                    targetLangs: getSelectedCreatorCaptionTargets()
                })
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'transcribe_failed');
            if (json.text) {
                setCreatorCaptionTranscript(`${providerLabel} đã nhận giọng:\n${json.text}\n\nĐang dịch ra OBS...`, 'ok');
                setCreatorCaptionStatus(`Đã nhận giọng bằng ${providerLabel} và đang dịch`, 'ok');
            } else {
                setCreatorCaptionTranscript(`${providerLabel} không nhận được chữ trong đoạn audio này. Hãy nói rõ hơn/gần mic hơn.`, 'pending');
            }
        } catch (e) {
            setCreatorCaptionTranscript(`${providerLabel} STT lỗi: ` + e.message, 'err');
            setCreatorCaptionStatus(`${providerLabel} STT lỗi: ` + e.message, 'err');
        } finally {
            creatorCaptionTranscribing = false;
        }
    }
    function startCreatorCaptionLocalRecorder(cfg) {
        if (!window.MediaRecorder) throw new Error('Máy này không hỗ trợ MediaRecorder');
        const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
        const mimeType = types.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
        const recordOnce = () => {
            if (!creatorCaptionListening || !creatorCaptionMicStream) return;
            const chunks = [];
            creatorCaptionChunkPeak = 0;
            creatorCaptionChunkLevelSum = 0;
            creatorCaptionChunkLevelCount = 0;
            creatorCaptionChunkActiveFrames = 0;
            creatorCaptionRecorder = new MediaRecorder(creatorCaptionMicStream, mimeType ? { mimeType } : undefined);
            creatorCaptionRecorder.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) chunks.push(ev.data);
            };
            creatorCaptionRecorder.onstop = () => {
                const metrics = {
                    peak: creatorCaptionChunkPeak,
                    avgLevel: creatorCaptionChunkLevelCount ? creatorCaptionChunkLevelSum / creatorCaptionChunkLevelCount : 0,
                    activeFrames: creatorCaptionChunkActiveFrames
                };
                creatorCaptionChunkPeak = 0;
                creatorCaptionChunkLevelSum = 0;
                creatorCaptionChunkLevelCount = 0;
                creatorCaptionChunkActiveFrames = 0;
                if (chunks.length) {
                    const blob = new Blob(chunks, { type: creatorCaptionRecorder?.mimeType || mimeType || 'audio/webm' });
                    sendCreatorCaptionAudio(blob, metrics, cfg);
                }
                creatorCaptionRecorder = null;
                if (creatorCaptionListening) creatorCaptionRecordTimer = setTimeout(recordOnce, 150);
            };
            creatorCaptionRecorder.onerror = (ev) => setCreatorCaptionStatus('Thu audio lỗi: ' + (ev.error?.message || 'recorder_error'), 'err');
            creatorCaptionRecorder.start();
            creatorCaptionRecordTimer = setTimeout(() => {
                try { if (creatorCaptionRecorder?.state === 'recording') creatorCaptionRecorder.stop(); } catch (e) {}
            }, 3000);
        };
        recordOnce();
    }
    function stopCreatorCaptionLocalRecorder() {
        if (creatorCaptionRecordTimer) clearTimeout(creatorCaptionRecordTimer);
        creatorCaptionRecordTimer = null;
        try {
            if (creatorCaptionRecorder && creatorCaptionRecorder.state !== 'inactive') creatorCaptionRecorder.stop();
        } catch (e) {}
        creatorCaptionRecorder = null;
        creatorCaptionTranscribing = false;
        creatorCaptionChunkPeak = 0;
        creatorCaptionChunkLevelSum = 0;
        creatorCaptionChunkLevelCount = 0;
        creatorCaptionChunkActiveFrames = 0;
        creatorCaptionLastTranscribeAt = 0;
        creatorCaptionRateLimitedUntil = 0;
        creatorCaptionLastSkipNoticeAt = 0;
    }
    async function startCreatorCaptionListening() {
        try {
            if (ccEnabled) ccEnabled.checked = true;
            const cfg = await saveCreatorCaptionConfig();
            setCreatorCaptionStatus('Đang xin quyền micro...', '');
            await startCreatorCaptionMicMonitor();
            setCreatorCaptionTranscript('Micro đã mở. Whisper local chỉ ghi nhận khi phát hiện giọng nói rõ...', 'pending');
            creatorCaptionLastResultAt = 0;
            creatorCaptionListening = true;
            startCreatorCaptionLocalRecorder(cfg);
            applyCreatorCaptionConfig(cfg);
            setCreatorCaptionStatus('Đang nghe bằng Whisper local...', 'ok');
        } catch (e) {
            stopCreatorCaptionLocalRecorder();
            stopCreatorCaptionMicMonitor();
            creatorCaptionListening = false;
            applyCreatorCaptionConfig(creatorCaptionConfig);
            setCreatorCaptionStatus('Không bật được micro: ' + e.message, 'err');
        }
    }
    function stopCreatorCaptionListening() {
        creatorCaptionListening = false;
        creatorCaptionRestarting = false;
        if (creatorCaptionConfig) flushCreatorCaptionBuffer(creatorCaptionConfig);
        try { creatorCaptionRecognition?.stop(); } catch (e) {}
        creatorCaptionRecognition = null;
        stopCreatorCaptionLocalRecorder();
        stopCreatorCaptionMicMonitor();
        setCreatorCaptionTranscript('', 'pending');
        applyCreatorCaptionConfig(creatorCaptionConfig);
        setCreatorCaptionStatus('Đã dừng nghe giọng Creator', '');
    }
    async function toggleCreatorCaptionListening() {
        if (creatorCaptionListening || creatorCaptionRestarting) stopCreatorCaptionListening();
        else await startCreatorCaptionListening();
    }
    async function copyCreatorCaptionOverlayUrl() {
        const url = buildOverlayURL('/overlay/creator-caption');
        const ok = await copyText(url);
        setCreatorCaptionStatus(ok ? 'Đã copy link OBS phụ đề' : 'Không copy tự động được. Link: ' + url, ok ? 'ok' : 'err');
    }
    async function testCreatorCaption() {
        try {
            if (ccEnabled) ccEnabled.checked = true;
            await saveCreatorCaptionConfig();
            const res = await fetch('/api/creator-caption/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Xin chào mọi người, hôm nay chúng ta bắt đầu live.' }) });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'caption_test_failed');
            setCreatorCaptionStatus('Đã gửi test phụ đề sang OBS', 'ok');
        } catch (e) { setCreatorCaptionStatus('Test phụ đề lỗi: ' + e.message, 'err'); }
    }
    refreshTranslateOverlayUrl();
    if (translatePopup) translatePopup.hidden = true;
    if (creatorCaptionPopup) creatorCaptionPopup.hidden = true;
    translateFab?.addEventListener('click', () => { if (isTranslatePopupOpen()) closeTranslatePopup(); else openTranslatePopup(); });
    translateClose?.addEventListener('click', closeTranslatePopup);
    creatorCaptionFab?.addEventListener('click', () => { if (isCreatorCaptionPopupOpen()) closeCreatorCaptionPopup(); else openCreatorCaptionPopup(); });
    creatorCaptionClose?.addEventListener('click', closeCreatorCaptionPopup);
    btnTranslateToggle?.addEventListener('click', () => setLiveTranslateRunning(!(liveTranslateConfig?.enabled === true)));
    btnTranslateSyncSheet?.addEventListener('click', syncTranslateSheetRules);
    btnTranslateTestVoice?.addEventListener('click', testTranslateVoice);
    btnTranslateSave?.addEventListener('click', saveLiveTranslateConfig);
    btnTranslateCopy?.addEventListener('click', copyTranslateOverlayUrl);
    btnCopyDashboard?.addEventListener('click', copyDashboardOverlayUrl);
    btnBackupExport?.addEventListener('click', exportBackupConfig);
    btnBackupImport?.addEventListener('click', () => backupImportFile?.click());
    backupImportFile?.addEventListener('change', () => importBackupConfig(backupImportFile.files?.[0]));
    btnCcToggle?.addEventListener('click', toggleCreatorCaptionListening);
    btnCcCopy?.addEventListener('click', copyCreatorCaptionOverlayUrl);
    btnCcTest?.addEventListener('click', testCreatorCaption);
    btnCcMicTest?.addEventListener('click', testCreatorCaptionMicrophone);
    ltVolume?.addEventListener('input', () => { if (ltVolumeV) ltVolumeV.textContent = (ltVolume.value || '0') + '%'; });
    ltRate?.addEventListener('input', () => { if (ltRateV) ltRateV.textContent = (parseFloat(ltRate.value || '1') || 1).toFixed(1) + 'x'; });
    ltTtsPreset?.addEventListener('change', () => {
        const preset = ltTtsPreset.value;
        if (preset && preset !== 'auto' && ltTarget) ltTarget.value = preset;
    });
    // TTS source: auto-save ngay khi đổi (UX: user thấy fix double-sound ngay lập tức)
    ltTtsSource?.addEventListener('change', () => {
        saveLiveTranslateConfig({ silent: false });
    });
    ccSilence?.addEventListener('input', () => { if (ccSilenceV) ccSilenceV.textContent = (parseFloat(ccSilence.value || '2') || 2) + 's'; });
    ccWhisperExe?.addEventListener('change', saveCreatorCaptionConfigSilent);
    ccWhisperModel?.addEventListener('change', saveCreatorCaptionConfigSilent);
    ccAutoTargets?.addEventListener('change', () => {
        if (!ccAutoTargets.checked) {
            for (const lang of Array.from(creatorCaptionAutoTargets)) clearCreatorCaptionAutoTarget(lang);
        }
        saveCreatorCaptionConfigSilent();
    });
    ccAutoTargetTimeout?.addEventListener('change', () => {
        for (const lang of Array.from(creatorCaptionAutoTargets)) scheduleCreatorCaptionAutoTargetOff(lang);
        saveCreatorCaptionConfigSilent();
    });
    ccTargets.forEach(input => input.addEventListener('change', () => {
        if (!input.checked) clearCreatorCaptionAutoTarget(input.value);
        saveCreatorCaptionConfigSilent();
    }));
    document.querySelectorAll('.translate-settings details').forEach(detail => {
        detail.addEventListener('toggle', () => {
            const scroller = detail.closest('.translate-settings');
            if (!scroller) return;
            setTimeout(() => detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
        });
    });
    socket.on('translate:config', applyLiveTranslateConfig);
    socket.on('translate:rules', updateTranslateSheetStatus);
    socket.on('translate:comment', (item) => { if (!isTranslatePopupOpen()) setTranslateUnread(unreadTranslations + 1); handleCreatorCaptionAutoTarget(item); });
    socket.on('creatorCaption:config', applyCreatorCaptionConfig);
    socket.on('creatorCaption:debug', (item) => {
        if (!isCreatorCaptionPopupOpen()) return;
        const text = item?.text || item?.message || '';
        if (!text) return;
        if (item.type === 'final') setCreatorCaptionTranscript(`Đã nhận giọng:\n${text}\n\nĐang gửi đi dịch...`, 'ok');
        else if (item.type === 'interim') setCreatorCaptionTranscript(`Đang nghe:\n${text}`, 'pending');
        else setCreatorCaptionStatus(text, item.type === 'error' ? 'err' : 'ok');
    });
    socket.on('creatorCaption:line', (item) => {
        if (!item?.originalText || !isCreatorCaptionPopupOpen()) return;
        const translations = Array.isArray(item.translations) && item.translations.length
            ? item.translations.map(row => `${row.targetLangLabel || row.targetLang}: ${row.translatedText || ''}`).join('\n')
            : `${item.targetLangLabel || item.targetLang || 'Dịch'}: ${item.translatedText || ''}`;
        setCreatorCaptionTranscript(`Đã nhận giọng:\n${item.originalText}\n\nKết quả dịch:\n${translations}`, item.error ? 'err' : 'ok');
        setCreatorCaptionStatus(item.error ? ('Dịch lỗi: ' + item.error) : 'Đã nhận giọng và dịch xong', item.error ? 'err' : 'ok');
    });
    setTranslateUnread(0);
    loadLiveTranslateConfig();
    loadCreatorCaptionConfig();
    refreshCreatorCaptionMicrophones();

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
            onUpdateProgress({ phase: 'verifying', percent: 0, message: 'Đang lưu gameplay Hũ trước khi cập nhật...' });
            const preserved = await flushStateBeforeUpdate();
            if (!preserved) {
                onUpdateProgress({ phase: 'error', percent: 0, message: 'Không lưu được trạng thái Hũ. Vui lòng thử lại để tránh mất gameplay.' });
                return;
            }
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
    document.getElementById('pktiktok-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('vipwelcome-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('live-translate-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('votecomment-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('level-quest-btn-settings')?.addEventListener('click', openSettingsPopup);
    document.getElementById('timer-btn-settings')?.addEventListener('click', openSettingsPopup);
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

    // ===================================================================
    // 🎬 OBS Effects — View riêng trong Game Library
    //   - Connection management (URL/pass/autoConnect)
    //   - Mapping Gift → Effect, gom theo NHÓM
    //   - Gift Picker modal (chọn quà bằng visual grid)
    //   - Group Name modal (tạo / đổi tên nhóm)
    // ===================================================================
    (function setupOBSEffectsView() {
        // Elements (sẽ null nếu view không có trong DOM — guard ngay)
        const $dot         = document.getElementById('obse-dot');
        const $statusText  = document.getElementById('obse-status-text');
        const $statusPill  = document.getElementById('obse-status-pill');
        const $url         = document.getElementById('obse-url');
        const $pass        = document.getElementById('obse-password');
        const $auto        = document.getElementById('obse-autoconnect');
        const $btnConn     = document.getElementById('btn-obse-connect');
        const $btnDisc     = document.getElementById('btn-obse-disconnect');
        const $btnRefresh  = document.getElementById('btn-obse-refresh-hotkeys');
        const $btnAddGroup = document.getElementById('btn-obse-add-group');
        const $groupsCt    = document.getElementById('obse-groups-container');
        const $err         = document.getElementById('obse-error');
        const $queuePill   = document.getElementById('obse-queue-pill');
        const $queueCount  = document.getElementById('obse-queue-count');
        const $btnQueueClr = document.getElementById('btn-obse-queue-clear');
        // ★ LUA Sync elements
        const $btnLuaCheck    = document.getElementById('btn-obse-lua-check');
        const $btnLuaDlAll    = document.getElementById('btn-obse-lua-download-all');
        const $btnLuaFolder   = document.getElementById('btn-obse-lua-open-folder');
        const $btnLuaSettings = document.getElementById('btn-obse-lua-settings');
        const $luaList        = document.getElementById('obse-lua-sync-list');
        const $luaMeta        = document.getElementById('obse-lua-sync-meta');
        const $luaSettings    = document.getElementById('obse-lua-sync-settings');
        const $luaAutoCheck   = document.getElementById('obse-lua-auto-check');
        const $luaInterval    = document.getElementById('obse-lua-interval');
        // ★ Background Removal helper elements
        const $btnCheckBg  = document.getElementById('btn-obse-check-bgremoval');
        const $btnInstBg   = document.getElementById('btn-obse-install-bgremoval');
        const $bgStatus    = document.getElementById('obse-bgremoval-status');
        const $bgModal     = document.getElementById('obse-bgremoval-modal');
        const $bgClose     = document.getElementById('obse-bgremoval-close');
        const $bgUrl       = document.getElementById('obse-bgremoval-url');
        const $btnBgCopy   = document.getElementById('btn-obse-bgremoval-copy');
        const $btnBgOpen   = document.getElementById('btn-obse-bgremoval-open');
        if (!$dot) return; // view không có trong DOM (chưa add HTML)

        // ===== Toast (feedback rõ ràng, hiện giữa màn) =====
        let toastEl = null;
        function toast(msg, kind = 'info', durationMs = 2500) {
            if (!toastEl) {
                toastEl = document.createElement('div');
                toastEl.id = 'obse-toast';
                toastEl.className = 'obse-toast';
                document.body.appendChild(toastEl);
            }
            toastEl.className = 'obse-toast show ' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : kind === 'warn' ? 'warn' : '');
            toastEl.textContent = msg;
            clearTimeout(toastEl._t);
            toastEl._t = setTimeout(() => { toastEl.classList.remove('show'); }, durationMs);
        }
        // ★ FIX: export toast ra global. Trước đây toast bị nhốt trong IIFE setupOBSEffectsView
        // → mọi chỗ gọi `if (typeof toast === 'function')` (đổi 4K, ẩn preview, báo game tắt...)
        // đều thấy undefined → KHÔNG toast nào hiện. Giờ bare `toast` resolve được toàn app.
        try { window.toast = toast; } catch (e) {}

        // Gift picker modal elements
        const $gpModal  = document.getElementById('obse-gift-modal');
        const $gpClose  = document.getElementById('obse-gp-close');
        const $gpSearch = document.getElementById('obse-gp-search');
        const $gpSort   = document.getElementById('obse-gp-sort');
        const $gpCount  = document.getElementById('obse-gp-count');
        const $gpGrid   = document.getElementById('obse-gp-grid');

        // Group name modal elements
        const $grmModal  = document.getElementById('obse-group-modal');
        const $grmTitle  = document.getElementById('obse-grm-title');
        const $grmClose  = document.getElementById('obse-grm-close');
        const $grmCancel = document.getElementById('obse-grm-cancel');
        const $grmSave   = document.getElementById('obse-grm-save');
        const $grmInput  = document.getElementById('obse-grm-input');

        // State
        let cachedConfig  = { url: '', password: '', autoConnect: false, mapping: [] };
        let cachedHotkeys = [];
        let saveTimer = null;
        let gpTargetMappingId = null;   // mapping id đang chờ chọn quà
        let grmMode = 'create';          // 'create' | 'rename'
        let grmRenameOldName = null;     // tên cũ khi rename
        let collapsedGroups = (() => {
            try { return new Set(JSON.parse(localStorage.getItem('obse:collapsedGroups') || '[]')); }
            catch (e) { return new Set(); }
        })();
        function persistCollapsed() {
            try { localStorage.setItem('obse:collapsedGroups', JSON.stringify([...collapsedGroups])); }
            catch (e) {}
        }

        // ============== Connection ==============
        function setStatus(s) {
            $dot.classList.remove('connected', 'connecting');
            if (s.connecting) {
                $dot.classList.add('connecting');
                $statusText.textContent = 'Đang kết nối...';
            } else if (s.connected) {
                $dot.classList.add('connected');
                $statusText.textContent = 'Đã kết nối';
                $statusPill.title = s.url || '';
            } else {
                $statusText.textContent = 'Chưa kết nối';
            }
            if (s.lastError && !s.connected) {
                $err.hidden = false;
                $err.textContent = '⚠ ' + s.lastError;
            } else {
                $err.hidden = true;
            }
            $btnConn.disabled = s.connecting || s.connected;
            $btnDisc.disabled = !s.connected;
        }
        function showError(msg) { $err.hidden = false; $err.textContent = '⚠ ' + msg; }

        async function loadConfig() {
            try {
                const r = await fetch('/api/obs-bridge/config');
                const j = await r.json();
                cachedConfig = {
                    url: j.url || 'ws://localhost:4455',
                    password: j.password || '',
                    autoConnect: !!j.autoConnect,
                    mapping: Array.isArray(j.mapping) ? j.mapping.map(normMapping) : []
                };
                $url.value = cachedConfig.url;
                $pass.value = cachedConfig.password;
                $auto.checked = cachedConfig.autoConnect;
                if (j.status) setStatus(j.status);
                renderGroups();
                if (j.status && j.status.connected) fetchHotkeys();
            } catch (e) { showError('Load config lỗi: ' + e.message); }
        }
        // Normalize mỗi mapping có đầy đủ fields + unique id
        function normMapping(m) {
            return {
                id: m.id || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
                giftId: String(m.giftId || ''),
                giftName: m.giftName || '',
                giftImage: m.giftImage || '',
                hotkey: m.hotkey || '',
                actionName: m.actionName || '',
                cooldownMs: Math.max(0, Number(m.cooldownMs) || 0),
                group: m.group || '',
                enabled: m.enabled !== false   // default true; chỉ false khi explicit set
            };
        }
        // Track group disabled state (mảng tên nhóm bị TẮT)
        function getGroupsDisabled() {
            if (!Array.isArray(cachedConfig.groupsDisabled)) cachedConfig.groupsDisabled = [];
            return cachedConfig.groupsDisabled;
        }
        function isGroupDisabled(name) {
            return getGroupsDisabled().includes(name);
        }
        function setGroupDisabled(name, disabled) {
            const arr = getGroupsDisabled();
            const idx = arr.indexOf(name);
            if (disabled && idx === -1) arr.push(name);
            if (!disabled && idx !== -1) arr.splice(idx, 1);
            saveConfig();
        }
        // Cache suggested duration để khỏi gọi server nhiều lần cho cùng 1 hotkey
        const _hotkeyDurationCache = {};
        async function fetchSuggestedDurationMs(hotkey) {
            if (!hotkey) return 0;
            if (_hotkeyDurationCache[hotkey] != null) return _hotkeyDurationCache[hotkey];
            try {
                const r = await fetch('/api/obs-bridge/lua-duration?hotkey=' + encodeURIComponent(hotkey));
                const j = await r.json();
                const ms = Number(j?.ms) || 0;
                _hotkeyDurationCache[hotkey] = ms;
                return ms;
            } catch (e) { return 0; }
        }
        // ====== 💾 Backup ALL Settings modal ======
        const $btnBackupAll = document.getElementById('btn-obse-lua-backup-all');
        const $backupAllModal = document.getElementById('obse-backup-all-modal');
        const $backupAllClose = document.getElementById('obse-backup-all-close');
        const $backupCollection = document.getElementById('obse-backup-collection');
        const $btnBackupDo = document.getElementById('obse-backup-do-btn');
        const $backupResult = document.getElementById('obse-backup-result');
        const $backupSummary = document.getElementById('obse-backup-summary');
        const $backupLuasList = document.getElementById('obse-backup-luas-list');
        const $btnBackupDownload = document.getElementById('obse-backup-download-btn');
        const $btnBackupCopy = document.getElementById('obse-backup-copy-btn');
        const $backupError = document.getElementById('obse-backup-error');
        let _lastBackupData = null;

        async function openBackupAllModal() {
            if (!$backupAllModal) return;
            $backupResult.hidden = true;
            $backupError.hidden = true;
            // Reuse loadSceneCollections nhưng populate vào $backupCollection
            try {
                const r = await fetch('/api/obs-settings/scene-collections');
                const j = await r.json();
                if (!j.ok) throw new Error(j.error || 'Load fail');
                const opts = j.collections.map(c =>
                    `<option value="${escapeHtml(c.filename)}">${escapeHtml(c.name)} (${new Date(c.modifiedAt).toLocaleString('vi-VN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})})</option>`
                ).join('');
                $backupCollection.innerHTML = opts || '<option value="">(không có)</option>';
            } catch (e) {
                toast('✗ Load collections: ' + e.message, 'error');
            }
            $backupAllModal.hidden = false;
        }
        function closeBackupAllModal() { if ($backupAllModal) $backupAllModal.hidden = true; }
        $btnBackupAll?.addEventListener('click', openBackupAllModal);
        $backupAllClose?.addEventListener('click', closeBackupAllModal);
        $backupAllModal?.addEventListener('click', (e) => { if (e.target === $backupAllModal) closeBackupAllModal(); });

        $btnBackupDo?.addEventListener('click', async () => {
            const sceneCollection = $backupCollection?.value || '';
            if (!sceneCollection) {
                $backupError.hidden = false;
                $backupError.textContent = '❌ Chọn scene collection trước';
                return;
            }
            $btnBackupDo.disabled = true;
            $btnBackupDo.textContent = '⏳ Đang backup...';
            $backupError.hidden = true;
            $backupResult.hidden = true;
            try {
                const r = await fetch('/api/obs-settings/backup-all', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sceneCollection })
                });
                const j = await r.json();
                if (!j.ok) {
                    $backupError.hidden = false;
                    $backupError.textContent = '❌ ' + (j.error || 'Backup fail');
                    return;
                }
                _lastBackupData = j.backup;
                $backupResult.hidden = false;
                $backupSummary.innerHTML = `<b>${j.matchedCount}/${j.totalLuas}</b> LUA tìm được settings trong "${escapeHtml(sceneCollection)}"`;
                // Liệt kê các LUA matched
                const luaIds = Object.keys(j.backup.luas || {});
                if (luaIds.length === 0) {
                    // ★ DIAGNOSTIC: show app đang tìm gì vs OBS thực có gì
                    const searchedFor = j.searchedFor || [];
                    const allScripts = j.allScripts || [];
                    let diagnosticHtml = '<div class="obse-backup-empty"><b>❌ Không có LUA nào match.</b></div>';
                    diagnosticHtml += '<div class="obse-backup-diag">';
                    diagnosticHtml += '<div class="obse-backup-diag-section"><b>🔍 App đang tìm các file LUA này:</b>';
                    if (searchedFor.length === 0) {
                        diagnosticHtml += '<div class="obse-backup-diag-empty">(chưa tải LUA nào về)</div>';
                    } else {
                        diagnosticHtml += '<ul>' + searchedFor.map(s =>
                            `<li><b>${escapeHtml(s.name)}</b>: <code>${escapeHtml(s.file)}</code></li>`
                        ).join('') + '</ul>';
                    }
                    diagnosticHtml += '</div>';
                    diagnosticHtml += '<div class="obse-backup-diag-section"><b>📋 Scripts thực có trong "' + escapeHtml(sceneCollection) + '":</b>';
                    if (allScripts.length === 0) {
                        diagnosticHtml += '<div class="obse-backup-diag-empty">(scene collection không có script nào — OBS Tools → Scripts trống)</div>';
                    } else {
                        diagnosticHtml += '<ul>' + allScripts.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('') + '</ul>';
                    }
                    diagnosticHtml += '</div>';
                    diagnosticHtml += '<div class="obse-backup-hint">';
                    if (allScripts.length === 0) {
                        diagnosticHtml += '💡 <b>Nguyên nhân</b>: scene collection này chưa có script nào. Add LUA vào OBS (Tools → Scripts → +) rồi chọn lại scene collection.';
                    } else if (searchedFor.length > 0) {
                        diagnosticHtml += '💡 <b>Nguyên nhân thường gặp</b>: bạn add LUA vào collection KHÁC, không phải "' + escapeHtml(sceneCollection) + '". Đổi sang collection chứa LUA → backup lại.';
                    }
                    diagnosticHtml += '</div>';
                    $backupLuasList.innerHTML = diagnosticHtml;
                } else {
                    $backupLuasList.innerHTML = luaIds.map(id => {
                        const lua = j.backup.luas[id];
                        const settingsCount = Object.keys(lua.settings || {}).length;
                        const stratLabel = ({obfuscated:'🎭 obfuscated', original:'📄 original', signature:'🔍 signature'})[lua.matchStrategy] || lua.matchStrategy;
                        const stratBadge = lua.matchStrategy ? ` <span class="obse-backup-strat ${lua.matchStrategy}">${stratLabel}</span>` : '';
                        const fileBadge = lua.matchedFile ? ` <code>${escapeHtml(lua.matchedFile)}</code>` : '';
                        return `<div class="obse-backup-lua-row">✓ <b>${escapeHtml(lua.name || id)}</b> <span class="obse-backup-lua-meta">v${escapeHtml(lua.version || '?')} · ${settingsCount} settings${fileBadge}${stratBadge}</span></div>`;
                    }).join('');
                }
                // Errors (nếu có)
                if (j.errors && j.errors.length > 0) {
                    $backupLuasList.innerHTML += '<div class="obse-backup-errors">⚠ Errors: ' +
                        j.errors.map(e => escapeHtml(e.id) + ': ' + escapeHtml(e.error)).join('; ') + '</div>';
                }
                if (j.matchedCount > 0) toast(`✓ Backup ${j.matchedCount}/${j.totalLuas} LUAs`, 'success', 3500);
                else toast(`⚠ 0 LUA match — xem chi tiết trong modal`, 'warning', 4000);
            } catch (e) {
                $backupError.hidden = false;
                $backupError.textContent = '❌ ' + e.message;
            } finally {
                $btnBackupDo.disabled = false;
                $btnBackupDo.textContent = '💾 Backup ngay';
            }
        });

        $btnBackupDownload?.addEventListener('click', () => {
            if (!_lastBackupData) return;
            const blob = new Blob([JSON.stringify(_lastBackupData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().slice(0,19).replace(/[:.]/g, '-');
            const collectionSafe = ($backupCollection.value || 'backup').replace(/\.json$/i, '').replace(/[^a-z0-9_-]/gi, '_');
            a.href = url;
            a.download = `lua-settings-${collectionSafe}-${ts}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast('⬇ Đã tải file backup', 'success', 2500);
        });
        $btnBackupCopy?.addEventListener('click', () => {
            if (!_lastBackupData) return;
            navigator.clipboard?.writeText(JSON.stringify(_lastBackupData, null, 2)).then(
                () => toast('✓ Đã copy JSON backup', 'success', 2000),
                () => toast('✗ Copy fail', 'error')
            );
        });

        // ====== 🔄 LUA Settings Sync modal ======
        const $settingsModal = document.getElementById('obse-settings-modal');
        const $settingsLuaName = document.getElementById('obse-settings-luaname');
        const $settingsClose = document.getElementById('obse-settings-close');
        const $colExport = document.getElementById('obse-settings-collection-export');
        const $colImport = document.getElementById('obse-settings-collection-import');
        const $btnExtract = document.getElementById('obse-settings-extract-btn');
        const $btnApply = document.getElementById('obse-settings-apply-btn');
        const $exportResult = document.getElementById('obse-settings-export-result');
        const $exportCount = document.getElementById('obse-settings-export-count');
        const $exportJson = document.getElementById('obse-settings-export-json');
        const $exportError = document.getElementById('obse-settings-export-error');
        const $btnExportCopy = document.getElementById('obse-settings-export-copy');
        const $btnExportSave = document.getElementById('obse-settings-export-save');
        const $importJson = document.getElementById('obse-settings-import-json');
        const $importError = document.getElementById('obse-settings-import-error');
        const $importSuccess = document.getElementById('obse-settings-import-success');
        const $btnImportFile = document.getElementById('obse-settings-import-file');
        const $importFileInput = document.getElementById('obse-settings-import-fileinput');
        let _currentSettingsLuaId = null;
        let _currentSettingsLuaName = null;

        async function loadSceneCollections() {
            try {
                const r = await fetch('/api/obs-settings/scene-collections');
                const j = await r.json();
                if (!j.ok) throw new Error(j.error || 'Load collections fail');
                const opts = j.collections.map(c =>
                    `<option value="${escapeHtml(c.filename)}">${escapeHtml(c.name)} (${new Date(c.modifiedAt).toLocaleString('vi-VN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})})</option>`
                ).join('');
                if ($colExport) $colExport.innerHTML = opts || '<option value="">(không có scene collection)</option>';
                if ($colImport) $colImport.innerHTML = opts || '<option value="">(không có scene collection)</option>';
            } catch (e) {
                toast('✗ Load scene collections: ' + e.message, 'error');
            }
        }

        function openSettingsSyncModal(luaId, luaName) {
            _currentSettingsLuaId = luaId;
            _currentSettingsLuaName = luaName;
            if ($settingsLuaName) $settingsLuaName.textContent = luaName;
            // Reset UI
            if ($exportResult) $exportResult.hidden = true;
            if ($exportError) { $exportError.hidden = true; $exportError.textContent = ''; }
            if ($importJson) $importJson.value = '';
            if ($importError) { $importError.hidden = true; $importError.textContent = ''; }
            if ($importSuccess) { $importSuccess.hidden = true; $importSuccess.textContent = ''; }
            // Default to Export tab
            document.querySelectorAll('.obse-settings-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === 'export');
            });
            document.querySelectorAll('.obse-settings-tab-content').forEach(c => {
                c.hidden = c.dataset.content !== 'export';
            });
            // Load scene collections
            loadSceneCollections();
            $settingsModal.hidden = false;
        }

        function closeSettingsSyncModal() {
            if ($settingsModal) $settingsModal.hidden = true;
            _currentSettingsLuaId = null;
        }
        $settingsClose?.addEventListener('click', closeSettingsSyncModal);
        $settingsModal?.addEventListener('click', (e) => { if (e.target === $settingsModal) closeSettingsSyncModal(); });

        // Tab switching
        document.querySelectorAll('.obse-settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                document.querySelectorAll('.obse-settings-tab').forEach(t => t.classList.toggle('active', t === tab));
                document.querySelectorAll('.obse-settings-tab-content').forEach(c => c.hidden = c.dataset.content !== target);
            });
        });

        // Extract handler
        $btnExtract?.addEventListener('click', async () => {
            if (!_currentSettingsLuaId) return;
            const sceneCollection = $colExport?.value || '';
            if (!sceneCollection) {
                $exportError.hidden = false;
                $exportError.textContent = '❌ Chọn scene collection trước';
                return;
            }
            $btnExtract.disabled = true;
            $btnExtract.textContent = '⏳ Đang trích...';
            $exportError.hidden = true;
            $exportResult.hidden = true;
            try {
                const r = await fetch('/api/obs-settings/extract', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ luaId: _currentSettingsLuaId, sceneCollection })
                });
                const j = await r.json();
                if (!j.ok) {
                    $exportError.hidden = false;
                    let errMsg = '❌ ' + (j.error || 'Extract fail');
                    if (j.availableScripts && j.availableScripts.length > 0) {
                        errMsg += '\n\nCác script có trong "' + sceneCollection + '":\n' + j.availableScripts.map(s => '  • ' + s).join('\n');
                    }
                    $exportError.textContent = errMsg;
                    return;
                }
                $exportResult.hidden = false;
                $exportCount.textContent = `${j.settingsCount} settings`;
                $exportJson.value = JSON.stringify(j.settings, null, 2);
                toast(`✓ Trích được ${j.settingsCount} settings`, 'success', 3000);
            } catch (e) {
                $exportError.hidden = false;
                $exportError.textContent = '❌ ' + e.message;
            } finally {
                $btnExtract.disabled = false;
                $btnExtract.textContent = '🔍 Trích settings';
            }
        });

        // Copy + Save handlers
        $btnExportCopy?.addEventListener('click', () => {
            navigator.clipboard?.writeText($exportJson.value).then(
                () => toast('✓ Đã copy JSON', 'success', 2000),
                () => toast('✗ Copy fail — chọn text + Ctrl+C', 'error')
            );
        });
        $btnExportSave?.addEventListener('click', () => {
            const blob = new Blob([$exportJson.value], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = (_currentSettingsLuaName || 'lua').toLowerCase().replace(/[^a-z0-9]/g, '_');
            const ts = new Date().toISOString().slice(0,19).replace(/[:.]/g, '-');
            a.href = url;
            a.download = `${safeName}-settings-${ts}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast('💾 Đã tải file settings', 'success', 2500);
        });

        // Import file picker
        $btnImportFile?.addEventListener('click', () => $importFileInput?.click());
        $importFileInput?.addEventListener('change', async () => {
            const file = $importFileInput.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                $importJson.value = text;
                toast('✓ Đã load file', 'success', 1500);
            } catch (e) { toast('✗ Read file fail: ' + e.message, 'error'); }
            $importFileInput.value = '';
        });

        // Apply handler
        $btnApply?.addEventListener('click', async () => {
            if (!_currentSettingsLuaId) return;
            const sceneCollection = $colImport?.value || '';
            const jsonText = $importJson?.value?.trim() || '';
            if (!sceneCollection) {
                $importError.hidden = false;
                $importError.textContent = '❌ Chọn scene collection đích';
                return;
            }
            if (!jsonText) {
                $importError.hidden = false;
                $importError.textContent = '❌ Paste JSON hoặc chọn file';
                return;
            }
            let settings;
            try { settings = JSON.parse(jsonText); }
            catch (e) {
                $importError.hidden = false;
                $importError.textContent = '❌ JSON không hợp lệ: ' + e.message;
                return;
            }
            if (!confirm('⚠ XÁC NHẬN: Bạn đã ĐÓNG OBS chưa?\n\nApply sẽ ghi đè settings vào scene collection. Nếu OBS đang chạy → corruption.\n\nBấm OK nếu OBS đã đóng.')) {
                return;
            }
            $btnApply.disabled = true;
            $btnApply.textContent = '⏳ Đang apply...';
            $importError.hidden = true;
            $importSuccess.hidden = true;
            try {
                const r = await fetch('/api/obs-settings/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ luaId: _currentSettingsLuaId, sceneCollection, settings })
                });
                const j = await r.json();
                if (j.ok) {
                    $importSuccess.hidden = false;
                    $importSuccess.textContent = `✓ ${j.message} (${j.settingsCount} settings, action: ${j.action})`;
                    toast('✓ Đã apply settings. Mở OBS để load.', 'success', 5000);
                } else {
                    $importError.hidden = false;
                    $importError.textContent = '❌ ' + (j.error || 'Apply fail');
                }
            } catch (e) {
                $importError.hidden = false;
                $importError.textContent = '❌ ' + e.message;
            } finally {
                $btnApply.disabled = false;
                $btnApply.textContent = '💉 Apply settings';
            }
        });

        // ====== LUA Sync ======
        const STATUS_BADGES = {
            latest:   { icon: '✓', label: 'Đã tải', cls: 'ok' },
            outdated: { icon: '⬆', label: 'Có update', cls: 'warn' },
            missing:  { icon: '⬇', label: 'Chưa tải', cls: 'missing' },
            unknown:  { icon: '?', label: 'Chưa check', cls: '' },
            orphan:   { icon: '⚠', label: 'Không trong manifest', cls: 'err' }
        };

        async function fetchLuaSyncStatus() {
            try {
                const r = await fetch('/api/lua-sync/status');
                const j = await r.json();
                if (j.ok) renderLuaSync(j.config, j.state);
            } catch (e) { /* silent */ }
        }
        async function doLuaCheck() {
            if (!$btnLuaCheck) return;
            $btnLuaCheck.disabled = true;
            $btnLuaCheck.textContent = '⏳ Đang check...';
            try {
                const r = await fetch('/api/lua-sync/check', { method: 'POST' });
                const j = await r.json();
                if (j.ok) {
                    renderLuaSync(null, j.state);
                    const count = j.state.luaCount || 0;
                    toast(`✓ Manifest loaded — ${count} effects`, 'success', 3000);
                } else {
                    toast('✗ Check fail: ' + (j.error || 'unknown'), 'error', 5000);
                    renderLuaSync(null, j.state);
                }
            } catch (e) {
                toast('✗ ' + e.message, 'error');
            } finally {
                $btnLuaCheck.disabled = false;
                $btnLuaCheck.textContent = '↻ Check';
            }
        }
        async function doLuaDownload(luaId) {
            try {
                const r = await fetch('/api/lua-sync/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ luaId })
                });
                const j = await r.json();
                if (j.ok) {
                    toast(`✓ Đã tải ${luaId} v${j.version} (${Math.round(j.size/1024)}KB)`, 'success', 3500);
                    fetchLuaSyncStatus();
                } else {
                    toast('✗ ' + (j.error || 'download fail'), 'error', 5000);
                }
            } catch (e) {
                toast('✗ ' + e.message, 'error');
            }
        }
        async function doLuaDownloadAll() {
            if (!$btnLuaDlAll) return;
            $btnLuaDlAll.disabled = true;
            $btnLuaDlAll.textContent = '⏳ Đang tải...';
            try {
                const r = await fetch('/api/lua-sync/download-all', { method: 'POST' });
                const j = await r.json();
                if (j.ok) {
                    toast(`✓ Tải xong: ${j.okCount} thành công, ${j.failCount} fail`, 'success', 4000);
                    renderLuaSync(null, j.state);
                } else {
                    toast('✗ ' + (j.error || 'fail'), 'error');
                }
            } catch (e) { toast('✗ ' + e.message, 'error'); }
            finally {
                $btnLuaDlAll.disabled = false;
                $btnLuaDlAll.textContent = '⬇ Tải tất cả';
            }
        }
        // ★ Custom password modal (Electron không support window.prompt)
        function showPasswordPrompt(message) {
            return new Promise((resolve) => {
                const modal = document.getElementById('obse-pwd-modal');
                const input = document.getElementById('obse-pwd-input');
                const prompt = document.getElementById('obse-pwd-prompt');
                const error = document.getElementById('obse-pwd-error');
                const btnOk = document.getElementById('obse-pwd-ok');
                const btnCancel = document.getElementById('obse-pwd-cancel');
                const btnClose = document.getElementById('obse-pwd-close');
                if (!modal || !input) return resolve(null);
                if (prompt) prompt.textContent = message || 'Nhập mật khẩu:';
                input.value = '';
                if (error) { error.hidden = true; error.textContent = ''; }
                modal.hidden = false;
                setTimeout(() => input.focus(), 50);

                const cleanup = () => {
                    modal.hidden = true;
                    btnOk.onclick = null;
                    btnCancel.onclick = null;
                    btnClose.onclick = null;
                    input.onkeydown = null;
                    modal.onclick = null;
                };
                const submit = () => {
                    const val = input.value;
                    cleanup();
                    resolve(val);
                };
                const cancel = () => { cleanup(); resolve(null); };
                btnOk.onclick = submit;
                btnCancel.onclick = cancel;
                btnClose.onclick = cancel;
                modal.onclick = (e) => { if (e.target === modal) cancel(); };
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submit(); }
                    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                };
            });
        }

        async function doLuaOpenFolder() {
            // SECURITY: prompt mật khẩu (101016) chống vô tình expose path khi share screen
            const pwd = await showPasswordPrompt('Nhập mật khẩu để mở folder cache:');
            if (pwd === null) return;   // user cancelled
            try {
                const r = await fetch('/api/lua-sync/open-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd })
                });
                const j = await r.json();
                if (j.ok) toast('📁 Đã mở folder cache', 'success', 2000);
                else if (r.status === 403) toast('🔒 Sai mật khẩu — không mở được', 'error', 3500);
                else toast('✗ ' + (j.error || 'fail'), 'error', 3000);
            } catch (e) { toast('✗ ' + e.message, 'error'); }
        }
        // SECURITY: KHÔNG còn copy path. Dùng "+ Thêm hiệu ứng" để auto-create mapping.
        async function doLuaAddToMapping(luaId) {
            try {
                const r = await fetch('/api/lua-sync/add-to-mapping', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ luaId })
                });
                const j = await r.json();
                if (j.ok) {
                    if (j.duplicate) {
                        toast(j.message, 'info', 4000);
                    } else {
                        toast(`✓ ${j.message || 'Đã thêm'} — chọn quà ở panel bên phải`, 'success', 4500);
                    }
                    // Refresh mapping panel + LUA list (để badge "Đã thêm" cập nhật)
                    if (typeof loadConfig === 'function') {
                        await loadConfig();
                        if (typeof renderGroups === 'function') renderGroups();
                    }
                    fetchLuaSyncStatus();   // ★ Re-render LUA list với inMappingCount mới
                } else {
                    toast('✗ ' + (j.error || 'Add fail'), 'error', 5000);
                }
            } catch (e) {
                toast('✗ ' + e.message, 'error');
            }
        }
        function renderLuaSync(config, state) {
            if (config) {
                if ($luaAutoCheck) $luaAutoCheck.checked = !!config.autoCheckEnabled;
                if ($luaInterval) $luaInterval.value = String(config.autoCheckIntervalSec || 300);
            }
            if (!state) return;
            // Meta info
            if ($luaMeta) {
                const luaCount = state.luaCount || 0;
                const ts = state.lastCheckAt ? new Date(state.lastCheckAt) : null;
                const tsStr = ts ? `${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}:${String(ts.getSeconds()).padStart(2,'0')}` : '—';
                const errPart = state.lastError ? ` · <span class="err">⚠ ${escapeHtml(state.lastError)}</span>` : '';
                $luaMeta.innerHTML = `<span class="obse-lua-meta-text">📦 ${luaCount} effects · Last check: ${tsStr}${errPart}</span>`;
            }
            // List
            if (!$luaList) return;
            const luas = state.luas || [];
            if (luas.length === 0) {
                $luaList.innerHTML = '<div class="obse-lua-sync-empty">Manifest chưa load — bấm <b>↻ Check</b></div>';
                if ($btnLuaDlAll) $btnLuaDlAll.disabled = true;
                return;
            }
            $luaList.innerHTML = '';
            luas.forEach(lua => {
                const badge = STATUS_BADGES[lua.status] || STATUS_BADGES.unknown;
                const row = document.createElement('div');
                row.className = 'obse-lua-row ' + badge.cls;
                const mapCount = lua.inMappingCount || 0;
                if (mapCount > 0) row.classList.add('has-mapping');
                // Action button based on status + mapping count
                let actionBtn = '';
                if (lua.status === 'missing') {
                    actionBtn = `<button class="obse-btn primary mini" data-action="dl" data-id="${escapeHtml(lua.id)}">⬇ Tải</button>`;
                } else if (lua.status === 'outdated') {
                    actionBtn = `<button class="obse-btn warn mini" data-action="dl" data-id="${escapeHtml(lua.id)}">⬆ Up</button>`;
                } else if (lua.status === 'latest') {
                    // ★ Compact: chỉ icon, gom trong group
                    const settingsBtn = `<button class="obse-btn ghost mini icon-only" data-action="settings" data-id="${escapeHtml(lua.id)}" data-name="${escapeHtml(lua.name || lua.id)}" title="Đồng bộ thông số (Export/Import)">⚙</button>`;
                    if (mapCount > 0) {
                        actionBtn = settingsBtn + `<button class="obse-btn ghost mini icon-only" data-action="add" data-id="${escapeHtml(lua.id)}" title="Đã có ${mapCount} mapping — bấm để thêm cho gift khác">+</button>`;
                    } else {
                        actionBtn = settingsBtn + `<button class="obse-btn primary mini" data-action="add" data-id="${escapeHtml(lua.id)}" title="Tự tạo mapping cho gift">+ Thêm</button>`;
                    }
                }
                const obFileHint = lua.obfuscatedName ? ` · 📄 <span class="obse-lua-obfilename">${escapeHtml(lua.obfuscatedName)}</span>` : '';
                // ★ Mapping count badge
                const mappingBadge = mapCount > 0
                    ? `<span class="obse-lua-mapping-badge" title="${mapCount} mapping đã tạo">✅ ${mapCount}</span>`
                    : '';
                row.innerHTML = `
                    <div class="obse-lua-row-icon">${lua.icon || '📜'}</div>
                    <div class="obse-lua-row-info">
                        <div class="obse-lua-row-name">${escapeHtml(lua.name || lua.id)} <span class="obse-lua-version">v${escapeHtml(lua.version || '?')}</span>${mappingBadge}</div>
                        <div class="obse-lua-row-meta">${escapeHtml(lua.hotkey || '')}${obFileHint}${lua.localVersion && lua.localVersion !== lua.version ? ` · local v${escapeHtml(lua.localVersion)}` : ''}</div>
                    </div>
                    <span class="obse-lua-status ${badge.cls}" title="${badge.label}">${badge.icon}</span>
                    <div class="obse-lua-row-actions">${actionBtn}</div>
                `;
                $luaList.appendChild(row);
            });
            // Wire up dynamic buttons
            $luaList.querySelectorAll('button[data-action="dl"]').forEach(b => {
                b.addEventListener('click', () => doLuaDownload(b.dataset.id));
            });
            $luaList.querySelectorAll('button[data-action="add"]').forEach(b => {
                b.addEventListener('click', () => doLuaAddToMapping(b.dataset.id));
            });
            $luaList.querySelectorAll('button[data-action="settings"]').forEach(b => {
                b.addEventListener('click', () => openSettingsSyncModal(b.dataset.id, b.dataset.name));
            });
            // Enable "Download all" if có ít nhất 1 missing/outdated
            const hasMissingOrOutdated = luas.some(l => l.status === 'missing' || l.status === 'outdated');
            if ($btnLuaDlAll) $btnLuaDlAll.disabled = !hasMissingOrOutdated;
        }
        // Wire up handlers
        if ($btnLuaCheck) $btnLuaCheck.addEventListener('click', doLuaCheck);
        if ($btnLuaDlAll) $btnLuaDlAll.addEventListener('click', doLuaDownloadAll);
        if ($btnLuaFolder) $btnLuaFolder.addEventListener('click', doLuaOpenFolder);
        if ($btnLuaSettings && $luaSettings) {
            $btnLuaSettings.addEventListener('click', () => { $luaSettings.hidden = !$luaSettings.hidden; });
        }
        async function saveLuaConfig() {
            try {
                await fetch('/api/lua-sync/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        autoCheckEnabled: !!($luaAutoCheck?.checked),
                        autoCheckIntervalSec: Number($luaInterval?.value) || 300
                    })
                });
                toast('✓ Đã lưu cài đặt auto-sync', 'success', 2000);
            } catch (e) { toast('✗ ' + e.message, 'error'); }
        }
        if ($luaAutoCheck) $luaAutoCheck.addEventListener('change', saveLuaConfig);
        if ($luaInterval) $luaInterval.addEventListener('change', saveLuaConfig);
        // Socket events
        if (typeof socket !== 'undefined' && socket) {
            socket.on('luaSync:updatesAvailable', (updates) => {
                const names = updates.map(u => u.id).join(', ');
                toast(`📢 Có update: ${names}`, 'info', 6000);
                fetchLuaSyncStatus();
            });
            socket.on('luaSync:downloaded', () => fetchLuaSyncStatus());
        }
        // Initial fetch khi view active
        fetchLuaSyncStatus();

        // ===== Persist collapse state (localStorage) =====
        const persistCollapse = (id, key) => {
            const el = document.getElementById(id);
            if (!el) return;
            const stored = localStorage.getItem(key);
            if (stored !== null) el.open = stored === 'true';
            el.addEventListener('toggle', () => {
                localStorage.setItem(key, String(el.open));
            });
        };
        persistCollapse('obse-lua-sync-details', 'obse-lua-collapse');
        persistCollapse('obse-bgremoval-details', 'obse-bg-collapse');

        // ====== Background Removal helper ======
        function setBgStatus(state, text) {
            // state: 'installed' | 'missing' | 'checking' | 'unknown'
            if (!$bgStatus) return;
            const iconEl = $bgStatus.querySelector('.obse-bgremoval-icon');
            const textEl = $bgStatus.querySelector('.obse-bgremoval-text');
            const icons = { installed: '✅', missing: '❌', checking: '⏳', unknown: '❓' };
            const colors = { installed: 'ok', missing: 'err', checking: 'wait', unknown: '' };
            if (iconEl) iconEl.textContent = icons[state] || '❓';
            if (textEl) textEl.textContent = text || '';
            $bgStatus.className = 'obse-bgremoval-status ' + (colors[state] || '');
            // Also update summary icon (visible even when collapsed)
            const summaryIcon = document.getElementById('obse-bgremoval-summary-icon');
            if (summaryIcon) {
                summaryIcon.textContent = icons[state] || '❓';
                summaryIcon.className = 'obse-bgremoval-summary-icon ' + (colors[state] || '');
            }
        }
        if ($btnCheckBg) $btnCheckBg.addEventListener('click', async () => {
            setBgStatus('checking', 'Đang kiểm tra qua OBS WebSocket...');
            try {
                const r = await fetch('/api/obs-bridge/check-bg-removal');
                const j = await r.json();
                if (!j.ok) {
                    setBgStatus('unknown', j.message || 'Không kiểm tra được');
                    toast('⚠ ' + (j.message || 'Check FAIL'), 'error', 4000);
                    return;
                }
                if (j.installed === true) {
                    setBgStatus('installed', j.message || '✓ Plugin đã cài');
                    toast('✓ Background Removal đã cài', 'success', 3000);
                } else {
                    setBgStatus('missing', j.message || '❌ Plugin chưa cài');
                    toast('❌ Plugin chưa cài — bấm 📥 Cài đặt để xem hướng dẫn', 'error', 4000);
                }
            } catch (e) {
                setBgStatus('unknown', 'Lỗi: ' + (e.message || e));
                toast('✗ ' + e.message, 'error');
            }
        });
        if ($btnInstBg && $bgModal) $btnInstBg.addEventListener('click', () => { $bgModal.hidden = false; });
        if ($bgClose && $bgModal) $bgClose.addEventListener('click', () => { $bgModal.hidden = true; });
        if ($bgModal) $bgModal.addEventListener('click', (e) => { if (e.target === $bgModal) $bgModal.hidden = true; });
        if ($btnBgCopy && $bgUrl) $btnBgCopy.addEventListener('click', () => {
            const url = $bgUrl.textContent.trim();
            navigator.clipboard?.writeText(url).then(() => toast('✓ Đã copy URL', 'success', 2000))
                .catch(() => toast('✗ Copy fail — chọn text và Ctrl+C thủ công', 'error'));
        });
        if ($btnBgOpen && $bgUrl) $btnBgOpen.addEventListener('click', () => {
            const url = $bgUrl.textContent.trim();
            window.open(url, '_blank');
        });

        // ★ AUTO-INSTALL BG Removal
        const $btnAutoInst = document.getElementById('btn-obse-bgremoval-autoinstall');
        const $progressBox = document.getElementById('obse-bgremoval-progress');
        const $progressFill = document.getElementById('obse-bgremoval-progress-fill');
        const $progressText = document.getElementById('obse-bgremoval-progress-text');
        function updateInstallProgress(data) {
            if (!$progressBox || !$progressFill || !$progressText) return;
            $progressBox.hidden = false;
            const pct = Math.max(0, Math.min(100, Number(data.percent) || 0));
            $progressFill.style.width = pct + '%';
            $progressText.textContent = data.message || (data.phase + '...');
            // Color per phase
            $progressBox.className = 'obse-bgremoval-progress phase-' + data.phase;
        }
        if (typeof socket !== 'undefined' && socket) {
            socket.on('bgInstall:progress', updateInstallProgress);
        }
        if ($btnAutoInst) {
            $btnAutoInst.addEventListener('click', async () => {
                if (!confirm('Bạn ĐÃ đóng OBS chưa? Plugin DLL không thể replace khi OBS chạy.\n\nNếu OBS WS đang connect → bấm "Disconnect" trên app TRƯỚC khi cài.\n\nBấm OK để bắt đầu cài.')) return;
                $btnAutoInst.disabled = true;
                $btnAutoInst.textContent = '⏳ Đang cài...';
                if ($progressBox) $progressBox.hidden = false;
                try {
                    const r = await fetch('/api/obs-bridge/install-bg-removal', { method: 'POST' });
                    const j = await r.json();
                    if (j.ok) {
                        updateInstallProgress({ phase: 'done', percent: 100, message: `✓ Đã cài v${j.version}. MỞ LẠI OBS.` });
                        toast(`✓ Plugin đã cài v${j.version}. Hãy mở OBS lại!`, 'success', 8000);
                        setBgStatus('installed', `✓ Plugin v${j.version} (cần khởi động OBS lại)`);
                    } else {
                        updateInstallProgress({ phase: 'error', percent: 0, message: '❌ ' + (j.error || 'Install fail') });
                        toast('✗ ' + (j.error || 'Install fail'), 'error', 6000);
                    }
                } catch (e) {
                    updateInstallProgress({ phase: 'error', percent: 0, message: '❌ ' + e.message });
                    toast('✗ ' + e.message, 'error');
                } finally {
                    $btnAutoInst.disabled = false;
                    $btnAutoInst.textContent = '🚀 Cài tự động ngay';
                }
            });
        }

        // ★ Auto-save mode toggle (localStorage)
        // Nếu autoSave OFF → không tự lưu, hiện nút "💾 LƯU" + warning "có thay đổi"
        function isAutoSaveEnabled() {
            return localStorage.getItem('obse-autosave') !== 'false';   // default true
        }
        function setAutoSaveEnabled(on) {
            localStorage.setItem('obse-autosave', String(!!on));
            updateSaveIndicatorMode();
        }
        let _hasUnsavedChanges = false;
        function markUnsaved() {
            _hasUnsavedChanges = true;
            const el = document.getElementById('obse-save-indicator');
            if (!el) return;
            if (!isAutoSaveEnabled()) {
                el.textContent = '⚠ Có thay đổi chưa lưu — bấm 💾 LƯU';
                el.className = 'obse-save-indicator unsaved';
            }
        }
        async function saveConfig(immediate = false) {
            clearTimeout(saveTimer);
            const doSave = async () => {
                try {
                    await fetch('/api/obs-bridge/config', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(cachedConfig)
                    });
                    _hasUnsavedChanges = false;
                    flashSavedIndicator();
                } catch (e) { showError('Lưu config lỗi: ' + e.message); }
            };
            // ★ Auto-save OFF mode: chỉ mark unsaved, không POST
            if (!isAutoSaveEnabled() && !immediate) {
                markUnsaved();
                return;
            }
            if (immediate) return doSave();
            setSavingIndicator();
            saveTimer = setTimeout(doSave, 400);
        }
        async function manualSave() {
            await saveConfig(true);
            toast('💾 Đã lưu', 'success', 1500);
        }
        function updateSaveIndicatorMode() {
            const el = document.getElementById('obse-save-indicator');
            if (!el) return;
            const autoOn = isAutoSaveEnabled();
            if (!autoOn && _hasUnsavedChanges) {
                el.textContent = '⚠ Có thay đổi chưa lưu — bấm 💾 LƯU';
                el.className = 'obse-save-indicator unsaved';
            } else if (!autoOn) {
                el.textContent = '💾 Auto OFF — chế độ lưu tay';
                el.className = 'obse-save-indicator manual';
            } else {
                el.textContent = '💾 Tự động lưu';
                el.className = 'obse-save-indicator';
            }
        }
        function setSavingIndicator() {
            if (!isAutoSaveEnabled()) return;   // skip ở manual mode
            const el = document.getElementById('obse-save-indicator');
            if (!el) return;
            el.textContent = '⏳ Đang lưu...';
            el.className = 'obse-save-indicator saving';
        }
        function flashSavedIndicator() {
            const el = document.getElementById('obse-save-indicator');
            if (!el) return;
            const now = new Date();
            const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
            el.textContent = `💾 Đã lưu (${hhmm})`;
            el.className = 'obse-save-indicator saved';
            setTimeout(updateSaveIndicatorMode, 2500);   // revert về mode bình thường
        }
        // Init save mode indicator
        setTimeout(updateSaveIndicatorMode, 100);
        // Wire up auto-save toggle button (added in HTML below)
        const $btnAutoSaveToggle = document.getElementById('btn-obse-autosave-toggle');
        const $btnManualSave = document.getElementById('btn-obse-manual-save');
        if ($btnAutoSaveToggle) {
            $btnAutoSaveToggle.checked = isAutoSaveEnabled();
            $btnAutoSaveToggle.addEventListener('change', () => {
                setAutoSaveEnabled($btnAutoSaveToggle.checked);
                if ($btnManualSave) $btnManualSave.hidden = $btnAutoSaveToggle.checked;
                if ($btnAutoSaveToggle.checked && _hasUnsavedChanges) {
                    saveConfig(true);   // flush ngay khi bật lại auto
                }
            });
            if ($btnManualSave) $btnManualSave.hidden = $btnAutoSaveToggle.checked;
        }
        if ($btnManualSave) $btnManualSave.addEventListener('click', manualSave);
        // Ctrl+S = save khi manual mode
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                if (!isAutoSaveEnabled() && _hasUnsavedChanges) {
                    e.preventDefault();
                    manualSave();
                }
            }
        });
        setInterval(async () => {
            // Poll status + queue mỗi 1s khi view active (1s để queue list update nhanh)
            if (!document.getElementById('view-obs-effects')?.classList.contains('active')) return;
            try {
                const r = await fetch('/api/obs-bridge/config');
                const j = await r.json();
                if (j.status) setStatus(j.status);
                if (j.queue) {
                    updateQueuePill(j.queue);
                    renderQueueList(j.queue);
                }
                if (j.status && j.status.connected && cachedHotkeys.length === 0) {
                    fetchHotkeys();
                }
                // Auto-check BG removal 1 lần sau khi connect (giúp user biết có cần cài plugin không)
                if (j.status && j.status.connected && !window.__bgRemovalChecked && $btnCheckBg) {
                    window.__bgRemovalChecked = true;
                    $btnCheckBg.click();
                }
                if (j.status && !j.status.connected) {
                    window.__bgRemovalChecked = false;  // reset để check lại sau lần connect tiếp
                }
            } catch (e) {}
        }, 1000);

        function updateQueuePill(q) {
            if (!q || !$queuePill) return;
            if (q.pending > 0) {
                $queuePill.hidden = false;
                $queueCount.textContent = q.pending;
            } else {
                $queuePill.hidden = true;
            }
        }

        // ============== Queue list panel ==============
        const $queueCard = document.getElementById('obse-queue-card');
        const $queueList = document.getElementById('obse-queue-list');
        const $btnQueueClr2 = document.getElementById('btn-obse-queue-clear2');
        if ($btnQueueClr2) {
            $btnQueueClr2.onclick = async () => {
                if (!confirm('Xóa tất cả effect đang chờ trong hàng đợi?')) return;
                try {
                    const r = await fetch('/api/obs-bridge/queue/clear', { method: 'POST' });
                    const j = await r.json();
                    toast(`🗑 Đã xóa ${j.removed || 0} effect`, 'success');
                } catch (e) { toast('✗ ' + e.message, 'error'); }
            };
        }
        // Cache queue data cho countdown render 5 lần/giây (server poll vẫn 1 lần/giây)
        let _lastQueueData = null;
        function renderQueueList(q) {
            _lastQueueData = q || null;
            renderQueueListInternal();
        }
        function renderQueueListInternal() {
            if (!$queueCard || !$queueList) return;
            const q = _lastQueueData;
            const items = q && q.items ? q.items : [];
            // Tính số "đang waiting có thật" — items có nowFiring "ảo" còn countdown thì coi như queue chưa rỗng
            if (items.length === 0) {
                $queueCard.hidden = true;
                $queueList.innerHTML = '';
                return;
            }
            $queueCard.hidden = false;
            // Re-render LẠI toàn bộ list mỗi tick (rẻ vì <10 items)
            $queueList.innerHTML = '';
            const now = Date.now();
            items.forEach((it, idx) => {
                const row = document.createElement('div');
                row.className = 'obse-queue-row ' + (it.status === 'running' ? 'running' : 'waiting');
                // Icon = giftImage
                const iconHtml = it.giftImage ?
                    `<img class="obse-queue-icon" src="${escapeHtml(it.giftImage)}" onerror="this.style.display='none'"/>` :
                    `<span class="obse-queue-icon-noimg">🎁</span>`;
                const displayName = it.actionName || it.giftName || `Gift ${it.giftId}`;
                const groupBadge = it.group ? `<span class="obse-queue-group">${escapeHtml(it.group)}</span>` : '';

                // Position badge: #1 (đang chạy), #2, #3, ...
                const posBadge = `<span class="obse-queue-pos">#${idx + 1}</span>`;

                let statusBadge;
                if (it.status === 'running' && it.firedAt && it.intervalMs) {
                    const elapsed = now - it.firedAt;
                    const remaining = Math.max(0, it.intervalMs - elapsed);
                    const secLeft = (remaining / 1000).toFixed(1);
                    // Progress bar bên trong badge
                    const pct = Math.max(0, Math.min(100, (elapsed / it.intervalMs) * 100));
                    statusBadge = `<span class="obse-queue-status running">
                        <span class="obse-queue-progress" style="width:${pct.toFixed(1)}%"></span>
                        <span class="obse-queue-status-text">▶ Đang chạy · còn ${secLeft}s</span>
                    </span>`;
                } else if (it.status === 'running') {
                    statusBadge = '<span class="obse-queue-status running"><span class="obse-queue-status-text">▶ Đang chạy</span></span>';
                } else {
                    statusBadge = '<span class="obse-queue-status waiting">⏳ Chờ</span>';
                }
                row.innerHTML = `
                    ${posBadge}
                    ${iconHtml}
                    <div class="obse-queue-info">
                        <span class="obse-queue-name">${escapeHtml(displayName)}</span>
                        <span class="obse-queue-meta">${groupBadge}${groupBadge ? ' · ' : ''}${escapeHtml(it.hotkey || '')}</span>
                    </div>
                    ${statusBadge}
                `;
                $queueList.appendChild(row);
            });
        }
        // Countdown refresh: 200ms cho UI mượt (server poll vẫn 1s)
        setInterval(() => {
            if (!document.getElementById('view-obs-effects')?.classList.contains('active')) return;
            if (!_lastQueueData) return;
            // Chỉ re-render nếu có item running (cần update countdown)
            const hasRunning = (_lastQueueData.items || []).some(it => it.status === 'running' && it.firedAt);
            if (hasRunning) renderQueueListInternal();
        }, 200);

        async function doConnect() {
            cachedConfig.url = $url.value.trim();
            cachedConfig.password = $pass.value;
            cachedConfig.autoConnect = $auto.checked;
            await saveConfig(true);
            $err.hidden = true;
            $btnConn.disabled = true;
            try {
                const r = await fetch('/api/obs-bridge/connect', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: cachedConfig.url, password: cachedConfig.password })
                });
                const j = await r.json();
                if (j.status) setStatus(j.status);
                if (!j.ok) showError(j.error || 'Kết nối thất bại');
                else fetchHotkeys();
            } catch (e) { showError(e.message); $btnConn.disabled = false; }
        }
        async function doDisconnect() {
            try {
                const r = await fetch('/api/obs-bridge/disconnect', { method: 'POST' });
                const j = await r.json();
                if (j.status) setStatus(j.status);
            } catch (e) { showError(e.message); }
        }
        async function fetchHotkeys() {
            try {
                const r = await fetch('/api/obs-bridge/hotkeys');
                const j = await r.json();
                if (j.ok) {
                    cachedHotkeys = j.effectHotkeys || [];
                    renderGroups();
                }
            } catch (e) {}
        }

        // ============== Groups rendering ==============
        function getGroupNames() {
            // Distinct groups từ mappings, sort: nhóm có tên (alphabet) → "" (Chưa nhóm) cuối
            const names = new Set();
            cachedConfig.mapping.forEach(m => names.add(m.group || ''));
            const arr = [...names];
            arr.sort((a, b) => {
                if (a === '' && b === '') return 0;
                if (a === '') return 1;
                if (b === '') return -1;
                return a.localeCompare(b, 'vi');
            });
            return arr;
        }

        function renderGroups() {
            const names = getGroupNames();
            $groupsCt.innerHTML = '';
            if (cachedConfig.mapping.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'obse-groups-empty';
                empty.innerHTML = '🎯 Chưa có mapping nào.<br>Bấm <b>+ Tạo nhóm mới</b> bên trên để bắt đầu, hoặc tạo nhóm mặc định:';
                const btn = document.createElement('button');
                btn.className = 'obse-btn primary';
                btn.style.marginTop = '12px';
                btn.textContent = '+ Tạo mapping đầu tiên (Chưa nhóm)';
                btn.onclick = () => addMappingToGroup('');
                empty.appendChild(btn);
                $groupsCt.appendChild(empty);
                return;
            }
            names.forEach(name => renderOneGroup(name));
        }

        function renderOneGroup(name) {
            const displayName = name === '' ? '📁 Chưa nhóm' : '📂 ' + name;
            const rows = cachedConfig.mapping.filter(m => (m.group || '') === name);
            const isCollapsed = collapsedGroups.has(name);
            const groupDisabled = isGroupDisabled(name);

            const wrap = document.createElement('div');
            wrap.className = 'obse-group';
            if (isCollapsed) wrap.classList.add('collapsed');
            if (groupDisabled) wrap.classList.add('group-disabled');
            wrap.dataset.group = name;

            // Header
            const head = document.createElement('div');
            head.className = 'obse-group-head';

            const toggle = document.createElement('button');
            toggle.className = 'obse-group-toggle';
            toggle.textContent = isCollapsed ? '▸' : '▾';
            toggle.onclick = () => {
                if (collapsedGroups.has(name)) collapsedGroups.delete(name);
                else collapsedGroups.add(name);
                persistCollapsed();
                renderGroups();
            };
            head.appendChild(toggle);

            // Group enable toggle (bật/tắt cả nhóm)
            const grpEnWrap = document.createElement('label');
            grpEnWrap.className = 'obse-group-toggle-switch';
            grpEnWrap.title = groupDisabled
                ? `Nhóm "${displayName}" đang TẮT — tất cả gift trong nhóm bị bỏ qua. Click để bật lại.`
                : `Nhóm "${displayName}" đang BẬT — click để tắt cả nhóm (mọi gift trong nhóm sẽ bị bỏ qua).`;
            const grpChk = document.createElement('input');
            grpChk.type = 'checkbox';
            grpChk.checked = !groupDisabled;
            grpChk.onchange = (e) => {
                e.stopPropagation();
                setGroupDisabled(name, !grpChk.checked);
                renderGroups();
                toast(grpChk.checked
                    ? `✓ Đã BẬT nhóm "${displayName}"`
                    : `✗ Đã TẮT nhóm "${displayName}" — gift trong nhóm sẽ bị bỏ qua`,
                    grpChk.checked ? 'success' : 'warning', 3000);
            };
            const grpSlider = document.createElement('span');
            grpSlider.className = 'obse-toggle-slider';
            grpEnWrap.appendChild(grpChk);
            grpEnWrap.appendChild(grpSlider);
            head.appendChild(grpEnWrap);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'obse-group-name';
            nameSpan.textContent = displayName;
            if (groupDisabled) nameSpan.innerHTML += ' <span class="obse-group-disabled-tag">TẮT</span>';
            head.appendChild(nameSpan);

            const countSpan = document.createElement('span');
            countSpan.className = 'obse-group-count';
            const enabledCount = rows.filter(r => r.enabled !== false).length;
            countSpan.textContent = rows.length === enabledCount
                ? `(${rows.length})`
                : `(${enabledCount}/${rows.length})`;
            head.appendChild(countSpan);

            const actions = document.createElement('div');
            actions.className = 'obse-group-actions';

            const btnAdd = document.createElement('button');
            btnAdd.className = 'obse-mini-btn';
            btnAdd.title = 'Thêm mapping vào nhóm này';
            btnAdd.textContent = '+';
            btnAdd.onclick = () => addMappingToGroup(name);
            actions.appendChild(btnAdd);

            if (name !== '') {
                const btnRename = document.createElement('button');
                btnRename.className = 'obse-mini-btn';
                btnRename.title = 'Đổi tên nhóm';
                btnRename.textContent = '✎';
                btnRename.onclick = () => openGroupModal('rename', name);
                actions.appendChild(btnRename);

                const btnDel = document.createElement('button');
                btnDel.className = 'obse-mini-btn danger';
                btnDel.title = 'Xóa cả nhóm (gồm các mapping)';
                btnDel.textContent = '🗑';
                btnDel.onclick = () => {
                    if (!confirm(`Xóa nhóm "${name}" và ${rows.length} mapping trong đó?`)) return;
                    cachedConfig.mapping = cachedConfig.mapping.filter(m => (m.group || '') !== name);
                    saveConfig(true);
                    renderGroups();
                };
                actions.appendChild(btnDel);
            }
            head.appendChild(actions);
            wrap.appendChild(head);

            // Body
            const body = document.createElement('div');
            body.className = 'obse-group-body';
            if (rows.length === 0) {
                const e = document.createElement('div');
                e.className = 'obse-group-empty';
                e.textContent = 'Nhóm rỗng — bấm + để thêm mapping';
                body.appendChild(e);
            } else {
                rows.forEach(m => body.appendChild(renderMappingRow(m)));
            }
            wrap.appendChild(body);

            $groupsCt.appendChild(wrap);
        }

        function renderMappingRow(m) {
            const row = document.createElement('div');
            row.className = 'obse-row';
            if (m.enabled === false) row.classList.add('disabled');
            row.dataset.id = m.id;

            // Enable toggle (switch nhỏ bên trái)
            const enWrap = document.createElement('label');
            enWrap.className = 'obse-row-toggle';
            enWrap.title = m.enabled === false ? 'Đang TẮT — click để bật lại' : 'Đang BẬT — click để tắt mapping này (gift đến vẫn không trigger)';
            const enChk = document.createElement('input');
            enChk.type = 'checkbox';
            enChk.checked = m.enabled !== false;
            enChk.onchange = () => {
                m.enabled = enChk.checked;
                saveConfig();
                renderGroups();   // re-render để update class disabled
            };
            const enSlider = document.createElement('span');
            enSlider.className = 'obse-toggle-slider';
            enWrap.appendChild(enChk);
            enWrap.appendChild(enSlider);
            row.appendChild(enWrap);

            // Gift picker button
            const btnGift = document.createElement('button');
            btnGift.className = 'obse-row-gift';
            btnGift.title = 'Click để chọn quà / đổi quà';
            if (m.giftId) {
                btnGift.innerHTML = `
                    ${m.giftImage ? `<img src="${m.giftImage}" onerror="this.style.display='none'"/>` : '<span class="obse-row-gift-noimg">🎁</span>'}
                    <span class="obse-row-gift-info">
                        <span class="obse-row-gift-name">${escapeHtml(m.giftName || '(chưa rõ tên)')}</span>
                        <span class="obse-row-gift-id">ID ${m.giftId}</span>
                    </span>`;
            } else {
                btnGift.innerHTML = `<span class="obse-row-gift-noimg">+</span><span class="obse-row-gift-info"><span class="obse-row-gift-name">Chọn quà</span></span>`;
            }
            btnGift.onclick = () => openGiftPicker(m.id);
            row.appendChild(btnGift);

            // Hotkey select
            const sel = document.createElement('select');
            sel.className = 'obse-row-hotkey';
            const optEmpty = document.createElement('option');
            optEmpty.value = ''; optEmpty.textContent = '— chọn effect —';
            sel.appendChild(optEmpty);
            const seen = new Set();
            cachedHotkeys.forEach(hk => {
                const o = document.createElement('option');
                o.value = hk; o.textContent = hk;
                sel.appendChild(o);
                seen.add(hk);
            });
            if (m.hotkey && !seen.has(m.hotkey)) {
                const o = document.createElement('option');
                o.value = m.hotkey;
                o.textContent = m.hotkey + ' (offline)';
                sel.appendChild(o);
            }
            sel.value = m.hotkey || '';
            sel.onchange = async () => {
                m.hotkey = sel.value;
                saveConfig();
                // Auto-suggest duration nếu mapping chưa có cooldown HOẶC user chưa custom
                // (chỉ overwrite khi cooldown=0 — tránh đè giá trị user đã chỉnh)
                if (m.hotkey && (!m.cooldownMs || m.cooldownMs === 0)) {
                    const suggested = await fetchSuggestedDurationMs(m.hotkey);
                    if (suggested > 0) {
                        m.cooldownMs = suggested;
                        saveConfig();
                        renderGroups();   // re-render để hiện số giây mới trong input
                        toast(`✓ Đã đề xuất ${(suggested/1000).toFixed(1)}s cho "${m.hotkey}" — chỉnh lại nếu cần`, 'success', 4000);
                    }
                }
            };
            row.appendChild(sel);

            // Action Name (tên hành động, hiển thị trong queue panel)
            const nameInp = document.createElement('input');
            nameInp.type = 'text';
            nameInp.className = 'obse-row-actionname';
            nameInp.placeholder = 'Tên hành động';
            nameInp.value = m.actionName || '';
            nameInp.title = 'Tên hành động hiển thị trong queue panel (vd "Hoa hồng đập chảo")';
            nameInp.oninput = () => { m.actionName = nameInp.value.trim().slice(0, 80); saveConfig(); };
            row.appendChild(nameInp);

            // Effect Duration — nhập SỐ GIÂY (lưu nội bộ vẫn là ms)
            // PHẢI ≥ duration thực tế của effect trong OBS (xem log dòng "TOTAL DURATION: ...ms")
            const cdWrap = document.createElement('label');
            cdWrap.className = 'obse-row-cd';
            cdWrap.title = 'Thời gian hiệu ứng (giây) — số giây effect chạy xong hoàn toàn.\nQuà tiếp theo trong hàng đợi chỉ phát SAU khi đủ thời gian này.\nXem OBS Script log dòng "TOTAL DURATION: ...ms" để biết số chính xác.';
            const cd = document.createElement('input');
            cd.type = 'number'; cd.min = '0'; cd.step = '0.5';
            cd.value = (Math.max(0, Number(m.cooldownMs) || 0) / 1000).toFixed(1);
            cd.placeholder = 'Giây';
            cd.oninput = () => {
                const sec = Math.max(0, Number(cd.value) || 0);
                m.cooldownMs = Math.round(sec * 1000);
                saveConfig();
            };
            cdWrap.appendChild(cd);
            const cdLbl = document.createElement('span');
            cdLbl.textContent = 'giây';
            cdWrap.appendChild(cdLbl);
            row.appendChild(cdWrap);

            // Test
            const btnTest = document.createElement('button');
            btnTest.className = 'obse-row-test';
            btnTest.textContent = '🔥';
            btnTest.title = 'Test trigger ngay (bỏ qua cooldown + queue)';
            btnTest.onclick = async () => {
                if (!m.hotkey) {
                    toast('⚠ Row này chưa chọn effect — pick effect từ dropdown trước', 'error');
                    return;
                }
                btnTest.disabled = true;
                try {
                    const r = await fetch('/api/obs-bridge/trigger', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hotkey: m.hotkey })
                    });
                    const j = await r.json();
                    if (!j.ok) {
                        const reasonMap = {
                            'unlicensed': 'License invalid — kích hoạt license trước',
                            'disconnected': 'Chưa kết nối OBS — bấm "Kết nối" bên trái',
                            'error': j.error || 'OBS trả lỗi'
                        };
                        toast('✗ ' + (reasonMap[j.reason] || j.reason || 'unknown'), 'error', 4000);
                    } else {
                        toast(`✓ Đã trigger "${m.hotkey}" — xem OBS preview`, 'success');
                    }
                } catch (e) { toast('✗ ' + e.message, 'error'); }
                finally { setTimeout(() => btnTest.disabled = false, 300); }
            };
            row.appendChild(btnTest);

            // Delete
            const btnDel = document.createElement('button');
            btnDel.className = 'obse-row-del';
            btnDel.textContent = '🗑';
            btnDel.title = 'Xóa mapping';
            btnDel.onclick = () => {
                cachedConfig.mapping = cachedConfig.mapping.filter(x => x.id !== m.id);
                saveConfig(true);
                renderGroups();
            };
            row.appendChild(btnDel);

            return row;
        }

        function addMappingToGroup(groupName) {
            // Default cooldown = 0 → tự được fill khi user chọn hotkey (theo registry server-side)
            // User có thể chỉnh lại sau khi test
            const m = normMapping({ group: groupName, cooldownMs: 0 });
            cachedConfig.mapping.push(m);
            saveConfig();
            renderGroups();
        }

        // ============== Gift Picker Modal ==============
        let gpFiltered = [];
        function openGiftPicker(mappingId) {
            gpTargetMappingId = mappingId;
            $gpSearch.value = '';
            $gpSort.value = 'diamond-asc';
            $gpModal.hidden = false;
            renderGiftPicker();
            setTimeout(() => $gpSearch.focus(), 50);
        }
        function closeGiftPicker() { $gpModal.hidden = true; gpTargetMappingId = null; }
        function renderGiftPicker() {
            const sheet = window.__giftSheet || [];
            const q = $gpSearch.value.trim().toLowerCase();
            const sort = $gpSort.value;
            let list = sheet.filter(g => {
                if (!q) return true;
                return String(g.id || '').toLowerCase().includes(q)
                    || String(g.name || '').toLowerCase().includes(q);
            });
            if (sort === 'diamond-asc')  list.sort((a, b) => (a.diamond || 0) - (b.diamond || 0));
            if (sort === 'diamond-desc') list.sort((a, b) => (b.diamond || 0) - (a.diamond || 0));
            if (sort === 'name')         list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            if (sort === 'id')           list.sort((a, b) => Number(a.id) - Number(b.id));
            gpFiltered = list;
            $gpCount.textContent = `${list.length} / ${sheet.length}`;
            $gpGrid.innerHTML = '';
            const frag = document.createDocumentFragment();
            list.slice(0, 500).forEach(g => {
                const c = document.createElement('div');
                c.className = 'obse-gp-card';
                c.innerHTML = `
                    <img src="${g.image || ''}" onerror="this.style.display='none'"/>
                    <div class="obse-gp-nm">${escapeHtml(g.name || '')}</div>
                    <div class="obse-gp-id">ID ${g.id}</div>
                    <div class="obse-gp-di">${g.diamond || 0}⭐</div>
                `;
                c.onclick = () => pickGift(g);
                frag.appendChild(c);
            });
            $gpGrid.appendChild(frag);
        }
        function pickGift(g) {
            const m = cachedConfig.mapping.find(x => x.id === gpTargetMappingId);
            if (!m) return;
            m.giftId = String(g.id);
            m.giftName = g.name || '';
            m.giftImage = g.image || '';
            saveConfig(true);
            closeGiftPicker();
            renderGroups();
        }

        // ============== Group Name Modal ==============
        function openGroupModal(mode, oldName) {
            grmMode = mode;
            grmRenameOldName = oldName || null;
            $grmTitle.textContent = mode === 'rename' ? `Đổi tên nhóm "${oldName}"` : 'Tạo nhóm mới';
            $grmInput.value = mode === 'rename' ? oldName : '';
            $grmModal.hidden = false;
            setTimeout(() => { $grmInput.focus(); $grmInput.select(); }, 50);
        }
        function closeGroupModal() { $grmModal.hidden = true; }
        function saveGroupModal() {
            const newName = $grmInput.value.trim();
            if (!newName) { $grmInput.focus(); return; }
            if (grmMode === 'rename' && grmRenameOldName) {
                // Rename: update tất cả mapping group == oldName → newName
                cachedConfig.mapping.forEach(m => {
                    if ((m.group || '') === grmRenameOldName) m.group = newName;
                });
                // Migrate collapsed state
                if (collapsedGroups.has(grmRenameOldName)) {
                    collapsedGroups.delete(grmRenameOldName);
                    collapsedGroups.add(newName);
                    persistCollapsed();
                }
                saveConfig(true);
                renderGroups();
            } else {
                // Create: tạo 1 mapping rỗng trong group này (để group hiển thị)
                addMappingToGroup(newName);
            }
            closeGroupModal();
        }

        // ============== Wire events ==============
        $btnConn.onclick = doConnect;
        $btnDisc.onclick = doDisconnect;
        $btnRefresh.onclick = async () => {
            await fetchHotkeys();
            toast(`✓ Đã tải ${cachedHotkeys.length} effect hotkey từ OBS`, 'success');
        };
        $btnAddGroup.onclick = () => openGroupModal('create');

        // Queue clear button
        if ($btnQueueClr) {
            $btnQueueClr.onclick = async (e) => {
                e.stopPropagation();
                try {
                    const r = await fetch('/api/obs-bridge/queue/clear', { method: 'POST' });
                    const j = await r.json();
                    toast(`🗑 Đã xóa ${j.removed || 0} effect khỏi hàng đợi`, 'success');
                    updateQueuePill(j.queue || { pending: 0 });
                } catch (e) { toast('✗ ' + e.message, 'error'); }
            };
        }
        $url.oninput  = () => { cachedConfig.url = $url.value.trim(); saveConfig(); };
        $pass.oninput = () => { cachedConfig.password = $pass.value; saveConfig(); };
        $auto.onchange = () => { cachedConfig.autoConnect = $auto.checked; saveConfig(true); };

        $gpClose.onclick = closeGiftPicker;
        $gpSearch.oninput = renderGiftPicker;
        $gpSort.onchange = renderGiftPicker;
        $gpModal.addEventListener('click', (e) => { if (e.target === $gpModal) closeGiftPicker(); });

        $grmClose.onclick = closeGroupModal;
        $grmCancel.onclick = closeGroupModal;
        $grmSave.onclick = saveGroupModal;
        $grmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveGroupModal(); });
        $grmModal.addEventListener('click', (e) => { if (e.target === $grmModal) closeGroupModal(); });

        // ESC close cho modals
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!$gpModal.hidden)  { closeGiftPicker();  return; }
            if (!$grmModal.hidden) { closeGroupModal();  return; }
        });

        // Helper
        function escapeHtml(s) {
            return String(s || '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
        }

        // Initial
        loadConfig();
    })();

    // ===== Police Force popup (FAB) =====
    function mountThuySidePanel(active = 'police') {
        const host = document.getElementById('thuy-side-panel-host');
        const police = document.getElementById('police-popup');
        const caught = document.getElementById('caught-popup');
        if (!host || !police || !caught) return;
        if (police.parentElement !== host) host.appendChild(police);
        if (caught.parentElement !== host) host.appendChild(caught);
        setThuySidePanel(active);
    }
    function setThuySidePanel(active) {
        const police = document.getElementById('police-popup');
        const caught = document.getElementById('caught-popup');
        const policeTab = document.getElementById('thuy-police-tab');
        const caughtTab = document.getElementById('thuy-caught-tab');
        const showCaught = active === 'caught';
        if (police) police.hidden = showCaught;
        if (caught) caught.hidden = !showCaught;
        policeTab?.classList.toggle('active', !showCaught);
        caughtTab?.classList.toggle('active', showCaught);
    }
    document.getElementById('thuy-police-tab')?.addEventListener('click', () => setThuySidePanel('police'));
    document.getElementById('thuy-caught-tab')?.addEventListener('click', () => setThuySidePanel('caught'));

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
            const thuyPoliceCount = document.getElementById('thuy-police-count');
            if (thuyPoliceCount) thuyPoliceCount.textContent = '0';
            return;
        }
        if (policeBadge) {
            policeBadge.hidden = false;
            policeBadge.textContent = String(members.length);
        }
        const thuyPoliceCount = document.getElementById('thuy-police-count');
        if (thuyPoliceCount) thuyPoliceCount.textContent = String(members.length);
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
            const thuyCaughtCount = document.getElementById('thuy-caught-count');
            if (thuyCaughtCount) thuyCaughtCount.textContent = '0';
            return;
        }
        if (caughtBadge) {
            caughtBadge.hidden = false;
            caughtBadge.textContent = String(active.length);
        }
        const thuyCaughtCount = document.getElementById('thuy-caught-count');
        if (thuyCaughtCount) thuyCaughtCount.textContent = String(active.length);
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
                    <div class="cp-top">
                        <div class="cp-name" title="${escAttrInline(c.name || 'Trộm')}">${escHtml(c.name || 'Trộm')}</div>
                        <span class="cp-cd">${left}s</span>
                    </div>
                    ${meta}
                </div>
                <button class="cp-bail" data-uid="${escAttrInline(c.uid || '')}" title="Bảo lãnh trộm này ra sớm" aria-label="Bảo lãnh">🔓</button>
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
        // Không tự kiểm tra/cài update khi đang vận hành bản chỉnh sửa tại chỗ.
        // Người dùng vẫn có thể kiểm tra thủ công trong Cài đặt.
    }

    // ===== Sidebar toggle thu/mở =====
    // Manual toggle (không auto hover) + persist qua localStorage.
    // Class .sidebar.collapsed cho child styling, .app.sidebar-collapsed cho grid track.
    function initSidebarToggle() {
        const btn = document.getElementById('sidebar-toggle');
        const sidebar = document.querySelector('.sidebar');
        const app = document.querySelector('.app');
        if (!btn || !sidebar || !app) return;
        localStorage.setItem('hp-sidebar-collapsed', '0');
        sidebar.classList.remove('collapsed');
        app.classList.remove('sidebar-collapsed');
        document.body.classList.remove('sidebar-collapsed');
        btn.hidden = true;
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

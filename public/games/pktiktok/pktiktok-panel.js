/* ============================================================
   HP PK TikTok — Panel controller (app side)
   ============================================================
   - Render grid 13 event cards
   - Upload file media qua POST /api/games/pktiktok/upload (server lưu vào DATA_DIR)
   - Bấm TEST → engine.trigger(key) → socket emit 'pktiktok:play' → overlay phát
   - Lưu config qua POST /api/games/pktiktok/config (debounced)

   Expose: window.HpPkTiktokPanel.open(socket)
   ============================================================ */
(function () {
    'use strict';

    let game = null;
    let socket = null;
    let cfg = null;
    let initialized = false;
    let pendingSave = null;
    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    window.HpPkTiktokPanel = {
        async open(sharedSocket) {
            socket = sharedSocket || window.io();
            if (!initialized) await init();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            $('#view-pktiktok')?.classList.add('active');
            renderGrid();
        },
        instance() { return game; },
    };

    async function init() {
        // Fetch config từ server
        try {
            const r = await fetch('/api/games/pktiktok/config');
            cfg = await r.json();
        } catch (e) {
            cfg = window.HpGame.pktiktok.defaultConfig();
        }

        game = window.HpGame.pktiktok.create({ config: cfg });

        // Engine fire 'play' → broadcast qua socket → overlay phát.
        // Server có authoritative state — nó đọc config event, build payload, emit cho overlay.
        game.on('play', (payload) => {
            fetch('/api/games/pktiktok/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'trigger', key: payload.key, source: payload.source }),
            }).catch(() => {});
            logTrigger(payload);
        });

        wireToolbar();
        wireOverlayCopy();
        wireUploadSettings();
        renderGrid();

        // Socket: nhận event auto-bind (nếu future có PK Đôi engine trong cùng project)
        if (socket) {
            socket.on('pktiktok:autoTrigger', (data) => {
                if (!cfg?.autoBindPkDuo) return;
                game.trigger(data?.key, { source: 'auto' });
            });
        }

        initialized = true;
    }

    function renderGrid() {
        const grid = $('#pktiktok-grid');
        if (!grid || !cfg) return;
        grid.innerHTML = cfg.events.map(ev => {
            const hasFile = !!ev.mediaUrl;
            const fileName = ev.mediaName || (ev.mediaUrl ? ev.mediaUrl.split('/').pop() : '');
            const typeBadge = hasFile ? (ev.mediaType === 'video' ? '🎞 VIDEO' : (ev.mediaType === 'audio' ? '🔊 ÂM' : '📄')) : '';
            return `<div class="pkfx-card${ev.enabled === false ? ' disabled' : ''}${hasFile ? ' has-file' : ''}" data-pkfx-key="${ev.key}">
                <div class="pkfx-card-head">
                    <span class="pkfx-card-emoji">${ev.emoji || '🎬'}</span>
                    <div class="pkfx-card-title">${escapeHtml(ev.label)}</div>
                    <label class="pkfx-card-toggle" title="Bật / Tắt sự kiện này">
                        <input type="checkbox" data-pkfx-toggle ${ev.enabled === false ? '' : 'checked'} />
                    </label>
                </div>
                <div class="pkfx-card-desc">${escapeHtml(ev.desc || '')}</div>
                <div class="pkfx-card-file" title="${escapeHtml(fileName)}">
                    ${hasFile
                        ? `<span class="pkfx-file-badge">${typeBadge}</span><span class="pkfx-file-name">${escapeHtml(fileName)}</span>`
                        : '<span class="pkfx-file-empty">Chưa chọn file — kéo thả vào đây hoặc bấm 📁 Chọn</span>'
                    }
                </div>
                <div class="pkfx-card-controls">
                    <label class="pkfx-vol" title="Âm lượng">🔊
                        <input type="range" min="0" max="100" step="5" value="${ev.volume ?? 100}" data-pkfx-vol />
                        <span data-pkfx-vol-v>${ev.volume ?? 100}%</span>
                    </label>
                </div>
                <div class="pkfx-card-actions">
                    <button type="button" class="ghost small" data-pkfx-pick>📁 Chọn</button>
                    <button type="button" class="primary small" data-pkfx-test ${hasFile ? '' : 'disabled'}>▶ TEST</button>
                    <button type="button" class="danger small" data-pkfx-clear ${hasFile ? '' : 'disabled'}>🗑</button>
                </div>
            </div>`;
        }).join('');
        wireCards();
        updateToolbarBadges();
    }

    function wireCards() {
        const grid = $('#pktiktok-grid');
        if (!grid) return;

        // Drag & drop highlight
        grid.querySelectorAll('.pkfx-card').forEach(card => {
            const key = card.dataset.pkfxKey;
            const ev = cfg.events.find(e => e.key === key);
            if (!ev) return;

            card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', async (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const file = e.dataTransfer?.files?.[0];
                if (file) await uploadFileToEvent(key, file);
            });

            card.querySelector('[data-pkfx-pick]')?.addEventListener('click', () => {
                pickFileForEvent(key);
            });
            card.querySelector('[data-pkfx-test]')?.addEventListener('click', () => {
                const r = game.trigger(key, { source: 'manual' });
                if (!r.ok) flashWarn(translateReason(r.reason));
            });
            card.querySelector('[data-pkfx-clear]')?.addEventListener('click', async () => {
                const name = ev.mediaName || 'file đã chọn';
                if (!confirm(`Xoá file "${name}" khỏi sự kiện "${ev.label}"?`)) return;
                ev.mediaUrl = ''; ev.mediaName = ''; ev.mediaType = '';
                await persistConfig();
                renderGrid();
            });
            card.querySelector('[data-pkfx-toggle]')?.addEventListener('change', async (e) => {
                ev.enabled = !!e.target.checked;
                card.classList.toggle('disabled', !ev.enabled);
                await persistConfig();
            });
            const vol = card.querySelector('[data-pkfx-vol]');
            const volV = card.querySelector('[data-pkfx-vol-v]');
            if (vol) {
                vol.addEventListener('input', () => {
                    ev.volume = +vol.value;
                    if (volV) volV.textContent = vol.value + '%';
                    schedulePersist();
                });
            }
        });
    }

    function pickFileForEvent(key) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,.mp4,.webm,.mp3,.wav,.ogg,.m4a';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = async () => {
            const f = inp.files?.[0];
            inp.remove();
            if (!f) return;
            await uploadFileToEvent(key, f);
        };
        inp.click();
    }

    async function uploadFileToEvent(key, file) {
        const ev = cfg.events.find(e => e.key === key);
        if (!ev) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
            flashWarn('Chỉ chấp nhận: mp4, webm, mp3, wav, ogg, m4a');
            return;
        }
        // Limit 30MB
        if (file.size > 30 * 1024 * 1024) {
            flashWarn('File quá 30MB — vui lòng nén lại');
            return;
        }
        const card = document.querySelector(`.pkfx-card[data-pkfx-key="${key}"]`);
        card?.classList.add('uploading');
        try {
            const url = `/api/games/pktiktok/upload?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}`;
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
            });
            const json = await r.json();
            if (!r.ok || !json.ok) throw new Error(json?.error || 'Upload thất bại');
            ev.mediaUrl = json.url;
            ev.mediaName = file.name;
            ev.mediaType = ['mp4', 'webm'].includes(ext) ? 'video' : 'audio';
            await persistConfig();
            renderGrid();
            flashOk(`Đã tải lên ${file.name}`);
        } catch (e) {
            flashWarn('Lỗi upload: ' + e.message);
        } finally {
            card?.classList.remove('uploading');
        }
    }

    function wireToolbar() {
        $('#pktiktok-enabled')?.addEventListener('change', async (e) => {
            cfg.enabled = !!e.target.checked;
            await persistConfig();
        });
        $('#pktiktok-autobind')?.addEventListener('change', async (e) => {
            cfg.autoBindPkDuo = !!e.target.checked;
            await persistConfig();
        });
        $('#pktiktok-show-label')?.addEventListener('change', async (e) => {
            cfg.display = cfg.display || {};
            cfg.display.showLabel = !!e.target.checked;
            await persistConfig();
        });
        $('#pktiktok-btn-stop')?.addEventListener('click', () => {
            game.stopAll();
            fetch('/api/games/pktiktok/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'stop' }),
            }).catch(() => {});
        });
        $('#pktiktok-btn-clear-all')?.addEventListener('click', async () => {
            if (!confirm('Xoá TẤT CẢ file media của 13 sự kiện?')) return;
            for (const ev of cfg.events) { ev.mediaUrl = ''; ev.mediaName = ''; ev.mediaType = ''; }
            await persistConfig();
            renderGrid();
        });
        $('#pktiktok-btn-test-all')?.addEventListener('click', async () => {
            // Test tuần tự — 1.5s mỗi event
            for (const ev of cfg.events) {
                if (!ev.mediaUrl || ev.enabled === false) continue;
                game.trigger(ev.key, { source: 'test-all' });
                await new Promise(r => setTimeout(r, 1500));
            }
        });
        // Initial UI sync
        if ($('#pktiktok-enabled')) $('#pktiktok-enabled').checked = cfg.enabled !== false;
        if ($('#pktiktok-autobind')) $('#pktiktok-autobind').checked = cfg.autoBindPkDuo !== false;
        if ($('#pktiktok-show-label')) $('#pktiktok-show-label').checked = !!cfg.display?.showLabel;
    }

    function wireOverlayCopy() {
        const inp = $('#pktiktok-overlay-url');
        const url = location.origin + '/overlay/pktiktok';
        if (inp) inp.value = url;
        $('#pktiktok-btn-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(url);
                flashOk('Đã copy link OBS overlay PK TikTok');
            } catch (e) { flashWarn('Copy thất bại — ' + e.message); }
        });
    }

    function wireUploadSettings() {
        // Future: thêm folder picker, batch upload, etc. — hiện tại để trống
    }

    function updateToolbarBadges() {
        const total = cfg.events.length;
        const filled = cfg.events.filter(e => e.mediaUrl).length;
        const el = $('#pktiktok-stats');
        if (el) el.textContent = `${filled}/${total} sự kiện đã gán media`;
    }

    function logTrigger(p) {
        const host = $('#pktiktok-log');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'pkfx-log-line';
        const time = new Date().toLocaleTimeString('vi-VN');
        const src = p.source === 'auto' ? '🤖' : (p.source === 'test-all' ? '🧪' : '👤');
        div.textContent = `${time} ${src} ${p.emoji} ${p.label}`;
        host.insertBefore(div, host.firstChild);
        while (host.children.length > 50) host.removeChild(host.lastChild);
    }

    function schedulePersist() {
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => persistConfig().catch(() => {}), 400);
    }
    async function persistConfig() {
        clearTimeout(pendingSave);
        const r = await fetch('/api/games/pktiktok/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg),
        });
        if (!r.ok) throw new Error('Save fail');
        if (game) game.setConfig(cfg);
        updateToolbarBadges();
    }

    function translateReason(reason) {
        return ({
            pkfx_disabled: 'PK TikTok đang TẮT — bật toolbar trên cùng',
            event_not_found: 'Không tìm thấy sự kiện',
            event_disabled: 'Sự kiện đang tắt',
            no_media: 'Sự kiện chưa gán file — bấm 📁 Chọn',
        })[reason] || reason;
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

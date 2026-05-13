/* ============================================================
   HP VIP Welcome — Panel controller (app side)
   ============================================================
   - Tab "Người chỉ định": list rules cho từng TikTok ID (join/gift)
   - Tab "Tất cả user": global rules (any user) với min level/diamond
   - Tab "Cài đặt": display + queue + cooldown
   - Tab "Hàng đợi": current queue + log gần nhất

   Server là authoritative — mọi rule check + queue đều ở server.
   Panel chỉ edit config, upload media, test rule, hiển thị log.
   ============================================================ */
(function () {
    'use strict';

    let socket = null;
    let cfg = null;
    let initialized = false;
    let pendingSave = null;
    let currentTab = 'users';

    // Các loại trigger TikTok event mà user-rule có thể chọn
    const TRIGGER_DEFS = [
        { id: 'join',     emoji: '🚪', label: 'Vào phòng' },
        { id: 'like',     emoji: '❤️', label: 'Táp tim' },
        { id: 'follow',   emoji: '➕', label: 'Follow LIVE' },
        { id: 'share',    emoji: '📤', label: 'Share LIVE' },
        { id: 'comment',  emoji: '💬', label: 'Comment' },
        { id: 'envelope', emoji: '🧧', label: 'Gửi bao lì xì' },
        { id: 'gift',     emoji: '🚀', label: 'Lên cấp (gift)' }
    ];
    function triggerLabel(id) {
        const t = TRIGGER_DEFS.find(x => x.id === id);
        return t ? `${t.emoji} ${t.label}` : id;
    }

    // 12 phong cách lời chúc — phải khớp với class style-* trong overlay.html
    const LABEL_STYLE_DEFS = [
        { id: 'goldpink', label: 'Vàng - Hồng', emoji: '🌟' },
        { id: 'royal',    label: 'Hoàng gia',   emoji: '👑' },
        { id: 'neon',     label: 'Neon Cyan',   emoji: '💎' },
        { id: 'fire',     label: 'Lửa',         emoji: '🔥' },
        { id: 'luxury',   label: 'Sang trọng',  emoji: '✨' },
        { id: 'pastel',   label: 'Pastel',      emoji: '🌸' },
        { id: 'emerald',  label: 'Ngọc lục bảo',emoji: '🍃' },
        { id: 'ocean',    label: 'Đại dương',   emoji: '🌊' },
        { id: 'vietnam',  label: 'Việt Nam',    emoji: '⭐' },
        { id: 'rainbow',  label: 'Cầu vồng',    emoji: '🌈' },
        { id: 'glass',    label: 'Kính mờ',     emoji: '🪟' },
        { id: 'cyber',    label: 'Cyber Punk',  emoji: '🤖' }
    ];

    const $ = (sel, ctx = document) => ctx.querySelector(sel);

    window.HpVipWelcomePanel = {
        async open(sharedSocket) {
            socket = sharedSocket || window.io();
            if (!initialized) await init();
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            $('#view-vipwelcome')?.classList.add('active');
            render();
            fetchQueueSnapshot();
            startStatusPoll();
        }
    };

    // Poll user-rule status periodically — hiển thị countdown / ready trên rule card
    let statusPollTimer = null;
    async function pollUserStatus() {
        try {
            const view = document.querySelector('#view-vipwelcome');
            const usersPane = document.querySelector('.vw-pane.active[data-vw-pane="users"]');
            // Chỉ poll khi đang ở tab Người chỉ định để tiết kiệm
            if (!view?.classList.contains('active') || !usersPane) return;
            const r = await fetch('/api/games/vipwelcome/user-status');
            const j = await r.json();
            for (const ruleId of Object.keys(j.statuses || {})) {
                const s = j.statuses[ruleId];
                const el = document.querySelector(`[data-vw-rule-status="${ruleId}"]`);
                if (!el) continue;
                let text = '';
                let cls = 'vw-rule-status';
                if (s.status === 'idle') {
                    text = '⏳ Chưa thấy user trong phiên — sẵn sàng fire khi user xuất hiện';
                    cls += ' status-idle';
                } else if (s.status === 'fired') {
                    text = `✅ Đã fire — chờ user xuất hiện lại (sau ${s.thresholdSec}s vắng mặt)`;
                    cls += ' status-fired';
                } else if (s.status === 'inRoom') {
                    text = `👁 User đang trong phòng (đã fire ${s.secondsSinceFire}s trước) — chờ vắng mặt ${s.secondsUntilRejoinEligible}s nữa mới re-fire`;
                    cls += ' status-inroom';
                } else if (s.status === 'readyForRejoin') {
                    text = `🟢 SẴN SÀNG re-fire! (user đã vắng mặt ${s.secondsSinceSeen}s${s.droppedOutOfSeq ? ' + rời khỏi top contributors' : ''})`;
                    cls += ' status-ready';
                }
                el.className = cls;
                const textEl = el.querySelector('.vw-rule-status-text');
                if (textEl) textEl.textContent = text;
                else el.textContent = text;
                // Fire count badge
                const fcEl = document.querySelector(`[data-vw-rule-firecount="${ruleId}"]`);
                if (fcEl) {
                    if (s.fireCount > 0) {
                        fcEl.hidden = false;
                        fcEl.textContent = `🔥 ${s.fireCount}`;
                    } else {
                        fcEl.hidden = true;
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }
    function startStatusPoll() {
        if (statusPollTimer) return;
        pollUserStatus();
        statusPollTimer = setInterval(pollUserStatus, 2000);
    }

    async function init() {
        try {
            const r = await fetch('/api/games/vipwelcome/config');
            cfg = await r.json();
        } catch (e) {
            cfg = window.HpGame.vipwelcome.defaultConfig();
        }
        // Đồng bộ defaults nếu config thiếu field (vd: bản app cũ)
        const def = window.HpGame.vipwelcome.defaultConfig();
        cfg = deepMerge(def, cfg || {});
        // Migrate inline: nếu config từ server vẫn ở schema cũ (không có profiles) thì wrap.
        if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
            const p = window.HpGame.vipwelcome.newProfile('Nhóm mặc định');
            if (Array.isArray(cfg.userRules)) p.userRules = cfg.userRules;
            if (cfg.globalJoin) Object.assign(p.globalJoin, cfg.globalJoin);
            if (cfg.globalGift) Object.assign(p.globalGift, cfg.globalGift);
            cfg.profiles = [p];
            cfg.activeProfileId = p.id;
            delete cfg.userRules; delete cfg.globalJoin; delete cfg.globalGift;
        }
        // Ensure activeProfileId valid
        const ids = cfg.profiles.map(p => p.id);
        if (!ids.includes(cfg.activeProfileId)) cfg.activeProfileId = cfg.profiles[0].id;

        wireOverlayCopy();
        wireTabs();
        wireToolbar();
        wireQueueButtons();
        wireProfileBar();

        // Socket listeners — log trigger realtime
        if (socket) {
            socket.on('vipwelcome:log', (entry) => addLogLine(entry));
            socket.on('vipwelcome:logCleared', () => {
                const log = $('#vw-log');
                if (log) log.innerHTML = '<div class="vw-empty">Chưa có log nào.</div>';
            });
            socket.on('vipwelcome:queue', (data) => {
                const el = $('#vipwelcome-queue-size');
                if (el) el.textContent = data?.size ?? 0;
            });
        }

        initialized = true;
    }

    // === Custom prompt modal — Electron block window.prompt(), tự build modal đơn giản ===
    function vwPrompt(title, defaultValue) {
        return new Promise((resolve) => {
            // Tạo overlay + card lần đầu, reuse cho lần sau
            let overlay = document.getElementById('vw-prompt-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'vw-prompt-overlay';
                overlay.className = 'vw-prompt-overlay';
                overlay.innerHTML = `
                    <div class="vw-prompt-card">
                        <div class="vw-prompt-title" id="vw-prompt-title"></div>
                        <input type="text" id="vw-prompt-input" class="vw-prompt-input" autocomplete="off" spellcheck="false" />
                        <div class="vw-prompt-actions">
                            <button class="ghost" id="vw-prompt-cancel">Huỷ</button>
                            <button class="primary" id="vw-prompt-ok">OK</button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);
            }
            const titleEl = overlay.querySelector('#vw-prompt-title');
            const inputEl = overlay.querySelector('#vw-prompt-input');
            const okBtn = overlay.querySelector('#vw-prompt-ok');
            const cancelBtn = overlay.querySelector('#vw-prompt-cancel');
            titleEl.textContent = title || 'Nhập giá trị:';
            inputEl.value = defaultValue == null ? '' : String(defaultValue);
            overlay.classList.add('show');
            setTimeout(() => { inputEl.focus(); inputEl.select(); }, 30);
            function cleanup(val) {
                overlay.classList.remove('show');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                inputEl.removeEventListener('keydown', onKey);
                overlay.removeEventListener('click', onBackdrop);
                resolve(val);
            }
            function onOk() { cleanup(inputEl.value.trim() || null); }
            function onCancel() { cleanup(null); }
            function onKey(e) {
                if (e.key === 'Enter') { e.preventDefault(); onOk(); }
                else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }
            function onBackdrop(e) { if (e.target === overlay) onCancel(); }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            inputEl.addEventListener('keydown', onKey);
            overlay.addEventListener('click', onBackdrop);
        });
    }

    // === Profile helpers ===
    function activeProfile() {
        if (!cfg || !Array.isArray(cfg.profiles)) return null;
        return cfg.profiles.find(p => p.id === cfg.activeProfileId) || cfg.profiles[0] || null;
    }

    // Collapse state persisted in localStorage (per-app, không cần đẩy server)
    function getProfileBarCollapsed() {
        try { return localStorage.getItem('vw-profile-bar-collapsed') === '1'; } catch (e) { return false; }
    }
    function setProfileBarCollapsed(v) {
        try { localStorage.setItem('vw-profile-bar-collapsed', v ? '1' : '0'); } catch (e) {}
        applyProfileBarCollapsed();
    }
    function applyProfileBarCollapsed() {
        const bar = document.getElementById('vw-profile-bar');
        const btn = document.getElementById('vw-profile-collapse');
        if (!bar || !btn) return;
        const collapsed = getProfileBarCollapsed();
        bar.classList.toggle('collapsed', collapsed);
        btn.textContent = collapsed ? '▶' : '▼';
        btn.title = collapsed ? 'Mở rộng thanh nhóm' : 'Thu gọn thanh nhóm';
        const nameEl = document.getElementById('vw-profile-active-name');
        if (nameEl) {
            if (collapsed) {
                const p = activeProfile();
                nameEl.textContent = p ? `▸ ${p.name}` : '';
                nameEl.hidden = false;
            } else {
                nameEl.hidden = true;
            }
        }
    }

    function wireProfileBar() {
        $('#vw-profile-collapse')?.addEventListener('click', () => {
            setProfileBarCollapsed(!getProfileBarCollapsed());
        });
        applyProfileBarCollapsed();
        $('#vw-btn-new-profile')?.addEventListener('click', async () => {
            const name = await vwPrompt('Tên nhóm hồ sơ mới:', `Nhóm ${(cfg.profiles?.length || 0) + 1}`);
            if (!name) return;
            const p = window.HpGame.vipwelcome.newProfile(name);
            cfg.profiles.push(p);
            cfg.activeProfileId = p.id;
            await persistConfig();
            render();
            flashOk(`Đã tạo nhóm "${p.name}"`);
        });
        $('#vw-btn-rename-profile')?.addEventListener('click', async () => {
            const p = activeProfile(); if (!p) return;
            const name = await vwPrompt('Tên nhóm mới:', p.name);
            if (!name || name === p.name) return;
            p.name = name;
            await persistConfig();
            renderProfileChips();
            renderGlobalTab();
            renderUserRulesTab();
            flashOk('Đã đổi tên nhóm');
        });
        $('#vw-btn-clone-profile')?.addEventListener('click', async () => {
            const src = activeProfile(); if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = window.HpGame.vipwelcome.newProfileId();
            clone.name = src.name + ' (bản sao)';
            // Đổi id cho mỗi userRule để cooldown không đè
            for (const r of (clone.userRules || [])) r.id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            cfg.profiles.push(clone);
            cfg.activeProfileId = clone.id;
            await persistConfig();
            render();
            flashOk(`Đã nhân bản → "${clone.name}"`);
        });
        // Export profile to JSON file
        $('#vw-btn-export-profile')?.addEventListener('click', () => {
            const p = activeProfile(); if (!p) return;
            // Snapshot — cloning để không expose id thực tế (sẽ regenerate khi import)
            const exportObj = {
                _hpExport: 'vipwelcome-profile',
                _version: 1,
                _exportedAt: new Date().toISOString(),
                profile: JSON.parse(JSON.stringify(p))
            };
            // Strip ID — sẽ regenerate khi import
            delete exportObj.profile.id;
            for (const r of (exportObj.profile.userRules || [])) delete r.id;
            const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const safeName = (p.name || 'nhom').replace(/[^\w\-]+/g, '_').slice(0, 40);
            a.download = `vipwelcome-${safeName}-${Date.now().toString(36)}.json`;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
            flashOk(`Đã xuất nhóm "${p.name}" — file đang tải xuống`);
        });
        // Import profile from JSON
        $('#vw-btn-import-profile')?.addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
            document.body.appendChild(inp);
            inp.onchange = async () => {
                const f = inp.files?.[0]; inp.remove();
                if (!f) return;
                try {
                    const txt = await f.text();
                    const obj = JSON.parse(txt);
                    if (!obj || obj._hpExport !== 'vipwelcome-profile' || !obj.profile) {
                        flashWarn('File không phải dạng VIP Welcome profile hợp lệ');
                        return;
                    }
                    const imported = obj.profile;
                    // Regenerate IDs
                    imported.id = window.HpGame.vipwelcome.newProfileId();
                    imported.name = (imported.name || 'Nhóm import') + ' (import)';
                    if (Array.isArray(imported.userRules)) {
                        for (const r of imported.userRules) r.id = window.HpGame.vipwelcome.newRuleId();
                    }
                    cfg.profiles = cfg.profiles || [];
                    cfg.profiles.push(imported);
                    cfg.activeProfileId = imported.id;
                    await persistConfig();
                    render();
                    flashOk(`Đã import nhóm "${imported.name}" — ${(imported.userRules || []).length} user rule`);
                } catch (e) {
                    flashWarn('Lỗi import: ' + e.message);
                }
            };
            inp.click();
        });
        $('#vw-btn-delete-profile')?.addEventListener('click', async () => {
            const p = activeProfile(); if (!p) return;
            if (cfg.profiles.length <= 1) {
                flashWarn('Cần ít nhất 1 nhóm — không thể xoá nhóm cuối cùng');
                return;
            }
            const ok = await (window.hpConfirm ? window.hpConfirm({
                icon: '🗑', tone: 'danger',
                title: 'Xoá nhóm hồ sơ',
                body: `Xoá nhóm <b>"${escapeHtml(p.name)}"</b>?<br><span style="color:#8b93a8">Mọi rule + cài đặt trong nhóm này sẽ MẤT vĩnh viễn.</span>`,
                okLabel: 'Xoá nhóm', cancelLabel: 'Huỷ'
            }) : Promise.resolve(confirm(`Xoá nhóm "${p.name}"?`)));
            if (!ok) return;
            cfg.profiles = cfg.profiles.filter(x => x.id !== p.id);
            cfg.activeProfileId = cfg.profiles[0].id;
            await persistConfig();
            render();
            flashOk('Đã xoá nhóm');
        });
    }

    function renderProfileChips() {
        const host = $('#vw-profile-chips');
        if (!host) return;
        // Update collapsed-mode active-name display
        applyProfileBarCollapsed();
        const profiles = cfg.profiles || [];
        host.innerHTML = profiles.map(p => {
            const isActive = p.id === cfg.activeProfileId;
            return `<div class="vw-profile-chip${isActive ? ' active' : ''}${p.enabled ? ' on' : ' off'}" data-vw-profile-id="${p.id}" title="${p.enabled ? 'Đang BẬT' : 'Đang TẮT'} — bấm vào ô để chọn nhóm. Bấm checkbox để bật/tắt.">
                <label class="vw-profile-toggle" title="Bật / Tắt nhóm này (không cần chọn để bật)">
                    <input type="checkbox" data-vw-profile-enabled ${p.enabled ? 'checked' : ''} />
                </label>
                <span class="vw-profile-name">${escapeHtml(p.name)}</span>
                <span class="vw-profile-count" title="Số rule cá nhân + số rule chung">${(p.userRules?.length || 0)}+${(p.globalJoin?.enabled ? 1 : 0) + (p.globalGift?.enabled ? 1 : 0)}</span>
            </div>`;
        }).join('');
        // Wire chips — toàn chip clickable để chọn nhóm (hit area lớn).
        // Checkbox dùng stopPropagation để toggle độc lập, không trigger chọn.
        host.querySelectorAll('.vw-profile-chip').forEach(chip => {
            const pid = chip.dataset.vwProfileId;
            // Click bất kỳ đâu trong chip → pick (trừ click vào checkbox/label toggle)
            chip.addEventListener('click', async (e) => {
                // Defensive: skip nếu click vào input checkbox HOẶC label toggle
                if (e.target.matches?.('[data-vw-profile-enabled]')) return;
                if (e.target.closest?.('.vw-profile-toggle')) return;
                if (cfg.activeProfileId === pid) return;
                cfg.activeProfileId = pid;
                await persistConfig();
                render();
            });
            const cb = chip.querySelector('[data-vw-profile-enabled]');
            if (cb) {
                cb.addEventListener('click', (e) => { e.stopPropagation(); });
                cb.addEventListener('change', async (e) => {
                    e.stopPropagation();
                    const p = cfg.profiles.find(x => x.id === pid); if (!p) return;
                    p.enabled = !!e.target.checked;
                    await persistConfig();
                    renderProfileChips();
                });
            }
            const toggleLabel = chip.querySelector('.vw-profile-toggle');
            toggleLabel?.addEventListener('click', (e) => { e.stopPropagation(); });
        });
    }

    function deepMerge(base, patch) {
        const out = { ...base };
        for (const k of Object.keys(patch || {})) {
            const v = patch[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                out[k] = deepMerge(base[k] || {}, v);
            } else if (v !== undefined) out[k] = v;
        }
        return out;
    }

    function wireTabs() {
        const tabs = document.querySelectorAll('#view-vipwelcome .vw-tab');
        tabs.forEach(t => {
            t.addEventListener('click', () => {
                tabs.forEach(x => x.classList.remove('active'));
                t.classList.add('active');
                currentTab = t.dataset.vwTab;
                document.querySelectorAll('#view-vipwelcome .vw-pane').forEach(p => {
                    p.classList.toggle('active', p.dataset.vwPane === currentTab);
                });
                if (currentTab === 'queue') fetchQueueSnapshot();
            });
        });
    }

    function wireToolbar() {
        $('#vipwelcome-enabled')?.addEventListener('change', async (e) => {
            cfg.enabled = !!e.target.checked;
            await persistConfig();
        });
    }

    function wireOverlayCopy() {
        const inp = $('#vipwelcome-overlay-url');
        const url = location.origin + '/overlay/vipwelcome';
        if (inp) inp.value = url;
        $('#vipwelcome-btn-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(url);
                flashOk('Đã copy link OBS overlay VIP');
            } catch (e) { flashWarn('Copy thất bại'); }
        });
        $('#vipwelcome-btn-stop')?.addEventListener('click', async () => {
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'stop' })
            });
            flashOk('Đã dừng + xoá hàng đợi');
        });
        $('#vipwelcome-btn-reload')?.addEventListener('click', async () => {
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'reloadOverlay' })
            });
            flashOk('Đã gửi lệnh reload — mọi overlay OBS sẽ refresh trong 1s');
        });
    }

    function wireQueueButtons() {
        $('#vipwelcome-btn-clear-queue')?.addEventListener('click', async () => {
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'clearQueue' })
            });
            fetchQueueSnapshot();
            flashOk('Đã xoá hàng đợi');
        });
        $('#vipwelcome-btn-clear-log')?.addEventListener('click', async () => {
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'clearLog' })
            });
            const log = $('#vw-log');
            if (log) log.innerHTML = '<div class="vw-empty">Chưa có log nào.</div>';
            flashOk('Đã xoá log');
        });
        $('#vipwelcome-btn-reset-cooldown')?.addEventListener('click', async () => {
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'resetCooldown' })
            });
            flashOk('Đã reset cooldown tất cả user');
        });
        $('#vipwelcome-btn-reset-session')?.addEventListener('click', async () => {
            if (!confirm('Reset toàn bộ session state? Tất cả user đã fire trong phiên này sẽ được fire lại nếu họ tiếp tục tương tác.')) return;
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'resetSession' })
            });
            flashOk('Đã reset phiên — user sẽ fire lại khi có tương tác mới');
        });
    }

    function render() {
        if (!cfg) return;
        $('#vipwelcome-enabled') && ($('#vipwelcome-enabled').checked = cfg.enabled !== false);
        renderProfileChips();
        renderUserRulesTab();
        renderGlobalTab();
        renderSettingsTab();
    }

    // ============================================================
    // TAB 1: USER RULES
    // ============================================================
    function renderUserRulesTab() {
        const host = $('#vw-user-rules-list');
        if (!host) return;
        const profile = activeProfile();
        const rules = (profile?.userRules) || [];
        if (rules.length === 0) {
            host.innerHTML = `<div class="vw-empty">Nhóm <b>"${escapeHtml(profile?.name || '')}"</b> chưa có user. Bấm "➕ Thêm user" để cài hiệu ứng cho 1 TikTok ID cụ thể.</div>`;
        } else {
            host.innerHTML = rules.map(r => renderUserRuleCard(r)).join('');
            wireUserRuleCards();
        }
        // Re-wire buttons mỗi lần render
        $('#vw-btn-add-user-rule')?.addEventListener('click', addUserRule, { once: true });
        $('#vw-btn-test-all')?.addEventListener('click', testAllRules, { once: true });
        // Search filter — keep state across re-renders via input itself
        const searchEl = $('#vw-rule-search');
        if (searchEl && !searchEl._vwWired) {
            searchEl._vwWired = true;
            searchEl.addEventListener('input', () => applyRuleSearchFilter(searchEl.value));
        }
        if (searchEl?.value) applyRuleSearchFilter(searchEl.value);
    }

    function applyRuleSearchFilter(query) {
        const q = String(query || '').toLowerCase().trim();
        const cards = document.querySelectorAll('#vw-user-rules-list .vw-rule-card');
        let hidden = 0;
        cards.forEach(card => {
            const ruleId = card.dataset.vwRule;
            const p = activeProfile();
            const rule = (p?.userRules || []).find(r => r.id === ruleId);
            if (!rule) return;
            const haystack = (
                (rule.uniqueId || '') + ' ' +
                (rule.message || '') + ' ' +
                (rule.mediaName || '') + ' ' +
                (rule.trigger || '')
            ).toLowerCase();
            const match = !q || haystack.includes(q);
            card.style.display = match ? '' : 'none';
            if (!match) hidden++;
        });
    }

    async function testAllRules() {
        const profile = activeProfile();
        if (!profile) return flashWarn('Không có nhóm');
        const items = [];
        for (const r of (profile.userRules || [])) {
            if (r.enabled !== false && r.mediaUrl) {
                items.push({ kind: 'user', ruleId: r.id, label: '@' + r.uniqueId });
            }
        }
        if (profile.globalJoin?.enabled && profile.globalJoin?.mediaUrl) items.push({ kind: 'globalJoin', label: 'Tất cả vào phòng' });
        if (profile.globalGift?.enabled && profile.globalGift?.mediaUrl) items.push({ kind: 'globalGift', label: 'Tất cả lên cấp' });
        if (items.length === 0) return flashWarn('Không có rule nào ENABLED + có media để test');
        flashOk(`Test ${items.length} rule lần lượt...`);
        const gapMs = Math.max(800, (cfg.queue?.perItemMinMs || 200) + 600);
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const payload = it.kind === 'user'
                ? { profileId: cfg.activeProfileId, ruleType: 'user', ruleId: it.ruleId, uniqueId: 'tester', nickname: 'Test', level: 99 }
                : { profileId: cfg.activeProfileId, ruleType: it.kind, uniqueId: 'tester', nickname: 'Test', level: 99, giftName: 'Quà thử' };
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'test', payload })
            });
            if (i < items.length - 1) await new Promise(r => setTimeout(r, gapMs));
        }
        flashOk(`Xong — đã fire ${items.length} rule`);
    }

    function renderUserRuleCard(r) {
        const hasFile = !!r.mediaUrl;
        const fileName = r.mediaName || (r.mediaUrl ? r.mediaUrl.split('/').pop() : '');
        const typeBadge = hasFile ? (r.mediaType === 'video' ? '🎞 VIDEO' : (r.mediaType === 'audio' ? '🔊 ÂM' : '📄')) : '';
        const triggerDef = TRIGGER_DEFS.find(t => t.id === r.trigger) || TRIGGER_DEFS[0];
        const ruleStyleOptions = ['<option value="">— Theo phong cách nhóm —</option>']
            .concat(LABEL_STYLE_DEFS.map(s => `<option value="${s.id}" ${r.labelStyle === s.id ? 'selected' : ''}>${s.emoji} ${escapeHtml(s.label)}</option>`));
        return `<div class="vw-rule-card${r.enabled === false ? ' disabled' : ''}${hasFile ? ' has-file' : ''}" data-vw-rule="${r.id}">
            <div class="vw-rule-status" data-vw-rule-status="${r.id}">
                <span class="vw-rule-status-text">⏳ Đang chờ user...</span>
                <span class="vw-rule-fire-count" data-vw-rule-firecount="${r.id}" title="Số lần fire trong phiên này" hidden>🔥 0</span>
            </div>
            <div class="vw-rule-head">
                <span class="vw-rule-emoji">${triggerDef.emoji}</span>
                <input type="text" class="vw-rule-uid" placeholder="@tiktok_id" data-vw-uid value="${escapeHtml(r.uniqueId || '')}" />
                <select data-vw-trigger class="vw-rule-trigger">
                    ${TRIGGER_DEFS.map(t => `<option value="${t.id}" ${r.trigger === t.id ? 'selected' : ''}>${t.emoji} ${escapeHtml(t.label)}</option>`).join('')}
                </select>
                <label class="vw-rule-toggle" title="Bật / Tắt rule"><input type="checkbox" data-vw-toggle ${r.enabled === false ? '' : 'checked'} /></label>
                <button class="ghost mini" data-vw-clone title="Sao chép rule này">📋</button>
                <button class="ghost mini danger" data-vw-delete title="Xoá rule">🗑</button>
            </div>
            <div class="vw-rule-file" title="${escapeHtml(fileName)}">
                ${hasFile
                    ? `<span class="vw-file-badge">${typeBadge}</span><span class="vw-file-name">${escapeHtml(fileName)}</span>`
                    : '<span class="vw-file-empty">Chưa chọn file — bấm "📁 Chọn" hoặc kéo thả file vào đây</span>'
                }
            </div>
            <div class="vw-rule-row">
                <label class="vw-inline">🔊 <input type="range" min="0" max="100" step="5" value="${r.volume ?? 100}" data-vw-volume />
                    <span data-vw-volume-v>${r.volume ?? 100}%</span>
                </label>
            </div>
            <div class="vw-rule-row">
                <label class="vw-inline vw-msg-row">💬 Lời chúc:
                    <input type="text" placeholder="VD: Chào {nickname} đã ghé phòng!" data-vw-message value="${escapeHtml(r.message || '')}" />
                </label>
            </div>
            <div class="vw-rule-row">
                <label class="vw-inline">🎨 Phong cách
                    <select data-vw-rule-style>
                        ${ruleStyleOptions.join('')}
                    </select>
                </label>
            </div>
            <div class="vw-rule-actions">
                <button class="ghost small" data-vw-pick>📁 Chọn file</button>
                <button class="primary small" data-vw-test ${hasFile ? '' : 'disabled'}>▶ TEST</button>
                <button class="danger small" data-vw-clear-file ${hasFile ? '' : 'disabled'}>🗑 Xoá file</button>
            </div>
        </div>`;
    }

    function wireUserRuleCards() {
        document.querySelectorAll('#vw-user-rules-list .vw-rule-card').forEach(card => {
            const ruleId = card.dataset.vwRule;
            const getRule = () => {
                const p = activeProfile();
                return (p?.userRules || []).find(r => r.id === ruleId);
            };

            // Drag & drop
            card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', async (e) => {
                e.preventDefault(); card.classList.remove('drag-over');
                const file = e.dataTransfer?.files?.[0];
                if (file) await uploadFileToRule(ruleId, file);
            });

            card.querySelector('[data-vw-uid]')?.addEventListener('input', (e) => {
                const r = getRule(); if (!r) return;
                r.uniqueId = e.target.value.replace(/^@/, '').trim();
                schedulePersist();
            });
            card.querySelector('[data-vw-trigger]')?.addEventListener('change', (e) => {
                const r = getRule(); if (!r) return;
                r.trigger = e.target.value;
                renderUserRulesTab();
            });
            card.querySelector('[data-vw-toggle]')?.addEventListener('change', (e) => {
                const r = getRule(); if (!r) return;
                r.enabled = !!e.target.checked;
                card.classList.toggle('disabled', !r.enabled);
                schedulePersist();
            });
            card.querySelector('[data-vw-delete]')?.addEventListener('click', async () => {
                const r = getRule(); if (!r) return;
                const ok = await (window.hpConfirm ? window.hpConfirm({
                    icon: '🗑', tone: 'danger',
                    title: 'Xoá rule',
                    body: `Xoá rule cho <b>@${escapeHtml(r.uniqueId || '(chưa đặt ID)')}</b>?<br><span style="color:#8b93a8">Hành động này không thể hoàn tác.</span>`,
                    okLabel: 'Xoá', cancelLabel: 'Huỷ'
                }) : Promise.resolve(confirm(`Xoá rule cho @${r.uniqueId || '(chưa đặt ID)'}?`)));
                if (!ok) return;
                const p = activeProfile(); if (!p) return;
                p.userRules = (p.userRules || []).filter(x => x.id !== ruleId);
                renderUserRulesTab();
                renderProfileChips();
                persistConfig();
            });
            // Sao chép rule
            card.querySelector('[data-vw-clone]')?.addEventListener('click', () => {
                const r = getRule(); if (!r) return;
                const p = activeProfile(); if (!p) return;
                const clone = JSON.parse(JSON.stringify(r));
                clone.id = window.HpGame.vipwelcome.newRuleId();
                clone.uniqueId = '';   // đợi user điền ID mới
                p.userRules.push(clone);
                renderUserRulesTab();
                renderProfileChips();
                persistConfig();
                flashOk('Đã sao chép — điền TikTok ID mới cho bản sao');
            });
            // Sub-style per rule (override profile default)
            card.querySelector('[data-vw-rule-style]')?.addEventListener('change', (e) => {
                const r = getRule(); if (!r) return;
                r.labelStyle = e.target.value || '';
                schedulePersist();
            });
            card.querySelector('[data-vw-pick]')?.addEventListener('click', () => pickFileForRule(ruleId));
            card.querySelector('[data-vw-clear-file]')?.addEventListener('click', () => {
                const r = getRule(); if (!r || !r.mediaUrl) return;
                if (!confirm(`Xoá file "${r.mediaName || ''}" khỏi rule này?`)) return;
                r.mediaUrl = ''; r.mediaName = ''; r.mediaType = '';
                renderUserRulesTab(); persistConfig();
            });
            card.querySelector('[data-vw-test]')?.addEventListener('click', async () => {
                const r = getRule(); if (!r) return;
                if (!r.mediaUrl) { flashWarn('Chưa chọn file'); return; }
                await fetch('/api/games/vipwelcome/trigger', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'test', payload: {
                            profileId: cfg.activeProfileId,
                            ruleType: 'user', ruleId,
                            uniqueId: r.uniqueId || 'tester',
                            nickname: r.uniqueId || 'Người Thử',
                            level: Math.max(r.minLevel || 30, 30),
                            giftName: 'Quà thử'
                        }
                    })
                });
                flashOk('Đã test');
            });
            const vol = card.querySelector('[data-vw-volume]');
            const volV = card.querySelector('[data-vw-volume-v]');
            vol?.addEventListener('input', () => {
                const r = getRule(); if (!r) return;
                r.volume = +vol.value;
                if (volV) volV.textContent = vol.value + '%';
                schedulePersist();
            });
            card.querySelector('[data-vw-message]')?.addEventListener('input', (e) => {
                const r = getRule(); if (!r) return;
                r.message = e.target.value;
                schedulePersist();
            });
        });
    }

    function addUserRule() {
        const p = activeProfile();
        if (!p) { flashWarn('Chưa có nhóm — bấm "➕ Tạo nhóm" trước'); return; }
        const r = window.HpGame.vipwelcome.newUserRule();
        p.userRules = p.userRules || [];
        p.userRules.push(r);
        renderUserRulesTab();
        renderProfileChips();
        persistConfig();
    }

    function pickFileForRule(ruleId) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,.mp4,.webm,.mp3,.wav,.ogg,.m4a';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = async () => {
            const f = inp.files?.[0]; inp.remove();
            if (!f) return;
            await uploadFileToRule(ruleId, f);
        };
        inp.click();
    }

    async function uploadFileToRule(ruleId, file) {
        const p = activeProfile(); if (!p) return;
        const r = (p.userRules || []).find(x => x.id === ruleId);
        if (!r) return;
        await uploadFileToTarget(file, (meta) => {
            r.mediaUrl = meta.url;
            r.mediaName = file.name;
            r.mediaType = meta.type;
        }, () => renderUserRulesTab());
    }

    // ============================================================
    // TAB 2: GLOBAL (all users)
    // ============================================================
    function renderGlobalTab() {
        renderGlobalCard('join');
        renderGlobalCard('gift');
    }

    function renderGlobalCard(kind) {
        const host = $(kind === 'join' ? '#vw-global-join-card' : '#vw-global-gift-card');
        if (!host) return;
        const profile = activeProfile();
        if (!profile) { host.innerHTML = ''; return; }
        const g = kind === 'join' ? profile.globalJoin : profile.globalGift;
        const titleEmoji = kind === 'join' ? '🚪' : '🚀';
        const titleText = kind === 'join'
            ? `[${profile.name}] TẤT CẢ USER — Vào phòng`
            : `[${profile.name}] TẤT CẢ USER — Lên cấp`;
        const hasFile = !!g.mediaUrl;
        const fileName = g.mediaName || (g.mediaUrl ? g.mediaUrl.split('/').pop() : '');
        const typeBadge = hasFile ? (g.mediaType === 'video' ? '🎞 VIDEO' : (g.mediaType === 'audio' ? '🔊 ÂM' : '📄')) : '';
        host.innerHTML = `
            <div class="vw-global-card${g.enabled ? ' enabled' : ' disabled'}${hasFile ? ' has-file' : ''}">
                <div class="vw-global-head">
                    <span class="vw-global-emoji">${titleEmoji}</span>
                    <div class="vw-global-title">${titleText}</div>
                    <label class="vw-rule-toggle">
                        <input type="checkbox" id="vw-${kind}-enabled" ${g.enabled ? 'checked' : ''} />
                        <span>Bật</span>
                    </label>
                </div>
                <div class="vw-rule-file" id="vw-${kind}-filedisplay">
                    ${hasFile
                        ? `<span class="vw-file-badge">${typeBadge}</span><span class="vw-file-name">${escapeHtml(fileName)}</span>`
                        : '<span class="vw-file-empty">Chưa chọn file — bấm "📁 Chọn" để tải video/âm thanh</span>'
                    }
                </div>
                <div class="vw-rule-row">
                    <label class="vw-inline">🔊 <input type="range" min="0" max="100" step="5" id="vw-${kind}-volume" value="${g.volume ?? 100}" />
                        <span id="vw-${kind}-volume-v">${g.volume ?? 100}%</span>
                    </label>
                    <label class="vw-inline">⭐ Min Level <input type="number" min="0" step="1" id="vw-${kind}-minlevel" value="${g.minLevel || 0}" /></label>
                    <label class="vw-inline" title="Chỉ phát cho user có dấu tích xanh trên TikTok (verified account)"><input type="checkbox" id="vw-${kind}-verified" ${g.requireVerified ? 'checked' : ''} /> ✓ Chỉ tích xanh</label>
                </div>
                <div class="vw-rule-row">
                    <label class="vw-inline vw-msg-row">💬 Lời chúc:
                        <input type="text" id="vw-${kind}-message" placeholder="VD: Chào {nickname} cấp {level}!" value="${escapeHtml(g.message || '')}" />
                    </label>
                </div>
                <div class="vw-rule-actions">
                    <button class="ghost small" id="vw-${kind}-pick">📁 Chọn file</button>
                    <button class="primary small" id="vw-${kind}-test" ${hasFile ? '' : 'disabled'}>▶ TEST</button>
                    <button class="danger small" id="vw-${kind}-clear" ${hasFile ? '' : 'disabled'}>🗑 Xoá file</button>
                </div>
                <div class="vw-hint">Biến: {nickname}, {level}, {gift}, {count}, {uniqueId}, {verified} (✓ nếu có tích xanh)</div>
            </div>`;
        // Wire
        $(`#vw-${kind}-enabled`)?.addEventListener('change', (e) => {
            g.enabled = !!e.target.checked;
            renderGlobalCard(kind); renderProfileChips(); persistConfig();
        });
        const vol = $(`#vw-${kind}-volume`);
        vol?.addEventListener('input', () => {
            g.volume = +vol.value;
            $(`#vw-${kind}-volume-v`).textContent = vol.value + '%';
            schedulePersist();
        });
        $(`#vw-${kind}-minlevel`)?.addEventListener('input', (e) => {
            g.minLevel = Math.max(0, parseInt(e.target.value, 10) || 0); schedulePersist();
        });
        $(`#vw-${kind}-verified`)?.addEventListener('change', (e) => {
            g.requireVerified = !!e.target.checked; schedulePersist();
        });
        $(`#vw-${kind}-message`)?.addEventListener('input', (e) => {
            g.message = e.target.value; schedulePersist();
        });
        $(`#vw-${kind}-pick`)?.addEventListener('click', () => pickFileForGlobal(kind));
        $(`#vw-${kind}-clear`)?.addEventListener('click', () => {
            if (!g.mediaUrl) return;
            if (!confirm('Xoá file?')) return;
            g.mediaUrl = ''; g.mediaName = ''; g.mediaType = '';
            renderGlobalCard(kind); persistConfig();
        });
        $(`#vw-${kind}-test`)?.addEventListener('click', async () => {
            if (!g.mediaUrl) { flashWarn('Chưa chọn file'); return; }
            await fetch('/api/games/vipwelcome/trigger', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'test', payload: {
                        profileId: cfg.activeProfileId,
                        ruleType: kind === 'join' ? 'globalJoin' : 'globalGift',
                        uniqueId: 'demo_user',
                        nickname: 'Demo VIP',
                        level: Math.max(g.minLevel || 30, 30),
                        verified: !!g.requireVerified,    // test với verified=true nếu rule đòi tích xanh
                        giftName: 'Hoa Hồng'
                    }
                })
            });
            flashOk('Đã test');
        });
    }

    function pickFileForGlobal(kind) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,.mp4,.webm,.mp3,.wav,.ogg,.m4a';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = async () => {
            const f = inp.files?.[0]; inp.remove();
            if (!f) return;
            const profile = activeProfile(); if (!profile) return;
            const g = kind === 'join' ? profile.globalJoin : profile.globalGift;
            await uploadFileToTarget(f, (meta) => {
                g.mediaUrl = meta.url;
                g.mediaName = f.name;
                g.mediaType = meta.type;
            }, () => renderGlobalCard(kind));
        };
        inp.click();
    }

    // ============================================================
    // TAB 3: SETTINGS
    // ============================================================
    function renderSettingsTab() {
        const host = $('#vw-settings-pane');
        if (!host) return;
        const d = cfg.display || {};
        const q = cfg.queue || {};
        const currentStyle = d.labelStyle || 'goldpink';
        const styleSwatches = LABEL_STYLE_DEFS.map(s => `
            <div class="vw-style-swatch${currentStyle === s.id ? ' active' : ''}" data-vw-style="${s.id}" title="${escapeHtml(s.label)}">
                <div class="vw-style-preview style-preview-${s.id}">CHÀO VIP ${s.emoji}</div>
                <div class="vw-style-name">${escapeHtml(s.label)}</div>
            </div>
        `).join('');
        host.innerHTML = `
            <div class="vw-setting-block">
                <div class="vw-setting-title">🎬 Hiển thị overlay</div>
                <label class="vw-inline">Scale <input type="range" min="50" max="150" step="5" id="vw-set-scale" value="${d.scale || 100}" />
                    <span id="vw-set-scale-v">${d.scale || 100}%</span>
                </label>
                <label class="vw-inline">X% <input type="range" min="0" max="100" step="1" id="vw-set-x" value="${d.xPercent ?? 50}" />
                    <span id="vw-set-x-v">${d.xPercent ?? 50}</span>
                </label>
                <label class="vw-inline">Y% <input type="range" min="0" max="100" step="1" id="vw-set-y" value="${d.yPercent ?? 50}" />
                    <span id="vw-set-y-v">${d.yPercent ?? 50}</span>
                </label>
                <label class="vw-inline"><input type="checkbox" id="vw-set-showtext" ${d.showText !== false ? 'checked' : ''} /> Hiện lời chúc trên overlay</label>
                <label class="vw-inline"><input type="checkbox" id="vw-set-showavatar" ${d.showAvatar !== false ? 'checked' : ''} /> 👤 Hiện avatar user (tròn, cạnh lời chúc)</label>
                <label class="vw-inline">Vị trí text
                    <select id="vw-set-textpos">
                        <option value="top" ${d.textPosition === 'top' ? 'selected' : ''}>Trên</option>
                        <option value="middle" ${d.textPosition === 'middle' ? 'selected' : ''}>Giữa</option>
                        <option value="bottom" ${d.textPosition !== 'top' && d.textPosition !== 'middle' ? 'selected' : ''}>Dưới</option>
                    </select>
                </label>
            </div>
            <div class="vw-setting-block">
                <div class="vw-setting-title">🎨 Phong cách lời chúc</div>
                <div class="vw-hint" style="margin-bottom:8px">Chọn 1 trong 12 phong cách — áp dụng cho overlay OBS. Bấm vào ô để chọn.</div>
                <div class="vw-style-grid" id="vw-style-grid">${styleSwatches}</div>
            </div>
            <div class="vw-setting-block">
                <div class="vw-setting-title">⏱️ Hàng đợi &amp; chống spam</div>
                <label class="vw-inline">Tối đa item chờ <input type="number" min="1" max="100" step="1" id="vw-set-qmax" value="${q.maxLen || 20}" /></label>
                <label class="vw-inline">Cooldown / user (giây) — chỉ áp dụng cho Lên cấp <input type="number" min="0" step="5" id="vw-set-cooldown" value="${q.perUserCooldownSec || 60}" /></label>
                <label class="vw-inline">Khoảng cách phát (ms) <input type="number" min="0" step="50" id="vw-set-gap" value="${q.perItemMinMs ?? 200}" /></label>
                <label class="vw-inline">🔁 Vắng mặt N giây = vào lại <input type="number" min="10" max="600" step="5" id="vw-set-rejoin" value="${q.rejoinThresholdSec || 60}" /></label>
                <div class="vw-hint">💡 <b>Vắng mặt N giây = vào lại</b>: user không xuất hiện trong N giây → coi như rời phòng → khi quay lại sẽ fire effect LẠI. Cài 60s (mặc định) phù hợp với tốc độ TikTok cập nhật danh sách (~30s/lần).</div>
            </div>
        `;
        // Wire
        const wireRange = (id, key, fmt) => {
            const el = $(`#${id}`); if (!el) return;
            el.addEventListener('input', () => {
                const v = parseInt(el.value, 10);
                cfg.display[key] = v;
                const vSpan = $(`#${id}-v`); if (vSpan) vSpan.textContent = fmt ? fmt(v) : v;
                schedulePersist();
            });
        };
        wireRange('vw-set-scale', 'scale', v => v + '%');
        wireRange('vw-set-x', 'xPercent');
        wireRange('vw-set-y', 'yPercent');
        $('#vw-set-showtext')?.addEventListener('change', (e) => { cfg.display.showText = !!e.target.checked; schedulePersist(); });
        $('#vw-set-showavatar')?.addEventListener('change', (e) => { cfg.display.showAvatar = !!e.target.checked; schedulePersist(); });
        $('#vw-set-textpos')?.addEventListener('change', (e) => { cfg.display.textPosition = e.target.value; schedulePersist(); });
        $('#vw-set-qmax')?.addEventListener('input', (e) => { cfg.queue.maxLen = Math.max(1, parseInt(e.target.value, 10) || 20); schedulePersist(); });
        $('#vw-set-cooldown')?.addEventListener('input', (e) => { cfg.queue.perUserCooldownSec = Math.max(0, parseInt(e.target.value, 10) || 0); schedulePersist(); });
        $('#vw-set-gap')?.addEventListener('input', (e) => { cfg.queue.perItemMinMs = Math.max(0, parseInt(e.target.value, 10) || 0); schedulePersist(); });
        $('#vw-set-rejoin')?.addEventListener('input', (e) => { cfg.queue.rejoinThresholdSec = Math.max(10, Math.min(600, parseInt(e.target.value, 10) || 60)); schedulePersist(); });
        // Style swatches — click chọn phong cách lời chúc
        document.querySelectorAll('#vw-style-grid .vw-style-swatch').forEach(el => {
            el.addEventListener('click', async () => {
                const id = el.dataset.vwStyle;
                if (!id) return;
                cfg.display = cfg.display || {};
                cfg.display.labelStyle = id;
                document.querySelectorAll('#vw-style-grid .vw-style-swatch').forEach(x => x.classList.toggle('active', x.dataset.vwStyle === id));
                await persistConfig();
                flashOk(`Đã chọn phong cách "${(LABEL_STYLE_DEFS.find(s => s.id === id) || {}).label || id}"`);
            });
        });
    }

    // ============================================================
    // TAB 4: QUEUE & LOG
    // ============================================================
    async function fetchQueueSnapshot() {
        try {
            const r = await fetch('/api/games/vipwelcome/queue');
            const j = await r.json();
            renderQueue(j);
        } catch (e) { /* ignore */ }
    }

    function renderQueue(snapshot) {
        const sizeEl = $('#vipwelcome-queue-size');
        if (sizeEl) sizeEl.textContent = snapshot?.size ?? 0;
        const list = $('#vw-queue-list');
        if (list) {
            const items = snapshot?.items || [];
            list.innerHTML = items.length === 0
                ? `<div class="vw-empty">Hàng đợi trống.</div>`
                : items.map((it, i) => `<div class="vw-queue-item">
                    <span class="vw-q-idx">#${i + 1}</span>
                    <span class="vw-q-ev">${it.eventType === 'join' ? '🚪' : '🎁'}</span>
                    <span class="vw-q-user">@${escapeHtml(it.uniqueId || '?')}</span>
                    <span class="vw-q-meta">cấp ${it.level || 0}</span>
                    <span class="vw-q-rule">${escapeHtml(it.ruleLabel || '')}</span>
                </div>`).join('');
        }
        const log = $('#vw-log');
        if (log) {
            const recent = snapshot?.recent || [];
            log.innerHTML = recent.length === 0
                ? `<div class="vw-empty">Chưa có log nào.</div>`
                : recent.map(e => renderLogLine(e)).join('');
        }
    }

    function renderLogLine(e) {
        const time = new Date(e.ts).toLocaleTimeString('vi-VN');
        let ico = '▶';
        let extra = '';
        if (e.kind === 'play') {
            ico = e.eventType === 'gift' ? '🎁' : '🚪';
            extra = `@${escapeHtml(e.uniqueId || '?')} (cấp ${e.level || 0}) — ${escapeHtml(e.ruleLabel || '')}`;
        } else if (e.kind === 'mediaMissing') {
            ico = '⚠';
            extra = `<b style="color:#ff8da6">FILE MEDIA MẤT</b> @${escapeHtml(e.uniqueId || '?')} — ${escapeHtml(e.ruleLabel || '')}<br><small style="color:#8b93a8">${escapeHtml(e.mediaUrl || '')}</small>`;
        } else if (e.kind === 'cooldown') {
            ico = '⏸';
            extra = `Cooldown: @${escapeHtml(e.uniqueId || '?')} — ${escapeHtml(e.ruleLabel || '')}`;
        } else if (e.kind === 'drop') {
            ico = '🗑';
            extra = `Drop ${e.dropped || 1} item — ${escapeHtml(e.ruleLabel || '')}`;
        }
        return `<div class="vw-log-line vw-log-${e.kind}">${time} ${ico} ${extra}</div>`;
    }

    function addLogLine(entry) {
        const log = $('#vw-log');
        if (!log) return;
        const div = document.createElement('div');
        div.innerHTML = renderLogLine(entry);
        const node = div.firstChild;
        if (log.firstChild?.classList?.contains('vw-empty')) log.innerHTML = '';
        log.insertBefore(node, log.firstChild);
        while (log.children.length > 80) log.removeChild(log.lastChild);
    }

    // ============================================================
    // Helpers
    // ============================================================
    async function uploadFileToTarget(file, applyMeta, onDone) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
            flashWarn('Chỉ chấp nhận: mp4, webm, mp3, wav, ogg, m4a');
            return;
        }
        if (file.size > 30 * 1024 * 1024) {
            flashWarn('File quá 30MB — vui lòng nén lại');
            return;
        }
        try {
            const url = `/api/games/vipwelcome/upload?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}`;
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file
            });
            const json = await r.json();
            if (!r.ok || !json.ok) throw new Error(json?.error || 'Upload thất bại');
            applyMeta({ url: json.url, type: ['mp4', 'webm'].includes(ext) ? 'video' : 'audio' });
            await persistConfig();
            if (typeof onDone === 'function') onDone();
            flashOk(`Đã tải lên ${file.name}`);
        } catch (e) {
            flashWarn('Lỗi upload: ' + e.message);
        }
    }

    function schedulePersist() {
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => persistConfig().catch(() => {}), 400);
    }

    async function persistConfig() {
        clearTimeout(pendingSave);
        const r = await fetch('/api/games/vipwelcome/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        if (!r.ok) throw new Error('Save fail');
    }

    function flashWarn(text) { showToast(text, 'warn'); }
    function flashOk(text) { showToast(text, 'ok'); }
    function showToast(text, kind) {
        const el = document.createElement('div');
        el.className = 'caro-toast ' + (kind === 'ok' ? 'ok' : 'warn');
        el.textContent = (kind === 'ok' ? '✓ ' : '⚠️ ') + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
})();

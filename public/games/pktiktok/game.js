/* ============================================================
   HP PK TikTok — Engine
   ============================================================
   Module: window.HpGame.pktiktok

   Đây KHÔNG phải board game như Caro — đây là **media trigger engine**
   cho PK match TikTok. Mỗi sự kiện trận PK (start / mission / x2 / x3 /
   item / 10s cuối / lead / behind / win / lose) gán 1 file video/âm thanh.
   Khi panel hoặc auto-bind fire trigger → engine emit 'play' → overlay
   nhận và render media.

   13 events default mapping với phase TikTok PK:
     start    → bấm Bắt đầu PK (đếm ngược 3-2-1)
     mission  → popup nhiệm vụ xuất hiện
     x2       → bonus mission unlock x2 điểm (Speed)
     x3       → bonus mission unlock x3 điểm (Speed mạnh)
     glove    → ITEM Boosting Glove (30% chance x5)
     mist     → ITEM Magic Mist
     hammer   → ITEM Stun Hammer (victory lap)
     time     → ITEM Time-Maker
     warn10s  → đồng hồ vào 10 giây cuối
     lead     → đội nhà đang dẫn điểm
     behind   → đội nhà đang thua điểm
     win      → kết quả: thắng
     lose     → kết quả: thua
   ============================================================ */
(function () {
    'use strict';

    window.HpGame = window.HpGame || {};

    const EVENT_DEFS = [
        { key: 'start',    label: 'BẮT ĐẦU PK',           emoji: '🚀', desc: 'Đếm ngược khi bắt đầu trận' },
        { key: 'mission',  label: 'NHIỆM VỤ XUẤT HIỆN',   emoji: '📋', desc: 'Popup nhiệm vụ bonus' },
        { key: 'x2',       label: 'X2 ĐIỂM (Speed)',      emoji: '⚡', desc: 'Bonus mission unlock nhân 2' },
        { key: 'x3',       label: 'X3 ĐIỂM (Speed mạnh)', emoji: '🔥', desc: 'Bonus mission unlock nhân 3' },
        { key: 'glove',    label: 'ITEM Găng Tay',        emoji: '🥊', desc: 'Boosting Glove — 30% chance x5' },
        { key: 'mist',     label: 'ITEM Sương Mù',        emoji: '🌫️', desc: 'Magic Mist phủ đối thủ' },
        { key: 'hammer',   label: 'ITEM Búa Choáng',      emoji: '🔨', desc: 'Stun Hammer trong victory lap' },
        { key: 'time',     label: 'ITEM Thêm Giờ',        emoji: '⏱️', desc: 'Time-Maker' },
        { key: 'warn10s',  label: '10 GIÂY CUỐI',         emoji: '⚠️', desc: 'Đồng hồ chuyển đỏ' },
        { key: 'lead',     label: 'ĐANG DẪN ĐIỂM',        emoji: '📈', desc: 'Đội nhà > đội đối thủ' },
        { key: 'behind',   label: 'ĐANG THUA ĐIỂM',       emoji: '📉', desc: 'Đội nhà < đội đối thủ' },
        { key: 'win',      label: 'KẾT QUẢ: THẮNG',       emoji: '🏆', desc: 'Vinh quang chiến thắng' },
        { key: 'lose',     label: 'KẾT QUẢ: THUA',        emoji: '💔', desc: 'Thất bại' },
    ];

    function defaultConfig() {
        return {
            enabled: true,
            autoBindPkDuo: true, // tự fire khi engine PK Đôi (nếu có) emit event tương đương
            events: EVENT_DEFS.map(d => ({
                key: d.key,
                label: d.label,
                emoji: d.emoji,
                desc: d.desc,
                mediaUrl: '',     // /api/games/pktiktok/asset/<filename> sau upload
                mediaName: '',    // tên gốc do user upload
                mediaType: '',    // 'video' | 'audio'
                volume: 100,      // 0..100
                playbackRate: 1.0,
                interruptCurrent: true, // true: fire mới ngắt cái đang phát; false: queue
                enabled: true,
            })),
            display: {
                scale: 100,
                xPercent: 50,
                yPercent: 50,
                showLabel: false, // hiện text label trên overlay khi fire
            },
        };
    }

    function eventDefs() { return EVENT_DEFS.slice(); }

    function create(opts) {
        opts = opts || {};
        let config = mergeConfig(defaultConfig(), opts.config || {});
        const listeners = {};

        // Last broadcast — để overlay reload state khi reconnect.
        let lastPlay = null;  // { key, mediaUrl, mediaType, volume, playbackRate, ts }

        function on(name, cb) { (listeners[name] = listeners[name] || []).push(cb); }
        function emit(name, payload) {
            (listeners[name] || []).forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } });
        }

        function setConfig(next) {
            config = mergeConfig(config, next || {});
            emit('change', { config });
        }

        function getConfig() { return config; }

        function getEvent(key) { return config.events.find(e => e.key === key); }

        // Fire 1 event → emit 'play' với payload. Panel + overlay đều listen.
        function trigger(key, options) {
            if (config.enabled === false) return { ok: false, reason: 'pkfx_disabled' };
            const ev = getEvent(key);
            if (!ev) return { ok: false, reason: 'event_not_found' };
            if (ev.enabled === false) return { ok: false, reason: 'event_disabled' };
            if (!ev.mediaUrl) return { ok: false, reason: 'no_media' };
            const payload = {
                key,
                label: ev.label,
                emoji: ev.emoji,
                mediaUrl: ev.mediaUrl,
                mediaType: ev.mediaType || guessType(ev.mediaUrl),
                volume: ev.volume != null ? ev.volume : 100,
                playbackRate: ev.playbackRate || 1.0,
                interruptCurrent: ev.interruptCurrent !== false,
                showLabel: !!config.display?.showLabel,
                ts: Date.now(),
                source: options?.source || 'manual',
            };
            lastPlay = payload;
            emit('play', payload);
            return { ok: true, payload };
        }

        function stopAll() {
            lastPlay = null;
            emit('stop', { ts: Date.now() });
        }

        // Overlay sync: nhận state snapshot từ panel/server qua socket.
        function loadState(state) {
            if (!state) return;
            if (state.config) config = mergeConfig(config, state.config);
            if (state.lastPlay) {
                lastPlay = state.lastPlay;
                // Không tự fire 'play' lại — overlay tự quyết định có nên replay không
                // (nếu lastPlay quá cũ — vd > 30s — overlay nên ignore)
            }
            emit('change', { config });
        }

        function getState() {
            return {
                config,
                lastPlay,
                eventDefs: EVENT_DEFS,
            };
        }

        return {
            on, setConfig, getConfig, getEvent, trigger, stopAll,
            loadState, getState,
        };
    }

    function guessType(url) {
        const u = String(url || '').toLowerCase();
        if (/\.(mp4|webm|mov)(\?|$)/.test(u)) return 'video';
        if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/.test(u)) return 'audio';
        return '';
    }

    // Deep merge — chỉ shallow merge events[] để giữ default key ordering.
    function mergeConfig(base, patch) {
        const out = { ...base };
        for (const k of Object.keys(patch || {})) {
            const v = patch[k];
            if (k === 'events' && Array.isArray(v)) {
                // Merge từng event theo key (giữ thứ tự EVENT_DEFS)
                out.events = EVENT_DEFS.map(def => {
                    const baseEv = (base.events || []).find(e => e.key === def.key) || { key: def.key, label: def.label, emoji: def.emoji };
                    const patchEv = v.find(e => e.key === def.key) || {};
                    return { ...baseEv, ...patchEv, key: def.key, label: baseEv.label || def.label, emoji: baseEv.emoji || def.emoji };
                });
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
                out[k] = { ...(base[k] || {}), ...v };
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    window.HpGame.pktiktok = { create, defaultConfig, eventDefs };
})();

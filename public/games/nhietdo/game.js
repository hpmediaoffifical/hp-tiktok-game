/* ============================================================
   HP Nhiệt Độ (Biểu cảm) — Engine helpers (client)
   ============================================================
   Module: window.HpGame.nhietdo

   Authoritative state ở SERVER:
     - server hook GIFT → tăng nhiệt theo công thức trong config
     - server tick loop (1Hz) → giảm nhiệt khi idle
     - server emit 'nhietdo:state' tới mọi overlay + panel

   Engine này chỉ là helpers: defaultConfig, computeStage, clamp.
   ============================================================ */
(function () {
    'use strict';
    window.HpGame = window.HpGame || {};

    // 5 mức hiệu ứng — overlay sẽ blend giữa các stage để mượt
    // threshold = nhiệt độ tối thiểu để vào stage này
    const STAGES = [
        { id: 0, threshold:   0, name: 'Bình thường', cssVar: '--nd-stage-0', tint: 'rgba(120,180,255,0)',     emoji: '😐' },
        { id: 1, threshold:  20, name: 'Ấm áp',       cssVar: '--nd-stage-1', tint: 'rgba(255,200, 90, 0.10)', emoji: '🙂' },
        { id: 2, threshold:  40, name: 'Nóng',        cssVar: '--nd-stage-2', tint: 'rgba(255,140, 50, 0.22)', emoji: '😅' },
        { id: 3, threshold:  60, name: 'Rất nóng',    cssVar: '--nd-stage-3', tint: 'rgba(255, 80, 40, 0.35)', emoji: '🥵' },
        { id: 4, threshold:  80, name: 'Rực lửa',     cssVar: '--nd-stage-4', tint: 'rgba(255, 40, 10, 0.50)', emoji: '🔥' },
        { id: 5, threshold:  98, name: 'Cháy đỉnh',   cssVar: '--nd-stage-5', tint: 'rgba(255,255,200, 0.65)', emoji: '💥' }
    ];

    function defaultMilestones() {
        return [
            { temp: 25,  label: '25°C — Ấm rồi!',     tickerText: '🔥 25°C — ẤM RỒI! 🔥',  mediaUrl: '', mediaName: '', mediaType: '', volume: 80, enabled: true },
            { temp: 50,  label: '50°C — Nóng!',       tickerText: '🔥 50°C — NÓNG QUÁ! 🔥', mediaUrl: '', mediaName: '', mediaType: '', volume: 85, enabled: true },
            { temp: 75,  label: '75°C — Rất nóng!',   tickerText: '🔥🔥 75°C — RẤT NÓNG!',  mediaUrl: '', mediaName: '', mediaType: '', volume: 90, enabled: true },
            { temp: 100, label: '100°C — CHÁY!',      tickerText: '💥 100°C — BÙM! 💥',      mediaUrl: '', mediaName: '', mediaType: '', volume: 100, enabled: true }
        ];
    }

    function defaultConfig() {
        return {
            enabled: true,
            sessionActive: true,       // BẮT ĐẦU / KẾT THÚC phiên — false = overlay ẩn hết
            // ===== Cách tăng nhiệt =====
            heatMode: 'perCoin',      // 'perCoin' | 'perGift' | 'specificGifts'
            perCoinDegrees: 0.1,       // user-curated: 1 xu = 0.1°C
            perGiftDegrees: 5,         // 1 quà bất kỳ = +5°C (perGift mode)
            specificGifts: [],         // [{giftId, giftName, giftImage, degrees}] — chỉ quà trong list mới tăng
            coolingGifts: [],          // [{giftId, giftName, giftImage, degrees}] — quà GIẢM nhiệt, hoạt động ở mọi mode
            multiplierByLevel: false,  // (future) — nhân theo cấp user

            // ===== Cách giảm nhiệt =====
            decayPerSecond: 1.0,       // °C giảm mỗi giây khi idle
            idleSeconds: 5,            // bao lâu không có quà thì bắt đầu giảm
            decayShape: 'linear',      // 'linear' | 'easeOut' (giảm chậm dần khi gần 0)

            // ===== Giới hạn =====
            tempMin: 0,
            tempMax: 100,
            initialTemp: 0,            // nhiệt khởi đầu khi reset

            // ===== Mốc thưởng — phát media + ticker khi đạt =====
            milestones: defaultMilestones(),

            // ===== Âm thanh nền — loop, volume scale theo nhiệt =====
            ambientAudio: {
                url: '', name: '', volume: 60,
                reactToHeat: true
            },

            // ===== Hiển thị overlay — user-curated defaults =====
            display: {
                xPercent: 86,
                yPercent: 23,
                scale: 40,
                showThermo: true,
                showLabel: false,
                showDegrees: true,
                showEmoji: true,
                showFloatGain: true,
                showFireEffect: true,
                showHaze: true,
                shakeAtMax: true,
                showTopContrib: false,
                topContribPos: 'bottom-right',
                colorScheme: 'pinkfire',
                shape: 'tube',
                fxIntensity: 90,
                tickerScale: 65,
                showGiftList: true,
                giftListXPercent: 4,
                giftListYPercent: 30,
                giftListScale: 100,
                giftListLayout: 'vertical'
            }
        };
    }

    function clamp(v, lo, hi) {
        v = Number(v);
        if (!isFinite(v)) return lo;
        return Math.max(lo, Math.min(hi, v));
    }

    // Trả về stage index dựa theo temperature (0..100)
    function stageOf(temp, tempMax) {
        const max = tempMax || 100;
        const pct = clamp(temp, 0, max) / max * 100;
        let cur = STAGES[0];
        for (const s of STAGES) {
            if (pct >= s.threshold) cur = s;
        }
        return cur;
    }

    // Trả 0..1 — progress trong khoảng giữa 2 stage liền kề (cho blend mượt)
    function stageBlend(temp, tempMax) {
        const max = tempMax || 100;
        const pct = clamp(temp, 0, max) / max * 100;
        const cur = stageOf(temp, max);
        const next = STAGES[Math.min(STAGES.length - 1, cur.id + 1)];
        if (next.id === cur.id) return { stage: cur, t: 1 };
        const range = next.threshold - cur.threshold;
        const t = range > 0 ? (pct - cur.threshold) / range : 0;
        return { stage: cur, next, t: clamp(t, 0, 1), pct };
    }

    // 12 phong cách — mỗi item gồm id + label + emoji + gợi ý đối tượng
    const SCHEME_LIST = [
        { id: 'pinkfire', emoji: '🌸',  label: 'Hồng-lửa',     target: 'NỮ' },
        { id: 'classic',  emoji: '🔥',  label: 'Cổ điển',       target: 'Chung' },
        { id: 'neon',     emoji: '💎',  label: 'Neon',          target: 'Chung' },
        { id: 'lava',     emoji: '🌋',  label: 'Nham thạch',    target: 'NAM' },
        { id: 'ice',      emoji: '💙',  label: 'Băng xanh',     target: 'NỮ' },
        { id: 'galaxy',   emoji: '🌌',  label: 'Vũ trụ',        target: 'NPC' },
        { id: 'warrior',  emoji: '⚔',  label: 'Chiến binh',    target: 'NAM' },
        { id: 'ocean',    emoji: '🌊',  label: 'Đại dương',     target: 'NAM' },
        { id: 'forest',   emoji: '🍃',  label: 'Rừng xanh',     target: 'NPC' },
        { id: 'sakura',   emoji: '🌸',  label: 'Sakura',        target: 'NỮ' },
        { id: 'halloween',emoji: '👻',  label: 'Halloween',     target: 'NPC' },
        { id: 'vietnam',  emoji: '🇻🇳', label: 'Việt Nam',      target: 'Chung' }
    ];

    window.HpGame.nhietdo = {
        defaultConfig, defaultMilestones, clamp, stageOf, stageBlend, STAGES, SCHEME_LIST
    };
})();

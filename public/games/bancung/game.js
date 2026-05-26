/* ============================================================
   HP Bắn Cung — Engine helpers (client)
   ============================================================
   Module: window.HpGame.bancung

   Authoritative state ở SERVER. Engine này chỉ là helpers:
     defaultConfig, skin list, clamp.
   ============================================================ */
(function () {
    'use strict';
    window.HpGame = window.HpGame || {};

    function defaultConfig() {
        return {
            enabled: true,
            sessionActive: true,
            maxHearts: 10,
            initialHearts: 10,
            damagePerShot: 0.1,
            regenPerSecond: 0.2,
            idleBeforeRegen: 3,
            reviveWindowSec: 10,
            autoReviveAfterWindow: true,
            autoReviveHearts: 5,
            reviveProtectionSec: 3,
            freeFireEnabled: false,
            freeFireKcPerHeart: 100,
            freeFireKcPerShot: 10,
            freeFireMaxShots: 20,
            shotGifts: [],
            healGifts: [],
            reviveGifts: [],
            shieldGifts: [],
            display: {
                heartsXPercent: 50,
                heartsYPercent: 16,
                heartsScale: 60,
                bowXPercent: 81,
                bowYPercent: 87,
                bowScale: 185,
                bowSkin: 'cupid',
                heartStyle: 'glossy',
                showShooterName: true,
                showDamageText: true,
                redFlashIntensity: 100,
                deathTintOpacity: 75,
                showBowWidget: true,
                showHearts: true,
                showTopContrib: false,
                topContribPos: 'bottom-left',
                arrowDurationMs: 200,
                burstDelayMs: 120,
                autoAimBow: true,
                impactXPercent: 55,
                impactYPercent: 40,
                impactSpread: 20,
                hotkeyFire: 'X',
                hotkeyHeal: 'H',
                hotkeyShield: 'B',
                hotkeyKill: '',
                hotkeyRevive: 'R',
                globalHotkeys: true,
                showArrowTrail: true,
                showArrowUsername: true,
                showHitParticles: true,
                heartShakeLowHp: true,
                slowMotionOnKill: true,
                viewportShakeOnHit: true,
                deathCamZoom: true,
                showKillingBlow: true,
                showPodium: true,
                showSurvivalTimer: true,
                criticalChance: 5,
                criticalMultiplier: 3,
                comboEnabled: true,
                comboWindowSec: 4,
                comboMaxMultiplier: 3,
                headshotEnabled: true,
                headshotChance: 0,
                headshotMultiplier: 2,
                bowChargeEnabled: false,
                bowChargePerGift: 100,
                bowChargeFullShots: 100,
                showGiftList: true,
                giftListXPercent: 4,
                giftListYPercent: 30,
                giftListScale: 100,
                giftListLayout: 'vertical',
                showHpNumber: true
            }
        };
    }

    function clamp(v, lo, hi) {
        v = Number(v);
        if (!isFinite(v)) return lo;
        return Math.max(lo, Math.min(hi, v));
    }

    // 8 skins cung tên — mỗi skin có color set + trail effect
    const BOW_SKINS = [
        { id: 'classic',  label: 'Cổ điển',     emoji: '🏹', bowColor: '#8b5a2b', stringColor: '#f0e8d0', arrowColor: '#a0794a', glow: '' },
        { id: 'glow',     label: 'Phát sáng',   emoji: '✨', bowColor: '#25f4ee', stringColor: '#ffffff', arrowColor: '#25f4ee', glow: '#25f4ee' },
        { id: 'fire',     label: 'Lửa',         emoji: '🔥', bowColor: '#ff5b2e', stringColor: '#ffd54a', arrowColor: '#ff8a30', glow: '#ff5b2e' },
        { id: 'ice',      label: 'Băng',        emoji: '❄', bowColor: '#7cc6ff', stringColor: '#e0f7ff', arrowColor: '#a0e8ff', glow: '#7cc6ff' },
        { id: 'cupid',    label: 'Thần tình yêu', emoji: '💘', bowColor: '#ff5fa3', stringColor: '#fff0f5', arrowColor: '#ff8ec0', glow: '#ff5fa3' },
        { id: 'shadow',   label: 'Bóng tối',    emoji: '🌑', bowColor: '#1a1a2e', stringColor: '#9b30ff', arrowColor: '#5a3a8a', glow: '#9b30ff' },
        { id: 'golden',   label: 'Vàng kim',    emoji: '👑', bowColor: '#c97f25', stringColor: '#ffd700', arrowColor: '#ffd700', glow: '#ffd700' },
        { id: 'plasma',   label: 'Plasma',      emoji: '⚡', bowColor: '#a0ffe0', stringColor: '#25f4ee', arrowColor: '#ffffff', glow: '#25f4ee' }
    ];

    const HEART_STYLES = [
        { id: 'pixel',   label: 'Pixel cổ điển', emoji: '❤' },
        { id: 'glossy',  label: 'Bóng láng',    emoji: '💖' },
        { id: 'fire',    label: 'Lửa',          emoji: '❤️‍🔥' },
        { id: 'crystal', label: 'Pha lê',       emoji: '💎' }
    ];

    function getBowSkin(id) {
        return BOW_SKINS.find(s => s.id === id) || BOW_SKINS[0];
    }
    function getHeartStyle(id) {
        return HEART_STYLES.find(s => s.id === id) || HEART_STYLES[0];
    }

    window.HpGame.bancung = {
        defaultConfig, clamp, BOW_SKINS, HEART_STYLES, getBowSkin, getHeartStyle
    };
})();

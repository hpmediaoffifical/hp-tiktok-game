/* ============================================================
   HP VIP Welcome — Engine (client-side helper)
   ============================================================
   Module: window.HpGame.vipwelcome

   Media trigger engine cho 2 loại sự kiện:
     - User vào phòng (member event) → phát media chào mừng
     - User tặng quà (gift event) → phát media chúc mừng theo cấp độ

   Hai chế độ trigger:
     1. User cụ thể (chỉ định TikTok ID) — list rules
     2. Tất cả user (global) — chặn bằng min level/diamond

   Authoritative state ở SERVER:
     - server hook MEMBER/GIFT → check rules → enqueue → emit 'vipwelcome:play'
     - overlay nhận → play media + show text
     - cooldown per-user và queue do server quản lý

   Engine này chủ yếu là helpers (defaultConfig, mergeConfig) — không có state
   complex như Caro hay Thủy Tinh.
   ============================================================ */
(function () {
    'use strict';

    window.HpGame = window.HpGame || {};

    function newProfileId() {
        return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function newProfile(name) {
        return {
            id: newProfileId(),
            name: name || 'Nhóm mới',
            enabled: true,
            userRules: [],
            globalJoin: {
                enabled: false,
                mediaUrl: '', mediaName: '', mediaType: '',
                volume: 100,
                message: 'Chào mừng {nickname} (cấp {level}) đã ghé phòng!',
                minLevel: 30,
                requireVerified: false
            },
            globalGift: {
                enabled: false,
                mediaUrl: '', mediaName: '', mediaType: '',
                volume: 100,
                message: 'Chúc mừng {nickname} vừa lên cấp {level}!',
                minLevel: 30,
                requireVerified: false
            }
        };
    }

    function defaultConfig() {
        const p = newProfile('Nhóm mặc định');
        return {
            enabled: true,
            activeProfileId: p.id,
            profiles: [p],
            queue: { maxLen: 20, perUserCooldownSec: 60, perItemMinMs: 200, rejoinThresholdSec: 60 },
            display: { scale: 100, xPercent: 50, yPercent: 50, showText: true, textPosition: 'bottom', labelStyle: 'goldpink' }
        };
    }

    function newRuleId() {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function newUserRule(patch) {
        return Object.assign({
            id: newRuleId(),
            uniqueId: '',
            trigger: 'join',              // 'join' (Vào phòng) | 'gift' (Lên cấp)
            mediaUrl: '', mediaName: '', mediaType: '',
            volume: 100,
            message: '',
            enabled: true
        }, patch || {});
    }

    // Render template message — dùng cho preview ở panel (server đã render khi enqueue).
    function renderMessage(template, ctx) {
        if (!template) return '';
        return String(template)
            .replace(/\{nickname\}/g, ctx?.nickname || 'User')
            .replace(/\{uniqueId\}/g, ctx?.uniqueId || '')
            .replace(/\{level\}/g, String(ctx?.level || 0))
            .replace(/\{gift\}/g, ctx?.giftName || '')
            .replace(/\{count\}/g, String(ctx?.repeatCount || 1))
            .replace(/\{diamond\}/g, String(ctx?.diamondCount || 0));
    }

    window.HpGame.vipwelcome = {
        defaultConfig, newRuleId, newUserRule, newProfile, newProfileId, renderMessage
    };
})();

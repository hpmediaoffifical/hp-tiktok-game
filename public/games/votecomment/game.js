/* ============================================================
   HP Vote Bình Luận — Engine helpers (client)
   ============================================================
   Module: window.HpGame.votecomment

   Authoritative state ở SERVER:
     - server hook CHAT/GIFT → cập nhật state → emit 'votecomment:state'
     - panel + overlay nhận state để render

   Engine này chủ yếu là helpers: defaultConfig, newRow, sumPoints, formatClock
   ============================================================ */
(function () {
    'use strict';
    window.HpGame = window.HpGame || {};

    function newRowId() {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function newRow(patch) {
        return Object.assign({
            id: newRowId(),
            keyword: '',
            label: '',
            color: ''
        }, patch || {});
    }

    function defaultConfig() {
        return {
            enabled: true,
            title: 'BIỂU QUYẾT',
            durationSec: 300,
            countingMode: 'both',
            pointsLabel: 'ĐIỂM',
            commentWeight: 1,
            giftWeight: 1,
            joinByGift: false,
            rows: [
                { id: 'r1', keyword: '1', label: 'Lựa chọn 1', color: '' },
                { id: 'r2', keyword: '2', label: 'Lựa chọn 2', color: '' }
            ],
            display: {
                titleSize: 56, itemSize: 36, itemHeight: 84,
                showBar: true,
                overlayBg: 'rgba(28,28,28,0.55)',
                itemBg: 'rgba(139,0,0,0.45)',
                barColor: '#ffce4d',
                textColor: '#ffffff',
                scale: 100, xPercent: 50, yPercent: 50
            }
        };
    }

    function rowPoints(row, countingMode, weights) {
        const cw = (weights && Number(weights.commentWeight) > 0) ? Number(weights.commentWeight) : 1;
        const gw = (weights && Number(weights.giftWeight) > 0) ? Number(weights.giftWeight) : 1;
        const c = Math.round((row.comments | 0) * cw);
        const g = Math.round((row.giftXu | 0) * gw);
        const b = row.bonus | 0;
        // Bonus (nhập tay) LUÔN cộng vào mọi mode — đây là điểm bù do admin/idol cấp
        if (countingMode === 'comments') return c + b;
        if (countingMode === 'gifts') return g + b;
        return c + g + b;
    }

    function totalPoints(rows, countingMode, weights) {
        let t = 0;
        for (const r of rows || []) t += rowPoints(r, countingMode, weights);
        return t;
    }

    function formatClock(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const mm = Math.floor(s / 60);
        const ss = s % 60;
        return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }

    window.HpGame.votecomment = { defaultConfig, newRow, newRowId, rowPoints, totalPoints, formatClock };
})();

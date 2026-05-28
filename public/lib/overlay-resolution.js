// public/lib/overlay-resolution.js
// Shared overlay resolution handler — super-sampling cho 4K stream
//
// CƠ CHẾ ĐÚNG (viewport meta — NOT transform scale):
//   - Lock CSS viewport ở 1080×1920 (kích thước thiết kế gốc của tất cả overlay)
//   - Browser render content fill viewport
//   - Nếu OBS Browser Source = 2160×3840 → DPR (device pixel ratio) = 2 → text/đồ hoạ render sharp 2x
//   - Nếu OBS Browser Source = 1080×1920 → DPR = 1 → render thường (no extra detail)
//
// KEY POINT: với viewport meta, CONTENT KHÔNG TO HƠN khi đổi resolution.
//             Chỉ DETAIL nhiều hơn (anti-aliasing mượt, text sắc nét).
//
// SETUP OBS:
//   1. Add Browser Source với URL có ?res=4k
//   2. Set Width=2160, Height=3840 trong properties
//   3. Source trong scene → bấm Ctrl+F (Fit to Screen) → tự scale 0.5 về 1080×1920
//   4. Hũ/text/đồ họa giữ NGUYÊN size như HD nhưng siêu nét

(function () {
    var url = new URL(window.location.href);
    var res = (url.searchParams.get('res') || 'hd').toLowerCase();
    if (res !== '4k' && res !== '2160' && res !== 'super') return;   // chỉ apply khi explicit 4k

    function apply() {
        if (!document.body) return;

        // ★ Force viewport meta = 1080 → browser maps CSS-1080 đến full Browser Source size
        //    Khi source = 2160×3840 → DPR = 2 → super-sampled. Khi source = 1080×1920 → DPR = 1.
        var viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            document.head.appendChild(viewport);
        }
        viewport.setAttribute('content', 'width=1080, initial-scale=1, user-scalable=no');

        // ★ Lock body to 1080×1920 CSS pixels — content layout giữ NGUYÊN size
        //    KHÔNG dùng transform: scale (sẽ làm content to gấp đôi sai vị trí)
        var style = document.createElement('style');
        style.textContent = [
            'html, body {',
            '  width: 1080px !important;',
            '  height: 1920px !important;',
            '  margin: 0 !important;',
            '  padding: 0 !important;',
            '  overflow: hidden !important;',
            '}',
            // High-quality rendering hints
            'body {',
            '  image-rendering: -webkit-optimize-contrast;',
            '  text-rendering: geometricPrecision;',
            '  -webkit-font-smoothing: antialiased;',
            '  -moz-osx-font-smoothing: grayscale;',
            '}',
            'img, canvas, video {',
            '  image-rendering: high-quality;',
            '}'
        ].join('\n');
        document.head.appendChild(style);

        document.body.dataset.overlayRes = '4k';
        console.log('[overlay-res] 4K mode: viewport=1080×1920 CSS. Set OBS Browser Source = 2160×3840 + Ctrl+F để fit canvas.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
})();

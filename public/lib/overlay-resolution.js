// public/lib/overlay-resolution.js
// Shared overlay resolution handler — đọc ?res= từ URL → apply CSS super-sampling
//
// Cách dùng: thêm <script src="/lib/overlay-resolution.js"></script> vào TOP <head> của overlay
//
// URL options:
//   ?res=4k    → render 2160×3840 internal, scale 2x (super sharp)
//   ?res=hd    → render 1080×1920 (default, no scale)
//   (no param) → mặc định HD
//
// Workflow OBS:
//   1. Add Browser Source với URL có ?res=4k
//   2. Set Width=2160, Height=3840 trong properties
//   3. OBS sẽ tự scale xuống 1080×1920 canvas → text/anti-aliasing siêu nét
//   4. Hoặc giữ nguyên 1080×1920 → vẫn render 4K nội bộ, scale 0.5 ngay trong browser (kém hơn nhưng vẫn nét hơn HD)

(function () {
    var url = new URL(window.location.href);
    var res = (url.searchParams.get('res') || 'hd').toLowerCase();
    if (res !== '4k' && res !== '2160' && res !== 'super') return;   // chỉ apply khi explicit 4k

    // Wait DOMContentLoaded để có document.body
    function apply() {
        if (!document.body) return;
        // CSS super-sampling: render 2160×3840 nội bộ, scale 2x từ top-left
        var style = document.createElement('style');
        style.textContent = [
            'html, body {',
            '  width: 2160px !important;',
            '  height: 3840px !important;',
            '  margin: 0 !important;',
            '  padding: 0 !important;',
            '  overflow: hidden !important;',
            '}',
            'body {',
            '  transform: scale(2) !important;',
            '  transform-origin: 0 0 !important;',
            '  width: 1080px !important;',
            '  height: 1920px !important;',
            '}'
        ].join('\n');
        document.head.appendChild(style);
        document.body.dataset.overlayRes = '4k';
        console.log('[overlay-res] 4K super-sampling enabled (2160×3840 → scale 2x)');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
})();

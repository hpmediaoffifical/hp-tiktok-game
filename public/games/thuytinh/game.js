/*
 * Game: Hủ Thủy Tinh
 * Quà tặng rơi vào hũ thủy tinh với vật lý Matter.js + nhiều tính năng tương tác.
 */
(function (global) {
    const { Engine, Runner, Bodies, Body, Composite, Events } = global.Matter;

    const CANVAS_W = 1080;
    const CANVAS_H = 1920;

    const SHAPE = {
        bodyLeftX: 0.09, bodyRightX: 0.92,
        bodyTopY: 0.12, bodyBottomY: 0.9,
        neckLeftX: 0.15, neckRightX: 0.85,
        neckTopY: 0.195, shoulderY: 0.235
    };
    const JAR_ASPECT = 1024 / 1536;

    function defaultConfig() {
        // ⭐ DEFAULTS = setup vận hành CHỈN CHU của HP Media (v1.0.50+) — áp dụng cho install MỚI.
        // User cũ đã có app-config.json sẽ giữ nguyên config riêng (không bị overwrite).
        // Bao gồm: 21 trigger gán quà → hiệu ứng, badges hiển thị + auto-scroll, hũ khóa,
        // CS HP Media, Goal 5000, panel scales đã tinh chỉnh.
        return {
            // Vị trí hũ — góc dưới-phải, đã tinh chỉnh để cân streamer + chat layout TikTok
            jar: { xPercent: 64.57, yPercent: 76.38, height: 400 },
            gift: { minSize: 40, maxSize: 220, dropHeight: 220, showName: false, showCount: true },
            // Physics: gravity vừa phải, friction thấp → quà rơi mượt, không cứng
            physics: { gravity: 1.4, bounce: 0.4, friction: 0.05 },
            jarVisible: true,
            jarLocked: true,                // khóa hũ — không bị kéo nhầm khi clean stream
            maxCapacity: 0,
            history: { intervalSec: 10, retentionHours: 6 },
            // Feature bật mặc định: Âm thanh + Welcome + Crown + Top tặng + Tổng phiên + Goal Bar + CS
            features: {
                audio: true,
                welcome: true,
                crown: true,
                leaderboard: true,
                sessionTotals: true,
                goalBar: true,
                combo: false,
                tierBorder: false,
                bigGiftFx: false,
                autoShake: false,
                randomEvents: false,
                thiefAuto: false,
                police: true,
                topHangers: true
            },
            goal: { target: 5000 },
            goalBarGap: 0.1,
            autoShakeAt: 500,
            randomEventEverySec: 90,
            thiefEverySec: 60,
            thiefMissRate: 0.1,
            policeCatchRate: 0.1,
            policeBanSec: 60,
            policeName: 'HP Media',
            // 21 trigger preset — mỗi gift ID map tới 1 hiệu ứng
            // (User vẫn có thể đổi qua chuột phải vào card quà)
            triggers: {
                '5585':  'pourOut',
                '5658':  'throwJar',
                '5827':  'shake',
                '6267':  'combo',
                '6788':  'wind',
                '7412':  'joinPolice',
                '7891':  'rain',
                '7934':  'shape',
                '8913':  'stealJar',
                '10961': 'magnet',
                '14219': 'gravflip',
                '15232': 'megaboom',
                '17465': 'ufo',
                '19443': 'kickJar',
                '19447': 'osin',
                '25340': 'crackJar',
                '57327': 'thief'
            },
            // Thông số chi tiết của từng hiệu ứng
            effects: {
                tornado:  { intensity: 0.2 },
                megaboom: { intensity: 1.0 },
                fireworks:{ intensity: 1.0 },
                shake:    { intensity: 1.0 },
                tilt:     { intensity: 1.0 },
                gravflip: { durationMs: 2200 },
                slow:     { timeScale: 0.25, durationMs: 3000 },
                crackJar: { durationSec: 5, count: 6, shatterAt: 3 },
                stealJar: { durationSec: 10, restoreDelaySec: 10 },
                spinJar: { spinSpeed: 1.4, holdMs: 1800, flyHeight: 34, scatterForce: 1.2 },
                zigzagLuck: { durationSec: 60, rows: 6, cols: 9, boardWidthPct: 92, iconSize: 42, dropHeight: 180 },
                combo:    { sequence: 'crackJar:0,crackJar:1.5,crackJar:3,stealJar:5' },
                // Hiệu ứng tạo hình: hút quà bên dưới → ghép thành hình/chữ giữa màn hình →
                // giữ X giây + hiện tên user → rơi tự do. Cho phép NHIỀU quà cùng kích hoạt
                // (trigger map sẽ chứa nhiều giftId cùng action='shape').
                shape: {
                    type: 'heart',          // 'heart' | 'star' | 'circle' | 'triangle' | 'diamond' | 'smile' | 'text'
                    customText: '',         // dùng khi type === 'text' (tối đa ~16 ký tự, hỗ trợ tiếng Việt)
                    sizePercent: 65,        // 20–95% — kích thước hình so với min(W, H)
                    durationMs: 3000,       // thời gian giữ hình trước khi rơi
                    showName: true,         // hiện tên user ở giữa hình
                    nameSize: 64,           // cỡ chữ tên user (px) — 24..160
                    color: '#ffd166'        // màu chữ tên user
                },
                // UFO: hút N quà rớt NGOÀI hũ (escaped) → bay tới miệng hũ → thả vào.
                // VIP PRO hơn OSIN (OSIN chỉ nhặt 1 quà ngoài, UFO nhặt 5-10 quà cùng lúc).
                ufo: {
                    minCapacity: 5,         // hút tối thiểu N quà
                    maxCapacity: 10,        // hút tối đa N quà
                    radiusPct: 40           // bán kính scan (% canvas width) tính từ scan center
                },
                // Dốc ngược hũ: tilt jar gần 180° để đổ hết quà ra → UFO/OSIN cứu lại
                pourOut: {
                    angleDeg: 165,          // góc nghiêng max (gần dốc ngược)
                    holdMs: 1400,           // giữ ở góc max bao lâu (để quà rơi hết)
                    flyToCenter: true,
                    flyMs: 900
                },
                // Mưa quà: spawn random gifts từ đỉnh canvas rơi xuống hũ
                rain: {
                    count: 25,              // số quà spawn (8-50)
                    durationMs: 3000        // thời gian rải spawn
                },
                wind: { durationMs: 4200 },
                // Phun trào: bodies trong hũ bắn lên cao tạo geyser
                geyser: {
                    durationMs: 1800,       // tổng thời gian phun
                    power: 1.0              // độ mạnh (0.5-2.0)
                },
                // Nam châm: bodies hút lẫn nhau trong X giây tạo cụm
                magnet: {
                    durationMs: 3500,
                    pullStrength: 1.0       // 0.5-2.0
                }
            },
            // Vị trí panel UI (đơn vị %) — null = dùng default CSS
            // Badges preset ở góc phải để sát mép TikTok UI, không che hũ
            panelPositions: {
                leaderboard: null,
                caught: null,
                badges: { left: 81.85, top: 23.41 }
            },
            // Tỉ lệ scale panel (Top tặng nhỏ hơn để nhường chỗ Goal bar / badges)
            panelScales: {
                leaderboard: 0.7,
                caught: 1
            },
            // Tỉ lệ scale nhân vật trộm / cảnh sát / osin / ufo (1 = 100% base size)
            actorScales: {
                thief: 1,
                police: 1,
                osin: 1,
                ufo: 1
            },
            // 🎀 Accessory gắn lên miệng hũ — không che thân hũ. Default 'none'.
            jarAccessory: 'none',
            // 🎨 Theme màu hũ — đổi ảnh jar-glass theo PNG khác màu (bên-ngoai folder)
            // Các option: default | blue | cam | green | pink | tim | yellow
            jarTheme: 'default',
            // 🏷 Badge hiệu ứng quà — bật + auto-scroll mặc định cho install mới
            badges: {
                enabled: true,
                layout: 'vertical',
                defaultNamePos: 'bottom',
                scale: 1.25,
                iconScale: 1.6,
                nameScale: 1.0,
                gap: 2.5,
                locked: false,
                // 19 quà preset gán badge — khớp với triggers, customLabel cho 2 hiệu ứng nổi bật
                items: {
                    '5269':  { customLabel: 'Pháo hoa', enabled: true },
                    '5585':  { customLabel: '', enabled: true },
                    '5655':  { customLabel: 'Trộm',    enabled: true },
                    '5658':  { customLabel: '', enabled: true },
                    '5827':  { customLabel: '', enabled: true },
                    '6064':  { customLabel: '', enabled: true },
                    '6267':  { customLabel: '', enabled: true },
                    '7891':  { customLabel: '', enabled: true },
                    '8913':  { customLabel: '', enabled: true },
                    '9340':  { customLabel: '', enabled: true },
                    '10961': { customLabel: '', enabled: true },
                    '14219': { customLabel: '', enabled: true },
                    '17004': { customLabel: '', enabled: true },
                    '17465': { customLabel: '', enabled: true },
                    '19441': { customLabel: '', enabled: true },
                    '19443': { customLabel: '', enabled: true },
                    '19445': { enabled: true },
                    '25340': { customLabel: '', enabled: true },
                    '57327': { enabled: true }
                },
                extras: [],
                // Auto-scroll bật mặc định: cuộn lên 6 quà mỗi 1.3s/quà
                autoScroll: {
                    enabled: true,
                    visibleCount: 6,
                    direction: 'up',
                    speed: 1.3
                }
            }
        };
    }
    // Map theme → file PNG hũ ngoài (bên-ngoai folder)
    const JAR_THEME_PATHS = {
        default: '/assets/thuytinh/ben-ngoai/jar-glass.png',
        blue:    '/assets/thuytinh/ben-ngoai/jar-glass_blue.png',
        cam:     '/assets/thuytinh/ben-ngoai/jar-glass_cam.png',
        green:   '/assets/thuytinh/ben-ngoai/jar-glass_green.png',
        pink:    '/assets/thuytinh/ben-ngoai/jar-glass_pink.png',
        tim:     '/assets/thuytinh/ben-ngoai/jar-glass_tim.png',
        yellow:  '/assets/thuytinh/ben-ngoai/jar-glass_yellow.png'
    };
    // SVG accessories gắn lên miệng hũ (vị trí = neck top, không che body jar).
    // Mỗi SVG có viewBox 200x100, render scale theo jar width.
    const JAR_ACCESSORIES = {
        none: '',
        'bow-pink': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="bpG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#ffa3c5"/><stop offset="0.5" stop-color="#ff5d8f"/><stop offset="1" stop-color="#d63384"/>
            </linearGradient></defs>
            <path d="M30 50 Q15 20 50 30 Q85 40 100 55 Q85 70 50 80 Q15 80 30 50 Z" fill="url(#bpG)" stroke="#a02560" stroke-width="2"/>
            <path d="M170 50 Q185 20 150 30 Q115 40 100 55 Q115 70 150 80 Q185 80 170 50 Z" fill="url(#bpG)" stroke="#a02560" stroke-width="2"/>
            <ellipse cx="100" cy="55" rx="15" ry="18" fill="#ff5d8f" stroke="#a02560" stroke-width="2"/>
            <path d="M85 80 L75 100 L95 90 Z" fill="url(#bpG)" stroke="#a02560" stroke-width="1.5"/>
            <path d="M115 80 L125 100 L105 90 Z" fill="url(#bpG)" stroke="#a02560" stroke-width="1.5"/>
        </svg>`,
        'bow-blue': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="bbG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#7dd3fc"/><stop offset="0.5" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/>
            </linearGradient></defs>
            <path d="M30 50 Q15 20 50 30 Q85 40 100 55 Q85 70 50 80 Q15 80 30 50 Z" fill="url(#bbG)" stroke="#1e3a8a" stroke-width="2"/>
            <path d="M170 50 Q185 20 150 30 Q115 40 100 55 Q115 70 150 80 Q185 80 170 50 Z" fill="url(#bbG)" stroke="#1e3a8a" stroke-width="2"/>
            <ellipse cx="100" cy="55" rx="15" ry="18" fill="#3b82f6" stroke="#1e3a8a" stroke-width="2"/>
            <path d="M85 80 L75 100 L95 90 Z" fill="url(#bbG)" stroke="#1e3a8a" stroke-width="1.5"/>
            <path d="M115 80 L125 100 L105 90 Z" fill="url(#bbG)" stroke="#1e3a8a" stroke-width="1.5"/>
        </svg>`,
        'bow-white': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="bwG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#f1f5f9"/><stop offset="1" stop-color="#cbd5e1"/>
            </linearGradient></defs>
            <path d="M30 50 Q15 20 50 30 Q85 40 100 55 Q85 70 50 80 Q15 80 30 50 Z" fill="url(#bwG)" stroke="#94a3b8" stroke-width="2"/>
            <path d="M170 50 Q185 20 150 30 Q115 40 100 55 Q115 70 150 80 Q185 80 170 50 Z" fill="url(#bwG)" stroke="#94a3b8" stroke-width="2"/>
            <ellipse cx="100" cy="55" rx="15" ry="18" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
            <path d="M85 80 L75 100 L95 90 Z" fill="url(#bwG)" stroke="#94a3b8" stroke-width="1.5"/>
            <path d="M115 80 L125 100 L105 90 Z" fill="url(#bwG)" stroke="#94a3b8" stroke-width="1.5"/>
        </svg>`,
        'bow-black': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="bkG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#475569"/><stop offset="0.5" stop-color="#1e293b"/><stop offset="1" stop-color="#0f172a"/>
            </linearGradient></defs>
            <path d="M30 50 Q15 20 50 30 Q85 40 100 55 Q85 70 50 80 Q15 80 30 50 Z" fill="url(#bkG)" stroke="#000" stroke-width="2"/>
            <path d="M170 50 Q185 20 150 30 Q115 40 100 55 Q115 70 150 80 Q185 80 170 50 Z" fill="url(#bkG)" stroke="#000" stroke-width="2"/>
            <ellipse cx="100" cy="55" rx="15" ry="18" fill="#1e293b" stroke="#000" stroke-width="2"/>
            <path d="M85 80 L75 100 L95 90 Z" fill="url(#bkG)" stroke="#000" stroke-width="1.5"/>
            <path d="M115 80 L125 100 L105 90 Z" fill="url(#bkG)" stroke="#000" stroke-width="1.5"/>
        </svg>`,
        'crown': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="crG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#fde047"/><stop offset="0.5" stop-color="#fbbf24"/><stop offset="1" stop-color="#b45309"/>
            </linearGradient></defs>
            <path d="M40 80 L55 30 L80 60 L100 20 L120 60 L145 30 L160 80 Z" fill="url(#crG)" stroke="#78350f" stroke-width="3"/>
            <rect x="40" y="78" width="120" height="14" fill="#fbbf24" stroke="#78350f" stroke-width="2"/>
            <circle cx="55" cy="30" r="6" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.5"/>
            <circle cx="100" cy="20" r="7" fill="#22d3ee" stroke="#0e7490" stroke-width="1.5"/>
            <circle cx="145" cy="30" r="6" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.5"/>
            <circle cx="100" cy="85" r="4" fill="#fff"/><circle cx="70" cy="85" r="3" fill="#fff"/><circle cx="130" cy="85" r="3" fill="#fff"/>
        </svg>`,
        'flower-cherry': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <g transform="translate(60,50)"><circle cx="0" cy="-20" r="14" fill="#fda4af"/><circle cx="19" cy="-6" r="14" fill="#fda4af"/><circle cx="12" cy="16" r="14" fill="#fda4af"/><circle cx="-12" cy="16" r="14" fill="#fda4af"/><circle cx="-19" cy="-6" r="14" fill="#fda4af"/><circle cx="0" cy="0" r="6" fill="#fbbf24"/></g>
            <g transform="translate(140,50)"><circle cx="0" cy="-20" r="14" fill="#fda4af"/><circle cx="19" cy="-6" r="14" fill="#fda4af"/><circle cx="12" cy="16" r="14" fill="#fda4af"/><circle cx="-12" cy="16" r="14" fill="#fda4af"/><circle cx="-19" cy="-6" r="14" fill="#fda4af"/><circle cx="0" cy="0" r="6" fill="#fbbf24"/></g>
            <g transform="translate(100,40) scale(0.7)"><circle cx="0" cy="-20" r="14" fill="#ec4899"/><circle cx="19" cy="-6" r="14" fill="#ec4899"/><circle cx="12" cy="16" r="14" fill="#ec4899"/><circle cx="-12" cy="16" r="14" fill="#ec4899"/><circle cx="-19" cy="-6" r="14" fill="#ec4899"/><circle cx="0" cy="0" r="6" fill="#fde047"/></g>
        </svg>`,
        'star-gold': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="sgG"><stop offset="0" stop-color="#fde047"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
            <path d="M100 10 L114 50 L156 50 L122 75 L135 115 L100 90 L65 115 L78 75 L44 50 L86 50 Z" fill="url(#sgG)" stroke="#78350f" stroke-width="2"/>
            <circle cx="35" cy="30" r="4" fill="#fff" opacity="0.9"/>
            <circle cx="170" cy="35" r="3" fill="#fff" opacity="0.9"/>
            <circle cx="160" cy="75" r="3" fill="#fff" opacity="0.9"/>
        </svg>`,
        'leaves-christmas': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <g><path d="M20 60 Q60 30 100 50 Q140 30 180 60 L180 80 Q140 60 100 80 Q60 60 20 80 Z" fill="#15803d" stroke="#14532d" stroke-width="2"/>
            <circle cx="50" cy="70" r="6" fill="#dc2626" stroke="#7f1d1d" stroke-width="1"/>
            <circle cx="100" cy="55" r="7" fill="#dc2626" stroke="#7f1d1d" stroke-width="1"/>
            <circle cx="150" cy="70" r="6" fill="#dc2626" stroke="#7f1d1d" stroke-width="1"/>
            <circle cx="75" cy="50" r="4" fill="#fbbf24"/>
            <circle cx="125" cy="50" r="4" fill="#fbbf24"/></g>
        </svg>`,
        'gem-diamond': `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="gdG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#7dd3fc"/><stop offset="0.5" stop-color="#06b6d4"/><stop offset="1" stop-color="#0e7490"/>
            </linearGradient></defs>
            <path d="M100 10 L150 40 L100 95 L50 40 Z" fill="url(#gdG)" stroke="#0e7490" stroke-width="2"/>
            <path d="M100 10 L150 40 L100 50 L50 40 Z" fill="#bae6fd" opacity="0.7"/>
            <path d="M100 10 L100 50 L80 30 Z" fill="#fff" opacity="0.6"/>
        </svg>`
    };

    // ===== Audio (Web Audio API tổng hợp âm thanh, không cần file) =====
    const audio = (() => {
        let ctx = null;
        let noiseBuf = null;
        function ensureCtx() {
            // Game đã TẮT trong Thư viện → mọi âm thanh tắt (defense-in-depth — caller phía
            // app.js + overlay.html cũng đã gate spawn, đây là chốt cuối).
            if (config.enabled === false) return null;
            if (!ctx) try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
            return ctx;
        }
        function getNoiseBuffer() {
            const a = ensureCtx(); if (!a) return null;
            if (noiseBuf) return noiseBuf;
            const len = a.sampleRate * 2;
            noiseBuf = a.createBuffer(1, len, a.sampleRate);
            const data = noiseBuf.getChannelData(0);
            for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
            return noiseBuf;
        }
        function tone(freq, dur, type = 'sine', vol = 0.15) {
            const a = ensureCtx(); if (!a) return;
            const o = a.createOscillator();
            const g = a.createGain();
            o.type = type; o.frequency.value = freq;
            g.gain.value = vol;
            o.connect(g); g.connect(a.destination);
            const t0 = a.currentTime;
            g.gain.setValueAtTime(vol, t0);
            g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
            o.start(t0); o.stop(t0 + dur + 0.02);
        }
        // Frequency sweep: dùng cho whoosh / beam / suck
        function sweep(fromHz, toHz, dur, type = 'sawtooth', vol = 0.12) {
            const a = ensureCtx(); if (!a) return;
            const o = a.createOscillator();
            const g = a.createGain();
            o.type = type;
            const t0 = a.currentTime;
            o.frequency.setValueAtTime(fromHz, t0);
            o.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), t0 + dur);
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.05, dur * 0.2));
            g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
            o.connect(g); g.connect(a.destination);
            o.start(t0); o.stop(t0 + dur + 0.02);
        }
        // Filtered noise burst — dùng cho rumble, crash, cascade
        function noise(dur, freqCenter = 800, q = 8, vol = 0.18) {
            const a = ensureCtx(); if (!a) return;
            const buf = getNoiseBuffer(); if (!buf) return;
            const src = a.createBufferSource(); src.buffer = buf;
            const filter = a.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = freqCenter;
            filter.Q.value = q;
            const g = a.createGain();
            const t0 = a.currentTime;
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
            src.connect(filter); filter.connect(g); g.connect(a.destination);
            src.start(t0); src.stop(t0 + dur + 0.02);
        }

        // UFO drone hum — trả về stop() để gọi khi UFO rời đi
        function ufoHum() {
            const a = ensureCtx(); if (!a) return () => {};
            const o1 = a.createOscillator();
            const o2 = a.createOscillator();
            const lfo = a.createOscillator();   // vibrato
            const lfoGain = a.createGain();
            const g = a.createGain();
            o1.type = 'sawtooth'; o1.frequency.value = 90;
            o2.type = 'sine';     o2.frequency.value = 135;
            lfo.frequency.value = 4.5; lfoGain.gain.value = 6;
            const t0 = a.currentTime;
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(0.06, t0 + 0.6);   // fade in
            lfo.connect(lfoGain);
            lfoGain.connect(o1.frequency);
            lfoGain.connect(o2.frequency);
            o1.connect(g); o2.connect(g); g.connect(a.destination);
            o1.start(t0); o2.start(t0); lfo.start(t0);
            let stopped = false;
            return function stop() {
                if (stopped) return; stopped = true;
                const t = a.currentTime;
                g.gain.cancelScheduledValues(t);
                g.gain.setValueAtTime(g.gain.value, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
                o1.stop(t + 0.55); o2.stop(t + 0.55); lfo.stop(t + 0.55);
            };
        }

        return {
            plop: () => tone(360, 0.07, 'sine', 0.18),
            ting: () => tone(1240, 0.08, 'triangle', 0.14),
            big: () => { tone(180, 0.1, 'sawtooth', 0.18); setTimeout(() => tone(280, 0.15, 'square', 0.12), 80); },
            fanfare: () => {
                const seq = [523, 659, 784, 1047];
                seq.forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.18), i * 110));
            },
            steal: () => { tone(800, 0.06, 'square', 0.12); setTimeout(() => tone(420, 0.08, 'sawtooth', 0.12), 60); },

            // ===== UFO sounds =====
            ufoHum,
            // Beam activate: sweep tăng tone + nhẹ noise hiss
            ufoBeam: () => { sweep(200, 1400, 0.45, 'sawtooth', 0.10); noise(0.45, 2400, 14, 0.06); },
            // Mỗi lần hút 1 quà: whoosh up
            ufoSuck: () => sweep(400, 1600, 0.35, 'triangle', 0.10),
            // Mỗi lần thả quà rơi vào hũ: bậc xuống + plop
            ufoDrop: () => { sweep(900, 220, 0.25, 'triangle', 0.09); setTimeout(() => tone(380, 0.06, 'sine', 0.16), 200); },
            // UFO arrival/exit swoosh
            ufoArrive: () => sweep(120, 600, 0.6, 'sawtooth', 0.10),
            ufoExit:   () => sweep(700, 90, 0.7, 'sawtooth', 0.10),

            // ===== Effects khác =====
            // Dốc ngược hũ: rumble dài + crash khi quà đổ ra
            pourOut: () => {
                noise(1.2, 180, 3, 0.16);                                        // rumble bass
                sweep(400, 120, 1.0, 'sawtooth', 0.08);                          // jar tilt creak
                setTimeout(() => noise(0.5, 800, 5, 0.14), 1100);                // cascade khi quà rơi
                setTimeout(() => { for (let i = 0; i < 6; i++) setTimeout(() => tone(280 + Math.random()*200, 0.06, 'sine', 0.12), i * 50); }, 1100);
            },
            // Lốc xoáy: wind whistle
            tornado: () => { sweep(200, 800, 0.6, 'sine', 0.10); noise(0.8, 1500, 6, 0.10); },
            // Slow motion: descending tone
            slow: () => sweep(600, 150, 0.5, 'sine', 0.10),
            // Đảo trọng lực: dual tone WOW effect
            gravflip: () => { tone(523, 0.15, 'square', 0.10); setTimeout(() => tone(330, 0.2, 'triangle', 0.12), 130); },
            // ☔ Rain: continuous noise + occasional drops
            rain: () => { noise(2.5, 1500, 4, 0.10); },
            // 🚀 Geyser: rising whoosh + bass
            geyser: () => { sweep(180, 800, 1.5, 'sawtooth', 0.12); noise(1.2, 400, 3, 0.10); },
            // 🧲 Magnet: subtle hum + ting on attract
            magnet: () => { tone(880, 0.5, 'sine', 0.06); setTimeout(() => tone(1320, 0.3, 'triangle', 0.08), 250); }
        };
    })();

    function create(opts) {
        const canvas = opts.canvas;
        const ctx = canvas.getContext('2d');
        const fxCanvas = opts.fxCanvas || null;
        const fxCtx = fxCanvas ? fxCanvas.getContext('2d') : null;
        const jarBottomEl = opts.jarBottomEl;
        const jarGlassEl = opts.jarGlassEl;
        const countDisplay = opts.countDisplay || null;
        const overlayLayer = opts.overlayLayer || null; // host cho welcome/crown/leaderboard/goal/totals/thief
        const onCountChange = opts.onCountChange || (() => {});
        const onStatsChange = opts.onStatsChange || (() => {});
        const onPanelMoved = opts.onPanelMoved || (() => {});
        const onBail = opts.onBail || (() => {});
        // ===== MIRROR MODE =====
        // mirrorMode = true → instance này là OBS overlay (đứng đọc), KHÔNG tự chạy trigger logic.
        // OBS chỉ render bodies + state nhận từ App. Trigger animations (thief, fxFireworks...)
        // chạy qua gameCmd từ App đẩy sang.
        // mirrorMode = false (mặc định) → App preview là authoritative, chạy tất cả logic.
        const mirrorMode = !!opts.mirrorMode;
        // onTrigger callback — App gọi sau khi resolve random outcome → broadcast cmd cho OBS replay
        const onTrigger = opts.onTrigger || (() => {});

        let config = mergeConfig(defaultConfig(), opts.config || {});
        const DISABLED_TRIGGER_ACTIONS = new Set(['tilt', 'fireworks', 'tornado', 'geyser', 'slow']);
        const SINGLE_RUN_TRIGGER_ACTIONS = new Set(['joinPolice', 'clear']);
        const engine = Engine.create();
        engine.gravity.y = config.physics.gravity;

        const bodies = [];
        const giftHistory = [];
        const HISTORY_MAX = 60;
        let historyTimer = null;
        let lastHistoryHash = '';
        let jarWalls = [];      // walls riêng của hũ — có thể tháo tạm khi spill/shatter
        let worldWalls = [];    // floor + 2 side walls — LUÔN giữ, để quà stack ở đáy overlay
        // Compat: nhiều chỗ cũ tham chiếu tới `walls` cho mọi walls — alias
        let walls = [];
        // fxTilt state — instance scope để buildJarWalls có thể reset khi rebuild
        let tiltAnimating = false;
        let currentTiltAngle = 0;
        const imgCache = new Map();
        let spawnQueue = [];
        let spawnTicker = null;

        function isEnabled() {
            return config.enabled !== false;
        }

        // ===== State =====
        const stats = {
            totalDiamonds: 0,
            totalGifts: 0,
            sessionStart: Date.now(),
            tippers: new Map(),
            seenGiftTypes: new Set(),
            combos: new Map(),
            recentTopUid: null,
            goalReached: false,
            caughtList: []            // [{ name, avatar, releaseAt }]
        };
        const fxAnimations = []; // { type, ... }

        // ===== Geometry =====
        function jarRect() {
            const h = config.jar.height;
            const w = h * JAR_ASPECT;
            const cx = CANVAS_W * config.jar.xPercent / 100;
            const cy = CANVAS_H * config.jar.yPercent / 100;
            return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
        }

        function positionJar() {
            const r = jarRect();
            const setStyle = (el) => {
                if (!el) return;
                el.style.position = 'absolute';
                el.style.left = (r.x / CANVAS_W * 100) + '%';
                el.style.top = (r.y / CANVAS_H * 100) + '%';
                el.style.width = (r.w / CANVAS_W * 100) + '%';
                el.style.height = (r.h / CANVAS_H * 100) + '%';
                el.style.opacity = config.jarVisible ? '1' : '0';
                el.style.pointerEvents = 'none';
            };
            setStyle(jarBottomEl);
            setStyle(jarGlassEl);
            // Clear filter cũ nếu có (legacy theme jar)
            if (jarBottomEl) jarBottomEl.style.filter = '';
            if (jarGlassEl)  jarGlassEl.style.filter  = '';
            buildWalls();
            positionAccessory();
            positionUiOverlays();
            updateCountDisplay();
        }

        function makeWall(x, y, w, h, angle = 0) {
            return Bodies.rectangle(x, y, w, h, {
                isStatic: true, angle, friction: 0.6, restitution: 0.1
            });
        }

        function buildWorldWalls() {
            if (worldWalls.length) return; // chỉ build 1 lần
            // Floor SÁT đáy canvas — TOP EDGE ở y = CANVAS_H. Thickness 400px → chống tunneling
            // khi OBS browser source chạy ở 30fps (dt tăng → bodies di chuyển nhiều/tick).
            // Tường mỏng 24px cũ → bodies vận tốc cao có thể xuyên qua → mất quà.
            worldWalls.push(makeWall(CANVAS_W / 2, CANVAS_H + 200, CANVAS_W + 200, 400));
            // Side walls: thick, span well beyond canvas
            worldWalls.push(makeWall(-100, CANVAS_H / 2, 200, CANVAS_H + 400));
            worldWalls.push(makeWall(CANVAS_W + 100, CANVAS_H / 2, 200, CANVAS_H + 400));
            // CEILING — chặn quà bay ra khỏi đỉnh overlay khi đảo trọng lực / lốc xoáy.
            worldWalls.push(makeWall(CANVAS_W / 2, -2100, CANVAS_W + 200, 200));
            Composite.add(engine.world, worldWalls);
        }
        function buildJarWalls() {
            if (jarWalls.length) { Composite.remove(engine.world, jarWalls); jarWalls = []; }
            // Reset tilt state — walls vừa rebuild ở angle = 0. Nếu đang có fxTilt chạy,
            // applyTilt sau đó sẽ tự tính delta đúng từ 0.
            currentTiltAngle = 0;
            const r = jarRect();
            const T = 14;
            const lx = r.x + r.w * SHAPE.bodyLeftX;
            const rx = r.x + r.w * SHAPE.bodyRightX;
            const by = r.y + r.h * SHAPE.bodyBottomY;
            const sy = r.y + r.h * SHAPE.shoulderY;
            const nlx = r.x + r.w * SHAPE.neckLeftX;
            const nrx = r.x + r.w * SHAPE.neckRightX;
            const nty = r.y + r.h * SHAPE.neckTopY;
            // Đáy hũ — TOP EDGE ở y=by (vị trí visual giữ nguyên), thickness 80px (vs cũ 28px).
            // Chống tunneling khi body rơi nhanh trong OBS (30fps → dt cao → di chuyển nhiều/tick).
            const FLOOR_T = 80;
            jarWalls.push(makeWall(lx + (rx - lx) / 2, by + FLOOR_T / 2, rx - lx + T, FLOOR_T));
            const bh = by - sy;
            jarWalls.push(makeWall(lx, sy + bh / 2, T, bh));
            jarWalls.push(makeWall(rx, sy + bh / 2, T, bh));
            let dx = nlx - lx, dy = sy - nty;
            let len = Math.hypot(dx, dy); let ang = Math.atan2(dy, -dx);
            jarWalls.push(makeWall((lx + nlx) / 2, (sy + nty) / 2, len, T, -ang));
            dx = rx - nrx;
            len = Math.hypot(dx, dy); ang = Math.atan2(dy, dx);
            jarWalls.push(makeWall((rx + nrx) / 2, (sy + nty) / 2, len, T, ang));
            const nh = sy - nty;
            jarWalls.push(makeWall(nlx, nty + nh / 2, T, nh + 8));
            jarWalls.push(makeWall(nrx, nty + nh / 2, T, nh + 8));
            Composite.add(engine.world, jarWalls);
        }
        function removeJarWalls() {
            if (jarWalls.length) Composite.remove(engine.world, jarWalls);
            jarWalls = [];
        }
        function clearJarLandingZone(rect = jarRect()) {
            const top = rect.y + rect.h * SHAPE.neckTopY - 25;
            const bottom = rect.y + rect.h * SHAPE.bodyBottomY + 55;
            const left = rect.x + rect.w * SHAPE.bodyLeftX - 35;
            const right = rect.x + rect.w * SHAPE.bodyRightX + 35;
            const cx = rect.cx;
            for (const b of bodies) {
                const p = b.position;
                if (p.x < left || p.x > right || p.y < top || p.y > bottom) continue;
                const side = p.x < cx ? -1 : 1;
                const targetX = side < 0 ? left - (b.gm?.sz || 40) * 0.9 : right + (b.gm?.sz || 40) * 0.9;
                try {
                    Body.setPosition(b, { x: targetX, y: p.y - 8 });
                    Body.setVelocity(b, { x: side * (5 + Math.random() * 4), y: -1.5 - Math.random() * 2 });
                    Body.setAngularVelocity(b, side * (0.18 + Math.random() * 0.2));
                } catch (e) {}
            }
        }
        function buildWalls() {
            buildWorldWalls();
            buildJarWalls();
            // Compat: legacy code đọc walls.length
            walls = jarWalls.concat(worldWalls);
        }

        function giftSize(coins) {
            const t = Math.log(Math.max(coins || 1, 1)) / Math.log(35000);
            const k = Math.min(1, Math.max(0, t));
            return Math.round(config.gift.minSize + (config.gift.maxSize - config.gift.minSize) * k);
        }

        function tierOf(coins) {
            if (coins >= 5000) return 'diamond';
            if (coins >= 500) return 'gold';
            if (coins >= 100) return 'silver';
            return null;
        }

        // ===== Drop =====
        function drop(g, count) {
            if (!isEnabled()) return;
            const n = Math.max(1, parseInt(count || g.repeatCount || 1, 10));
            let triggerAction = config.triggers && config.triggers[String(g.giftId)];
            if (DISABLED_TRIGGER_ACTIONS.has(triggerAction)) triggerAction = null;
            if (triggerAction) {
                // Quà kích hoạt — KHÔNG rơi vào hũ
                // Mirror mode (OBS): KHÔNG chạy trigger ở local. Đợi App broadcast gameCmd với
                // outcome đã được resolve để OBS replay đồng bộ. Vẫn record tipper + welcome cho
                // visual UI consistency.
                recordTipper(g, n);
                handleWelcome(g);
                checkGoal();
                if (mirrorMode) return;
                const userInfo = {
                    name: g.nickname || g.uniqueId || 'Khách',
                    avatar: g.profilePicture,
                    uid: String(g.userId || g.uniqueId || '')
                };
                handleCombo(g, n);
                checkBigGiftFx(g, n);
                const runs = SINGLE_RUN_TRIGGER_ACTIONS.has(triggerAction) ? 1 : n;
                for (let i = 0; i < runs; i++) {
                    const payload = { ...userInfo, comboIndex: i + 1, comboCount: n };
                    // v1.0.73 fix: combo gift bị drop với các hiệu ứng single-instance (osin/ufo/kick/
                    // throw/spin/pour/shape/tilt/stealJar) vì guard `xBusy`. Trước đây setTimeout 120ms
                    // không đủ — call 2-N hit guard và bị bỏ. Giờ enqueue qua serial dispatcher: hiệu ứng
                    // serial chờ busy clear rồi mới chạy tiếp; hiệu ứng parallel-safe (megaboom/shake/rain/
                    // magnet/wind/gravflip/crackJar/zigzag/combo) vẫn fire ngay với spacing 120ms như cũ.
                    enqueueTriggerRun(triggerAction, payload, i);
                }
                return;
            }
            for (let i = 0; i < n; i++) spawnQueue.push(g);
            if (!spawnTicker) spawnTicker = setInterval(processQueue, 45);
            recordTipper(g, n);
            handleCombo(g, n);
            handleWelcome(g);
            checkBigGiftFx(g, n);
            checkGoal();
        }

        function runTriggerAction(action, userInfo) {
            switch (action) {
                case 'thief': triggerThief(userInfo); break;
                case 'joinPolice': togglePoliceMembership(userInfo); break;
                case 'fireworks': fxFireworks(); if (config.features.audio) audio.big(); break;
                case 'megaboom': fxMegaboom(); if (config.features.audio) audio.fanfare(); break;
                case 'tornado': fxTornado(); break;
                case 'tilt': fxTilt(); break;
                case 'pourOut': fxPourOut(); break;
                case 'gravflip': fxGravFlip(); break;
                case 'shake': shake(); break;
                case 'clear': clearAll(); break;
                case 'slow': fxSlow(); break;
                case 'rain': fxRain(); break;
                case 'geyser': fxGeyser(); break;
                case 'magnet': fxMagnet(); break;
                case 'wind': fxWind(); break;
                case 'crackJar': fxCrackJar(); break;
                case 'stealJar': fxStealJar(); break;
                case 'osin': triggerOsin(userInfo); break;
                case 'ufo': triggerUFO(userInfo); break;
                case 'kickJar': fxKickJar(userInfo); break;
                case 'throwJar': fxThrowJar(userInfo); break;
                case 'spinJar': fxSpinJar(userInfo); break;
                case 'osinKickOut': fxOsinKickOut(userInfo); break;
                case 'dragonFire': fxDragonFire(userInfo); break;
                case 'zigzagLuck': fxZigzagLuck(userInfo); break;
                case 'combo': fxCombo(userInfo); break;
                case 'shape': fxShape(userInfo); break;
            }
            // App broadcast cmd cho OBS replay cùng action (chỉ chạy ở authoritative mode)
            if (!mirrorMode) onTrigger(action, userInfo);
        }

        // ============================================================
        // v1.0.73 — Serial trigger queue (fix combo gift)
        // ============================================================
        // Bug v1.0.68 và trước: combo gift x10 → các effect single-instance (osin/ufo/pour/kick/throw/
        // spin/shape/tilt/stealJar) chỉ chạy 1 lần. Các call 2-N hit guard `xBusy` và silently return.
        //
        // Fix: per-action queue. Mỗi action có queue riêng + 1 worker. Worker check busy state → khi
        // clear thì dequeue và chạy tiếp. Effect parallel-safe (megaboom/shake/rain/magnet/wind/gravflip/
        // crackJar/zigzagLuck/combo/fireworks/tornado/geyser/slow) → isActionBusy luôn false → drains
        // tức thì với spacing 120ms giữ feel "rolling" cho khán giả.
        //
        // SERIAL_ACTIONS: list các action có guard xBusy. Predicate isActionBusy đọc trực tiếp các flag
        // local trong IIFE để không lệch state. Khi thêm effect mới có guard, add vào đây.
        const SERIAL_ACTIONS = new Set([
            'osin', 'ufo', 'pourOut', 'kickJar', 'throwJar', 'spinJar',
            'shape', 'stealJar', 'tilt'
        ]);
        function isActionBusy(action) {
            switch (action) {
                case 'pourOut':
                case 'tilt':     return tiltAnimating || spillInProgress || jarStolen;
                case 'osin':     return osinBusy;
                case 'ufo':      return ufoBusy;
                case 'kickJar':  return kickJarBusy || jarStolen;
                case 'throwJar': return throwJarBusy || kickJarBusy || jarStolen;
                case 'spinJar':  return spinJarBusy || kickJarBusy || throwJarBusy || tiltAnimating || jarStolen;
                case 'shape':    return shapeBusy;
                case 'stealJar': return jarStolen;
                default:         return false;  // parallel-safe — never queue
            }
        }
        const triggerQueues = {};   // { actionName: { items: [...], pumping: bool } }
        function enqueueTriggerRun(action, payload, comboIdx) {
            // Parallel-safe effects: vẫn dùng spacing 120ms như cũ (feel rolling)
            if (!SERIAL_ACTIONS.has(action)) {
                const delayMs = (comboIdx || 0) * 120;
                if (delayMs) setTimeout(() => runTriggerAction(action, payload), delayMs);
                else runTriggerAction(action, payload);
                return;
            }
            // Serial effects: queue + worker pump theo busy state
            let q = triggerQueues[action];
            if (!q) q = triggerQueues[action] = { items: [], pumping: false };
            q.items.push(payload);
            pumpTriggerQueue(action);
        }
        function pumpTriggerQueue(action) {
            const q = triggerQueues[action];
            if (!q || q.pumping) return;
            q.pumping = true;
            const tick = () => {
                if (!q.items.length) { q.pumping = false; return; }
                if (isActionBusy(action)) {
                    // Đợi busy clear — poll 250ms cho responsive nhưng không tốn CPU
                    setTimeout(tick, 250);
                    return;
                }
                const payload = q.items.shift();
                runTriggerAction(action, payload);
                // Sau khi gọi: busy flag thường set true trong vài chục ms (effects async).
                // Chờ 400ms để busy flag kịp set, sau đó tick để check (sẽ thấy busy → đợi tiếp).
                // Nếu effect quá ngắn không set busy → 400ms sau tick thấy clear → dequeue tiếp ngay.
                setTimeout(tick, 400);
            };
            tick();
        }

        function fxCombo(userInfo) {
            const seq = (config.effects?.combo?.sequence || '').trim();
            if (!seq) return;
            // Format: "effect:delaySec, effect:delaySec, ..."
            const parts = seq.split(',').map(s => s.trim()).filter(Boolean);
            for (const p of parts) {
                const [actionRaw, delayRaw] = p.split(':').map(s => (s || '').trim());
                if (!actionRaw || actionRaw === 'combo') continue; // tránh đệ quy
                const delayMs = Math.max(0, (parseFloat(delayRaw) || 0) * 1000);
                setTimeout(() => runTriggerAction(actionRaw, userInfo), delayMs);
            }
        }

        function togglePoliceMembership(userInfo) {
            const uid = String(userInfo?.uid || '');
            if (!uid) return;
            if (policeForce.has(uid)) {
                policeForce.delete(uid);
                flashPoliceJoinToast(userInfo.name || 'User', false);
            } else {
                policeForce.set(uid, {
                    uid,
                    name: userInfo.name || 'CS',
                    avatar: userInfo.avatar || '',
                    joinedAt: Date.now()
                });
                // Nếu user đang bị giam → tự ân xá khi gia nhập đội
                bannedUntilByUid.delete(uid);
                stats.caughtList = stats.caughtList.filter(c => String(c.uid) !== uid);
                updateCaughtList();
                flashPoliceJoinToast(userInfo.name || 'User', true);
            }
            updatePoliceForcePanel();
            if (config.features.audio) audio.ting();
        }
        function flashPoliceJoinToast(name, joined) {
            showComboToast(
                joined
                    ? `🚓 <b>${escHtml(name)}</b> gia nhập lực lượng Cảnh sát!`
                    : `🚪 <b>${escHtml(name)}</b> rời lực lượng Cảnh sát`,
                joined
                    ? 'linear-gradient(135deg, #2563eb, #0ea5e9)'
                    : 'linear-gradient(135deg, #6b7280, #4b5563)'
            );
        }
        function isInPoliceForce(uid) { return !!uid && policeForce.has(String(uid)); }
        function processQueue() {
            if (!spawnQueue.length) { clearInterval(spawnTicker); spawnTicker = null; return; }
            const batch = Math.min(2, spawnQueue.length);
            for (let i = 0; i < batch; i++) dropOne(spawnQueue.shift());
        }
        function isJarFull() { return config.maxCapacity > 0 && bodies.length >= config.maxCapacity; }

        function loadImage(g) {
            const key = g.giftId || g.image || Math.random().toString(36);
            if (imgCache.has(key)) return imgCache.get(key);
            const im = new Image();
            im.onerror = () => {
                const oc = document.createElement('canvas');
                oc.width = 96; oc.height = 96;
                const oc2 = oc.getContext('2d');
                const hue = (parseInt(g.giftId, 10) || 0) % 360;
                oc2.fillStyle = `hsl(${hue},60%,50%)`;
                oc2.beginPath(); oc2.arc(48, 48, 44, 0, Math.PI * 2); oc2.fill();
                oc2.fillStyle = '#fff';
                oc2.font = 'bold 14px Arial';
                oc2.textAlign = 'center';
                const label = (g.giftName || g.giftId || '?').toString().slice(0, 8);
                oc2.fillText(label, 48, 54);
                const fallback = new Image();
                fallback.src = oc.toDataURL();
                imgCache.set(key, fallback);
            };
            im.src = g.image || '';
            imgCache.set(key, im);
            return im;
        }

        function makeGiftBody(g, x, y, sz, velocity) {
            const body = Bodies.circle(x, y, sz / 2, {
                restitution: config.physics.bounce,
                friction: config.physics.friction,
                density: 0.002
            });
            body.gm = {
                id: g.giftId,
                name: g.giftName || g.name,
                coins: g.coinValue || 1,
                tier: tierOf(g.coinValue || 1),
                sz,
                img: loadImage(g),
                tipperUid: g.userId || g.uniqueId
            };
            Body.setVelocity(body, velocity || { x: 0, y: 2 });
            Composite.add(engine.world, body);
            bodies.push(body);
            return body;
        }
        function scaleGiftBody(body, targetSize) {
            if (!body?.gm) return;
            const cur = Math.max(1, body.gm.sz || targetSize);
            const next = Math.max(12, targetSize || cur);
            const factor = next / cur;
            if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.02) return;
            Body.scale(body, factor, factor);
            body.gm.sz = next;
        }

        function dropOne(g) {
            if (isJarFull()) return;
            if (zigzagLuck.active) {
                dropOneZigzag(g);
                return;
            }
            const sz = giftSize(g.coinValue);
            const r = jarRect();
            const nl = r.x + r.w * SHAPE.neckLeftX + 8;
            const nr = r.x + r.w * SHAPE.neckRightX - 8;
            // ===== Spawn vị trí — TẬP TRUNG GIỮA =====
            // Vấn đề cũ: Math.random() đều khắp [nl, nr] → quà rơi sát mép cổ hũ → đập viền,
            // dội ra ngoài, gây cảm giác "trượt mép" liên tục.
            // Giải pháp: phân phối tam giác (triangular distribution) qua trung bình 2 random.
            // → Đỉnh phân phối ở center, giảm tuyến tính về 2 mép → ít quà rơi sát mép hơn nhiều.
            // Thêm margin 12% mỗi bên để chừa thêm khoảng an toàn.
            // Tham khảo: Irwin-Hall distribution, common technique in physics simulation spawns.
            const margin = (nr - nl) * 0.12;
            const innerL = nl + margin;
            const innerR = nr - margin;
            const t = (Math.random() + Math.random()) / 2;   // triangular peak = 0.5
            const dx = innerL + t * (innerR - innerL);
            const dropHeight = Math.max(80, Math.min(700, Number(config.gift?.dropHeight ?? 220)));
            const dy = r.y + r.h * SHAPE.neckTopY - sz - dropHeight - Math.random() * 80;
            makeGiftBody(g, dx, dy, sz, { x: (Math.random() - 0.5) * 3, y: Math.random() * 2 + 1 });
            if (config.features.audio) audio.plop();
            updateCountDisplay();
            onCountChange(bodies.length);
            // Hũ đầy → SPILL (tràn ra), KHÔNG xoá bodies — quà stack ở đáy overlay
            if (config.features.autoShake && config.autoShakeAt > 0 && bodies.length >= config.autoShakeAt) {
                setTimeout(() => { fxFireworks(); spillJar(); }, 400);
            }
        }

        // ===== SPILL: tháo jar walls + đẩy bodies bay ra ngoài → rơi xuống stack ở floor =====
        let spillInProgress = false;
        const zigzagLuck = { active: false, pegs: [], walls: [], rect: null, until: 0, timer: null, cfg: null };
        function cleanupZigzagLuck() {
            if (zigzagLuck.timer) clearTimeout(zigzagLuck.timer);
            zigzagLuck.timer = null;
            if (zigzagLuck.pegs.length) Composite.remove(engine.world, zigzagLuck.pegs);
            if (zigzagLuck.walls.length) Composite.remove(engine.world, zigzagLuck.walls);
            zigzagLuck.pegs = [];
            zigzagLuck.walls = [];
            zigzagLuck.active = false;
            zigzagLuck.rect = null;
            zigzagLuck.cfg = null;
            zigzagLuck.until = 0;
        }
        function buildZigzagGeometry(cfg) {
            const jar = jarRect();
            const cols = Math.max(4, Math.min(11, parseInt(cfg.cols ?? 9, 10)));
            const rows = Math.max(5, Math.min(13, parseInt(cfg.rows ?? 6, 10)));
            const width = CANVAS_W * Math.max(0.55, Math.min(0.98, Number(cfg.boardWidthPct ?? 92) / 100));
            const left = (CANVAS_W - width) / 2;
            const bottom = Math.max(CANVAS_H * 0.34, Math.min(jar.y - 120, CANVAS_H * 0.68));
            const desiredHeight = Math.max(390, Math.min(720, rows * 64 + 150));
            const top = Math.max(CANVAS_H * 0.08, bottom - desiredHeight);
            const height = bottom - top;
            const gapX = width / (cols + 0.8);
            const gapY = height / (rows + 1);
            const radius = Math.max(16, Math.min(28, Math.min(gapX, gapY) * 0.2));
            const rect = { left, top, width, height, right: left + width, bottom, cols, rows, gapX, gapY, radius, dropHeight: Math.max(40, Math.min(700, Number(cfg.dropHeight ?? 180))) };
            const pegs = [];
            for (let row = 0; row < rows; row++) {
                const count = row % 2 ? cols - 1 : cols;
                const offset = row % 2 ? gapX * 0.5 : 0;
                for (let col = 0; col < count; col++) {
                    const x = left + gapX * 0.9 + offset + col * gapX;
                    const y = top + gapY * 0.95 + row * gapY;
                    pegs.push(Bodies.circle(x, y, radius, {
                        isStatic: true,
                        friction: 0.04,
                        restitution: 1.05,
                        label: 'zigzag-peg'
                    }));
                }
            }
            const T = 22;
            const walls = [
                Bodies.rectangle(left - T / 2, top + height / 2, T, height, { isStatic: true, friction: 0.02, restitution: 0.95, label: 'zigzag-wall' }),
                Bodies.rectangle(left + width + T / 2, top + height / 2, T, height, { isStatic: true, friction: 0.02, restitution: 0.95, label: 'zigzag-wall' })
            ];
            return { rect, pegs, walls };
        }
        function fxZigzagLuck(opts = {}) {
            const cfg = { ...(config.effects?.zigzagLuck || {}), ...(opts || {}) };
            cleanupZigzagLuck();
            const geo = buildZigzagGeometry(cfg);
            zigzagLuck.active = true;
            zigzagLuck.rect = geo.rect;
            zigzagLuck.pegs = geo.pegs;
            zigzagLuck.walls = geo.walls;
            zigzagLuck.cfg = cfg;
            zigzagLuck.until = Date.now() + Math.max(10, Math.min(180, Number(cfg.durationSec ?? 60))) * 1000;
            Composite.add(engine.world, zigzagLuck.pegs.concat(zigzagLuck.walls));
            zigzagLuck.timer = setTimeout(cleanupZigzagLuck, Math.max(10, Math.min(180, Number(cfg.durationSec ?? 60))) * 1000);
            if (config.features.audio) audio.ting();
            if (!mirrorMode) showComboToast('🎰 <b>Zikzak may mắn</b> đã mở! Quà tiếp theo sẽ rơi qua bàn may mắn.', 'linear-gradient(135deg, #16a34a, #22c55e)');
        }
        function dropOneZigzag(g) {
            if (!zigzagLuck.rect) return;
            const r = zigzagLuck.rect;
            const cfg = zigzagLuck.cfg || {};
            const safeSize = Math.max(24, Math.min(64, Number(cfg.iconSize ?? 42)));
            const margin = r.gapX * 0.65;
            const x = r.left + margin + Math.random() * Math.max(20, r.width - margin * 2);
            const y = r.top - safeSize - r.dropHeight - Math.random() * 70;
            const body = makeGiftBody(g, x, y, safeSize, { x: (Math.random() - 0.5) * 3.2, y: 2.8 + Math.random() * 1.8 });
            body.gm.zigzag = true;
            body.gm.zigzagTargetSize = giftSize(g.coinValue);
            body.gm.zigzagSpawnTs = Date.now();
            body.gm.zigzagLastRow = -1;
            body.gm.zigzagDir = Math.random() < 0.5 ? -1 : 1;
            body.gm.zigzagBumps = 0;
            body.gm.zigzagExpanded = false;
            body.frictionAir = 0.004;
            if (config.features.audio) audio.plop();
            updateCountDisplay();
            onCountChange(bodies.length);
        }
        function spillJar(durationMs = 1400) {
            if (spillInProgress || jarStolen) return;
            spillInProgress = true;
            removeJarWalls();
            const r = jarRect();
            shake();
            // Cú đẩy chính: văng các bodies ra hai bên + nảy lên, để chúng bay qua miệng hũ
            bodies.forEach(b => {
                // chỉ "spill" bodies đang ở trong vùng hũ
                if (b.position.x > r.x && b.position.x < r.x + r.w &&
                    b.position.y > r.y && b.position.y < r.y + r.h) {
                    const dx = b.position.x - r.cx;
                    const dist = Math.max(Math.abs(dx), 1);
                    Body.setVelocity(b, {
                        x: (dx / dist) * (10 + Math.random() * 10) + (Math.random() - 0.5) * 6,
                        y: -(8 + Math.random() * 8)
                    });
                    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.5);
                }
            });
            if (config.features.audio) audio.big();
            // Rebuild jar walls sau khi bodies đã bay ra ngoài
            setTimeout(() => {
                clearJarLandingZone();
                buildJarWalls();
                spillInProgress = false;
            }, durationMs);
        }

        // ===== Stats =====
        function recordTipper(g, count) {
            const uid = String(g.userId || g.uniqueId || '');
            if (!uid) {
                stats.totalDiamonds += (g.coinValue || 1) * count;
                stats.totalGifts += count;
                onStatsChange(stats);
                return;
            }
            const prev = stats.tippers.get(uid) || { uid, uniqueId: g.uniqueId, nickname: g.nickname, avatar: g.profilePicture, diamonds: 0, count: 0 };
            prev.diamonds += (g.coinValue || 1) * count;
            prev.count += count;
            prev.nickname = g.nickname || prev.nickname;
            prev.avatar = g.profilePicture || prev.avatar;
            prev.lastTs = Date.now();
            stats.tippers.set(uid, prev);
            stats.totalDiamonds += (g.coinValue || 1) * count;
            stats.totalGifts += count;
            updateCrown();
            updateLeaderboard();
            updateTopHangers();
            updateSessionTotals();
            onStatsChange(stats);
        }
        function handleCombo(g, count) {
            if (!config.features.combo) return;
            const uid = String(g.userId || g.uniqueId || '');
            if (!uid) return;
            const now = Date.now();
            const prev = stats.combos.get(uid) || { count: 0, lastTs: 0 };
            const interval = now - prev.lastTs;
            const newCount = interval < 8000 ? prev.count + count : count;
            stats.combos.set(uid, { count: newCount, lastTs: now });
            if (newCount >= 3) flashComboToast(g.nickname || g.uniqueId || 'guest', newCount);
        }
        function handleWelcome(g) {
            if (!config.features.welcome) return;
            const id = String(g.giftId);
            if (!id || stats.seenGiftTypes.has(id)) return;
            stats.seenGiftTypes.add(id);
            showWelcome(g);
        }
        function checkBigGiftFx(g, count) {
            if (!config.features.bigGiftFx) return;
            const v = (g.coinValue || 1) * count;
            const tipperName = g.nickname || g.uniqueId || 'Guest';
            const giftName = g.giftName || 'Quà';
            if (v >= 10000) {
                fxMegaboom();
                if (config.features.audio) audio.fanfare();
                flashBigGiftToast(`💎💎 <b>${escHtml(tipperName)}</b> tặng <b>${escHtml(giftName)}</b> <b>${v.toLocaleString('vi-VN')}⭐</b> 🔥`, 'mega');
            }
            else if (v >= 1000) {
                fxFireworks();
                if (config.features.audio) audio.big();
                flashBigGiftToast(`✨ <b>${escHtml(tipperName)}</b> tặng <b>${escHtml(giftName)}</b> <b>${v.toLocaleString('vi-VN')}⭐</b>`, 'big');
            }
        }

        // Toast nổi cho quà to — banner trượt từ trên xuống, glow + scale animation
        let _bigGiftToastEl = null;
        let _bigGiftToastTimer = null;
        function flashBigGiftToast(html, tier) {
            if (!overlayLayer) return;
            if (!_bigGiftToastEl) {
                _bigGiftToastEl = document.createElement('div');
                _bigGiftToastEl.className = 'tt-big-gift-toast';
                overlayLayer.appendChild(_bigGiftToastEl);
            }
            _bigGiftToastEl.classList.remove('show', 'tier-mega', 'tier-big');
            _bigGiftToastEl.classList.add('tier-' + tier);
            _bigGiftToastEl.innerHTML = html;
            void _bigGiftToastEl.offsetWidth;
            _bigGiftToastEl.classList.add('show');
            clearTimeout(_bigGiftToastTimer);
            _bigGiftToastTimer = setTimeout(() => _bigGiftToastEl.classList.remove('show'), tier === 'mega' ? 5000 : 3500);
        }
        function checkGoal() {
            if (!config.features.goalBar || stats.goalReached) return updateGoalBar();
            if (config.goal.target > 0 && stats.totalDiamonds >= config.goal.target) {
                stats.goalReached = true;
                // 🎯 Goal celebration — confetti 5s + fanfare + animated toast
                fxGoalCelebration();
                showWelcome({ giftId: 'goal', giftName: `🎯 Đạt mục tiêu ${config.goal.target}⭐`, image: '' });
                setTimeout(() => { shake(); }, 600);
                // Mở mốc kế (gấp đôi)
                setTimeout(() => {
                    config.goal.target = Math.max(config.goal.target * 2, stats.totalDiamonds + 500);
                    stats.goalReached = false;
                    updateGoalBar();
                }, 5000);
            }
            updateGoalBar();
        }

        // ===== Effects =====
        function shake() {
            const k = (config.effects?.shake?.intensity ?? 1);
            bodies.forEach(b => Body.setVelocity(b, {
                x: (Math.random() - 0.5) * 15 * k,
                y: -(Math.random() * 8 + 3) * k
            }));
        }
        function cloneBodiesForState() {
            return bodies.filter(b => !b.gm?.previewOnly).map(b => ({
                x: b.position.x,
                y: b.position.y,
                sz: b.gm?.sz || 40,
                gm: b.gm ? {
                    id: b.gm.id,
                    name: b.gm.name,
                    coins: b.gm.coins,
                    tier: b.gm.tier,
                    sz: b.gm.sz,
                    imgSrc: b.gm.img?.src || '',
                    tipperUid: b.gm.tipperUid
                } : null
            }));
        }
        function historyHashFromBodies(list) {
            return JSON.stringify((list || []).map(b => [b.gm?.id, Math.round(b.x), Math.round(b.y), b.sz]));
        }
        function summarizeSnapshotBodies(list) {
            const map = new Map();
            for (const b of list || []) {
                if (!b.gm) continue;
                const key = String(b.gm.id || b.gm.name || 'gift');
                const cur = map.get(key) || { id: b.gm.id, name: b.gm.name || 'Quà', imgSrc: b.gm.imgSrc || '', count: 0 };
                cur.count++;
                map.set(key, cur);
            }
            return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 12);
        }
        function historyRetentionMs() {
            const hours = Math.max(1, Math.min(24, Number(config.history?.retentionHours ?? 6)));
            return hours * 60 * 60 * 1000;
        }
        function historyIntervalMs() {
            const sec = Math.max(5, Math.min(300, Number(config.history?.intervalSec ?? 10)));
            return sec * 1000;
        }
        function pruneGiftHistory() {
            const cutoff = Date.now() - historyRetentionMs();
            for (let i = giftHistory.length - 1; i >= 0; i--) {
                if (!giftHistory[i]?.ts || giftHistory[i].ts < cutoff) giftHistory.splice(i, 1);
            }
            giftHistory.splice(HISTORY_MAX);
        }
        function restartGiftHistoryTimer() {
            if (historyTimer) clearInterval(historyTimer);
            historyTimer = setInterval(() => {
                pruneGiftHistory();
                captureGiftHistory(`Tự lưu ${Math.round(historyIntervalMs() / 1000)}s`);
            }, historyIntervalMs());
        }
        function captureGiftHistory(label = 'Tự lưu', force = false) {
            pruneGiftHistory();
            const snapshotBodies = cloneBodiesForState();
            if (!snapshotBodies.length && !force) return null;
            const hash = historyHashFromBodies(snapshotBodies);
            if (!force && hash === lastHistoryHash) return null;
            lastHistoryHash = hash;
            const item = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ts: Date.now(),
                label,
                count: snapshotBodies.length,
                totalDiamonds: stats.totalDiamonds,
                totalGifts: stats.totalGifts,
                bodies: snapshotBodies,
                summary: summarizeSnapshotBodies(snapshotBodies)
            };
            giftHistory.unshift(item);
            pruneGiftHistory();
            giftHistory.splice(HISTORY_MAX);
            return item;
        }
        function makeBodyFromSaved(saved, x, y, velocity) {
            if (!saved?.gm) return null;
            const sz = Math.max(20, saved.sz || saved.gm.sz || 40);
            let img = null;
            if (saved.gm.imgSrc) {
                if (imgCache.has(saved.gm.imgSrc)) img = imgCache.get(saved.gm.imgSrc);
                else {
                    img = new Image();
                    img.src = saved.gm.imgSrc;
                    imgCache.set(saved.gm.imgSrc, img);
                }
            }
            const body = Bodies.circle(x ?? saved.x, y ?? saved.y, sz / 2, {
                restitution: config.physics.bounce,
                friction: config.physics.friction,
                density: 0.002
            });
            body.gm = {
                id: saved.gm.id,
                name: saved.gm.name,
                coins: saved.gm.coins || 1,
                tier: saved.gm.tier,
                sz,
                img,
                tipperUid: saved.gm.tipperUid
            };
            if (velocity) Body.setVelocity(body, velocity);
            return body;
        }
        function clearBodiesOnly() {
            if (bodies.length) Composite.remove(engine.world, bodies);
            bodies.length = 0;
        }
        function clearAll() {
            captureGiftHistory('Trước khi xoá hũ', true);
            clearBodiesOnly();
            updateCountDisplay();
            onCountChange(0);
        }
        function restoreGiftSnapshot(id, animate = true) {
            const snap = giftHistory.find(x => String(x.id) === String(id));
            if (!snap || !Array.isArray(snap.bodies)) return false;
            clearBodiesOnly();
            stats.totalDiamonds = snap.totalDiamonds || stats.totalDiamonds;
            stats.totalGifts = snap.totalGifts || stats.totalGifts;
            const r = jarRect();
            snap.bodies.forEach((saved, i) => {
                const x = animate ? r.x + r.w * (0.18 + Math.random() * 0.64) : saved.x;
                const y = animate ? Math.max(40, r.y - 260 - (i % 18) * 22) : saved.y;
                const body = makeBodyFromSaved(saved, x, y, animate ? { x: (Math.random() - 0.5) * 3, y: 4 + Math.random() * 2 } : null);
                if (!body) return;
                Composite.add(engine.world, body);
                bodies.push(body);
            });
            updateCountDisplay();
            onCountChange(bodies.length);
            updateCrown(); updateLeaderboard(); updateSessionTotals(); updateGoalBar(); updateTopHangers();
            showComboToast(`♻️ Đã khôi phục <b>${snap.bodies.length}</b> quà từ lịch sử`, 'linear-gradient(135deg, #22c55e, #0ea5e9)');
            return true;
        }
        function fxFireworks() {
            const k = (config.effects?.fireworks?.intensity ?? 1);
            const r = jarRect();
            // Cải tiến: tăng số burst (5-7), trải theo cả X và Y, staggered timing
            const count = Math.max(3, Math.round(6 * k));
            for (let i = 0; i < count; i++) {
                setTimeout(() => {
                    fxAnimations.push({
                        type: 'firework',
                        x: r.cx + (Math.random() - 0.5) * r.w * 0.9,
                        y: r.y + Math.random() * r.h * 0.6,
                        age: 0, life: 70,
                        color: `hsl(${Math.random() * 360},95%,65%)`
                    });
                    if (i % 2 === 0 && config.features.audio) audio.ting();
                }, i * 180);   // stagger 180ms mỗi burst
            }
        }

        // ===== 🎯 Goal celebration — confetti + fanfare khi đạt mục tiêu =====
        let _goalCelebrated = false;
        function fxGoalCelebration() {
            if (_goalCelebrated) return;
            _goalCelebrated = true;
            const r = jarRect();
            if (config.features.audio) audio.fanfare();
            // 12 burst confetti rải khắp canvas trong 5s
            for (let i = 0; i < 12; i++) {
                setTimeout(() => {
                    fxAnimations.push({
                        type: 'firework',
                        x: CANVAS_W * (0.1 + Math.random() * 0.8),
                        y: CANVAS_H * (0.1 + Math.random() * 0.4),
                        age: 0, life: 90,
                        color: `hsl(${Math.random() * 360},95%,70%)`
                    });
                    if (config.features.audio && i % 3 === 0) audio.big();
                }, i * 400);
            }
            // Show celebration toast prominently
            showComboToast(
                `🎯 <b>ĐẠT MỤC TIÊU!</b> 🎉🎊`,
                'linear-gradient(135deg, #fbbf24, #ef4444, #ec4899)'
            );
            // Reset flag sau 30s — cho phép trigger lại nếu user reset goal
            setTimeout(() => { _goalCelebrated = false; }, 30000);
        }
        function fxMegaboom() {
            const k = (config.effects?.megaboom?.intensity ?? 1);
            const r = jarRect();
            fxAnimations.push({ type: 'megaboom', x: r.cx, y: r.cy, age: 0, life: 80 });
            bodies.forEach(b => {
                const dx = b.position.x - r.cx, dy = b.position.y - r.cy, d = Math.max(Math.hypot(dx, dy), 1);
                Body.setVelocity(b, { x: dx / d * 20 * k, y: (dy / d * 20 - 5) * k });
            });
        }
        // fxTilt: NGHIÊNG CẢ HŨ — không chỉ thay gravity mà rotate visual jar img + jar walls
        // trong physics world quanh tâm hũ. Bodies bên trong nghiêng theo, trượt về phía thấp →
        // cảm giác "chân thật" như đang ngả hũ thật.
        // Pipeline:
        //   1) Lưu state visual transform gốc của jar img.
        //   2) Phase nghiêng (~700ms ease-out): rotate img qua CSS + rotate từng jar wall qua
        //      Body.rotate quanh tâm hũ. Vì delta nhỏ qua mỗi frame, vận dụng Body.rotate(body,
        //      delta, pivot) — xoay vị trí + góc trong 1 step.
        //   3) Hold ở góc tilt 800ms (bodies trượt + va vào thành thấp).
        //   4) Phase đứng lại (~700ms ease-in): rotate ngược về 0.
        //   5) Cleanup: clear CSS transform.
        // Lưu ý:
        //   - jarStolen/spillInProgress → skip (jar đang animation khác).
        //   - positionJar() trong lúc tilt sẽ rebuild walls → buildJarWalls reset currentTiltAngle
        //     để applyTilt sau tính delta đúng từ 0.
        async function fxTilt() {
            if (tiltAnimating || jarStolen || spillInProgress) return;
            const k = Math.max(0.2, Math.min(3, (config.effects?.tilt?.intensity ?? 1)));
            // Góc nghiêng max ~18° * intensity. Hướng random trái/phải.
            const maxAngle = 0.32 * k * (Math.random() < 0.5 ? -1 : 1);

            tiltAnimating = true;
            const r = jarRect();
            const pivot = { x: r.cx, y: r.cy };

            // Lưu CSS transform gốc để khôi phục cuối effect
            const visualEls = [jarBottomEl, jarGlassEl].filter(Boolean);
            const origTr = visualEls.map(el => el.style.transform || '');
            visualEls.forEach((el) => {
                el.style.transition = 'none';
                el.style.transformOrigin = '50% 50%';
            });

            // Helper: đặt góc tilt tuyệt đối (tính delta so với currentTiltAngle)
            const applyTilt = (theta) => {
                const delta = theta - currentTiltAngle;
                if (delta === 0) return;
                // Rotate jar walls quanh pivot (xoay vị trí + góc body)
                for (const w of jarWalls) {
                    try { Body.rotate(w, delta, pivot); } catch (e) {}
                }
                currentTiltAngle = theta;
                const deg = (theta * 180 / Math.PI).toFixed(2);
                visualEls.forEach(el => { el.style.transform = `rotate(${deg}deg)`; });
            };

            // Phase 1: nghiêng tới maxAngle
            await tween(t => {
                const e = 1 - Math.pow(1 - t, 3);   // ease-out cubic
                applyTilt(maxAngle * e);
            }, 700);

            // Phase 2: hold — bodies tự trượt do gravity vẫn y-down trong khi walls đang nghiêng
            await wait(800);

            // Phase 3: đứng dậy về 0
            await tween(t => {
                const e = t * t;   // ease-in quadratic
                applyTilt(maxAngle * (1 - e));
            }, 700);

            // Đảm bảo về đúng 0 (tránh drift do float)
            applyTilt(0);

            // Restore transform CSS gốc
            visualEls.forEach((el, i) => {
                el.style.transition = '';
                el.style.transform = origTr[i];
            });
            tiltAnimating = false;
        }
        // ===== Dốc ngược hũ — đổ hết quà ra ngoài =====
        // Khác fxTilt thông thường: góc nghiêng gần 180° (mặc định 165°) → miệng hũ
        // chĩa xuống → mọi quà rơi ra do gravity. UFO / OSIN sẽ cứu lại sau.
        async function fxPourOut() {
            if (tiltAnimating || jarStolen || spillInProgress) return;
            captureGiftHistory('Trước Dốc ngược hũ', true);
            const cfg = config.effects?.pourOut || {};
            const angleDeg = Math.max(120, Math.min(180, cfg.angleDeg ?? 165));
            const holdMs = Math.max(500, Math.min(4000, cfg.holdMs ?? 1400));
            const flyToCenter = cfg.flyToCenter !== false;
            const flyMs = Math.max(300, Math.min(2200, cfg.flyMs ?? 900));
            const dir = Math.random() < 0.5 ? -1 : 1;
            const maxAngle = (angleDeg * Math.PI / 180) * dir;

            tiltAnimating = true;
            const r = jarRect();
            const baseRect = { ...r };
            const pivot = { x: r.cx, y: r.cy };
            const visualEls = [jarBottomEl, jarGlassEl, countDisplay].filter(Boolean);
            const insideBodies = bodies.filter(b => {
                const p = b.position;
                return p.x >= r.x - 30 && p.x <= r.x + r.w + 30 && p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= r.y + r.h + 80;
            });
            const origTr = visualEls.map(el => el.style.transform || '');
            const origStyle = visualEls.map(el => el.style.cssText || '');
            visualEls.forEach((el) => {
                el.style.transition = 'none';
                el.style.transformOrigin = '50% 50%';
            });
            let jarOffsetX = 0;
            let jarOffsetY = 0;
            const moveJarToOffset = (ox, oy, carryBodies = true) => {
                const dx = ox - jarOffsetX;
                const dy = oy - jarOffsetY;
                jarOffsetX = ox;
                jarOffsetY = oy;
                pivot.x = baseRect.cx + jarOffsetX;
                pivot.y = baseRect.cy + jarOffsetY;
                for (const w of jarWalls) {
                    try { Body.setPosition(w, { x: w.position.x + dx, y: w.position.y + dy }); } catch (e) {}
                }
                if (carryBodies) {
                    for (const b of insideBodies) {
                        try {
                            Body.setPosition(b, { x: b.position.x + dx, y: b.position.y + dy });
                            Body.setVelocity(b, { x: 0, y: 0 });
                        } catch (e) {}
                    }
                }
                const nx = baseRect.x + jarOffsetX;
                const ny = baseRect.y + jarOffsetY;
                if (jarBottomEl) { jarBottomEl.style.left = (nx / CANVAS_W * 100) + '%'; jarBottomEl.style.top = (ny / CANVAS_H * 100) + '%'; }
                if (jarGlassEl) { jarGlassEl.style.left = (nx / CANVAS_W * 100) + '%'; jarGlassEl.style.top = (ny / CANVAS_H * 100) + '%'; }
                if (countDisplay) { countDisplay.style.left = ((baseRect.cx + jarOffsetX) / CANVAS_W * 100) + '%'; countDisplay.style.top = ((baseRect.y + baseRect.h * 0.88 + jarOffsetY) / CANVAS_H * 100) + '%'; }
                if (_accessoryEl) positionAccessory();
                moveTopHangersWithJar(nx, ny, 0, baseRect);
            };
            const applyTilt = (theta) => {
                const delta = theta - currentTiltAngle;
                if (delta === 0) return;
                for (const w of jarWalls) {
                    try { Body.rotate(w, delta, pivot); } catch (e) {}
                }
                currentTiltAngle = theta;
                const deg = (theta * 180 / Math.PI).toFixed(2);
                visualEls.forEach(el => { el.style.transform = `rotate(${deg}deg)`; });
                if (topHangersEl) topHangersEl.style.transform = `translate(${jarOffsetX}px, ${jarOffsetY}px) rotate(${deg}deg)`;
            };

            if (config.features.audio) audio.pourOut();

            try {
                if (flyToCenter) {
                    const targetCx = CANVAS_W * 0.5;
                    const targetCy = CANVAS_H * 0.34;
                    const targetOx = targetCx - baseRect.cx;
                    const targetOy = targetCy - baseRect.cy;
                    await tween(t => {
                        const e = 1 - Math.pow(1 - t, 3);
                        moveJarToOffset(targetOx * e, targetOy * e);
                    }, flyMs);
                }
                // Phase 1: nghiêng nhanh tới góc max (1.2s)
                await tween(t => {
                    const e = 1 - Math.pow(1 - t, 2.5);
                    applyTilt(maxAngle * e);
                }, 1200);

                // Phase 2: giữ ở góc max → bodies sẽ tự rơi ra do gravity
                for (const b of bodies) {
                    try {
                        Body.setVelocity(b, {
                            x: b.velocity.x + (Math.random() - 0.5) * 3,
                            y: b.velocity.y + Math.random() * 2
                        });
                    } catch (e) {}
                }
                await wait(holdMs);

                // Phase 3: dựng lại hũ (1s)
                await tween(t => {
                    const e = t * t;
                    applyTilt(maxAngle * (1 - e));
                }, 1000);
                if (flyToCenter) {
                    const startOx = jarOffsetX;
                    const startOy = jarOffsetY;
                    removeJarWalls();
                    await tween(t => {
                        const e = t * t;
                        moveJarToOffset(startOx * (1 - e), startOy * (1 - e), false);
                    }, flyMs);
                }
            } finally {
                applyTilt(0);
                visualEls.forEach((el, i) => {
                    el.style.transition = '';
                    el.style.cssText = origStyle[i];
                    el.style.transform = origTr[i];
                });
                // Dốc ngược luôn phải kết thúc bằng hũ đứng thẳng. Không giữ transform cũ
                // vì nếu lần trước bị ngắt giữa chừng, origStyle/origTr có thể đã chứa rotate.
                [jarBottomEl, jarGlassEl].filter(Boolean).forEach(el => {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.transformOrigin = '50% 50%';
                });
                if (countDisplay) {
                    countDisplay.style.transition = '';
                    countDisplay.style.transform = 'translate(-50%, 0)';
                    countDisplay.style.transformOrigin = '50% 50%';
                }
                currentTiltAngle = 0;
                if (topHangersEl) { topHangersEl.style.transform = ''; updateTopHangers(); }
                clearJarLandingZone(baseRect);
                buildJarWalls();
                positionJar();
                positionAccessory();
                tiltAnimating = false;
            }
        }
        // ===== Temp lid — tạm khóa miệng hũ trong gravflip/tornado để quà không bay ra =====
        let _tempLid = null;
        function addTempLid() {
            if (_tempLid) return;
            const r = jarRect();
            const T = 14;
            const nty = r.y + r.h * SHAPE.neckTopY;
            const nlx = r.x + r.w * SHAPE.neckLeftX;
            const nrx = r.x + r.w * SHAPE.neckRightX;
            _tempLid = makeWall((nlx + nrx) / 2, nty - T, nrx - nlx + T * 2, T);
            Composite.add(engine.world, _tempLid);
        }
        function removeTempLid() {
            if (!_tempLid) return;
            try { Composite.remove(engine.world, _tempLid); } catch (e) {}
            _tempLid = null;
        }

        function fxGravFlip() {
            const dur = (config.effects?.gravflip?.durationMs ?? 2200);
            // Khóa miệng hũ để quà không bay ra qua opening khi đảo gravity
            addTempLid();
            engine.gravity.y = -Math.abs(engine.gravity.y);
            if (config.features.audio) audio.gravflip();
            setTimeout(() => {
                engine.gravity.y = Math.abs(config.physics.gravity);
                removeTempLid();
            }, dur);
        }

        // Lốc dọc giữa canvas: tháo tường hũ tạm để bodies bay tự do thành cột xoắn ốc
        // giữa màn hình. Sau effect → rebuild walls + bodies rơi xuống lại theo gravity.
        // Khác cũ (bám vào hũ, bị block): bodies thoát ra ngoài jar walls → swirl thoải mái.
        function fxTornado() {
            const k = Math.max(0.3, Math.min(2, config.effects?.tornado?.intensity ?? 1));
            if (config.features.audio) audio.tornado();
            // Tháo jar walls tạm — bodies không bị jar block
            removeJarWalls();
            // Cột tornado ở giữa canvas (không bám vào hũ)
            const columnX = CANVAS_W / 2;
            const columnCenterY = CANVAS_H * 0.4;   // giữa trên canvas
            const TOTAL = 70;
            const maxV = 10;
            let t = 0;
            const iv = setInterval(() => {
                if (t++ > TOTAL) {
                    clearInterval(iv);
                    // Rebuild walls — bodies sẽ rơi xuống do gravity, một số rơi vào hũ
                    clearJarLandingZone();
                    buildJarWalls();
                    return;
                }
                const intensity = Math.sin((t / TOTAL) * Math.PI) * k * 0.7;
                bodies.forEach(b => {
                    const dx = b.position.x - columnX;
                    const dy = b.position.y - columnCenterY;
                    // Pull về tâm cột tornado
                    const pullX = -dx * 0.06;
                    const pullY = -dy * 0.05;
                    // Helical X oscillation theo Y position → xoắn ốc dọc
                    const phase = (b.position.y - columnCenterY) / 60 + t * 0.22;
                    const oscX = Math.cos(phase) * 3 * intensity;
                    const oscY = Math.sin(phase * 0.7) * 1.2 * intensity;
                    const newVx = b.velocity.x * 0.82 + pullX + oscX;
                    const newVy = b.velocity.y * 0.82 + pullY + oscY;
                    Body.setVelocity(b, {
                        x: Math.max(-maxV, Math.min(maxV, newVx)),
                        y: Math.max(-maxV, Math.min(maxV, newVy))
                    });
                    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.2 * intensity);
                });
            }, 30);
            showComboToast('🌪 <b>Lốc xoáy</b> giữa canvas!', 'linear-gradient(135deg, #6366f1, #8b5cf6)');
        }
        function fxSlow() {
            const ts = (config.effects?.slow?.timeScale ?? 0.25);
            const dur = (config.effects?.slow?.durationMs ?? 3000);
            engine.timing.timeScale = ts;
            if (config.features.audio) audio.slow();
            setTimeout(() => engine.timing.timeScale = 1, dur);
        }

        // ===== ✨ Mưa quà — spawn N gifts từ trên trời rơi xuống hũ =====
        function fxRain() {
            const cfg = config.effects?.rain || {};
            const count = Math.max(5, Math.min(60, cfg.count ?? 25));
            const durMs = Math.max(500, Math.min(8000, cfg.durationMs ?? 3000));
            if (config.features.audio) audio.rain();
            // Lấy ngẫu nhiên giftMap để có icon đa dạng — fallback dùng bodies trong hũ nếu trống
            const allGms = [];
            for (const b of bodies) if (b.gm) allGms.push(b.gm);
            if (!allGms.length) return showComboToast('☔ Mưa quà cần ít nhất 1 quà trong hũ', 'linear-gradient(135deg,#6b7280,#4b5563)');
            const interval = durMs / count;
            for (let i = 0; i < count; i++) {
                setTimeout(() => {
                    const gm = allGms[Math.floor(Math.random() * allGms.length)];
                    const x = CANVAS_W * (0.2 + Math.random() * 0.6);   // 20-80% width
                    const y = -50;
                    const body = Bodies.circle(x, y, gm.sz / 2, {
                        restitution: config.physics.bounce,
                        friction: config.physics.friction,
                        density: 0.002
                    });
                    body.gm = gm;
                    Body.setVelocity(body, { x: (Math.random() - 0.5) * 3, y: 3 + Math.random() * 4 });
                    Composite.add(engine.world, body);
                    bodies.push(body);
                    if (i % 4 === 0 && config.features.audio) audio.plop();
                }, i * interval);
            }
            setTimeout(() => {
                updateCountDisplay();
                onCountChange(bodies.length);
            }, durMs + 200);
            showComboToast('☔ <b>Mưa quà</b> đang rơi xuống!', 'linear-gradient(135deg, #0ea5e9, #6366f1)');
        }

        // ===== 🚀 Phun trào — hút quà NGOÀI hũ về phía hũ (như máy hút bụi) =====
        // Khác hẳn version cũ (phun từ trong hũ lên — ngược logic). Giờ hút từ ngoài vào.
        function fxGeyser() {
            const cfg = config.effects?.geyser || {};
            const dur = Math.max(800, Math.min(4000, cfg.durationMs ?? 1800));
            const power = Math.max(0.4, Math.min(2.5, cfg.power ?? 1.0));
            if (config.features.audio) audio.geyser();
            const r = jarRect();
            const mouthX = r.cx;
            const mouthY = r.y + r.h * SHAPE.neckTopY;
            const targetY = mouthY - 80;   // điểm hút phía trên miệng hũ → gravity sẽ kéo xuống
            const TOTAL = Math.floor(dur / 30);
            const maxV = 14;
            let t = 0;
            const iv = setInterval(() => {
                if (t++ > TOTAL) { clearInterval(iv); return; }
                const env = Math.sin((t / TOTAL) * Math.PI);
                // Re-fetch escaped bodies mỗi tick (status thay đổi liên tục)
                const escaped = findEscapedBodies();
                escaped.forEach(b => {
                    const dx = mouthX - b.position.x;
                    const dy = targetY - b.position.y;
                    const dist = Math.max(Math.hypot(dx, dy), 1);
                    const factor = 0.18 * env * power;
                    const newVx = b.velocity.x * 0.85 + (dx / dist) * Math.min(dist, 600) * factor * 0.05;
                    const newVy = b.velocity.y * 0.85 + (dy / dist) * Math.min(dist, 600) * factor * 0.05;
                    Body.setVelocity(b, {
                        x: Math.max(-maxV, Math.min(maxV, newVx)),
                        y: Math.max(-maxV, Math.min(maxV, newVy))
                    });
                });
            }, 30);
            showComboToast('🚀 <b>Phun trào</b> — hút quà về hũ!', 'linear-gradient(135deg, #f59e0b, #ef4444)');
        }

        // ===== 🧲 Nam châm — bodies hút lẫn nhau tạo cụm =====
        function fxMagnet() {
            const cfg = config.effects?.magnet || {};
            const dur = Math.max(1000, Math.min(8000, cfg.durationMs ?? 3500));
            const pull = Math.max(0.3, Math.min(2.5, cfg.pullStrength ?? 1.0));
            if (config.features.audio) audio.magnet();
            // 🧲 TARGET: vùng đầu idol — top-center của màn hình (idol đang LIVE thường ở 15% top)
            // Sau duration, gravity tự kéo quà rơi xuống → tạo cảm giác idol "hút lên" rồi "thả ra"
            const centerX = CANVAS_W * 0.5;
            const centerY = CANVAS_H * 0.15;
            // Mở miệng hũ để quà bay LÊN được (nếu vẫn bám hũ thì hút lên bị chặn)
            removeJarWalls();
            const TOTAL = Math.floor(dur / 30);
            const maxV = 14;   // tăng max velocity → quà bay lên nhanh hơn
            let t = 0;
            const iv = setInterval(() => {
                if (t++ > TOTAL) {
                    clearInterval(iv);
                    // Restore walls để quà rơi lại không bị mất ra ngoài
                    setTimeout(() => { try { clearJarLandingZone(); buildJarWalls(); } catch(e){} }, 200);
                    return;
                }
                // Envelope ramp up then hold — release nhanh hơn để quà bị "thả" rơi xuống
                const env = t < 10 ? t / 10 : (t > TOTAL - 20 ? Math.max(0, (TOTAL - t) / 20) : 1);
                bodies.forEach(b => {
                    const dx = centerX - b.position.x;
                    const dy = centerY - b.position.y;
                    const dist = Math.max(Math.hypot(dx, dy), 20);
                    // Pull mạnh hơn theo trục Y → quà bay LÊN trước rồi mới gom horizontal
                    const factor = 0.08 * pull * env;
                    const newVx = b.velocity.x * 0.92 + (dx / dist) * dist * factor * 0.08;
                    const newVy = b.velocity.y * 0.88 + (dy / dist) * dist * factor * 0.12;
                    Body.setVelocity(b, {
                        x: Math.max(-maxV, Math.min(maxV, newVx)),
                        y: Math.max(-maxV, Math.min(maxV, newVy))
                    });
                });
            }, 30);
            showComboToast('🧲 <b>Nam châm</b> hút quà lên trên cao!', 'linear-gradient(135deg, #8b5cf6, #ec4899)');
        }

        // ===== Tạo hình quà (hút bodies → ghép hình/chữ → giữ → rơi tự do) =====
        // Pipeline:
        //   1) Pick các body trên màn, SẮP XẾP TĂNG DẦN THEO size — quà nhỏ vào trước
        //      để bám sát outline, quà to dùng sau (đỡ phải hút nếu đủ quà nhỏ).
        //   2) Sample N điểm chính xác trên outline (parametric) cho shape vector,
        //      hoặc sample pixel cho text (canvas + Vietnamese-capable font).
        //   3) Greedy match: gán mỗi body → target gần nhất, body nhỏ assign trước.
        //   4) setStatic(true) → tween về target (~800ms).
        //   5) Hold durationMs với pulse nhẹ + hiện tên user ở tâm.
        //   6) setStatic(false) + velocity nhẹ → rơi tự do; tên fade ra.
        let shapeBusy = false;

        // Parametric outline points (đều dọc theo đường biên — không nhồi pixel)
        // → Visual sạch hơn fill: bodies nhỏ ghép thành đường biên rõ ràng.
        function pointsOnPolyline(verts, N, closed) {
            // Lấy N điểm cách đều dọc theo polyline `verts`. closed=true → nối điểm cuối về đầu.
            const segs = [];
            const M = verts.length;
            const last = closed ? M : (M - 1);
            for (let i = 0; i < last; i++) {
                const a = verts[i], b = verts[(i + 1) % M];
                segs.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
            }
            const total = segs.reduce((s, e) => s + e.len, 0) || 1;
            const out = [];
            for (let i = 0; i < N; i++) {
                let d = (i / N) * total;
                let si = 0;
                while (si < segs.length - 1 && d > segs[si].len) { d -= segs[si].len; si++; }
                const t = d / segs[si].len;
                out.push({
                    x: segs[si].a.x + (segs[si].b.x - segs[si].a.x) * t,
                    y: segs[si].a.y + (segs[si].b.y - segs[si].a.y) * t
                });
            }
            return out;
        }
        function pointsOnArc(cx, cy, r, a0, a1, N) {
            const out = [];
            for (let i = 0; i < N; i++) {
                const t = N === 1 ? 0.5 : (i / (N - 1));
                const a = a0 + (a1 - a0) * t;
                out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
            }
            return out;
        }
        function pointsOnClosedCurve(fn, N) {
            // fn(t in [0, 1)) → {x, y}. Đều theo tham số t.
            const out = [];
            for (let i = 0; i < N; i++) out.push(fn(i / N));
            return out;
        }

        function generateShapePoints(N, sCfg) {
            const type = sCfg.type || 'heart';
            const customText = (sCfg.customText || '').trim();

            // ===== Shape vector (parametric outline) — toạ độ chuẩn hoá [-0.5, 0.5] =====
            if (type === 'heart') {
                return pointsOnClosedCurve(u => {
                    const t = u * Math.PI * 2;
                    const x = 16 * Math.pow(Math.sin(t), 3);
                    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
                    return { x: x / 34, y: y / 34 };
                }, N);
            }
            if (type === 'circle') {
                return pointsOnClosedCurve(u => {
                    const t = u * Math.PI * 2;
                    return { x: Math.cos(t) * 0.45, y: Math.sin(t) * 0.45 };
                }, N);
            }
            if (type === 'star') {
                const outerR = 0.46, innerR = outerR * 0.5;
                const verts = [];
                for (let i = 0; i < 10; i++) {
                    const r = (i % 2 === 0) ? outerR : innerR;
                    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
                    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
                }
                return pointsOnPolyline(verts, N, true);
            }
            if (type === 'triangle') {
                const verts = [
                    { x: 0,     y: -0.44 },
                    { x: -0.46, y: 0.38 },
                    { x: 0.46,  y: 0.38 }
                ];
                return pointsOnPolyline(verts, N, true);
            }
            if (type === 'diamond') {
                const verts = [
                    { x: 0,     y: -0.46 },
                    { x: 0.46,  y: 0 },
                    { x: 0,     y: 0.46 },
                    { x: -0.46, y: 0 }
                ];
                return pointsOnPolyline(verts, N, true);
            }
            if (type === 'smile') {
                // Phân bổ N điểm: ~55% mặt outline, ~10%/mắt, phần còn lại = miệng cười.
                // → Đường nét rõ ràng (outline) thay vì fill cả đĩa mặt như bản cũ.
                const faceN = Math.max(8, Math.round(N * 0.55));
                const eyeN  = Math.max(3, Math.round(N * 0.10));
                const mouthN = Math.max(4, N - faceN - eyeN * 2);
                const pts = [];
                // Face outline
                for (let i = 0; i < faceN; i++) {
                    const t = (i / faceN) * Math.PI * 2;
                    pts.push({ x: Math.cos(t) * 0.46, y: Math.sin(t) * 0.46 });
                }
                // Left eye (small filled-ish ring)
                for (let i = 0; i < eyeN; i++) {
                    const t = (i / eyeN) * Math.PI * 2;
                    pts.push({
                        x: -0.17 + Math.cos(t) * 0.075,
                        y: -0.11 + Math.sin(t) * 0.075
                    });
                }
                // Right eye
                for (let i = 0; i < eyeN; i++) {
                    const t = (i / eyeN) * Math.PI * 2;
                    pts.push({
                        x: 0.17 + Math.cos(t) * 0.075,
                        y: -0.11 + Math.sin(t) * 0.075
                    });
                }
                // Smile mouth arc (từ 0.15π → 0.85π — cung cười nửa dưới)
                const mouthArc = pointsOnArc(0, 0.08, 0.24,
                    0.15 * Math.PI, 0.85 * Math.PI, mouthN);
                pts.push(...mouthArc);
                return pts.slice(0, N);
            }

            // ===== Text — render canvas + sample pixel (chỉ dùng cho text) =====
            if (type === 'text') {
                return sampleTextPoints(N, customText);
            }

            // Fallback: circle
            return pointsOnClosedCurve(u => {
                const t = u * Math.PI * 2;
                return { x: Math.cos(t) * 0.45, y: Math.sin(t) * 0.45 };
            }, N);
        }

        // Sample điểm pixel từ text bằng off-screen canvas.
        // Stack font: ưu tiên font tích hợp Vietnamese diacritics tốt (Segoe UI, Tahoma,
        // Be Vietnam Pro, Roboto). Auto-shrink font-size để fit ngang canvas.
        function sampleTextPoints(N, customText) {
            const txt = (customText || '♥').slice(0, 16);
            const C = 800;   // độ phân giải cao cho dấu tiếng Việt sắc nét
            const cv = document.createElement('canvas');
            cv.width = cv.height = C;
            const cx = cv.getContext('2d');
            cx.fillStyle = '#000';
            cx.textAlign = 'center';
            cx.textBaseline = 'middle';
            // Font stack hỗ trợ tiếng Việt — Tahoma/Segoe UI/Roboto đều render dấu tốt.
            const fontFamily = '"Be Vietnam Pro", "Segoe UI", "Tahoma", "Roboto", "Arial Black", sans-serif';
            // Auto-fit: chọn fontSize lớn nhất mà text vẫn vừa 90% canvas ngang/dọc.
            let fontSize = Math.min(C * 0.75, (C * 1.5) / Math.max(1, txt.length));
            cx.font = `900 ${fontSize}px ${fontFamily}`;
            let m = cx.measureText(txt);
            while (m.width > C * 0.88 && fontSize > 28) {
                fontSize -= 8;
                cx.font = `900 ${fontSize}px ${fontFamily}`;
                m = cx.measureText(txt);
            }
            cx.font = `900 ${fontSize}px ${fontFamily}`;
            cx.fillText(txt, C / 2, C / 2);

            // Sample: step nhỏ (2px) để bắt được các nét mảnh + dấu tiếng Việt.
            const data = cx.getImageData(0, 0, C, C).data;
            const candidates = [];
            const step = 2;
            for (let y = 0; y < C; y += step) {
                for (let x = 0; x < C; x += step) {
                    const i = (y * C + x) * 4;
                    if (data[i + 3] > 100) candidates.push({ x: (x - C / 2) / C, y: (y - C / 2) / C });
                }
            }
            if (!candidates.length) return [];

            // Stratified sample: chia candidates thành N nhóm theo index, lấy 1 phần tử ngẫu nhiên
            // trong mỗi nhóm → phân bố đều khắp text, tránh cụm dày 1 chỗ.
            if (candidates.length <= N) {
                const r = [];
                for (let i = 0; i < N; i++) {
                    const base = candidates[i % candidates.length];
                    r.push({
                        x: base.x + (Math.random() - 0.5) * 0.004,
                        y: base.y + (Math.random() - 0.5) * 0.004
                    });
                }
                return r;
            }
            const r = [];
            const grpSize = candidates.length / N;
            for (let i = 0; i < N; i++) {
                const start = Math.floor(i * grpSize);
                const end = Math.floor((i + 1) * grpSize);
                const pick = candidates[start + Math.floor(Math.random() * Math.max(1, end - start))];
                r.push(pick);
            }
            return r;
        }

        // Ngưỡng tối thiểu để 1 shape trông "đủ rõ". Dưới mức này, outline đứt khúc/khó nhận ra.
        // Số liệu chọn dựa trên độ phức tạp visual: smile cần nhiều nhất (mặt + 2 mắt + miệng),
        // tam giác/kim cương cần ít nhất (chỉ 3-4 cạnh).
        function minBodiesForShape(type, customText) {
            switch (type) {
                case 'heart':    return 24;
                case 'star':     return 22;
                case 'circle':   return 16;
                case 'triangle': return 12;
                case 'diamond':  return 12;
                case 'smile':    return 30;
                case 'text':
                    // Mỗi ký tự ~8 quà để nét chữ rõ. Tiếng Việt có dấu cần thêm chút.
                    return Math.max(12, Math.min(80, (customText || '').length * 8));
                default:         return 16;
            }
        }
        function shapeLabel(type) {
            return ({
                heart: 'Trái tim ❤️', star: 'Ngôi sao ⭐', circle: 'Tròn ⚪',
                triangle: 'Tam giác 🔺', diamond: 'Kim cương 🔷', smile: 'Mặt cười 😊',
                text: 'Chữ 🔤'
            })[type] || 'Hình';
        }

        async function fxShape(userInfo) {
            if (shapeBusy) return;
            const sCfg = config.effects?.shape || {};
            const sizePercent = Math.max(20, Math.min(95, sCfg.sizePercent ?? 65));
            const durationMs = Math.max(500, sCfg.durationMs ?? 3000);
            const showName = sCfg.showName !== false;
            const color = sCfg.color || '#ffd166';
            const type = sCfg.type || 'heart';

            // Kiểm tra số lượng quà: nếu < ngưỡng tối thiểu, KHÔNG vẽ + báo cho Creator + viewer
            // biết cần thêm bao nhiêu quà nữa.
            const minN = minBodiesForShape(type, sCfg.customText);
            const have = bodies.length;
            if (have < minN) {
                const need = minN - have;
                showComboToast(
                    `🎨 Cần thêm <b>${need}</b> quà nữa để vẽ hình <b>${shapeLabel(type)}</b> · đang có ${have}/${minN}`,
                    'linear-gradient(135deg, #f59e0b, #ef4444)'
                );
                return;
            }

            shapeBusy = true;

            // ƯU TIÊN QUÀ NHỎ: sort ASC theo body.gm.sz → quà nhỏ vào outline trước (sát biên),
            // quà to dùng sau (nếu cần thêm điểm). Nếu đủ quà nhỏ thì quà to KHÔNG bị hút.
            // Cap MAX_BODIES = 120 — đủ chi tiết cho mọi shape, tránh nặng vật lý.
            const MAX_BODIES = 120;
            const sortedAll = bodies.slice().sort((a, b) => {
                const sa = (a.gm && a.gm.sz) || 9999;
                const sb = (b.gm && b.gm.sz) || 9999;
                return sa - sb;
            });
            let useBodies = sortedAll.slice(0, MAX_BODIES);
            const N = useBodies.length;

            // Sample N target points (normalized) → world coords
            const points = generateShapePoints(N, sCfg);
            if (!points.length) { shapeBusy = false; return; }
            const ccx = CANVAS_W / 2;
            const ccy = CANVAS_H * 0.42;   // hơi trên giữa cho cân thị giác (top-half visual)
            const sz = Math.min(CANVAS_W, CANVAS_H * 0.55) * (sizePercent / 100);
            const targets = points.map(p => ({ x: ccx + p.x * sz, y: ccy + p.y * sz }));

            // Sắp xếp tối ưu hoá: gán body gần nhất → target gần nhất (greedy, không Hungarian
            // chuẩn nhưng đủ tốt cho 120 phần tử và không thấy được khác biệt visual).
            const animBodies = useBodies.map(b => ({
                body: b,
                sx: b.position.x, sy: b.position.y,
                tx: 0, ty: 0,
                wasStatic: b.isStatic
            }));
            const usedTargets = new Array(targets.length).fill(false);
            // Greedy: với mỗi body, chọn target gần nhất chưa dùng
            for (const ab of animBodies) {
                let bestIdx = -1, bestD = Infinity;
                for (let i = 0; i < targets.length; i++) {
                    if (usedTargets[i]) continue;
                    const dx = targets[i].x - ab.sx;
                    const dy = targets[i].y - ab.sy;
                    const d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; bestIdx = i; }
                }
                if (bestIdx >= 0) {
                    ab.tx = targets[bestIdx].x;
                    ab.ty = targets[bestIdx].y;
                    usedTargets[bestIdx] = true;
                }
            }

            // Phase 1: freeze + tween về target (~800ms ease-out)
            for (const ab of animBodies) {
                try { Body.setStatic(ab.body, true); } catch (e) {}
                try { Body.setVelocity(ab.body, { x: 0, y: 0 }); } catch (e) {}
            }
            const PHASE1_MS = 800;
            await tween(t => {
                const e = 1 - Math.pow(1 - t, 3);
                for (const ab of animBodies) {
                    const nx = lerp(ab.sx, ab.tx, e);
                    const ny = lerp(ab.sy, ab.ty, e);
                    try { Body.setPosition(ab.body, { x: nx, y: ny }); } catch (err) {}
                }
            }, PHASE1_MS);

            if (config.features.audio) audio.fanfare();
            // Burst pháo hoa ngay khi shape hình thành cho long lanh
            fxAnimations.push({
                type: 'firework',
                x: ccx, y: ccy, age: 0, life: 50,
                color: 'hsl(' + Math.floor(Math.random() * 360) + ',90%,60%)'
            });

            // Phase 2: hiển thị tên + pulse
            let nameEl = null;
            if (showName && overlayLayer) {
                nameEl = document.createElement('div');
                nameEl.className = 'tt-shape-name';
                const rawName = userInfo?.name || userInfo?.nickname || userInfo?.uniqueId || '';
                nameEl.textContent = rawName;
                nameEl.style.color = color;
                const ns = Math.max(24, Math.min(200, sCfg.nameSize ?? 64));
                nameEl.style.fontSize = ns + 'px';
                nameEl.style.left = (ccx / CANVAS_W * 100) + '%';
                nameEl.style.top = (ccy / CANVAS_H * 100) + '%';
                overlayLayer.appendChild(nameEl);
                requestAnimationFrame(() => nameEl.classList.add('show'));
            }

            // Pulse loop: nhịp thở nhẹ + xoay nhẹ — chạy độc lập trong durationMs
            let pulseDone = false;
            const pulseT0 = performance.now();
            const pulseLoop = () => {
                if (pulseDone) return;
                const elapsed = performance.now() - pulseT0;
                if (elapsed >= durationMs) return;
                const phase = (elapsed / 1000) * Math.PI * 2;
                for (const ab of animBodies) {
                    const dx = ab.tx - ccx;
                    const dy = ab.ty - ccy;
                    const dist = Math.hypot(dx, dy);
                    const wave = Math.sin(phase - dist * 0.02) * 3;
                    const nrx = dist > 0 ? dx / dist : 0;
                    const nry = dist > 0 ? dy / dist : 0;
                    try {
                        Body.setPosition(ab.body, {
                            x: ab.tx + nrx * wave,
                            y: ab.ty + nry * wave
                        });
                    } catch (e) {}
                }
                requestAnimationFrame(pulseLoop);
            };
            requestAnimationFrame(pulseLoop);

            await wait(durationMs);
            pulseDone = true;

            // Phase 3: tan biến — fade tên, dynamic lại, drop với jitter
            if (nameEl) {
                nameEl.classList.remove('show');
                nameEl.classList.add('fade');
                setTimeout(() => nameEl.remove(), 1200);
            }
            for (const ab of animBodies) {
                // Snap về target (tránh giật do pulse offset)
                try { Body.setPosition(ab.body, { x: ab.tx, y: ab.ty }); } catch (e) {}
                try { Body.setStatic(ab.body, ab.wasStatic === true); } catch (e) {}
                try {
                    Body.setVelocity(ab.body, {
                        x: (Math.random() - 0.5) * 4,
                        y: Math.random() * 1.5
                    });
                    Body.setAngularVelocity(ab.body, (Math.random() - 0.5) * 0.25);
                } catch (e) {}
            }
            if (config.features.audio) audio.plop();
            shapeBusy = false;
        }

        // ===== Nứt hũ (tích luỹ + vỡ tan khi đủ ngưỡng) =====
        let crackLevel = 0;
        const crackElements = [];
        function generateCrackSvg(numCracks) {
            const paths = [];
            for (let i = 0; i < numCracks; i++) {
                const sx = 15 + Math.random() * 70;
                const sy = 15 + Math.random() * 70;
                let x = sx, y = sy;
                let d = `M ${x.toFixed(1)} ${y.toFixed(1)}`;
                const segs = 4 + Math.floor(Math.random() * 5);
                for (let j = 0; j < segs; j++) {
                    x += (Math.random() - 0.5) * 22;
                    y += (Math.random() - 0.5) * 22;
                    x = Math.max(2, Math.min(98, x));
                    y = Math.max(2, Math.min(98, y));
                    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
                    if (Math.random() < 0.5) {
                        const bx = Math.max(2, Math.min(98, x + (Math.random() - 0.5) * 16));
                        const by = Math.max(2, Math.min(98, y + (Math.random() - 0.5) * 16));
                        d += ` M ${x.toFixed(1)} ${y.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)} M ${x.toFixed(1)} ${y.toFixed(1)}`;
                    }
                }
                paths.push(`<path d="${d}" stroke="rgba(255,255,255,0.92)" stroke-width="0.35" fill="none" stroke-linecap="round"/>`);
                paths.push(`<path d="${d}" stroke="rgba(100,200,255,0.55)" stroke-width="0.7" fill="none" stroke-linecap="round" opacity="0.6"/>`);
            }
            return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${paths.join('')}</svg>`;
        }
        function fxCrackJar() {
            if (!overlayLayer || jarStolen) return;
            const cfg = config.effects?.crackJar || {};
            const durMs = Math.max(500, (cfg.durationSec ?? 5) * 1000);
            const numCracks = Math.max(2, Math.min(20, cfg.count ?? 6));
            const shatterAt = Math.max(2, Math.min(20, cfg.shatterAt ?? 3));

            crackLevel++;
            // Tạo layer crack MỚI (chồng lên các layer cũ → tích luỹ)
            const el = document.createElement('div');
            el.className = 'tt-crack';
            const r = jarRect();
            el.style.left = (r.x / CANVAS_W * 100) + '%';
            el.style.top = (r.y / CANVAS_H * 100) + '%';
            el.style.width = (r.w / CANVAS_W * 100) + '%';
            el.style.height = (r.h / CANVAS_H * 100) + '%';
            el.innerHTML = generateCrackSvg(numCracks);
            overlayLayer.appendChild(el);
            crackElements.push(el);
            requestAnimationFrame(() => el.classList.add('show'));
            if (config.features.audio) audio.steal();
            // Wobble quà
            bodies.forEach(b => Body.setVelocity(b, {
                x: b.velocity.x + (Math.random() - 0.5) * 6,
                y: b.velocity.y - Math.random() * 3
            }));

            // Đạt ngưỡng → VỠ TAN
            if (crackLevel >= shatterAt) {
                shatterJar();
                return;
            }
            // Chưa vỡ → fade sau X giây + giảm crackLevel
            setTimeout(() => {
                el.classList.remove('show');
                setTimeout(() => {
                    el.remove();
                    const idx = crackElements.indexOf(el);
                    if (idx >= 0) crackElements.splice(idx, 1);
                    crackLevel = Math.max(0, crackLevel - 1);
                }, 500);
            }, durMs);
        }
        function flashShatterToast(text, color) {
            showComboToast(text, color || 'linear-gradient(135deg, #dc2626, #f59e0b)');
        }
        function shatterJar() {
            flashShatterToast(`💥 <b>HŨ VỠ TAN!</b> Quà rơi tung toé`);
            if (config.features.audio) { audio.fanfare(); audio.big(); }
            // Nháy đỏ
            if (jarBottomEl) jarBottomEl.style.transition = 'opacity 0.4s, filter 0.4s';
            if (jarGlassEl) jarGlassEl.style.transition = 'opacity 0.4s, filter 0.4s';
            if (jarBottomEl) jarBottomEl.style.filter = 'brightness(2) hue-rotate(330deg)';
            if (jarGlassEl) jarGlassEl.style.filter = 'brightness(2) hue-rotate(330deg)';
            setTimeout(() => {
                if (jarBottomEl) { jarBottomEl.style.opacity = '0.1'; jarBottomEl.style.filter = ''; }
                if (jarGlassEl) { jarGlassEl.style.opacity = '0.1'; jarGlassEl.style.filter = ''; }
            }, 250);

            // Chỉ tháo JAR walls — world floor + side walls vẫn còn → quà sẽ rơi xuống stack ở đáy overlay
            removeJarWalls();
            const r = jarRect();
            bodies.forEach(b => {
                const dx = b.position.x - r.cx;
                const dist = Math.max(Math.abs(dx), 1);
                // Văng ngang ra + đẩy lên một chút để bay qua miệng hũ rồi rơi ngoài
                Body.setVelocity(b, {
                    x: (dx / dist) * (10 + Math.random() * 12) + (Math.random() - 0.5) * 8,
                    y: -(4 + Math.random() * 8)
                });
                Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.6);
            });
            fxAnimations.push({ type: 'megaboom', x: r.cx, y: r.cy, age: 0, life: 50 });

            // Sau 3s: phục hồi hũ. Bodies cũ stack tại đáy overlay; bodies bên trong jar area lại bị
            // jar walls cage lại lần nữa — đó là mong muốn của user (overlay đầy quà phủ luôn Creator).
            setTimeout(() => {
                clearJarLandingZone();
                buildJarWalls();
                if (jarBottomEl) { jarBottomEl.style.opacity = '1'; }
                if (jarGlassEl) { jarGlassEl.style.opacity = '1'; }
                crackElements.forEach(c => c.remove());
                crackElements.length = 0;
                crackLevel = 0;
                flashShatterToast(`✨ Hũ phục hồi nguyên vẹn`, 'linear-gradient(135deg, #22c55e, #10b981)');
            }, 3000);
        }

        // ===== Trộm cả hũ (animation: ninja khổng lồ ôm hũ chạy ra rồi quay lại trả) =====
        let jarStolen = false;
        let stealCountdownEl = null;
        async function fxStealJar() {
            if (jarStolen || !overlayLayer) return;
            captureGiftHistory('Trước Trộm cả hũ', true);
            const durSec = Math.max(3, config.effects?.stealJar?.durationSec ?? 10);
            const restoreDelaySec = durSec;
            const durMs = durSec * 1000;
            jarStolen = true;
            const savedTimeScale = engine.timing.timeScale;
            engine.timing.timeScale = 0;

            const r = jarRect();
            // Trộm cả hũ LUÔN xuất phát từ BÊN TRÁI (theo yêu cầu — nhất quán hướng cướp)
            const fromLeft = true;
            const enterX = -260;
            const exitX = -1200;

            // Tạo ninja khổng lồ
            const ninja = document.createElement('div');
            ninja.className = 'tt-big-thief';
            ninja.innerHTML = NINJA_SVG;
            overlayLayer.appendChild(ninja);
            const posBig = (x) => {
                ninja.style.left = (x / CANVAS_W * 100) + '%';
                ninja.style.top = (r.cy / CANVAS_H * 100) + '%';
            };
            posBig(enterX);

            // Lưu state gốc của hũ
            const targets = [jarBottomEl, jarGlassEl, canvas, countDisplay, _accessoryEl, topHangersEl].filter(Boolean);
            targets.forEach(el => {
                el.dataset._stealOp = el.style.opacity || '1';
                el.dataset._stealTr = el.style.transform || '';
            });

            const flyMs = 700;
            // Phase 1: ninja chạy vào chỗ hũ
            await tween(t => posBig(lerp(enterX, r.cx, t)), 700);

            // Phase 2: ninja + hũ cùng bay ra rìa
            await tween(t => {
                const dx = lerp(0, exitX - r.cx, t);
                const rot = lerp(0, fromLeft ? -18 : 18, t);
                targets.forEach(el => {
                    el.style.transition = 'none';
                    el.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
                });
                posBig(lerp(r.cx, exitX, t));
            }, flyMs);

            // Ẩn hoàn toàn
            targets.forEach(el => { el.style.opacity = '0'; });
            ninja.style.display = 'none';

            flashStealJarToast(durSec, true);
            if (config.features.audio) audio.fanfare();

            // Phase 3: hiển thị countdown ở giữa
            const stayMs = Math.max(800, restoreDelaySec * 1000);
            const stayStartSec = Math.ceil(stayMs / 1000);
            ensureStealCountdownEl();
            stealCountdownEl.style.left = (r.cx / CANVAS_W * 100) + '%';
            stealCountdownEl.style.top = (r.cy / CANVAS_H * 100) + '%';
            stealCountdownEl.style.display = 'flex';
            let remaining = stayStartSec;
            const updateCd = () => {
                if (!stealCountdownEl) return;
                stealCountdownEl.innerHTML = `<div class="ico">🥷</div><div class="lbl">Hũ bị ăn trộm</div><div class="cd">${Math.max(0, remaining)}s</div>`;
            };
            updateCd();
            const cdTimer = setInterval(() => { remaining--; updateCd(); }, 1000);
            await wait(stayMs);
            clearInterval(cdTimer);
            if (stealCountdownEl) stealCountdownEl.style.display = 'none';

            // Phase 4: ninja quay lại TỪ BÊN TRÁI (cùng hướng đã cướp đi) trả hũ
            const returnX = -1200;
            // KHÔNG flip — ninja vẫn quay mặt cùng hướng cũ
            ninja.style.display = 'block';
            targets.forEach(el => {
                el.style.transition = 'none';
                el.style.transform = `translateX(${returnX - r.cx}px) rotate(-18deg)`;
                el.style.opacity = el.dataset._stealOp || '1';
            });
            posBig(returnX);
            await wait(50); // reflow

            await tween(t => {
                const dx = lerp(returnX - r.cx, 0, t);
                const rot = lerp(-18, 0, t);
                targets.forEach(el => el.style.transform = `translateX(${dx}px) rotate(${rot}deg)`);
                posBig(lerp(returnX, r.cx, t));
            }, flyMs);

            // Phase 5: ninja bỏ đi về lại bên trái
            const finalExit = -260;
            await tween(t => posBig(lerp(r.cx, finalExit, t)), 500);

            // Cleanup
            ninja.remove();
            targets.forEach(el => {
                el.style.transition = '';
                el.style.transform = el.dataset._stealTr || '';
                el.style.opacity = el.dataset._stealOp || '1';
            });
            clearJarLandingZone(r);
            engine.timing.timeScale = savedTimeScale || 1;
            jarStolen = false;
            flashStealJarToast(0, false);
            if (config.features.audio) audio.big();
        }
        function ensureStealCountdownEl() {
            if (stealCountdownEl) return;
            stealCountdownEl = document.createElement('div');
            stealCountdownEl.className = 'tt-steal-countdown';
            overlayLayer.appendChild(stealCountdownEl);
        }
        function flashStealJarToast(seconds, isStart) {
            showComboToast(
                isStart
                    ? `🚚 Cướp tẩu thoát với cả hũ! Quay lại sau <b>${seconds}s</b>`
                    : `🎉 Hũ đã quay về!`,
                isStart
                    ? 'linear-gradient(135deg, #ef4444, #f59e0b)'
                    : 'linear-gradient(135deg, #22c55e, #10b981)'
            );
        }

        // ===== Random events =====
        let randomEventTimer = null;
        function startRandomEvents() {
            stopRandomEvents();
            const fns = [fxTilt, fxGravFlip, fxTornado, fxSlow, fxFireworks];
            randomEventTimer = setInterval(() => {
                if (!config.features.randomEvents) return;
                fns[Math.floor(Math.random() * fns.length)]();
            }, Math.max(15, config.randomEventEverySec) * 1000);
        }
        function stopRandomEvents() { if (randomEventTimer) { clearInterval(randomEventTimer); randomEventTimer = null; } }

        // ===== UI overlays =====
        let goalEl, totalsEl, crownEl, lbEl, welcomeEl, comboToastEl, thiefLayer, caughtEl, forceEl, topHangersEl;
        let windUntil = 0;
        let windStartedAt = 0;
        let windTickTimer = null;
        let windRafId = null;
        function ensureOverlayDom() {
            if (!overlayLayer) return;
            if (overlayLayer.dataset.thuytinhInit === '1') {
                goalEl = overlayLayer.querySelector('.tt-goal');
                totalsEl = overlayLayer.querySelector('.tt-totals');
                crownEl = overlayLayer.querySelector('.tt-crown');
                lbEl = overlayLayer.querySelector('.tt-leaderboard');
                caughtEl = overlayLayer.querySelector('.tt-caught');
                forceEl = overlayLayer.querySelector('.tt-force');
                topHangersEl = overlayLayer.querySelector('.tt-top-hangers');
                welcomeEl = overlayLayer.querySelector('.tt-welcome');
                comboToastEl = overlayLayer.querySelector('.tt-combo-toast');
                thiefLayer = overlayLayer.querySelector('.tt-thief-layer');
                return;
            }
            overlayLayer.dataset.thuytinhInit = '1';
            overlayLayer.style.position = 'absolute';
            overlayLayer.style.inset = '0';
            overlayLayer.style.zIndex = '6';
            overlayLayer.style.pointerEvents = 'none';

            overlayLayer.innerHTML = `
                <div class="tt-welcome"></div>
                <div class="tt-combo-toast"></div>
                <div class="tt-crown"><img class="ico" alt=""><img class="avatar" alt=""><div class="name"></div></div>
                <div class="tt-leaderboard tt-drag-panel" data-panel="leaderboard"></div>
                <div class="tt-caught tt-drag-panel" data-panel="caught"></div>
                <div class="tt-force tt-drag-panel" data-panel="force"></div>
                <div class="tt-top-hangers"></div>
                <div class="tt-goal"><div class="bar"><div class="fill"></div></div><div class="label"></div></div>
                <div class="tt-totals"></div>
                <div class="tt-thief-layer"></div>
            `;
            goalEl = overlayLayer.querySelector('.tt-goal');
            totalsEl = overlayLayer.querySelector('.tt-totals');
            crownEl = overlayLayer.querySelector('.tt-crown');
            lbEl = overlayLayer.querySelector('.tt-leaderboard');
            caughtEl = overlayLayer.querySelector('.tt-caught');
            forceEl = overlayLayer.querySelector('.tt-force');
            topHangersEl = overlayLayer.querySelector('.tt-top-hangers');
            welcomeEl = overlayLayer.querySelector('.tt-welcome');
            comboToastEl = overlayLayer.querySelector('.tt-combo-toast');
            thiefLayer = overlayLayer.querySelector('.tt-thief-layer');
            // Bail button delegation (innerHTML refresh không mất listener trên parent)
            caughtEl.addEventListener('click', (ev) => {
                const btn = ev.target.closest('.caught-bail');
                if (!btn) return;
                ev.stopPropagation();
                const uid = btn.dataset.uid;
                bailUser(uid);
                onBail(uid);
            });
            wireDragPanels();
        }
        function positionUiOverlays() {
            if (!overlayLayer) return;
            ensureOverlayDom();
            const r = jarRect();
            // Crown trên miệng hũ
            if (crownEl) {
                const left = (r.cx / CANVAS_W * 100);
                const top = ((r.y + r.h * SHAPE.neckTopY - 60) / CANVAS_H * 100);
                crownEl.style.left = left + '%';
                crownEl.style.top = top + '%';
                crownEl.style.display = config.features.crown && stats.tippers.size > 0 ? 'flex' : 'none';
            }
            // Goal bar SÁT đáy hũ — gap nhỏ (cấu hình qua config.goalBarGap, default -1.2%)
            // Âm = nằm chồng lên đáy hũ. Dương = cách xa đáy.
            if (goalEl) {
                const left = (r.cx / CANVAS_W * 100);
                const gap = typeof config.goalBarGap === 'number' ? config.goalBarGap : -1.2;
                const topPctRaw = ((r.y + r.h) / CANVAS_H * 100) + gap;
                const top = Math.max(0, Math.min(98, topPctRaw));
                goalEl.style.left = left + '%';
                goalEl.style.top = top + '%';
                // Ngắn hơn đáy hũ (70%) cho gọn
                goalEl.style.width = (r.w * 0.7 / CANVAS_W * 100) + '%';
                goalEl.style.maxWidth = 'none';
                goalEl.style.display = config.features.goalBar ? 'flex' : 'none';
            }
            // Totals trên cùng
            if (totalsEl) {
                totalsEl.style.display = config.features.sessionTotals ? 'block' : 'none';
            }
            // Leaderboard bên phải hũ
            if (lbEl) {
                lbEl.style.display = config.features.leaderboard ? 'block' : 'none';
                applyPanelScale('leaderboard', lbEl);
            }
            if (caughtEl) applyPanelScale('caught', caughtEl);
            updateTopHangers();
        }
        function fxWind() {
            const dur = config.effects?.wind?.durationMs || 4200;
            windStartedAt = Date.now();
            windUntil = Date.now() + dur;
            if (windTickTimer) clearInterval(windTickTimer);
            if (windRafId) cancelAnimationFrame(windRafId);
            updateTopHangers();
            topHangersEl?.querySelectorAll('.tt-hanger-avatar.is-kite').forEach((el, i) => {
                el.animate([
                    { transform: 'translate(-50%, calc(-50% + 520px)) scale(.9) rotate(-8deg)' },
                    { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)' }
                ], { duration: 900 + i * 120, easing: 'cubic-bezier(.18,1.25,.35,1)', fill: 'none' });
            });
            startWindLoop();
            windTickTimer = setTimeout(() => {
                windTickTimer = null;
                if (windRafId) {
                    cancelAnimationFrame(windRafId);
                    windRafId = null;
                }
                updateTopHangers();
            }, dur + 80);
        }
        function startWindLoop() {
            const tick = () => {
                if (!topHangersEl || Date.now() >= windUntil) {
                    windRafId = null;
                    return;
                }
                const t = (Date.now() - windStartedAt) / 1000;
                topHangersEl.querySelectorAll('.tt-hanger-avatar.is-kite').forEach((el, i) => {
                    const baseX = Number(el.dataset.baseX || 0);
                    const baseY = Number(el.dataset.baseY || 0);
                    const ampX = Number(el.dataset.ampX || 90);
                    const ampY = Number(el.dataset.ampY || 26);
                    const phase = Number(el.dataset.phase || 0);
                    const x = baseX + Math.sin(t * 1.55 + phase) * ampX + Math.sin(t * 3.1 + phase) * 16;
                    const y = baseY + Math.cos(t * 1.2 + phase) * ampY;
                    el.style.left = (x / CANVAS_W * 100) + '%';
                    el.style.top = (y / CANVAS_H * 100) + '%';
                    const line = topHangersEl.querySelector(`.tt-hanger-lines line[data-i="${i}"]`);
                    if (line) {
                        line.setAttribute('x2', x.toFixed(1));
                        line.setAttribute('y2', y.toFixed(1));
                    }
                });
                windRafId = requestAnimationFrame(tick);
            };
            windRafId = requestAnimationFrame(tick);
        }
        function updateTopHangers() {
            if (!topHangersEl) return;
            if (!config.features.topHangers) {
                topHangersEl.style.display = 'none';
                topHangersEl.innerHTML = '';
                return;
            }
            topHangersEl.style.display = 'block';
            const r = jarRect();
            const windy = Date.now() < windUntil;
            // Default HP avatar toggle (default ON nếu chưa cấu hình):
            //   - ON  → ghim HP ở slot cuối (chiếm 1 trong 5), top 4 real users + HP
            //   - OFF → top 5 real users đầy đủ, không có HP placeholder
            // Khi 0 real users + ON → chỉ hiện HP. Khi 0 real users + OFF → chỉ hiện canvas trống.
            const showDefaultHp = config.features.defaultHpAvatar !== false;
            const HP_ENTRY = { uid: 'hp-media', nickname: 'HP Media', avatar: '/hp-logo-pink.svg', diamonds: 0 };
            const users = showDefaultHp ? topTippers(4) : topTippers(5);
            const baseList = showDefaultHp ? [...users, HP_ENTRY] : (users.length ? users : []);
            const list = baseList;
            const anchorY = r.y + r.h * SHAPE.neckTopY + 8;
            const neckL = r.x + r.w * SHAPE.neckLeftX;
            const neckR = r.x + r.w * SHAPE.neckRightX;
            const svg = [`<svg class="tt-hanger-lines" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" preserveAspectRatio="none">`];
            const avatars = [];
            list.forEach((u, i) => {
                const edgeSlots = [0.03, 0.97, 0.16, 0.84, 0.5];
                const anchorX = neckL + (neckR - neckL) * (edgeSlots[i] ?? (0.5 + (i - 1) * 0.28));
                const normalY = anchorY + 126 + i * 14;
                const breeze = Math.sin(Date.now() / 850 + i * 1.7) * 10;
                const spread = Math.min(280, 82 * Math.max(list.length - 1, 1));
                const kiteBaseX = CANVAS_W * 0.5 - spread / 2 + (spread / Math.max(list.length - 1, 1)) * i;
                const kiteBaseY = Math.max(70, anchorY - 690 - (i % 2) * 90);
                const kiteX = kiteBaseX;
                const kiteY = kiteBaseY;
                const avatarX = windy ? kiteX : anchorX + breeze;
                const avatarY = windy ? kiteY : normalY;
                const name = escHtml(u.nickname || u.uniqueId || 'HP Media');
                const avatar = escAttr(u.avatar || '/hp-logo-pink.svg');
                svg.push(`<line data-i="${i}" x1="${anchorX.toFixed(1)}" y1="${anchorY.toFixed(1)}" x2="${avatarX.toFixed(1)}" y2="${avatarY.toFixed(1)}"></line>`);
                avatars.push(`<div class="tt-hanger-avatar${windy ? ' is-kite' : ''}" data-base-x="${kiteBaseX.toFixed(1)}" data-base-y="${kiteBaseY.toFixed(1)}" data-amp-x="${Math.max(54, 112 - i * 10)}" data-amp-y="${Math.max(16, 30 - i * 3)}" data-phase="${(i * 1.2).toFixed(2)}" style="left:${(avatarX / CANVAS_W * 100).toFixed(3)}%;top:${(avatarY / CANVAS_H * 100).toFixed(3)}%"><img src="${avatar}" onerror="this.src='/hp-logo-pink.svg'" alt=""><span>${name}</span></div>`);
            });
            svg.push('</svg>');
            topHangersEl.innerHTML = svg.join('') + avatars.join('');
        }
        function moveTopHangersWithJar(newJarX, newJarY, angleDeg, baseRect) {
            if (!topHangersEl) return;
            topHangersEl.style.transformOrigin = `${baseRect.cx}px ${baseRect.cy}px`;
            topHangersEl.style.transform = `translate(${newJarX - baseRect.x}px, ${newJarY - baseRect.y}px) rotate(${angleDeg}deg)`;
        }
        function updateCrown() {
            if (!config.features.crown || !crownEl) return;
            const top = topTippers(1)[0];
            if (!top) { crownEl.style.display = 'none'; return; }
            crownEl.style.display = 'flex';
            const ico = crownEl.querySelector('.ico');
            const avatar = crownEl.querySelector('.avatar');
            const name = crownEl.querySelector('.name');
            if (ico) ico.src = crownIconSvg();
            if (avatar) {
                if (top.avatar) { avatar.src = top.avatar; avatar.style.display = 'block'; }
                else avatar.style.display = 'none';
            }
            if (name) name.textContent = (top.nickname || top.uniqueId || '') + ' · ' + top.diamonds + '⭐';
            // Crown change celebration
            if (stats.recentTopUid && stats.recentTopUid !== top.uid) {
                crownEl.animate([{ transform: 'translate(-50%, 0) scale(1)' }, { transform: 'translate(-50%, -10px) scale(1.15)' }, { transform: 'translate(-50%, 0) scale(1)' }],
                    { duration: 600 });
            }
            stats.recentTopUid = top.uid;
            positionUiOverlays();
        }
        function topTippers(n) {
            return Array.from(stats.tippers.values()).sort((a, b) => b.diamonds - a.diamonds).slice(0, n);
        }
        function updateLeaderboard() {
            if (!config.features.leaderboard || !lbEl) return;
            const top = topTippers(5);
            lbEl.innerHTML = `<div class="tt-lb-title">TOP TẶNG</div>` + top.map((t, i) => `
                <div class="tt-lb-row">
                    <div class="rank">#${i + 1}</div>
                    <div class="who">
                        ${t.avatar ? `<img src="${escAttr(t.avatar)}"/>` : `<span class="ph"></span>`}
                        <span>${escHtml(t.nickname || t.uniqueId || 'guest')}</span>
                    </div>
                    <div class="dia">${t.diamonds}⭐</div>
                </div>`).join('');
            applyPanelPosition('leaderboard', lbEl);
        }
        function updateCaughtList() {
            if (!caughtEl) return;
            const now = Date.now();
            stats.caughtList = stats.caughtList.filter(c => c.releaseAt > now);
            if (!stats.caughtList.length) {
                caughtEl.style.display = 'none';
                return;
            }
            caughtEl.style.display = 'block';
            // Overlay (App preview + OBS) chỉ hiển thị THÔNG TIN — nút BẢO LÃNH đã chuyển ra popup
            caughtEl.innerHTML = `<div class="tt-lb-title">BỊ TÓM 🚔</div>` + stats.caughtList.map(c => {
                const left = Math.max(0, Math.ceil((c.releaseAt - now) / 1000));
                const thiefAv = c.avatar
                    ? `<img class="caught-avatar" src="${escAttr(c.avatar)}"/>`
                    : `<div class="caught-avatar ph">🥷</div>`;
                const copMini = c.copAvatar
                    ? `<img class="cop-mini" src="${escAttr(c.copAvatar)}"/>`
                    : `<span class="cop-mini ph">👮</span>`;
                const metaLine = c.copName
                    ? `<div class="caught-meta">do ${copMini} <span class="cop-name">${escHtml(c.copName)}</span> tóm</div>`
                    : '';
                return `<div class="caught-row">
                    ${thiefAv}
                    <div class="caught-main">
                        <div class="caught-top">
                            <div class="caught-name" title="${escAttr(c.name || 'Trộm')}">${escHtml(c.name || 'Trộm')}</div>
                            <span class="caught-cd">${left}s</span>
                        </div>
                        ${metaLine}
                    </div>
                </div>`;
            }).join('');
            applyPanelPosition('caught', caughtEl);
            applyPanelScale('caught', caughtEl);
        }
        function updatePoliceForcePanel() {
            if (!forceEl) return;
            const members = Array.from(policeForce.values());
            if (!members.length) { forceEl.style.display = 'none'; return; }
            forceEl.style.display = 'block';
            forceEl.innerHTML = `<div class="tt-lb-title">🚓 LỰC LƯỢNG CS (${members.length})</div>` + members.map(p => `
                <div class="force-row">
                    ${p.avatar ? `<img class="force-avatar" src="${escAttr(p.avatar)}"/>` : `<div class="force-avatar ph">👮</div>`}
                    <div class="force-name" title="${escAttr(p.name)}">${escHtml(p.name)}</div>
                </div>
            `).join('');
            applyPanelPosition('force', forceEl);
            applyPanelScale('force', forceEl);
        }
        function applyPanelScale(key, el) {
            const s = config.panelScales?.[key];
            if (typeof s === 'number' && s > 0) {
                el.style.setProperty('--cs', String(s));
            }
        }
        // Đẩy actorScales (thief/police/osin) vào CSS variables của thiefLayer
        // → mọi .tt-thief / .tt-police con sẽ pick up tự động qua var().
        function applyActorScales() {
            if (!thiefLayer) return;
            const a = config.actorScales || {};
            const clamp = (v) => Math.max(0.3, Math.min(3, v ?? 1));
            thiefLayer.style.setProperty('--tt-thief-scale', String(clamp(a.thief)));
            thiefLayer.style.setProperty('--tt-police-scale', String(clamp(a.police)));
            thiefLayer.style.setProperty('--tt-ufo-scale', String(clamp(a.ufo)));
            // osin dùng inline width/height % → đọc config trực tiếp lúc spawn (triggerOsin).
        }
        // Đổi PNG hũ ngoài theo theme — chỉ thay src của jarGlassEl
        function applyJarTheme() {
            if (!jarGlassEl) return;
            const theme = config.jarTheme || 'default';
            const newSrc = JAR_THEME_PATHS[theme] || JAR_THEME_PATHS.default;
            // Compare relative path (img.src returns absolute URL)
            if (!jarGlassEl.src.endsWith(newSrc)) {
                jarGlassEl.src = newSrc;
            }
        }

        // Accessory SVG element — gắn vào DOM 1 lần, position theo jar mỗi lần positionJar()
        let _accessoryEl = null;
        function ensureAccessoryEl() {
            if (_accessoryEl) return _accessoryEl;
            if (!jarBottomEl?.parentElement) return null;
            _accessoryEl = document.createElement('div');
            _accessoryEl.className = 'tt-jar-accessory';
            _accessoryEl.style.cssText = 'position:absolute;pointer-events:none;z-index:5;display:none';
            // Insert sau jarGlassEl để accessory nằm trên cùng
            jarBottomEl.parentElement.appendChild(_accessoryEl);
            return _accessoryEl;
        }
        function applyJarAccessory() {
            const el = ensureAccessoryEl();
            if (!el) return;
            const acc = config.jarAccessory || 'none';
            const svg = JAR_ACCESSORIES[acc];
            if (!svg) {
                el.style.display = 'none';
                el.innerHTML = '';
                return;
            }
            el.style.display = 'block';
            el.innerHTML = svg;
            positionAccessory();
        }
        function positionAccessory() {
            if (!_accessoryEl) return;
            const r = jarRect();
            // Vị trí: căn giữa X theo jar, Y nằm ngay trên cổ hũ (nắp)
            // Width = 80% jar width (TĂNG từ 50%), aspect 2:1 do SVG viewBox 200x100
            const accW = r.w * 0.8;
            const accH = accW * 0.5;
            const accX = r.cx - accW / 2;
            // Y: ngay trên neckTop, nhô lên trên 80% accH (đè lên nắp đẹp hơn)
            const accY = r.y + r.h * SHAPE.neckTopY - accH * 0.8;
            _accessoryEl.style.left = (accX / CANVAS_W * 100) + '%';
            _accessoryEl.style.top  = (accY / CANVAS_H * 100) + '%';
            _accessoryEl.style.width  = (accW / CANVAS_W * 100) + '%';
            _accessoryEl.style.height = (accH / CANVAS_H * 100) + '%';
        }

        // ===== 🏷 Badge hiệu ứng quà — render danh sách quà đã gán effect lên overlay =====
        let _badgesContainer = null;
        function ensureBadgesContainer() {
            if (_badgesContainer) return _badgesContainer;
            if (!overlayLayer) return null;
            _badgesContainer = document.createElement('div');
            _badgesContainer.className = 'tt-badges tt-drag-panel';
            _badgesContainer.dataset.panel = 'badges';
            overlayLayer.appendChild(_badgesContainer);
            // Wire drag — chỉ trong app preview (mirrorMode=false), OBS static
            if (!mirrorMode) wireDragPanels();
            return _badgesContainer;
        }
        function renderBadges() {
            const cfg = config.badges || {};
            // Khi tắt: REMOVE hẳn container khỏi DOM (fix bug: container ẩn nhưng vẫn chiếm chỗ).
            // Kết hợp clean stale container nếu có nhiều phiên render cũ còn sót.
            if (!cfg.enabled) {
                if (_badgesContainer) {
                    try { _badgesContainer.remove(); } catch(e) {}
                    _badgesContainer = null;
                }
                // Đề phòng: xóa MỌI .tt-badges trong overlayLayer (bao gồm DOM leftover từ instance cũ)
                if (overlayLayer) {
                    overlayLayer.querySelectorAll('.tt-badges').forEach(n => n.remove());
                }
                return;
            }
            const el = ensureBadgesContainer();
            if (!el) return;
            el.style.display = '';
            // Reset & apply container class — GIỮ tt-drag-panel + class tt-positioned cho drag
            // Container vị trí default top-left, user drag để move tự do
            const keepPositioned = el.classList.contains('tt-positioned');
            const keepDragging = el.classList.contains('tt-dragging');
            el.className = 'tt-badges tt-drag-panel layout-' + (cfg.layout === 'horizontal' ? 'horizontal' : 'vertical')
                + (keepPositioned ? ' tt-positioned' : '')
                + (keepDragging ? ' tt-dragging' : '')
                + (cfg.locked ? ' tt-locked' : '');
            // Apply iconScale via CSS custom property — cascade tới mọi .tt-badge bên trong
            el.style.setProperty('--icon-scale', String(cfg.iconScale ?? 1));
            el.style.setProperty('--badge-scale', String(cfg.scale || 1));
            el.style.setProperty('--badge-gap', String(cfg.gap ?? 0.8));
            el.style.setProperty('--name-scale', String(cfg.nameScale ?? 1));
            // Render từng badge từ config.triggers + config.badges.items
            const triggers = config.triggers || {};
            const items = cfg.items || {};
            // Fallback icon — HP Media logo (bundled trong public/) cho quà không có image
            const FALLBACK_ICON = '/hp-logo.png';
            const iconSrc = (url) => (url && String(url).trim()) ? url : FALLBACK_ICON;
            // Lookup gift metadata qua window.__giftSheet (app.js cache giftSheet vào đây)
            // Hoặc fallback dùng bodies[].gm trong physics world (đã spawn quà rồi)
            const sheet = (typeof window !== 'undefined' && window.__giftSheet) || [];
            const localMap = {};
            for (const g of sheet) if (g?.id) localMap[String(g.id)] = g;
            // Bổ sung từ bodies (case mới spawn, chưa có trong sheet)
            for (const b of bodies) {
                if (b.gm?.id && !localMap[String(b.gm.id)]) {
                    localMap[String(b.gm.id)] = { id: b.gm.id, name: b.gm.name, image: b.gm.img?.src || '' };
                }
            }
            // Default namePos cho tất cả badges nếu per-card không set
            const globalNamePos = cfg.defaultNamePos || (cfg.layout === 'horizontal' ? 'top' : 'right');
            const frag = document.createDocumentFragment();
            // 1. Badges từ triggers (effects đã gán)
            for (const giftId of Object.keys(triggers)) {
                const action = triggers[giftId];
                if (DISABLED_TRIGGER_ACTIONS.has(action)) continue;
                const itemCfg = items[giftId] || {};
                if (itemCfg.enabled === false) continue;
                const giftMeta = localMap[String(giftId)];
                if (!giftMeta) continue;
                const label = (itemCfg.customLabel || actionLabel(action) || action).trim();
                const namePos = itemCfg.namePos || globalNamePos;
                const borderStyle = (itemCfg.borderStyle && itemCfg.borderStyle !== 'none') ? itemCfg.borderStyle : '';
                const badge = document.createElement('div');
                badge.className = 'tt-badge name-' + namePos + (borderStyle ? ' border-' + borderStyle : '');
                badge.title = `${giftMeta.name || ''} · ${label}`;
                badge.innerHTML = `
                    <img class="tt-badge-ico" src="${escAttr(iconSrc(giftMeta.image))}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_ICON}'"/>
                    <div class="tt-badge-name"><span>${escHtml(label)}</span></div>
                `;
                frag.appendChild(badge);
            }
            // 2. Badges thủ công bổ sung (extras) — quà không cần gán effect
            const extras = Array.isArray(cfg.extras) ? cfg.extras : [];
            for (const ex of extras) {
                if (ex.enabled === false) continue;
                if (!ex.id || !ex.name) continue;
                const label = (ex.customLabel || ex.name).trim();
                const namePos = ex.namePos || globalNamePos;
                const borderStyle = (ex.borderStyle && ex.borderStyle !== 'none') ? ex.borderStyle : '';
                const badge = document.createElement('div');
                badge.className = 'tt-badge name-' + namePos + (borderStyle ? ' border-' + borderStyle : '');
                badge.title = `${ex.name} · ${label}`;
                badge.innerHTML = `
                    <img class="tt-badge-ico" src="${escAttr(iconSrc(ex.image))}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_ICON}'"/>
                    <div class="tt-badge-name"><span>${escHtml(label)}</span></div>
                `;
                frag.appendChild(badge);
            }
            // Đếm trước khi append (fragment.children.length = 0 sau khi append)
            const total = frag.children.length;
            el.innerHTML = '';
            // 🔢 Counter pill — ĐẶT NGOÀI vùng cuộn (vertical=trên, horizontal=trái)
            if (total >= 2) {
                const counter = document.createElement('div');
                counter.className = 'tt-badges-counter';
                counter.textContent = String(total);
                counter.title = `${total} quà có badge`;
                el.appendChild(counter);   // first child — ngoài scroll area
            }
            // Inner list div — chứa badges + áp dụng scroll/auto-scroll
            const listEl = document.createElement('div');
            listEl.className = 'tt-badges-list';
            // 🎞 Auto-scroll marquee — render duplicated track nếu enabled + đủ badges
            const as = cfg.autoScroll || {};
            const visibleCount = Math.max(2, parseInt(as.visibleCount || 5, 10));
            if (as.enabled && total > visibleCount) {
                listEl.classList.add('tt-auto-scroll');
                const dir = as.direction || 'up';
                listEl.classList.add('tt-scroll-' + dir);
                // Track inner + duplicate badges để loop seamless
                const track = document.createElement('div');
                track.className = 'tt-badges-track';
                track.appendChild(frag);
                for (const card of [...track.children]) {
                    track.appendChild(card.cloneNode(true));
                }
                listEl.appendChild(track);
                // Set animation duration: total badges × speed giây
                const speed = parseFloat(as.speed) || 2;
                listEl.style.setProperty('--scroll-duration', (total * speed) + 's');
                // Size list = visibleCount cards (cqw-based)
                const cardSize = (cfg.layout === 'horizontal' ? 7 : 4.5);
                const scale = parseFloat(cfg.scale) || 1;
                const gap = parseFloat(cfg.gap ?? 0.8);
                const iconScale = parseFloat(cfg.iconScale) || 1;
                const visibleSize = visibleCount * cardSize * scale
                                    + Math.max(0, visibleCount - 1) * gap * scale
                                    + 4 * iconScale;
                if (cfg.layout === 'horizontal') {
                    listEl.style.maxWidth = visibleSize + 'cqw';
                } else {
                    listEl.style.maxHeight = visibleSize + 'cqw';
                }
            } else {
                listEl.appendChild(frag);
            }
            el.appendChild(listEl);
            // Apply user-saved position (nếu user đã kéo trước đó)
            applyPanelPosition('badges', el);
        }
        // Lookup action label từ EFFECTS list (defined ngoài scope, dùng config.triggers)
        // Map tĩnh cho fallback nếu không có context EFFECTS:
        function actionLabel(action) {
            const M = {
                thief: 'Trộm', joinPolice: 'Gia nhập CS', osin: 'Osin nhặt quà', ufo: 'UFO hút quà',
                shape: 'Tạo hình', fireworks: 'Pháo hoa', megaboom: 'Megaboom', tornado: 'Lốc xoáy',
                tilt: 'Nghiêng hũ', pourOut: 'Dốc ngược hũ', gravflip: 'Đảo trọng lực',
                shake: 'Rung hũ', slow: 'Slow motion', rain: 'Mưa quà', geyser: 'Phun trào',
                magnet: 'Nam châm', crackJar: 'Nứt hũ', stealJar: 'Trộm cả hũ',
                combo: 'Combo', clear: 'Xoá hết hũ', kickJar: 'OSIN đá hũ', throwJar: 'OSIN ném hũ',
                spinJar: 'OSIN xoay hũ', osinKickOut: 'OSIN đá tung quà', zigzagLuck: 'Zikzak may mắn',
                wind: 'Thả diều Avatar Gió', dragonFire: '🐉 Rồng phun lửa'
            };
            return M[action] || action;
        }

        function bailUser(uid) {
            if (!uid) return;
            bannedUntilByUid.delete(String(uid));
            stats.caughtList = stats.caughtList.filter(c => String(c.uid) !== String(uid));
            updateCaughtList();
        }
        function applyPanelPosition(key, el) {
            // Không can thiệp nếu user đang kéo — tránh hút về vị trí cũ giữa chừng
            if (el.classList.contains('tt-dragging')) return;
            const pos = config.panelPositions?.[key];
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                el.style.left = pos.left + '%';
                el.style.top = pos.top + '%';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                el.classList.add('tt-positioned');
            } else {
                // pos null/undefined → reset → để pos-* class (top-left/etc) hoạt động
                el.classList.remove('tt-positioned');
                el.style.left = '';
                el.style.top = '';
                el.style.right = '';
                el.style.bottom = '';
            }
        }
        // Cho phép kéo thả các panel (chỉ trong preview app, overlay OBS thì static)
        // Dùng WeakSet để track panel đã wire — cho phép gọi nhiều lần (khi panel mới được tạo)
        const _wiredPanels = new WeakSet();
        function wireDragPanels() {
            overlayLayer.querySelectorAll('.tt-drag-panel').forEach(panel => {
                if (_wiredPanels.has(panel)) return;
                _wiredPanels.add(panel);
                let dragging = false, startX, startY, baseLeft, baseTop;
                panel.style.pointerEvents = 'auto';
                panel.addEventListener('mousedown', (ev) => {
                    if (ev.button !== 0) return;
                    if (ev.target.closest('a, button, input, select, textarea')) return;
                    // Khóa panel — không cho drag (vd badgesLocked = true cho .tt-badges)
                    if (panel.classList.contains('tt-locked')) return;
                    const stage = overlayLayer.parentElement;
                    const r = stage.getBoundingClientRect();
                    const pr = panel.getBoundingClientRect();
                    baseLeft = ((pr.left - r.left) / r.width) * 100;
                    baseTop = ((pr.top - r.top) / r.height) * 100;
                    startX = ev.clientX; startY = ev.clientY;
                    dragging = true;
                    panel.classList.add('tt-dragging', 'tt-positioned');
                    // Set vị trí hiện tại để clear right/bottom default
                    panel.style.left = baseLeft + '%';
                    panel.style.top = baseTop + '%';
                    panel.style.right = 'auto';
                    panel.style.bottom = 'auto';
                    ev.preventDefault();
                });
                window.addEventListener('mousemove', (ev) => {
                    if (!dragging) return;
                    const stage = overlayLayer.parentElement;
                    const r = stage.getBoundingClientRect();
                    const dx = ((ev.clientX - startX) / r.width) * 100;
                    const dy = ((ev.clientY - startY) / r.height) * 100;
                    const nx = Math.max(0, Math.min(95, baseLeft + dx));
                    const ny = Math.max(0, Math.min(95, baseTop + dy));
                    panel.style.left = nx + '%';
                    panel.style.top = ny + '%';
                    panel.style.right = 'auto';
                    panel.classList.add('tt-positioned');
                });
                window.addEventListener('mouseup', () => {
                    if (!dragging) return;
                    dragging = false;
                    panel.classList.remove('tt-dragging');
                    const key = panel.dataset.panel;
                    const left = parseFloat(panel.style.left);
                    const top = parseFloat(panel.style.top);
                    if (!isFinite(left) || !isFinite(top)) return;
                    config.panelPositions = config.panelPositions || {};
                    config.panelPositions[key] = { left, top };
                    if (typeof onPanelMoved === 'function') onPanelMoved(key, { left, top });
                });
            });
        }
        function updateSessionTotals() {
            if (!config.features.sessionTotals || !totalsEl) return;
            totalsEl.textContent = `${stats.totalGifts} quà · ${stats.totalDiamonds.toLocaleString('vi-VN')} ⭐`;
        }
        function updateGoalBar() {
            if (!config.features.goalBar || !goalEl) return;
            const target = Math.max(1, config.goal.target);
            const pct = Math.min(100, (stats.totalDiamonds / target) * 100);
            const fill = goalEl.querySelector('.fill');
            const label = goalEl.querySelector('.label');
            if (fill) fill.style.width = pct + '%';
            if (label) label.textContent = `${stats.totalDiamonds.toLocaleString('vi-VN')} / ${target.toLocaleString('vi-VN')} ⭐`;
        }
        function showWelcome(g) {
            if (!welcomeEl) return;
            welcomeEl.innerHTML = `
                <div class="ico-wrap">${g.image ? `<img src="${escAttr(g.image)}"/>` : '✨'}</div>
                <div class="text"><b>Thắp sáng quà mới!</b><div>${escHtml(g.giftName || g.giftId || '')}</div></div>`;
            welcomeEl.classList.add('show');
            clearTimeout(welcomeEl._t);
            welcomeEl._t = setTimeout(() => welcomeEl.classList.remove('show'), 3000);
            if (config.features.audio) audio.ting();
        }
        // Helper chung: show toast, auto-hide sau 3s (tránh sticky toast)
        let _comboToastTimer = null;
        function showComboToast(html, bg) {
            if (mirrorMode) return;
            if (!comboToastEl) return;
            comboToastEl.style.background = bg || '';
            comboToastEl.innerHTML = html;
            comboToastEl.classList.remove('show'); void comboToastEl.offsetWidth; comboToastEl.classList.add('show');
            clearTimeout(_comboToastTimer);
            _comboToastTimer = setTimeout(() => comboToastEl.classList.remove('show'), 3000);
        }
        function flashComboToast(name, count) {
            showComboToast(`🔥 <b>${escHtml(name)}</b> combo <span>x${count}</span>`);
        }
        function flashMissToast(name) {
            showComboToast(`💥 <b>${escHtml(name)}</b> bị TUỘT TAY!`, 'linear-gradient(135deg, #ef4444, #ff8a00)');
        }
        function respawnLoot(gm, x, y) {
            if (!gm) return;
            const body = Bodies.circle(x, y, gm.sz / 2, {
                restitution: config.physics.bounce,
                friction: config.physics.friction,
                density: 0.002
            });
            body.gm = gm;
            Body.setVelocity(body, { x: (Math.random() - 0.5) * 4, y: 2 });
            Composite.add(engine.world, body);
            bodies.push(body);
            updateCountDisplay();
            onCountChange(bodies.length);
        }

        // ===== Tên trộm =====
        // Mặc định: emoji 🦝, có thể đổi ảnh/video qua setThiefAppearance
        // SVG icons — render đẹp & nhất quán hơn emoji
        const NINJA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <!-- Body silhouette -->
            <path d="M 16 28 C 16 18 23 11 32 11 C 41 11 48 18 48 28 L 48 38 C 48 42 52 44 52 48 L 52 62 L 12 62 L 12 48 C 12 44 16 42 16 38 Z" fill="#0a0a0a"/>
            <!-- Hood opening shadow -->
            <ellipse cx="32" cy="26" rx="14" ry="7" fill="#000" opacity="0.45"/>
            <!-- Eye band -->
            <rect x="14" y="22.5" width="36" height="7" fill="#1f1f1f"/>
            <!-- Eye whites -->
            <ellipse cx="25" cy="26" rx="3" ry="1.6" fill="#f7f7f7"/>
            <ellipse cx="39" cy="26" rx="3" ry="1.6" fill="#f7f7f7"/>
            <!-- Pupils -->
            <ellipse cx="26" cy="26" rx="1.2" ry="1.2" fill="#0a0a0a"/>
            <ellipse cx="40" cy="26" rx="1.2" ry="1.2" fill="#0a0a0a"/>
            <!-- Headband knot trailing right -->
            <path d="M 50 27 Q 58 28 60 33 L 56 35 Q 56 30 50 30 Z" fill="#1f1f1f"/>
            <!-- Belt -->
            <rect x="13" y="43" width="38" height="3" fill="#3a1414"/>
            <path d="M 30 43 L 34 43 L 33 49 L 31 49 Z" fill="#7c2d12"/>
            <!-- Subtle body shadow -->
            <path d="M 16 38 L 32 44 L 48 38 L 48 62 L 16 62 Z" fill="#000" opacity="0.25"/>
        </svg>`;
        // Tone xanh rêu cảnh sát Việt Nam (đồng bộ với FAB police):
        //   #3f6212 lime-800  — áo chính, gam đậm
        //   #1a2e0a lime-950  — cà vạt + nón đậm
        //   #65a30d lime-600  — lapels + nón crown, gam sáng pop
        const POLICE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <!-- Uniform body -->
            <path d="M 16 36 L 16 62 L 48 62 L 48 36 L 42 33 L 38 38 L 32 40 L 26 38 L 22 33 Z" fill="#3f6212"/>
            <!-- Tie strip -->
            <path d="M 30 36 L 34 36 L 33 56 L 32 58 L 31 56 Z" fill="#1a2e0a"/>
            <!-- Lapels (V collar) -->
            <path d="M 22 33 L 32 42 L 26 38 Z" fill="#65a30d"/>
            <path d="M 42 33 L 32 42 L 38 38 Z" fill="#65a30d"/>
            <!-- Buttons -->
            <circle cx="32" cy="46" r="1.1" fill="#fbbf24"/>
            <circle cx="32" cy="52" r="1.1" fill="#fbbf24"/>
            <!-- Sheriff badge -->
            <g transform="translate(20,42)">
                <polygon points="0,-4 1.2,-1.2 4,-1.2 1.8,0.6 2.6,3.4 0,1.8 -2.6,3.4 -1.8,0.6 -4,-1.2 -1.2,-1.2" fill="#fbbf24" stroke="#a16207" stroke-width="0.4"/>
            </g>
            <!-- Neck -->
            <rect x="29" y="29" width="6" height="6" fill="#e6b58a"/>
            <!-- Head (face) -->
            <ellipse cx="32" cy="22" rx="10" ry="11" fill="#f5d0a9"/>
            <!-- Ears -->
            <ellipse cx="22" cy="23" rx="2" ry="2.5" fill="#e6b58a"/>
            <ellipse cx="42" cy="23" rx="2" ry="2.5" fill="#e6b58a"/>
            <!-- Eyes -->
            <ellipse cx="28" cy="22" rx="1.4" ry="1.6" fill="#fff"/>
            <ellipse cx="36" cy="22" rx="1.4" ry="1.6" fill="#fff"/>
            <circle cx="28" cy="22.3" r="0.9" fill="#1f2937"/>
            <circle cx="36" cy="22.3" r="0.9" fill="#1f2937"/>
            <!-- Eyebrows -->
            <path d="M 25.5 19 L 30.5 19.5" stroke="#5c4033" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M 33.5 19.5 L 38.5 19" stroke="#5c4033" stroke-width="1.2" stroke-linecap="round"/>
            <!-- Mouth -->
            <path d="M 29 27 Q 32 28.5 35 27" stroke="#7c2d12" stroke-width="1" stroke-linecap="round" fill="none"/>
            <!-- Cap shadow on forehead -->
            <ellipse cx="32" cy="14.5" rx="11" ry="2" fill="#000" opacity="0.2"/>
            <!-- Cap brim -->
            <ellipse cx="32" cy="14" rx="14" ry="2.5" fill="#1a2e0a"/>
            <!-- Cap crown -->
            <path d="M 21 14 L 22 6 Q 22 4 24.5 4 L 39.5 4 Q 42 4 42 6 L 43 14 Z" fill="#65a30d"/>
            <!-- Cap band -->
            <rect x="21" y="11" width="22" height="2.5" fill="#1a2e0a"/>
            <!-- Cap shield -->
            <g transform="translate(32,8)">
                <path d="M -3 0 L 3 0 L 2 4 L 0 5 L -2 4 Z" fill="#fbbf24" stroke="#a16207" stroke-width="0.4"/>
                <circle cx="0" cy="2.5" r="1" fill="#dc2626"/>
            </g>
        </svg>`;
        let thiefSrcMode = 'svg';        // 'svg' | 'emoji' | 'image' | 'video'
        let thiefSrcValue = NINJA_SVG;
        let policeSrcMode = 'svg';
        let policeSrcValue = POLICE_SVG;
        // Per-user ban: uid → release timestamp (ms)
        const bannedUntilByUid = new Map();
        let banTimerHandle = null;
        // Lực lượng cảnh sát (user đã gia nhập): uid → { uid, name, avatar, joinedAt }
        const policeForce = new Map();
        function setThiefAppearance({ mode, src }) {
            if (mode) thiefSrcMode = mode;
            if (src !== undefined) thiefSrcValue = src;
        }
        function setPoliceAppearance({ mode, src }) {
            if (mode) policeSrcMode = mode;
            if (src !== undefined) policeSrcValue = src;
        }
        // Ban theo từng user (uid). User khác KHÔNG bị ảnh hưởng.
        function isThiefBanned(uid) {
            if (!uid) return false;
            const t = bannedUntilByUid.get(String(uid));
            return !!(t && t > Date.now());
        }
        function banThief(uid, seconds) {
            if (!uid) return;
            bannedUntilByUid.set(String(uid), Date.now() + Math.max(1, seconds) * 1000);
            startBanCountdown();
        }
        function unbanThief(uid) {
            if (uid) bannedUntilByUid.delete(String(uid));
            else bannedUntilByUid.clear();
            // Auto cleanup sẽ tự ẩn UI khi map rỗng
        }
        function pruneExpiredBans() {
            const now = Date.now();
            for (const [uid, t] of bannedUntilByUid) {
                if (t <= now) bannedUntilByUid.delete(uid);
            }
        }
        function startBanCountdown() {
            if (banTimerHandle) return;
            banTimerHandle = setInterval(() => {
                pruneExpiredBans();
                updateCaughtList();
                if (bannedUntilByUid.size === 0) stopBanCountdown();
            }, 250);
        }
        function stopBanCountdown() {
            if (banTimerHandle) { clearInterval(banTimerHandle); banTimerHandle = null; }
        }

        function buildPoliceNode({ direction, name, avatar } = {}) {
            const wrap = document.createElement('div');
            wrap.className = 'tt-police' + (direction === 'left' ? ' flip' : '');
            const body = document.createElement('div'); body.className = 'cop-body';
            if (policeSrcMode === 'svg') body.innerHTML = policeSrcValue;
            else if (policeSrcMode === 'emoji') body.textContent = policeSrcValue;
            else if (policeSrcMode === 'image') {
                const im = document.createElement('img'); im.src = policeSrcValue; body.appendChild(im);
            } else if (policeSrcMode === 'video') {
                const v = document.createElement('video'); v.src = policeSrcValue;
                v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
                body.appendChild(v);
            }
            wrap.appendChild(body);
            if (name) {
                const lbl = document.createElement('div'); lbl.className = 'cop-name';
                if (avatar) {
                    const av = document.createElement('img'); av.className = 'cop-avatar'; av.src = avatar;
                    lbl.appendChild(av);
                }
                const txt = document.createElement('span'); txt.textContent = name;
                lbl.appendChild(txt);
                wrap.appendChild(lbl);
            }
            return { wrap, body };
        }
        function pickPoliceIdentity(excludeUid) {
            // 1) Ưu tiên: pick từ user đã gia nhập lực lượng cảnh sát
            const force = Array.from(policeForce.values()).filter(p => p.uid !== String(excludeUid || ''));
            if (force.length) {
                const p = force[Math.floor(Math.random() * force.length)];
                return { name: p.name || 'CS', avatar: p.avatar || '' };
            }
            // 2) Tên cố định trong config (nếu user đặt sẵn)
            const fixed = (config.policeName || '').trim();
            if (fixed) return { name: fixed, avatar: '' };
            // 3) Fallback: pick random tipper khác
            const pool = Array.from(stats.tippers.values()).filter(t => t.uid !== excludeUid);
            if (pool.length) {
                const t = pool[Math.floor(Math.random() * pool.length)];
                return { name: t.nickname || t.uniqueId || 'Cảnh sát', avatar: t.avatar };
            }
            return { name: 'Cảnh sát', avatar: '' };
        }
        function flashPoliceCantStealToast(name) {
            showComboToast(
                `🚓 <b>${escHtml(name || 'User')}</b> là Cảnh sát · không được trộm`,
                'linear-gradient(135deg, #2563eb, #1e40af)'
            );
        }
        function positionEl(el, xCanvas, yCanvas) {
            el.style.position = 'absolute';
            el.style.left = (xCanvas / CANVAS_W * 100) + '%';
            el.style.top = (yCanvas / CANVAS_H * 100) + '%';
        }
        function flashBanRejected(uid, name) {
            const t = bannedUntilByUid.get(String(uid || ''));
            const left = t ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : 0;
            showComboToast(
                `🚔 <b>${escHtml(name || 'Trộm')}</b> đang bị giam · còn ${left}s`,
                'linear-gradient(135deg, #2563eb, #1e40af)'
            );
        }
        function flashPoliceCatchToast(thiefName, copName) {
            const cop = copName ? `<b style="color:#60a5fa">${escHtml(copName)}</b> ` : '🚔 Cảnh sát ';
            showComboToast(
                `${cop}tóm <b style="color:#ffd166">${escHtml(thiefName)}</b>!`,
                'linear-gradient(135deg, #2563eb, #ef4444)'
            );
        }

        function buildThiefNode({ name, avatar } = {}) {
            const wrap = document.createElement('div'); wrap.className = 'tt-thief';
            const rope = document.createElement('div'); rope.className = 'rope';
            wrap.appendChild(rope);
            const body = document.createElement('div'); body.className = 'thief-body';
            if (thiefSrcMode === 'svg') body.innerHTML = thiefSrcValue;
            else if (thiefSrcMode === 'emoji') body.textContent = thiefSrcValue;
            else if (thiefSrcMode === 'image') {
                const im = document.createElement('img'); im.src = thiefSrcValue; body.appendChild(im);
            } else if (thiefSrcMode === 'video') {
                const v = document.createElement('video'); v.src = thiefSrcValue;
                v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
                body.appendChild(v);
            }
            wrap.appendChild(body);
            if (name) {
                const lbl = document.createElement('div'); lbl.className = 'thief-name';
                if (avatar) {
                    const av = document.createElement('img'); av.className = 'thief-avatar'; av.src = avatar;
                    lbl.appendChild(av);
                }
                const txt = document.createElement('span'); txt.textContent = name;
                lbl.appendChild(txt);
                wrap.appendChild(lbl);
            }
            const loot = document.createElement('div'); loot.className = 'loot';
            wrap.appendChild(loot);
            return { wrap, rope, body, loot };
        }
        // KHÔNG khoá: cho phép nhiều tên trộm cùng lúc
        async function triggerThief(opts = {}) {
            if (!thiefLayer || !bodies.length) return;
            // CS không được đi trộm
            if (isInPoliceForce(opts.uid)) {
                flashPoliceCantStealToast(opts.name);
                return;
            }
            // Nếu USER này đang bị giam → không cho user này thả (user khác vẫn được)
            if (isThiefBanned(opts.uid)) {
                flashBanRejected(opts.uid, opts.name);
                return;
            }
            // 40% chuyển sang RUNNER (chạy từ trái, leo hũ) thay vì rope.
            // Gán vào opts.mode để onTrigger broadcast đúng mode cho OBS replay.
            if (!opts.mode) opts.mode = (Math.random() < 0.4 ? 'runner' : 'rope');
            if (opts.mode === 'runner') {
                return triggerThiefRunner(opts);
            }
            const { name, avatar, uid } = opts;
            {
                const { wrap, rope, body, loot } = buildThiefNode({ name, avatar });
                thiefLayer.appendChild(wrap);
                const r = jarRect();
                // Điểm hạ rope: ƯU TIÊN VÙNG GIỮA màn hình (tránh viền 2 bên do TikTok UI che).
                // Lấy tâm hũ + offset ngẫu nhiên ±35% bề ngang hũ, clamp vào vùng an toàn 18%-82% canvas.
                const jarCenterX = r.x + r.w / 2;
                const offset = (Math.random() - 0.5) * r.w * 0.7;
                const dropX = Math.max(CANVAS_W * 0.18, Math.min(CANVAS_W * 0.82, jarCenterX + offset));
                const ropeStartY = 20;
                const mouthY = r.y + r.h * SHAPE.neckTopY + 10;
                // ƯU TIÊN trộm icon trong hũ (60-80%): bodies có y nằm giữa miệng và đáy hũ,
                // và x nằm trong vùng hũ. Nếu không có thì rơi về random toàn bộ.
                const jarBottomY = r.y + r.h * 0.95;
                const insideJar = bodies.filter(b => {
                    const p = b.position;
                    return p.x >= r.x && p.x <= r.x + r.w
                        && p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= jarBottomY;
                });
                const preferInside = insideJar.length > 0 && Math.random() < 0.9;  // 90% prefer inside
                const pool = preferInside ? insideJar : bodies;
                const targetBody = pool[Math.floor(Math.random() * pool.length)];
                const targetX = targetBody.position.x;
                const targetY = targetBody.position.y;

                // Phase 1: rope drop từ đỉnh xuống mép miệng hũ
                positionThief(wrap, rope, dropX, ropeStartY, ropeStartY + 30);
                await tween(t => {
                    const len = lerp(30, mouthY - ropeStartY, t);
                    positionThief(wrap, rope, dropX, ropeStartY, ropeStartY + len);
                }, 900);

                // Phase 2: bò vào miệng hũ — di chuyển ngang đến trên đầu target
                const overTargetY = mouthY;
                await tween(t => {
                    const x = lerp(dropX, targetX, t);
                    positionThief(wrap, rope, x, ropeStartY, overTargetY - ropeStartY);
                }, 700);

                // Phase 3: thả xuống bám vào icon
                await tween(t => {
                    const y = lerp(overTargetY, targetY, t);
                    positionThief(wrap, rope, targetX, ropeStartY, y - ropeStartY);
                }, 500);

                // Phase 4: ăn cắp — chỉ ăn nếu body vẫn còn (chưa ai khác lấy)
                let lootGm = null;
                const idx = bodies.indexOf(targetBody);
                if (idx >= 0) {
                    bodies.splice(idx, 1);
                    Composite.remove(engine.world, targetBody);
                    updateCountDisplay();
                    onCountChange(bodies.length);
                    lootGm = targetBody.gm;
                    if (lootGm?.img) {
                        const im = document.createElement('img');
                        im.src = lootGm.img.src;
                        loot.appendChild(im);
                    }
                    if (config.features.audio) audio.steal();
                }
                wrap.classList.add('grab');
                await wait(250);

                // Cảnh sát có khả năng tóm trộm sau khi cầm quà — bypass MISS
                const policeOn = !!config.features?.police;
                const catchRate = Math.max(0, Math.min(1, config.policeCatchRate ?? 0));
                const willBeCaught = policeOn && !!lootGm && Math.random() < catchRate;

                if (willBeCaught) {
                    // Phase 5a: trộm leo lên 1 đoạn (~30%) rồi cảnh sát xuất hiện
                    const midY = lerp(targetY, ropeStartY + 30, 0.35);
                    await tween(t => {
                        const y = lerp(targetY, midY, t);
                        positionThief(wrap, rope, targetX, ropeStartY, y - ropeStartY);
                    }, 500);

                    // Cảnh sát hiện từ rìa đối diện
                    const policeFromLeft = targetX > CANVAS_W / 2;
                    const policeStartX = policeFromLeft ? -100 : CANVAS_W + 100;
                    const policeY = midY;
                    const copIdentity = pickPoliceIdentity(uid);
                    const cop = buildPoliceNode({
                        direction: policeFromLeft ? 'right' : 'left',
                        name: copIdentity.name,
                        avatar: copIdentity.avatar
                    });
                    thiefLayer.appendChild(cop.wrap);
                    positionEl(cop.wrap, policeStartX, policeY);

                    // Cảnh sát chạy đến chỗ trộm
                    await tween(t => {
                        const px = lerp(policeStartX, targetX, t);
                        positionEl(cop.wrap, px, policeY);
                    }, 650);

                    // Túm cổ: animation grab
                    cop.wrap.classList.add('grab');
                    flashPoliceCatchToast(name || 'Trộm', copIdentity.name);
                    if (config.features.audio) audio.steal();

                    // Quà trả lại vào hũ nếu còn
                    if (lootGm) {
                        const lootImg = loot.querySelector('img');
                        if (lootImg) loot.removeChild(lootImg);
                        respawnLoot(lootGm, targetX, policeY + 30);
                    }
                    wrap.classList.remove('grab');
                    await wait(350);

                    // Cả hai chạy đi khỏi canvas về phía cảnh sát đến
                    const exitX = policeFromLeft ? -120 : CANVAS_W + 120;
                    await tween(t => {
                        const x = lerp(targetX, exitX, t);
                        positionEl(cop.wrap, x, policeY);
                        positionThief(wrap, rope, x, ropeStartY, policeY - ropeStartY);
                    }, 800);
                    // Thu rope
                    await tween(t => {
                        const len = lerp(policeY - ropeStartY, 0, t);
                        positionThief(wrap, rope, exitX, ropeStartY, ropeStartY + len);
                        wrap.style.opacity = String(1 - t);
                        cop.wrap.style.opacity = String(1 - t);
                    }, 300);

                    cop.wrap.remove();
                    wrap.remove();

                    // Cấm tính năng trộm CHO RIÊNG USER NÀY (user khác vẫn được trộm)
                    const sec = config.policeBanSec ?? 30;
                    // Xoá entry cũ của uid nếu có (tránh trùng)
                    stats.caughtList = stats.caughtList.filter(c => c.uid !== uid);
                    stats.caughtList.push({
                        uid: uid || ('anon-' + Date.now()),
                        name: name || 'Trộm',
                        avatar: avatar || '',
                        copName: copIdentity.name,
                        copAvatar: copIdentity.avatar,
                        releaseAt: Date.now() + sec * 1000
                    });
                    updateCaughtList();
                    if (uid) banThief(uid, sec);
                    else startBanCountdown();   // có entry không uid, cần timer để xoá
                    return;
                }

                // Phase 5: leo lên đỉnh — có thể MISS rớt quà
                const missRate = Math.max(0, Math.min(1, config.thiefMissRate ?? 0));
                const willMiss = !!lootGm && Math.random() < missRate;
                if (willMiss) {
                    // Leo lên 1 đoạn rồi tuột tay
                    const halfwayY = (targetY + ropeStartY + 30) / 2;
                    await tween(t => {
                        const y = lerp(targetY, halfwayY, t);
                        positionThief(wrap, rope, targetX, ropeStartY, y - ropeStartY);
                    }, 450);
                    // Tuột loot: gỡ khỏi DOM tên trộm
                    const lootImg = loot.querySelector('img');
                    if (lootImg) loot.removeChild(lootImg);
                    wrap.classList.remove('grab');
                    flashMissToast(name || 'Trộm');
                    // Spawn lại quà vào world ngay tại vị trí thả
                    respawnLoot(lootGm, targetX, halfwayY);
                    // Tên trộm tiếp tục bỏ chạy
                    await tween(t => {
                        const y = lerp(halfwayY, ropeStartY + 30, t);
                        positionThief(wrap, rope, targetX, ropeStartY, y - ropeStartY);
                    }, 600);
                } else {
                    await tween(t => {
                        const y = lerp(targetY, ropeStartY + 30, t);
                        positionThief(wrap, rope, targetX, ropeStartY, y - ropeStartY);
                    }, 900);
                }

                // Phase 6: di chuyển ngang ra rìa rồi rope thu lại
                await tween(t => {
                    const x = lerp(targetX, dropX, t);
                    positionThief(wrap, rope, x, ropeStartY, 30);
                }, 400);
                await tween(t => {
                    const len = lerp(30, 0, t);
                    positionThief(wrap, rope, dropX, ropeStartY, ropeStartY + len);
                    wrap.style.opacity = String(1 - t);
                }, 500);

                wrap.remove();
            }
        }
        function positionThief(wrap, rope, xCanvas, ropeTopYCanvas, thiefYCanvas) {
            const xPct = xCanvas / CANVAS_W * 100;
            const ropeTopPct = ropeTopYCanvas / CANVAS_H * 100;
            const thiefYPct = thiefYCanvas / CANVAS_H * 100;
            wrap.style.position = 'absolute';
            wrap.style.left = xPct + '%';
            wrap.style.top = thiefYPct + '%';
            const ropeLenPct = thiefYPct - ropeTopPct;
            rope.style.position = 'absolute';
            rope.style.left = '50%';
            rope.style.top = (-ropeLenPct) + '%';
            rope.style.height = ropeLenPct + '%';
        }
        function tween(fn, ms) {
            return new Promise(res => {
                const t0 = performance.now();
                function step(now) {
                    const t = Math.min(1, (now - t0) / ms);
                    fn(t);
                    if (t < 1) requestAnimationFrame(step);
                    else res();
                }
                requestAnimationFrame(step);
            });
        }
        function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
        function lerp(a, b, t) { return a + (b - a) * t; }

        // ===== Trộm Runner: chạy từ trái → leo lên thành hũ → trộm → chạy về =====
        // Sử dụng CÙNG buildThiefNode như rope thief để visual đồng bộ — chỉ thêm class
        // .tt-thief-runner để ẨN dây (rope) và điều chỉnh position anchor.
        async function triggerThiefRunner(opts = {}) {
            const { name, avatar, uid } = opts;
            const r = jarRect();
            // Reuse buildThiefNode (giống rope thief 100%): có rope + body + name + loot
            // → class .tt-thief-runner sẽ ẩn rope qua CSS
            const { wrap, rope, body, loot } = buildThiefNode({ name, avatar });
            wrap.classList.add('tt-thief-runner');
            thiefLayer.appendChild(wrap);

            // Mặt sàn (ground): y ~ 91% canvas
            const groundY = CANVAS_H * 0.91;
            // Cạnh trái hũ (để leo)
            const climbX = r.x - r.w * 0.04;
            // Bắt đầu off-screen bên trái
            const startX = -CANVAS_W * 0.15;
            // Helper: đặt vị trí cho wrap runner (anchor = chân = top mới)
            const posRunner = (xCanvas, yCanvas) => {
                wrap.style.position = 'absolute';
                wrap.style.left = (xCanvas / CANVAS_W * 100) + '%';
                wrap.style.top = (yCanvas / CANVAS_H * 100) + '%';
            };
            posRunner(startX, groundY);
            wrap.style.transition = 'left 1.0s linear, top 0.6s cubic-bezier(.25,.1,.25,1)';
            await wait(60);

            // Phase 1: chạy ngang đến chân trái hũ
            wrap.style.left = (climbX / CANVAS_W * 100) + '%';
            await wait(1020);

            // Phase 2: leo lên dọc thành trái hũ tới miệng
            const climbTopY = r.y + r.h * SHAPE.neckTopY + 20;
            wrap.classList.add('climbing');
            wrap.style.transition = 'top 0.9s cubic-bezier(.4,0,.4,1)';
            wrap.style.top = (climbTopY / CANVAS_H * 100) + '%';
            await wait(920);

            // Phase 3: vợt 1 quà từ trong hũ
            // Ưu tiên 75% target body trong hũ
            const insideJar = bodies.filter(b => {
                const p = b.position;
                return p.x >= r.x && p.x <= r.x + r.w
                    && p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= r.y + r.h * 0.95;
            });
            const pool = (insideJar.length && Math.random() < 0.9) ? insideJar : bodies;
            const target = pool[Math.floor(Math.random() * pool.length)];
            let lootGm = null;
            const idx = bodies.indexOf(target);
            if (idx >= 0) {
                bodies.splice(idx, 1);
                Composite.remove(engine.world, target);
                updateCountDisplay();
                onCountChange(bodies.length);
                lootGm = target.gm;
                if (lootGm?.img) {
                    const lootEl = wrap.querySelector('.loot');
                    if (lootEl) {
                        const im = document.createElement('img');
                        im.src = lootGm.img.src;
                        lootEl.appendChild(im);
                    }
                }
                if (config.features.audio) audio.steal();
            }
            // Vợt nhanh
            wrap.style.transition = 'transform 0.18s ease';
            wrap.style.transform = 'translate(-50%, -100%) scale(1.12)';
            await wait(180);
            wrap.style.transform = 'translate(-50%, -100%) scale(1)';
            await wait(120);

            // Phase 4: kiểm tra cảnh sát có tóm không (giống rope thief)
            const policeOn = !!config.features?.police;
            const catchRate = Math.max(0, Math.min(1, config.policeCatchRate ?? 0));
            const willBeCaught = policeOn && !!lootGm && Math.random() < catchRate;

            if (willBeCaught) {
                // Cảnh sát xuất hiện trên đỉnh hũ tóm trộm
                const copIdentity = pickPoliceIdentity(uid);
                const cop = buildPoliceNode({ direction: 'right', name: copIdentity.name, avatar: copIdentity.avatar });
                thiefLayer.appendChild(cop.wrap);
                cop.wrap.style.position = 'absolute';
                cop.wrap.style.left = ((climbX + 60) / CANVAS_W * 100) + '%';
                cop.wrap.style.top = (climbTopY / CANVAS_H * 100) + '%';
                cop.wrap.style.transform = 'translate(-50%, -100%)';
                cop.wrap.style.transition = 'left 0.5s ease';
                await wait(60);
                cop.wrap.style.left = (climbX / CANVAS_W * 100) + '%';
                await wait(520);
                flashPoliceCatchToast(name || 'Trộm', copIdentity.name);
                if (config.features.audio) audio.fanfare();

                // Quà rơi xuống lại hũ (vận tốc xuống nhẹ)
                if (lootGm) {
                    const respawnX = r.x + r.w / 2;
                    const respawnY = r.y + r.h * SHAPE.neckTopY + 60;
                    const newBody = Bodies.circle(respawnX, respawnY, lootGm.sz / 2, {
                        restitution: config.physics.bounce,
                        friction: config.physics.friction,
                        density: 0.002
                    });
                    newBody.gm = lootGm;
                    Body.setVelocity(newBody, { x: 0, y: 4 });
                    Composite.add(engine.world, newBody);
                    bodies.push(newBody);
                    updateCountDisplay();
                    onCountChange(bodies.length);
                }
                const lootEl = wrap.querySelector('.loot');
                if (lootEl) lootEl.innerHTML = '';

                await wait(300);
                // Cả 2 rời màn hình về trái
                wrap.style.transition = 'left 1.0s linear, top 0.8s ease-in';
                wrap.style.top = (groundY / CANVAS_H * 100) + '%';
                wrap.style.left = (startX / CANVAS_W * 100) + '%';
                cop.wrap.style.transition = 'left 1.0s linear, top 0.8s ease-in';
                cop.wrap.style.top = (groundY / CANVAS_H * 100) + '%';
                cop.wrap.style.left = (startX / CANVAS_W * 100) + '%';
                await wait(1020);
                cop.wrap.remove();
                wrap.remove();

                // Thêm vào BỊ TÓM
                const sec = config.policeBanSec ?? 30;
                stats.caughtList = stats.caughtList.filter(c => c.uid !== uid);
                stats.caughtList.push({
                    uid: uid || ('anon-' + Date.now()),
                    name: name || 'Trộm',
                    avatar: avatar || '',
                    copName: copIdentity.name,
                    copAvatar: copIdentity.avatar,
                    releaseAt: Date.now() + sec * 1000
                });
                updateCaughtList();
                if (uid) banThief(uid, sec);
                else startBanCountdown();
                return;
            }

            // Phase 5: thoát — leo xuống và chạy về bên trái
            wrap.classList.remove('climbing');
            wrap.style.transition = 'top 0.7s cubic-bezier(.4,0,.4,1)';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            await wait(720);

            wrap.style.transition = 'left 1.0s linear';
            wrap.style.left = (startX / CANVAS_W * 100) + '%';
            await wait(1020);

            wrap.remove();
        }

        let thiefAutoTimer = null;
        function startThiefAuto() {
            stopThiefAuto();
            thiefAutoTimer = setInterval(() => {
                if (config.features.thiefAuto) triggerThief();
            }, Math.max(15, config.thiefEverySec) * 1000);
        }
        function stopThiefAuto() { if (thiefAutoTimer) { clearInterval(thiefAutoTimer); thiefAutoTimer = null; } }

        // ===== OSIN: nhặt quà văng ra ngoài hũ, đưa về lại =====
        // Phát hiện body nằm NGOÀI vùng hũ (rơi ra do shatter/stealJar/tilt) → OSIN xuất hiện
        // bò ngang, đến từng quà, ôm về và "ném" lại vào hũ. Cuối cùng toast cảm ơn user.
        let osinBusy = false;
        function findEscapedBodies() {
            const r = jarRect();
            const jarBottomY = r.y + r.h * 0.95;
            return bodies.filter(b => {
                const p = b.position;
                // Ngoài vùng hũ X HOẶC dưới đáy hũ (đã rơi xuống nền canvas)
                const outsideX = p.x < r.x - 30 || p.x > r.x + r.w + 30;
                const belowJar = p.y > jarBottomY + 40;
                return outsideX || belowJar;
            });
        }
        // SVG nhân vật OSIN — hình người đơn giản: đầu, thân áo, tay, chân, basket cầm tay
        // Tay phải sẽ giữ quà nhặt được (slot .osin-hand)
        function osinPersonSvg() {
            // Phục trang HỒNG theo màu logo HP (hơi đậm hơn gradient logo cho rõ trên overlay)
            // shirt: #f472b6 (pink-400), collar/hat: #ec4899 (pink-500), pants: #9d174d (pink-900)
            return `
<svg viewBox="0 0 80 140" xmlns="http://www.w3.org/2000/svg" class="osin-person">
  <!-- mũ -->
  <ellipse cx="40" cy="14" rx="14" ry="6" fill="#ec4899"/>
  <rect x="29" y="6" width="22" height="10" rx="2" fill="#f472b6"/>
  <!-- đầu -->
  <circle cx="40" cy="26" r="11" fill="#fde68a" stroke="#a16207" stroke-width="1"/>
  <!-- mắt -->
  <circle cx="36" cy="25" r="1.4" fill="#1f2937"/>
  <circle cx="44" cy="25" r="1.4" fill="#1f2937"/>
  <!-- miệng -->
  <path d="M36 31 Q40 33 44 31" stroke="#7c2d12" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  <!-- thân áo -->
  <rect x="26" y="38" width="28" height="38" rx="5" fill="#f472b6"/>
  <rect x="26" y="38" width="28" height="8" rx="3" fill="#ec4899"/>
  <!-- nút áo -->
  <circle cx="40" cy="52" r="1.5" fill="#fff"/>
  <circle cx="40" cy="60" r="1.5" fill="#fff"/>
  <circle cx="40" cy="68" r="1.5" fill="#fff"/>
  <!-- tay trái (cầm chổi) -->
  <g class="osin-arm-left">
    <line x1="28" y1="44" x2="16" y2="72" stroke="#fde68a" stroke-width="6" stroke-linecap="round"/>
    <!-- chổi -->
    <line x1="14" y1="66" x2="12" y2="84" stroke="#7c2d12" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M8 84 Q12 92 16 84 Z" fill="#fbbf24"/>
  </g>
  <!-- tay phải (giữ quà — slot foreignObject .osin-hand) -->
  <g class="osin-arm-right">
    <line x1="52" y1="44" x2="64" y2="62" stroke="#fde68a" stroke-width="6" stroke-linecap="round"/>
    <foreignObject x="56" y="52" width="22" height="22" class="osin-hand"></foreignObject>
  </g>
  <!-- chân trái (animation đi bộ) — quần hồng đậm -->
  <g class="osin-leg-left">
    <line x1="34" y1="76" x2="32" y2="110" stroke="#9d174d" stroke-width="8" stroke-linecap="round"/>
    <ellipse cx="32" cy="116" rx="9" ry="4" fill="#500724"/>
  </g>
  <!-- chân phải -->
  <g class="osin-leg-right">
    <line x1="46" y1="76" x2="48" y2="110" stroke="#9d174d" stroke-width="8" stroke-linecap="round"/>
    <ellipse cx="48" cy="116" rx="9" ry="4" fill="#500724"/>
  </g>
</svg>`;
        }
        function buildOsinNode({ name } = {}) {
            const wrap = document.createElement('div');
            wrap.className = 'tt-osin';
            wrap.innerHTML = `
                <div class="osin-label">🧹 OSIN${name ? ' · ' + escHtml(name) : ''}</div>
                <div class="osin-body">${osinPersonSvg()}</div>`;
            return wrap;
        }
        async function triggerOsin(opts = {}) {
            if (!thiefLayer || osinBusy) return;
            const r = jarRect();

            // ===== SYNC PHASE (chạy đồng bộ trước khi await) =====
            // Pre-decide target để App + OBS dùng cùng vị trí. App mutate opts.targetX/Y →
            // sendCmd payload có sẵn → OBS triggerOsin nhận → render cùng đường đi.
            if (opts.targetX == null || opts.targetY == null) {
                // 1) Ưu tiên 1 quà văng ra ngoài hũ
                const escaped = findEscapedBodies();
                let target = null;
                if (escaped.length) {
                    target = escaped[Math.floor(Math.random() * escaped.length)];
                } else if (bodies.length) {
                    // 2) Không có escaped → chọn 1 body bất kỳ trong hũ (để OSIN có việc làm)
                    target = bodies[Math.floor(Math.random() * bodies.length)];
                }
                if (!target) {
                    // Hũ trống → OSIN vô việc, thông báo nhẹ
                    showComboToast(
                        `🧹 OSIN tới giúp nhưng không có quà nào để nhặt`,
                        'linear-gradient(135deg, #6b7280, #4b5563)'
                    );
                    return;
                }
                opts.targetX = target.position.x;
                opts.targetY = target.position.y;
            }
            const targetX = opts.targetX;
            const targetY = opts.targetY;

            // Tìm body LOCAL gần nhất với target (App đã chọn target chính xác,
            // OBS có thể không match 100% nhưng chọn cái gần nhất trong bán kính 200px)
            let pickupBody = null;
            let bestDist = Infinity;
            for (const b of bodies) {
                const d = Math.hypot(b.position.x - targetX, b.position.y - targetY);
                if (d < bestDist) { bestDist = d; pickupBody = b; }
            }
            if (bestDist > 200) pickupBody = null;   // không có body khớp → animation visual only

            osinBusy = true;
            const { name } = opts;
            const wrap = buildOsinNode({ name });
            thiefLayer.appendChild(wrap);

            // OSIN xuất hiện từ mép trái/phải gần target (chọn mép gần hơn để đi ít)
            const fromLeft = targetX < CANVAS_W / 2;
            const enterX = fromLeft ? -CANVAS_W * 0.13 : CANVAS_W * 1.13;
            const exitX = enterX;   // exit về lại nơi đến
            const groundY = CANVAS_H * 0.91;
            const osinScale = Math.max(0.3, Math.min(3, config.actorScales?.osin ?? 1));
            const personW = 12 * osinScale, personH = 16 * osinScale;
            wrap.style.position = 'absolute';
            wrap.style.width = personW + '%';
            wrap.style.height = personH + '%';
            wrap.style.left = (enterX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)' + (fromLeft ? '' : ' scaleX(-1)');
            wrap.style.transition = 'left 0.6s linear, top 0.5s cubic-bezier(.25,.1,.25,1)';
            wrap.classList.add('osin-walking');
            await wait(80);

            const jarCenterX = r.x + r.w / 2;
            const jarMouthY = r.y + r.h * SHAPE.neckTopY + 30;
            const jumpApexY = jarMouthY - 40;
            const handSlot = wrap.querySelector('.osin-hand');

            // ===== Phase 1: đi TỚI ÔM SÁT quà (target X chính xác) =====
            // OSIN đứng cạnh quà — visual "ôm sát" như tên trộm. Personal width ~6.5% nên
            // body center cách quà ~3% canvas (rất gần, gần như chạm).
            const approachX = targetX + (fromLeft ? -CANVAS_W * 0.03 : CANVAS_W * 0.03);
            wrap.style.transition = 'left 0.9s linear, top 0.5s cubic-bezier(.25,.1,.25,1)';
            wrap.style.left = (approachX / CANVAS_W * 100) + '%';
            wrap.style.top = (Math.max(targetY, groundY * 0.85) / CANVAS_H * 100) + '%';   // có thể cúi xuống nếu quà thấp
            await wait(920);

            // ===== Phase 2: cúi xuống NHẶT quà =====
            wrap.classList.remove('osin-walking');
            wrap.classList.add('osin-carrying');
            const gm = pickupBody?.gm;
            if (handSlot && gm?.img) {
                handSlot.innerHTML = `<img src="${escAttr(gm.img.src)}" style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4))"/>`;
            }
            // Remove body physics (chỉ App authoritative thực sự remove — OBS có thể bỏ qua nếu không match)
            if (pickupBody) {
                const idx = bodies.indexOf(pickupBody);
                if (idx >= 0) {
                    bodies.splice(idx, 1);
                    Composite.remove(engine.world, pickupBody);
                    updateCountDisplay();
                    onCountChange(bodies.length);
                    if (config.features.audio) audio.plop();
                }
            }
            // Vợt nhanh (scale up nhỏ để có cảm giác "chộp")
            wrap.style.transition = 'transform 0.18s ease';
            wrap.style.transform = 'translate(-50%, -100%) scale(1.08)' + (fromLeft ? '' : ' scaleX(-1)');
            await wait(180);
            wrap.style.transform = 'translate(-50%, -100%)' + (fromLeft ? '' : ' scaleX(-1)');
            await wait(120);

            // ===== Phase 3: đi tới chân hũ =====
            wrap.classList.add('osin-walking');
            wrap.style.transition = 'left 0.6s linear, top 0.5s ease-out';
            wrap.style.left = (jarCenterX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            // Hướng mặt theo hướng đi tới hũ
            const facingRightToJar = jarCenterX > approachX;
            wrap.style.transform = 'translate(-50%, -100%)' + (facingRightToJar ? '' : ' scaleX(-1)');
            await wait(620);

            // ===== Phase 4: NHẢY lên miệng hũ =====
            wrap.classList.remove('osin-walking');
            wrap.classList.add('osin-jumping');
            wrap.style.transition = 'top 0.45s cubic-bezier(.2,1.3,.4,1)';
            wrap.style.top = (jumpApexY / CANVAS_H * 100) + '%';
            await wait(460);

            // ===== Phase 5: THẢ quà vào miệng hũ =====
            if (pickupBody && gm) {
                const respawnX = jarCenterX + (Math.random() - 0.5) * r.w * 0.3;
                const respawnY = r.y + r.h * SHAPE.neckTopY + 50;
                const newBody = Bodies.circle(respawnX, respawnY, gm.sz / 2, {
                    restitution: config.physics.bounce,
                    friction: config.physics.friction,
                    density: 0.002
                });
                newBody.gm = gm;
                Body.setVelocity(newBody, { x: 0, y: 4 });
                Composite.add(engine.world, newBody);
                bodies.push(newBody);
                updateCountDisplay();
                onCountChange(bodies.length);
                if (config.features.audio) audio.plop();
            }
            if (handSlot) handSlot.innerHTML = '';
            await wait(140);

            // ===== Phase 6: nhảy XUỐNG sàn =====
            wrap.classList.remove('osin-jumping');
            wrap.classList.add('osin-walking');
            wrap.style.transition = 'top 0.42s cubic-bezier(.4,0,.6,1.1)';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            await wait(420);

            // ===== Phase 7: đi ra khỏi màn hình về phía vào =====
            wrap.style.transition = 'left 0.9s ease-in';
            wrap.style.left = (exitX / CANVAS_W * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)' + (fromLeft ? ' scaleX(-1)' : '');
            await wait(920);
            wrap.remove();
            osinBusy = false;

            // Toast cảm ơn
            const thankName = (name || '').trim() || 'Khách';
            showComboToast(
                `🧹 <b>Cảm ơn OSIN ${escHtml(thankName)}</b> đã giúp tôi nhặt quà về hũ!`,
                'linear-gradient(135deg, #10b981, #14b8a6)'
            );
        }

        // ===== 😡 OSIN GIẬN — đá hũ bay lên không + nứt + vỡ + quà rơi =====
        // Flow: OSIN từ trái → đi qua hũ về phải → quay lại nhìn hũ → KICK!
        //   → hũ bay parabolic tới điểm cao giữa canvas → nứt giữa đường
        //   → tới target thì shatterJar() → quà rơi → OSIN bỏ đi
        let kickJarBusy = false;
        async function fxKickJar(opts = {}) {
            if (kickJarBusy || jarStolen) return;
            if (!thiefLayer) return;
            kickJarBusy = true;

            const r = jarRect();
            // OSIN groundY — đặt ngang với đáy hũ (cảm giác đứng cạnh hũ chứ không xa)
            // Trước: 0.91 (sát đáy canvas, OSIN quá thấp so với hũ)
            const groundY = Math.max(CANVAS_H * 0.78, r.y + r.h * 0.92);
            const { name } = opts;

            // ===== 1. Spawn OSIN từ trái =====
            const wrap = buildOsinNode({ name: name ? '😡 ' + name : '😡 OSIN giận' });
            thiefLayer.appendChild(wrap);
            const personW = 12, personH = 16;
            wrap.style.position = 'absolute';
            wrap.style.width = personW + '%';
            wrap.style.height = personH + '%';
            const startX = -CANVAS_W * 0.13;
            wrap.style.left = (startX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)';   // không scaleX vì đi từ trái sang phải
            wrap.style.transition = 'left 1.4s linear, top 0.5s ease, transform 0.3s ease';
            wrap.classList.add('osin-walking');
            await wait(80);

            // ===== 2. Đi từ trái sang phải, qua hũ =====
            const rightOfJarX = r.x + r.w + CANVAS_W * 0.06;
            wrap.style.left = (rightOfJarX / CANVAS_W * 100) + '%';
            await wait(1420);

            // ===== 3. Quay sang trái (mặt hướng về hũ) =====
            wrap.style.transition = 'transform 0.3s ease';
            wrap.style.transform = 'translate(-50%, -100%) scaleX(-1)';   // flip ngang
            wrap.classList.remove('osin-walking');
            await wait(320);

            // ===== 4. Wind-up: cúi xuống tích lực (osin-jumping class) =====
            wrap.classList.add('osin-jumping');
            await wait(280);

            // ===== 5. KICK! Body nghiêng + nhảy về phía hũ một chút =====
            wrap.style.transition = 'transform 0.2s cubic-bezier(.5,1.5,.5,1)';
            wrap.style.transform = 'translate(-50%, -100%) scaleX(-1) rotate(-15deg)';
            if (config.features.audio) audio.steal();
            await wait(220);

            // ===== 6. Hũ bay parabolic tới target (45% X, 37% Y) =====
            // GIỮ jar walls + bodies INSIDE jar cùng bay → quà ngoài hũ (đã rớt) giữ nguyên.
            // Khi tới target mới shatterJarAt → walls remove + bodies inside scatter ra ngoài.

            // Snapshot bodies INSIDE jar (trước khi bay) — chỉ những bodies này được dịch chuyển
            const jarBottomYThresh = r.y + r.h * 0.95;
            const insideBodies = bodies.filter(b => {
                const p = b.position;
                const insideX = p.x >= r.x - 30 && p.x <= r.x + r.w + 30;
                const insideY = p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= jarBottomYThresh + 40;
                return insideX && insideY;
            });

            const targetCx = CANVAS_W * 0.45;
            const targetCy = CANVAS_H * 0.37;
            const newJarX = r.x + (targetCx - r.cx);
            const newJarY = r.y + (targetCy - r.cy);

            // Save original styles + tắt CSS transition trên jar elements (mình tween bằng JS)
            const jbStyle = jarBottomEl ? jarBottomEl.style.cssText : '';
            const jgStyle = jarGlassEl ? jarGlassEl.style.cssText : '';
            const accStyle = _accessoryEl ? _accessoryEl.style.cssText : '';
            const hangerStyle = topHangersEl ? topHangersEl.style.cssText : '';
            if (jarBottomEl) jarBottomEl.style.transition = 'none';
            if (jarGlassEl)  jarGlassEl.style.transition  = 'none';
            if (_accessoryEl) _accessoryEl.style.transition = 'none';
            if (topHangersEl) topHangersEl.style.transition = 'none';

            // Pause physics — bodies + walls không bị gravity affect trong flight,
            // chỉ di chuyển bởi setPosition theo tween.
            const savedTimeScale = engine.timing.timeScale;
            engine.timing.timeScale = 0;

            const flyDur = 1100;
            let lastCx = r.cx, lastCy = r.cy;
            await tween(t => {
                // X: easeOut. Y: linear + parabolic peak (15% canvas height above midpoint)
                const easeX = 1 - Math.pow(1 - t, 2);
                const newCx = r.cx + (targetCx - r.cx) * easeX;
                const yLinear = r.cy + (targetCy - r.cy) * t;
                const peakDepth = CANVAS_H * 0.18;
                const newCy = yLinear - peakDepth * Math.sin(t * Math.PI);
                const dx = newCx - lastCx;
                const dy = newCy - lastCy;

                // Move jar walls (physics)
                for (const w of jarWalls) {
                    try { Body.setPosition(w, { x: w.position.x + dx, y: w.position.y + dy }); } catch (e) {}
                }
                // CHỈ move bodies INSIDE jar — bodies ngoài (escaped) giữ nguyên vị trí
                for (const b of insideBodies) {
                    Body.setPosition(b, { x: b.position.x + dx, y: b.position.y + dy });
                    Body.setVelocity(b, { x: 0, y: 0 });
                }

                // Visual jar
                const angle = t * 35;
                const newX = newCx - r.w / 2;
                const newY = newCy - r.h / 2;
                if (jarBottomEl) {
                    jarBottomEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarBottomEl.style.top  = (newY / CANVAS_H * 100) + '%';
                    jarBottomEl.style.transform = `rotate(${angle}deg)`;
                }
                if (jarGlassEl) {
                    jarGlassEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarGlassEl.style.top  = (newY / CANVAS_H * 100) + '%';
                    jarGlassEl.style.transform = `rotate(${angle}deg)`;
                }
                if (_accessoryEl) {
                    const accW = r.w * 0.8;
                    const accH = accW * 0.5;
                    const accX = newCx - accW / 2;
                    const accY = newY + r.h * SHAPE.neckTopY - accH * 0.8;
                    _accessoryEl.style.left = (accX / CANVAS_W * 100) + '%';
                    _accessoryEl.style.top  = (accY / CANVAS_H * 100) + '%';
                    _accessoryEl.style.transform = `rotate(${angle}deg)`;
                }
                moveTopHangersWithJar(newX, newY, angle, r);

                // Crack overlay khi t ~ 0.55 (giữa đường, lần đầu chạm)
                if (t > 0.55 && !wrap.__crackedOnce) {
                    wrap.__crackedOnce = true;
                    if (overlayLayer && !jarStolen) {
                        const crackEl = document.createElement('div');
                        crackEl.className = 'tt-crack show';
                        crackEl.style.position = 'absolute';
                        crackEl.style.left = (newX / CANVAS_W * 100) + '%';
                        crackEl.style.top  = (newY / CANVAS_H * 100) + '%';
                        crackEl.style.width  = (r.w / CANVAS_W * 100) + '%';
                        crackEl.style.height = (r.h / CANVAS_H * 100) + '%';
                        crackEl.style.transform = `rotate(${angle}deg)`;
                        crackEl.innerHTML = generateCrackSvg(8);
                        overlayLayer.appendChild(crackEl);
                        crackElements.push(crackEl);
                        if (config.features.audio) audio.steal();
                    }
                }

                lastCx = newCx;
                lastCy = newCy;
            }, flyDur);

            // ===== 7. OSIN reset pose, walk back trái (sau khi đá xong) =====
            wrap.style.transition = 'transform 0.4s ease';
            wrap.style.transform = 'translate(-50%, -100%) scaleX(-1)';
            setTimeout(() => {
                wrap.classList.remove('osin-jumping');
                wrap.classList.add('osin-walking');
                wrap.style.transition = 'left 1.3s linear, transform 0.3s ease';
                wrap.style.transform = 'translate(-50%, -100%)';
                wrap.style.left = ((CANVAS_W + CANVAS_W * 0.18) / CANVAS_W * 100) + '%';
            }, 100);

            // ===== 8. Tại target → SHATTER (chỉ scatter bodies inside jar) =====
            engine.timing.timeScale = savedTimeScale;
            shatterJarAt(targetCx, targetCy, insideBodies);

            // ===== 10. Chờ 3s rồi respawn jar tại vị trí gốc =====
            setTimeout(() => {
                // EXPLICIT clear transform trước khi restore — fix bug jar bị nghiêng
                if (jarBottomEl) {
                    jarBottomEl.style.transform = '';
                    jarBottomEl.style.cssText = jbStyle;
                    jarBottomEl.style.transform = '';   // safety: clear lại sau cssText
                }
                if (jarGlassEl) {
                    jarGlassEl.style.transform = '';
                    jarGlassEl.style.cssText = jgStyle;
                    jarGlassEl.style.transform = '';
                }
                if (_accessoryEl) {
                    _accessoryEl.style.transform = '';
                    _accessoryEl.style.cssText = accStyle;
                    _accessoryEl.style.transform = '';
                }
                if (topHangersEl) {
                    topHangersEl.style.transform = '';
                    topHangersEl.style.cssText = hangerStyle;
                    topHangersEl.style.transform = '';
                }
                positionJar();
                positionAccessory();
                updateTopHangers();
            }, 3200);

            // OSIN remove after walks off
            setTimeout(() => wrap.remove(), 2400);
            kickJarBusy = false;
        }
        // ===== 🥾 OSIN ĐÁ TUNG QUÀ — kick jar in place (no throw), 1-3 gifts fly out =====
        // OSIN đi từ trái → đá vào hũ một phát mạnh → hũ rung + nứt nhẹ → 1-3 quà văng ra
        // (ưu tiên quà lớn). Jar Ở YÊN tại chỗ, KHÔNG bị bay đi như fxKickJar.
        let osinKickOutBusy = false;
        async function fxOsinKickOut(opts = {}) {
            if (osinKickOutBusy || kickJarBusy || throwJarBusy || spinJarBusy || jarStolen) return;
            if (!thiefLayer) return;
            osinKickOutBusy = true;

            const r = jarRect();
            const groundY = Math.max(CANVAS_H * 0.78, r.y + r.h * 0.92);
            const { name } = opts;

            // 1. Spawn OSIN từ trái + đi tới mép trái hũ
            const wrap = buildOsinNode({ name: name ? '🥾 ' + name : '🥾 OSIN đá tung quà' });
            thiefLayer.appendChild(wrap);
            const personW = 12, personH = 16;
            wrap.style.position = 'absolute';
            wrap.style.width = personW + '%';
            wrap.style.height = personH + '%';
            const startX = -CANVAS_W * 0.13;
            wrap.style.left = (startX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)';
            wrap.style.transition = 'left 1.3s linear, top 0.5s ease, transform 0.3s ease';
            wrap.classList.add('osin-walking');
            await wait(80);

            // 2. Đi tới sát mép trái hũ (cách hũ ~5% W)
            const kickPosX = Math.max(r.x - CANVAS_W * 0.05, CANVAS_W * 0.04);
            wrap.style.left = (kickPosX / CANVAS_W * 100) + '%';
            await wait(1280);

            // 3. Wind-up
            wrap.classList.remove('osin-walking');
            wrap.classList.add('osin-jumping');
            await wait(260);

            // 4. KICK! Body nghiêng + nhảy về phía hũ
            wrap.style.transition = 'transform 0.18s cubic-bezier(.5,1.5,.5,1)';
            wrap.style.transform = 'translate(-50%, -100%) rotate(18deg)';
            if (config.features?.audio !== false) { try { audio.big(); } catch (e) {} }
            await wait(160);

            // 5. IMPACT — jar rung mạnh (CSS shake), crack nhẹ overlay, 1-3 quà văng ra
            const jbBase = jarBottomEl ? (jarBottomEl.style.transform || '') : '';
            const jgBase = jarGlassEl ? (jarGlassEl.style.transform || '') : '';
            const shakeStart = Date.now();
            const shakeDur = 700;
            const shakeAmp = 10;
            const shakeId = setInterval(() => {
                const elapsed = Date.now() - shakeStart;
                if (elapsed >= shakeDur) {
                    clearInterval(shakeId);
                    if (jarBottomEl) jarBottomEl.style.transform = jbBase;
                    if (jarGlassEl)  jarGlassEl.style.transform  = jgBase;
                    return;
                }
                const decay = 1 - elapsed / shakeDur;
                const dx = (Math.random() - 0.5) * shakeAmp * 2 * decay;
                const dy = (Math.random() - 0.5) * shakeAmp * 1 * decay;
                const rot = (Math.random() - 0.5) * 3 * decay;
                const t = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`;
                if (jarBottomEl) jarBottomEl.style.transform = t;
                if (jarGlassEl)  jarGlassEl.style.transform  = t;
            }, 40);

            // Nứt NHẸ (4 đường thay vì 8 như fxCrackJar)
            if (overlayLayer && !jarStolen) {
                const crackEl = document.createElement('div');
                crackEl.className = 'tt-crack show';
                crackEl.style.position = 'absolute';
                crackEl.style.left = (r.x / CANVAS_W * 100) + '%';
                crackEl.style.top  = (r.y / CANVAS_H * 100) + '%';
                crackEl.style.width  = (r.w / CANVAS_W * 100) + '%';
                crackEl.style.height = (r.h / CANVAS_H * 100) + '%';
                crackEl.innerHTML = generateCrackSvg(4);
                overlayLayer.appendChild(crackEl);
                crackElements.push(crackEl);
                // Tự fade sau 2.8s (crack nhẹ → hết nhanh để không persistent)
                setTimeout(() => {
                    crackEl.style.transition = 'opacity 1.2s ease';
                    crackEl.style.opacity = '0';
                    setTimeout(() => {
                        crackEl.remove();
                        const i = crackElements.indexOf(crackEl);
                        if (i >= 0) crackElements.splice(i, 1);
                    }, 1300);
                }, 2800);
            }

            // 6. Pick 1-3 quà từ bodies INSIDE jar, ƯU TIÊN quà lớn (sz desc)
            const insideBodies = bodies.filter(b => {
                const p = b.position;
                const insideX = p.x >= r.x - 20 && p.x <= r.x + r.w + 20;
                const insideY = p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= r.y + r.h * 0.96;
                return insideX && insideY;
            });
            // Weighted pick: sort by sz desc → bias top 60% list
            insideBodies.sort((a, b) => (b.gm?.sz || 40) - (a.gm?.sz || 40));
            const launchCount = Math.min(insideBodies.length, 1 + Math.floor(Math.random() * 3));
            const biasPoolSize = Math.max(launchCount, Math.ceil(insideBodies.length * 0.6));
            const pool = insideBodies.slice(0, biasPoolSize);
            const picked = [];
            for (let i = 0; i < launchCount && pool.length; i++) {
                const idx = Math.floor(Math.random() * pool.length);
                picked.push(pool.splice(idx, 1)[0]);
            }

            // 7. Launch — TELEPORT body lên TRÊN miệng hũ + burst upward → rơi tự nhiên ngoài hũ.
            // Cách này tự nhiên hơn "đá xuyên wall": quà như bị tung qua miệng hũ rồi gravity kéo
            // xuống ngoài. Không cần disable collision.
            const neckMidX = r.x + r.w * (SHAPE.neckLeftX + SHAPE.neckRightX) / 2;
            const neckMouthY = r.y + r.h * SHAPE.neckTopY;
            picked.forEach((b, i) => {
                // Tách nhau ngang miệng + nâng cao ngẫu nhiên
                const offsetX = (i - (picked.length - 1) / 2) * 18 + (Math.random() - 0.5) * 12;
                const popX = neckMidX + offsetX;
                const popY = neckMouthY - 25 - Math.random() * 20;
                // Vận tốc: ra ngoài (trái hoặc phải) + tung lên thêm 1 chút, gravity sẽ lo phần rơi
                const sideDir = Math.random() < 0.5 ? -1 : 1;   // bay ra 2 bên ngẫu nhiên
                const vx = sideDir * (8 + Math.random() * 6);
                const vy = -(6 + Math.random() * 4);
                try {
                    Body.setPosition(b, { x: popX, y: popY });
                    Body.setVelocity(b, { x: vx, y: vy });
                    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.5);
                } catch (e) {}
            });

            // 8. OSIN reset pose + walk away (về trái)
            setTimeout(() => {
                wrap.classList.remove('osin-jumping');
                wrap.classList.add('osin-walking');
                wrap.style.transition = 'left 1.2s linear, transform 0.3s ease';
                wrap.style.transform = 'translate(-50%, -100%) scaleX(-1)';   // quay lưng
                wrap.style.left = (startX / CANVAS_W * 100) + '%';
            }, 320);
            setTimeout(() => wrap.remove(), 2200);

            osinKickOutBusy = false;
        }

        // ===== 🐉 RỒNG PHUN LỬA — webm dragon overlay + jar progressive heat→crack→explode =====
        // Timeline 5s (đồng bộ với dragon.webm 5s):
        //   0.0-2.0s: jar tint đỏ lửa (sepia + saturate + hue-rotate gradual)
        //   2.0-3.0s: giữ đỏ + rung nhẹ
        //   3.0s: spawn crack 1 (4 đường)
        //   4.0s: spawn crack 2 (8 đường) — tích luỹ
        //   5.0s: NỔ TUNG — shatter, văng quà ra, megaboom
        //   5.5s: cleanup video + restore jar visuals (jar tự rebuild qua shatterJar)
        let dragonFireBusy = false;
        async function fxDragonFire(opts = {}) {
            if (dragonFireBusy || jarStolen) return;
            if (!overlayLayer) return;
            dragonFireBusy = true;

            const r = jarRect();
            const { name } = opts;

            // 1. Spawn webm overlay — FULL CANVAS 1080x1920.
            // STANDARD cho mọi webm effect: full canvas → creator designe action ngay trong webm,
            // không cần code căn vị trí. Hũ ở vị trí cố định trong canvas (theo jarRect).
            // Tip cho người làm webm: render 1080x1920, đặt hũ giả ở vị trí thật (~center, cy~50%),
            // action overlap hũ tại đúng toạ độ đó.
            const video = document.createElement('video');
            video.src = '/assets/jar-fx-webm/dragon.webm';
            video.autoplay = true;
            video.playsInline = true;
            video.loop = false;
            video.className = 'tt-dragon-fx';
            // Audio: tôn trọng features.audio (OFF → mute). Volume từ config.webmFxVolume (0-100, default 80).
            const audioOn = config.features?.audio !== false;
            const webmVol = Math.max(0, Math.min(100, parseInt(config.webmFxVolume, 10))) || 80;
            if (audioOn) {
                video.muted = false;
                video.volume = webmVol / 100;
            } else {
                video.muted = true;
                video.volume = 0;
            }
            video.style.cssText = `
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                pointer-events: none;
                z-index: 50;
            `;
            overlayLayer.appendChild(video);
            try {
                await video.play();
            } catch (e) {
                // Browser block autoplay-with-audio (vd tab background, chưa user-interact).
                // Fallback: mute + replay → ít nhất hình vẫn chạy. OBS/foreground sẽ có audio.
                video.muted = true;
                video.volume = 0;
                try { await video.play(); } catch (e2) {}
            }

            // 2. Red glow halo behind jar (radial gradient orange→red fade)
            const halo = document.createElement('div');
            halo.style.cssText = `
                position: absolute;
                left: ${((r.cx - r.w * 0.9) / CANVAS_W * 100).toFixed(2)}%;
                top: ${((r.cy - r.h * 0.6) / CANVAS_H * 100).toFixed(2)}%;
                width: ${(r.w * 1.8 / CANVAS_W * 100).toFixed(2)}%;
                height: ${(r.h * 1.2 / CANVAS_H * 100).toFixed(2)}%;
                background: radial-gradient(ellipse, rgba(255,80,0,0.55) 0%, rgba(220,30,0,0.30) 40%, transparent 75%);
                pointer-events: none;
                z-index: 30;
                opacity: 0;
                transition: opacity 1.4s ease-out;
                filter: blur(8px);
            `;
            overlayLayer.appendChild(halo);
            requestAnimationFrame(() => { halo.style.opacity = '1'; });

            // 3. Phase A (0-2s) — tint hũ đỏ dần qua CSS filter
            const jbBaseF = jarBottomEl ? (jarBottomEl.style.filter || '') : '';
            const jgBaseF = jarGlassEl ? (jarGlassEl.style.filter || '') : '';
            const jbBaseTr = jarBottomEl ? (jarBottomEl.style.transition || '') : '';
            const jgBaseTr = jarGlassEl ? (jarGlassEl.style.transition || '') : '';
            if (jarBottomEl) jarBottomEl.style.transition = 'filter 2s ease-out';
            if (jarGlassEl)  jarGlassEl.style.transition  = 'filter 2s ease-out';
            // Apply red-hot filter (target state after 2s)
            const hotFilter = 'sepia(0.85) saturate(3.5) hue-rotate(-15deg) brightness(1.35) drop-shadow(0 0 24px rgba(255,80,0,0.7))';
            requestAnimationFrame(() => {
                if (jarBottomEl) jarBottomEl.style.filter = hotFilter;
                if (jarGlassEl)  jarGlassEl.style.filter  = hotFilter;
            });

            if (config.features.audio !== false) { try { audio.tornado && audio.tornado(); } catch (e) {} }

            // 4. Phase B (2-3s) — rung nhẹ jar (báo hiệu sắp vỡ)
            setTimeout(() => {
                const shakeStart = Date.now();
                const shakeDur = 900;
                const shakeAmp = 5;
                const shakeId = setInterval(() => {
                    const el = Date.now() - shakeStart;
                    if (el >= shakeDur) { clearInterval(shakeId); return; }
                    const decay = 1 - el / shakeDur * 0.4;   // giảm yếu cuối phase
                    const dx = (Math.random() - 0.5) * shakeAmp * 2 * decay;
                    const dy = (Math.random() - 0.5) * shakeAmp * decay;
                    if (jarBottomEl) jarBottomEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
                    if (jarGlassEl)  jarGlassEl.style.transform  = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
                }, 35);
            }, 2000);

            // 5. Phase C (3s) — crack 1 (4 đường)
            const dragonCracks = [];
            const spawnCrack = (numLines) => {
                if (!overlayLayer || jarStolen) return;
                const cr = jarRect();
                const el = document.createElement('div');
                el.className = 'tt-crack show';
                el.style.cssText = `position:absolute;left:${(cr.x/CANVAS_W*100)}%;top:${(cr.y/CANVAS_H*100)}%;width:${(cr.w/CANVAS_W*100)}%;height:${(cr.h/CANVAS_H*100)}%;z-index:40;`;
                el.innerHTML = generateCrackSvg(numLines);
                overlayLayer.appendChild(el);
                crackElements.push(el);
                dragonCracks.push(el);
                if (config.features.audio !== false) { try { audio.steal && audio.steal(); } catch (e) {} }
            };
            setTimeout(() => spawnCrack(4), 3000);
            setTimeout(() => spawnCrack(8), 4000);

            // 6. Phase D (5s) — NỔ TUNG hũ, văng quà ra
            setTimeout(() => {
                // Reset transform shake
                if (jarBottomEl) jarBottomEl.style.transform = '';
                if (jarGlassEl)  jarGlassEl.style.transform  = '';
                // Flash white + megaboom
                if (jarBottomEl) jarBottomEl.style.filter = 'brightness(3) saturate(2)';
                if (jarGlassEl)  jarGlassEl.style.filter  = 'brightness(3) saturate(2)';
                if (config.features.audio !== false) { try { audio.big && audio.big(); audio.fanfare && audio.fanfare(); } catch (e) {} }
                // Megaboom particles
                fxAnimations.push({ type: 'megaboom', x: r.cx, y: r.cy, age: 0, life: 60 });
                // Văng tất cả bodies trong jar ra ngoài (tương tự shatterJar nhưng nhẹ hơn — KHÔNG removeJarWalls vì sẽ tự reset)
                const insideBodies = bodies.filter(b => {
                    const p = b.position;
                    return p.x >= r.x - 30 && p.x <= r.x + r.w + 30 && p.y >= r.y && p.y <= r.y + r.h + 40;
                });
                // Disable jar walls tạm thời để quà bay ra (0.8s)
                removeJarWalls();
                insideBodies.forEach(b => {
                    const dx = b.position.x - r.cx;
                    const dist = Math.max(Math.abs(dx), 1);
                    try {
                        Body.setVelocity(b, {
                            x: (dx / dist) * (10 + Math.random() * 14) + (Math.random() - 0.5) * 6,
                            y: -(8 + Math.random() * 8)
                        });
                        Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.7);
                    } catch (e) {}
                });
            }, 5000);

            // 7. Cleanup ở 5.5s — fade video + halo, restore jar filter, rebuild walls
            const finishCleanup = () => {
                // Fade video + halo
                video.style.transition = 'opacity 0.4s ease';
                video.style.opacity = '0';
                halo.style.opacity = '0';
                setTimeout(() => { video.remove(); halo.remove(); }, 500);
                // Restore jar visuals
                if (jarBottomEl) {
                    jarBottomEl.style.transition = 'filter 0.6s ease, opacity 0.6s ease';
                    jarBottomEl.style.filter = jbBaseF;
                }
                if (jarGlassEl) {
                    jarGlassEl.style.transition = 'filter 0.6s ease, opacity 0.6s ease';
                    jarGlassEl.style.filter = jgBaseF;
                }
                // Rebuild walls
                buildJarWalls();
                // Restore transitions sau khi xong
                setTimeout(() => {
                    if (jarBottomEl) jarBottomEl.style.transition = jbBaseTr;
                    if (jarGlassEl)  jarGlassEl.style.transition  = jgBaseTr;
                }, 800);
                // Fade cracks
                setTimeout(() => {
                    dragonCracks.forEach(el => {
                        el.style.transition = 'opacity 1s ease';
                        el.style.opacity = '0';
                        setTimeout(() => {
                            el.remove();
                            const i = crackElements.indexOf(el);
                            if (i >= 0) crackElements.splice(i, 1);
                        }, 1100);
                    });
                }, 1500);
                dragonFireBusy = false;
            };
            video.onended = finishCleanup;
            // Safety: nếu video không onended (lỗi load) → cleanup ở 5.6s
            setTimeout(() => { if (dragonFireBusy) finishCleanup(); }, 5600);
        }

        // ===== 💪 OSIN KÉO + NÉM hũ — drag to middle then throw up =====
        // Flow: OSIN tới hũ → grab → kéo về giữa canvas → wind-up → NÉM lên cao
        //   → hũ bay parabolic UP tới target → crack mid-air → shatter ở target → quà rơi
        let throwJarBusy = false;
        async function fxThrowJar(opts = {}) {
            if (throwJarBusy || kickJarBusy || jarStolen) return;
            if (!thiefLayer) return;
            throwJarBusy = true;

            const r = jarRect();
            const groundY = Math.max(CANVAS_H * 0.78, r.y + r.h * 0.92);
            const { name } = opts;

            // 1. Spawn OSIN từ trái
            const wrap = buildOsinNode({ name: name ? '💪 ' + name : '💪 OSIN ném hũ' });
            thiefLayer.appendChild(wrap);
            const personW = 12, personH = 16;
            wrap.style.position = 'absolute';
            wrap.style.width = personW + '%';
            wrap.style.height = personH + '%';
            const startX = -CANVAS_W * 0.13;
            wrap.style.left = (startX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)';
            wrap.style.transition = 'left 1.2s linear, top 0.4s ease, transform 0.3s ease';
            wrap.classList.add('osin-walking');
            await wait(80);

            // 2. Đi tới CẠNH PHẢI hũ
            const rightOfJarX = r.x + r.w + CANVAS_W * 0.04;
            wrap.style.left = (rightOfJarX / CANVAS_W * 100) + '%';
            await wait(1220);

            // 3. Quay sang trái + bend down (grab pose)
            wrap.style.transition = 'transform 0.3s ease';
            wrap.style.transform = 'translate(-50%, -100%) scaleX(-1)';
            wrap.classList.remove('osin-walking');
            wrap.classList.add('osin-carrying');
            await wait(380);

            // 4. KÉO HŨ về giữa canvas — OSIN walk leftward, jar follows
            const middleCx = CANVAS_W * 0.5;
            const middleCy = groundY - r.h * 0.45;   // hũ ở ground level, center y = groundY - half jar height
            const dragDur = 1300;

            // Snapshot bodies INSIDE jar (trước khi kéo) — chỉ những bodies này được dịch
            // chuyển. Bodies ngoài hũ (escaped) giữ nguyên vị trí.
            const jarBottomYThresh = r.y + r.h * 0.95;
            const insideBodies = bodies.filter(b => {
                const p = b.position;
                const insideX = p.x >= r.x - 30 && p.x <= r.x + r.w + 30;
                const insideY = p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= jarBottomYThresh + 40;
                return insideX && insideY;
            });

            // Pause physics + sync jar walls + bodies during drag
            const savedTimeScale = engine.timing.timeScale;
            engine.timing.timeScale = 0;
            if (jarBottomEl) jarBottomEl.style.transition = 'none';
            if (jarGlassEl)  jarGlassEl.style.transition  = 'none';
            if (_accessoryEl) _accessoryEl.style.transition = 'none';
            if (topHangersEl) topHangersEl.style.transition = 'none';
            const jbStyle = jarBottomEl ? jarBottomEl.style.cssText : '';
            const jgStyle = jarGlassEl ? jarGlassEl.style.cssText : '';
            const accStyle = _accessoryEl ? _accessoryEl.style.cssText : '';
            const hangerStyle = topHangersEl ? topHangersEl.style.cssText : '';

            // OSIN walks left to middle (dragging)
            const osinDragX = middleCx + r.w * 0.55;   // OSIN stand slightly right of jar
            wrap.style.transition = `left ${dragDur}ms linear`;
            wrap.style.left = (osinDragX / CANVAS_W * 100) + '%';

            let lastCx = r.cx, lastCy = r.cy;
            await tween(t => {
                const newCx = r.cx + (middleCx - r.cx) * t;
                const newCy = r.cy + (middleCy - r.cy) * t;
                const dx = newCx - lastCx;
                const dy = newCy - lastCy;
                for (const w of jarWalls) {
                    try { Body.setPosition(w, { x: w.position.x + dx, y: w.position.y + dy }); } catch (e) {}
                }
                for (const b of insideBodies) {
                    Body.setPosition(b, { x: b.position.x + dx, y: b.position.y + dy });
                    Body.setVelocity(b, { x: 0, y: 0 });
                }
                const newX = newCx - r.w / 2;
                const newY = newCy - r.h / 2;
                if (jarBottomEl) {
                    jarBottomEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarBottomEl.style.top  = (newY / CANVAS_H * 100) + '%';
                }
                if (jarGlassEl) {
                    jarGlassEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarGlassEl.style.top  = (newY / CANVAS_H * 100) + '%';
                }
                if (_accessoryEl) {
                    const accW = r.w * 0.8;
                    const accH = accW * 0.5;
                    _accessoryEl.style.left = ((newCx - accW/2) / CANVAS_W * 100) + '%';
                    _accessoryEl.style.top  = ((newY + r.h * SHAPE.neckTopY - accH * 0.8) / CANVAS_H * 100) + '%';
                }
                moveTopHangersWithJar(newX, newY, 0, r);
                lastCx = newCx;
                lastCy = newCy;
            }, dragDur);

            // 5. Wind-up: OSIN bend down further + tilt body
            wrap.classList.remove('osin-carrying');
            wrap.classList.add('osin-jumping');
            wrap.style.transition = 'transform 0.25s cubic-bezier(.5,1.5,.5,1)';
            wrap.style.transform = 'translate(-50%, -100%) scaleX(-1) rotate(15deg)';
            if (config.features.audio) audio.steal();
            await wait(280);

            // 6. THROW! Jar parabolic UP tới target (red rectangle area)
            const targetCx = CANVAS_W * 0.5;   // chính giữa X
            const targetCy = CANVAS_H * 0.25;  // upper area (red rect)
            const throwDur = 850;

            await tween(t => {
                // X: linear from middleCx to targetCx
                const newCx = middleCx + (targetCx - middleCx) * t;
                // Y: parabolic — bay vọt LÊN cao rồi xuống tại target
                // Cong cao hơn: peakDepth lớn
                const yLinear = middleCy + (targetCy - middleCy) * t;
                const peakDepth = CANVAS_H * 0.12;   // peak 12% ABOVE midpoint của arc
                const newCy = yLinear - peakDepth * Math.sin(t * Math.PI);
                const dx = newCx - lastCx;
                const dy = newCy - lastCy;
                for (const w of jarWalls) {
                    try { Body.setPosition(w, { x: w.position.x + dx, y: w.position.y + dy }); } catch (e) {}
                }
                for (const b of insideBodies) {
                    Body.setPosition(b, { x: b.position.x + dx, y: b.position.y + dy });
                    Body.setVelocity(b, { x: 0, y: 0 });
                }

                const angle = t * 360;   // 1 vòng xoay full → tumble
                const newX = newCx - r.w / 2;
                const newY = newCy - r.h / 2;
                if (jarBottomEl) {
                    jarBottomEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarBottomEl.style.top  = (newY / CANVAS_H * 100) + '%';
                    jarBottomEl.style.transform = `rotate(${angle}deg)`;
                }
                if (jarGlassEl) {
                    jarGlassEl.style.left = (newX / CANVAS_W * 100) + '%';
                    jarGlassEl.style.top  = (newY / CANVAS_H * 100) + '%';
                    jarGlassEl.style.transform = `rotate(${angle}deg)`;
                }
                if (_accessoryEl) {
                    const accW = r.w * 0.8;
                    const accH = accW * 0.5;
                    _accessoryEl.style.left = ((newCx - accW/2) / CANVAS_W * 100) + '%';
                    _accessoryEl.style.top  = ((newY + r.h * SHAPE.neckTopY - accH * 0.8) / CANVAS_H * 100) + '%';
                    _accessoryEl.style.transform = `rotate(${angle}deg)`;
                }
                moveTopHangersWithJar(newX, newY, angle, r);

                // Crack overlay khi t ~ 0.6 (gần tới target)
                if (t > 0.6 && !wrap.__crackedOnceThrow) {
                    wrap.__crackedOnceThrow = true;
                    if (overlayLayer && !jarStolen) {
                        const crackEl = document.createElement('div');
                        crackEl.className = 'tt-crack show';
                        crackEl.style.position = 'absolute';
                        crackEl.style.left = (newX / CANVAS_W * 100) + '%';
                        crackEl.style.top  = (newY / CANVAS_H * 100) + '%';
                        crackEl.style.width  = (r.w / CANVAS_W * 100) + '%';
                        crackEl.style.height = (r.h / CANVAS_H * 100) + '%';
                        crackEl.style.transform = `rotate(${angle}deg)`;
                        crackEl.innerHTML = generateCrackSvg(10);
                        overlayLayer.appendChild(crackEl);
                        crackElements.push(crackEl);
                        if (config.features.audio) audio.steal();
                    }
                }

                lastCx = newCx;
                lastCy = newCy;
            }, throwDur);

            // 7. OSIN reset + walk off left
            wrap.style.transition = 'transform 0.3s ease, left 1.3s linear';
            wrap.style.transform = 'translate(-50%, -100%)';
            wrap.classList.remove('osin-jumping');
            wrap.classList.add('osin-walking');
            wrap.style.left = ((-CANVAS_W * 0.15) / CANVAS_W * 100) + '%';

            // 8. Resume physics + SHATTER ở target (chỉ scatter bodies inside)
            engine.timing.timeScale = savedTimeScale;
            shatterJarAt(targetCx, targetCy, insideBodies);

            // 9. Sau 3s respawn jar — EXPLICIT clear transform (fix bug nghiêng)
            setTimeout(() => {
                if (jarBottomEl) {
                    jarBottomEl.style.transform = '';
                    jarBottomEl.style.cssText = jbStyle;
                    jarBottomEl.style.transform = '';
                }
                if (jarGlassEl) {
                    jarGlassEl.style.transform = '';
                    jarGlassEl.style.cssText = jgStyle;
                    jarGlassEl.style.transform = '';
                }
                if (_accessoryEl) {
                    _accessoryEl.style.transform = '';
                    _accessoryEl.style.cssText = accStyle;
                    _accessoryEl.style.transform = '';
                }
                if (topHangersEl) {
                    topHangersEl.style.transform = '';
                    topHangersEl.style.cssText = hangerStyle;
                    topHangersEl.style.transform = '';
                }
                positionJar();
                positionAccessory();
                updateTopHangers();
            }, 3200);
            setTimeout(() => wrap.remove(), 1400);
            throwJarBusy = false;
        }

        // ===== OSIN xoay hũ — hất hũ lên cao, xoay liên tục, dốc ngược để văng quà =====
        let spinJarBusy = false;
        async function fxSpinJar(opts = {}) {
            if (spinJarBusy || kickJarBusy || throwJarBusy || tiltAnimating || jarStolen) return;
            if (!thiefLayer) return;
            captureGiftHistory('Trước OSIN xoay hũ', true);

            const cfg = config.effects?.spinJar || {};
            const spinSpeed = Math.max(0.5, Math.min(4, cfg.spinSpeed ?? 1.4));
            const holdMs = Math.max(500, Math.min(6000, cfg.holdMs ?? 1800));
            const flyHeight = Math.max(15, Math.min(55, cfg.flyHeight ?? 34));
            const scatterForce = Math.max(0.4, Math.min(3, cfg.scatterForce ?? 1.2));
            const dir = opts.dir || (Math.random() < 0.5 ? -1 : 1);
            opts.dir = dir;

            spinJarBusy = true;
            const r = jarRect();
            const baseRect = { ...r };
            const insideBodies = bodies.filter(b => {
                const p = b.position;
                return p.x >= r.x - 30 && p.x <= r.x + r.w + 30 && p.y >= r.y + r.h * SHAPE.neckTopY && p.y <= r.y + r.h + 80;
            });
            const localBodies = insideBodies.map(b => ({ body: b, x: b.position.x - r.cx, y: b.position.y - r.cy }));

            const wrap = buildOsinNode({ name: opts.name ? '🌀 ' + opts.name : '🌀 OSIN xoay hũ' });
            thiefLayer.appendChild(wrap);
            const personW = 13, personH = 17;
            const groundY = Math.max(CANVAS_H * 0.78, r.y + r.h * 0.92);
            const startX = -CANVAS_W * 0.13;
            const pushX = r.x - CANVAS_W * 0.035;
            wrap.style.position = 'absolute';
            wrap.style.width = personW + '%';
            wrap.style.height = personH + '%';
            wrap.style.left = (startX / CANVAS_W * 100) + '%';
            wrap.style.top = (groundY / CANVAS_H * 100) + '%';
            wrap.style.transform = 'translate(-50%, -100%)';
            wrap.style.transition = 'left 1.05s linear, transform 0.25s ease';
            wrap.classList.add('osin-walking');

            const visualEls = [jarBottomEl, jarGlassEl, countDisplay].filter(Boolean);
            const origStyle = visualEls.map(el => el.style.cssText || '');
            const accStyle = _accessoryEl ? _accessoryEl.style.cssText : '';
            const hangerStyle = topHangersEl ? topHangersEl.style.cssText : '';
            const savedTimeScale = engine.timing.timeScale;
            let lastCx = r.cx;
            let lastCy = r.cy;
            let currentAngle = 0;
            let jarX = r.x;
            let jarY = r.y;
            let pinSpinBodies = true;
            let releasedSpinBodies = false;

            const setJarPose = (cx, cy, angleRad) => {
                const dx = cx - lastCx;
                const dy = cy - lastCy;
                const deltaAngle = angleRad - currentAngle;
                const pivot = { x: cx, y: cy };
                for (const w of jarWalls) {
                    try {
                        Body.setPosition(w, { x: w.position.x + dx, y: w.position.y + dy });
                        Body.rotate(w, deltaAngle, pivot);
                    } catch (e) {}
                }
                const cos = Math.cos(angleRad);
                const sin = Math.sin(angleRad);
                if (pinSpinBodies) {
                    for (const item of localBodies) {
                        try {
                            const x = cx + item.x * cos - item.y * sin;
                            const y = cy + item.x * sin + item.y * cos;
                            Body.setPosition(item.body, { x, y });
                            Body.setVelocity(item.body, { x: 0, y: 0 });
                            Body.setAngularVelocity(item.body, dir * spinSpeed * 0.08);
                        } catch (e) {}
                    }
                }
                jarX = cx - baseRect.w / 2;
                jarY = cy - baseRect.h / 2;
                const deg = angleRad * 180 / Math.PI;
                if (jarBottomEl) { jarBottomEl.style.left = (jarX / CANVAS_W * 100) + '%'; jarBottomEl.style.top = (jarY / CANVAS_H * 100) + '%'; jarBottomEl.style.transform = `rotate(${deg}deg)`; }
                if (jarGlassEl) { jarGlassEl.style.left = (jarX / CANVAS_W * 100) + '%'; jarGlassEl.style.top = (jarY / CANVAS_H * 100) + '%'; jarGlassEl.style.transform = `rotate(${deg}deg)`; }
                if (countDisplay) { countDisplay.style.left = (cx / CANVAS_W * 100) + '%'; countDisplay.style.top = ((jarY + baseRect.h * 0.88) / CANVAS_H * 100) + '%'; countDisplay.style.transform = `rotate(${deg}deg)`; }
                if (_accessoryEl) {
                    const accW = baseRect.w * 0.8;
                    const accH = accW * 0.5;
                    _accessoryEl.style.left = ((cx - accW / 2) / CANVAS_W * 100) + '%';
                    _accessoryEl.style.top = ((jarY + baseRect.h * SHAPE.neckTopY - accH * 0.8) / CANVAS_H * 100) + '%';
                    _accessoryEl.style.transform = `rotate(${deg}deg)`;
                }
                moveTopHangersWithJar(jarX, jarY, deg, baseRect);
                lastCx = cx;
                lastCy = cy;
                currentAngle = angleRad;
            };
            const releaseSpinBodies = (cx, cy, angleRad, boost = 1) => {
                if (releasedSpinBodies) return;
                releasedSpinBodies = true;
                pinSpinBodies = false;
                removeJarWalls();
                engine.timing.timeScale = savedTimeScale || 1;
                const mouthX = Math.sin(angleRad);
                const mouthY = -Math.cos(angleRad);
                for (const item of localBodies) {
                    try {
                        const mouthBoost = item.y < -baseRect.h * 0.18 ? 1.15 : 1;
                        const sidePush = (item.x / Math.max(1, baseRect.w)) * 2.2;
                        Body.setVelocity(item.body, {
                            x: (mouthX * (7 + Math.random() * 5) * mouthBoost + sidePush) * scatterForce * boost,
                            y: (mouthY * (7 + Math.random() * 5) * mouthBoost + 3) * scatterForce * boost
                        });
                        Body.setAngularVelocity(item.body, dir * (0.12 + Math.random() * 0.22) * scatterForce);
                    } catch (e) {}
                }
            };

            try {
                await wait(80);
                wrap.style.left = (pushX / CANVAS_W * 100) + '%';
                await wait(1080);
                wrap.classList.remove('osin-walking');
                wrap.classList.add('osin-jumping', 'osin-spin');
                wrap.style.transform = 'translate(-50%, -100%) rotate(-12deg)';
                if (config.features.audio) audio.steal();
                await wait(260);

                visualEls.forEach(el => { el.style.transition = 'none'; el.style.transformOrigin = '50% 50%'; });
                if (_accessoryEl) { _accessoryEl.style.transition = 'none'; _accessoryEl.style.transformOrigin = '50% 50%'; }
                if (topHangersEl) topHangersEl.style.transition = 'none';
                engine.timing.timeScale = 0;

                const targetCx = CANVAS_W * 0.5;
                const targetCy = CANVAS_H * (flyHeight / 100);
                const flyMs = 900;
                const flyRot = dir * Math.PI * 2.25 * spinSpeed;
                await tween(t => {
                    const e = 1 - Math.pow(1 - t, 3);
                    const cx = r.cx + (targetCx - r.cx) * e;
                    const cy = r.cy + (targetCy - r.cy) * e - Math.sin(t * Math.PI) * CANVAS_H * 0.05;
                    setJarPose(cx, cy, flyRot * e);
                }, flyMs);

                const holdRotStart = currentAngle;
                await tween(t => {
                    setJarPose(targetCx, targetCy, holdRotStart + dir * Math.PI * 2 * spinSpeed * (holdMs / 1000) * t);
                }, holdMs);

                const pourStart = currentAngle;
                const pourEnd = pourStart + dir * Math.PI;
                await tween(t => {
                    const e = 1 - Math.pow(1 - t, 2);
                    setJarPose(targetCx, targetCy, pourStart + (pourEnd - pourStart) * e);
                }, 520);

                // Chỉ tới pha dốc ngược mới tháo physics cage để quà đổ ra; không vỡ/nổ hũ.
                releaseSpinBodies(targetCx, targetCy, currentAngle, 1.05);
                await wait(1350);

                const restoreCx0 = lastCx;
                const restoreCy0 = lastCy;
                const restoreAngle0 = currentAngle;
                await tween(t => {
                    const e = t * t;
                    setJarPose(restoreCx0 + (baseRect.cx - restoreCx0) * e, restoreCy0 + (baseRect.cy - restoreCy0) * e, restoreAngle0 * (1 - e));
                }, 850);
            } finally {
                engine.timing.timeScale = savedTimeScale;
                currentTiltAngle = 0;
                visualEls.forEach((el, i) => {
                    el.style.transition = '';
                    el.style.cssText = origStyle[i];
                });
                if (_accessoryEl) { _accessoryEl.style.transform = ''; _accessoryEl.style.cssText = accStyle; }
                if (topHangersEl) { topHangersEl.style.transform = ''; topHangersEl.style.cssText = hangerStyle; }
                clearJarLandingZone(baseRect);
                buildJarWalls();
                positionJar();
                positionAccessory();
                updateTopHangers();
                setTimeout(() => { try { wrap.remove(); } catch (e) {} }, 350);
                spinJarBusy = false;
            }
        }

        // Variant của shatterJar nhận vị trí explosion center custom
        // targetBodies (optional): chỉ scatter mảng bodies này (default: all bodies)
        function shatterJarAt(cx, cy, targetBodies) {
            // KHÔNG hiện shatter toast — user không muốn note chữ cho Kick/Throw effects
            if (config.features.audio) { audio.fanfare(); audio.big(); }
            if (jarBottomEl) jarBottomEl.style.transition = 'opacity 0.4s, filter 0.4s';
            if (jarGlassEl) jarGlassEl.style.transition = 'opacity 0.4s, filter 0.4s';
            if (jarBottomEl) jarBottomEl.style.filter = 'brightness(2) hue-rotate(330deg)';
            if (jarGlassEl) jarGlassEl.style.filter = 'brightness(2) hue-rotate(330deg)';
            setTimeout(() => {
                if (jarBottomEl) { jarBottomEl.style.opacity = '0.1'; jarBottomEl.style.filter = ''; }
                if (jarGlassEl) { jarGlassEl.style.opacity = '0.1'; jarGlassEl.style.filter = ''; }
            }, 250);

            const scatterPool = (targetBodies && targetBodies.length) ? targetBodies : bodies;
            scatterPool.forEach(b => {
                const dx = b.position.x - cx;
                const dist = Math.max(Math.abs(dx), 1);
                Body.setVelocity(b, {
                    x: (dx / dist) * (10 + Math.random() * 12) + (Math.random() - 0.5) * 8,
                    y: -(4 + Math.random() * 8)
                });
                Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.6);
            });
            fxAnimations.push({ type: 'megaboom', x: cx, y: cy, age: 0, life: 50 });

            // Rebuild jar walls + restore visual sau 3s — KHÔNG toast
            setTimeout(() => {
                clearJarLandingZone();
                buildJarWalls();
                if (jarBottomEl) { jarBottomEl.style.opacity = '1'; }
                if (jarGlassEl) { jarGlassEl.style.opacity = '1'; }
                crackElements.forEach(c => c.remove());
                crackElements.length = 0;
                crackLevel = 0;
            }, 3000);
        }

        // ===== UFO: VIP PRO hơn OSIN — hút 5-10 quà trong phạm vi → thả vào hũ =====
        // Flow: spawn off-screen → fly tới scan center → tractor beam hút N quà → fly tới
        // miệng hũ → tractor beam thả từng quà → bay khỏi màn hình.
        let ufoBusy = false;
        function ufoSvg() {
            // SVG đĩa bay đơn giản: thân + dome + đèn nhấp nháy
            return `
<svg viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg" class="ufo-craft">
  <defs>
    <linearGradient id="ufoBody" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#cbd5e1"/>
      <stop offset="0.5" stop-color="#94a3b8"/>
      <stop offset="1" stop-color="#475569"/>
    </linearGradient>
    <radialGradient id="ufoDome" cx="0.5" cy="0.8" r="0.7">
      <stop offset="0" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#0369a1"/>
    </radialGradient>
  </defs>
  <!-- Thân chính: ellipse dẹt -->
  <ellipse cx="60" cy="38" rx="55" ry="12" fill="url(#ufoBody)" stroke="#1e293b" stroke-width="1.5"/>
  <!-- Dome trên -->
  <path d="M30 35 Q60 5 90 35 Z" fill="url(#ufoDome)" stroke="#1e293b" stroke-width="1.5" opacity="0.85"/>
  <!-- Đèn dưới (3 đèn nhấp nháy) -->
  <circle class="ufo-light l1" cx="35" cy="46" r="3.2" fill="#fbbf24"/>
  <circle class="ufo-light l2" cx="60" cy="48" r="3.2" fill="#f87171"/>
  <circle class="ufo-light l3" cx="85" cy="46" r="3.2" fill="#34d399"/>
</svg>`;
        }
        function buildUFONode({ name, avatar }) {
            const wrap = document.createElement('div');
            wrap.className = 'tt-ufo';
            wrap.innerHTML = `
                <div class="ufo-name">${name ? '🛸 ' + escHtml(name) : '🛸 UFO'}</div>
                <div class="ufo-craft-wrap">${ufoSvg()}</div>
                <div class="ufo-beam"></div>
            `;
            return wrap;
        }
        async function triggerUFO(opts = {}) {
            if (!thiefLayer || ufoBusy) return;
            // UFO chỉ hút quà NGOÀI hũ (escaped) — VIP PRO version của OSIN.
            // Picking-from-jar-and-dropping-back-into-jar là vô nghĩa.
            const escaped = findEscapedBodies();
            if (!escaped.length) {
                showComboToast(
                    `🛸 UFO tới nhưng không có quà rớt ngoài hũ để cứu`,
                    'linear-gradient(135deg, #6b7280, #4b5563)'
                );
                return;
            }
            ufoBusy = true;
            const { name, avatar } = opts;
            const cfg = config.effects?.ufo || {};
            const minN = Math.max(1, cfg.minCapacity ?? 5);
            const maxN = Math.max(minN, cfg.maxCapacity ?? 10);
            const capacity = minN + Math.floor(Math.random() * (maxN - minN + 1));
            const radiusPct = Math.max(10, Math.min(80, cfg.radiusPct ?? 40));
            const radius = CANVAS_W * radiusPct / 100;

            const r = jarRect();
            const wrap = buildUFONode({ name, avatar });
            thiefLayer.appendChild(wrap);

            // Start UFO hum drone — chạy suốt animation, tắt khi UFO exit
            let stopHum = () => {};
            if (config.features.audio) {
                stopHum = audio.ufoHum();
                audio.ufoArrive();
            }

            // Random độ cao bay: 15-35% canvas height (THẤP hơn version cũ 8-30%)
            // - Min 15%: vẫn còn cao đủ thấy rõ, không sát đỉnh
            // - Max clamp dưới miệng hũ - 3% để chừa khoảng kéo beam
            //   (idol thường ngồi tầm 50-70% nên UFO ở 15-35% gần idol — dễ nhìn)
            const mouthYPct = (r.y + r.h * SHAPE.neckTopY) / CANVAS_H * 100;
            const maxFlyPct = Math.max(20, Math.min(35, mouthYPct - 3));
            const flyYPct = 15 + Math.random() * (maxFlyPct - 15);
            const flyY = CANVAS_H * flyYPct / 100;
            const fromLeft = Math.random() < 0.5;
            const startX = fromLeft ? -CANVAS_W * 0.18 : CANVAS_W * 1.18;

            // Pick scan center: random escaped body → tâm scan
            const anchor = escaped[Math.floor(Math.random() * escaped.length)];
            const scanCenterX = Math.max(CANVAS_W * 0.15, Math.min(CANVAS_W * 0.85, anchor.position.x));
            const scanCenterY = Math.max(CANVAS_H * 0.3, Math.min(CANVAS_H * 0.88, anchor.position.y));

            const posUFO = (xCanvas, yCanvas) => {
                wrap.style.position = 'absolute';
                wrap.style.left = (xCanvas / CANVAS_W * 100) + '%';
                wrap.style.top = (yCanvas / CANVAS_H * 100) + '%';
            };
            posUFO(startX, flyY);
            wrap.style.transition = 'left 1.4s cubic-bezier(.25,.46,.45,.94), top 1.4s ease-out';
            await wait(60);

            // Phase 1: bay tới scan center (giữ độ cao flyY)
            posUFO(scanCenterX, flyY);
            await wait(1400);
            if (config.features.audio) audio.ufoBeam();

            // Phase 2: extend tractor beam xuống dưới
            // height tính bằng cqi (= % container width 1080) để independent với wrap nhỏ.
            const beam = wrap.querySelector('.ufo-beam');
            const beamLenPx = (scanCenterY + radius * 0.4) - flyY;
            beam.style.height = (beamLenPx / CANVAS_W * 100) + 'cqi';
            beam.classList.add('active');
            await wait(450);

            // Phase 3: tìm escaped bodies trong phạm vi & hút lên
            // Re-fetch escaped (có thể đã đổi sau khi chờ phase 1+2)
            const escapedNow = findEscapedBodies();
            const candidates = escapedNow
                .map(b => ({
                    b,
                    d: Math.hypot(b.position.x - scanCenterX, b.position.y - scanCenterY)
                }))
                .filter(x => x.d <= radius)
                .sort((a, b) => a.d - b.d)
                .slice(0, capacity);

            const cargo = [];   // { gm, sourceX, sourceY } để spawn lại lúc thả
            for (const item of candidates) {
                const tb = item.b;
                const idx = bodies.indexOf(tb);
                if (idx < 0) continue;
                const sourceX = tb.position.x;
                const sourceY = tb.position.y;
                const gm = tb.gm;
                bodies.splice(idx, 1);
                Composite.remove(engine.world, tb);
                cargo.push({ gm, sourceX, sourceY });

                // Ghost img bay lên UFO — wobble nhẹ + shrink dần → mất hút vào đĩa bay
                if (gm?.img) {
                    const ghost = document.createElement('img');
                    ghost.src = gm.img.src;
                    ghost.className = 'tt-ufo-ghost';
                    ghost.style.left = (sourceX / CANVAS_W * 100) + '%';
                    ghost.style.top = (sourceY / CANVAS_H * 100) + '%';
                    thiefLayer.appendChild(ghost);
                    // Stagger 80ms mỗi quà — tạo cảm giác hút từng cái chứ không đồng loạt
                    const delay = 60 + Math.random() * 200;
                    setTimeout(() => {
                        // Wobble X nhẹ trên đường lên (random ±5% canvas width)
                        const wobble = (Math.random() - 0.5) * CANVAS_W * 0.05;
                        ghost.style.left = ((scanCenterX + wobble) / CANVAS_W * 100) + '%';
                        ghost.style.top = (flyY / CANVAS_H * 100) + '%';
                        // Shrink xuống 15% size + xoay nhẹ 180° trong khi bay
                        ghost.style.transform = 'translate(-50%, -50%) scale(0.15) rotate(180deg)';
                        ghost.style.opacity = '0';
                        // Whoosh up audio cho từng quà — staggered theo delay
                        if (config.features.audio) audio.ufoSuck();
                    }, delay);
                    setTimeout(() => ghost.remove(), delay + 1200);
                }
            }
            updateCountDisplay();
            onCountChange(bodies.length);
            // Chờ ghost bay xong (suck 1.1s + max stagger 260ms ≈ 1.4s)
            await wait(1300);

            // Retract beam
            beam.classList.remove('active');
            beam.style.height = '0cqi';
            await wait(250);

            if (cargo.length === 0) {
                // Không hút được quà nào (bodies đã bị di chuyển hoặc race condition)
                if (config.features.audio) audio.ufoExit();
                wrap.style.transition = 'left 1.2s ease-in, opacity .4s ease';
                wrap.style.left = (fromLeft ? CANVAS_W * 1.18 : -CANVAS_W * 0.18) / CANVAS_W * 100 + '%';
                wrap.style.opacity = '0';
                await wait(1200);
                stopHum();
                wrap.remove();
                ufoBusy = false;
                return;
            }

            // Phase 4: bay tới trên miệng hũ
            const jarCenterX = r.x + r.w / 2;
            const dropY = flyY;
            wrap.style.transition = 'left 1.2s cubic-bezier(.25,.46,.45,.94)';
            wrap.style.left = (jarCenterX / CANVAS_W * 100) + '%';
            await wait(1220);

            // Phase 5: extend beam xuống miệng hũ
            const mouthY = r.y + r.h * SHAPE.neckTopY + 30;
            const dropBeamPx = mouthY - flyY;
            beam.style.height = (dropBeamPx / CANVAS_W * 100) + 'cqi';
            beam.classList.add('active');
            if (config.features.audio) audio.ufoBeam();
            await wait(400);

            // Phase 6: thả từng quà — stagger 180ms, mỗi quà tạo physics body mới rơi vào hũ
            for (let i = 0; i < cargo.length; i++) {
                const { gm } = cargo[i];
                if (!gm) continue;
                const respawnX = jarCenterX + (Math.random() - 0.5) * r.w * 0.5;
                const respawnY = r.y + r.h * SHAPE.neckTopY + 60;
                const newBody = Bodies.circle(respawnX, respawnY, gm.sz / 2, {
                    restitution: config.physics.bounce,
                    friction: config.physics.friction,
                    density: 0.002
                });
                newBody.gm = gm;
                Body.setVelocity(newBody, { x: 0, y: 4 });
                Composite.add(engine.world, newBody);
                bodies.push(newBody);

                // Visual: ghost rơi từ UFO xuống miệng hũ
                if (gm.img) {
                    const ghost = document.createElement('img');
                    ghost.src = gm.img.src;
                    ghost.className = 'tt-ufo-ghost drop';
                    ghost.style.left = (jarCenterX / CANVAS_W * 100) + '%';
                    ghost.style.top = (flyY / CANVAS_H * 100) + '%';
                    thiefLayer.appendChild(ghost);
                    requestAnimationFrame(() => {
                        ghost.style.top = (mouthY / CANVAS_H * 100) + '%';
                        ghost.style.opacity = '0';
                    });
                    setTimeout(() => ghost.remove(), 600);
                }
                if (config.features.audio) audio.ufoDrop();
                updateCountDisplay();
                onCountChange(bodies.length);
                await wait(180);
            }

            // Retract beam + fly off
            beam.classList.remove('active');
            beam.style.height = '0cqi';
            await wait(250);
            if (config.features.audio) audio.ufoExit();
            const exitX = fromLeft ? CANVAS_W * 1.18 : -CANVAS_W * 0.18;
            wrap.style.transition = 'left 1.4s cubic-bezier(.25,.46,.45,.94), opacity .6s ease';
            wrap.style.left = (exitX / CANVAS_W * 100) + '%';
            wrap.style.opacity = '0';
            await wait(1400);
            stopHum();
            wrap.remove();
            ufoBusy = false;

            const thankName = (name || '').trim() || 'Khách';
            showComboToast(
                `🛸 <b>UFO của ${escHtml(thankName)}</b> đã cứu <b>${cargo.length}</b> quà rớt vào hũ!`,
                'linear-gradient(135deg, #0ea5e9, #6366f1)'
            );
        }

        // ===== Crown SVG =====
        function crownIconSvg() {
            return 'data:image/svg+xml;utf8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="%23ffd166"/><stop offset="1" stop-color="%23ff8a00"/></linearGradient></defs><path d="M4 14 L18 30 L32 8 L46 30 L60 14 L56 42 L8 42 Z" fill="url(%23g)" stroke="%23a36500" stroke-width="2"/><circle cx="4" cy="14" r="4" fill="%23ff5e8a"/><circle cx="60" cy="14" r="4" fill="%23ff5e8a"/><circle cx="32" cy="8" r="4" fill="%2300d4ff"/></svg>'
            );
        }

        // ===== Render =====
        const CULL_BELOW_Y = CANVAS_H + 2000; // bodies stack ở floor (CANVAS_H+12) — safety net cho bug fall-through hiếm gặp
        function render() {
            ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
            // Khi hũ bị trộm, không vẽ bodies (tạo cảm giác hũ + quà cùng biến mất)
            if (jarStolen) { requestAnimationFrame(render); return; }
            // Cull bodies đã rơi quá xa khỏi vùng nhìn (giải phóng bộ nhớ).
            let culled = 0;
            for (let i = bodies.length - 1; i >= 0; i--) {
                const b = bodies[i];
                if (b.position.y > CULL_BELOW_Y) {
                    Composite.remove(engine.world, b);
                    bodies.splice(i, 1);
                    culled++;
                }
            }
            if (culled) { updateCountDisplay(); onCountChange(bodies.length); }
            for (const b of bodies) {
                const m = b.gm; if (!m) continue;
                ctx.save();
                ctx.translate(b.position.x, b.position.y);
                ctx.rotate(b.angle);
                const sz = m.sz;
                // Tier border
                if (config.features.tierBorder && m.tier) {
                    ctx.beginPath(); ctx.arc(0, 0, sz / 2 + 4, 0, Math.PI * 2);
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = m.tier === 'diamond' ? 'rgba(120,220,255,0.95)'
                        : m.tier === 'gold' ? 'rgba(255,210,90,0.95)'
                        : 'rgba(220,220,255,0.6)';
                    ctx.stroke();
                }
                const img = m.img;
                if (img && img.complete && img.naturalWidth > 0) {
                    ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
                } else {
                    ctx.fillStyle = 'rgba(180,180,180,0.35)';
                    ctx.beginPath(); ctx.arc(0, 0, sz / 2, 0, Math.PI * 2); ctx.fill();
                }
                ctx.restore();
            }
            requestAnimationFrame(render);
        }
        function renderFx() {
            if (!fxCtx) { requestAnimationFrame(renderFx); return; }
            fxCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
            if (zigzagLuck.active && zigzagLuck.rect) {
                const r = zigzagLuck.rect;
                const leftSec = Math.max(0, Math.ceil((zigzagLuck.until - Date.now()) / 1000));
                const now = performance.now();
                const arrowBob = Math.sin(now / 260) * 12;
                const arrowAlpha = 0.62 + 0.38 * Math.abs(Math.sin(now / 360));
                fxCtx.save();
                fxCtx.shadowColor = 'rgba(0, 0, 0, 0.55)';
                fxCtx.shadowBlur = 18;
                fxCtx.fillStyle = 'rgba(10, 14, 22, 0.42)';
                fxCtx.beginPath();
                if (fxCtx.roundRect) fxCtx.roundRect(r.left, r.top, r.width, r.height, 18);
                else fxCtx.rect(r.left, r.top, r.width, r.height);
                fxCtx.fill();
                fxCtx.shadowBlur = 0;
                fxCtx.lineWidth = 5;
                fxCtx.strokeStyle = 'rgba(255, 198, 104, 0.95)';
                fxCtx.stroke();
                fxCtx.lineWidth = 2;
                fxCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
                fxCtx.stroke();
                const grad = fxCtx.createLinearGradient(r.left, r.top - 50, r.left + 420, r.top - 50);
                grad.addColorStop(0, '#ffe9b8');
                grad.addColorStop(0.55, '#ffffff');
                grad.addColorStop(1, '#ffb74a');
                fxCtx.font = '900 26px Inter, Arial';
                fxCtx.fillStyle = grad;
                fxCtx.textAlign = 'left';
                fxCtx.shadowColor = 'rgba(255, 138, 0, 0.5)';
                fxCtx.shadowBlur = 10;
                fxCtx.fillText(`🎰 ZIKZAK MAY MẮN · ${leftSec}s`, r.left + 18, r.top - 16);
                fxCtx.shadowBlur = 0;
                for (const peg of zigzagLuck.pegs) {
                    const px = peg.position.x;
                    const py = peg.position.y;
                    const pegGrad = fxCtx.createRadialGradient(px - r.radius * 0.35, py - r.radius * 0.35, 2, px, py, r.radius * 1.25);
                    pegGrad.addColorStop(0, '#f8d08a');
                    pegGrad.addColorStop(0.45, '#b36a2d');
                    pegGrad.addColorStop(1, '#5b2f16');
                    fxCtx.fillStyle = pegGrad;
                    fxCtx.beginPath();
                    fxCtx.arc(px, py, r.radius * 1.1, 0, Math.PI * 2);
                    fxCtx.fill();
                    fxCtx.lineWidth = 4;
                    fxCtx.strokeStyle = '#ff3d4f';
                    fxCtx.stroke();
                    fxCtx.beginPath();
                    fxCtx.fillStyle = 'rgba(255,255,255,0.22)';
                    fxCtx.arc(px - r.radius * 0.28, py - r.radius * 0.28, r.radius * 0.22, 0, Math.PI * 2);
                    fxCtx.fill();
                }
                const arrows = 5;
                for (let i = 0; i < arrows; i++) {
                    const x = r.left + r.width * (0.14 + i * 0.18);
                    const y = r.top - 78 + arrowBob + Math.sin(now / 180 + i) * 4;
                    fxCtx.globalAlpha = arrowAlpha;
                    fxCtx.strokeStyle = '#7df9ff';
                    fxCtx.fillStyle = '#7df9ff';
                    fxCtx.shadowColor = '#00e5ff';
                    fxCtx.shadowBlur = 18;
                    fxCtx.lineWidth = 6;
                    fxCtx.beginPath();
                    fxCtx.moveTo(x, y - 52);
                    fxCtx.lineTo(x, y + 8);
                    fxCtx.stroke();
                    fxCtx.beginPath();
                    fxCtx.moveTo(x - 22, y + 8);
                    fxCtx.lineTo(x + 22, y + 8);
                    fxCtx.lineTo(x, y + 48);
                    fxCtx.closePath();
                    fxCtx.fill();
                    fxCtx.globalAlpha = 1;
                    fxCtx.shadowBlur = 0;
                }
                fxCtx.restore();
            }
            for (let i = fxAnimations.length - 1; i >= 0; i--) {
                const fx = fxAnimations[i];
                fx.age++;
                if (fx.type === 'firework') {
                    const t = fx.age / fx.life;
                    const N = 24, R = t * 220;
                    fxCtx.globalAlpha = Math.max(0, 1 - t);
                    for (let k = 0; k < N; k++) {
                        const a = (k / N) * Math.PI * 2;
                        const x = fx.x + Math.cos(a) * R;
                        const y = fx.y + Math.sin(a) * R;
                        fxCtx.fillStyle = fx.color;
                        fxCtx.beginPath(); fxCtx.arc(x, y, 4 + (1 - t) * 6, 0, Math.PI * 2); fxCtx.fill();
                    }
                    fxCtx.globalAlpha = 1;
                } else if (fx.type === 'megaboom') {
                    const t = fx.age / fx.life;
                    const R = t * 600;
                    fxCtx.globalAlpha = Math.max(0, 1 - t);
                    fxCtx.strokeStyle = '#ff8a00';
                    fxCtx.lineWidth = 14 * (1 - t * 0.7);
                    fxCtx.beginPath(); fxCtx.arc(fx.x, fx.y, R, 0, Math.PI * 2); fxCtx.stroke();
                    fxCtx.strokeStyle = '#ffd166';
                    fxCtx.lineWidth = 6 * (1 - t * 0.7);
                    fxCtx.beginPath(); fxCtx.arc(fx.x, fx.y, R * 0.7, 0, Math.PI * 2); fxCtx.stroke();
                    fxCtx.globalAlpha = 1;
                }
                if (fx.age > fx.life) fxAnimations.splice(i, 1);
            }
            requestAnimationFrame(renderFx);
        }

        function updateCountDisplay() {
            if (!countDisplay) return;
            // Hiện counter khi feature on, BẤT KỂ bodies = 0 (user thấy '0' khi hũ trống)
            if (config.gift.showCount) {
                countDisplay.style.display = 'block';
                countDisplay.textContent = String(bodies.length);
                const r = jarRect();
                countDisplay.style.left = (r.cx / CANVAS_W * 100) + '%';
                countDisplay.style.top = ((r.y + r.h * 0.88) / CANVAS_H * 100) + '%';
                const fontPx = Math.max(14, Math.min(72, r.h * 0.055));
                countDisplay.style.fontSize = fontPx + 'px';
            } else countDisplay.style.display = 'none';
        }

        function getJarRect() { return jarRect(); }
        function setJarPosition(xPercent, yPercent) {
            config.jar.xPercent = Math.max(0, Math.min(100, xPercent));
            config.jar.yPercent = Math.max(0, Math.min(100, yPercent));
            positionJar();
        }
        function setConfig(patch) {
            config = mergeConfig(config, patch || {});
            // triggers cần replacement (cho phép xoá), không deep-merge
            if (patch && Object.prototype.hasOwnProperty.call(patch, 'triggers')) {
                config.triggers = patch.triggers ? JSON.parse(JSON.stringify(patch.triggers)) : {};
            }
            engine.gravity.y = config.physics.gravity;
            if (!isEnabled()) {
                spawnQueue.length = 0;
                if (spawnTicker) { clearInterval(spawnTicker); spawnTicker = null; }
                stopRandomEvents();
                stopThiefAuto();
                if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
            }
            positionJar();
            // Cập nhật TẤT CẢ panel để pick up vị trí + scale mới từ config
            updateGoalBar(); updateLeaderboard(); updateSessionTotals(); updateCrown(); updateTopHangers();
            updateCaughtList(); updatePoliceForcePanel();
            applyActorScales();
            applyJarTheme();
            applyJarAccessory();
            renderBadges();
            if (isEnabled() && config.features.randomEvents) startRandomEvents(); else stopRandomEvents();
            if (isEnabled() && config.features.thiefAuto) startThiefAuto(); else stopThiefAuto();
            if (isEnabled()) restartGiftHistoryTimer();
        }
        function getConfig() { return JSON.parse(JSON.stringify(config)); }
        function getStats() {
            return {
                totalDiamonds: stats.totalDiamonds,
                totalGifts: stats.totalGifts,
                tippers: Array.from(stats.tippers.values()).sort((a, b) => b.diamonds - a.diamonds),
                seenGifts: stats.seenGiftTypes.size
            };
        }
        function resetSession() {
            stats.totalDiamonds = 0; stats.totalGifts = 0;
            stats.tippers.clear(); stats.seenGiftTypes.clear(); stats.combos.clear();
            stats.recentTopUid = null; stats.goalReached = false;
            stats.caughtList = [];
            bannedUntilByUid.clear();
            policeForce.clear();
            // Clear cả bodies trong hũ — phiên mới = bắt đầu lại 100%
            // (Tránh tình trạng app preview clear nhưng OBS giữ bodies cũ)
            clearAll();
            updateGoalBar(); updateLeaderboard(); updateSessionTotals(); updateCrown(); updateTopHangers();
            updateCaughtList(); updatePoliceForcePanel();
        }
        function serializeState() {
            const stateBodies = cloneBodiesForState();
            return {
                totalDiamonds: stats.totalDiamonds,
                totalGifts: stats.totalGifts,
                tippers: Array.from(stats.tippers.entries()),
                seenGiftTypes: Array.from(stats.seenGiftTypes),
                caughtList: JSON.parse(JSON.stringify(stats.caughtList)),
                bannedUntilByUid: Array.from(bannedUntilByUid.entries()),
                policeForce: Array.from(policeForce.entries()),
                goalReached: !!stats.goalReached,
                // PERSIST bodies — quà đang trong hũ (giữ qua restart)
                // gm có circular refs (img is HTMLImageElement) → chỉ save fields cần thiết
                bodies: stateBodies,
                giftHistory: JSON.parse(JSON.stringify(giftHistory))
            };
        }
        function isTransientAnimationActive() {
            return !!(spinJarBusy || kickJarBusy || throwJarBusy || tiltAnimating || spillInProgress || jarStolen);
        }
        function loadState(state) {
            if (!state || typeof state !== 'object') return;
            stats.totalDiamonds = state.totalDiamonds || 0;
            stats.totalGifts = state.totalGifts || 0;
            stats.tippers = new Map(state.tippers || []);
            stats.seenGiftTypes = new Set(state.seenGiftTypes || []);
            stats.caughtList = Array.isArray(state.caughtList) ? state.caughtList : [];
            bannedUntilByUid.clear();
            if (Array.isArray(state.bannedUntilByUid)) {
                for (const [k, v] of state.bannedUntilByUid) bannedUntilByUid.set(String(k), Number(v));
            }
            policeForce.clear();
            if (Array.isArray(state.policeForce)) {
                for (const [k, v] of state.policeForce) policeForce.set(String(k), v);
            }
            stats.goalReached = !!state.goalReached;
            giftHistory.length = 0;
            if (Array.isArray(state.giftHistory)) giftHistory.push(...state.giftHistory.slice(0, HISTORY_MAX));
            pruneGiftHistory();

            // RESTORE bodies — recreate physics bodies từ saved positions (persist qua restart).
            // === FIX REGRESSION v1.0.57 (khôi phục đúng hành vi v1.0.56) ===
            // v1.0.56 KHÔNG bị giật vì có chốt `bodies.length === 0`: chỉ tạo lại quà
            // khi đang TRỐNG (lúc mới mở OBS / cold start). Khi OBS đã có quà (đang chạy
            // physics riêng), snapshot 1.5s bị BỎ QUA → không clear+recreate → không
            // teleport, không bắn quà khỏi hũ, không giật. v1.0.57 lỡ bỏ chốt này nên
            // mỗi 1.5s stomp toàn bộ → giật "ma thuật". App (preview) chỉ loadState 1
            // lần lúc khởi động (bodies trống) nên chốt này vô hại với App.
            if (Array.isArray(state.bodies) && state.bodies.length && bodies.length === 0) {
                clearBodiesOnly();
                for (const b of state.bodies) {
                    const body = makeBodyFromSaved(b);
                    if (!body) continue;
                    Composite.add(engine.world, body);
                    bodies.push(body);
                }
                updateCountDisplay();
                onCountChange(bodies.length);
                console.log(`[loadState] Restored ${state.bodies.length} bodies từ state`);
            }

            updateCrown(); updateLeaderboard(); updateSessionTotals(); updateGoalBar();
            updateCaughtList(); updatePoliceForcePanel();
            // QUAN TRỌNG: re-position toàn bộ overlay sau loadState — đảm bảo display flags
            // (block/none) khớp với config.features hiện tại. Nếu thiếu bước này, panels có
            // thể bị hidden dù feature đang on (race condition khi loadState chạy trước khi
            // setConfig hoàn tất trên OBS reconnect).
            positionUiOverlays();
            if (bannedUntilByUid.size > 0) startBanCountdown();
        }

        // Init
        ensureOverlayDom();
        positionJar();
        updateGoalBar(); updateSessionTotals(); updateLeaderboard(); updateCrown();
        applyActorScales();
        applyJarAccessory();
        if (isEnabled() && config.features.randomEvents) startRandomEvents();
        if (isEnabled() && config.features.thiefAuto) startThiefAuto();
        // Runner FIXED delta — Matter.js default isFixed:false sẽ adapt dt theo real time.
        // Khi OBS browser source giới hạn FPS (mặc định 30fps trong OBS), dt tăng từ 16.67ms → 33ms
        // → bodies di chuyển GẤP ĐÔI mỗi tick → dễ tunneling qua tường (đáy hũ, sàn world).
        // isFixed: true → mỗi tick luôn dt = 1000/60ms, bodies di chuyển ổn định.
        // Trade-off: nếu OBS chậm → vật lý chạy slow-motion thay vì bị mất quà.
        Runner.run(Runner.create({ isFixed: true, delta: 1000 / 60 }), engine);

        // Safety net: cap max velocity sau mỗi tick để bodies không bao giờ đạt tốc độ tunneling.
        // Đáy hũ FLOOR_T=80, max safe velocity = 80 / 2 = 40 px/tick → cap ở 35.
        const MAX_BODY_V = 35;
        Events.on(engine, 'collisionStart', (event) => {
            if (!zigzagLuck.active || !zigzagLuck.rect) return;
            for (const pair of event.pairs || []) {
                const a = pair.bodyA;
                const b = pair.bodyB;
                const gift = a?.gm?.zigzag ? a : (b?.gm?.zigzag ? b : null);
                const peg = a === gift ? b : a;
                if (!gift || peg?.label !== 'zigzag-peg') continue;
                const side = gift.position.x < peg.position.x ? -1 : 1;
                const flip = Math.random() < 0.42 ? -1 : 1;
                const dir = side * flip;
                gift.gm.zigzagDir = dir;
                gift.gm.zigzagBumps = (gift.gm.zigzagBumps || 0) + 1;
                const speedX = 3.2 + Math.random() * 3.4;
                Body.setVelocity(gift, {
                    x: dir * speedX,
                    y: Math.max(2.2, gift.velocity.y * 0.72 + 1.4)
                });
                Body.setAngularVelocity(gift, dir * (0.12 + Math.random() * 0.18));
            }
        });
        Events.on(engine, 'afterUpdate', () => {
            for (const b of bodies) {
                const v = b.velocity;
                if (zigzagLuck.active && b.gm?.zigzag && zigzagLuck.rect) {
                    const r = zigzagLuck.rect;
                    const insideBoard = b.position.x > r.left && b.position.x < r.right && b.position.y > r.top && b.position.y < r.bottom;
                    if (!b.gm.zigzagExpanded && b.position.y > r.bottom + Math.max(12, b.gm.sz * 0.35)) {
                        b.gm.zigzagExpanded = true;
                        scaleGiftBody(b, b.gm.zigzagTargetSize);
                    }
                    if (insideBoard) {
                        const row = Math.max(0, Math.min(r.rows - 1, Math.floor((b.position.y - r.top) / Math.max(1, r.gapY))));
                        if (row !== b.gm.zigzagLastRow) {
                            b.gm.zigzagLastRow = row;
                            const edgeDir = b.position.x < r.left + r.width * 0.2 ? 1 : (b.position.x > r.left + r.width * 0.8 ? -1 : 0);
                            const nextDir = edgeDir || (Math.random() < 0.55 ? -(b.gm.zigzagDir || 1) : (b.gm.zigzagDir || 1));
                            b.gm.zigzagDir = nextDir;
                            Body.setVelocity(b, {
                                x: nextDir * (2.5 + Math.random() * 3.5),
                                y: Math.max(1.8, Math.min(7, v.y))
                            });
                        }
                        const edgeDir = b.position.x < r.left + r.width * 0.12 ? 1 : (b.position.x > r.left + r.width * 0.88 ? -1 : 0);
                        if (edgeDir) Body.setVelocity(b, { x: edgeDir * Math.max(2.4, Math.abs(v.x) * 0.7), y: Math.max(v.y, 1.8) });
                        if (Math.hypot(v.x, v.y) < 0.45) {
                            Body.setVelocity(b, { x: (b.gm.zigzagDir || 1) * (2.8 + Math.random() * 2.8), y: 3.1 });
                        }
                    }
                }
                if (Math.abs(v.x) > MAX_BODY_V || Math.abs(v.y) > MAX_BODY_V) {
                    Body.setVelocity(b, {
                        x: Math.max(-MAX_BODY_V, Math.min(MAX_BODY_V, v.x)),
                        y: Math.max(-MAX_BODY_V, Math.min(MAX_BODY_V, v.y))
                    });
                }
            }
        });

        requestAnimationFrame(render);
        requestAnimationFrame(renderFx);
        pruneGiftHistory();
        restartGiftHistoryTimer();

        return {
            drop, shake, clearAll, setConfig, getConfig, getStats, resetSession,
            getJarRect, setJarPosition,
            triggerThief, triggerOsin, triggerUFO, fxKickJar, fxThrowJar, fxSpinJar, fxOsinKickOut, fxDragonFire, setThiefAppearance, setPoliceAppearance,
            banThief, unbanThief, isThiefBanned, bailUser,
            serializeState, loadState,
            captureGiftHistory,
            getGiftHistory: () => JSON.parse(JSON.stringify(giftHistory)),
            restoreGiftSnapshot,
            fxFireworks, fxMegaboom, fxTilt, fxGravFlip, fxTornado, fxSlow, fxPourOut,
            fxRain, fxGeyser, fxMagnet, fxWind,
            fxCrackJar, fxStealJar, fxZigzagLuck, fxCombo, fxShape,
            togglePoliceMembership,
            // Trả về snapshot lực lượng CS (cho Police popup ngoài app)
            getPoliceForce: () => Array.from(policeForce.values()),
            // Trả về snapshot danh sách trộm bị tóm (cho Bị Tóm popup ngoài app)
            getCaughtList: () => JSON.parse(JSON.stringify(stats.caughtList)),
            getCount: () => bodies.length,
            engine, CANVAS_W, CANVAS_H
        };
    }

    function mergeConfig(base, patch) {
        const out = JSON.parse(JSON.stringify(base));
        if (!patch || typeof patch !== 'object') return out;
        for (const k of Object.keys(patch)) {
            if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
                out[k] = mergeConfig(out[k] || {}, patch[k]);
            } else {
                out[k] = patch[k];
            }
        }
        return out;
    }

    function escHtml(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
    function escAttr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

    global.HpGame = global.HpGame || {};
    global.HpGame.thuytinh = { create, defaultConfig, CANVAS_W, CANVAS_H };
})(window);

/*
 * Game: Hủ Thủy Tinh
 * Quà tặng rơi vào hũ thủy tinh với vật lý Matter.js + nhiều tính năng tương tác.
 */
(function (global) {
    const { Engine, Runner, Bodies, Body, Composite } = global.Matter;

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
        // ⭐ DEFAULTS đã được tinh chỉnh theo setup vận hành tốt — áp dụng cho install MỚI.
        // User cũ đã có app-config.json sẽ giữ nguyên config riêng.
        // (Cài đặt này khớp giao diện idol đang dùng cho live TikTok: hũ ở góc dưới phải, gravity nặng,
        // ma sát cao để quà ổn định nhanh, chỉ bật Top tặng + Goal bar + CS — gọn gàng cho stream.)
        return {
            // Vị trí + kích thước hũ — góc dưới-phải canvas, hũ nhỏ gọn (height 400 thay vì 1200)
            jar: { xPercent: 79.43, yPercent: 76.63, height: 400 },
            gift: { minSize: 40, maxSize: 220, showName: false, showCount: true },
            // Physics nặng + ma sát cao → quà rơi nhanh, ổn định nhanh, ít văng lung tung
            physics: { gravity: 2, bounce: 0.5, friction: 0.5 },
            jarVisible: true,
            jarLocked: false,
            maxCapacity: 0,
            // Chỉ bật những feature thiết yếu cho stream: Âm thanh + Top tặng + Goal Bar + Cảnh sát.
            // Welcome/Crown/Combo/Quà to v.v. mặc định TẮT cho gọn — user bật lại nếu muốn.
            features: {
                audio: true,
                welcome: false,
                crown: false,
                leaderboard: true,
                sessionTotals: false,
                goalBar: true,
                combo: false,
                tierBorder: false,
                bigGiftFx: false,
                autoShake: false,
                randomEvents: false,
                thiefAuto: false,
                police: true
            },
            goal: { target: 4100 },
            // Khoảng cách goal bar so với đáy hũ (% canvas H). Âm = sát lên / chồng lên đáy hũ
            goalBarGap: -1.2,
            autoShakeAt: 200,
            randomEventEverySec: 90,
            thiefEverySec: 60,
            thiefMissRate: 0.1,
            policeCatchRate: 0.2,
            policeBanSec: 60,
            policeName: '',
            // Map: giftId → action ('thief'|'fireworks'|'megaboom'|'tornado'|'tilt'|'gravflip'|'shake'|'clear'|'slow'|'osin')
            // Quà có trong map sẽ KHÔNG rơi vào hũ, chỉ kích hoạt hiệu ứng tương ứng.
            // Default trống — user assign per gift qua chuột phải.
            triggers: {},
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
                stealJar: { durationSec: 8 },
                combo:    { sequence: 'crackJar:0,crackJar:1.5,crackJar:3,stealJar:5' }
            },
            // Vị trí panel UI (đơn vị %) — null = dùng default CSS
            panelPositions: {
                leaderboard: null,
                caught: null
            },
            // Tỉ lệ scale panel (1 = 100%)
            panelScales: {
                leaderboard: 1,
                caught: 1
            }
        };
    }

    // ===== Audio (Web Audio API tổng hợp âm thanh, không cần file) =====
    const audio = (() => {
        let ctx = null;
        function ensureCtx() {
            if (!ctx) try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
            return ctx;
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
        return {
            plop: () => tone(360, 0.07, 'sine', 0.18),
            ting: () => tone(1240, 0.08, 'triangle', 0.14),
            big: () => { tone(180, 0.1, 'sawtooth', 0.18); setTimeout(() => tone(280, 0.15, 'square', 0.12), 80); },
            fanfare: () => {
                const seq = [523, 659, 784, 1047];
                seq.forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.18), i * 110));
            },
            steal: () => { tone(800, 0.06, 'square', 0.12); setTimeout(() => tone(420, 0.08, 'sawtooth', 0.12), 60); }
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
        const engine = Engine.create();
        engine.gravity.y = config.physics.gravity;

        const bodies = [];
        let jarWalls = [];      // walls riêng của hũ — có thể tháo tạm khi spill/shatter
        let worldWalls = [];    // floor + 2 side walls — LUÔN giữ, để quà stack ở đáy overlay
        // Compat: nhiều chỗ cũ tham chiếu tới `walls` cho mọi walls — alias
        let walls = [];
        const imgCache = new Map();
        let spawnQueue = [];
        let spawnTicker = null;

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
            buildWalls();
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
            // Floor sát đáy overlay → quà tràn ra sẽ stack ở đáy thay vì rơi mất
            worldWalls.push(makeWall(CANVAS_W / 2, CANVAS_H + 12, CANVAS_W + 200, 24));
            worldWalls.push(makeWall(-12, CANVAS_H / 2, 24, CANVAS_H + 200));
            worldWalls.push(makeWall(CANVAS_W + 12, CANVAS_H / 2, 24, CANVAS_H + 200));
            Composite.add(engine.world, worldWalls);
        }
        function buildJarWalls() {
            if (jarWalls.length) { Composite.remove(engine.world, jarWalls); jarWalls = []; }
            const r = jarRect();
            const T = 14;
            const lx = r.x + r.w * SHAPE.bodyLeftX;
            const rx = r.x + r.w * SHAPE.bodyRightX;
            const by = r.y + r.h * SHAPE.bodyBottomY;
            const sy = r.y + r.h * SHAPE.shoulderY;
            const nlx = r.x + r.w * SHAPE.neckLeftX;
            const nrx = r.x + r.w * SHAPE.neckRightX;
            const nty = r.y + r.h * SHAPE.neckTopY;
            jarWalls.push(makeWall(lx + (rx - lx) / 2, by, rx - lx + T, T * 2));
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
            const n = Math.max(1, parseInt(count || g.repeatCount || 1, 10));
            const triggerAction = config.triggers && config.triggers[String(g.giftId)];
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
                for (let i = 0; i < n; i++) {
                    setTimeout(() => runTriggerAction(triggerAction, userInfo), i * 300);
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
                case 'gravflip': fxGravFlip(); break;
                case 'shake': shake(); break;
                case 'clear': clearAll(); break;
                case 'slow': fxSlow(); break;
                case 'crackJar': fxCrackJar(); break;
                case 'stealJar': fxStealJar(); break;
                case 'osin': triggerOsin(userInfo); break;
                case 'combo': fxCombo(userInfo); break;
            }
            // App broadcast cmd cho OBS replay cùng action (chỉ chạy ở authoritative mode)
            if (!mirrorMode) onTrigger(action, userInfo);
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

        function dropOne(g) {
            if (isJarFull()) return;
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
            const dy = r.y + r.h * SHAPE.neckTopY - sz - 200 - Math.random() * 80;
            const body = Bodies.circle(dx, dy, sz / 2, {
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
            Body.setVelocity(body, { x: (Math.random() - 0.5) * 3, y: Math.random() * 2 + 1 });
            Composite.add(engine.world, body);
            bodies.push(body);
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
            if (v >= 10000) { fxMegaboom(); if (config.features.audio) audio.fanfare(); }
            else if (v >= 1000) { fxFireworks(); if (config.features.audio) audio.big(); }
        }
        function checkGoal() {
            if (!config.features.goalBar || stats.goalReached) return updateGoalBar();
            if (config.goal.target > 0 && stats.totalDiamonds >= config.goal.target) {
                stats.goalReached = true;
                if (config.features.audio) audio.fanfare();
                fxFireworks(); fxFireworks();
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
        function clearAll() {
            if (bodies.length) Composite.remove(engine.world, bodies);
            bodies.length = 0;
            updateCountDisplay();
            onCountChange(0);
        }
        function fxFireworks() {
            const k = (config.effects?.fireworks?.intensity ?? 1);
            const r = jarRect();
            const count = Math.max(1, Math.round(3 * k));
            for (let i = 0; i < count; i++) {
                fxAnimations.push({
                    type: 'firework',
                    x: r.cx + (Math.random() - 0.5) * r.w * 0.7,
                    y: r.y + Math.random() * r.h * 0.4,
                    age: 0, life: 60,
                    color: `hsl(${Math.random() * 360},90%,60%)`
                });
            }
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
        function fxTilt() {
            const k = (config.effects?.tilt?.intensity ?? 1);
            engine.gravity.x = (Math.random() < 0.5 ? -0.6 : 0.6) * k;
            setTimeout(() => engine.gravity.x = 0, 4000);
        }
        function fxGravFlip() {
            const dur = (config.effects?.gravflip?.durationMs ?? 2200);
            engine.gravity.y = -Math.abs(engine.gravity.y);
            setTimeout(() => engine.gravity.y = Math.abs(config.physics.gravity), dur);
        }
        function fxTornado() {
            const k = (config.effects?.tornado?.intensity ?? 1);
            const r = jarRect();
            let t = 0;
            const TOTAL = 90;
            const iv = setInterval(() => {
                if (t++ > TOTAL) { clearInterval(iv); return; }
                const intensity = Math.sin((t / TOTAL) * Math.PI) * k;
                bodies.forEach(b => {
                    const dx = b.position.x - r.cx;
                    const dy = b.position.y - r.cy;
                    const dist = Math.max(Math.hypot(dx, dy), 1);
                    const nx = dx / dist, ny = dy / dist;
                    const tgX = -ny, tgY = nx;
                    const swirl = 8 * intensity * b.mass;
                    const suck = 2.5 * intensity * b.mass;
                    const lift = 2.2 * intensity * b.mass;
                    Body.setVelocity(b, {
                        x: b.velocity.x * 0.82 + tgX * swirl - nx * suck,
                        y: b.velocity.y * 0.82 + tgY * swirl - ny * suck - lift
                    });
                    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.4 * intensity);
                });
            }, 30);
        }
        function fxSlow() {
            const ts = (config.effects?.slow?.timeScale ?? 0.25);
            const dur = (config.effects?.slow?.durationMs ?? 3000);
            engine.timing.timeScale = ts;
            setTimeout(() => engine.timing.timeScale = 1, dur);
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
            const durSec = Math.max(3, config.effects?.stealJar?.durationSec ?? 8);
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
            const targets = [jarBottomEl, jarGlassEl, canvas, countDisplay].filter(Boolean);
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
            const stayMs = Math.max(800, durMs - (700 + flyMs + flyMs + 500));
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
        let goalEl, totalsEl, crownEl, lbEl, welcomeEl, comboToastEl, thiefLayer, caughtEl, forceEl;
        function ensureOverlayDom() {
            if (!overlayLayer) return;
            if (overlayLayer.dataset.thuytinhInit === '1') {
                goalEl = overlayLayer.querySelector('.tt-goal');
                totalsEl = overlayLayer.querySelector('.tt-totals');
                crownEl = overlayLayer.querySelector('.tt-crown');
                lbEl = overlayLayer.querySelector('.tt-leaderboard');
                caughtEl = overlayLayer.querySelector('.tt-caught');
                forceEl = overlayLayer.querySelector('.tt-force');
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
                        <div class="caught-name" title="${escAttr(c.name || 'Trộm')}">${escHtml(c.name || 'Trộm')}</div>
                        ${metaLine}
                        <div class="caught-actions">
                            <span class="caught-cd">${left}s</span>
                        </div>
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
            }
        }
        // Cho phép kéo thả 2 panel (chỉ trong preview app, overlay OBS thì static)
        let dragWired = false;
        function wireDragPanels() {
            if (dragWired) return;
            dragWired = true;
            overlayLayer.querySelectorAll('.tt-drag-panel').forEach(panel => {
                let dragging = false, startX, startY, baseLeft, baseTop;
                panel.style.pointerEvents = 'auto';
                panel.addEventListener('mousedown', (ev) => {
                    if (ev.button !== 0) return;
                    if (ev.target.closest('a, button, input, select, textarea')) return;
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
        const POLICE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <!-- Uniform body -->
            <path d="M 16 36 L 16 62 L 48 62 L 48 36 L 42 33 L 38 38 L 32 40 L 26 38 L 22 33 Z" fill="#1e3a8a"/>
            <!-- Tie strip -->
            <path d="M 30 36 L 34 36 L 33 56 L 32 58 L 31 56 Z" fill="#0c1e58"/>
            <!-- Lapels (V collar) -->
            <path d="M 22 33 L 32 42 L 26 38 Z" fill="#1d4ed8"/>
            <path d="M 42 33 L 32 42 L 38 38 Z" fill="#1d4ed8"/>
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
            <ellipse cx="32" cy="14" rx="14" ry="2.5" fill="#0c1e58"/>
            <!-- Cap crown -->
            <path d="M 21 14 L 22 6 Q 22 4 24.5 4 L 39.5 4 Q 42 4 42 6 L 43 14 Z" fill="#1d4ed8"/>
            <!-- Cap band -->
            <rect x="21" y="11" width="22" height="2.5" fill="#0c1e58"/>
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
                const preferInside = insideJar.length > 0 && Math.random() < 0.75;  // 75% prefer inside
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
            const pool = (insideJar.length && Math.random() < 0.75) ? insideJar : bodies;
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
            return `
<svg viewBox="0 0 80 140" xmlns="http://www.w3.org/2000/svg" class="osin-person">
  <!-- mũ -->
  <ellipse cx="40" cy="14" rx="14" ry="6" fill="#10b981"/>
  <rect x="29" y="6" width="22" height="10" rx="2" fill="#14b8a6"/>
  <!-- đầu -->
  <circle cx="40" cy="26" r="11" fill="#fde68a" stroke="#a16207" stroke-width="1"/>
  <!-- mắt -->
  <circle cx="36" cy="25" r="1.4" fill="#1f2937"/>
  <circle cx="44" cy="25" r="1.4" fill="#1f2937"/>
  <!-- miệng -->
  <path d="M36 31 Q40 33 44 31" stroke="#7c2d12" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  <!-- thân áo -->
  <rect x="26" y="38" width="28" height="38" rx="5" fill="#14b8a6"/>
  <rect x="26" y="38" width="28" height="8" rx="3" fill="#10b981"/>
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
  <!-- chân trái (animation đi bộ) -->
  <g class="osin-leg-left">
    <line x1="34" y1="76" x2="32" y2="110" stroke="#1e3a8a" stroke-width="8" stroke-linecap="round"/>
    <ellipse cx="32" cy="116" rx="9" ry="4" fill="#0f172a"/>
  </g>
  <!-- chân phải -->
  <g class="osin-leg-right">
    <line x1="46" y1="76" x2="48" y2="110" stroke="#1e3a8a" stroke-width="8" stroke-linecap="round"/>
    <ellipse cx="48" cy="116" rx="9" ry="4" fill="#0f172a"/>
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
            const personW = 12, personH = 16;
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
            if (config.gift.showCount && bodies.length > 0) {
                countDisplay.style.display = 'block';
                countDisplay.textContent = String(bodies.length);
                const r = jarRect();
                countDisplay.style.left = (r.cx / CANVAS_W * 100) + '%';
                // đặt trong hũ ở vị trí ~88% chiều cao để KHÔNG đè goal bar (dưới đáy hũ)
                countDisplay.style.top = ((r.y + r.h * 0.88) / CANVAS_H * 100) + '%';
                // tự co theo chiều cao hũ
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
            positionJar();
            // Cập nhật TẤT CẢ panel để pick up vị trí + scale mới từ config
            updateGoalBar(); updateLeaderboard(); updateSessionTotals(); updateCrown();
            updateCaughtList(); updatePoliceForcePanel();
            if (config.features.randomEvents) startRandomEvents(); else stopRandomEvents();
            if (config.features.thiefAuto) startThiefAuto(); else stopThiefAuto();
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
            updateGoalBar(); updateLeaderboard(); updateSessionTotals(); updateCrown();
            updateCaughtList(); updatePoliceForcePanel();
        }
        function serializeState() {
            return {
                totalDiamonds: stats.totalDiamonds,
                totalGifts: stats.totalGifts,
                tippers: Array.from(stats.tippers.entries()),
                seenGiftTypes: Array.from(stats.seenGiftTypes),
                caughtList: JSON.parse(JSON.stringify(stats.caughtList)),
                bannedUntilByUid: Array.from(bannedUntilByUid.entries()),
                policeForce: Array.from(policeForce.entries()),
                goalReached: !!stats.goalReached
            };
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
        if (config.features.randomEvents) startRandomEvents();
        if (config.features.thiefAuto) startThiefAuto();
        Runner.run(Runner.create(), engine);
        requestAnimationFrame(render);
        requestAnimationFrame(renderFx);

        return {
            drop, shake, clearAll, setConfig, getConfig, getStats, resetSession,
            getJarRect, setJarPosition,
            triggerThief, triggerOsin, setThiefAppearance, setPoliceAppearance,
            banThief, unbanThief, isThiefBanned, bailUser,
            serializeState, loadState,
            fxFireworks, fxMegaboom, fxTilt, fxGravFlip, fxTornado, fxSlow,
            fxCrackJar, fxStealJar, fxCombo,
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

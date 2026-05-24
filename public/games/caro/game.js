/* ============================================================
   HP Caro LIVE — engine + renderer (shared by app preview & OBS)
   ============================================================
   Exports: window.HpGame.caro.create({ canvas, config, mirrorMode })
   - mirrorMode: false → app preview (interactive, panel control)
   - mirrorMode: true  → OBS overlay (read-only render, follow snapshots)

   Stage: 1080×1920 (TikTok vertical). Canvas vẽ scale theo container.
   Game logic = state machine: setup → registration → picking → playing → roundEnd → matchEnd
   ============================================================ */
(function () {
    'use strict';

    const STAGE_W = 1080;
    const STAGE_H = 1920;

    // ---------- Coord helpers ----------
    function colLabel(c) { return String(c + 1); }                 // c=0 → "1"
    function rowLabel(r) { return String.fromCharCode(65 + r); }   // r=0 → "A"

    // Parse comment → {c, r} or null.
    //
    // RẤT LIBERAL — chỉ cần dò đúng góc là nhận. Hỗ trợ tất cả các pattern user
    // có thể gõ trên TikTok (bao gồm prefix chống chặn cmt):
    //
    //   ✓ 9F, F9, 9f, f9, 9F, F9                    (basic, in/sensitive case)
    //   ✓ @9F, @F9, @ 9F, @ F9, @f9, @ 9 F          (special-char prefix + space)
    //   ✓ #9F, *F9, .9F, !F9, ?9F, ★9F, 🎯9F        (ANY non-alphanumeric prefix)
    //   ✓ 9-F, F-9, 9.F, F_9, 9 - - F               (separator can be ANY non-alphanum)
    //   ✓ "đánh 9F nhé", ">>F9<<", "bấm vào 9 F"    (embedded trong câu)
    //   ✓ ９Ｆ, Ｆ９                                  (fullwidth Unicode digits/letters)
    //   ✗ "lol9Fhaha"                               (alphanum liền mạch — ambiguous, từ chối)
    //
    // Thuật toán:
    //   1. Normalize fullwidth → halfwidth
    //   2. Tách thành tokens theo bất kỳ ký tự non-alphanumeric (ai cũng là separator)
    //   3. Tìm token tự thân = "NL" (vd "9F") hoặc "LN" (vd "F9")
    //   4. Hoặc cặp token liền kề: NUM + LETTER hoặc LETTER + NUM
    //   5. Trả về coord ĐẦU TIÊN hợp lệ (trong bound bàn cờ)
    function parseCoord(text, cols, rows) {
        if (!text) return null;

        // === 1. Normalize fullwidth Unicode chars (０-９, Ａ-Ｚ, ａ-ｚ) ===
        let s = String(text);
        // Fullwidth digits 0xFF10-0xFF19 → 0x30-0x39
        s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        // Fullwidth letters A-Z (0xFF21-0xFF3A), a-z (0xFF41-0xFF5A)
        s = s.replace(/[Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));

        function makeCoord(numStr, letterStr) {
            const c = parseInt(numStr, 10) - 1;
            const r = letterStr.toUpperCase().charCodeAt(0) - 65;
            if (isNaN(c) || c < 0 || c >= cols || r < 0 || r >= rows) return null;
            return { c, r };
        }

        // === 2. Tokenize: tách bằng BẤT KỲ ký tự non-alphanumeric ===
        // → @, #, *, ., ,, !, ?, :, ;, space, dash, emoji, tab — tất cả đều là separator
        const tokens = s.split(/[^0-9a-zA-Z]+/).filter(t => t.length > 0);

        // === 3. Pass 1: token tự chứa NL hoặc LN ===
        for (const tok of tokens) {
            // "9F", "12F" pattern
            let m = /^(\d{1,2})([a-zA-Z])$/.exec(tok);
            if (m) {
                const c = makeCoord(m[1], m[2]);
                if (c) return c;
            }
            // "F9", "F12" pattern
            m = /^([a-zA-Z])(\d{1,2})$/.exec(tok);
            if (m) {
                const c = makeCoord(m[2], m[1]);
                if (c) return c;
            }
        }

        // === 4. Pass 2: cặp token liền kề (số liền chữ hoặc chữ liền số) ===
        for (let i = 0; i < tokens.length - 1; i++) {
            const a = tokens[i], b = tokens[i + 1];
            // num + letter
            if (/^\d{1,2}$/.test(a) && /^[a-zA-Z]$/.test(b)) {
                const c = makeCoord(a, b);
                if (c) return c;
            }
            // letter + num
            if (/^[a-zA-Z]$/.test(a) && /^\d{1,2}$/.test(b)) {
                const c = makeCoord(b, a);
                if (c) return c;
            }
        }

        return null;
    }

    // ---------- Threat detection ("đối thủ gần thắng không?") ----------
    // Quét tất cả nước CỦA `targetSide` ('idol' = Creator) tìm pattern nguy hiểm:
    //   - open-4: (winLength-1) quân liên tiếp, có ÍT NHẤT 1 đầu trống → thắng nước tới
    //   - open-3: (winLength-2) quân liên tiếp, CẢ 2 đầu trống → forced win
    // Trả về: { yes: bool, pattern: 'open-4'|'open-3'|null, line: [{c,r}, ...] | null, side: targetSide }
    function checkThreatForSide(moves, targetSide, cols, rows, winLength) {
        const placed = new Map();
        for (const m of moves) placed.set(`${m.c},${m.r}`, m.side);
        const isMine = (c, r) => placed.get(`${c},${r}`) === targetSide;
        const isEmpty = (c, r) => {
            if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
            return !placed.has(`${c},${r}`);
        };
        const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
        for (const m of moves) {
            if (m.side !== targetSide) continue;
            for (const [dc, dr] of dirs) {
                if (isMine(m.c - dc, m.r - dr)) continue;   // start chỉ ở stone đầu chuỗi
                let cc = m.c, rr = m.r;
                const line = [];
                while (isMine(cc, rr)) { line.push({ c: cc, r: rr }); cc += dc; rr += dr; }
                const len = line.length;
                if (len === 0 || len >= winLength) continue;
                const fwdOpen = isEmpty(cc, rr);
                const backOpen = isEmpty(m.c - dc, m.r - dr);
                if (len === winLength - 1 && (fwdOpen || backOpen)) {
                    return { yes: true, pattern: 'open-4', line, side: targetSide };
                }
                if (len === winLength - 2 && fwdOpen && backOpen) {
                    return { yes: true, pattern: 'open-3', line, side: targetSide };
                }
            }
        }
        return { yes: false, pattern: null, line: null, side: targetSide };
    }
    // Wrapper backwards-compat: chỉ check CREATOR (idol side)
    function checkCreatorThreat(moves, cols, rows, winLength) {
        return checkThreatForSide(moves, 'idol', cols, rows, winLength);
    }
    // Check BOTH sides — trả về threat đầu tiên tìm được (idol hoặc user)
    function checkAnyThreat(moves, cols, rows, winLength) {
        const idolThreat = checkThreatForSide(moves, 'idol', cols, rows, winLength);
        if (idolThreat.yes) return idolThreat;
        return checkThreatForSide(moves, 'user', cols, rows, winLength);
    }
    // === MATCH ANALYZER — replay moves, đếm "missed blocks" ===
    // Cho mỗi nước của side X, check TRƯỚC nước đó side đối thủ có threat.
    // Nếu yes + nước X không gần line threat → tính 1 missed block.
    function analyzeMatch(moves, cols, rows, winLength) {
        const result = { totalMoves: moves.length, missedByCreator: 0, missedByUser: 0, criticalMoves: [] };
        for (let i = 1; i < moves.length; i++) {
            const movesBefore = moves.slice(0, i);
            const playerMove = moves[i];
            const opponent = playerMove.side === 'idol' ? 'user' : 'idol';
            const oppThreat = checkThreatForSide(movesBefore, opponent, cols, rows, winLength);
            if (oppThreat.yes) {
                const blocks = (oppThreat.line || []).some(c =>
                    Math.abs(c.c - playerMove.c) + Math.abs(c.r - playerMove.r) <= 1
                );
                if (!blocks) {
                    result.criticalMoves.push({
                        moveIdx: i + 1,
                        side: playerMove.side,
                        threatPattern: oppThreat.pattern,
                        threatedBy: opponent
                    });
                    if (playerMove.side === 'idol') result.missedByCreator++;
                    else result.missedByUser++;
                }
            }
        }
        return result;
    }

    // ---------- Win detection ----------
    // Trả về { line: [{c,r}, ...] } nếu có winLength liên tiếp, ngược lại null.
    function detectWin(moves, side, lastMove, winLength) {
        if (!lastMove) return null;
        // Index 2D
        const placed = new Set();
        for (const m of moves) if (m.side === side) placed.add(m.c + ',' + m.r);
        if (!placed.has(lastMove.c + ',' + lastMove.r)) return null;

        const dirs = [[1,0],[0,1],[1,1],[1,-1]];
        for (const [dc, dr] of dirs) {
            const line = [{ c: lastMove.c, r: lastMove.r }];
            // forward
            let cc = lastMove.c + dc, rr = lastMove.r + dr;
            while (placed.has(cc + ',' + rr)) { line.push({ c: cc, r: rr }); cc += dc; rr += dr; }
            // backward
            cc = lastMove.c - dc; rr = lastMove.r - dr;
            while (placed.has(cc + ',' + rr)) { line.unshift({ c: cc, r: rr }); cc -= dc; rr -= dr; }
            if (line.length >= winLength) return { line: line.slice(0, winLength) };
        }
        return null;
    }

    // ---------- Default config ----------
    function defaultConfig() {
        return {
            board: { cols: 12, rows: 12, winLength: 5 },
            match: { bestOf: 3, idolFirst: true, alternateFirst: true },
            registration: { giftId: '', minCount: 1, autoCloseSeconds: 0 },
            undo: { window: 30, maxPerRound: 3, mode: 'idol', giftId: '', cooldown: 60 },
            turnTimer: 0,
            practiceMode: false,
            // Chế độ TÍCH ĐIỂM: mỗi bên giới hạn N quân trên bàn,
            // quá N → quân CŨ NHẤT của bên đó tự biến mất khi đặt quân mới.
            // Hợp với bàn nhỏ 3x3, 4x4 — biến caro thành game endless không hoà.
            rolling: { enabled: false, tokensPerSide: 3 },
            // SFX clips + match-end music do user upload
            audio: {
                enabled: true,
                volume: 50,
                clips: [],          // clips: [{ name, url }]
                winMusic: '',       // URL file phát khi CREATOR thắng
                loseMusic: '',      // URL file phát khi CREATOR thua
                drawMusic: ''       // URL file phát khi hoà
            },
            // Nhạc gay cấn — phát khi 1 trong 2 bên có open-4/open-3
            tenseMusic: { enabled: false, url: '' },
            // Tường chắn (walls) — đặt trước trận, tồn tại suốt match.
            // count = số tường tổng. Mỗi quà = 1 cơ hội user comment đặt 1 tường.
            // Creator cũng có thể click manual (tổng creator + user-via-gift ≤ count).
            walls: { enabled: false, giftId: '', count: 3 },
            // Sương mù — chỉ hiện N quân gần nhất, quân cũ ẩn/mờ
            // mode: 'always' (luôn ẩn) | 'gift' (kích hoạt khi tặng quà, áp dụng 1 lượt)
            fogOfWar: { enabled: false, mode: 'always', visibleCount: 5, giftId: '' },
            // Luật hôm nay — chỉ banner hiển thị, không đụng game logic.
            // Creator tự chọn preset HOẶC nhập custom text.
            dailyRule: { enabled: false, text: '' },
            // Đầu hàng — Creator concede, User thắng kèm badge "Honor Victory"
            surrender: { enabled: true, cooldownSec: 60 },
            // Crowd reactions — tiếng đám đông ooooh/cheer khi có threat/win
            crowd: { enabled: false },
            // TTS voice announcer — đọc các sự kiện game qua Web Speech API
            tts: {
                enabled: false,
                volume: 80,
                rate: 1.1,
                voice: '',                 // tên voice (vd 'Microsoft An Online (Natural)')
                events: {
                    move: false,           // đọc mỗi nước cờ (có thể spam)
                    win: true,             // đọc khi thắng/thua
                    roundStart: true,      // đọc khi hiệp bắt đầu
                    threat: true           // cảnh báo gần thắng
                }
            },
            // Nhạc nền — Web Audio synth (calm/arcade/epic/lofi/final) hoặc custom URL/file.
            music: { enabled: false, track: 'calm', volume: 30, customUrl: '', autoPlayOnRound: true },
            // Gợi ý "Tôi có sắp thua không?" — user tặng quà → check threat của CREATOR.
            // Cooldown per-user (giây) để chống spam khi nhiều user gửi cùng lúc.
            hint: { enabled: false, giftId: '', cooldownSec: 10, showSeconds: 3 },
            // User-undo bằng quà: sau khi User đánh, mở window N giây cho User tặng quà → hoàn nước.
            // Creator đặt quân trước → window đóng (Creator quá nhanh, User mất quyền hoàn).
            userUndo: { enabled: false, giftId: '', windowSec: 3 },
            // Chế độ AVATAR — thay quân tròn bằng ảnh đại diện TikTok user.
            // Creator side dùng creatorAvatar (config). Opponent side dùng profilePic từ TikTok.
            avatarMode: { enabled: false, creatorAvatar: '' },
            colors: { idol: '#25F4EE', user: '#FE2C55' },
            display: {
                showHistory: true, showInfo: true,
                scale: 100, xPercent: 50, yPercent: 50,
                // Mặc định cellHints BẬT với opacity 55% — đủ rõ trên OBS LIVE sau nén.
                cellHints: true, cellHintOpacity: 55
            }
        };
    }

    function defaultState() {
        return {
            phase: 'setup',                  // setup | registration | picking | playing | roundEnd | matchEnd
            match: {
                score: { idol: 0, user: 0 },
                currentRound: 1,
                // Tổng số nước đi từng phe qua TẤT CẢ các hiệp (cho tie-break)
                totalMoves: { idol: 0, user: 0 }
            },
            round: {
                idx: 1,
                moves: [],
                // Số nước riêng hiệp này (commit vào match.totalMoves khi hiệp kết thúc bằng win/draw)
                moveCount: { idol: 0, user: 0 },
                turn: 'idol',
                firstSide: 'idol',
                lastMoveTs: 0,
                undosUsed: 0,
                lastUndoTs: 0,
                winner: null,
                winLine: null,
                drawn: false   // true khi bàn đầy không ai thắng
            },
            registration: {
                open: false,
                entries: []                  // { uniqueId, nickname, profilePic, totalDiamond, registered }
            },
            opponent: null,                  // { uniqueId, nickname, profilePic, totalDiamond } — bên 'user' (pink)
            // Gợi ý "có đang sắp thua không"
            hint: {
                active: false,
                yes: false,
                pattern: null,               // 'open-4' | 'open-3'
                line: null,                  // [{c,r},...] line dangerous (để overlay highlight)
                triggeredBy: '',             // nickname user tặng quà
                expireAt: 0,                 // ms epoch — auto-clear khi expire
                userCooldown: {}             // uniqueId → ts của lần trigger gần nhất
            },
            // User-undo window: active sau khi User đánh, đóng khi Creator đánh hoặc expire.
            userUndo: {
                active: false,
                lastMove: null,              // { c, r, side, ts } — nước cờ User vừa đặt
                expireAt: 0                  // ms epoch
            },
            // Tường chắn — phase 'placing' diễn ra TRƯỚC khi vào 'playing'.
            walls: {
                phase: 'idle',               // 'idle' | 'placing' | 'ready'
                placedBy: '',                // uniqueId của user được chọn (chỉ user này comment đặt được)
                opportunitiesUser: 0,        // số quà đã tặng (= số cơ hội user còn lại để comment)
                cells: [],                   // [{c,r}] — ô đã có tường
                target: 0                    // tổng tường cần (= cfg.walls.count)
            },
            // Fog activation state — fog mode='gift' kích hoạt 1 lượt
            fog: {
                activeForNextMove: false,    // true → áp dụng cho nước kế tiếp
                triggeredBy: '',             // tên user kích hoạt
                visibleCountOverride: 0      // số quân hiện cho lượt này (0 = dùng cfg.fogOfWar.visibleCount)
            }
        };
    }

    // ---------- Main create ----------
    function create({ canvas, config, mirrorMode = false, hudHost = null }) {
        const ctx = canvas.getContext('2d');
        let cfg = mergeConfig(defaultConfig(), config || {});
        let state = defaultState();
        // Listeners (cho app panel react)
        // tap = canvas click (raw input, chưa có move) — chỉ app preview
        // placed = sau khi đặt quân thành công (post-place notification)
        // change = state thay đổi (UI sync)
        // win = round won
        // draw = bàn đầy, không ai thắng (chờ Idol quyết định)
        // sound = âm thanh cue (panel + overlay subscribe để play tone)
        // hint = banner "có sắp thua không" show/clear
        const listeners = { change: [], tap: [], placed: [], win: [], draw: [], sound: [], invalid: [], hint: [] };

        // === AVATAR cache ===
        // Cache Image objects để khỏi reload mỗi frame. URL → { img, loaded, error }
        const avatarCache = new Map();
        function getAvatar(url) {
            if (!url) return null;
            let entry = avatarCache.get(url);
            if (entry) return entry.loaded && !entry.error ? entry.img : null;
            entry = { img: new Image(), loaded: false, error: false };
            entry.img.crossOrigin = 'anonymous';
            entry.img.onload = () => { entry.loaded = true; };
            entry.img.onerror = () => { entry.error = true; };
            entry.img.src = url;
            avatarCache.set(url, entry);
            return null;
        }

        // === Text with outline — Vietnamese-safe + nét đều ===
        // ROOT FIX: dùng canvas filter drop-shadow → outline đều CẢ 4 phía,
        // không bị "nét thanh nét đậm" như multi-offset fill (1 hướng dày hơn).
        // Vẽ DUY NHẤT 1 fillText → filter tự tạo outline → diacritics Vietnamese render bình thường.
        function drawOutlinedText(text, x, y, fillColor, outlineColor, outlineWidth) {
            const w = Math.max(1, outlineWidth || 2);
            const oc = outlineColor || 'rgba(0,0,0,0.9)';
            ctx.save();
            // 4 lớp drop-shadow để outline ĐỀU 360° + đậm vừa đủ
            ctx.filter = `drop-shadow(0 0 ${w}px ${oc}) drop-shadow(0 0 ${w}px ${oc})`;
            ctx.fillStyle = fillColor;
            ctx.fillText(text, x, y);
            ctx.restore();
        }

        // --- Pixel sizing ---
        canvas.width = STAGE_W;
        canvas.height = STAGE_H;
        ctx.imageSmoothingEnabled = true;

        // Cursor preview (hover) — chỉ app preview, không bật ở OBS
        let hover = null;
        if (!mirrorMode) {
            canvas.addEventListener('mousemove', (ev) => {
                const cell = pickCell(ev);
                if (!cell) { hover = null; render(); return; }
                hover = cell;
                render();
            });
            canvas.addEventListener('mouseleave', () => { hover = null; render(); });
            canvas.addEventListener('click', (ev) => {
                const cell = pickCell(ev);
                if (!cell) return;
                // Raw tap event — app panel sẽ quyết định có placeStone hay không
                fire('tap', { cell });
            });
        }

        function pickCell(ev) {
            const rect = canvas.getBoundingClientRect();
            const sx = canvas.width / rect.width;
            const sy = canvas.height / rect.height;
            const px = (ev.clientX - rect.left) * sx;
            const py = (ev.clientY - rect.top) * sy;
            return pixelToCell(px, py);
        }

        // --- Board layout (computed) ---
        function boardLayout() {
            const cols = cfg.board.cols, rows = cfg.board.rows;
            // Bàn cờ chiếm vùng vuông giữa canvas
            const headerH = 200;
            const footerH = cfg.display.showHistory ? 200 : 80;
            // Dành margin cho coord labels (số trên + chữ trái)
            const labelMargin = 70;
            const availH = STAGE_H - headerH - footerH - labelMargin;
            const availW = STAGE_W - 80 - labelMargin; // padding hai bên + label trái
            const side = Math.min(availW, availH);
            const cellSize = Math.floor(side / Math.max(cols, rows));
            const boardW = cellSize * cols;
            const boardH = cellSize * rows;
            const ox = Math.floor((STAGE_W - boardW) / 2) + Math.floor(labelMargin / 2);
            // Center toàn bộ khối nội dung (header + labels + board + footer) theo chiều dọc.
            // Phần dư chia ĐỀU phía trên + phía dưới → bàn cờ không bị lệch trên/dưới.
            const totalUsed = headerH + labelMargin + boardH + footerH;
            const yShift = Math.max(0, Math.floor((STAGE_H - totalUsed) / 2));
            const oy = headerH + labelMargin + yShift;
            return { cols, rows, cellSize, ox, oy, boardW, boardH, headerH, footerH, yShift };
        }

        function cellToPixel(c, r) {
            const lay = boardLayout();
            return {
                x: lay.ox + c * lay.cellSize + lay.cellSize / 2,
                y: lay.oy + r * lay.cellSize + lay.cellSize / 2
            };
        }
        function pixelToCell(px, py) {
            const lay = boardLayout();
            if (px < lay.ox || px >= lay.ox + lay.boardW) return null;
            if (py < lay.oy || py >= lay.oy + lay.boardH) return null;
            const c = Math.floor((px - lay.ox) / lay.cellSize);
            const r = Math.floor((py - lay.oy) / lay.cellSize);
            if (c < 0 || c >= lay.cols || r < 0 || r >= lay.rows) return null;
            return { c, r };
        }

        // --- Rendering ---
        function render() {
            ctx.clearRect(0, 0, STAGE_W, STAGE_H);
            drawBackground();
            // matchEnd: banner thay thế header (KHÔNG vẽ header thường để tránh chồng)
            if (state.phase !== 'matchEnd') drawHeader();
            drawBoard();
            drawWalls();   // walls vẽ TRƯỚC stones, dưới lớp quân
            drawStones();
            drawWinLine();
            drawFooter();
            // Banner đặt tường (đang trong phase placing)
            if (state.walls?.phase === 'placing') drawWallPlacingBanner();
            if (state.phase === 'matchEnd') drawMatchEnd();
            // Banner ghi danh đã merge vào footer status — không vẽ banner riêng (tránh che cột labels).
            if (state.phase === 'roundEnd') drawRoundEnd();
            // Hint "có đang sắp thua không" — chỉ render khi active + chưa expire
            if (state.hint?.active && Date.now() < (state.hint.expireAt || 0)) drawHintBanner();
        }

        function drawBackground() {
            // Nền đen sâu trong suốt (overlay OBS chạy trong suốt, panel app sẽ phủ nền card)
            // Vẽ glow nền nhẹ bằng radial gradient
            const g = ctx.createRadialGradient(STAGE_W/2, STAGE_H/2, 100, STAGE_W/2, STAGE_H/2, 1100);
            g.addColorStop(0, 'rgba(37, 244, 238, 0.06)');
            g.addColorStop(0.55, 'rgba(254, 44, 85, 0.04)');
            g.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, STAGE_W, STAGE_H);
        }

        function drawHeader() {
            const lay = boardLayout();
            const yS = lay.yShift || 0;   // Shift cùng pha với board để header dính sát bàn cờ
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            // === Title — stroke outline đen + fill trắng → sắc nét trên OBS LIVE ===
            // Không dùng shadowBlur (làm mờ chữ khi nén video). Glow giữ ở mức thấp.
            ctx.font = '800 60px Inter, "Segoe UI", Arial, sans-serif';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 6;
            ctx.strokeText('HP CARO LIVE', STAGE_W / 2, 60 + yS);
            ctx.fillStyle = '#FFFFFF';
            ctx.shadowColor = 'rgba(37,244,238,0.65)';
            ctx.shadowBlur = 4;   // Glow nhẹ — không làm nhòe chữ
            ctx.fillText('HP CARO LIVE', STAGE_W / 2, 60 + yS);
            ctx.shadowBlur = 0;

            // Hiệp & tỉ số
            const bo = cfg.match.bestOf;
            const idolScore = state.match.score.idol;
            const userScore = state.match.score.user;
            const roundIdx = state.round.idx;

            // === Tỉ số: TEAM A 0 — 0 TEAM B + ID dưới ===
            const cyY = 130 + yS;
            const idolTxt = `🩵 TEAM A  ${idolScore}`;
            const vsTxt = `  —  `;
            const userTxt = `${userScore}  🩷 TEAM B`;

            const fontSide = '900 44px Inter, Arial, sans-serif';   // 900 đậm hơn để nét survive nén
            const fontVs = '800 30px Inter, Arial, sans-serif';
            // Đo độ rộng từng đoạn theo đúng font
            ctx.font = fontSide;
            const idolW = ctx.measureText(idolTxt).width;
            const userW = ctx.measureText(userTxt).width;
            ctx.font = fontVs;
            const vsW = ctx.measureText(vsTxt).width;
            const totalW = idolW + vsW + userW;
            const startX = Math.floor(STAGE_W / 2 - totalW / 2);

            // Vẽ stroke đen TRƯỚC cho cả 3 segment, rồi fill màu sau → outline đồng đều
            ctx.textAlign = 'left';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
            ctx.lineWidth = 5;
            ctx.font = fontSide;
            ctx.strokeText(idolTxt, startX, cyY);
            ctx.strokeText(userTxt, startX + idolW + vsW, cyY);
            ctx.font = fontVs;
            ctx.strokeText(vsTxt, startX + idolW, cyY);

            // CREATOR (left segment) — fill cyan
            ctx.font = fontSide;
            ctx.fillStyle = cfg.colors.idol;
            ctx.fillText(idolTxt, startX, cyY);
            // VS dash (middle) — fill trắng
            ctx.fillStyle = '#FFFFFF';
            ctx.font = fontVs;
            ctx.fillText(vsTxt, startX + idolW, cyY);
            // USER (right segment) — fill pink
            ctx.font = fontSide;
            ctx.fillStyle = cfg.colors.user;
            ctx.fillText(userTxt, startX + idolW + vsW, cyY);

            // Hiệp pill — bolder + stroke nhẹ cho rõ
            // Tên ID cụ thể dưới TEAM A / TEAM B
            const creatorId = (typeof window !== 'undefined' && window.__hostInfo?.uniqueId) ? `@${window.__hostInfo.uniqueId}` : '';
            const opId = state.opponent?.uniqueId ? `@${state.opponent.uniqueId}` : '';
            if (creatorId || opId) {
                ctx.font = '600 18px Inter, Arial, sans-serif';
                ctx.textAlign = 'center';
                const idLineY = 165 + yS;
                if (creatorId) {
                    drawOutlinedText(truncate(creatorId, 16), STAGE_W * 0.3, idLineY,
                        cfg.colors.idol, 'rgba(0,0,0,0.85)', 1.5);
                }
                if (opId) {
                    drawOutlinedText(truncate(opId, 16), STAGE_W * 0.7, idLineY,
                        cfg.colors.user, 'rgba(0,0,0,0.85)', 1.5);
                }
            }
            // Sub-line: HIỆP info
            ctx.font = '700 22px Inter, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 4;
            const subTxt = `HIỆP ${roundIdx} / BO${bo} · Win ${cfg.board.winLength} · ${cfg.board.cols}×${cfg.board.rows}`;
            ctx.strokeText(subTxt, STAGE_W / 2, 195 + yS);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillText(subTxt, STAGE_W / 2, 195 + yS);
            // Daily rule banner (nếu enabled + có text)
            if (cfg.dailyRule?.enabled && cfg.dailyRule?.text) {
                ctx.font = '800 22px Inter, Arial, sans-serif';
                drawOutlinedText('📜 LUẬT HÔM NAY: ' + cfg.dailyRule.text,
                    STAGE_W / 2, 200 + yS, '#FFD166', 'rgba(0,0,0,0.85)', 2);
            }
            ctx.restore();
        }

        function drawBoard() {
            const lay = boardLayout();
            ctx.save();
            // Backdrop card
            const padding = 12;
            roundRect(ctx, lay.ox - padding, lay.oy - padding, lay.boardW + padding * 2, lay.boardH + padding * 2, 16);
            ctx.fillStyle = 'rgba(15, 17, 26, 0.78)';
            ctx.fill();
            // Border glow
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(37, 244, 238, 0.5)';
            ctx.shadowColor = 'rgba(37, 244, 238, 0.55)';
            ctx.shadowBlur = 22;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Grid lines — TẤT CẢ đường đều như nhau (đậm đều)
            ctx.strokeStyle = 'rgba(180, 195, 220, 0.6)';
            ctx.lineWidth = 1.8;
            ctx.lineCap = 'square';
            for (let c = 0; c <= lay.cols; c++) {
                const x = Math.round(lay.ox + c * lay.cellSize) + 0.5;
                ctx.beginPath();
                ctx.moveTo(x, lay.oy);
                ctx.lineTo(x, lay.oy + lay.boardH);
                ctx.stroke();
            }
            for (let r = 0; r <= lay.rows; r++) {
                const y = Math.round(lay.oy + r * lay.cellSize) + 0.5;
                ctx.beginPath();
                ctx.moveTo(lay.ox, y);
                ctx.lineTo(lay.ox + lay.boardW, y);
                ctx.stroke();
            }

            // === CELL HINTS — toạ độ ở GIỮA mỗi ô ===
            // ROOT FIX độ nét OBS LIVE: stroke OUTLINE đen dày + fill trắng → cạnh chữ
            // sắc nét survive nén video TikTok 720p bitrate thấp.
            // Vẽ TRƯỚC stones để stones đè lên (không che chữ khi đã đặt quân).
            if (cfg.display.cellHints) {
                const hintOp = Math.max(0, Math.min(1, (cfg.display.cellHintOpacity ?? 35) / 100));
                if (hintOp > 0) {
                    ctx.save();
                    // Font to + đậm hơn để chống nén
                    const hintFontSize = Math.max(16, Math.round(lay.cellSize * 0.38));
                    ctx.font = `800 ${hintFontSize}px Inter, Arial, sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.lineJoin = 'round';
                    ctx.miterLimit = 2;
                    // Outline dày (3-4px) — màu đen đậm theo opacity user set
                    ctx.strokeStyle = `rgba(0, 0, 0, ${Math.min(1, hintOp + 0.35)})`;
                    ctx.lineWidth = Math.max(2.5, hintFontSize * 0.18);
                    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, hintOp + 0.25)})`;
                    for (let cc = 0; cc < lay.cols; cc++) {
                        for (let rr = 0; rr < lay.rows; rr++) {
                            const px = lay.ox + cc * lay.cellSize + lay.cellSize / 2;
                            const py = lay.oy + rr * lay.cellSize + lay.cellSize / 2;
                            const txt = `${cc + 1}${String.fromCharCode(65 + rr)}`;
                            ctx.strokeText(txt, px, py);
                            ctx.fillText(txt, px, py);
                        }
                    }
                    ctx.restore();
                }
            }

            // === Coord labels — stroke outline đen + fill trắng cho OBS LIVE ===
            // Bàn lớn (16x20) → labelSize nhỏ → cần stroke đậm để nét survive nén.
            const labelSize = Math.max(24, Math.min(40, Math.round(lay.cellSize * 0.55)));
            ctx.font = `900 ${labelSize}px Inter, Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
            ctx.lineWidth = Math.max(3, labelSize * 0.15);
            const labelGap = Math.max(30, labelSize * 0.95);
            // Vẽ stroke trước cho tất cả labels
            for (let c = 0; c < lay.cols; c++) {
                const x = lay.ox + c * lay.cellSize + lay.cellSize / 2;
                ctx.strokeText(colLabel(c), x, lay.oy - labelGap);
            }
            for (let r = 0; r < lay.rows; r++) {
                const y = lay.oy + r * lay.cellSize + lay.cellSize / 2;
                ctx.strokeText(rowLabel(r), lay.ox - labelGap, y);
            }
            // Fill trắng đậm
            ctx.fillStyle = '#FFFFFF';
            for (let c = 0; c < lay.cols; c++) {
                const x = lay.ox + c * lay.cellSize + lay.cellSize / 2;
                ctx.fillText(colLabel(c), x, lay.oy - labelGap);
            }
            for (let r = 0; r < lay.rows; r++) {
                const y = lay.oy + r * lay.cellSize + lay.cellSize / 2;
                ctx.fillText(rowLabel(r), lay.ox - labelGap, y);
            }

            // Hover preview (app side only)
            if (!mirrorMode && hover && state.phase === 'playing' && state.round.turn === 'idol') {
                const px = lay.ox + hover.c * lay.cellSize + lay.cellSize / 2;
                const py = lay.oy + hover.r * lay.cellSize + lay.cellSize / 2;
                ctx.fillStyle = cfg.colors.idol + '33';
                ctx.beginPath();
                ctx.arc(px, py, lay.cellSize * 0.4, 0, Math.PI * 2);
                ctx.fill();
                // Coord tooltip — TO hơn
                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.font = `900 ${Math.round(lay.cellSize * 0.4)}px Inter, Arial, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`${colLabel(hover.c)}${rowLabel(hover.r)}`, px, py);
            }
            ctx.restore();
        }

        // === WALLS — vẽ ô bị chặn bằng gạch xám ===
        function drawWalls() {
            if (!state.walls?.cells?.length) return;
            const lay = boardLayout();
            ctx.save();
            for (const w of state.walls.cells) {
                const x = lay.ox + w.c * lay.cellSize;
                const y = lay.oy + w.r * lay.cellSize;
                const pad = 3;
                // Background gạch xám
                ctx.fillStyle = 'rgba(60, 65, 80, 0.92)';
                ctx.shadowColor = 'rgba(255, 209, 102, 0.5)';
                ctx.shadowBlur = 12;
                ctx.fillRect(x + pad, y + pad, lay.cellSize - pad * 2, lay.cellSize - pad * 2);
                ctx.shadowBlur = 0;
                // Pattern gạch (4 ngói nhỏ)
                ctx.fillStyle = 'rgba(120, 130, 150, 0.5)';
                const half = (lay.cellSize - pad * 2) / 2;
                ctx.fillRect(x + pad, y + pad, half - 2, half - 2);
                ctx.fillRect(x + pad + half + 2, y + pad + half + 2, half - 2, half - 2);
                // Icon 🧱 ở giữa
                ctx.font = `${Math.floor(lay.cellSize * 0.55)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#FFD166';
                ctx.shadowColor = 'rgba(0,0,0,0.7)';
                ctx.shadowBlur = 4;
                ctx.fillText('🧱', x + lay.cellSize / 2, y + lay.cellSize / 2);
                ctx.shadowBlur = 0;
            }
            ctx.restore();
        }

        // === BANNER đặt tường — hiện trong phase 'placing' ===
        function drawWallPlacingBanner() {
            const lay = boardLayout();
            const cx = STAGE_W / 2;
            const cardY = 80;
            const cardH = 140;
            const cardW = STAGE_W - 100;
            const cardX = (STAGE_W - cardW) / 2;
            ctx.save();
            roundRect(ctx, cardX, cardY, cardW, cardH, 18);
            ctx.fillStyle = 'rgba(15, 20, 32, 0.94)';
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#FFD166';
            ctx.shadowColor = '#FFD166';
            ctx.shadowBlur = 24;
            ctx.stroke();
            ctx.shadowBlur = 0;

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Title
            ctx.font = '900 44px Inter, Arial, sans-serif';
            drawOutlinedText('🧱 ĐẶT TƯỜNG CHẮN', cx, cardY + 40, '#FFFFFF', 'rgba(0,0,0,0.9)', 2);
            // Counter
            const placed = state.walls.cells.length;
            const target = state.walls.target;
            const oppLeft = state.walls.opportunitiesUser;
            ctx.font = '700 28px Inter, Arial, sans-serif';
            drawOutlinedText(`${placed}/${target} tường — User còn ${oppLeft} cơ hội · Creator được click thêm`,
                cx, cardY + 90, '#FFD166', 'rgba(0,0,0,0.85)', 1.5);
            ctx.restore();
        }

        function drawStones() {
            const lay = boardLayout();
            const now = Date.now();
            ctx.save();

            // Rolling mode: tính quân SẮP MẤT của mỗi bên (cũ nhất khi đạt limit)
            let oldestIdolIdx = -1, oldestUserIdx = -1;
            if (cfg.rolling?.enabled) {
                const limit = cfg.rolling.tokensPerSide || 3;
                const idolMoves = [], userMoves = [];
                state.round.moves.forEach((m, i) => {
                    if (m.side === 'idol') idolMoves.push(i);
                    else userMoves.push(i);
                });
                if (idolMoves.length >= limit) oldestIdolIdx = idolMoves[0];
                if (userMoves.length >= limit) oldestUserIdx = userMoves[0];
            }

            // === AVATAR MODE — lấy URL avatar mỗi bên TỪ TIKTOK (auto) ===
            // idol side: host profile (Creator avatar từ TikTok connect)
            // user side: opponent.profilePic (từ chat/gift event TikTok)
            // FALLBACK: chưa có URL → vẽ chữ INITIAL từ nickname với viền màu side.
            const avatarMode = !!cfg.avatarMode?.enabled;
            const hostInfo = (typeof window !== 'undefined' && window.__hostInfo) || null;
            const hostPic = hostInfo?.profilePic || '';
            const idolAvatarUrl = avatarMode ? (hostPic || '') : '';
            const userAvatarUrl = avatarMode ? (state.opponent?.profilePic || '') : '';
            // Tên dùng để fallback INITIAL (nếu avatar chưa load)
            const idolName = hostInfo?.nickname || hostInfo?.uniqueId || 'CREATOR';
            const userName = state.opponent?.nickname || state.opponent?.uniqueId || 'USER';

            // === FOG OF WAR — chỉ vẽ N nước gần nhất ===
            // mode 'always': enabled luôn → áp dụng visibleCount
            // mode 'gift': chỉ active 1 lượt khi state.fog.activeForNextMove (kích hoạt qua quà)
            const fogEnabled = !!cfg.fogOfWar?.enabled;
            const fogMode = cfg.fogOfWar?.mode || 'always';
            let fogActive = false;
            let fogVisibleCount = Math.max(1, cfg.fogOfWar?.visibleCount || 5);
            if (fogEnabled) {
                if (fogMode === 'always') fogActive = true;
                else if (fogMode === 'gift' && state.fog?.activeForNextMove) {
                    fogActive = true;
                    if (state.fog.visibleCountOverride > 0) fogVisibleCount = state.fog.visibleCountOverride;
                }
            }
            const totalMoves = state.round.moves.length;
            const fogStartIdx = fogActive ? Math.max(0, totalMoves - fogVisibleCount) : 0;

            for (let i = 0; i < state.round.moves.length; i++) {
                // Skip nước cũ nếu fog enabled (giữ index để các tính toán khác vẫn đúng)
                if (i < fogStartIdx) continue;
                const m = state.round.moves[i];
                const isLast = i === state.round.moves.length - 1;
                const isFadingOut = (i === oldestIdolIdx || i === oldestUserIdx);
                const color = m.side === 'idol' ? cfg.colors.idol : cfg.colors.user;
                const px = lay.ox + m.c * lay.cellSize + lay.cellSize / 2;
                const py = lay.oy + m.r * lay.cellSize + lay.cellSize / 2;
                const radius = lay.cellSize * 0.42;

                // Stone với opacity giảm nếu sắp mất
                const stoneAlpha = isFadingOut ? 0.55 : 1;
                ctx.globalAlpha = stoneAlpha;

                // Glow
                ctx.shadowColor = color;
                ctx.shadowBlur = isLast ? 28 : 14;

                // === AVATAR? Vẽ ảnh circle-clipped với viền màu side ===
                const avatarUrl = m.side === 'idol' ? idolAvatarUrl : userAvatarUrl;
                const sideName = m.side === 'idol' ? idolName : userName;
                const img = avatarUrl ? getAvatar(avatarUrl) : null;
                if (avatarMode) {
                    // Viền màu side + glow (lúc nào cũng vẽ)
                    ctx.beginPath();
                    ctx.arc(px, py, radius + 2, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.shadowBlur = 0;
                    if (img) {
                        // Có avatar → clip + vẽ ảnh
                        ctx.save();
                        ctx.beginPath();
                        ctx.arc(px, py, radius - 1, 0, Math.PI * 2);
                        ctx.clip();
                        ctx.drawImage(img, px - radius, py - radius, radius * 2, radius * 2);
                        ctx.restore();
                    } else {
                        // FALLBACK: chưa có avatar → vẽ INITIAL từ nickname với BG đậm
                        // Background đậm (tối) bên trong viền màu side
                        ctx.beginPath();
                        ctx.arc(px, py, radius - 1, 0, Math.PI * 2);
                        const bgGrad = ctx.createRadialGradient(px - radius/3, py - radius/3, 2, px, py, radius);
                        bgGrad.addColorStop(0, 'rgba(40, 48, 70, 0.95)');
                        bgGrad.addColorStop(1, 'rgba(15, 20, 32, 0.98)');
                        ctx.fillStyle = bgGrad;
                        ctx.fill();
                        // INITIAL — chữ đầu tiên của nickname (loại bỏ @, emoji)
                        const cleanName = String(sideName || '?').replace(/^[@\s_.]+/, '').replace(/[^\p{L}\p{N}]/gu, '');
                        const initial = (cleanName || '?').charAt(0).toUpperCase();
                        ctx.fillStyle = color;
                        ctx.shadowColor = color;
                        ctx.shadowBlur = 8;
                        ctx.font = `900 ${Math.floor(radius * 1.15)}px Inter, Arial, sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(initial, px, py);
                        ctx.shadowBlur = 0;
                    }
                    // Đường viền màu side rõ nét (luôn vẽ trên cùng)
                    ctx.shadowBlur = isLast ? 28 : 14;
                    ctx.shadowColor = color;
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    ctx.arc(px, py, radius - 1, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    // Stone tròn truyền thống
                    const grad = ctx.createRadialGradient(px - radius/3, py - radius/3, 2, px, py, radius);
                    grad.addColorStop(0, lighten(color, 60));
                    grad.addColorStop(1, color);
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(px, py, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;

                // Rolling: vòng tròn nét đứt vàng quanh quân sắp mất
                if (isFadingOut) {
                    ctx.shadowBlur = 0;
                    ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
                    ctx.lineWidth = 2.5;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                // === Last-move indicator — ĐẬM + RÕ cho LIVE viewers ===
                // Double-ring: vòng trong tĩnh trắng + vòng ngoài chớp màu side
                if (isLast) {
                    ctx.shadowBlur = 0;
                    // 1) Vòng trong tĩnh — trắng đậm
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.arc(px, py, radius + 6, 0, Math.PI * 2);
                    ctx.stroke();

                    // 2) Vòng ngoài chớp pulse — màu side, glow mạnh
                    const t = (now / 500) % 1;                    // chu kỳ 500ms
                    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
                    const outerR = radius + 12 + pulse * 10;       // radius co giãn
                    const outerAlpha = 0.4 + 0.6 * pulse;
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 30;
                    ctx.strokeStyle = color.replace('#', '#') /* keep hex */;
                    // dùng rgba để alpha thay đổi
                    const rgb = hexToRgb(color);
                    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${outerAlpha})`;
                    ctx.lineWidth = 5;
                    ctx.beginPath();
                    ctx.arc(px, py, outerR, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                }

                // Undo-window indicator
                if (isLast && state.phase === 'playing' && cfg.undo.window > 0) {
                    const age = (now - m.ts) / 1000;
                    if (age < cfg.undo.window) {
                        const remain = 1 - age / cfg.undo.window;
                        ctx.shadowBlur = 0;
                        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(px, py, radius + 12, -Math.PI/2, -Math.PI/2 + Math.PI * 2 * remain);
                        ctx.stroke();
                    }
                }
            }
            ctx.shadowBlur = 0;
            ctx.restore();
        }

        function drawWinLine() {
            if (!state.round.winLine || state.round.winLine.length < 2) return;
            const lay = boardLayout();
            const first = state.round.winLine[0];
            const last = state.round.winLine[state.round.winLine.length - 1];
            const winner = state.round.winner;
            const color = winner === 'idol' ? cfg.colors.idol : cfg.colors.user;
            const p1 = { x: lay.ox + first.c * lay.cellSize + lay.cellSize/2, y: lay.oy + first.r * lay.cellSize + lay.cellSize/2 };
            const p2 = { x: lay.ox + last.c * lay.cellSize + lay.cellSize/2, y: lay.oy + last.r * lay.cellSize + lay.cellSize/2 };

            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 10;
            ctx.lineCap = 'round';
            ctx.shadowColor = color;
            ctx.shadowBlur = 30;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            ctx.restore();
        }

        function drawFooter() {
            const lay = boardLayout();
            const baseY = lay.oy + lay.boardH + 40;
            ctx.save();
            // Status line
            ctx.font = '700 32px Inter, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const turnColor = state.round.turn === 'idol' ? cfg.colors.idol : cfg.colors.user;
            let line = '';
            if (state.phase === 'setup') line = '⏸️ Đang cấu hình ván';
            else if (state.phase === 'registration') {
                const n = state.registration.entries.length;
                line = n > 0
                    ? `🏁 Đang ghi danh — ${n} người · gửi quà chỉ định`
                    : '🏁 Đang ghi danh — gửi quà chỉ định';
            }
            else if (state.phase === 'picking') line = '🎯 Idol đang chọn đối thủ...';
            else if (state.phase === 'playing') {
                const who = state.round.turn === 'idol' ? '🩵 Lượt TEAM A' : '🩷 Lượt TEAM B';
                // VD động theo bàn cờ (vd bàn 3x3 → 2B, bàn 12x12 → 9F)
                const exC = Math.min(Math.ceil(cfg.board.cols / 2) + 1, cfg.board.cols);
                const exR = Math.min(Math.ceil(cfg.board.rows / 2) + 1, cfg.board.rows);
                const example = `${exC}${rowLabel(exR - 1)}`;
                line = `${who} · Bình luận tọa độ (VD: ${example})`;
            }
            else if (state.phase === 'roundEnd') {
                const winner = state.round.winner === 'idol' ? '🩵 TEAM A' : '🩷 TEAM B';
                line = `🏆 ${winner} thắng hiệp ${state.round.idx}`;
            }

            ctx.fillStyle = (state.phase === 'playing') ? turnColor : '#FFFFFF';
            ctx.shadowColor = (state.phase === 'playing') ? turnColor : 'rgba(255,255,255,0.5)';
            ctx.shadowBlur = 12;
            ctx.fillText(line, STAGE_W / 2, baseY);
            ctx.shadowBlur = 0;

            // History
            if (cfg.display.showHistory && state.round.moves.length > 0) {
                ctx.font = '500 22px Inter, Arial, sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                const last5 = state.round.moves.slice(-5);
                const hist = last5.map((m, idx) => {
                    const num = state.round.moves.length - last5.length + idx + 1;
                    const tag = m.side === 'idol' ? '🩵' : '🩷';
                    return `${num}.${tag}${colLabel(m.c)}${rowLabel(m.r)}`;
                }).join('   ');
                ctx.fillText(hist, STAGE_W / 2, baseY + 56);
            }
            ctx.restore();
        }

        function drawRegistrationBanner() {
            const lay = boardLayout();
            const yS = lay.yShift || 0;
            ctx.save();
            // Top-right banner đếm số người đăng ký
            const text = `📋 ${state.registration.entries.length} người ghi danh`;
            ctx.font = '700 28px Inter, Arial, sans-serif';
            const w = ctx.measureText(text).width + 32;
            const x = STAGE_W - w - 24;
            const y = 240 + yS;
            roundRect(ctx, x, y, w, 50, 12);
            ctx.fillStyle = 'rgba(254, 44, 85, 0.85)';
            ctx.shadowColor = '#FE2C55';
            ctx.shadowBlur = 20;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#FFFFFF';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(text, x + w/2, y + 25);
            ctx.restore();
        }

        // === Hint banner — "TÔI CÓ ĐANG SẮP THUA KHÔNG? [CÓ/KHÔNG]" ===
        // Hiển thị to ở giữa bàn cờ, có stroke đen + glow màu kết quả.
        function drawHintBanner() {
            const lay = boardLayout();
            const yes = !!state.hint.yes;
            const triggeredBy = state.hint.triggeredBy || '';
            const cx = STAGE_W / 2;
            // Card NHỎ GỌN hơn — không che quá nhiều bàn cờ
            const cardH = 210;
            const cardW = Math.min(720, STAGE_W - 200);
            const cardX = (STAGE_W - cardW) / 2;
            const cardY = lay.oy + lay.boardH / 2 - cardH / 2;
            // === Bảng màu MỚI — dịu mắt, đẹp mềm ===
            // YES: warm coral pink (#FB7185 / rose-400) — vẫn cảnh báo nhưng không nhức mắt
            // NO: mint teal (#5EEAD4 / teal-300) — êm dịu, sang
            const accent = yes ? '#FB7185' : '#5EEAD4';
            const accentSoft = yes ? 'rgba(251, 113, 133, 0.18)' : 'rgba(94, 234, 212, 0.16)';
            const accentDeep = yes ? 'rgba(159, 18, 57, 0.35)' : 'rgba(15, 118, 110, 0.30)';

            ctx.save();
            // Highlight line nguy hiểm — màu dịu hơn (rose nhạt thay neon đỏ)
            if (yes && Array.isArray(state.hint.line)) {
                ctx.fillStyle = accentSoft;
                ctx.shadowColor = accent;
                ctx.shadowBlur = 14;
                for (const c of state.hint.line) {
                    const x = lay.ox + c.c * lay.cellSize;
                    const y = lay.oy + c.r * lay.cellSize;
                    ctx.fillRect(x + 2, y + 2, lay.cellSize - 4, lay.cellSize - 4);
                }
                ctx.shadowBlur = 0;
            }
            // Card backdrop — đổ bóng gradient nhẹ theo accent thay vì black tuyền
            roundRect(ctx, cardX, cardY, cardW, cardH, 22);
            // Background gradient: deep accent → near-black (subtle tint, không chói)
            const bgGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
            bgGrad.addColorStop(0, accentDeep);
            bgGrad.addColorStop(0.5, 'rgba(12, 14, 22, 0.96)');
            bgGrad.addColorStop(1, 'rgba(8, 10, 18, 0.98)');
            ctx.fillStyle = bgGrad;
            ctx.fill();
            // Border + glow MỀM (giảm shadowBlur 32 → 18)
            ctx.lineWidth = 4;
            ctx.strokeStyle = accent;
            ctx.shadowColor = accent;
            ctx.shadowBlur = 18;
            ctx.stroke();
            ctx.shadowBlur = 0;

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Câu hỏi
            ctx.font = '700 30px Inter, Arial, sans-serif';
            drawOutlinedText('ĐỐI THỦ CÓ ĐANG GẦN THẮNG?', cx, cardY + 38, 'rgba(255,255,255,0.95)', 'rgba(0,0,0,0.85)', 2);
            // Đáp án — nhỏ hơn (120 → 78), text TRẮNG + glow accent nhẹ
            ctx.font = '900 78px Inter, Arial, sans-serif';
            ctx.shadowColor = accent;
            ctx.shadowBlur = 10;
            drawOutlinedText(yes ? 'CÓ!' : 'KHÔNG', cx, cardY + 100, '#FFFFFF', 'rgba(0,0,0,0.85)', 2);
            ctx.shadowBlur = 0;
            // Sub-label — hiện tên bên đang gần thắng nếu yes
            ctx.font = '700 18px Inter, Arial, sans-serif';
            let subLabel = 'AN TOÀN — chơi tiếp';
            if (yes) {
                const sideName = state.hint.threatSide === 'idol' ? '🩵 TEAM A' : '🩷 TEAM B';
                subLabel = `${sideName} sắp thắng — Block ngay!`;
            }
            drawOutlinedText(subLabel, cx, cardY + 155, accent, 'rgba(0,0,0,0.8)', 1.5);
            // Triggered by
            if (triggeredBy) {
                ctx.font = '600 14px Inter, Arial, sans-serif';
                const tag = `📩 ${truncate(triggeredBy, 18)}${yes ? ' · ' + (state.hint.pattern || '') : ''}`;
                drawOutlinedText(tag, cx, cardY + 184, 'rgba(255,255,255,0.65)', 'rgba(0,0,0,0.75)', 1);
            }
            ctx.restore();
        }


        function drawRoundEnd() {
            // GIẢM dim (0.55 → 0.18) để bàn cờ + quân rõ hơn,
            // người xem LIVE thấy rõ pattern thắng để bình luận tranh luận
            const lay = boardLayout();
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(lay.ox - 12, lay.oy - 12, lay.boardW + 24, lay.boardH + 24);
            ctx.restore();
            drawWinLine();
        }

        function drawMatchEnd() {
            // === Banner KẾT QUẢ ở TRÊN, KHÔNG che bàn cờ ===
            // User cần thấy quân + đường thắng bên dưới để bình luận / tranh luận
            ctx.save();

            // Quyết định winner: 1) số hiệp thắng, 2) tie-break số nước
            const idolScore = state.match.score.idol;
            const userScore = state.match.score.user;
            const moves = state.match.totalMoves || { idol: 0, user: 0 };
            let winner, tieBreak = false;
            if (idolScore > userScore) winner = 'idol';
            else if (userScore > idolScore) winner = 'user';
            else {
                tieBreak = true;
                if (moves.idol < moves.user) winner = 'idol';
                else if (moves.user < moves.idol) winner = 'user';
                else winner = 'idol';
            }
            const color = winner === 'idol' ? cfg.colors.idol : cfg.colors.user;
            const name = winner === 'idol' ? 'TEAM A' : 'TEAM B';

            // Background card ở TOP của canvas (replace header area) — shift theo yShift
            const lay = boardLayout();
            const yS = lay.yShift || 0;
            const cardX = 30, cardY = 20 + yS;
            const cardW = STAGE_W - 60;
            const cardH = tieBreak ? 290 : 250;
            roundRect(ctx, cardX, cardY, cardW, cardH, 22);
            ctx.fillStyle = 'rgba(15, 17, 26, 0.82)';   // backdrop 82% — board phía dưới VẪN thấy
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 40;
            ctx.stroke();
            ctx.shadowBlur = 0;

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // Trophy + Title (cùng hàng)
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 26;
            ctx.font = '900 78px Inter, Arial, sans-serif';
            ctx.fillText('🏆 CHIẾN THẮNG', STAGE_W / 2, cardY + 70);
            ctx.shadowBlur = 0;

            // Winner name
            ctx.font = '800 56px Inter, Arial, sans-serif';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(name, STAGE_W / 2, cardY + 140);

            // Tỉ số + tổng nước trên 1 dòng (compact)
            ctx.font = '600 30px Inter, Arial, sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            const scoreLine = `Tỉ số: ${idolScore} – ${userScore}`;
            ctx.fillText(scoreLine, STAGE_W / 2, cardY + 190);

            // Move count split 2 màu
            ctx.font = '600 28px Inter, Arial, sans-serif';
            ctx.fillStyle = cfg.colors.idol;
            ctx.textAlign = 'right';
            ctx.fillText(`🩵 TEAM A ${moves.idol} nước`, STAGE_W / 2 - 16, cardY + 230);
            ctx.fillStyle = cfg.colors.user;
            ctx.textAlign = 'left';
            ctx.fillText(`🩷 TEAM B ${moves.user} nước`, STAGE_W / 2 + 16, cardY + 230);

            // Tie-break note (nếu có)
            if (tieBreak) {
                ctx.font = '700 22px Inter, Arial, sans-serif';
                ctx.fillStyle = '#FFD166';
                ctx.textAlign = 'center';
                ctx.fillText('⚡ Hoà điểm — thắng nhờ ít nước hơn', STAGE_W / 2, cardY + 270);
            }
            // Honor Victory badge (User thắng nhờ Creator surrender)
            if (state.round.surrenderedBy === 'idol' && winner === 'user') {
                ctx.font = '900 28px Inter, Arial, sans-serif';
                ctx.textAlign = 'center';
                drawOutlinedText('🏳️ HONOR VICTORY · TEAM A đầu hàng',
                    STAGE_W / 2, cardY + 270, '#FFD166', 'rgba(0,0,0,0.85)', 2);
            }
            ctx.restore();
        }

        // ---------- Public API ----------
        function setConfig(newCfg) {
            cfg = mergeConfig(cfg, newCfg || {});
            // === AUTO-CLAMP winLength theo kích thước bàn ===
            // Bàn 3x3 chỉ chơi được win=3. Bàn 4x4 win ≤ 4. Bàn lớn win ≤ 5 (chuẩn caro).
            // Tránh bug "đặt 3 quân thẳng hàng nhưng game không win vì winLength=5".
            const maxWin = Math.min(cfg.board.cols, cfg.board.rows);
            if (cfg.board.winLength > maxWin) {
                cfg.board.winLength = Math.max(3, maxWin);
                fire('change');   // báo UI cập nhật segmented control
            }
            render();
            fire('change');
        }

        function getConfig() { return JSON.parse(JSON.stringify(cfg)); }
        function getState() { return JSON.parse(JSON.stringify(state)); }

        function loadState(snap) {
            if (!snap || typeof snap !== 'object') return;
            // Track move delta cho sound cue (overlay nhận snapshot từ panel)
            const oldRoundIdx = state.round?.idx || 0;
            const oldMoveLen = state.round?.moves?.length || 0;
            // Migrate / merge defensively
            state = Object.assign(defaultState(), snap);
            state.match = Object.assign({ score: { idol: 0, user: 0 }, currentRound: 1 }, snap.match || {});
            state.round = Object.assign(defaultState().round, snap.round || {});
            state.registration = Object.assign(defaultState().registration, snap.registration || {});
            // Hint state — preserve cho overlay render banner
            state.hint = Object.assign(defaultState().hint, snap.hint || {});
            // Walls state — preserve cho overlay render gạch + banner
            state.walls = Object.assign(defaultState().walls, snap.walls || {});

            // Sound cue cho overlay: nếu hiệp đang chơi và có nước MỚI thêm vào
            if (mirrorMode) {
                const newRoundIdx = state.round.idx;
                const newMoveLen = state.round.moves.length;
                if (newRoundIdx === oldRoundIdx && newMoveLen > oldMoveLen) {
                    const last = state.round.moves[newMoveLen - 1];
                    if (last) fire('sound', { side: last.side, kind: 'place' });
                }
                // Win cue
                if (state.round.winner && !state.round.winLine) {
                    // edge: shouldn't happen but defensive
                } else if (state.round.winner) {
                    // chỉ play 1 lần khi nhận snap có winner mới
                    // (có thể phát lặp nếu reconnect, chấp nhận)
                }
            }
            render();
            fire('change');
        }

        // App side: place stone (tap idol hoặc comment user)
        function placeStone(c, r, side) {
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            if (state.round.turn !== side) return { ok: false, reason: 'not_turn' };
            if (state.round.winner) return { ok: false, reason: 'round_over' };
            // Out of bounds?
            if (c < 0 || c >= cfg.board.cols || r < 0 || r >= cfg.board.rows) return { ok: false, reason: 'oob' };
            // Có tường chắn?
            if (_isWalled(c, r)) return { ok: false, reason: 'walled' };
            // Occupied?
            if (state.round.moves.some(m => m.c === c && m.r === r)) return { ok: false, reason: 'occupied' };

            const move = { c, r, side, ts: Date.now() };
            state.round.moves.push(move);
            state.round.lastMoveTs = move.ts;
            // Tăng counter NỘI BỘ hiệp (chưa commit vào match.totalMoves)
            if (!state.round.moveCount) state.round.moveCount = { idol: 0, user: 0 };
            state.round.moveCount[side] = (state.round.moveCount[side] || 0) + 1;

            // === ROLLING MODE: nếu quá tokensPerSide, xoá quân CŨ NHẤT của bên này ===
            // Vô hiệu draw-detection (bàn không bao giờ đầy vì quân cũ tự mất).
            if (cfg.rolling?.enabled) {
                const limit = Math.max(1, cfg.rolling.tokensPerSide || 3);
                const sideMoves = state.round.moves.filter(m => m.side === side);
                while (sideMoves.length > limit) {
                    const oldest = sideMoves.shift();
                    const idx = state.round.moves.indexOf(oldest);
                    if (idx >= 0) state.round.moves.splice(idx, 1);
                }
            }

            // Sound cue trên cả app + overlay (Web Audio synth)
            fire('sound', { side, kind: 'place' });

            // Win check — clamp defensively (winLength không thể > min(cols, rows))
            const effectiveWinLen = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            const win = detectWin(state.round.moves, side, move, effectiveWinLen);
            if (win) {
                state.round.winner = side;
                state.round.winLine = win.line;
                state.phase = 'roundEnd';
                if (side === 'idol') state.match.score.idol += 1; else state.match.score.user += 1;
                // COMMIT moveCount of this round into match totalMoves
                if (!state.match.totalMoves) state.match.totalMoves = { idol: 0, user: 0 };
                state.match.totalMoves.idol += state.round.moveCount.idol;
                state.match.totalMoves.user += state.round.moveCount.user;
                render();
                fire('sound', { side, kind: 'win' });
                fire('win', { side, move, line: win.line });
                fire('change');
                // Check match end: BO3 cần 2, BO5 cần 3, BO7 cần 4
                const need = Math.floor(cfg.match.bestOf / 2) + 1;
                if (state.match.score.idol >= need || state.match.score.user >= need) {
                    state.phase = 'matchEnd';
                    render();
                    fire('change');
                }
                return { ok: true, move, win: true, winLine: win.line };
            }

            // === DRAW detection — bàn đầy không ai thắng ===
            // Rolling mode KHÔNG bao giờ draw (quân cũ tự mất → bàn không đầy)
            const totalCells = cfg.board.cols * cfg.board.rows;
            if (!cfg.rolling?.enabled && state.round.moves.length >= totalCells - state.walls.cells.length) {
                state.round.drawn = true;
                state.phase = 'draw';   // chờ Idol quyết định
                // Vẫn commit moveCount vào totalMoves (đã chơi → tính)
                if (!state.match.totalMoves) state.match.totalMoves = { idol: 0, user: 0 };
                state.match.totalMoves.idol += state.round.moveCount.idol;
                state.match.totalMoves.user += state.round.moveCount.user;
                render();
                fire('sound', { side: null, kind: 'draw' });
                fire('draw', { round: state.round.idx, isPractice: !!cfg.practiceMode });
                fire('change');
                return { ok: true, move, draw: true };
            }

            // === User-undo window: chỉ mở khi User vừa đánh, đóng ngay khi Creator đánh ===
            if (cfg.userUndo?.enabled && side === 'user') {
                state.userUndo.active = true;
                state.userUndo.lastMove = { ...move };
                state.userUndo.expireAt = Date.now() + (cfg.userUndo.windowSec || 3) * 1000;
            } else if (side === 'idol' && state.userUndo?.active) {
                // Creator đánh trước → window đóng (User mất quyền hoàn)
                state.userUndo.active = false;
                state.userUndo.lastMove = null;
                state.userUndo.expireAt = 0;
            }

            // === Clear fog gift-mode AFTER lượt vừa đi (fog chỉ áp dụng 1 lượt) ===
            if (cfg.fogOfWar?.mode === 'gift' && state.fog?.activeForNextMove) {
                state.fog.activeForNextMove = false;
                state.fog.visibleCountOverride = 0;
                state.fog.triggeredBy = '';
            }

            // Switch turn
            state.round.turn = side === 'idol' ? 'user' : 'idol';
            render();
            fire('placed', { side, cell: { c, r }, move });
            fire('change');
            return { ok: true, move };
        }

        // === User-undo bằng quà — gỡ nước cuối của User nếu window còn active ===
        // Gọi từ panel khi user tặng quà undo trong N giây sau khi đánh.
        // Phải đúng user vừa đánh (so sánh uniqueId vs opponent.uniqueId).
        function tryUserUndoByGift(userInfo) {
            if (!cfg.userUndo?.enabled) return { ok: false, reason: 'disabled' };
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            if (!state.userUndo?.active) return { ok: false, reason: 'no_window' };
            if (Date.now() > state.userUndo.expireAt) {
                state.userUndo.active = false;
                return { ok: false, reason: 'expired' };
            }
            // Chỉ opponent đã chọn mới hoàn được nước CỦA HỌ
            const uid = String(userInfo?.uniqueId || '').toLowerCase();
            const opUid = String(state.opponent?.uniqueId || '').toLowerCase();
            if (uid && opUid && uid !== opUid) return { ok: false, reason: 'not_opponent' };
            // Verify last move khớp với userUndo.lastMove
            const last = state.round.moves[state.round.moves.length - 1];
            const lm = state.userUndo.lastMove;
            if (!last || !lm || last.c !== lm.c || last.r !== lm.r || last.side !== 'user') {
                return { ok: false, reason: 'move_changed' };
            }
            // POP nước cuối
            state.round.moves.pop();
            state.round.moveCount.user = Math.max(0, (state.round.moveCount.user || 1) - 1);
            state.round.turn = 'user';   // Lượt quay lại User
            state.round.lastMoveTs = state.round.moves.length
                ? state.round.moves[state.round.moves.length - 1].ts : 0;
            // Đóng window
            state.userUndo.active = false;
            state.userUndo.lastMove = null;
            state.userUndo.expireAt = 0;
            render();
            fire('placed', { side: 'user', cell: { c: last.c, r: last.r }, move: last, undone: true });
            fire('change');
            return { ok: true, undone: last };
        }

        // === Reset hiệp HIỆN TẠI — không đụng score, không sang round mới ===
        // Dùng khi đánh nhầm, muốn chơi lại ván hiện tại từ đầu.
        // moveCount của hiệp bị clear (chưa commit vào totalMoves) → coi như ván này chưa diễn ra.
        function resetCurrentRound() {
            const firstSide = state.round.firstSide || (cfg.match.idolFirst ? 'idol' : 'user');
            const idx = state.round.idx || 1;
            state.round = {
                idx,
                moves: [],
                moveCount: { idol: 0, user: 0 },
                turn: firstSide,
                firstSide,
                lastMoveTs: 0,
                undosUsed: 0,
                lastUndoTs: 0,
                winner: null,
                winLine: null,
                drawn: false
            };
            state.phase = 'playing';
            render();
            fire('change');
        }

        // === DRAW handlers — Idol chọn 1 trong 3 sau khi bàn đầy ===
        function drawReplay() {
            // Đánh lại hiệp này — không commit moves vừa rồi
            if (state.phase !== 'draw') return false;
            // ROLLBACK totalMoves đã commit khi detect draw
            if (state.match.totalMoves && state.round.moveCount) {
                state.match.totalMoves.idol = Math.max(0, state.match.totalMoves.idol - state.round.moveCount.idol);
                state.match.totalMoves.user = Math.max(0, state.match.totalMoves.user - state.round.moveCount.user);
            }
            resetCurrentRound();
            return true;
        }
        function drawHalfPoint() {
            // Tính hoà 0.5-0.5, sang hiệp sau
            if (state.phase !== 'draw') return false;
            state.match.score.idol += 0.5;
            state.match.score.user += 0.5;
            state.phase = 'roundEnd';
            // Check match end
            const need = Math.floor(cfg.match.bestOf / 2) + 1;
            if (state.match.score.idol >= need || state.match.score.user >= need) {
                state.phase = 'matchEnd';
            }
            render();
            fire('change');
            return true;
        }
        function drawEndMatch() {
            // Kết thúc match LUÔN — tỉ số hiện tại quyết định winner (tie-break theo moves)
            if (state.phase !== 'draw') return false;
            state.phase = 'matchEnd';
            render();
            fire('change');
            return true;
        }

        // === CHẾ ĐỘ CHƠI THỬ — tap luân phiên 2 màu, không cần ghi danh / opponent ===
        // Mỗi tap đặt 1 quân với màu của lượt hiện tại, rồi tự toggle sang phe kia.
        // Win-detection vẫn hoạt động bình thường.
        function practicePlace(c, r) {
            // Auto-init nếu chưa ở pha chơi
            if (state.phase !== 'playing') {
                state = defaultState();
                state.phase = 'playing';
                state.round.idx = 1;
                state.round.turn = cfg.match.idolFirst ? 'idol' : 'user';
                state.round.firstSide = state.round.turn;
                // Tạo opponent giả để header hiện đẹp
                state.opponent = { uniqueId: '__practice__', nickname: 'CHƠI THỬ', profilePic: '', totalDiamond: 0 };
            }
            // Đặt theo lượt hiện tại
            const side = state.round.turn;
            return placeStone(c, r, side);
        }
        // Reset ván chơi thử (giữ cấu hình)
        function practiceReset() {
            state = defaultState();
            state.phase = 'playing';
            state.round.idx = 1;
            state.round.turn = cfg.match.idolFirst ? 'idol' : 'user';
            state.round.firstSide = state.round.turn;
            state.opponent = { uniqueId: '__practice__', nickname: 'CHƠI THỬ', profilePic: '', totalDiamond: 0 };
            render();
            fire('change');
        }

        // Hoàn nước cuối
        function undoLastMove() {
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            if (state.round.moves.length === 0) return { ok: false, reason: 'empty' };
            if (state.round.undosUsed >= cfg.undo.maxPerRound && cfg.undo.maxPerRound > 0) {
                return { ok: false, reason: 'limit_reached' };
            }
            const last = state.round.moves[state.round.moves.length - 1];
            const ageSec = (Date.now() - last.ts) / 1000;
            if (cfg.undo.window > 0 && ageSec > cfg.undo.window) {
                return { ok: false, reason: 'window_expired' };
            }
            // Cooldown
            if (cfg.undo.cooldown > 0 && state.round.lastUndoTs) {
                const sinceUndo = (Date.now() - state.round.lastUndoTs) / 1000;
                if (sinceUndo < cfg.undo.cooldown) {
                    return { ok: false, reason: 'cooldown', remain: Math.ceil(cfg.undo.cooldown - sinceUndo) };
                }
            }
            state.round.moves.pop();
            state.round.undosUsed += 1;
            state.round.lastUndoTs = Date.now();
            // Turn quay lại phe vừa đánh
            state.round.turn = last.side;
            state.round.lastMoveTs = state.round.moves.length ? state.round.moves[state.round.moves.length-1].ts : 0;
            render();
            fire('change');
            return { ok: true, undone: last };
        }

        // Comment từ user
        function trySubmitFromComment(text, uniqueId) {
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            if (state.round.turn !== 'user') return { ok: false, reason: 'not_user_turn' };
            if (!state.opponent || state.opponent.uniqueId !== uniqueId) return { ok: false, reason: 'not_opponent' };
            const coord = parseCoord(text, cfg.board.cols, cfg.board.rows);
            if (!coord) return { ok: false, reason: 'parse_fail' };
            return placeStone(coord.c, coord.r, 'user');
        }

        // ---------- Registration ----------
        function openRegistration() {
            state.phase = 'registration';
            state.registration.open = true;
            state.registration.entries = [];
            render();
            fire('change');
        }
        function closeRegistration() {
            state.registration.open = false;
            render();
            fire('change');
        }
        // === HINT — User tặng quà chỉ định, hỏi "Creator có đang sắp thua không?" ===
        // Trả về: { ok, yes, pattern } hoặc { ok: false, reason }
        function requestThreatHint(userInfo) {
            if (!cfg.hint?.enabled) return { ok: false, reason: 'disabled' };
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            // Cooldown per-user
            const uid = userInfo?.uniqueId || 'unknown';
            const now = Date.now();
            if (!state.hint.userCooldown) state.hint.userCooldown = {};
            const lastTs = state.hint.userCooldown[uid] || 0;
            const cdMs = (cfg.hint?.cooldownSec || 10) * 1000;
            if (now - lastTs < cdMs) {
                return { ok: false, reason: 'cooldown', remain: Math.ceil((cdMs - (now - lastTs)) / 1000) };
            }
            state.hint.userCooldown[uid] = now;
            // Detect threat
            const effWin = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            // Check BOTH sides — popup hiển thị CÓ nếu bên nào gần thắng (idol HOẶC user)
            const result = checkAnyThreat(state.round.moves, cfg.board.cols, cfg.board.rows, effWin);
            // Show banner
            const showMs = (cfg.hint?.showSeconds || 3) * 1000;
            state.hint.active = true;
            state.hint.yes = !!result.yes;
            state.hint.pattern = result.pattern;
            state.hint.line = result.line;
            state.hint.threatSide = result.side || null;   // 'idol' | 'user' bên đang gần thắng
            state.hint.triggeredBy = userInfo?.nickname || uid;
            state.hint.expireAt = now + showMs;
            render();
            fire('hint', { yes: result.yes, pattern: result.pattern, triggeredBy: state.hint.triggeredBy, phase: 'show' });
            fire('change');
            // Auto-clear sau showSeconds
            setTimeout(() => {
                if (state.hint && state.hint.expireAt <= Date.now()) {
                    state.hint.active = false;
                    state.hint.line = null;
                    render();
                    fire('hint', { phase: 'clear' });
                    fire('change');
                }
            }, showMs + 50);
            return { ok: true, yes: result.yes, pattern: result.pattern };
        }

        function addGift(g, isRegistrationGift) {
            if (state.phase !== 'registration' && state.phase !== 'picking') {
                // chỉ tính gift trong reg phase, NHƯNG cũng cho phép cộng điểm "tip" trong picking
            }
            if (!state.registration.open && state.phase !== 'picking') return;
            const uid = g.uniqueId || 'unknown';
            let entry = state.registration.entries.find(e => e.uniqueId === uid);
            const diamond = (Number(g.coinValue) || 1) * (Number(g.repeatCount) || 1);
            if (!entry) {
                if (!isRegistrationGift) return; // chưa ghi danh thì gift khác bỏ qua
                entry = {
                    uniqueId: uid,
                    nickname: g.nickname || uid,
                    profilePic: g.profilePicture || '',
                    totalDiamond: 0,
                    registeredAt: Date.now()
                };
                state.registration.entries.push(entry);
            }
            entry.totalDiamond += diamond;
            // Re-sort
            state.registration.entries.sort((a, b) => b.totalDiamond - a.totalDiamond);
            render();
            fire('change');
        }

        function pickOpponent(uniqueId) {
            const entry = state.registration.entries.find(e => e.uniqueId === uniqueId);
            if (!entry) return false;
            state.opponent = {
                uniqueId: entry.uniqueId,
                nickname: entry.nickname,
                profilePic: entry.profilePic,
                totalDiamond: entry.totalDiamond
            };
            // Nếu walls enabled → vào phase placing TRƯỚC khi vào playing
            if (cfg.walls?.enabled && state.walls.phase === 'idle') {
                wallStart(entry.uniqueId);
            } else {
                state.phase = 'playing';
                startRound(1);
            }
            return true;
        }

        // === FREE-ID — bỏ qua ghi danh, chọn đối thủ theo ID nhập tay ===
        // Dùng khi Idol muốn đấu với 1 user cụ thể mà không cần họ tặng quà ghi danh.
        // uniqueId = TikTok @username (so sánh insensitive với chat.uniqueId khi đặt nước).
        function pickOpponentManual(uniqueId, nickname) {
            const uid = String(uniqueId || '').trim().replace(/^@+/, '').toLowerCase();
            if (!uid) return false;
            state.opponent = {
                uniqueId: uid,
                nickname: String(nickname || uid).trim() || uid,
                profilePic: '',
                totalDiamond: 0
            };
            // Nếu walls enabled → vào phase placing trước khi playing
            if (cfg.walls?.enabled && state.walls.phase === 'idle') {
                wallStart(uid);
            } else {
                state.phase = 'playing';
                startRound(1);
            }
            return true;
        }

        // ============================================================
        // TƯỜNG CHẮN — đặt trước trận, tồn tại suốt match
        // ============================================================
        // Khi opponent vừa được pick, nếu walls.enabled → vào phase 'placing'.
        // - Mỗi quà chỉ định tới → wallsAddGiftOpportunity(uid) tăng opportunitiesUser
        //   (chỉ designated user mới đặt được; user khác tặng tăng cơ hội cho designated user)
        // - User comment toạ độ → wallPlace(c, r, 'user-comment')
        // - Creator click manual → wallPlace(c, r, 'creator-click') (không cần quà)
        // - Khi len(cells) === target → walls.phase = 'ready', tự startRound
        function wallStart(designatedUid) {
            state.walls.phase = 'placing';
            state.walls.placedBy = String(designatedUid || '').toLowerCase().replace(/^@+/, '');
            state.walls.opportunitiesUser = 0;
            state.walls.cells = [];
            state.walls.target = Math.max(1, Math.min(10, cfg.walls?.count || 3));
            render();
            fire('walls', { phase: 'placing', target: state.walls.target });
            fire('change');
        }
        function wallAddGiftOpportunity(uid) {
            // Quà chỉ định tới → tăng cơ hội cho user được chọn
            if (state.walls.phase !== 'placing') return { ok: false, reason: 'not_placing' };
            if (state.walls.cells.length >= state.walls.target) return { ok: false, reason: 'full' };
            state.walls.opportunitiesUser += 1;
            render();
            fire('walls', { phase: 'opportunity', from: uid, opportunitiesUser: state.walls.opportunitiesUser });
            fire('change');
            return { ok: true };
        }
        function wallPlace(c, r, source) {
            if (state.walls.phase !== 'placing') return { ok: false, reason: 'not_placing' };
            if (c < 0 || c >= cfg.board.cols || r < 0 || r >= cfg.board.rows) return { ok: false, reason: 'oob' };
            // Ô đã có tường?
            if (state.walls.cells.some(w => w.c === c && w.r === r)) return { ok: false, reason: 'already_walled' };
            // Source 'user-comment' cần opportunitiesUser > 0
            if (source === 'user-comment') {
                if (state.walls.opportunitiesUser <= 0) return { ok: false, reason: 'no_opportunity' };
                state.walls.opportunitiesUser -= 1;
            }
            // Source 'creator-click' không cần opportunity (Creator được click trực tiếp,
            // nhưng vẫn giới hạn bởi target tổng)
            // Check tổng walls đã đạt target
            if (state.walls.cells.length >= state.walls.target) return { ok: false, reason: 'full' };
            state.walls.cells.push({ c, r });
            // Nếu đã đủ target → ready, auto-startRound
            if (state.walls.cells.length >= state.walls.target) {
                state.walls.phase = 'ready';
                // Auto-start match nếu opponent đã có
                if (state.opponent && state.phase !== 'playing') {
                    state.phase = 'playing';
                    startRound(1);
                }
                fire('walls', { phase: 'ready', cells: state.walls.cells });
            } else {
                fire('walls', { phase: 'placed', c, r, source, remaining: state.walls.target - state.walls.cells.length });
            }
            render();
            fire('change');
            return { ok: true };
        }
        // Helper: kiểm tra ô có wall không (placeStone dùng)
        function _isWalled(c, r) {
            return state.walls?.cells?.some(w => w.c === c && w.r === r);
        }

        // === FOG — kích hoạt sương mù 1 lượt qua quà ===
        function fogActivate(userInfo, visibleCount) {
            if (!cfg.fogOfWar?.enabled || cfg.fogOfWar?.mode !== 'gift') return { ok: false, reason: 'not_gift_mode' };
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            const maxAllowed = Math.floor((cfg.board.cols * cfg.board.rows) / 2);
            const count = visibleCount
                ? Math.max(1, Math.min(maxAllowed, visibleCount))
                : (cfg.fogOfWar.visibleCount || 5);
            state.fog.activeForNextMove = true;
            state.fog.visibleCountOverride = count;
            state.fog.triggeredBy = userInfo?.nickname || userInfo?.uniqueId || '';
            render();
            fire('change');
            return { ok: true, count };
        }

        // Auto-update profilePic của opponent từ chat events (Free-ID flow)
        function _setOpponentAvatar(uniqueId, profilePic) {
            const uid = String(uniqueId || '').toLowerCase();
            if (state.opponent && (state.opponent.uniqueId || '').toLowerCase() === uid) {
                if (state.opponent.profilePic !== profilePic) {
                    state.opponent.profilePic = profilePic;
                    render();
                    fire('change');
                }
            }
        }

        function startRound(idx) {
            const first = decideFirstTurn(idx);
            state.round = {
                idx: idx,
                moves: [],
                moveCount: { idol: 0, user: 0 },
                turn: first,
                firstSide: first,
                lastMoveTs: 0,
                undosUsed: 0,
                lastUndoTs: 0,
                winner: null,
                winLine: null,
                drawn: false
            };
            state.match.currentRound = idx;
            state.phase = 'playing';
            render();
            fire('change');
        }

        function decideFirstTurn(roundIdx) {
            const base = cfg.match.idolFirst ? 'idol' : 'user';
            if (!cfg.match.alternateFirst) return base;
            // Đổi mỗi hiệp
            return (roundIdx % 2 === 1) ? base : (base === 'idol' ? 'user' : 'idol');
        }

        function nextRound() {
            if (state.phase === 'matchEnd') return false;
            startRound(state.round.idx + 1);
            return true;
        }

        function resetMatch(keepOpponent) {
            const op = keepOpponent ? state.opponent : null;
            state = defaultState();
            state.opponent = op;
            if (op) {
                state.phase = 'playing';
                startRound(1);
            }
            render();
            fire('change');
        }

        function newGame() {
            state = defaultState();
            render();
            fire('change');
        }

        // === ĐẦU HÀNG — Creator concede match, User thắng có badge Honor Victory ===
        // Cooldown để chống troll (Creator không spam surrender liên tục).
        let _lastSurrenderTs = 0;
        function surrender() {
            if (!cfg.surrender?.enabled) return { ok: false, reason: 'disabled' };
            if (state.phase !== 'playing') return { ok: false, reason: 'not_playing' };
            const now = Date.now();
            const cdMs = (cfg.surrender?.cooldownSec || 60) * 1000;
            if (now - _lastSurrenderTs < cdMs) {
                return { ok: false, reason: 'cooldown', remain: Math.ceil((cdMs - (now - _lastSurrenderTs)) / 1000) };
            }
            _lastSurrenderTs = now;
            // User thắng kiểu surrender — same flow như placeStone win nhưng KHÔNG có winLine
            state.round.winner = 'user';
            state.round.winLine = null;
            state.round.surrenderedBy = 'idol';   // flag cho overlay render badge
            state.phase = 'roundEnd';
            state.match.score.user += 1;
            if (!state.match.totalMoves) state.match.totalMoves = { idol: 0, user: 0 };
            state.match.totalMoves.idol += state.round.moveCount.idol;
            state.match.totalMoves.user += state.round.moveCount.user;
            render();
            fire('sound', { side: 'user', kind: 'win' });
            fire('win', { side: 'user', surrender: true });
            fire('change');
            // Check match end
            const need = Math.floor(cfg.match.bestOf / 2) + 1;
            if (state.match.score.user >= need) {
                state.phase = 'matchEnd';
                render();
                fire('change');
            }
            return { ok: true };
        }

        // ---------- Render loop ----------
        let rafId = null;
        function loop() {
            render();
            rafId = requestAnimationFrame(loop);
        }
        loop();

        function destroy() {
            if (rafId) cancelAnimationFrame(rafId);
        }

        // ---------- Events ----------
        function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); }
        function fire(evt, payload) { (listeners[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); }

        // ---------- Helpers ----------
        function mergeConfig(base, over) {
            const out = JSON.parse(JSON.stringify(base));
            for (const k of Object.keys(over || {})) {
                if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
                    out[k] = Object.assign({}, out[k] || {}, over[k]);
                } else if (over[k] !== undefined) {
                    out[k] = over[k];
                }
            }
            return out;
        }

        function truncate(s, n) {
            s = String(s || '');
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        }
        function roundRect(c, x, y, w, h, r) {
            c.beginPath();
            c.moveTo(x + r, y);
            c.arcTo(x + w, y, x + w, y + h, r);
            c.arcTo(x + w, y + h, x, y + h, r);
            c.arcTo(x, y + h, x, y, r);
            c.arcTo(x, y, x + w, y, r);
            c.closePath();
        }
        function lighten(hex, pct) {
            const m = /^#?([0-9a-f]{6})$/i.exec(hex);
            if (!m) return hex;
            const n = parseInt(m[1], 16);
            let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
            r = Math.min(255, r + Math.round((255 - r) * pct / 100));
            g = Math.min(255, g + Math.round((255 - g) * pct / 100));
            b = Math.min(255, b + Math.round((255 - b) * pct / 100));
            return '#' + (r << 16 | g << 8 | b).toString(16).padStart(6, '0');
        }
        function hexToRgb(hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(hex);
            if (!m) return { r: 255, g: 255, b: 255 };
            const n = parseInt(m[1], 16);
            return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
        }

        // Expose internal for app panel to draw mini leaderboard (optional)
        return {
            // info
            getConfig, getState, defaultConfig: () => defaultConfig(),
            // setters
            setConfig, loadState,
            // gameplay
            placeStone, undoLastMove, trySubmitFromComment,
            practicePlace, practiceReset,
            // round flow
            resetCurrentRound,
            drawReplay, drawHalfPoint, drawEndMatch,
            // registration
            openRegistration, closeRegistration, addGift, pickOpponent, pickOpponentManual,
            _setOpponentAvatar,
            // Walls
            wallStart, wallAddGiftOpportunity, wallPlace,
            // Fog gift activation
            fogActivate,
            // Surrender
            surrender,
            // Match analyzer
            analyzeMatch: () => {
                const effWin = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
                return analyzeMatch(state.round.moves, cfg.board.cols, cfg.board.rows, effWin);
            },
            // hint "có đang thua không"
            requestThreatHint,
            // tense music — panel poll mỗi nước để start/stop nhạc gây cấn
            checkAnyThreat: () => {
                const effWin = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
                return checkAnyThreat(state.round.moves, cfg.board.cols, cfg.board.rows, effWin);
            },
            // user-undo bằng quà
            tryUserUndoByGift,
            // match flow
            startRound, nextRound, resetMatch, newGame,
            // helpers exposed
            parseCoord: (t) => parseCoord(t, cfg.board.cols, cfg.board.rows),
            cellToPixel,
            // events
            on,
            // teardown
            destroy
        };
    }

    // ----- Expose -----
    window.HpGame = window.HpGame || {};
    window.HpGame.caro = {
        create,
        defaultConfig
    };
})();

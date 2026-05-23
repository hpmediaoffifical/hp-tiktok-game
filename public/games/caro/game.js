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
            audio: { enabled: true, volume: 50 },
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
            opponent: null                   // { uniqueId, nickname, profilePic, totalDiamond }
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
        const listeners = { change: [], tap: [], placed: [], win: [], draw: [], sound: [], invalid: [] };

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
            drawStones();
            drawWinLine();
            drawFooter();
            if (state.phase === 'matchEnd') drawMatchEnd();
            // Banner ghi danh đã merge vào footer status — không vẽ banner riêng (tránh che cột labels).
            if (state.phase === 'roundEnd') drawRoundEnd();
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

            // === Tỉ số: căn giữa TOÀN BỘ cụm (CREATOR + score + — + score + USER) ===
            const cyY = 130 + yS;
            const userName = state.opponent?.nickname ? truncate(state.opponent.nickname, 12) : 'USER';
            const idolTxt = `🩵 CREATOR  ${idolScore}`;
            const vsTxt = `  —  `;
            const userTxt = `${userScore}  🩷 ${userName}`;

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
            ctx.font = '700 26px Inter, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 4;
            const subTxt = `HIỆP ${roundIdx} / BO${bo} · Win ${cfg.board.winLength} · ${cfg.board.cols}×${cfg.board.rows}`;
            ctx.strokeText(subTxt, STAGE_W / 2, 170 + yS);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillText(subTxt, STAGE_W / 2, 170 + yS);
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

            for (let i = 0; i < state.round.moves.length; i++) {
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
                // Stone
                const grad = ctx.createRadialGradient(px - radius/3, py - radius/3, 2, px, py, radius);
                grad.addColorStop(0, lighten(color, 60));
                grad.addColorStop(1, color);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(px, py, radius, 0, Math.PI * 2);
                ctx.fill();
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
                const who = state.round.turn === 'idol' ? '🩵 Lượt CREATOR' : `🩷 Lượt ${state.opponent?.nickname || 'USER'}`;
                // VD động theo bàn cờ (vd bàn 3x3 → 2B, bàn 12x12 → 9F)
                const exC = Math.min(Math.ceil(cfg.board.cols / 2) + 1, cfg.board.cols);
                const exR = Math.min(Math.ceil(cfg.board.rows / 2) + 1, cfg.board.rows);
                const example = `${exC}${rowLabel(exR - 1)}`;
                line = `${who} · Bình luận tọa độ (VD: ${example})`;
            }
            else if (state.phase === 'roundEnd') {
                const winner = state.round.winner === 'idol' ? '🩵 CREATOR' : `🩷 ${state.opponent?.nickname || 'USER'}`;
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
            const name = winner === 'idol' ? 'CREATOR' : (state.opponent?.nickname || 'USER');

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
            ctx.fillText(`🩵 CREATOR ${moves.idol} nước`, STAGE_W / 2 - 16, cardY + 230);
            ctx.fillStyle = cfg.colors.user;
            ctx.textAlign = 'left';
            ctx.fillText(`🩷 USER ${moves.user} nước`, STAGE_W / 2 + 16, cardY + 230);

            // Tie-break note (nếu có)
            if (tieBreak) {
                ctx.font = '700 22px Inter, Arial, sans-serif';
                ctx.fillStyle = '#FFD166';
                ctx.textAlign = 'center';
                ctx.fillText('⚡ Hoà điểm — thắng nhờ ít nước hơn', STAGE_W / 2, cardY + 270);
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
            // Occupied?
            if (state.round.moves.some(m => m.c === c && m.r === r)) return { ok: false, reason: 'occupied' };

            const move = { c, r, side, ts: Date.now() };
            state.round.moves.push(move);
            state.round.lastMoveTs = move.ts;
            // Tăng counter NỘI BỘ hiệp (chưa commit vào match.totalMoves)
            if (!state.round.moveCount) state.round.moveCount = { idol: 0, user: 0 };
            state.round.moveCount[side] = (state.round.moveCount[side] || 0) + 1;

            // === ROLLING MODE: nếu quá tokensPerSide, xoá quân CŨ NHẤT của bên này ===
            // Vô hiệu draw-detection (bàn không bao giờ đầy vì quân cũ tự mất)
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
            if (!cfg.rolling?.enabled && state.round.moves.length >= totalCells) {
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

            // Switch turn
            state.round.turn = side === 'idol' ? 'user' : 'idol';
            render();
            fire('placed', { side, cell: { c, r }, move });
            fire('change');
            return { ok: true, move };
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
            state.phase = 'playing';
            startRound(1);
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
            state.phase = 'playing';
            startRound(1);
            return true;
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

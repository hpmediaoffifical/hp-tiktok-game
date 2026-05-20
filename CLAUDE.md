# CLAUDE.md — Project instructions for Claude Code

> File này Claude **luôn đọc** khi mở session trong repo này. Đặt mọi context project-level cần thiết để Claude không hỏi lại / không vòng vo.

## 🚨 Trước khi chạy `node server.js` từ worktree — BẮT BUỘC

**Triệu chứng cần nhận diện ngay:** Activate key trên UI báo `"Hệ thống bản quyền chưa cấu hình — liên hệ HP Media"`, hoặc log server ra warning `[hpkey] WARNING: HMAC_SECRET trống`.

**Nguyên nhân:** Worktree thiếu file `hpkey/secret.local.js` (file gitignored, không nằm trong git history). Git worktree không share working-tree files giữa các checkout — file này chỉ có ở project gốc và Electron build, không tự copy sang worktree.

**Fix ngay, 1 lệnh, không cần debug code:**

```powershell
# PowerShell (Windows)
Copy-Item "C:\Users\NCPC\Desktop\HP Action LIVE\hpkey\secret.local.js" `
          ".\hpkey\secret.local.js"
```

```bash
# Bash
cp "/c/Users/NCPC/Desktop/HP Action LIVE/hpkey/secret.local.js" hpkey/secret.local.js
```

Rồi **restart Node server** (`require()` cache file lúc startup).

**Đừng nghi ngờ code mới làm hỏng license** — license code không thay đổi từ v1.0.64 trở đi. Nếu key fail trong worktree, nó là vấn đề secret file, không phải code regression.

## Kiến trúc nhanh

- **Electron app** (`electron-main.js`) bọc Express server (`server.js`) chạy localhost:3000.
- **TikTok Live Connector** (`tiktok-live-connector` v2) — kết nối realtime phòng LIVE qua `@username`.
- **OBS overlays** transparent 1080×1920 — mỗi game 1 URL riêng (`/overlay/<gameId>`).
- **Games hiện có:** `thuytinh` (hũ thủy tinh + vật lý Matter.js), `caro` (cờ caro tương tác), `pktiktok` (hiệu ứng PK), `vipwelcome` (chào VIP).
- **License system:** v1.0.64+ dùng `hpvn.media/hpkey/api.php` (HMAC + RSA). Trước đó dùng `hp-license.nguyenvu.dev/activate`. Endpoint cũ vẫn còn cho gift-sheet + auto-update.
- **License storage:** `%APPDATA%/hp-action-live/data/app-config.json` field `license`. Recheck mỗi 60s (`hpkey/config.js:RECHECK_SECONDS`).

## Convention khi thêm game mới

Mỗi game mới cần:
1. Folder `public/games/<id>/` chứa `game.js` (engine), `overlay.html` (OBS view), `<id>-panel.js` (panel controller).
2. Đăng ký trong `server.js` block `const GAMES = {...}` với `defaultConfig`, `overlayPath`.
3. Route `/overlay/<id>` trỏ tới `overlay.html`.
4. Section `<section id="view-<id>">` trong `public/index.html`.
5. Script tags + `openXxx()` handler trong `public/app.js`.
6. CSS namespace prefix `.<id>-*` trong `public/style.css`.
7. **Tránh route collision với `/api/games/:id/*`** — generic GET/POST `/state` và `/config` đã giữ chỗ. Đặt route riêng dưới namespace khác (vd `/api/<id>/*`).

## Versioning & Release

- Production releases lên branch riêng (`release-v1.0.XX-clean`), không trên main.
- Tags `vX.Y.Z` đánh trên branch release.
- Main branch ở phiên bản cũ hơn — đừng nhầm với tag mới nhất.
- File `package.json:version` phải khớp tag.
- Installer build qua `npm run build:win` → `dist/HP-Action-LIVE-Setup-X.Y.Z.exe`.

## Một số lệnh tiện

```powershell
# Verify license endpoint working trong dev:
$body = '{"key":"adminphung"}'
curl.exe -X POST http://localhost:3000/api/license/activate `
         -H "Content-Type: application/json" -d $body

# So sánh worktree branch với tag known-good:
git log --oneline v1.0.66..HEAD

# Tạo worktree mới + auto-copy secret (tránh lặp lỗi):
git worktree add ../new-feature -b feature-name
cp hpkey/secret.local.js ../new-feature/hpkey/
```

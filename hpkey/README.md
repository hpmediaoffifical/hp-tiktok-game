# HP KEY — License client

Module client cho hệ thống bản quyền HP Media (đặt tại `hpvn.media/hpkey/api.php`).
Áp dụng từ **v1.0.64** trở đi (thay thế license-server cũ `hp-license.nguyenvu.dev/activate`,
endpoint cũ vẫn được giữ cho gift-sheet + auto-update).

## Cấu trúc

```
hpkey/
├── config.js          — Cấu hình endpoint, HMAC secret loader, recheck interval
├── validate.js        — Hàm validateLicenseKey() — interface chính server.js gọi
├── hwid.js            — Sinh device fingerprint (HWID) cho binding 1 key ↔ N máy
├── public-key.js      — Public key RSA (PEM base64) để verify chữ ký token server
└── secret.local.js    — ⚠ HMAC_SECRET — GITIGNORED, KHÔNG push lên repo
```

## ⚠ Vấn đề `secret.local.js` mất trong git worktree

**Đây là pitfall thường gặp khi dùng Claude Code hoặc bất kỳ git worktree nào.**

`hpkey/secret.local.js` chứa HMAC_SECRET để ký request lên server hpkey. File này nằm trong
`.gitignore` (để không leak secret khi push public repo) → **không có trong git history** →
git worktree mới tạo (`git worktree add` hoặc Claude Code sandbox) sẽ **không có file này**.

**Triệu chứng:** Chạy `node server.js` từ worktree, nhập key bản quyền → app báo
`"Hệ thống bản quyền chưa cấu hình — liên hệ HP Media"` (thông điệp từ `hpkey/validate.js:122`
khi `cfg.HMAC_SECRET` rỗng hoặc bắt đầu bằng `DAN_`).

**Cách fix:** Copy file từ project gốc vào worktree đang chạy:

```powershell
# PowerShell
Copy-Item "C:\Users\NCPC\Desktop\HP Action LIVE\hpkey\secret.local.js" `
          "<worktree-path>\hpkey\secret.local.js"
```

```bash
# Bash
cp "C:/Users/NCPC/Desktop/HP Action LIVE/hpkey/secret.local.js" \
   "<worktree-path>/hpkey/secret.local.js"
```

Rồi **restart Node server** (vì `require()` cache file lúc startup).

> Lỗi này KHÔNG liên quan tới tính năng nào trong app code — nó là git-worktree gotcha. Trước khi đổ tại
> code mới, nhớ check `ls hpkey/secret.local.js` xem có file không. Bản Electron app đóng gói qua
> `electron-builder` luôn có file này bake-in (đọc từ project gốc lúc build), nên user cuối không
> bao giờ gặp lỗi này.

## Tạo `secret.local.js` lần đầu (cho máy build mới)

```js
'use strict';
// Lấy giá trị HMAC_SECRET từ admin hpvn.media/hpkey/admin (chỉ HP Media biết)
module.exports = {
    HMAC_SECRET: 'xxxx-xxxx-xxxx-xxxx-xxxx'
};
```

Hoặc set qua env var khi chạy: `HPKEY_HMAC=xxxx node server.js`.

## Endpoint flow

```
App (server.js → validateLicenseKey)
    ↓ POST /api/v1/activate  + body { key, hwid, product, ts, sig: HMAC(secret, body) }
hpvn.media/hpkey/api.php
    ↓ verify HMAC, check key trong DB
    ↓ ký token { key, role, expiry, vip } bằng RSA private key
    ← response { ok, key, role, vip, expiry, token, sig: RSA_sign(...) }
App
    ↓ verify sig bằng PUBLIC_KEY (hpkey/public-key.js)
    ↓ cache vào app-config.json — license.activated = true
    ↓ recheck mỗi 60s (RECHECK_SECONDS) — nếu admin revoke → re-prompt
```

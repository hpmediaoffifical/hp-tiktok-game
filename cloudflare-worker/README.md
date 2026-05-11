# HP Action LIVE — License Validation Worker (Cloudflare)

Cloudflare Worker xác thực key bản quyền cho HP Action LIVE — option đơn giản nhất.

## So sánh với license-server (Node.js standalone)

| | Cloudflare Worker | License Server (Node.js) |
|---|---|---|
| **Chi phí** | $0 (100K req/ngày) | $5/tháng VPS, hoặc $0 Render/Railway free |
| **Setup** | 5 phút | 15-30 phút |
| **Latency** | ~30ms (edge global) | ~100ms (1 region) |
| **Persistent state** | Không (cần KV add-on $5) | ✅ JSON file |
| **Admin dashboard** | Không có sẵn | ✅ Web UI included |
| **Device binding** | Phải code thêm | ✅ Built-in |
| **Audit log** | Cloudflare dashboard | ✅ File local |
| **Revoke instant** | Cần KV | ✅ Native |

→ Chọn Worker nếu chỉ cần validate đơn giản. Chọn license-server nếu cần dashboard + device binding + audit log.

## Tại sao cần Worker?

**Trước:** App fetch Google Sheet KEY_HP_GAME trực tiếp. Sheet ID hardcoded trong server.js → attacker `asar extract` thấy → curl sheet → tải toàn bộ key.

**Sau:** Sheet ID nằm trong Cloudflare Worker (secret env). App POST /activate {key} → Worker đọc sheet (server-side) → trả result. Attacker không thấy Sheet ID trong app.

→ Casual cracker không thể tải bulk key. Vẫn có thể patch app để bypass check (Tier 4 fix qua bytenode), nhưng đó là vấn đề chung của Electron.

## Yêu cầu

- Tài khoản Cloudflare miễn phí (https://dash.cloudflare.com/sign-up)
- Node.js 18+ trên máy local
- `wrangler` CLI: `npm install -g wrangler`

## Deploy

### Bước 1: Đăng nhập Cloudflare

```powershell
wrangler login
```

Browser sẽ mở → đăng nhập → cho phép Wrangler.

### Bước 2: Set Sheet ID secret

```powershell
cd cloudflare-worker
wrangler secret put SHEET_ID
```

Paste Google Sheet ID khi được hỏi (vd: `1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M`).

### Bước 3: Deploy

```powershell
wrangler deploy
```

Output:
```
Published hp-license (1.2 sec)
  https://hp-license.your-username.workers.dev
```

Copy URL.

### Bước 4: Update server.js của app electron

Mở `<project root>/server.js`:

```js
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://hp-license.your-username.workers.dev';   // ← URL từ bước 3
```

### Bước 5: Đặt Google Sheet private (optional)

Để tăng bảo mật, đặt sheet PRIVATE (chỉ owner đọc). Nhưng vì Worker dùng public CSV export URL, sheet phải shared "Anyone with the link" để Worker đọc được.

**Khuyến nghị:** Tạo Sheet ID MỚI (vì ID cũ đã lộ trong git history). Đổi `SHEET_ID` secret sang sheet mới.

### Bước 6: Rebuild app

```powershell
cd ..
npm run build:win
```

## Test Worker

```powershell
# Health check
curl https://hp-license.your-username.workers.dev/

# → {"service":"hp-license","status":"ok"}

# Test activate
curl -X POST https://hp-license.your-username.workers.dev/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"HDUSN67HUN8666HOEKSN6HPMEDIA"}'

# → {"ok":true,"key":"HDUSN67HUN8666HOEKSN6HPMEDIA","vip":"VIP","expiry":"27/11/2029",...}

# Test key sai
curl -X POST https://hp-license.your-username.workers.dev/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"FAKE"}'

# → {"ok":false,"error":"Key không tồn tại trong hệ thống"}
```

## Update Worker

Sửa `worker.js`, sau đó:
```powershell
wrangler deploy
```

## Xem log Worker (debug)

```powershell
wrangler tail
```

→ Live log mọi request vào Worker.

## Chi phí

Cloudflare Workers free tier:
- 100,000 request/ngày
- 10ms CPU/request

Worker này dùng ~5ms CPU/request. 100K req/day = ~3000 user/giờ.

→ **$0/tháng** cho HP Action LIVE.

## Bảo mật

- **HTTPS tự động** — Cloudflare handle SSL.
- **Sheet ID ẩn** trong env var → attacker không thấy trong app.
- **Rate limit tự động** ở Cloudflare edge → khó brute force.
- **Cache 60s** giảm tải Google Sheets.

Không có Ed25519 sign → đơn giản hơn, vẫn an toàn vì:
- Attacker không thể fake Worker URL (đã hardcode trong app build)
- HTTPS chống MITM trên đường truyền
- Attack chính của Electron là patch client, không phải MITM

## Câu hỏi thường gặp

**Q: Worker bị down thì user bị sao?**
A: User đã activate có 24h offline grace (app-config.json `lastValidated`). User chưa activate không hoạt động được. Cloudflare uptime ~99.99% → hiếm khi down.

**Q: Có cần custom domain không?**
A: Không bắt buộc. `<worker-name>.<your-username>.workers.dev` đã hoạt động + có HTTPS. Nếu muốn URL đẹp `license.hpvn.media`:
1. Add domain vào Cloudflare (proxied DNS)
2. wrangler.toml thêm:
   ```toml
   routes = [{ pattern = "license.hpvn.media/*", custom_domain = true }]
   ```
3. `wrangler deploy`

**Q: Worker thấy được key user nhập không?**
A: Có — Worker chạy server-side, đọc key từ POST body. Đây là design intent. Worker chỉ log 6 ký tự đầu vào dashboard Cloudflare, không lưu full key. Nếu muốn audit chi tiết → dùng license-server (Node.js) với log file.

# HP Action LIVE — License Validation Worker

Cloudflare Worker xác thực key bản quyền cho HP Action LIVE.

## Tại sao cần Worker?

**Trước (v1.0.4):** App fetch trực tiếp Google Sheet KEY_HP_GAME → Sheet ID + URL nằm
trong source code → attacker `asar extract` thấy được → curl Sheet → tải toàn bộ key list.

**Sau (Tier 1):** App POST tới Worker URL → Worker đọc Sheet (server-side, Sheet ID ẩn) →
ký response bằng Ed25519 → app verify với public key. Attacker:
- Không thấy Sheet ID trong app (chỉ thấy Worker URL)
- Không thể curl Sheet (đặt private)
- Không thể forge response (không có private key)
- Vẫn có thể patch app để skip verify, NHƯNG cần kiến thức cao + mất tính chính danh

→ Raise the bar đáng kể. Casual cracker fail.

## Yêu cầu

- Tài khoản Cloudflare miễn phí (https://dash.cloudflare.com/sign-up)
- Node.js 18+ trên máy local
- `wrangler` CLI: `npm install -g wrangler`

## Deploy lần đầu

### Bước 1: Sinh Ed25519 keypair

```powershell
cd cloudflare-worker
node keygen.js
```

Output:
- `private-key.pem` — BÍ MẬT, upload vào Cloudflare
- `public-key.pem` — public, embed vào server.js
- `public-key.txt` — base64 1 dòng dễ paste

→ KHÔNG commit `private-key.pem` lên git (đã có .gitignore).

### Bước 2: Đăng nhập Cloudflare

```powershell
wrangler login
```

Browser sẽ mở → đăng nhập Cloudflare account → cho phép Wrangler.

### Bước 3: Set secrets

```powershell
wrangler secret put SHEET_ID
```

Wrangler hỏi value → paste Google Sheet ID (vd: `1Fv9Jdno_pPMTx_-tnwSfRObm1r1wKds_gaMBnfCDm4M`).

```powershell
wrangler secret put SIGN_PRIVATE_KEY
```

Wrangler hỏi value → paste **toàn bộ nội dung** của `private-key.pem` (bao gồm `-----BEGIN PRIVATE KEY-----` và `-----END PRIVATE KEY-----`).

### Bước 4: Deploy Worker

```powershell
wrangler deploy
```

Wrangler sẽ trả về URL Worker, vd:
```
Published hp-license (1.2 sec)
  https://hp-license.your-username.workers.dev
```

Copy URL này.

### Bước 5: Update server.js

Mở `<project root>/server.js`, tìm 2 hằng số sau và update:

```js
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://hp-license.your-username.workers.dev';   // ← URL từ bước 4
const LICENSE_PUBLIC_KEY_B64 = process.env.HP_LICENSE_PUBLIC_KEY
    || 'AbCdEfGhIjKlMnOpQrSt...';                          // ← Nội dung public-key.txt (dòng base64)
```

### Bước 6: Lock down Google Sheet

Trên Google Sheet KEY_HP_GAME:
1. Bấm Share (góc phải trên)
2. Đổi từ "Anyone with the link can view" → **"Restricted"**
3. Chỉ giữ owner email của bạn

Worker vẫn đọc được Sheet vì dùng public CSV export URL, **không cần auth**. Test:

```powershell
# Curl trực tiếp Sheet → phải trả 401/302 (Sheet đã private)
curl "https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&sheet=KEY_HP_GAME"

# Curl Worker → vẫn hoạt động
curl -X POST "https://hp-license.your-username.workers.dev/activate" \
     -H "Content-Type: application/json" \
     -d '{"key": "TEST_KEY"}'
```

> ⚠️ **Quan trọng:** Google Sheet đặt private thì CSV export URL `gviz/tq?tqx=out:csv` SẼ NGỪNG hoạt động (kể cả từ Worker). Phải chuyển sang dùng **Google Sheets API** với API key/Service Account. Xem **TIER 1+** bên dưới.
>
> **Phương án nhanh trong Tier 1:** Giữ Sheet public nhưng đổi Sheet ID → Sheet ID cũ thành rác → tạo Sheet mới với danh sách key mới (re-issue all keys cho user). Sheet ID mới chỉ Worker biết.

### Bước 7: Rebuild app

```powershell
cd ..
npm run build:win
```

→ `dist/HP-Action-LIVE-Setup-X.X.X.exe` đã có Worker URL + public key được bake vào.

## Test Worker

```powershell
# Health check
curl https://hp-license.your-username.workers.dev/

# → {"service":"hp-license","status":"ok"}

# Test activate với key valid
curl -X POST https://hp-license.your-username.workers.dev/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"HDUSN67HUN8666HOEKSN6HPMEDIA"}'

# → {"data":{"ok":true,"key":"HDUSN67HUN8666HOEKSN6HPMEDIA","vip":"VIP","expiry":"27/11/2029",...},"signature":"abc123..."}

# Test activate với key sai
curl -X POST https://hp-license.your-username.workers.dev/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"FAKE_KEY"}'

# → {"ok":false,"error":"Key không tồn tại trong hệ thống"}
```

## Update Worker sau này

Sửa `worker.js`, sau đó:
```powershell
wrangler deploy
```

Sửa SHEET_ID:
```powershell
wrangler secret put SHEET_ID
```

## Xem log Worker (debug)

```powershell
wrangler tail
```

→ Live log mọi request vào Worker. Hữu ích để debug hoặc audit hoạt động bất thường.

## Rotate key (nếu nghi ngờ private key bị lộ)

```powershell
# 1. Sinh keypair mới
node keygen.js

# 2. Update Worker secret
wrangler secret put SIGN_PRIVATE_KEY

# 3. Update server.js với public key MỚI
# 4. Build + release version mới
# 5. User update lên version mới
```

> Lưu ý: User dùng version cũ (public key cũ) sẽ không activate được key mới. Phải lên version mới.

## TIER 1+ (nâng cấp sau): Service Account cho Sheet private

Nếu muốn Sheet thực sự private (không CSV export public):

1. Tạo Google Cloud project: https://console.cloud.google.com/
2. Enable Google Sheets API
3. Tạo Service Account → download JSON key
4. Share Sheet với email của Service Account (Editor hoặc Viewer)
5. Trong worker.js, thay `fetch(sheetUrl)` bằng OAuth2 + Sheets API call:
   ```js
   // Pseudo-code
   const token = await getAccessToken(env.SERVICE_ACCOUNT_JSON);  // JWT exchange
   const sheetData = await fetch(
       `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/KEY_HP_GAME`,
       { headers: { Authorization: `Bearer ${token}` } }
   ).then(r => r.json());
   ```
6. `wrangler secret put SERVICE_ACCOUNT_JSON` → paste JSON nội dung
7. Sheet giờ HOÀN TOÀN private. Curl không lấy được nữa.

Đây là Tier 1+ — nâng cấp khi cần. Hiện tại Tier 1 đã đủ chống casual cracker.

## Chi phí

Cloudflare Workers free tier:
- 100,000 request/ngày
- 10ms CPU/request

Worker hp-license dùng ~5ms CPU/request. 100K request/ngày = ~3000 user active mỗi giờ. Quá dư cho HP Action LIVE.

→ **$0/tháng** cho đến khi vượt scale rất lớn.

## Cấu trúc files

```
cloudflare-worker/
├── worker.js          # Main Worker code (deploy lên Cloudflare)
├── wrangler.toml      # Cloudflare config
├── keygen.js          # Sinh Ed25519 keypair (chạy local)
├── README.md          # Tài liệu này
├── .gitignore         # Bỏ qua private-key.pem
├── private-key.pem    # ⚠️ BÍ MẬT — không commit
├── public-key.pem     # Public, có thể commit
└── public-key.txt     # Public key dạng base64
```

## Câu hỏi thường gặp

**Q: Cài trên máy mới có cần Worker không?**
A: Có. Mọi máy đều cần Internet kết nối Worker để activate key lần đầu. Sau khi activate, app có 24h offline grace.

**Q: Worker bị down thì sao?**
A: User đang activated → offline grace 24h, vẫn dùng được. User chưa activate → không hoạt động được. Cloudflare Workers uptime ~99.99% → hiếm khi down.

**Q: Có cần custom domain không?**
A: Không bắt buộc. `<worker-name>.<your-username>.workers.dev` đã hoạt động ngay. Nếu muốn URL đẹp như `license.hpvn.media`:
1. Add domain vào Cloudflare (cần proxied DNS)
2. wrangler.toml thêm `routes = [{ pattern = "license.hpvn.media/*", custom_domain = true }]`
3. `wrangler deploy`

**Q: Public key trong app có an toàn không nếu lộ?**
A: Có. Public key chỉ dùng để VERIFY. Không thể dùng để forge. Chỉ private key (trên Cloudflare) mới forge được. Đó là điểm mạnh của asymmetric crypto.

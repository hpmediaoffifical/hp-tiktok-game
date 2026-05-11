# HP License Server (standalone)

Server Node.js riêng xác thực key bản quyền HP Action LIVE — thay thế Cloudflare Worker.

## Tại sao server riêng?

| | Cloudflare Worker | Standalone Server |
|---|---|---|
| Chi phí | $0 (100K req/ngày) | ~$5/tháng VPS, hoặc $0 trên Render/Railway free |
| Setup | Đơn giản | Cần biết Linux/SSH cơ bản |
| Persistent storage | Không (cần KV add-on $5) | ✅ File JSON / SQLite native |
| Admin dashboard | Không có sẵn | ✅ Web UI tự host |
| Device binding | Khó implement | ✅ Dễ |
| Custom logic phức tạp | Giới hạn V8 isolate | ✅ Full Node.js |
| Logs | Chỉ thấy trong dashboard CF | ✅ File logs riêng |
| Lệ thuộc 3rd party | Cloudflare | Chỉ VPS provider |

→ Khi HP Media muốn **kiểm soát hoàn toàn** + tính năng nâng cao (dashboard, audit log, device tracking, revoke instant) → server riêng tốt hơn.

## Tính năng

- ✅ POST `/activate` với key validation, signed Ed25519 response
- ✅ Device binding: 1 key chỉ chạy trên N máy (configurable)
- ✅ Admin dashboard web UI: list/search keys, revoke, reset devices
- ✅ Audit log: ghi mọi lần activate/revoke vào file
- ✅ Rate limiting: chống brute force key (20 req/phút/IP mặc định)
- ✅ Cache Google Sheet 5 phút (giảm Google API call)
- ✅ Health check endpoint

## Cấu trúc

```
license-server/
├── server.js         # Main Express server (~340 dòng)
├── package.json      # Dependencies: express, node-fetch, express-rate-limit
├── keygen.js         # Sinh Ed25519 keypair
├── .env.example      # Template config
├── README.md         # Tài liệu này
├── public/
│   └── index.html    # Admin dashboard web UI
└── data/             # Auto-created: activations.json + log file
```

## Setup local (test trước khi deploy)

```powershell
# 1. Cài dependencies
cd license-server
npm install

# 2. Sinh keypair
node keygen.js

# 3. Config
cp .env.example .env
# → Mở .env, set: SHEET_ID, ADMIN_TOKEN, SIGN_PRIVATE_KEY_FILE=./private-key.pem

# 4. Chạy
npm start
# → Server lắng nghe http://localhost:8787

# 5. Test
curl http://localhost:8787/
# → {"service":"hp-license-server","status":"ok","activations_count":0}

curl -X POST http://localhost:8787/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"HDUSN67HUN8666HOEKSN6HPMEDIA","deviceId":"test-machine-1"}'
# → {"data":{"ok":true,...},"signature":"..."}

# Admin dashboard:
# http://localhost:8787/admin/?token=<ADMIN_TOKEN từ .env>
```

## Deploy lên Production — chọn 1 trong 4

### Option A — VPS (Ubuntu) — recommended, $5/tháng

VPS provider: DigitalOcean, Vultr, Linode, Hetzner, Bizfly, FPT Cloud...

```bash
# Trên VPS Ubuntu:

# 1. Cài Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. Clone code
git clone <repo URL> /opt/hp-license
cd /opt/hp-license/license-server

# 3. Cài deps + setup
npm install --production
node keygen.js
cp .env.example .env
nano .env   # set SHEET_ID, ADMIN_TOKEN, SIGN_PRIVATE_KEY_FILE=./private-key.pem

# 4. Test chạy
npm start
# Ctrl+C nếu OK

# 5. Cài PM2 cho auto-restart
sudo npm install -g pm2
pm2 start server.js --name hp-license
pm2 startup       # follow hướng dẫn để enable boot start
pm2 save

# 6. Cài nginx reverse proxy + SSL
sudo apt install -y nginx certbot python3-certbot-nginx

# Tạo /etc/nginx/sites-available/hp-license:
sudo tee /etc/nginx/sites-available/hp-license <<'EOF'
server {
    listen 80;
    server_name license.hpvn.media;
    location / {
        proxy_pass http://localhost:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/hp-license /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 7. SSL
sudo certbot --nginx -d license.hpvn.media

# 8. Done. Test:
curl https://license.hpvn.media/
```

URL server giờ: `https://license.hpvn.media`

### Option B — Render free tier ($0/tháng)

1. Push `license-server/` lên 1 GitHub repo (KHÔNG commit `private-key.pem`).
2. https://render.com → New → Web Service → connect repo
3. Settings:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Root Directory: `license-server`
4. Environment variables (Settings → Environment):
   - `PORT` = (Render tự set, để trống)
   - `SHEET_ID` = `<Sheet ID>`
   - `ADMIN_TOKEN` = `<random 64 hex>`
   - `SIGN_PRIVATE_KEY` = `<paste nội dung private-key.pem, replace newline bằng \n>`
5. Deploy. Render cho URL `https://hp-license-xxx.onrender.com`

**Lưu ý:** Render free tier sleep sau 15 phút inactive → request đầu sau khi sleep mất 30s. Không lý tưởng cho production, nhưng OK cho POC.

### Option C — Railway ($5 credit free)

```bash
npm install -g @railway/cli
railway login
cd license-server
railway init
railway up
```

Set env vars qua dashboard Railway. URL: `https://xxx.up.railway.app`.

### Option D — Fly.io (free tier 3 small VMs)

```bash
brew install flyctl    # hoặc: iwr https://fly.io/install.ps1 -useb | iex
fly auth login
cd license-server
fly launch    # → tạo fly.toml, choose region (sin = Singapore gần VN)
fly secrets set SHEET_ID="..." ADMIN_TOKEN="..." SIGN_PRIVATE_KEY="..."
fly deploy
```

URL: `https://hp-license-server.fly.dev`.

## Update app electron để gọi server riêng

Sau khi server chạy ổn (vd `https://license.hpvn.media`):

Mở `<root>/server.js` (app electron, KHÔNG phải license-server/server.js):

```js
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://license.hpvn.media';                           // ← URL server riêng
const LICENSE_PUBLIC_KEY_B64 = process.env.HP_LICENSE_PUBLIC_KEY
    || 'w1YGF8wiIdJZKa7Wk2hOhciFRVYYA7M9s4k+cF+V/g4=';        // ← từ keygen.js
```

Rebuild + release app như bình thường (`npm run build:win`).

## Endpoints

### Public

- `GET /` → health check
- `POST /activate` `{key, deviceId?}` → validate, return signed payload

### Admin (yêu cầu `Authorization: Bearer <ADMIN_TOKEN>` hoặc `?token=...`)

- `GET /admin/` → web UI dashboard
- `GET /admin/api/list` → list tất cả activated keys
- `POST /admin/api/revoke` `{key}` → thu hồi key
- `POST /admin/api/unrevoke` `{key}` → khôi phục key
- `POST /admin/api/reset-devices` `{key}` → xoá device list của key
- `POST /admin/api/refresh-sheet` → force reload Google Sheet cache

## Bảo mật vận hành

1. **Đặt Sheet private** sau khi server deploy. Server vẫn đọc được qua CSV export nếu sheet shared với "Anyone with link can view". Để thực sự private cần Google Service Account (xem cloudflare-worker/README.md TIER 1+).

2. **Đổi ADMIN_TOKEN** thường xuyên (3-6 tháng/lần). Sinh token mới:
   ```bash
   openssl rand -hex 32
   # hoặc trong Node: crypto.randomBytes(32).toString('hex')
   ```

3. **Firewall**: chỉ mở port 80/443. Block direct access port 8787:
   ```bash
   sudo ufw allow 22
   sudo ufw allow 80
   sudo ufw allow 443
   sudo ufw enable
   ```

4. **Monitor log**: tail `data/activations.log` định kỳ tìm pattern bất thường (vd: cùng IP activate 50 key).

5. **Backup `data/activations.json`** mỗi ngày — đây là database activation. Mất file = mất lịch sử device binding.

6. **Rotate Ed25519 keypair** mỗi 1-2 năm hoặc khi nghi lộ private key. Khi rotate:
   - Sinh keypair mới
   - Update server `.env` SIGN_PRIVATE_KEY
   - Update app electron LICENSE_PUBLIC_KEY_B64
   - Release version mới → user cập nhật → mới activate được

## Mở rộng (future)

- **PostgreSQL** thay JSON file (khi >100K activations)
- **Webhook** ping HP Media khi có activation mới
- **Geo blocking**: chặn activation từ countries không thuộc thị trường mục tiêu
- **2FA cho admin dashboard**
- **License tiers**: key VIP có tính năng khác key Thường (đã có trường `vip` trong response)

## Câu hỏi thường gặp

**Q: Server bị down thì user bị sao?**
A: User đã activate có 24h offline grace (giữ trong app-config.json `lastValidated`). User chưa activate không hoạt động được. Khuyến nghị: VPS reliable (Hetzner uptime 99.99%) + monitor uptime (Uptime Robot free).

**Q: Server bị DDoS thì sao?**
A: Đặt sau Cloudflare DNS (free): proxy mode bật → Cloudflare absorb traffic. Plus rate limit local (đã có 20 req/min/IP). Plus VPS provider thường có DDoS protection cơ bản.

**Q: Có cần SSL không?**
A: BẮT BUỘC. Không có SSL → request chứa key bay qua mạng plaintext → attacker MITM lấy được. Certbot Let's Encrypt miễn phí.

**Q: Public key trong app có an toàn không?**
A: Có. Public key chỉ verify, không sign. Lộ = không sao. Nhưng GIỮ private key trên server (file mode 600, chỉ owner đọc).

**Q: Có nên log full key?**
A: KHÔNG. Server log chỉ log 6 ký tự đầu + `***`. Full key trong DB activations.json — protect file (mode 600).

# HP License Server (standalone)

Server Node.js riêng xác thực key bản quyền HP Action LIVE.

## Tại sao server riêng?

| | Server riêng | App fetch sheet trực tiếp |
|---|---|---|
| Sheet ID lộ trong app | ❌ Ẩn ở server | ✅ Lộ |
| Đặt sheet private được | ✅ | ❌ Phải public |
| Admin dashboard | ✅ | ❌ |
| Audit log activation | ✅ | ❌ |
| Revoke key tức thì | ✅ | ❌ |
| Device binding | ✅ | ❌ |
| Rate limit chống brute force | ✅ | ❌ |
| Custom logic mở rộng | ✅ | ❌ |

## Tính năng

- ✅ POST `/activate` với key validation
- ✅ Device binding: 1 key chỉ chạy trên N máy (configurable)
- ✅ Admin dashboard web UI: list/search keys, revoke, reset devices
- ✅ Audit log: ghi mọi lần activate/revoke vào file
- ✅ Rate limiting: chống brute force key (20 req/phút/IP mặc định)
- ✅ Cache Google Sheet 5 phút (giảm Google API call)
- ✅ Health check endpoint

## Bảo mật đường truyền

Server này KHÔNG ký response. Bảo mật trong transit dựa hoàn toàn vào **HTTPS**:
- Production BẮT BUỘC phải dùng HTTPS (Let's Encrypt miễn phí, hoặc Cloudflare proxy).
- Không có HTTPS → key user bay qua mạng plaintext → attacker MITM lấy được.

App electron tin response từ server URL được hardcode trong build. Attacker không thể:
- Thay đổi URL server trong app (đã build vào .exe)
- MITM trên HTTPS (cần CA bị compromise hoặc malware client)
- Tải bulk key (Sheet private hoặc Sheet ID ẩn ở server)

→ Attack vector chính còn lại: **patch app electron** để bypass check. Đây là vấn đề chung của mọi app Electron, không fixable hoàn toàn ở client.

## Cấu trúc

```
license-server/
├── server.js         # Main Express server (~300 dòng)
├── package.json      # Dependencies: express, node-fetch, express-rate-limit, dotenv
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

# 2. Tạo file .env
cp .env.example .env
# Mở .env, set:
#   SHEET_ID=<your sheet id>
#   ADMIN_TOKEN=<random 64 hex>

# 3. Sinh ADMIN_TOKEN (paste vào .env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Chạy
npm start
# → Server lắng nghe http://localhost:8787

# 5. Test
curl http://localhost:8787/
# → {"service":"hp-license-server","status":"ok","activations_count":0}

curl -X POST http://localhost:8787/activate `
     -H "Content-Type: application/json" `
     -d '{"key":"HDUSN67HUN8666HOEKSN6HPMEDIA","deviceId":"test-machine"}'
# → {"ok":true,"key":"HDUSN67HUN8666HOEKSN6HPMEDIA","vip":"VIP","expiry":"27/11/2029",...}

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
cp .env.example .env
nano .env   # set SHEET_ID + ADMIN_TOKEN

# Sinh ADMIN_TOKEN ngẫu nhiên:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

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

# 7. SSL (BẮT BUỘC cho production)
sudo certbot --nginx -d license.hpvn.media

# 8. Done. Test:
curl https://license.hpvn.media/
```

URL server giờ: `https://license.hpvn.media`

### Option B — Render free tier ($0/tháng)

1. Push `license-server/` lên 1 GitHub repo (file `.env` đã có .gitignore, không lo lộ).
2. https://render.com → New → Web Service → connect repo
3. Settings:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Root Directory: `license-server`
4. Environment variables (Settings → Environment):
   - `SHEET_ID` = `<Sheet ID>`
   - `ADMIN_TOKEN` = `<random 64 hex>`
   - (PORT do Render tự set)
5. Deploy. Render cho URL `https://hp-license-xxx.onrender.com` (đã có HTTPS sẵn).

**Lưu ý:** Render free tier sleep sau 15 phút inactive → request đầu sau khi sleep mất 30s. Không lý tưởng cho production.

### Option C — Railway ($5 credit free)

```bash
npm install -g @railway/cli
railway login
cd license-server
railway init
railway up
```

Set env vars (`SHEET_ID`, `ADMIN_TOKEN`) qua dashboard Railway. URL: `https://xxx.up.railway.app` (HTTPS sẵn).

### Option D — Fly.io (free tier 3 small VMs)

```bash
brew install flyctl    # hoặc: iwr https://fly.io/install.ps1 -useb | iex
fly auth login
cd license-server
fly launch    # → tạo fly.toml, choose region (sin = Singapore gần VN)
fly secrets set SHEET_ID="..." ADMIN_TOKEN="..."
fly deploy
```

URL: `https://hp-license-server.fly.dev` (HTTPS sẵn).

## Update app electron để gọi server riêng

Sau khi server chạy ổn (vd `https://license.hpvn.media`):

Mở `<project root>/server.js` (file của app electron, KHÔNG phải license-server/server.js):

```js
const LICENSE_WORKER_URL = process.env.HP_LICENSE_WORKER_URL
    || 'https://license.hpvn.media';   // ← URL server riêng của bạn
```

Rebuild + release app như bình thường (`npm run build:win`).

## Endpoints

### Public

- `GET /` → health check
- `POST /activate` `{key, deviceId?}` → validate, return `{ok, key, vip, expiry, expiryISO, note, issued_at}`

### Admin (yêu cầu `Authorization: Bearer <ADMIN_TOKEN>` hoặc `?token=...`)

- `GET /admin/` → web UI dashboard
- `GET /admin/api/list` → list tất cả activated keys
- `POST /admin/api/revoke` `{key}` → thu hồi key
- `POST /admin/api/unrevoke` `{key}` → khôi phục key
- `POST /admin/api/reset-devices` `{key}` → xoá device list của key
- `POST /admin/api/refresh-sheet` → force reload Google Sheet cache

## Bảo mật vận hành

1. **Production BẮT BUỘC HTTPS**. Không có HTTPS → key bay qua mạng plaintext.

2. **Đặt Sheet private** sau khi server deploy. Server vẫn đọc được qua CSV export nếu sheet shared với "Anyone with link can view". Để thực sự private cần Google Service Account (xem mở rộng bên dưới).

3. **Đổi ADMIN_TOKEN** thường xuyên (3-6 tháng/lần). Sinh token mới:
   ```bash
   openssl rand -hex 32
   # hoặc trong Node: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. **Firewall** (VPS): chỉ mở port 80/443. Block direct access port 8787:
   ```bash
   sudo ufw allow 22
   sudo ufw allow 80
   sudo ufw allow 443
   sudo ufw enable
   ```

5. **Monitor log**: tail `data/activations.log` định kỳ tìm pattern bất thường (vd: cùng IP activate 50 key).

6. **Backup `data/activations.json`** mỗi ngày — đây là database activation. Mất file = mất lịch sử device binding.

7. **CORS_ORIGIN production** nên set cụ thể thay vì `*`. Vd: `CORS_ORIGIN=app://hp-action-live` (electron protocol).

## Mở rộng tương lai

- **Google Service Account** cho Sheet thực sự private (không cần share public link)
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

**Q: Có nên log full key?**
A: KHÔNG. Server log chỉ log 6 ký tự đầu + `***`. Full key trong DB activations.json — protect file (mode 600).

**Q: Tại sao không có ký Ed25519?**
A: Đơn giản hóa setup. HTTPS đã đủ tin cậy với server hợp lệ. Attacker chính của app Electron là patching client code, không phải MITM trên đường truyền. Ký response chỉ tăng friction ~5% nhưng tăng complexity setup nhiều. Nếu HP Media muốn ký sau này, xem nhánh git có Ed25519 trong lịch sử commit.

# Releases folder

Folder này chứa các phiên bản installer .exe để phục vụ auto-update.

## Cách publish phiên bản mới

### Bước 1: Build .exe

Trên máy dev (Windows):
```powershell
cd "C:\Users\NCPC\Desktop\HP Action LIVE"
npm run build:win
# → dist/HP-Action-LIVE-Setup-1.0.5.exe
```

### Bước 2: Tính SHA-256 checksum

```powershell
$exe = "dist\HP-Action-LIVE-Setup-1.0.5.exe"
(Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
# vd: 4a1b8c... → copy hash này
```

### Bước 3: Upload .exe lên server

Copy file lên license-server (qua SCP, FTP, hoặc upload qua admin UI nếu có):
```bash
scp dist/HP-Action-LIVE-Setup-1.0.5.exe \
    user@license.hpvn.media:/opt/hp-license/license-server/releases/
```

### Bước 4: Publish metadata (báo cho server biết phiên bản mới)

```powershell
$token = "YOUR_ADMIN_TOKEN"
$body = @{
    version = "1.0.5"
    filename = "HP-Action-LIVE-Setup-1.0.5.exe"
    sha256 = "4a1b8c..."
    size = (Get-Item "dist\HP-Action-LIVE-Setup-1.0.5.exe").Length
    notes = @"
Bản v1.0.5 — Auto-update + Role-based key

• Auto-update không qua GitHub (private)
• Role-based key: ADMIN / CREATOR
• CREATOR keys gắn với TikTok ID
"@
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://license.hpvn.media/admin/api/publish-version" `
    -Method Post `
    -Headers @{"Authorization"="Bearer $token"} `
    -ContentType "application/json" `
    -Body $body
```

Hoặc qua curl/bash:
```bash
curl -X POST https://license.hpvn.media/admin/api/publish-version \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0.5",
    "filename": "HP-Action-LIVE-Setup-1.0.5.exe",
    "sha256": "4a1b8c...",
    "size": 96000000,
    "notes": "Bản v1.0.5\n• Auto-update\n• Role-based key"
  }'
```

Server sẽ ghi `version.json` trong folder này.

### Bước 5: User cập nhật

User mở app → app check `/api/version` → so version → modal hỏi "Có cập nhật, đồng ý?" → user Đồng ý → app tải qua `/api/download/installer` → cài silent → reopen.

## Files trong folder này

```
releases/
├── README.md                              # File này
├── version.json                           # Metadata phiên bản mới nhất (auto-gen từ publish-version)
└── HP-Action-LIVE-Setup-X.Y.Z.exe         # Các .exe đã publish (giữ file mới nhất, file cũ tùy)
```

## version.json schema

```json
{
  "version": "1.0.5",
  "notes": "Bản v1.0.5\n• Auto-update\n• Role-based key",
  "filename": "HP-Action-LIVE-Setup-1.0.5.exe",
  "sha256": "4a1b8c2d3e...",
  "size": 96660955,
  "published_at": 1778530000000
}
```

## Rollback nếu version mới có lỗi

Sửa `version.json` thủ công về version cũ:
```json
{
  "version": "1.0.4",
  "filename": "HP-Action-LIVE-Setup-1.0.4.exe",
  ...
}
```

Hoặc gọi `/admin/api/publish-version` với data của version cũ.

User đang dùng version mới (lỗi) sẽ không bị tự rollback (vì version cũ hơn local). Họ phải uninstall + cài lại manually từ file .exe cũ.

→ **Khuyến nghị:** giữ file .exe các phiên bản cũ trong folder này để có thể rollback / cấp lại cho user khi cần.

## Bảo mật

- `.gitignore` đã loại file .exe khỏi git (KHÔNG commit binaries lên repo)
- Folder này access public qua `/api/download/installer` — user/bot có thể tải nhưng cần key bản quyền để activate app
- Rate limit không áp dụng cho `/api/download/installer` (chỉ áp cho `/activate`) — chấp nhận vì .exe size lớn, người tải 1 file lớn không phải attacker

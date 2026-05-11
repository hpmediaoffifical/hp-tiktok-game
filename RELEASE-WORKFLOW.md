# Release Workflow — HP Action LIVE

Quy trình release từng phiên bản. **Distribution hai tầng:**

```
              ┌───────────────────────────────────┐
              │  PRIMARY (user-facing)            │
              │  https://license.hpvn.media       │
              │  /api/download/installer          │
              │  ← User app tự gọi (auto-update)  │
              └─────────────┬─────────────────────┘
                            │
              ┌─────────────▼─────────────────────┐
              │  BACKUP (admin-only)              │
              │  GitHub Releases                  │
              │  ← Lưu trữ mọi version cũ        │
              │  ← Rollback manual nếu cần       │
              └───────────────────────────────────┘
```

## Phân loại 2 kênh

| | Kênh 1: License-server | Kênh 2: GitHub Release |
|---|---|---|
| **Mục đích** | Tự động cập nhật cho user | Backup archive + rollback manual |
| **User access** | ✅ App tự gọi (không thấy URL) | ⚠️ Chỉ admin/HP Media biết |
| **URL** | https://license.hpvn.media/api/download/installer | https://github.com/hpmediaoffifical/hp-tiktok-game/releases |
| **Số version giữ** | 1 file mới nhất | Tất cả version (v1.0.0, v1.0.1, ..., v1.0.N) |
| **Khi nào dùng** | Mọi update bình thường | Khi user gặp lỗi với v mới → admin cấp link v cũ |

## Workflow release version mới

### Bước 1: Bump version

```powershell
# Sửa package.json: "version": "1.0.4" → "1.0.5"
# Hoặc dùng npm:
npm version patch --no-git-tag-version
```

### Bước 2: Commit code

```powershell
git add -A
git commit -m "v1.0.5 - <mô tả ngắn>"
```

### Bước 3: Build .exe

```powershell
npm run build:win
# → dist/HP-Action-LIVE-Setup-1.0.5.exe (~93MB, chỉ 1 file)
```

### Bước 4: Tính SHA-256

```powershell
(Get-FileHash -Algorithm SHA256 "dist\HP-Action-LIVE-Setup-1.0.5.exe").Hash.ToLower()
# vd: 4a1b8c2d3e9f...
```

### Bước 5: Push GitHub + tag (BACKUP)

```powershell
git push origin main
git tag v1.0.5
git push origin v1.0.5

# Tạo GitHub Release với .exe attached (backup archive)
gh release create v1.0.5 "dist/HP-Action-LIVE-Setup-1.0.5.exe" `
    --title "v1.0.5 - <title>" `
    --notes "## Thay đổi`n- ...`n`n## Cài đặt`nUser nhận update tự động qua app. Bản backup này dành cho rollback khi cần."
```

### Bước 6: Upload .exe lên license-server (PRIMARY)

```powershell
# Qua SCP (nếu VPS Linux)
scp "dist\HP-Action-LIVE-Setup-1.0.5.exe" `
    user@license.hpvn.media:/opt/hp-license/license-server/releases/

# Hoặc Render/Railway/Fly: upload qua dashboard hoặc CI/CD
```

### Bước 7: Publish metadata (báo server biết phiên bản mới)

```powershell
$token = "<your admin token>"
$sha = "<sha256 từ bước 4>"
$size = (Get-Item "dist\HP-Action-LIVE-Setup-1.0.5.exe").Length

$body = @{
    version = "1.0.5"
    filename = "HP-Action-LIVE-Setup-1.0.5.exe"
    sha256 = $sha
    size = $size
    notes = "Bản v1.0.5`n• Auto-update private`n• Role-based key`n• Một số fix UX"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://license.hpvn.media/admin/api/publish-version" `
    -Method Post `
    -Headers @{"Authorization"="Bearer $token"} `
    -ContentType "application/json" `
    -Body $body
```

→ Từ thời điểm này, user mở app sẽ thấy modal "Có cập nhật v1.0.5" → bấm Đồng ý → tự cài.

## Khi user gặp lỗi với version mới → Rollback strategy

### Cách 1: Rollback toàn bộ (mọi user về version cũ)

Publish lại metadata với version cũ:

```powershell
# Set version trong license-server về 1.0.4 (file cũ vẫn còn ở releases/)
Invoke-RestMethod -Uri "https://license.hpvn.media/admin/api/publish-version" `
    -Method Post `
    -Headers @{"Authorization"="Bearer $token"} `
    -ContentType "application/json" `
    -Body (@{
        version = "1.0.4"
        filename = "HP-Action-LIVE-Setup-1.0.4.exe"
        sha256 = "<sha của 1.0.4>"
        size = <size>
        notes = "Bản v1.0.4 (rollback từ 1.0.5)"
    } | ConvertTo-Json)
```

> Lưu ý: user đang dùng 1.0.5 (đã cài) sẽ KHÔNG tự rollback (vì 1.0.4 < 1.0.5). Họ phải uninstall + cài lại manually. Vì vậy:

### Cách 2: Hotfix cho user cụ thể (kiến nghị)

User báo lỗi → admin gửi link GitHub Release v1.0.4 để họ cài đè manually:

```
https://github.com/hpmediaoffifical/hp-tiktok-game/releases/download/v1.0.4/HP-Action-LIVE-Setup-1.0.4.exe
```

User tải về → chạy → cài đè lên 1.0.5 → giải quyết riêng cho user đó.

**Đây là lý do giữ GitHub Release:** để admin có thể cấp link manual khi cần. User không biết link này (không có trong app).

### Cách 3: Publish version mới fix lỗi (TỐT NHẤT)

Tạo v1.0.6 fix bug → publish như bình thường → user tự nhận update.

## Strategy giữ files trên license-server

`license-server/releases/` folder:
- Giữ **file mới nhất** + 1-2 file gần đây (vd: v1.0.4, v1.0.5, v1.0.6)
- File cũ hơn → xoá để tiết kiệm disk (vẫn còn trên GitHub Release backup)

## Strategy GitHub Release

- Giữ TẤT CẢ versions từ v1.0.0 đến hiện tại
- User cuối không biết URL — chỉ admin biết
- Khi cần cấp file cho user gặp lỗi → copy direct link `releases/download/v.../HP-Action-LIVE-Setup-X.Y.Z.exe`

## Checklist mỗi lần release

- [ ] Test build local (npm start) — features mới hoạt động
- [ ] Bump version trong package.json
- [ ] `git commit -m "vX.Y.Z - description"`
- [ ] `npm run build:win` → check dist/Setup-X.Y.Z.exe
- [ ] Cài thử file Setup mới trên máy test → khởi động OK
- [ ] Tính SHA-256
- [ ] `git push origin main` + tag
- [ ] `gh release create vX.Y.Z` với .exe attached (BACKUP)
- [ ] Upload .exe lên license-server
- [ ] `publish-version` API gọi với metadata
- [ ] Test auto-update: mở app version cũ → thấy modal → bấm Đồng ý → cài → app mới mở
- [ ] Monitor log license-server để bắt lỗi user gặp

## Bỏ portable

Từ v1.0.5 trở đi **không build portable** vì:
1. Portable không tự update được (cần installer overwrite running .exe)
2. User cài 1 file Setup duy nhất → đơn giản hơn
3. 1 file = 1 file phải maintain → ít rủi ro mismatch

Nếu sau này cần portable (vd cho máy hạn chế cài), có thể restore target trong package.json:
```json
"target": [
    { "target": "nsis", "arch": ["x64"] },
    { "target": "portable", "arch": ["x64"] }
]
```

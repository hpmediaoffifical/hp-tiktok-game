# publish-v1.0.96.ps1 — Upload + publish v1.0.96 lên license.hpvn.media
# CÁCH DÙNG:
#   1. Mở PowerShell tại folder repo
#   2. Set token (1 lần, lưu trong env hoặc paste inline):
#        $env:HP_ADMIN_TOKEN = "<paste token của bạn>"
#   3. Chạy: .\publish-v1.0.96.ps1
#
# Token KHÔNG được hard-code trong file này — tránh leak khi commit git.

$ErrorActionPreference = 'Stop'

$VERSION  = "1.0.96"
$FILENAME = "HP-Action-LIVE-Setup-1.0.96.exe"
$FILEPATH = "dist\$FILENAME"
$BASE_URL = "https://license.hpvn.media"

# Lấy token từ env
$token = $env:HP_ADMIN_TOKEN
if (-not $token) {
    Write-Host "Thieu env var HP_ADMIN_TOKEN" -ForegroundColor Red
    Write-Host '   Chay truoc: $env:HP_ADMIN_TOKEN = "<token>"' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $FILEPATH)) {
    Write-Host "Khong tim thay $FILEPATH - chay 'npm run build:win' truoc" -ForegroundColor Red
    exit 1
}

# Tinh SHA256 + size truc tiep tu file de tranh sai khi quen update
$SHA256 = (Get-FileHash -Path $FILEPATH -Algorithm SHA256).Hash.ToLower()
$SIZE   = (Get-Item $FILEPATH).Length
Write-Host "File: $FILENAME" -ForegroundColor Gray
Write-Host "Size: $SIZE bytes ($([math]::Round($SIZE/1MB,1)) MB)" -ForegroundColor Gray
Write-Host "SHA256: $SHA256" -ForegroundColor Gray
Write-Host ""

# ============ STEP 1: Upload .exe ============
Write-Host "Step 1/2: Upload $FILENAME len $BASE_URL..." -ForegroundColor Cyan
$body = [IO.File]::ReadAllBytes($FILEPATH)
try {
    $up = Invoke-RestMethod -Uri "$BASE_URL/admin/api/upload-installer" `
        -Method Post `
        -Headers @{
            "Authorization" = "Bearer $token"
            "X-Filename"    = $FILENAME
            "Content-Type"  = "application/octet-stream"
        } `
        -Body $body `
        -TimeoutSec 600
    if (-not $up.ok) { throw "Upload reply: $($up | ConvertTo-Json -Compress)" }
    Write-Host "Upload OK - size=$($up.size) sha256=$($up.sha256.Substring(0,16))..." -ForegroundColor Green
    if ($up.sha256.ToLower() -ne $SHA256.ToLower()) {
        Write-Host "SHA256 server tinh khac voi local - kiem tra lai file!" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Upload fail: $_" -ForegroundColor Red
    exit 1
}

# ============ STEP 2: Publish metadata ============
Write-Host "Step 2/2: Publish metadata version $VERSION..." -ForegroundColor Cyan
$notes = @"
v1.0.96 - Khoi dong nhanh: TikTok connect + Cai dat hien thi + Overlay auto-refresh

- Khoi dong nhanh: them card "Ket noi TikTok" - nhap ID + connect/disconnect ngay trong cua so roi, sync 2 chieu voi app chinh.
- Khoi dong nhanh: autocomplete lich su ID tu nhung lan da connect THANH CONG (xoa duoc tung item bang nut x).
- Khoi dong nhanh: gop 2 nut Bat dau / Dung thanh 1 toggle icon goc (xanh la = bat dau, cam = dang chay).
- Khoi dong nhanh: them ⚙ Cai dat - tich chon game nao hien thi trong cua so. Game an chi an UI, van chay binh thuong o app chinh.
- App chinh: them autocomplete lich su ID cho o "Ket noi TikTok" (chia se localStorage voi cua so roi). Chi luu khi connect thanh cong.
- App chinh: khi connect ID khac voi phien truoc -> popup hoi reset toan bo tien trinh game (hu, caro, vote, level quest, timer) de bat dau phien moi voi streamer moi.
- LEVEL QUEST + THOI GIAN: fix overlay OBS khong tu cap nhat - server cache cfg/state, overlay mo SAU lab nhan snapshot ngay, khong can Reset OBS.
- Cap nhat icon qua: nut "Dong bo danh sach qua" gio tra them icon thieu tu phong LIVE dang connect (chinh xac hon Google Sheet). Toast hien so icon duoc khoi phuc.
- Qua chua cap nhat icon: thay bong tron + chu xau xi bang logo HP (https://hpvn.media/logo-hp.png), fallback local /hp-logo.png khi offline.
"@

$publishBody = @{
    version  = $VERSION
    filename = $FILENAME
    sha256   = $SHA256
    size     = $SIZE
    notes    = $notes
} | ConvertTo-Json

try {
    $pub = Invoke-RestMethod -Uri "$BASE_URL/admin/api/publish-version" `
        -Method Post `
        -Headers @{
            "Authorization" = "Bearer $token"
            "Content-Type"  = "application/json"
        } `
        -Body $publishBody
    if (-not $pub.ok) { throw "Publish reply: $($pub | ConvertTo-Json -Compress)" }
    Write-Host "Published version=$($pub.info.version)" -ForegroundColor Green
} catch {
    Write-Host "Publish fail: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "DONE - v1.0.96 da san sang. User mo app cu se thay modal cap nhat." -ForegroundColor Magenta
Write-Host "   URL kiem tra: $BASE_URL/api/version" -ForegroundColor Gray

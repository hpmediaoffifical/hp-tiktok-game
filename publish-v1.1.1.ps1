# publish-v1.1.1.ps1 — Upload + publish v1.1.1 lên license.hpvn.media
# CÁCH DÙNG:
#   1. Mở PowerShell tại folder repo
#   2. Build installer truoc:
#        npm run build:win
#   3. Set token (1 lần, lưu trong env hoặc paste inline):
#        $env:HP_ADMIN_TOKEN = "<paste token của bạn>"
#   4. Chạy: .\publish-v1.1.1.ps1
#
# Token KHÔNG được hard-code trong file này — tránh leak khi commit git.

$ErrorActionPreference = 'Stop'

$VERSION  = "1.1.1"
$FILENAME = "HP-Action-LIVE-Setup-1.1.1.exe"
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
    Write-Host "Khong tim thay $FILEPATH — chay 'npm run build:win' truoc" -ForegroundColor Red
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
    Write-Host "Upload OK — size=$($up.size) sha256=$($up.sha256.Substring(0,16))..." -ForegroundColor Green
    if ($up.sha256.ToLower() -ne $SHA256.ToLower()) {
        Write-Host "SHA256 server tinh khac voi local — kiem tra lai file!" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Upload fail: $_" -ForegroundColor Red
    exit 1
}

# ============ STEP 2: Publish metadata ============
Write-Host "Step 2/2: Publish metadata version $VERSION..." -ForegroundColor Cyan
$notes = @"
v1.1.1 — Custom gift labels + swap + horizontal layout + hide HP number

CUSTOM LABEL CHO QUA CHI DINH (ca 2 game):
- Moi qua trong tab "Qua chi dinh" co them o text "Ten hien thi" — go
  ten tuy y, hien tren overlay thay vi ten goc TikTok.
- VD: doi "Rose" -> "BAN 1 PHAT", "Football" -> "GIAP 10s"...
- Bo trong = giu nguyen ten goc.

DOI QUA NHANH (SWAP):
- Nut "↻ Doi" tren moi qua: bam mo gift picker, chon qua khac de
  THAY THE — giu lai customLabel + value (shots/heal/duration).
- Khong can xoa roi them lai.

BO CUC DANH SACH QUA:
- Tab Hien thi: chon "↕ Doc" hoac "↔ Ngang" cho overlay gift list.
- Doc: cards xep theo cot ben trai (mac dinh).
- Ngang: cards xep ngang nhu thanh menu — phu hop overlay vuong.

AN SO MAU HEART (Ban Cung):
- Toggle "Số máu dưới hàng trái tim" — an dong "5.6/10 ♥" neu chi
  muon thay hang tim, khong muon hien con so.
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
Write-Host "DONE — v1.1.1 da san sang. User mo app cu se thay modal cap nhat." -ForegroundColor Magenta
Write-Host "   URL kiem tra: $BASE_URL/api/version" -ForegroundColor Gray

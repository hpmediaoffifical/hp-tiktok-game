# publish-v1.0.80.ps1 — Upload + publish v1.0.80 lên license.hpvn.media
# CÁCH DÙNG:
#   1. Mở PowerShell tại folder repo
#   2. Set token (1 lần, lưu trong env hoặc paste inline):
#        $env:HP_ADMIN_TOKEN = "<paste token của bạn>"
#   3. Chạy: .\publish-v1.0.80.ps1
#
# Token KHÔNG được hard-code trong file này — tránh leak khi commit git.

$ErrorActionPreference = 'Stop'

$VERSION  = "1.0.80"
$FILENAME = "HP-Action-LIVE-Setup-1.0.80.exe"
$FILEPATH = "dist\$FILENAME"
$SHA256   = "ae903b76f82da4a3f1ff992fb6908fdae410b1a58f756b45ef409a244ec47521"
$SIZE     = 130945537
$BASE_URL = "https://license.hpvn.media"

# Lấy token từ env
$token = $env:HP_ADMIN_TOKEN
if (-not $token) {
    Write-Host "❌ Thiếu env var HP_ADMIN_TOKEN" -ForegroundColor Red
    Write-Host '   Chạy trước: $env:HP_ADMIN_TOKEN = "<token>"' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $FILEPATH)) {
    Write-Host "❌ Không tìm thấy $FILEPATH — chạy 'npm run build:win' trước" -ForegroundColor Red
    exit 1
}

# ============ STEP 1: Upload .exe ============
Write-Host "📤 Step 1/2: Upload $FILENAME ($([math]::Round($SIZE/1MB,1)) MB) lên $BASE_URL..." -ForegroundColor Cyan
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
    Write-Host "✓ Upload OK — size=$($up.size) sha256=$($up.sha256.Substring(0,16))..." -ForegroundColor Green
    if ($up.sha256.ToLower() -ne $SHA256.ToLower()) {
        Write-Host "⚠ SHA256 server tính khác với local — kiểm tra lại file!" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Upload fail: $_" -ForegroundColor Red
    exit 1
}

# ============ STEP 2: Publish metadata ============
Write-Host "📢 Step 2/2: Publish metadata version $VERSION..." -ForegroundColor Cyan
$notes = @"
v1.0.80 — Game mới: THỜI GIAN + LEVEL QUEST

⏱ THỜI GIAN: countdown/đếm tới 19 themes, 3 chế độ quà ± time,
trigger countdown + audio/video overlay riêng, cộng dồn thời gian khi tặng nhiều lần.

🎯 LEVEL QUEST: quest bar 18 level KPI 💎/❤/🔄 cho NPC creator (prototype).

🛠 Fixes:
- Sidebar game-list scroll nội bộ (Sound Effects không đè game items)
- Toggle ⏻ TẮT game giờ thật sự bỏ qua hiệu ứng (caro/votecomment/timer)
- Trigger overlay căn giữa viewport, audio không bị đè 2x
- Label tiêu đề pill xám nổi bật trên video LIVE
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
    Write-Host "✓ Published version=$($pub.info.version) at $(Get-Date -UnixTimeSeconds ($pub.info.published_at/1000))" -ForegroundColor Green
} catch {
    Write-Host "❌ Publish fail: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🎉 DONE — v1.0.80 đã sẵn sàng. User mở app cũ sẽ thấy modal cập nhật." -ForegroundColor Magenta
Write-Host "   URL kiểm tra: $BASE_URL/api/version" -ForegroundColor Gray

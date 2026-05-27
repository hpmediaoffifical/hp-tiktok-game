# tools/test-simulate-gift.ps1
# Test queue effect bằng cách giả lập TikTok gift event.
#
# Usage:
#   .\tools\test-simulate-gift.ps1 5655        # Send 1x gift ID 5655
#   .\tools\test-simulate-gift.ps1 5655 5      # Send combo 5x gift ID 5655
#   .\tools\test-simulate-gift.ps1 -List       # Xem queue status
#   .\tools\test-simulate-gift.ps1 -Clear      # Xóa queue
#   .\tools\test-simulate-gift.ps1 -Mapping    # Xem mapping hiện tại + groups

param(
    [Parameter(Position=0)][string]$GiftId = "",
    [Parameter(Position=1)][int]$Count = 1,
    [switch]$List,
    [switch]$Clear,
    [switch]$Mapping
)

$base = "http://localhost:3000/api/obs-bridge"

function Format-Queue($q) {
    Write-Host "Queue status:" -ForegroundColor Cyan
    Write-Host "  Total pending: $($q.pending), Draining: $($q.draining)"
    if ($q.groups.PSObject.Properties.Count -gt 0) {
        Write-Host "  Per-group breakdown:" -ForegroundColor Yellow
        $q.groups.PSObject.Properties | ForEach-Object {
            Write-Host "    [$($_.Name)] pending=$($_.Value.pending), draining=$($_.Value.draining)"
        }
    }
    if ($q.lastResult) {
        $r = $q.lastResult
        $status = if ($r.ok) { "OK" } else { "FAIL ($($r.reason))" }
        Write-Host "  Last trigger: $($r.hotkey) [$status] @group='$($r.group)'" -ForegroundColor Gray
    }
}

if ($Clear) {
    $r = Invoke-RestMethod -Uri "$base/queue/clear" -Method POST
    Write-Host "✓ Cleared $($r.removed) effects" -ForegroundColor Green
    Format-Queue $r.queue
    return
}

if ($List) {
    $r = Invoke-RestMethod -Uri "$base/config"
    Format-Queue $r.queue
    return
}

if ($Mapping) {
    $r = Invoke-RestMethod -Uri "$base/config"
    Write-Host "Mappings ($($r.mapping.Count)):" -ForegroundColor Cyan
    $grouped = $r.mapping | Group-Object -Property group
    foreach ($g in $grouped) {
        $gn = if ($g.Name -eq "") { "(Chưa nhóm)" } else { $g.Name }
        Write-Host "  📂 $gn  [$($g.Count) effects]" -ForegroundColor Yellow
        foreach ($m in $g.Group) {
            $gname = if ($m.giftName) { $m.giftName } else { "(chưa pick gift)" }
            Write-Host "    Gift $($m.giftId) '$gname' → $($m.hotkey)  CD=$($m.cooldownMs)ms"
        }
    }
    return
}

if ($GiftId -eq "") {
    Write-Host "Usage: .\test-simulate-gift.ps1 <giftId> [count]" -ForegroundColor Red
    Write-Host "Run with -Mapping to see available mappings"
    return
}

$body = @{ giftId = $GiftId; repeatCount = $Count } | ConvertTo-Json
try {
    $r = Invoke-RestMethod -Uri "$base/queue/simulate-gift" -Method POST `
        -ContentType "application/json" -Body $body
    if ($r.ok) {
        Write-Host "✓ Enqueued $($r.enqueued) effects (group='$($r.group)')" -ForegroundColor Green
        Format-Queue $r.queue
    } else {
        Write-Host "✗ FAIL: $($r.reason)" -ForegroundColor Red
    }
} catch {
    Write-Host "✗ ERROR: $($_.Exception.Message)" -ForegroundColor Red
}

# ═══════════════════════════════════════════
# MeetMind AI — Test Script
# Run this in a SECOND PowerShell window while services are running
# ═══════════════════════════════════════════

Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MeetMind AI — Service Health Check" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Test 1: Control Server
Write-Host "Testing meet-control-server (port 3001)..." -NoNewline
try {
    $r = Invoke-RestMethod -Uri "http://localhost:3001/health" -TimeoutSec 5
    Write-Host " [OK]" -ForegroundColor Green
} catch {
    Write-Host " [FAILED] - Is it running?" -ForegroundColor Red
}

# Test 2: Meet Bot
Write-Host "Testing meet-bot (port 3000)..." -NoNewline
try {
    $r = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 5
    Write-Host " [OK]" -ForegroundColor Green
} catch {
    Write-Host " [FAILED] - Is it running?" -ForegroundColor Red
}

# Test 3: MeetMind Agent
Write-Host "Testing meetmind-agent (port 8080)..." -NoNewline
try {
    $r = Invoke-RestMethod -Uri "http://localhost:8080/health" -TimeoutSec 5
    Write-Host " [OK]" -ForegroundColor Green
} catch {
    Write-Host " [FAILED] - Is it running?" -ForegroundColor Red
}

Write-Host ""

# Test 4: List roles
Write-Host "Fetching available roles..." -ForegroundColor Yellow
try {
    $roles = Invoke-RestMethod -Uri "http://localhost:8080/api/roles" -TimeoutSec 5
    foreach ($role in $roles.roles) {
        Write-Host "  - $($role.role_name) ($($role.mode))" -ForegroundColor White
    }
    Write-Host "[OK] $($roles.roles.Count) roles available" -ForegroundColor Green
} catch {
    Write-Host "[FAILED] Could not fetch roles" -ForegroundColor Red
}

Write-Host ""

# Test 5: Try deploying to a meeting (optional)
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Ready to test with a real meeting?" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Create a Google Meet at https://meet.google.com" -ForegroundColor White
Write-Host "2. Copy the meeting URL" -ForegroundColor White
Write-Host "3. Paste it below to deploy the agent" -ForegroundColor White
Write-Host ""

$meetUrl = Read-Host "Paste Google Meet URL (or press Enter to skip)"

if ($meetUrl -and $meetUrl -match "meet.google.com") {
    Write-Host ""
    Write-Host "Deploying MeetMind agent as 'Meeting Scribe'..." -ForegroundColor Yellow
    
    $body = @{
        meeting_url = $meetUrl
        role_id = "meeting_scribe"
        vision_enabled = $true
        display_name = "MeetMind AI"
    } | ConvertTo-Json

    try {
        $result = Invoke-RestMethod -Uri "http://localhost:8080/api/deploy" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 30
        
        Write-Host ""
        Write-Host "[OK] Agent deployed!" -ForegroundColor Green
        Write-Host "  Session: $($result.session_id)" -ForegroundColor White
        Write-Host "  Role:    $($result.role_name)" -ForegroundColor White
        Write-Host "  Mode:    $($result.mode)" -ForegroundColor White
        Write-Host "  Status:  $($result.status)" -ForegroundColor White
        Write-Host ""
        Write-Host "Check the meeting — the bot should be joining now!" -ForegroundColor Yellow
        Write-Host "Watch the docker compose logs for real-time events." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "To end the session:" -ForegroundColor Cyan
        Write-Host "  Invoke-RestMethod -Uri 'http://localhost:8080/api/session/end' -Method Post" -ForegroundColor White
    } catch {
        Write-Host "[FAILED] $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Check docker compose logs for details." -ForegroundColor Yellow
    }
} else {
    Write-Host "Skipped. You can deploy later via the API or dashboard." -ForegroundColor Gray
}

Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Dashboard:  http://localhost:8080" -ForegroundColor White
Write-Host "  API Docs:   http://localhost:8080/docs" -ForegroundColor White
Write-Host "  Control:    http://localhost:3001" -ForegroundColor White
Write-Host "  Bot:        http://localhost:3000" -ForegroundColor White
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan

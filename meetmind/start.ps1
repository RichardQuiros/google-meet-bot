# ═══════════════════════════════════════════
# MeetMind AI — Windows Startup (Vertex AI Mode)
# Run this in PowerShell from the meetmind/ folder
# ═══════════════════════════════════════════

Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MeetMind AI — Vertex AI Setup" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Docker
$dockerRunning = docker info 2>$null
if (-not $?) {
    Write-Host "ERROR: Docker is not running!" -ForegroundColor Red
    Write-Host "Open Docker Desktop and wait for it to start." -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Docker is running" -ForegroundColor Green

# Step 2: Check gcloud CLI
$gcloudInstalled = gcloud version 2>$null
if (-not $?) {
    Write-Host ""
    Write-Host "ERROR: gcloud CLI is not installed!" -ForegroundColor Red
    Write-Host "Install it from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
    Write-Host "Then run: gcloud init" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] gcloud CLI found" -ForegroundColor Green

# Step 3: Get or set GCP Project ID
if (-not $env:GOOGLE_CLOUD_PROJECT) {
    $currentProject = gcloud config get-value project 2>$null
    if ($currentProject) {
        Write-Host "[OK] GCP Project: $currentProject" -ForegroundColor Green
        $env:GOOGLE_CLOUD_PROJECT = $currentProject
    } else {
        $env:GOOGLE_CLOUD_PROJECT = Read-Host "Enter your GCP Project ID"
    }
} else {
    Write-Host "[OK] GCP Project: $env:GOOGLE_CLOUD_PROJECT" -ForegroundColor Green
}

# Step 4: Set location
if (-not $env:GOOGLE_CLOUD_LOCATION) {
    $env:GOOGLE_CLOUD_LOCATION = "us-central1"
}
Write-Host "[OK] Location: $env:GOOGLE_CLOUD_LOCATION" -ForegroundColor Green

# Step 5: Enable required APIs
Write-Host ""
Write-Host "Enabling Vertex AI API..." -ForegroundColor Yellow
gcloud services enable aiplatform.googleapis.com --project=$env:GOOGLE_CLOUD_PROJECT 2>$null
Write-Host "[OK] Vertex AI API enabled" -ForegroundColor Green

# Step 6: Create Application Default Credentials
Write-Host ""
Write-Host "Setting up authentication from the local gcloud profile..." -ForegroundColor Yellow

# ADC must live in the standard gcloud profile path, never inside the repository.
$adcPath = "$env:APPDATA\gcloud\application_default_credentials.json"
if (-not (Test-Path $adcPath)) {
    Write-Host "You need to authenticate with Google Cloud." -ForegroundColor Yellow
    Write-Host "A browser window will open — sign in with your Google account." -ForegroundColor Yellow
    Write-Host ""
    gcloud auth application-default login
}

if (Test-Path $adcPath) {
    $env:GOOGLE_ADC_PATH = $adcPath
    Write-Host "[OK] Application Default Credentials found" -ForegroundColor Green
    Write-Host "[OK] Using ADC outside the repository: $env:GOOGLE_ADC_PATH" -ForegroundColor Green
} else {
    Write-Host "ERROR: ADC not found at $adcPath" -ForegroundColor Red
    Write-Host "Run: gcloud auth application-default login" -ForegroundColor Yellow
    exit 1
}

# Step 7: Show config summary
Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Configuration Summary" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Project:  $env:GOOGLE_CLOUD_PROJECT" -ForegroundColor White
Write-Host "  Location: $env:GOOGLE_CLOUD_LOCATION" -ForegroundColor White
Write-Host "  Model:    gemini-2.5-flash (text mode)" -ForegroundColor White
Write-Host "  Auth:     Application Default Credentials" -ForegroundColor White
Write-Host "  ADC Path: $env:GOOGLE_ADC_PATH" -ForegroundColor White
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Step 8: Build and run
Write-Host "Starting MeetMind (first build takes 5-10 min)..." -ForegroundColor Yellow
Write-Host ""

docker compose up --build

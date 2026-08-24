# Start Reslo Backend + Svelte Frontend + Cloudflare Tunnel + Localtunnel
# Universal startup: auto-builds frontend, starts unified FastAPI server on port 8000,
# establishes stable public tunnels (Cloudflare + Localtunnel), and logs all output.
# Usage: .\start_tunnel.ps1 or run start.bat
# Stop:  .\stop_tunnel.ps1

# 1. Auto-detect custom Node.js and Python installation paths
$customPaths = @(
    "C:\PROKON\bin\Python",
    "C:\PROKON\bin\Python\Scripts",
    "$env:LOCALAPPDATA\Python\pythoncore-3.14-64",
    "$env:LOCALAPPDATA\Python\pythoncore-3.14-64\Scripts",
    "$env:LOCALAPPDATA\Programs\Python\Python312",
    "$env:LOCALAPPDATA\Programs\Python\Python311",
    "$env:LOCALAPPDATA\Programs\Python\Python310",
    "C:\Program Files\nodejs",
    "C:\Users\m.marjan\AppData\Local\OpenAI\Codex\runtimes\cua_node\fb8898c05a62885e\bin",
    "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VisualStudio\NodeJs"
)
foreach ($p in $customPaths) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

# Helper to read files that are locked by running background processes
function Get-SharedContent($path) {
    if (Test-Path $path) {
        try {
            $file = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $reader = New-Object System.IO.StreamReader($file)
            $text = $reader.ReadToEnd()
            $reader.Close()
            $file.Close()
            return $text
        } catch {
            return $null
        }
    }
    return $null
}

# Helper to health-check the local backend
function Test-BackendHealth() {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# Helper to poll for TryCloudflare URL
function Get-CloudflareUrl($logPath, $port = 8000) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        for ($i = 0; $i -lt 15; $i++) {
            $log = Get-SharedContent $logPath
            if ($log -and ($log -match "(https://[a-zA-Z0-9\-]+\.trycloudflare\.com)")) {
                return $Matches[1]
            }
            Start-Sleep -Seconds 1
        }
    }
    return $null
}

# 2. Stop any existing processes on ports 8000 and 5173
Write-Host "Checking for existing processes on ports 8000 and 5173..." -ForegroundColor Cyan
$ports = @(8000, 5173)
foreach ($port in $ports) {
    $existingConn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($existingConn) {
        Write-Host "Port $port is occupied. Terminating existing process..." -ForegroundColor Yellow
        foreach ($conn in $existingConn) {
            if ($conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
Start-Sleep -Seconds 1

# 3. Stop any running cloudflared or localtunnel processes
Write-Host "Stopping any running tunnel processes..." -ForegroundColor Cyan
Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*localtunnel*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 4. Detect cloudflared binary
Write-Host "Checking Cloudflared..." -ForegroundColor Cyan
$cloudflaredPaths = @(
    "$PSScriptRoot\cloudflared.exe",
    "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    "C:\Program Files\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
)
$cloudflaredExe = $null
foreach ($cp in $cloudflaredPaths) {
    if (Test-Path $cp) { $cloudflaredExe = $cp; break }
}
if (-not $cloudflaredExe) {
    $cloudflaredExe = (Get-Command "cloudflared" -ErrorAction SilentlyContinue).Source
}

# 5. Detect compatible Python environment (prioritize PROKON Python)
Write-Host "Detecting compatible Python environment..." -ForegroundColor Cyan
$pyExe = $null
$pyArgs = @()

$pyCandidates = @(
    @{ Path = "C:\PROKON\bin\Python\python.exe"; Args = @() },
    @{ Path = "py"; Args = @("-3.10") },
    @{ Path = "py"; Args = @("-3.11") },
    @{ Path = "py"; Args = @("-3.12") },
    @{ Path = "py"; Args = @() },
    @{ Path = "python"; Args = @() }
)

foreach ($c in $pyCandidates) {
    $target = $c.Path
    if ($target -like "*\*" -and (-not (Test-Path $target))) { continue }
    
    $cmd = Get-Command $target -ErrorAction SilentlyContinue
    if (-not $cmd -and -not (Test-Path $target)) { continue }

    $testArgs = $c.Args + @("-c", "import fastapi, uvicorn")
    & $target $testArgs >$null 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pyExe = if (Test-Path $target) { $target } else { $cmd.Source }
        $pyArgs = $c.Args
        Write-Host "Found compatible Python environment: $pyExe" -ForegroundColor Green
        break
    }
}

if (-not $pyExe) {
    Write-Host "ERROR: Could not find a Python environment with fastapi and uvicorn." -ForegroundColor Red
    Exit
}

# 6. Check npm and build frontend if needed
$distIndex = "$PSScriptRoot\dist\index.html"
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue

if ($npmCmd -and (-not (Test-Path $distIndex))) {
    Write-Host "Building Svelte production bundle (npm run build)..." -ForegroundColor Cyan
    Push-Location $PSScriptRoot
    npm run build 2>&1 | Out-Null
    Pop-Location
}

# 7. Start unified FastAPI + Frontend Server on port 8000
Write-Host "Starting Unified Reslo Server on http://127.0.0.1:8000..." -ForegroundColor Cyan
$logPath = Join-Path $PSScriptRoot "backend.log"
$outLogPath = Join-Path $PSScriptRoot "backend_stdout.log"
if (Test-Path $logPath) { Remove-Item $logPath -Force -ErrorAction SilentlyContinue }
if (Test-Path $outLogPath) { Remove-Item $outLogPath -Force -ErrorAction SilentlyContinue }

$backendArgs = $pyArgs + @("-u", "backend\main.py")
Start-Process -FilePath $pyExe -ArgumentList $backendArgs -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput $outLogPath -RedirectStandardError $logPath -WindowStyle Hidden -PassThru | Out-Null

# 8. Health check loop
Write-Host "Waiting for server to become ready..." -ForegroundColor Cyan
$backendReady = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-BackendHealth) {
        $backendReady = $true
        Write-Host "Server is online! (took $($i+1)s)" -ForegroundColor Green
        break
    }
}

if (-not $backendReady) {
    Write-Host "ERROR: Backend failed to start. Check backend.log:" -ForegroundColor Red
    if (Test-Path $logPath) { Get-Content $logPath | Select-Object -Last 20 }
}

# 9. Start Cloudflare Tunnel and Localtunnel
$cloudflareUrl = $null
$localtunnelUrl = $null

if ($backendReady) {
    # 9a. Start Cloudflare Tunnel
    if ($cloudflaredExe) {
        Write-Host "Starting Cloudflare Tunnel..." -ForegroundColor Cyan
        $tunnelLog = Join-Path $PSScriptRoot "tunnel.log"
        if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }

        Start-Process -FilePath $cloudflaredExe -ArgumentList "tunnel --url http://127.0.0.1:8000" `
            -WorkingDirectory $PSScriptRoot -RedirectStandardError $tunnelLog -WindowStyle Hidden -PassThru | Out-Null

        $cloudflareUrl = Get-CloudflareUrl $tunnelLog 8000
    }

    # 9b. Start Localtunnel (instant fallback that resolves on all ISPs)
    $npxCmd = Get-Command npx -ErrorAction SilentlyContinue
    if ($npxCmd) {
        Write-Host "Starting Localtunnel (global ISP fallback)..." -ForegroundColor Cyan
        $ltLog = Join-Path $PSScriptRoot "tunnel_lt.log"
        if (Test-Path $ltLog) { Remove-Item $ltLog -Force -ErrorAction SilentlyContinue }

        Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx -y localtunnel --port 8000 > `"$ltLog`" 2>&1" `
            -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru | Out-Null

        for ($k = 0; $k -lt 15; $k++) {
            Start-Sleep -Seconds 1
            $ltContent = Get-SharedContent $ltLog
            if ($ltContent -and ($ltContent -match "(https://[a-zA-Z0-9\-]+\.loca\.lt)")) {
                $localtunnelUrl = $Matches[1]
                break
            }
        }
    }
}

# 10. Summary and Launch
$localLink = "http://localhost:8000/?api=http://localhost:8000"

Write-Host "`n=================================================================" -ForegroundColor Green
Write-Host "         RESLO STRUCTURAL FEA PLATFORM IS ONLINE!                " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Green
Write-Host "  LOCAL LINK (Fastest on this machine):" -ForegroundColor Cyan
Write-Host "    $localLink" -ForegroundColor Yellow
Write-Host ""

if ($cloudflareUrl) {
    $cfShareLink = "$cloudflareUrl/?api=$cloudflareUrl"
    Write-Host "  CLOUDFLARE SHARE LINK (Python DKT Solver via API):" -ForegroundColor Cyan
    Write-Host "    $cfShareLink" -ForegroundColor Green
}

if ($localtunnelUrl) {
    $ltShareLink = "$localtunnelUrl/?api=$localtunnelUrl"
    Write-Host "  LOCALTUNNEL SHARE LINK (Universal ISP Fallback):" -ForegroundColor Cyan
    Write-Host "    $ltShareLink" -ForegroundColor Green
}

Write-Host "=================================================================" -ForegroundColor Green
Write-Host "To stop the server and tunnels, run: .\stop_tunnel.ps1" -ForegroundColor Yellow
Write-Host "Logs: backend.log, tunnel.log, tunnel_lt.log" -ForegroundColor Gray
Write-Host "=================================================================" -ForegroundColor Green

Write-Host "`nOpening Reslo in your default browser..." -ForegroundColor Cyan
Start-Process $localLink

Write-Host "`n[RUNNING] Reslo Server and Tunnels are active." -ForegroundColor Green
Write-Host "[INFO] Keep this terminal window open while using Reslo." -ForegroundColor Yellow
Write-Host "[INFO] Press Ctrl+C in this window or run .\stop_tunnel.ps1 to stop." -ForegroundColor Gray

# Keep-alive monitoring loop to ensure backend and tunnel processes stay alive
try {
    while ($true) {
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host "`nShutting down Reslo services..." -ForegroundColor Yellow
    & "$PSScriptRoot\stop_tunnel.ps1"
}


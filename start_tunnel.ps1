# Start Reslo Backend + Svelte Frontend + Cloudflare Tunnels + Surge
# Universal startup: auto-builds frontend, health-checks backend, logs all errors
# Usage: .\start_tunnel.ps1
# Stop:  .\stop_tunnel.ps1

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

# Helper to poll for trycloudflare.com URL up to 60 seconds after tunnel registration
function Get-TunnelUrl($logPath) {
    for ($i = 0; $i -lt 60; $i++) {
        $log = Get-SharedContent $logPath
        if ($log -and ($log -match "Registered tunnel connection") -and ($log -match "(https://[a-zA-Z0-9\-]+\.trycloudflare\.com)")) {
            return $Matches[1]
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

# Helper to health-check the backend (returns $true if backend is online)
function Test-BackendHealth() {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}


# 1. Stop any existing backend processes on port 8000 and 5173
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

# 2. Stop any existing cloudflared process
Write-Host "Stopping any running cloudflared processes..." -ForegroundColor Cyan
Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue

# 3. Check cloudflared is installed
Write-Host "Checking Cloudflared..." -ForegroundColor Cyan
$cloudflaredPaths = @(
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
if (-not $cloudflaredExe) {
    Write-Host "WARNING: cloudflared not found. Install from:" -ForegroundColor Yellow
    Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" -ForegroundColor Yellow
    Write-Host "Or place cloudflared.exe in one of:" -ForegroundColor Yellow
    foreach ($cp in $cloudflaredPaths) { Write-Host "  - $cp" -ForegroundColor Yellow }
    Write-Host "Continuing with local-only URLs (no tunnel will be started)..." -ForegroundColor Yellow
}

# 4. Detect compatible Python environment and start the backend
Write-Host "Detecting compatible Python environment..." -ForegroundColor Cyan
$pyExe = $null
$pyArgs = @()

# We test in order: py -3.10, py -3.11, py -3.12, py, python
$candidates = @(
    @{ Cmd = "py"; Args = @("-3.10") },
    @{ Cmd = "py"; Args = @("-3.11") },
    @{ Cmd = "py"; Args = @("-3.12") },
    @{ Cmd = "py"; Args = @() },
    @{ Cmd = "python"; Args = @() }
)

foreach ($c in $candidates) {
    $cmd = $c.Cmd
    $exePath = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $exePath) { continue }

    # Run check script using direct execution to avoid quote-stripping issues
    $testArgs = $c.Args + @("-c", "import KratosMultiphysics, KratosStructuralMechanicsApplication, fastapi, uvicorn")
    & $cmd $testArgs >$null 2>&1
    if ($LASTEXITCODE -eq 0) {
        $realPy = & $cmd $c.Args -c "import sys; print(sys.executable)" 2>$null
        if ($realPy -and (Test-Path $realPy.Trim())) {
            $pyExe = $realPy.Trim()
            $pyArgs = @()
        } else {
            $pyExe = $exePath.Source
            $pyArgs = $c.Args
        }
        Write-Host "Found compatible Python environment: $pyExe" -ForegroundColor Green
        break
    }
}

if (-not $pyExe) {
    Write-Host "WARNING: Could not find a Python version that successfully loads Kratos + fastapi." -ForegroundColor Yellow

    Write-Host "Checking for default launcher..." -ForegroundColor Cyan

    $pyCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCmd) {
        $pyExe = $pyCmd.Source
        $pyArgs = @("-3.12")
        Write-Host "Falling back to default 'py -3.12' launcher." -ForegroundColor Yellow
    } else {
        $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCmd) {
            $pyExe = $pythonCmd.Source
            $pyArgs = @()
            Write-Host "Falling back to system 'python'." -ForegroundColor Yellow
        } else {
            Write-Host "ERROR: Python is not installed or not in PATH." -ForegroundColor Red
            Exit
        }
    }
}

# 5. Ensure npm dependencies are installed
Write-Host "Checking npm dependencies..." -ForegroundColor Cyan
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($npmCmd) {
    if (-not (Test-Path "$PSScriptRoot\node_modules")) {
        Write-Host "node_modules not found. Running npm install..." -ForegroundColor Yellow
        Push-Location $PSScriptRoot
        npm install 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: npm install failed. Build may fail." -ForegroundColor Yellow
        }
        Pop-Location
    }
} else {
    Write-Host "WARNING: npm not found - cannot build frontend." -ForegroundColor Yellow
}

# 6. Delete existing .env so the frontend builds with default backend URL (localhost:8000)
#    The ?api= query param in share links will override this at runtime.
if (Test-Path "$PSScriptRoot\.env") {
    Remove-Item "$PSScriptRoot\.env" -Force -ErrorAction SilentlyContinue
}

# 7. Auto-build the frontend before serving (ensures dist/ is always up-to-date)
Write-Host "Building Svelte frontend (npm run build)..." -ForegroundColor Cyan
if ($npmCmd) {
    Push-Location $PSScriptRoot
    npm run build 2>&1 | Tee-Object -Variable buildOutput | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: Frontend build failed. Serving existing dist/ if available." -ForegroundColor Yellow
        Write-Host ($buildOutput | Select-Object -Last 10 | Out-String) -ForegroundColor Yellow
    } else {
        Write-Host "Frontend build complete." -ForegroundColor Green
    }
    Pop-Location
}

# 8. Verify dist/ exists
$distIndex = "$PSScriptRoot\dist\index.html"
if (-not (Test-Path $distIndex)) {
    Write-Host "ERROR: $distIndex not found. Frontend build failed or never ran." -ForegroundColor Red
    Write-Host "Run 'npm run build' manually from the reslo directory." -ForegroundColor Yellow
    # Continue anyway - tunnels may still work for backend
}

# 9. Start FastAPI backend (redirect stderr to backend.log)
# Uvicorn logs to stderr, Python crash tracebacks go to stderr too.
# Use absolute log path so the file is always created in the right place.
Write-Host "Starting FastAPI backend (Kratos solver)..." -ForegroundColor Cyan
$logPath = Join-Path $PSScriptRoot "backend.log"
if (Test-Path $logPath) { Remove-Item $logPath -Force -ErrorAction SilentlyContinue }
$backendArgs = $pyArgs + @("-u", "backend\main.py")
Start-Process -FilePath $pyExe -ArgumentList $backendArgs -WorkingDirectory $PSScriptRoot `
    -RedirectStandardError $logPath -WindowStyle Hidden -PassThru | Out-Null

# 10. Wait up to 30 seconds for backend to become healthy (health check loop)
Write-Host "Waiting for backend to start (health checking http://127.0.0.1:8000/api/health)..." -ForegroundColor Cyan
$backendReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-BackendHealth) {
        $backendReady = $true
        Write-Host "Backend is online! (took $($i+1)s)" -ForegroundColor Green
        break
    }
}

if (-not $backendReady) {
    Write-Host "" -ForegroundColor Red
    Write-Host "ERROR: Backend failed to start within 30 seconds." -ForegroundColor Red
    Write-Host "Check backend.log for details:" -ForegroundColor Yellow
    if (Test-Path $logPath) {
        Get-Content $logPath | Select-Object -Last 30
    } else {
        Write-Host "(backend.log not found - process may have crashed immediately)" -ForegroundColor Yellow
    }
    Write-Host "" -ForegroundColor Red
    Write-Host "Common causes:" -ForegroundColor Yellow
    Write-Host "  - KratosMultiphysics not installed (pip install KratosMultiphysics KratosStructuralMechanicsApplication)" -ForegroundColor Yellow
    Write-Host "  - Missing Python dependencies (pip install fastapi uvicorn scipy numpy gmsh)" -ForegroundColor Yellow
    Write-Host "  - Port 8000 already in use (netstat -ano | findstr :8000)" -ForegroundColor Yellow
    # Continue anyway so frontend still serves (worker fallback works without backend)
}

# 11. Start Backend Cloudflare Tunnel (only if cloudflared was found)
$backendUrl = $null
if ($cloudflaredExe) {
    Write-Host "Starting Backend Cloudflare Tunnel..." -ForegroundColor Cyan
    $tunnelLog = Join-Path $PSScriptRoot "tunnel.log"
    if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }
    Start-Process $cloudflaredExe -ArgumentList "tunnel --url http://127.0.0.1:8000 --http-host-header 127.0.0.1" -WorkingDirectory $PSScriptRoot -RedirectStandardError $tunnelLog -WindowStyle Hidden -PassThru | Out-Null

    # 12. Wait for Backend Tunnel and extract the URL
    Write-Host "Waiting for Backend Tunnel to connect..." -ForegroundColor Cyan
    $backendUrl = Get-TunnelUrl $tunnelLog

    if ($backendUrl) {
        Write-Host "Backend tunnel established: $backendUrl" -ForegroundColor Green
        # Write VITE_API_URL to .env for NEXT build (current build uses ?api= fallback)
        "VITE_API_URL=$backendUrl" | Out-File -FilePath "$PSScriptRoot\.env" -Encoding utf8
    } else {
        Write-Host "WARNING: Backend tunnel failed to establish." -ForegroundColor Red
        Write-Host "Check tunnel.log for errors." -ForegroundColor Yellow
    }
} else {
    Write-Host "Skipping tunnels (cloudflared not found)." -ForegroundColor Yellow
}

# 13. Deploy frontend to Surge.sh (if surge CLI is installed and logged in)
$surgeDeployed = $false
if (Test-Path $distIndex) {
    $surgeCmd = Get-Command "surge" -ErrorAction SilentlyContinue
    if ($surgeCmd) {
        # Check if Surge is logged in (looks for token file)
        $surgeTokenPath = "$env:USERPROFILE\.surge\surge_token"
        if (Test-Path $surgeTokenPath) {
            Write-Host "Deploying frontend to Surge.sh..." -ForegroundColor Cyan
            $surgeDomain = "reslo-graph.surge.sh"
            $surgeOutput = surge --project "$PSScriptRoot\dist" --domain $surgeDomain 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0) {
                $surgeDeployed = $true
                Write-Host "Surge deployment complete: https://$surgeDomain" -ForegroundColor Green
            } else {
                Write-Host "WARNING: Surge deployment failed:" -ForegroundColor Yellow
                Write-Host "$surgeOutput" -ForegroundColor Yellow
            }
        } else {
            Write-Host "Surge CLI found but not logged in. To enable Surge deployment:" -ForegroundColor Yellow
            Write-Host "  surge login" -ForegroundColor Yellow
            Write-Host "Skipping Surge deploy for now." -ForegroundColor Yellow
        }
    } else {
        Write-Host "Surge CLI not found. Install with: npm install -g surge" -ForegroundColor Yellow
    }
}

# 14. Start frontend static server (only if dist/ exists)
$frontendUrl = $null
if (Test-Path $distIndex) {
    Write-Host "Starting Svelte frontend static production server..." -ForegroundColor Cyan
    Start-Process $pyExe -ArgumentList @("-m", "http.server", "5173", "--directory", "dist") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru | Out-Null
    Start-Sleep -Seconds 2

    # 15. Start Frontend Cloudflare Tunnel (only if cloudflared was found)
    if ($cloudflaredExe) {
        Write-Host "Starting Frontend Cloudflare Tunnel..." -ForegroundColor Cyan
        $tunnelFrontendLog = Join-Path $PSScriptRoot "tunnel_frontend.log"
        if (Test-Path $tunnelFrontendLog) { Remove-Item $tunnelFrontendLog -Force -ErrorAction SilentlyContinue }
        Start-Process $cloudflaredExe -ArgumentList "tunnel --url http://127.0.0.1:5173 --http-host-header 127.0.0.1" -WorkingDirectory $PSScriptRoot -RedirectStandardError $tunnelFrontendLog -WindowStyle Hidden -PassThru | Out-Null

        Write-Host "Waiting for Frontend Tunnel to connect..." -ForegroundColor Cyan
        $frontendUrl = Get-TunnelUrl $tunnelFrontendLog
        if ($frontendUrl) {
            Write-Host "Frontend tunnel established: $frontendUrl" -ForegroundColor Green
        } else {
            Write-Host "WARNING: Frontend tunnel failed to establish." -ForegroundColor Red
            Write-Host "Check tunnel_frontend.log for errors." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Skipping frontend server (dist/ not found)." -ForegroundColor Yellow
}

# 16. Print shareable links
Write-Host "`n=================================================================" -ForegroundColor Green
Write-Host " RESLO IS LIVE AND ACCESSIBLE FROM ANYWHERE IN THE WORLD!" -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Green

if (-not $backendReady) {
    Write-Host " !! WARNING: Backend health check FAILED - Kratos may not be running!" -ForegroundColor Red
    Write-Host "    The frontend will use the in-browser Web Worker (no backend needed)." -ForegroundColor Yellow
    Write-Host "    Check backend.log for error details." -ForegroundColor Yellow
} elseif ($backendUrl) {
    Write-Host " [OK] Backend is ONLINE with Kratos solver" -ForegroundColor Green
} else {
    Write-Host " [OK] Backend is ONLINE (local only - no tunnel)" -ForegroundColor Green
}

if ($frontendUrl) {
    $cloudflareShareLink = "$frontendUrl/?api=$backendUrl"
    Write-Host " SHARE THIS LINK (Cloudflare Tunnel - anyone can open):" -ForegroundColor Cyan
    Write-Host "    $cloudflareShareLink" -ForegroundColor Yellow
}

if ($surgeDeployed) {
    $surgeShareLink = "https://reslo-graph.surge.sh/?api=$backendUrl"
    Write-Host " SURGE PRODUCTION LINK (always online):" -ForegroundColor Cyan
    Write-Host "    $surgeShareLink" -ForegroundColor Yellow
}

if (Test-Path $distIndex) {
    $localLink = "http://localhost:5173/?api=http://localhost:8000"
    Write-Host " LOCAL ONLY (this machine):" -ForegroundColor Cyan
    Write-Host "    $localLink" -ForegroundColor Yellow
}

if ($backendUrl) {
    Write-Host " BACKEND API URL:" -ForegroundColor Cyan
    Write-Host "    $backendUrl" -ForegroundColor Yellow
}

Write-Host "=================================================================" -ForegroundColor Green
Write-Host "To stop everything, run: .\stop_tunnel.ps1" -ForegroundColor Yellow
Write-Host "Backend log: backend.log" -ForegroundColor Gray
Write-Host "Tunnel logs: tunnel.log, tunnel_frontend.log" -ForegroundColor Gray

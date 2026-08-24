# Stop Reslo Backend + Svelte Frontend + Tunnels

Write-Host "Stopping all hosting processes..." -ForegroundColor Cyan

# 1. Stop processes on port 8000 and 5173
$ports = @(8000, 5173)
foreach ($port in $ports) {
    $existingConn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($existingConn) {
        foreach ($conn in $existingConn) {
            if ($conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# 2. Stop cloudflared
Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue

# 3. Stop localtunnel node processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*localtunnel*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Successfully stopped all hosting processes." -ForegroundColor Green


# Start Claude Code connected to OmniRoute
$env:PATH = "$env:PATH;C:\Users\Mohammed Marjan\AppData\Roaming\npm"
$env:ANTHROPIC_BASE_URL = "http://localhost:20128"
$env:ANTHROPIC_AUTH_TOKEN = "sk-64a2099be98b2ab9-3ab189-144af3ce"
$env:ANTHROPIC_MODEL = "agy"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "190000"

Write-Host "=================================================" -ForegroundColor Green
Write-Host " Starting Claude Code connected to OmniRoute " -ForegroundColor Green
Write-Host " Base URL: http://localhost:20128" -ForegroundColor Cyan
Write-Host " Model:    agy" -ForegroundColor Cyan
Write-Host " Token:    sk-64a2099be98b2ab9-3ab189-144af3ce" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Green

& claude $args

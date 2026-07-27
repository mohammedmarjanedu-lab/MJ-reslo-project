@echo off
set "PATH=%PATH%;C:\Users\Mohammed Marjan\AppData\Roaming\npm"
set "ANTHROPIC_BASE_URL=http://localhost:20128"
set "ANTHROPIC_AUTH_TOKEN=sk-64a2099be98b2ab9-3ab189-144af3ce"
set "ANTHROPIC_MODEL=agy"
set "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"
set "CLAUDE_CODE_AUTO_COMPACT_WINDOW=190000"

echo =================================================
echo  Starting Claude Code connected to OmniRoute 
echo  Base URL: http://localhost:20128
echo  Model:    agy
echo  Token:    sk-64a2099be98b2ab9-3ab189-144af3ce
echo =================================================

claude %*

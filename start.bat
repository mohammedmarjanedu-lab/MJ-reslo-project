@echo off
cd /d "%~dp0"
echo ====================================================
echo  Reslo - One-Click Start
echo ====================================================
powershell -ExecutionPolicy Bypass -File "%~dp0start_tunnel.ps1"
pause

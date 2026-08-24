@echo off
cd /d "%~dp0"
echo ====================================================
echo  Reslo - One-Click Push to GitHub
echo ====================================================
echo Staging all changes...
git add .
echo Committing latest changes...
git commit -m "Update Reslo codebase with all latest features, solvers, and ETABS parity"
echo Pushing to origin main...
git push origin main
echo ====================================================
echo Done!
pause

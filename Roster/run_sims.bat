@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Sim fronta -> Raidbots Droptimizer -> wowaudit ===
python sim_runner.py %*
echo.
pause

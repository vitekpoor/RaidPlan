@echo off
rem Regenerates ESAttendance\RosterData.lua from the web roster (Worker API) and copies the addon
rem into ..\..\_retail_\Interface\AddOns\ESAttendance. Then /reload in game.
cd /d "%~dp0"
python build_roster.py --install %*
pause

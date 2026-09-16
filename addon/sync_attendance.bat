@echo off
rem Sends attendance records written in game (ESAttendance SavedVariables) to the
rem "Dochazka" sheet tab. WoW saves the file on logout or /reload - do that first.
cd /d "%~dp0"
python sync_attendance.py %*
pause

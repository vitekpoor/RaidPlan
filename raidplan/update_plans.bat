@echo off
setlocal
cd /d "%~dp0"

rem One-click sync of RaidPlan plans with the "Boss sestavy" sheet tab.
rem   update_plans.bat            -> all bosses
rem   update_plans.bat 02         -> just boss 02
rem   update_plans.bat 02 05 09   -> several bosses
rem Plans are saved IN PLACE (edit keys come from venomabyss_plans.txt).
rem Preview without saving: update_plans.bat 02 --dry-run

if "%~1"=="" (
    python -X utf8 raidplan.py --boss all
) else (
    python -X utf8 raidplan.py --boss %*
)
pause

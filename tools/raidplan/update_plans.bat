@echo off
setlocal
cd /d "%~dp0"

rem One-click sync of RaidPlan plans with the "Boss sestavy" sheet tab.
rem   update_plans.bat                    -> all bosses
rem   update_plans.bat 02                 -> just boss 02
rem   update_plans.bat 02 05 09           -> several bosses
rem   update_plans.bat 02 Gina-Houdy      -> sync + SWAP two players' places
rem                                          and assignments (also A~B, A+B,
rem                                          A:B, "A x B", "A<->B" in quotes)
rem   update_plans.bat 02 Miky=Hase       -> sync + explicit rename
rem   update_plans.bat 02 --dry-run       -> preview without saving
rem   update_plans.bat --help             -> full help of raidplan.py
rem Undo (every save first backs up the plan as backup_<code>_rev<N>.json here):
rem   update_plans.bat --list-backups     -> what backups exist, per plan
rem   update_plans.bat 02 --restore       -> put plan 02 back to its newest backup
rem   update_plans.bat 02 --restore rev35 -> back to that revision
rem   update_plans.bat --restore backup_<code>_rev35.json   -> exactly this file
rem   (add --dry-run to see what a restore would change without saving)
rem Quote anything with spaces or <> ("Gina x Houdy", "Gina<->Houdy").
rem Class/spec icons, border colors and name spelling follow the Roster tab
rem (Main classa / Main role / optional Main spec). Plans are saved IN PLACE
rem (edit keys come from venomabyss_plans.txt).

if "%~1"=="" (
    python -X utf8 raidplan.py --boss all
) else if /i "%~1"=="--help" (
    python -X utf8 raidplan.py --help
) else if /i "%~1"=="-h" (
    python -X utf8 raidplan.py --help
) else if "%~1"=="/?" (
    python -X utf8 raidplan.py --help
) else if /i "%~1"=="--boss" (
    python -X utf8 raidplan.py %*
) else if /i "%~1"=="--restore" (
    python -X utf8 raidplan.py %*
) else if /i "%~1"=="--list-backups" (
    python -X utf8 raidplan.py %*
) else (
    python -X utf8 raidplan.py --boss %*
)
pause

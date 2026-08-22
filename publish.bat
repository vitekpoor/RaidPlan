@echo off
setlocal
cd /d "%~dp0"

rem parts\ and bosses\ are the master copies - build the single page
rem (venomous-abyss.html + index.html) from them before committing
call build.bat
if errorlevel 1 goto :end

git add -A

rem exit if there is nothing new to commit
git diff --cached --quiet
if %errorlevel%==0 (
    echo Nothing to publish - no changes since last commit.
    goto :end
)

rem commit message: everything passed as arguments, or a default
set "msg=%*"
if "%msg%"=="" set "msg=Update raid guide"

git commit -m "%msg%"
if errorlevel 1 goto :end

git push
if errorlevel 1 (
    echo.
    echo PUSH FAILED - check your connection or credentials and run again.
    goto :end
)

echo.
echo Published! Live in ~1 minute at:
echo   https://vitekpoor.github.io/RaidPlan/

:end
echo.
pause

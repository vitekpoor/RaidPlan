@echo off
setlocal
cd /d "%~dp0.."

rem Commit + push everything changed. The site itself is built on Cloudflare from web/ (web/build.mjs -> dist/)
rem on every push, so there is nothing to build or copy here any more.
git add -A
git diff --cached --quiet
if %errorlevel%==0 (
    echo Nothing to publish - no changes since last commit.
    goto :end
)

set "msg=%*"
if "%msg%"=="" set "msg=Update site"
git commit -m "%msg%"
if errorlevel 1 goto :end
git push
if errorlevel 1 (
    echo.
    echo PUSH FAILED - check your connection or credentials and run again.
    goto :end
)
echo.
echo Published! Cloudflare builds and deploys in ~1 minute:
echo   https://eternal-shadows.vitek-poor.workers.dev/

:end
echo.
pause

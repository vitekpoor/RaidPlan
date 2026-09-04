@echo off
setlocal
cd /d "%~dp0"

rem parts\ and bosses\ are the master copies. This assembles the single page:
rem   parts\head.html + bosses\*.html (alphabetical order) + parts\tail.html
rem into venomous-abyss.html (local preview here), then writes the repo-root
rem index.html for the GitHub Pages publish with asset paths rewritten to
rem point into raidplan\ (the root holds only index.html).

if not exist parts\head.html (echo ERROR: parts\head.html not found & exit /b 1)
if not exist parts\tail.html (echo ERROR: parts\tail.html not found & exit /b 1)

type parts\head.html > venomous-abyss.html
for %%f in (bosses\*.html) do type "%%f" >> venomous-abyss.html
type parts\tail.html >> venomous-abyss.html

powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\index.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0venomous-abyss.html') -replace '(boss_2_marks|sszorak_addon_0\d)\.png', 'raidplan/$0'), (New-Object System.Text.UTF8Encoding $false))"
if errorlevel 1 (echo ERROR: failed to write ..\index.html & exit /b 1)

echo Built venomous-abyss.html + ..\index.html from parts\ and bosses\.

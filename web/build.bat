@echo off
setlocal
cd /d "%~dp0"

rem parts\ and bosses\ are the master copies. This assembles the single page:
rem   parts\head.html + bosses\*.html (alphabetical order) + parts\tail.html
rem into venomous-abyss.html (local preview here), then writes the repo-root
rem raid.html for the GitHub Pages publish with asset paths rewritten to
rem point into web\. Root index.html = hub.html (guild landing page),
rem root loot.html = loot.html (sims overview).
rem Shared look lives in assets\css\site.css (+ assets\images\); every root copy
rem gets href/src="assets/..." rewritten to "web/assets/...".

if not exist parts\head.html (echo ERROR: parts\head.html not found & exit /b 1)
if not exist parts\tail.html (echo ERROR: parts\tail.html not found & exit /b 1)
if not exist assets\css\site.css (echo ERROR: assets\css\site.css not found & exit /b 1)

type parts\head.html > venomous-abyss.html
for %%f in (bosses\*.html) do type "%%f" >> venomous-abyss.html
type parts\tail.html >> venomous-abyss.html

powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\raid.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0venomous-abyss.html') -replace '(boss_2_marks|sszorak_addon_0\d)\.png', 'web/$0' -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
if errorlevel 1 (echo ERROR: failed to write ..\raid.html & exit /b 1)

rem hub.html (guild landing page) becomes the root index.html
if not exist hub.html (echo ERROR: hub.html not found & exit /b 1)
powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\index.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0hub.html') -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
if errorlevel 1 (echo ERROR: failed to write ..\index.html & exit /b 1)

rem loot.html (Loot simy) is a standalone page; the root copy loads loot_items.json from web\
if exist loot.html (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\loot.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0loot.html') -replace '\"loot_items\.json\"', '\"web/loot_items.json\"' -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
  if errorlevel 1 (echo ERROR: failed to write ..\loot.html & exit /b 1)
)

rem roster.html (soupiska z databáze, admin editace) is a standalone page
if exist roster.html (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\roster.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0roster.html') -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
  if errorlevel 1 (echo ERROR: failed to write ..\roster.html & exit /b 1)
)

rem attendance.html (docházka + absence z databáze) is a standalone page
if exist attendance.html (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\attendance.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0attendance.html') -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
  if errorlevel 1 (echo ERROR: failed to write ..\attendance.html & exit /b 1)
)

rem lineups.html (boss sestavy z databáze) is a standalone page
if exist lineups.html (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\lineups.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0lineups.html') -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
  if errorlevel 1 (echo ERROR: failed to write ..\lineups.html & exit /b 1)
)

rem flopik.html (Flopik - fails po pullech) is a standalone page reading the "Flopik" sheet tab
if exist flopik.html (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%~dp0..\flopik.html', ((Get-Content -Raw -Encoding UTF8 '%~dp0flopik.html') -replace '(href|src)=\"assets/', '$1=\"web/assets/'), (New-Object System.Text.UTF8Encoding $false))"
  if errorlevel 1 (echo ERROR: failed to write ..\flopik.html & exit /b 1)
)

echo Built venomous-abyss.html + ..\raid.html, ..\index.html (hub), ..\loot.html, ..\roster.html, ..\attendance.html, ..\lineups.html, ..\flopik.html.

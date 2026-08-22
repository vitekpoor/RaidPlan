@echo off
setlocal
cd /d "%~dp0"

rem parts\ and bosses\ are the master copies. This assembles the single page:
rem   parts\head.html + bosses\*.html (alphabetical order) + parts\tail.html
rem into venomous-abyss.html, mirrored to index.html.

if not exist parts\head.html (echo ERROR: parts\head.html not found & exit /b 1)
if not exist parts\tail.html (echo ERROR: parts\tail.html not found & exit /b 1)

type parts\head.html > venomous-abyss.html
for %%f in (bosses\*.html) do type "%%f" >> venomous-abyss.html
type parts\tail.html >> venomous-abyss.html

copy /y venomous-abyss.html index.html >nul
echo Built venomous-abyss.html + index.html from parts\ and bosses\.

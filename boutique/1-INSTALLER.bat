@echo off
setlocal
cd /d "%~dp0"
title Installation de Boutique
echo.
echo  === Installation de Boutique ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js n'est pas installe sur cet ordinateur.
  echo  Installez-le d'abord : https://nodejs.org  ^(version LTS^), puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

rem arrete une ancienne version si elle tourne (mise a jour)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

echo  Installation des composants ^(une minute environ, internet necessaire^)...
call npm install --omit=dev
if errorlevel 1 (
  echo.
  echo  L'installation a echoue. Verifiez la connexion internet et relancez.
  pause
  exit /b 1
)

rem raccourci sur le Bureau
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Boutique.lnk'); $s.TargetPath='%~dp0Boutique.vbs'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,13'; $s.Save()"

echo.
set /p AUTO= Faut-il que Boutique demarre toute seule avec Windows ? (O/N) : 
if /i "%AUTO%"=="O" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Boutique.lnk'); $s.TargetPath='%~dp0Boutique.vbs'; $s.Arguments='silencieux'; $s.WorkingDirectory='%~dp0'; $s.Save()"
  echo  C'est fait : Boutique demarrera avec Windows.
)

echo.
echo  Installation terminee. Une icone "Boutique" est sur votre Bureau.
echo  Ouverture de Boutique...
wscript "%~dp0Boutique.vbs"
echo.
pause

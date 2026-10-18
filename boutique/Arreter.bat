@echo off
rem Arrete Boutique (a utiliser avant une mise a jour).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo Boutique est arretee.
timeout /t 3 >nul

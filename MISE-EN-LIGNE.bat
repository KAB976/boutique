@echo off
cd /d "%~dp0"
title Mise en ligne de Boutique
node scripts\mettre-en-ligne.mjs
echo.
pause

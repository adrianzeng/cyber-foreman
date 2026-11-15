@echo off
chcp 65001 >nul
title Agent Hub
cd /d "%~dp0"
node "%~dp0tools\launch.mjs"
pause

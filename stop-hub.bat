@echo off
chcp 65001 >nul
title 停止 CyberForeman (赛博包工头)
cd /d "%~dp0"
node "%~dp0tools\stop.mjs"
timeout /t 2 /nobreak >nul

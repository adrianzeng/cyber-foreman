@echo off
chcp 65001 >nul
title CyberForeman (赛博包工头)
cd /d "%~dp0"
node "%~dp0tools\launch.mjs"
if errorlevel 1 (
  echo.
  echo 启动遇到问题，请查看上方提示。
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul

@echo off
rem Windows launcher for the headless multi-user server.
rem Double-click this file, or run it from a terminal.
rem Install/build/start logic lives in scripts\launch-server.mjs.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node scripts\launch-server.mjs %*
if errorlevel 1 (
  echo.
  pause
)
endlocal

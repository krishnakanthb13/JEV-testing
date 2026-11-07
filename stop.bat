@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  pause
  exit /b 1
)

echo Stopping Jev Test Console...
node stop.js

if /I not "%~1"=="quiet" pause
endlocal

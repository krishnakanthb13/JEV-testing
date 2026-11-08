@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PROXY_PORT=8787"
set "APP_PORT=8080"

if /I "%~1"=="stop" (
  call "%~dp0stop.bat" quiet
  exit /b %errorlevel%
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required. Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Jev Test Console...

rem Start the CORS proxy only when its health check does not answer.
node -e "fetch('http://127.0.0.1:%PROXY_PORT%/health').then(r=>r.ok?r.json():Promise.reject()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if errorlevel 1 (
  echo   proxy: starting on port %PROXY_PORT%
  start "Jev proxy :%PROXY_PORT%" /min node proxy.js
) else (
  echo   proxy: already running on port %PROXY_PORT%
)

rem Start the static server only when the app is not already being served.
node -e "fetch('http://127.0.0.1:%APP_PORT%/index.html').then(r=>r.ok?r.text():Promise.reject()).then(t=>process.exit(t.includes('Jev Test Console')?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if errorlevel 1 (
  echo   app: starting on port %APP_PORT%
  start "Jev app :%APP_PORT%" /min node serve.js
) else (
  echo   app: already running on port %APP_PORT%
)

rem Wait for the app to answer before opening the browser.
set "TRIES=0"
:waitapp
node -e "fetch('http://127.0.0.1:%APP_PORT%/index.html').then(r=>r.ok?r.text():Promise.reject()).then(t=>process.exit(t.includes('Jev Test Console')?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 goto openapp
set /a TRIES+=1
if %TRIES% GEQ 10 goto openapp
timeout /t 1 /nobreak >nul
goto waitapp

:openapp
start "" "http://localhost:%APP_PORT%"
echo.
echo Opened http://localhost:%APP_PORT%
echo Close everything again with "stop.bat" or "start.bat stop".
endlocal

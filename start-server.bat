@echo off
cd /d "%~dp0"
title Claude Terminal Server
if "%PORT%"=="" set "PORT=3900"

echo Checking port %PORT%...
set "PORT_BUSY="
for /f "tokens=5" %%a in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "PORT_BUSY=1"
  echo Stopping process on port %PORT%: PID %%a
  taskkill /F /PID %%a >nul 2>&1
)
if not defined PORT_BUSY echo Port %PORT% is free.

node server.js
pause

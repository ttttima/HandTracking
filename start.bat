@echo off
REM Double-click to launch the HandGestures desktop app (installs dependencies on first run).
REM For the browser-only version run:  npm start
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
call npm run desktop:start

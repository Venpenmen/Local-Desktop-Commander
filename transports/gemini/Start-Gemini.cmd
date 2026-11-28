@echo off
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node.js before running this developer build.
  pause
  exit /b 1
)
node console.mjs
set "result=%errorlevel%"
popd
if not "%result%"=="0" pause
exit /b %result%

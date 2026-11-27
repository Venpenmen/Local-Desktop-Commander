@echo off
setlocal DisableDelayedExpansion
node "%~dp0..\tests\m7-isolation.mjs" %*
set "LDC_EXIT=%ERRORLEVEL%"
pause >nul
exit /b %LDC_EXIT%
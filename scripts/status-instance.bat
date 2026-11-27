@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\management\LDC.ps1" -Action Status
set "LDC_EXIT=%ERRORLEVEL%"
pause >nul
exit /b %LDC_EXIT%
@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0management\LDC.ps1" -Action Menu
set "LDC_EXIT=%ERRORLEVEL%"
popd
exit /b %LDC_EXIT%

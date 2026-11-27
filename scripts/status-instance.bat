@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\management\LDC.ps1" -Action Status
exit /b %errorlevel%
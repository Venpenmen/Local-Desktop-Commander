@echo off
setlocal
set "LDC_ROOT=%~dp0.."
set "LDC_BIN=%LDC_ROOT%\dist\LocalDC-GUI-win-x64\LocalDC.Gui.exe"
if not exist "%LDC_BIN%" (
  echo [Local DC GUI] Release executable not found.
  echo Build package: powershell -File scripts\publish-gui.ps1
  exit /b 1
)
if not exist "%LDC_ROOT%\management\LDC-CLI.ps1" (
  echo [Local DC GUI] Management CLI not found.
  exit /b 1
)
start "" "%LDC_BIN%" --root "%LDC_ROOT%"
exit /b %ERRORLEVEL%

@echo off
setlocal
node "%~dp0..\tests\m7-isolation.mjs" %*
exit /b %errorlevel%
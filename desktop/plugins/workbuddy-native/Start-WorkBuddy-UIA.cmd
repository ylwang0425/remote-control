@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-WorkBuddy.ps1" -Mode uia %*
exit /b %errorlevel%

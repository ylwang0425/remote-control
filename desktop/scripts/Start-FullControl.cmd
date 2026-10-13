@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-FullControl.ps1" %*
exit /b %errorlevel%

@echo off
rem Starts the payroll app. Keep this window open while the app is in use.
cd /d "%~dp0"
echo Starting payroll app on port 3000...
"C:\Program Files\nodejs\node.exe" server\index.js
pause

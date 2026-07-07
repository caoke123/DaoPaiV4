@echo off
setlocal

set "OPENCODE_CONFIG_DIR=%USERPROFILE%\.config\opencode-v4"

cd /d "%~dp0"

echo PROJECT=%CD%
echo CONFIG=%OPENCODE_CONFIG_DIR%
echo PORT=12449
echo.

if not exist "%APPDATA%\npm\opencode.cmd" (
  echo ERROR: opencode.cmd not found
  pause
  exit /b 1
)

call "%APPDATA%\npm\opencode.cmd" --port 12449 --hostname 127.0.0.1 .

pause
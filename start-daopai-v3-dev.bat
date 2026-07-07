@echo off
setlocal

set "ROOT_DIR=%~dp0"

echo Starting DaoPai V3 development services...
echo ROOT_DIR=%ROOT_DIR%
echo.

start "DaoPai V3 Backend" cmd /k "cd /d %ROOT_DIR% && npm run dev"
start "DaoPai V3 Frontend" cmd /k "cd /d %ROOT_DIR%frontend && npm run dev"
start "DaoPai V3 Agent" cmd /k "cd /d %ROOT_DIR%packages\agent && npm run dev"

echo.
echo Started backend, frontend, and agent in separate windows.
echo Backend:  http://localhost:3300
echo Frontend: http://localhost:5176
echo Agent:    packages/agent
echo.
echo IMPORTANT: Agent must stay running, otherwise business tasks will remain pending.
echo.

pause

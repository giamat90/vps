@echo off
rem Activates the sidecar venv (..\.venv) and cd's into pitch_lab.
rem Double-click: opens a prompt that stays open with the venv active.
rem From an open cmd prompt: `call activate_venv.bat` activates it in that shell.
call "%~dp0..\.venv\Scripts\activate.bat"
cd /d "%~dp0"
echo %cmdcmdline% | find /i "%~0" >nul
if not errorlevel 1 cmd /k

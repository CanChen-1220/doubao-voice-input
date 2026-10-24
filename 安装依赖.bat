@echo off
chcp 65001 >nul
echo === Doubao voice input - setup ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found. Install it first: https://nodejs.org
  echo        (choose the LTS version, tick "Add to PATH").
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Python not found. Install it first: https://www.python.org
  echo        (tick "Add python.exe to PATH" during install).
  pause
  exit /b 1
)

echo Installing Python packages (sounddevice, keyboard, pyperclip)...
python -m pip install --upgrade sounddevice keyboard pyperclip
if errorlevel 1 (
  echo [FAIL] Package install failed. Check your network and retry.
  pause
  exit /b 1
)

echo.
echo Setup complete. Next steps:
echo   1. Edit credentials.json and fill in appKey + accessKey
echo   2. Double-click 启动语音输入.vbs
echo   3. (optional) Run 安装自启.bat to launch on login
echo.
pause

@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*voice_hotkey.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Voice input stopped.
ping -n 3 127.0.0.1 >nul

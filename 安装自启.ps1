$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyExe = (Get-Command python).Source
$pyw = Join-Path (Split-Path $pyExe) 'pythonw.exe'
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'VoiceInput.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = $pyw
$shortcut.Arguments = '"' + (Join-Path $here 'voice_hotkey.py') + '"'
$shortcut.WorkingDirectory = $here
$shortcut.WindowStyle = 0
$shortcut.Description = 'Global push-to-talk dictation (F9)'
$shortcut.Save()
Write-Host "Autostart installed: $link"

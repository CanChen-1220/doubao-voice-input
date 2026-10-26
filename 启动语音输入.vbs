' Start the global dictation tool with no console window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "voice_hotkey.py")
command = "pythonw.exe """ & script & """"
shell.Run command, 0, False

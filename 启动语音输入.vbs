' Start the global dictation tool with no console window.
Set shell = CreateObject("WScript.Shell")
pythonw = "C:\Users\chenc\AppData\Local\Programs\Python\Python312\pythonw.exe"
script = "C:\Users\chenc\.dsh\tools\voice-hotkey\voice_hotkey.py"
command = """" & pythonw & """ """ & script & """"
shell.Run command, 0, False

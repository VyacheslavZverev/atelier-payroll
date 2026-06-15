' Starts the payroll app server hidden (no console window).
' A copy of this file in shell:startup launches it at every Windows login.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "F:\invoices"
sh.Run """C:\Program Files\nodejs\node.exe"" server\index.js", 0, False

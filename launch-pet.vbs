Option Explicit

Dim shell, fso, projectDir, exePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(projectDir, "src-tauri\target\release\claude-pet-companion.exe")

If Not fso.FileExists(exePath) Then
  MsgBox "Build first with: npm run tauri:build" & vbCrLf & exePath, vbExclamation, "Claude Pet Companion"
  WScript.Quit 1
End If

shell.Run Chr(34) & exePath & Chr(34), 0, False

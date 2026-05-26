Option Explicit

Dim shell, fso, projectDir, exePath, stableExePath, userProfile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
userProfile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
stableExePath = fso.BuildPath(userProfile, ".claude\pet-companion\bin\claude-pet-companion.exe")
exePath = fso.BuildPath(projectDir, "src-tauri\target\release\claude-pet-companion.exe")

If fso.FileExists(stableExePath) Then
  exePath = stableExePath
ElseIf Not fso.FileExists(exePath) Then
  MsgBox "Build first with: npm run tauri:build" & vbCrLf & exePath, vbExclamation, "Claude Pet Companion"
  WScript.Quit 1
End If

shell.Run Chr(34) & exePath & Chr(34) & " --launch --state waving --event manual-vbs --ttl-ms 3000", 1, False

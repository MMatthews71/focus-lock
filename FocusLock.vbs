' ============================================================================
'  FocusLock - silent launcher (Windows)
'
'  Double-click this file to start FocusLock with NO terminal / console
'  windows. On the very first run it launches setup.bat (visible, so you can
'  watch the one-time install + build); after that it goes straight to opening
'  the app silently.
'
'  Electron itself is a GUI program, so launching it directly - instead of
'  through npm / node in a console - means no black terminal windows appear.
'  The background service that the app starts is also spawned hidden.
' ============================================================================

Option Explicit

Dim fso, sh, scriptDir, electronRoot, electronExe, appDir, pathTxt, rel

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir    = fso.GetParentFolderName(WScript.ScriptFullName)
appDir       = scriptDir & "\apps\desktop"
electronRoot = scriptDir & "\node_modules\electron"

' --- Run one-time setup if dependencies or the UI build are missing ----------
If (Not fso.FolderExists(scriptDir & "\node_modules")) _
   Or (Not fso.FileExists(appDir & "\dist\index.html")) _
   Or (Not fso.FolderExists(electronRoot)) Then
    sh.CurrentDirectory = scriptDir
    ' Visible (1) and wait for it to finish (True).
    sh.Run "cmd /c """ & scriptDir & "\setup.bat""", 1, True
End If

' --- Locate the Electron executable ------------------------------------------
electronExe = ""
pathTxt = electronRoot & "\path.txt"
If fso.FileExists(pathTxt) Then
    rel = Trim(fso.OpenTextFile(pathTxt, 1).ReadAll())
    If Len(rel) > 0 Then electronExe = electronRoot & "\" & rel
End If
If (electronExe = "") Or (Not fso.FileExists(electronExe)) Then
    If fso.FileExists(electronRoot & "\dist\electron.exe") Then
        electronExe = electronRoot & "\dist\electron.exe"
    End If
End If

If (electronExe = "") Or (Not fso.FileExists(electronExe)) Then
    MsgBox "FocusLock could not find Electron. Please run setup.bat once first.", _
           vbExclamation, "FocusLock"
    WScript.Quit 1
End If

' --- Launch the app. electron.exe is a GUI app, so no console window appears.
' Style 1 = show the app window normally; False = don't block this script.
sh.CurrentDirectory = scriptDir
sh.Run """" & electronExe & """ """ & appDir & """", 1, False

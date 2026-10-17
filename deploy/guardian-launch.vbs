' FocusLock guardian launcher.
'
' Run by the elevated "FocusLock Guardian" scheduled task. Starts the supervisor
' hidden (no console window). Because the task runs with HIGHEST privileges, the
' node process started here - and the service it in turn spawns - run elevated.
'
' Everything is resolved relative to this script's own folder (the install root),
' so there are no hard-coded user paths.
Option Explicit

Dim fso, sh, root, sup, node

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sup  = root & "\supervisor.cjs"
If Not fso.FileExists(sup) Then WScript.Quit 0

' Locate node.exe: prefer the standard install, fall back to PATH.
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then
    node = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe"
End If
If Not fso.FileExists(node) Then node = "node"

sh.CurrentDirectory = root
' Style 0 = hidden, False = do not wait.
sh.Run """" & node & """ """ & sup & """", 0, False

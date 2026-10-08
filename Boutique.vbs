' Lance Boutique en arriere-plan (sans fenetre noire) et ouvre la page.
' Argument "silencieux" : ne pas ouvrir le navigateur (utilise au demarrage de Windows).
Option Explicit
Dim sh, fso, dir, quiet, i, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
quiet = (WScript.Arguments.Count > 0)

Function ServerUp()
  Dim h
  ServerUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1000, 1000, 1000, 1000
  h.open "GET", "http://localhost:3000/api/public", False
  h.send
  If Err.Number = 0 Then
    If h.status = 200 Then ServerUp = True
  End If
  On Error GoTo 0
End Function

If Not fso.FolderExists(dir & "\node_modules") Then
  MsgBox "Boutique n'est pas encore installee." & vbCrLf & "Double-cliquez d'abord sur 1-INSTALLER.bat", vbExclamation, "Boutique"
  WScript.Quit 1
End If

If Not ServerUp() Then
  If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder dir & "\data"
  sh.Run "cmd /c node --disable-warning=ExperimentalWarning server\index.js >> data\serveur.log 2>&1", 0, False
  ok = False
  For i = 1 To 30
    WScript.Sleep 500
    If ServerUp() Then
      ok = True
      Exit For
    End If
  Next
  If Not ok Then
    MsgBox "Boutique n'a pas pu demarrer." & vbCrLf & "Details dans le fichier data\serveur.log", vbCritical, "Boutique"
    WScript.Quit 1
  End If
End If

If Not quiet Then sh.Run "http://localhost:3000"

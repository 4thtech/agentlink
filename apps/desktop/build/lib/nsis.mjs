// NSIS script for the per-user installer (no admin, no HKLM). Generated text; `makensis` compiles it
// on the windows-2022 CI runner.
//  - installs under $LOCALAPPDATA\Programs\AgentLink;
//  - registers agentlink:// under HKCU with the URL after an argument separator: "<exe>" -- "%1" (H1);
//  - the uninstaller removes only the install directory and its own registry keys. It never touches
//    the user's AgentLink data folder (the shared home of the CLI and the app).

/** N7: the AppUserModelID the app sets at startup (apps/desktop/src/main/notify.ts). */
export const APP_USER_MODEL_ID = '4thTech.AgentLink';

const q = (s) => String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

export function nsisScript({ version, sourceDir, outFile, iconFile }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Bad version: ${version}`);
  const exe = 'AgentLink.exe';
  const uninstKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\4thTech.AgentLink';
  return `Unicode true
!include "MUI2.nsh"

Name "AgentLink"
OutFile "${q(outFile)}"
InstallDir "$LOCALAPPDATA\\Programs\\AgentLink"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "4thTech AgentLink ${version}"

!define MUI_ABORTWARNING
; WIN-INSTALLER-SHORTCUT: the finish page offers "Create a desktop shortcut" (ticked by default). The
; checkbox reuses the MUI run-checkbox slot with its own function; nothing is started from it.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_RUN_FUNCTION CreateDesktopShortcut
${iconFile ? `!define MUI_ICON "${q(iconFile)}"\n!define MUI_UNICON "${q(iconFile)}"\n` : ''}!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${q(sourceDir)}\\*.*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; agentlink:// (per user). Main reads only the one argument after "--".
  WriteRegStr HKCU "Software\\Classes\\agentlink" "" "URL:AgentLink"
  WriteRegStr HKCU "Software\\Classes\\agentlink" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\agentlink\\DefaultIcon" "" "$INSTDIR\\${exe},0"
  WriteRegStr HKCU "Software\\Classes\\agentlink\\shell\\open\\command" "" "$\\"$INSTDIR\\${exe}$\\" -- $\\"%1$\\""

  ; Apps & features entry (per user)
  WriteRegStr HKCU "${uninstKey}" "DisplayName" "AgentLink"
  WriteRegStr HKCU "${uninstKey}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${uninstKey}" "Publisher" "4thTech"
  WriteRegStr HKCU "${uninstKey}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${uninstKey}" "UninstallString" "$\\"$INSTDIR\\Uninstall.exe$\\""
  WriteRegDWORD HKCU "${uninstKey}" "NoModify" 1
  WriteRegDWORD HKCU "${uninstKey}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\\AgentLink"
  CreateShortCut "$SMPROGRAMS\\AgentLink\\AgentLink.lnk" "$INSTDIR\\${exe}" "" "$INSTDIR\\${exe}" 0 SW_SHOWNORMAL "" "AgentLink"
  ; N7 (IR-N7-1 M-1): Windows attributes toasts through the Start menu shortcut that carries the
  ; same AppUserModelID the app sets at startup (setAppUserModelId).
  StrCpy $0 "$SMPROGRAMS\\AgentLink\\AgentLink.lnk"
  Call SetShortcutAumid
SectionEnd

; N7: sets System.AppUserModel.ID (PKEY {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3},5) on the shortcut in
; $0 to ${APP_USER_MODEL_ID}, with the stock System plugin only (IShellLinkW, IPersistFile,
; IPropertyStore). Best effort: a failing step leaves the shortcut as it was.
Function SetShortcutAumid
  System::Call 'ole32::CoCreateInstance(g "{00021401-0000-0000-C000-000000000046}", p 0, i 1, g "{000214F9-0000-0000-C000-000000000046}", *p .r2) i .r9'
  StrCmp $9 0 0 aumid_done
  System::Call '$2->0(g "{0000010b-0000-0000-C000-000000000046}", *p .r3) i .r9'
  StrCmp $9 0 0 aumid_link
  System::Call '$3->5(w r0, i 2) i .r9'
  StrCmp $9 0 0 aumid_file
  System::Call '$2->0(g "{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}", *p .r4) i .r9'
  StrCmp $9 0 0 aumid_file
  System::Call '*(g "{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}", i 5) p .r5'
  System::Call '*(&w64 "${APP_USER_MODEL_ID}") p .r7'
  System::Call '*(&i2 31, &i2 0, &i2 0, &i2 0, p r7, p 0) p .r6'
  System::Call '$4->6(p r5, p r6) i .r9'
  StrCmp $9 0 0 aumid_store
  System::Call '$4->7() i .r9'
  StrCmp $9 0 0 aumid_store
  System::Call '$3->6(p 0, i 1) i .r9'
aumid_store:
  System::Call '$4->2()'
  System::Free $5
  System::Free $6
  System::Free $7
aumid_file:
  System::Call '$3->2()'
aumid_link:
  System::Call '$2->2()'
aumid_done:
FunctionEnd

; WIN-INSTALLER-SHORTCUT: runs when the finish page is closed with the box ticked. Per-user desktop
; ($DESKTOP is the user's own folder under a user-level install); same icon and AppUserModelID as the
; Start menu entry. Silent installs (/S) skip the finish page, so they create no desktop shortcut.
Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\\AgentLink.lnk" "$INSTDIR\\${exe}" "" "$INSTDIR\\${exe}" 0 SW_SHOWNORMAL "" "AgentLink"
  StrCpy $0 "$DESKTOP\\AgentLink.lnk"
  Call SetShortcutAumid
FunctionEnd

; WIN-DESK-2 (R-WIN §6 item 11): AgentLink's files are in use while it runs, so install and uninstall
; first check that it is not running. A running .exe cannot be opened for writing; FileOpen in append
; mode only opens it (nothing is written, nothing is closed by force). Retry checks again; a silent
; run (/S) stops with an error instead of waiting.
!macro CHECK_NOT_RUNNING UN
Function \${UN}CheckNotRunning
  check_again:
  ClearErrors
  IfFileExists "$INSTDIR\\${exe}" 0 +4
    FileOpen $R0 "$INSTDIR\\${exe}" a
    IfErrors is_running
    FileClose $R0
  ClearErrors
  IfFileExists "$INSTDIR\\resources\\node\\node.exe" 0 +4
    FileOpen $R0 "$INSTDIR\\resources\\node\\node.exe" a
    IfErrors is_running
    FileClose $R0
  Return
  is_running:
  IfSilent 0 +3
    SetErrorLevel 2
    Quit
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AgentLink is running.$\\r$\\n$\\r$\\nQuit AgentLink first: right-click its icon near the clock and choose Quit AgentLink. Then choose Retry." IDRETRY check_again
  Quit
FunctionEnd
!macroend
!insertmacro CHECK_NOT_RUNNING ""
!insertmacro CHECK_NOT_RUNNING "un."

Function .onInit
  Call CheckNotRunning
FunctionEnd

Function un.onInit
  Call un.CheckNotRunning
FunctionEnd

Section "Uninstall"
  DeleteRegKey HKCU "Software\\Classes\\agentlink"
  DeleteRegKey HKCU "${uninstKey}"
  Delete "$SMPROGRAMS\\AgentLink\\AgentLink.lnk"
  Delete "$DESKTOP\\AgentLink.lnk"
  RMDir "$SMPROGRAMS\\AgentLink"
  ; Recursive delete only of the exact per-user install dir, and only when it really is an AgentLink
  ; install (a /D= override or a stray Uninstall.exe elsewhere must never delete a user directory).
  StrCmp "$INSTDIR" "$LOCALAPPDATA\\Programs\\AgentLink" +2 0
    Abort "Refusing to remove an unexpected folder."
  IfFileExists "$INSTDIR\\${exe}" +2 0
    Abort "AgentLink.exe is not in this folder; nothing was removed."
  IfFileExists "$INSTDIR\\Uninstall.exe" +2 0
    Abort "This is not an AgentLink install folder; nothing was removed."
  RMDir /r "$INSTDIR"
SectionEnd
`;
}

// NSIS script for the per-user installer (no admin, no HKLM). Generated text; `makensis` compiles it
// on the windows-2022 CI runner.
//  - installs under $LOCALAPPDATA\Programs\AgentLink;
//  - registers agentlink:// under HKCU with the URL after an argument separator: "<exe>" -- "%1" (H1);
//  - the uninstaller removes only the install directory and its own registry keys. It never touches
//    the user's AgentLink data folder (the shared home of the CLI and the app).

const q = (s) => String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

export function nsisScript({ version, sourceDir, outFile }) {
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
!insertmacro MUI_PAGE_INSTFILES
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
  ; AppUserModelID 4thTech.AgentLink is set by the app at startup (setAppUserModelId).
SectionEnd

Section "Uninstall"
  DeleteRegKey HKCU "Software\\Classes\\agentlink"
  DeleteRegKey HKCU "${uninstKey}"
  Delete "$SMPROGRAMS\\AgentLink\\AgentLink.lnk"
  RMDir "$SMPROGRAMS\\AgentLink"
  RMDir /r "$INSTDIR"
SectionEnd
`;
}

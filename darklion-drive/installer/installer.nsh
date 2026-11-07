; installer.nsh - Custom NSIS script for DarkLion Drive

!macro customInstall
  ; ── Check/Install WinFsp ────────────────────────────────────────────────────
  ; Check multiple registry locations WinFsp may use
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WinFsp" "InstallDir"
  ${If} ${Errors}
    ClearErrors
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\WinFsp" "InstallDir"
  ${EndIf}
  ${If} ${Errors}
    ClearErrors
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp" "DisplayName"
  ${EndIf}
  ${If} ${Errors}
    ClearErrors
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp" "DisplayName"
  ${EndIf}

  ${If} $0 == ""
    ; WinFsp not found — download and install silently
    DetailPrint "Installing WinFsp (required for DarkLion Drive)..."
    NSISdl::download "https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi" "$TEMP\winfsp.msi"
    Pop $0
    ${If} $0 == "success"
      ExecWait '"msiexec" /i "$TEMP\winfsp.msi" /quiet /norestart' $0
      DetailPrint "WinFsp installed (code: $0)"
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Could not download WinFsp automatically. Please install it manually from https://winfsp.dev/rel/ before using DarkLion Drive."
    ${EndIf}
  ${Else}
    DetailPrint "WinFsp already installed — skipping."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Leave WinFsp installed — other apps may depend on it
!macroend

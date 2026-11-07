; nsis-extra.nsh — Custom install/uninstall steps injected into electron-builder's NSIS installer
; Runs printer-setup.ps1 on install and printer-remove.ps1 on uninstall.

!macro customInstall
  ; ── Download and install Ghostscript if not present ────────────────────────
  DetailPrint "Checking for Ghostscript..."
  IfFileExists "C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe" gs_found gs_missing

  gs_missing:
    DetailPrint "Ghostscript not found — downloading..."
    inetc::get \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10031/gs10031w64.exe" \
      "$TEMP\gs10031w64.exe" \
      /END
    Pop $0
    StrCmp $0 "OK" gs_download_ok gs_download_fail

    gs_download_fail:
      MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to download Ghostscript. Please install it manually from ghostscript.com and re-run this installer."
      Abort

    gs_download_ok:
      DetailPrint "Installing Ghostscript..."
      ExecWait '"$TEMP\gs10031w64.exe" /S' $0
      StrCmp $0 "0" gs_found gs_install_fail

    gs_install_fail:
      MessageBox MB_OK|MB_ICONEXCLAMATION "Ghostscript installation failed. Please install it manually from ghostscript.com."
      Abort

  gs_found:
    DetailPrint "Ghostscript is installed."

  ; ── Install DarkLion Printer ────────────────────────────────────────────────
  DetailPrint "Installing DarkLion Printer..."
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "$INSTDIR\resources\installer\printer-setup.ps1" -RedmonDll "$INSTDIR\resources\installer\redmon64.dll"'
  Pop $0
  StrCmp $0 "0" printer_ok printer_warn

  printer_warn:
    DetailPrint "Printer setup returned code $0 — may need to re-run as Administrator."

  printer_ok:
    DetailPrint "DarkLion Printer installed."

  ; ── Auto-start for current user ─────────────────────────────────────────────
  WriteRegStr HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "DarkLionPrintAgent" '"$INSTDIR\DarkLion Print Agent.exe"'

!macroend

!macro customUninstall
  ; ── Remove printer ───────────────────────────────────────────────────────────
  DetailPrint "Removing DarkLion Printer..."
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "$INSTDIR\resources\installer\printer-remove.ps1"'

  ; ── Remove auto-start entry ──────────────────────────────────────────────────
  DeleteRegValue HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "DarkLionPrintAgent"

!macroend

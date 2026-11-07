; DarkLion Print Agent - Inno Setup Installer
; Requires Inno Setup 6.x
; Build: iscc setup.iss

#define MyAppName "DarkLion Print Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "DarkLion AI"
#define MyAppURL "https://darklion.ai"
#define MyAppExeName "DarkLionPrintAgent.exe"

; Path to the built Electron app (electron-builder output)
#define ElectronAppDir "..\dist\win-unpacked"
; Path to the Node.js service files
#define ServiceDir "..\service"
; Path to the shared config
#define SharedDir "..\shared"

[Setup]
AppId={{A7C3D8E1-4F2B-4A9C-8E3D-1B2C3D4E5F6A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\DarkLion\PrintAgent
DefaultGroupName=DarkLion
AllowNoIcons=yes
; No code signing yet — users will see SmartScreen warning on first run
; Add SignTool directive here when a cert is obtained
OutputDir=..\output
OutputBaseFilename=DarkLionPrintAgent_Setup_v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Require admin for printer installation
PrivilegesRequired=admin
; 64-bit only (Server 2022 is always x64)
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startupentry"; Description: "Start DarkLion Print Agent automatically when you log in"; GroupDescription: "Additional tasks:"; Flags: checked

[Files]
; Electron app (built with electron-builder)
Source: "{#ElectronAppDir}\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

; Node.js service files
Source: "{#ServiceDir}\index.js";          DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#ServiceDir}\watcher.js";        DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#ServiceDir}\ipc.js";            DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#ServiceDir}\service-install.js"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#ServiceDir}\service-uninstall.js"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#ServiceDir}\package.json";      DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#SharedDir}\config.js";          DestDir: "{app}\shared"; Flags: ignoreversion

; Redmon port monitor DLL (bundled)
Source: "redmon64.dll"; DestDir: "{app}\installer"; Flags: ignoreversion

; PowerShell setup scripts
Source: "printer-setup.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "printer-remove.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion

; Node.js runtime (bundled — downloaded separately, see README)
; Alternatively: download during install (see [Code] section below)

[Icons]
; No Start Menu shortcut needed (tray app)
Name: "{group}\{#MyAppName}"; Filename: "{app}\app\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Registry]
; Auto-start for the CURRENT user (per-user, so each RDS user gets it)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "DarkLionPrintAgent"; \
  ValueData: """{app}\app\{#MyAppExeName}"""; \
  Flags: uninsdeletevalue; \
  Tasks: startupentry

[Run]
; 1. Install Node.js service dependencies
Filename: "{cmd}"; Parameters: "/c cd ""{app}\service"" && npm install --production"; \
  Flags: runhidden waitprocfinished; StatusMsg: "Installing service dependencies..."

; 2. Run printer setup PowerShell script (requires admin — we already have it)
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NonInteractive -File ""{app}\installer\printer-setup.ps1"" -RedmonDll ""{app}\installer\redmon64.dll"""; \
  Flags: runhidden waitprocfinished; StatusMsg: "Installing DarkLion Printer..."

; 3. Install and start the Windows service
Filename: "{cmd}"; \
  Parameters: "/c cd ""{app}\service"" && node service-install.js"; \
  Flags: runhidden waitprocfinished; StatusMsg: "Installing print monitoring service..."

; 4. Launch Electron app for the current user
Filename: "{app}\app\{#MyAppExeName}"; \
  Flags: nowait postinstall skipifsilent; Description: "Launch DarkLion Print Agent"

[UninstallRun]
; 1. Uninstall the Windows service
Filename: "{cmd}"; Parameters: "/c cd ""{app}\service"" && node service-uninstall.js"; \
  Flags: runhidden waitprocfinished

; 2. Run printer removal script
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NonInteractive -File ""{app}\installer\printer-remove.ps1"""; \
  Flags: runhidden waitprocfinished

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// Download Ghostscript during installation if not already present
const
  GsVersion = '10.03.1';
  GsInstaller = 'gs10031w64.exe';
  GsDownloadUrl = 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10031/gs10031w64.exe';
  GsDefaultPath = 'C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe';

function GhostscriptInstalled: Boolean;
begin
  Result := FileExists(GsDefaultPath);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  TempFile: String;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    if not GhostscriptInstalled then
    begin
      if MsgBox('Ghostscript is required to convert print jobs to searchable PDFs.' + #13#10 +
                'It will be downloaded (~50MB) and installed automatically.' + #13#10#13#10 +
                'Click OK to download Ghostscript now.',
                mbInformation, MB_OKCANCEL) = IDOK then
      begin
        TempFile := ExpandConstant('{tmp}\') + GsInstaller;

        // Download Ghostscript
        if not idpDownloadFile(GsDownloadUrl, TempFile) then
        begin
          MsgBox('Failed to download Ghostscript. Please install it manually from https://www.ghostscript.com/releases/gsdnld.html' + #13#10 +
                 'Then re-run this installer.',
                 mbError, MB_OK);
          Abort;
        end;

        // Run the Ghostscript installer silently
        if not Exec(TempFile, '/S', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
        begin
          MsgBox('Ghostscript installation failed (error ' + IntToStr(ResultCode) + ').' + #13#10 +
                 'Please install Ghostscript manually and re-run this installer.',
                 mbError, MB_OK);
          Abort;
        end;
      end
      else
      begin
        MsgBox('Installation cancelled. Ghostscript is required.',
               mbError, MB_OK);
        Abort;
      end;
    end;
  end;
end;

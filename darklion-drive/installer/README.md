# installer/

This directory holds installer customizations for DarkLion Drive.

## Files

- `installer.nsh` - NSIS script fragment injected by electron-builder. Handles
  silent WinFsp installation during setup.

## winfsp.msi (REQUIRED before building)

The WinFsp MSI must be placed here before running `npm run build:win`.

Download from:
https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi

The final path must be: `darklion-drive/installer/winfsp.msi`

electron-builder picks it up via `extraResources` in package.json and bundles
it into the installer. The `installer.nsh` script then runs msiexec to install
it silently during DarkLion Drive setup.

## Build flow

1. Place `vendor/rclone.exe` (Windows x64 from https://rclone.org/downloads/)
2. Place `installer/winfsp.msi` (from URL above)
3. Run `npm run build:win` on Windows (or cross-compile with Wine on Mac/Linux)
4. Output: `dist/DarkLionDrive_Setup_1.0.0.exe`

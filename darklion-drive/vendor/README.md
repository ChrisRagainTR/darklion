# vendor/

This directory holds third-party binaries bundled with DarkLion Drive.

## rclone.exe (REQUIRED before building)

`rclone.exe` must be placed in this directory before running `npm run build:win`
or `npm start` in development.

### How to get it

1. Go to https://rclone.org/downloads/
2. Download **Windows x64** zip (e.g. `rclone-current-windows-amd64.zip`)
3. Extract the zip
4. Copy `rclone.exe` from the extracted folder into this `vendor/` directory

The final path must be: `darklion-drive/vendor/rclone.exe`

### Why rclone?

rclone mounts our local WebDAV server (running on 127.0.0.1:7891) as drive letter
L: using WinFsp. This is more reliable than the old net use / WebDAV client approach
and does not require the WebClient Windows service.

### WinFsp (also required)

rclone --network-mode mounting requires WinFsp to be installed on the system.

For development/testing: download and install from https://winfsp.dev/rel/

For production installs: the installer (DarkLionDrive_Setup.exe) bundles and
silently installs WinFsp automatically. Place `winfsp.msi` in the `installer/`
directory before building.

Download WinFsp MSI from:
https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi

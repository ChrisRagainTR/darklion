# DarkLion Print Agent

A Windows application that installs a **"DarkLion Printer"** virtual printer. When staff prints any document from any application (Drake, Word, Excel, etc.), a small popup appears letting them route the PDF directly to the correct client's document folder in DarkLion.

## How It Works

```
App prints → PostScript → Redmon port monitor → Ghostscript → PDF in spool folder
                                                                      ↓
                                              Chokidar detects new PDF
                                                                      ↓
                                        Named pipe → Electron routing popup
                                                                      ↓
                                              Staff picks: Client / Year / Folder
                                                                      ↓
                                           POST /api/documents/upload → DarkLion
```

Output is a **fully searchable PDF** — Ghostscript preserves the vector text from PostScript.

## Architecture

| Component | What it does |
|---|---|
| `installer/printer-setup.ps1` | Registers Redmon port monitor + creates "DarkLion Printer" |
| `service/` | Node.js Windows service (runs as SYSTEM) — watches spool folder |
| `app/` | Electron app (runs per-user) — tray icon + routing popup |
| `installer/setup.iss` | Inno Setup script — builds the single `.exe` installer |
| `shared/config.js` | Shared paths and constants |

## Prerequisites

- **Windows Server 2019/2022** or Windows 10/11 (x64)
- **Inno Setup 6.x** — to build the installer
- **Node.js 18+** — for development
- **Ghostscript 10.x** — downloaded automatically by the installer
- **Redmon 2.x** — `redmon64.dll` must be placed in `installer/` before building

### Getting Redmon
Download from: https://www.undocprint.org/formats/winspool/redmon
- File needed: `redmon64.dll` (for x64 Windows)
- Place at: `installer/redmon64.dll`

## Development

```bash
# Install Electron app dependencies
cd app && npm install

# Install service dependencies  
cd service && npm install

# Run Electron app (development)
cd app && npm start
```

## Building the Installer

```bash
# 1. Build the Electron app
cd app && npm run build
# Output: dist/win-unpacked/

# 2. Compile the Inno Setup installer
# Open installer/setup.iss in Inno Setup IDE and click Build
# Or from command line:
iscc installer/setup.iss
# Output: output/DarkLionPrintAgent_Setup_v1.0.0.exe
```

## RDS Server Installation

1. Copy the installer `.exe` to the RDS server
2. Run as Administrator — SmartScreen warning is expected (no code signing yet)
3. The installer will:
   - Download and install Ghostscript (~50MB, one-time)
   - Install Redmon port monitor
   - Create the "DarkLion Printer" (visible to ALL users on the server)
   - Install the Node.js background service
   - Register the Electron app to start at each user's login
4. Each user will see the DarkLion Printer in their printer list automatically

## User Flow

1. Open any document → File → Print → Select **DarkLion Printer**
2. Routing popup appears immediately
3. Pick: **Client** (type to search) + **Year** + **Folder** (Tax/Other) + **Section**
4. Click **Upload to DarkLion**
5. Toast: ✅ Document uploaded

## API

Uses existing DarkLion endpoints — no server changes required:
- `POST /firms/login` — authentication
- `GET /api/search?q=` — client search
- `POST /api/documents/upload` — upload document

## Code Signing

The installer works without a code signing certificate but will trigger Windows SmartScreen
on first run. Users can click "More info" → "Run anyway".

To add signing:
1. Obtain an EV Code Signing certificate
2. Add `SignTool=...` directive to `setup.iss`
3. SmartScreen warning will disappear once reputation is established

## Troubleshooting

**Printer not showing in list:**
- Run `printer-setup.ps1` as Administrator manually
- Check Event Viewer → Windows Logs → System for Print Spooler errors

**PDF not appearing after print:**
- Check `C:\ProgramData\DarkLion\Spool\` for files
- Check `C:\ProgramData\DarkLion\Logs\redmon.log` for Redmon errors
- Make sure Ghostscript is installed at `C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe`

**Routing popup not appearing:**
- Check that DarkLion Print Agent is running in the system tray
- Check Task Manager for `DarkLionPrintAgent.exe`
- The service (SYSTEM) communicates via named pipe — verify service is running

**Upload failing:**
- Check internet connectivity from the server
- Sign out and sign in again (JWT is valid 24h)
- Check DarkLion server logs at https://darklion.ai

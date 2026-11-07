# DarkLion Drive

A Windows desktop app that mounts your DarkLion documents as a real Windows drive letter (**L:**).

## Architecture

```
Electron app
  ├── Local WebDAV server (http://127.0.0.1:7890)
  │     └── Proxies to DarkLion API at https://darklion.ai
  └── net use L: \\127.0.0.1@7890\DavWWWRoot
```

**Key insight:** Windows allows HTTP (not HTTPS) basic auth to localhost without any registry changes. This avoids ALL the WebDAV-over-HTTPS setup problems.

## Drive Structure

```
L:\
  {Relationship Name}\
    {Person or Company Name}\
      {Year}\
        {folder_category}\
          {display_name}.pdf
```

## Development (Windows)

### Prerequisites
- Node.js 18+ 
- npm
- Windows 10/11

### Setup

```bash
# Clone the repo
git clone https://github.com/ChrisRagainTR/darklion.git
cd darklion-ai/darklion-drive

# Install Electron and build tools
npm install

# Install app dependencies
cd app
npm install
cd ..

# Run in development mode
npm start
```

### Build Installer

```bash
# From darklion-drive/ directory
npm run build:win
# Output: dist/DarkLionDrive_Setup_1.0.0.exe
```

## Files

| File | Purpose |
|------|---------|
| `app/main.js` | Electron main: tray, login window, drive mount/unmount |
| `app/auth.js` | Token storage in userData/auth.json |
| `app/api.js` | DarkLion API client |
| `app/webdav-server.js` | Local WebDAV server (Express) |
| `app/drive.js` | `net use` mount/unmount helpers |
| `app/preload.js` | Secure IPC bridge for renderer |
| `app/renderer/login.html` | Login UI (dark themed) |
| `app/renderer/login.js` | Login form logic |

## How It Works

1. App starts → checks for stored JWT token
2. If no token → shows login window
3. Login → calls `POST https://darklion.ai/firms/login` → gets JWT
4. Saves JWT to `%APPDATA%\DarkLion Drive\auth.json`
5. Starts local WebDAV server on `http://127.0.0.1:7890`
6. Runs `net use L: \\127.0.0.1@7890\DavWWWRoot` to mount as drive L:
7. WebDAV server serves the DarkLion document tree (cached 30s)
8. Tray icon shows connection status
9. On quit: unmounts drive, stops WebDAV server

## Token Expiry

If the API returns 401, the app:
1. Clears stored token
2. Unmounts the drive
3. Shows the login window again

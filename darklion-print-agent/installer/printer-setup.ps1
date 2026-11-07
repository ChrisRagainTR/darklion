# DarkLion Printer Setup — TCP/IP port approach (no Redmon DLL needed)
# Creates "DarkLion Printer" that sends PostScript to localhost:9100
# The Electron app listens on port 9100 and converts PS → PDF via Ghostscript.
# Run as Administrator.

$PrinterName = "DarkLion Printer"
$PortName    = "DarkLion_9100"
$SpoolDir    = "$env:PROGRAMDATA\DarkLion\Spool"

# ── 1. Create spool directory ─────────────────────────────────────────────────
Write-Host "Creating spool directory..."
New-Item -ItemType Directory -Force -Path $SpoolDir | Out-Null
$acl = Get-Acl $SpoolDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "Everyone","FullControl","ContainerInherit,ObjectInherit","None","Allow")
$acl.SetAccessRule($rule)
Set-Acl $SpoolDir $acl

# ── 2. Create TCP/IP port pointing to localhost:9100 ─────────────────────────
Write-Host "Creating TCP/IP port $PortName (localhost:9100)..."
$existing = Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue
if (-not $existing) {
    Add-PrinterPort -Name $PortName -PrinterHostAddress "127.0.0.1" -PortNumber 9100
    Write-Host "Port created."
} else {
    Write-Host "Port already exists."
}

# ── 3. Find a PostScript printer driver ──────────────────────────────────────
Write-Host "Looking for PostScript driver..."
$preferred = @(
    "HP Color LaserJet 2800 Series PS",
    "HP Universal Printing PS",
    "HP LaserJet 4 Plus/4M Plus PS",
    "Lexmark Universal v2 PS3",
    "MS Publisher Color Printer",
    "MS Publisher Imagesetter"
)
$installed = Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
$driver = $null
foreach ($d in $preferred) {
    if ($installed -contains $d) { $driver = $d; break }
}

if (-not $driver) {
    # Install PS driver from Windows driver store
    Write-Host "Installing PostScript driver from driver store..."
    $inf = Get-ChildItem "$env:SystemRoot\System32\DriverStore\FileRepository" `
        -Recurse -Filter "*.inf" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "pscript|ps5ui|ps[c5]" } |
        Select-Object -First 1
    if ($inf) {
        pnputil.exe /add-driver $inf.FullName /install 2>$null | Out-Null
        $installed = Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
        foreach ($d in $preferred) {
            if ($installed -contains $d) { $driver = $d; break }
        }
    }
}

if (-not $driver) {
    # Last resort: add the PS driver manually
    try {
        Add-PrinterDriver -Name "MS Publisher Color Printer" -ErrorAction SilentlyContinue
        $driver = "MS Publisher Color Printer"
    } catch {}
}

if (-not $driver) {
    Write-Error "No PostScript printer driver found. Install any HP PS driver and re-run."
    exit 1
}

Write-Host "Using driver: $driver"

# ── 4. Create the printer ─────────────────────────────────────────────────────
Write-Host "Creating printer '$PrinterName'..."
$existing = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($existing) {
    Remove-Printer -Name $PrinterName -ErrorAction SilentlyContinue
}
Add-Printer -Name $PrinterName -DriverName $driver -PortName $PortName
Set-Printer -Name $PrinterName -Comment "DarkLion Document Management" -Location "DarkLion"

Write-Host ""
Write-Host "DarkLion Printer installed successfully!"
Write-Host "  Printer : $PrinterName"
Write-Host "  Driver  : $driver"
Write-Host "  Port    : $PortName (localhost:9100)"
Write-Host "  Spool   : $SpoolDir"
Write-Host ""
Write-Host "Note: The DarkLion Print Agent must be running to receive print jobs."

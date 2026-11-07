# DarkLion Printer Removal
# Run as Administrator — called by the Inno Setup uninstaller

$PrinterName = "DarkLion Printer"
$PortName    = "DarkLionPort:"

Write-Host "Removing DarkLion Printer..."

# Remove printer
Remove-Printer -Name $PrinterName -ErrorAction SilentlyContinue
Write-Host "Printer removed."

# Remove port
Remove-PrinterPort -Name $PortName -ErrorAction SilentlyContinue
Write-Host "Port removed."

# Remove Redmon port registry entries
$portKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Redmon\Ports\$PortName"
Remove-Item -Path $portKey -Force -ErrorAction SilentlyContinue

# Remove Redmon monitor (only if no other ports exist)
$remainingPorts = Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Redmon\Ports" -ErrorAction SilentlyContinue
if (-not $remainingPorts) {
    Remove-Item -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Redmon" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "$env:SystemRoot\System32\redmon64.dll" -Force -ErrorAction SilentlyContinue
    Write-Host "Redmon monitor removed."
}

# Restart spooler
Restart-Service -Name Spooler -Force -ErrorAction SilentlyContinue

Write-Host "DarkLion Printer uninstalled."

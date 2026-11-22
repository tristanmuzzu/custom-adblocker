# Custom Adblocker installer for Windows.
# Downloads the latest extension files into a permanent folder and opens the
# browser's extensions page. Run it again later to update.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   (or) irm https://raw.githubusercontent.com/tristanmuzzu/custom-adblocker/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoZip = 'https://github.com/tristanmuzzu/custom-adblocker/archive/refs/heads/main.zip'
$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $HOME }
$target = Join-Path $base 'CustomAdblocker'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cab-" + [guid]::NewGuid())

New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'main.zip'
    Write-Host "Downloading $repoZip"
    Invoke-WebRequest -Uri $repoZip -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem -Path $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
    if (-not $src) { throw 'manifest.json not found in the download.' }

    # Replace the extension files in place. The folder path stays the same, so
    # an already loaded extension only needs a Reload click to pick up updates.
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($item in 'manifest.json', 'LICENSE', 'icons', 'src') {
        $dest = Join-Path $target $item
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Copy-Item -Recurse -Path (Join-Path $src.FullName $item) -Destination $dest
    }
    $version = (Get-Content (Join-Path $target 'manifest.json') -Raw | ConvertFrom-Json).version
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Custom Adblocker $version is in: $target"
try { Set-Clipboard -Value $target; Write-Host '(Folder path copied to the clipboard.)' } catch {}

# Open the extensions page in whichever Chromium browser is installed.
$browsers = @(
    @{ Name = 'chrome'; Page = 'chrome://extensions' },
    @{ Name = 'msedge'; Page = 'edge://extensions' },
    @{ Name = 'brave';  Page = 'brave://extensions' }
)
foreach ($b in $browsers) {
    if (Get-Command $b.Name -ErrorAction SilentlyContinue) { Start-Process $b.Name $b.Page; break }
    $appPath = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.Name).exe" -ErrorAction SilentlyContinue
    if ($appPath) { Start-Process $appPath.'(default)' $b.Page; break }
}

Write-Host @"

Finish in the browser (one time only):
  1. Turn on 'Developer mode' (top right of the extensions page).
  2. Click 'Load unpacked' and choose: $target
  3. Pin 'Custom Adblocker' from the puzzle-piece menu.

To update later: run this script again, then click the reload arrow on the
Custom Adblocker card and refresh open tabs.
"@

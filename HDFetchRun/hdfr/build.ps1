# build.ps1 - Windows equivalent of build.sh.
#
# Produces the same artifact: a static linux/armv7 `hdfrd` staged into
# ..\phase0\dist, ready to serve to the box. Go cross-compiles identically from
# Windows; only the shell conveniences differ (cp -> Copy-Item, md5sum ->
# Get-FileHash). Nothing here runs on the box - boot\*.sh stay POSIX.
#
# Untested on Windows (written on Linux, no PowerShell available to verify).

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here "..\phase0\dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$ver = "0.6.0-phase6-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd")

# Static, no cgo: the box has 2014-era glibc, do not link against it.
$env:CGO_ENABLED = "0"
$env:GOOS        = "linux"
$env:GOARCH      = "arm"
$env:GOARM       = "7"

Push-Location $here
try {
    go build -trimpath -ldflags "-s -w -X main.version=$ver" -o (Join-Path $out "hdfrd") .
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }

    Copy-Item -Force -Path @(
        "assets\index.html", "assets\app.js", "assets\ui.css",
        "assets\config.json", "assets\ca-bundle.pem",
        "boot\nxserver", "boot\install.sh", "boot\uninstall.sh"
    ) -Destination $out

    Write-Host "staged in ${out}:"
    Get-ChildItem $out | Format-Table Name, Length, LastWriteTime -AutoSize
    Get-FileHash -Path (Get-ChildItem -Path $out -File).FullName -Algorithm MD5 |
        Format-Table Hash, @{ n = "File"; e = { Split-Path $_.Path -Leaf } } -AutoSize
}
finally {
    Pop-Location
}

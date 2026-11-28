#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$dotnet = Join-Path $env:LOCALAPPDATA 'LocalDC-GUI-SDK\dotnet.exe'
if (!(Test-Path -LiteralPath $dotnet -PathType Leaf)) {
    $dotnet = (Get-Command dotnet -ErrorAction Stop).Source
}
$destination = Join-Path $project 'dist\LocalDC-GUI-win-x64'
$exe = Join-Path $destination 'LocalDC.Gui.exe'
& $dotnet publish (Join-Path $project 'gui\LocalDC.Gui.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o $destination
if ($LASTEXITCODE -ne 0) { throw 'GUI publish failed' }
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Missing GUI executable' }
$manifest = [ordered]@{
    component = 'LocalDC management GUI'
    branch = 'feature/management-gui'
    mode = 'win-x64/self-contained'
    requires = 'management/LDC-CLI.ps1 in parent worktree'
    executable = 'LocalDC.Gui.exe'
    rootArgument = '--root'
}
[IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath (Join-Path $project 'docs\gui-usage.md') -Destination (Join-Path $destination 'README.md') -Force
if (Test-Path -LiteralPath (Join-Path $project 'LICENSE') -PathType Leaf) {
    Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination (Join-Path $destination 'LICENSE') -Force
}
$zip = Join-Path $project 'dist\LocalDC-GUI-win-x64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $destination '*') -DestinationPath $zip -CompressionLevel Optimal
if (!(Test-Path -LiteralPath $zip -PathType Leaf)) { throw 'Missing GUI ZIP package' }
Write-Output ("GUI package: " + $exe)
Write-Output ("GUI ZIP: " + $zip)
Write-Output ("SHA256 EXE: " + (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash)
Write-Output ("SHA256 ZIP: " + (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)

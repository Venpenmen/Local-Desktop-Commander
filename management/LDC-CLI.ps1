#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'LDC-Core.ps1')
. (Join-Path $PSScriptRoot 'LDC-Protocol.ps1')
try {
    Initialize-LdcRegistry
    $line = [Console]::ReadLine()
    $request = if ($line -and $line.Length -le 32768) { $line | ConvertFrom-Json }
} catch {
    $request = $null
    $reply = @{protocol=1; id=$null; ok=$false; error=@{code='INITIALIZATION_OR_PARSE_FAILED';message='Check the request JSON and version registry.'}}
}
if (!$reply) { $reply = Invoke-LdcRequest $request 3>$null 4>$null 5>$null 6>$null }
[Console]::WriteLine(($reply | ConvertTo-Json -Depth 16 -Compress))
if ($reply.ok) { exit 0 }
exit 1

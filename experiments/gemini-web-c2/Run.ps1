param(
    [ValidateSet('Start','Status','Stop')][string]$Action='Status',
    [ValidatePattern('^[a-f0-9]{32}$')][string]$Id,
    [switch]$Public,
    [ValidateRange(30,7200)][int]$Seconds=3600
)
$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot 'probe.mjs'
$node=(Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$runtime=Join-Path $PSScriptRoot 'runtime'
if($Action -eq 'Start'){
    if(!$Id){$Id=[guid]::NewGuid().ToString('N')}
    $run=Join-Path $runtime $Id
    if(Test-Path -LiteralPath $run){throw 'Run ID already exists.'}
    $null=New-Item -ItemType Directory -Path $run -Force
    $mode=if($Public){'public'}else{'local'}
    $child=Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $scriptPath),$Id,$mode,$Seconds) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $run 'startup.log')
    $child.Dispose()
}
if(!$Id){throw 'Specify the experiment ID.'}
$status=Join-Path (Join-Path $runtime $Id) 'status.json'
if($Action -eq 'Start'){
    for($i=0;$i -lt 60 -and !(Test-Path -LiteralPath $status);$i++){Start-Sleep -Milliseconds 250}
}
$record=Get-Content -LiteralPath $status -Raw | ConvertFrom-Json
if($record.id -cne $Id){throw 'Run identity mismatch.'}
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)"
$owned=$process -and $process.ExecutablePath -eq $node -and
    $process.CommandLine -match ('"' + [regex]::Escape($scriptPath) + '"\s+' + $Id + '\s') -and
    ([datetime]$process.CreationDate).ToUniversalTime() -le (Get-Item -LiteralPath $status).LastWriteTimeUtc
if($Action -eq 'Stop' -and !$record.stoppedUtc){
    if(!$owned){throw 'Cannot confirm the original probe process.'}
    $handle=Get-Process -Id $process.ProcessId
    try {
        $null=$handle.Handle
        if($handle.HasExited -or $handle.StartTime.ToUniversalTime() -ne ([datetime]$process.CreationDate).ToUniversalTime()){
            # CIM time can be rounded to microseconds.
            if($handle.HasExited -or [math]::Abs(($handle.StartTime.ToUniversalTime()-([datetime]$process.CreationDate).ToUniversalTime()).Ticks) -gt 10){throw 'Process identity changed.'}
        }
        & "$env:SystemRoot\System32\taskkill.exe" /PID $handle.Id /T /F | Out-Null
        if($LASTEXITCODE -or !$handle.WaitForExit(5000)){throw 'Probe stop failed.'}
        $record | Add-Member -NotePropertyName stoppedUtc -NotePropertyValue ([datetime]::UtcNow.ToString('o')) -Force
        $record | ConvertTo-Json | Set-Content -LiteralPath $status -Encoding UTF8
        $owned=$false
    }finally{$handle.Dispose()}
}
$record | Add-Member -NotePropertyName running -NotePropertyValue ([bool]$owned) -Force
$record | ConvertTo-Json

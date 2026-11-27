param(
    [ValidateSet('Start','Status','Stop','AddClient')][string]$Action='Status',
    [ValidatePattern('^[a-f0-9]{32}$')][string]$Id,
    [switch]$Public,
    [switch]$OAuth,
    [string]$RedirectUri,
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
    $mode=if($OAuth){'oauth'}elseif($Public){'public'}else{'local'}
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
if($Action -eq 'AddClient'){
    if(!$owned -or $record.kind -ne 'oauth' -or !$record.publicUrl){throw 'An active OAuth experiment is required.'}
    if($RedirectUri -cnotmatch '^https://oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com/[ra]/[A-Za-z0-9._~-]+$'){
        throw 'Expected the exact official Google HTTPS callback.'
    }
    $dir=Split-Path -Parent $status
    $store=Join-Path $dir 'manual-client.json'
    $temp=Join-Path $dir ([guid]::NewGuid().ToString('N')+'.tmp')
    foreach($path in $runtime,$dir,$store){
        $item=Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Credential storage cannot use a reparse point.'}
    }
    $client=[ordered]@{
        client_id='ldc-'+[guid]::NewGuid().ToString('N')
        client_secret=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')
        redirect_uris=@($RedirectUri)
        token_endpoint_auth_method='client_secret_post'
    }
    try {
        $null=New-Item -ItemType File -Path $temp
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl=New-Object Security.AccessControl.FileSecurity
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true,$false)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
        Set-Acl -LiteralPath $temp -AclObject $acl
        [IO.File]::WriteAllText($temp,($client|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
        if([IO.File]::Exists($store)){[IO.File]::Replace($temp,$store,$temp+'.old')}
        else{[IO.File]::Move($temp,$store)}
    }finally{
        [IO.File]::Delete($temp)
        [IO.File]::Delete($temp+'.old')
    }
    [pscustomobject]@{credentialFile=$store;redirectUri=$RedirectUri} | ConvertTo-Json
    return
}
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

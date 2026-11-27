# Local management API v1. Uses the same lock and state as the console.
function Get-LdcConfiguration {
    $selection = Get-LdcSelection
    $roots = [ordered]@{}
    foreach ($version in ($script:Versions.Values | Sort-Object Id)) {
        $roots[$version.Id] = Get-LdcConfiguredRoot $version
    }
    $openai = $null
    if ($script:Instance.transport -eq 'openai') { $openai = Get-LdcOpenAiSettings }
    $config = [ordered]@{schema=1; instance=$script:Instance.key; target=$selection.target; rollback=$selection.rollback; roots=$roots; proxy=$openai.proxy}
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $revision = [BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes(($config | ConvertTo-Json -Compress -Depth 8)))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $config.revision = $revision
    $config
}

function Get-LdcSnapshot {
    $actual = Get-LdcObservation -IncludeHealth
    $pending = Read-LdcJson $script:PendingPath
    $state = if ($actual.State -eq 'stopped' -and (Test-LdcPending $pending)) {'starting'} else {$actual.State}
    $expected = $null
    switch ($actual.Mode) { files { $expected = $actual.Version.FilesTools }; terminal { $expected = $actual.Version.TerminalTools } }
    [ordered]@{
        instance=@{id=$script:Instance.id; key=$script:Instance.key; transport=$script:Instance.transport}
        observedUtc=[datetime]::UtcNow.ToString('o')
        actual=@{state=$state; version=$actual.Version.Id; mode=$actual.Mode; pid=$actual.Pid; birth=$actual.Birth}
        configuration=Get-LdcConfiguration
        readiness=@{local=$actual.Health.Ready -eq 200; expectedTools=$expected; remoteInvocation='unverified'}
        transports=@(Get-LdcTransportDescriptors $actual.Health)
        task=Get-LdcRecentTask
    }
}

function Get-LdcRecentTask {
    $task = Read-LdcJson $script:TaskPath
    if ($task.state -eq 'running') {
        $owner = Get-LdcProcess $task.owner
        if (!$owner -or (Get-LdcBirth $owner) -ne $task.birth) { $task.state = 'interrupted' }
    }
    $task
}

function Get-LdcEvents {
    Assert-LdcPlainPath $script:ActivityPath
    if (Test-Path -LiteralPath $script:ActivityPath -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $script:ActivityPath -Tail 40 -Encoding UTF8)) {
            if ($line -match '^(\S+) ([a-z-]+) version=([a-z0-9-]*) mode=([a-z]*) pid=(\d+) code=(-?\d+)$') {
                [ordered]@{utc=$Matches[1];kind=$Matches[2];version=$Matches[3];mode=$Matches[4];pid=[int]$Matches[5];code=[int]$Matches[6]}
            }
        }
    }
}

function Invoke-LdcMutation {
    param([string]$Operation,$Arguments,[switch]$Interactive)
    if (!$Interactive -and $Arguments.confirmed -isnot [bool]) { throw 'CONFIRMATION_REQUIRED' }
    if (!$Interactive -and !$Arguments.confirmed) { throw 'CONFIRMATION_REQUIRED' }
    Invoke-LdcLocked {
        $selection = Get-LdcSelection
        if ($Operation -in 'select','root.set','network.set') {
            if ((!$Interactive -or $Arguments.revision) -and $Arguments.revision -cne (Get-LdcConfiguration).revision) { throw 'REVISION_CONFLICT' }
        }
        $owner = Get-LdcProcess $PID
        $task = [ordered]@{id=[guid]::NewGuid().ToString('N'); operation=$Operation; state='running'; owner=$PID; birth=Get-LdcBirth $owner; startedUtc=[datetime]::UtcNow.ToString('o')}
        $script:LdcRequestTaskId = $task.id
        Write-LdcJson $script:TaskPath $task
        $script:LdcConfirmed = !$Interactive
        $task.state = 'failed'
        try {
            $code = 0
            switch ($Operation) {
                start { $code = Start-LdcTarget $selection.target }
                stop {
                    $current = Get-LdcObservation
                    if (!$Interactive -or $Arguments.confirmed -eq $true -or $current.State -ne 'running' -or (Confirm-LdcAction "停止 PID $($current.Pid) 及其子进程")) {
                        $code = Stop-LdcInstance $current
                    } else { $task.state = 'cancelled' }
                }
                restart { $code = Invoke-LdcChange $null 'restart' }
                rollback { $code = Invoke-LdcChange $selection.rollback 'rollback' }
                select {
                    if (!$Arguments.version -or !$script:Versions.ContainsKey([string]$Arguments.version) -or $Arguments.mode -notin 'files','terminal') {
                        throw 'INVALID_ARGUMENT'
                    }
                    $code = Invoke-LdcChange ([pscustomobject]@{version=[string]$Arguments.version; mode=[string]$Arguments.mode}) 'select'
                }
                'root.set' {
                    if (!$Arguments.version -or !$script:Versions.ContainsKey([string]$Arguments.version) -or $Arguments.path -isnot [string] -or !$Arguments.path) {
                        throw 'INVALID_ARGUMENT'
                    }
                    if (!(Set-LdcRoot $script:Versions[$Arguments.version] $Arguments.path)) { $task.state = 'cancelled' }
                }
                'network.set' { Set-LdcOpenAiProxy $Arguments.proxy }
                'credential.configure' { & $script:LdcOpenAiHelper -Action Configure }
                'credential.forget' { & $script:LdcOpenAiHelper -Action Forget }
            }
            if ($code -ne 0) { throw 'OPERATION_FAILED' }
            if ($script:LdcCancelled) { $task.state = 'cancelled' }
            if ($task.state -ne 'cancelled') { $task.state = 'completed' }
        } finally {
            $script:LdcConfirmed = $false
            $script:LdcCancelled = $false
            $task.finishedUtc = [datetime]::UtcNow.ToString('o')
            Write-LdcJson $script:TaskPath $task
        }
        $task
    }
}

function Invoke-LdcRequest {
    param($Request,[switch]$Interactive)
    $id = if ($Request.id -is [string] -and $Request.id -cmatch '^[a-zA-Z0-9-]{1,64}$') { $Request.id }
    $operation = [string]$Request.operation
    $script:LdcRequestTaskId = $null
    $reply = [ordered]@{protocol=1; id=$id; ok=$false}
    try {
        if ($null -eq $id -or $operation -cnotmatch '^[a-z.]+$') { throw 'INVALID_REQUEST' }
        if ($Request.protocol -cne 1) { throw 'UNSUPPORTED_PROTOCOL' }
        if ($Request.instance -and $Request.instance -cne $script:Instance.key) { throw 'INSTANCE_MISMATCH' }
        if ($script:Instance.transport -eq 'local-dev' -and $operation -in 'network.set','network.prompt','credential.configure','credential.forget','diagnose') {
            throw 'UNSUPPORTED_ON_INSTANCE'
        }
        $reply.instance = $script:Instance.key
        $reply.result = switch ($operation) {
            capabilities { $operations=@('capabilities','state','config.get','versions','events','logs','task.get','extensions','diagnose','start','stop','restart','rollback','select','root.set','network.set')
                if ($script:Instance.transport -eq 'local-dev') { $operations = @($operations | Where-Object { $_ -notin 'diagnose','network.set' }) }
                @{protocol=1; operations=$operations; transports=@(Get-LdcTransportDescriptors $null)}
            }
            state { Get-LdcSnapshot }
            'config.get' { Get-LdcConfiguration }
            versions { ,@($script:Versions.Values | Sort-Object Id | Select-Object Id,Label,Status,FilesTools,TerminalTools) }
            events { ,@(Get-LdcEvents) }
            logs { Get-LdcLogs }
            'task.get' {
                $task = Get-LdcRecentTask
                if ($Request.arguments.id -and $Request.arguments.id -ne $task.id) { throw 'TASK_NOT_FOUND' }
                $task
            }
            extensions { ,@(Get-LdcExtensions) }
            diagnose { Get-LdcOpenAiDiagnosis }
            { $_ -in 'start','stop','restart','rollback','select','root.set','network.set' } { Invoke-LdcMutation $operation $Request.arguments -Interactive:$Interactive }
            { $_ -in 'credential.configure','credential.forget','network.prompt' } {
                if (!$Interactive) { throw 'INTERACTIVE_REQUIRED' }
                if ($_ -eq 'network.prompt') { Invoke-LdcLocked { & $script:LdcOpenAiHelper -Action Network } }
                else { Invoke-LdcMutation $operation $Request.arguments -Interactive }
            }
            default { throw 'UNKNOWN_OPERATION' }
        }
        $reply.ok = $true
    } catch {
        $code = $_.Exception.Message
        if ($code -cnotmatch '^(INSTANCE_MISMATCH|UNSUPPORTED_ON_INSTANCE|INVALID_REQUEST|INVALID_MANIFEST|INVALID_ARGUMENT|UNSUPPORTED_PROTOCOL|UNKNOWN_OPERATION|CONFIRMATION_REQUIRED|REVISION_CONFLICT|BUSY|INTERACTIVE_REQUIRED|TASK_NOT_FOUND|OPERATION_FAILED)$') { $code = 'OPERATION_FAILED' }
        $reply.error = @{code=$code; message=$script:LdcErrors[$code]}
        if ($script:LdcRequestTaskId) { $reply.error.taskId = $script:LdcRequestTaskId }
        if ($Interactive) { Write-Host $_.Exception.Message }
        if ($code -eq 'OPERATION_FAILED' -and $script:Versions) {
            try {
                $reply.error.logPath = $script:Versions[(Get-LdcSelection).target.version].LogFile
            } catch {}
        }
    }
    $reply
}

$script:LdcErrors = @{
    INSTANCE_MISMATCH='The request was addressed to a different instance.'
    UNSUPPORTED_ON_INSTANCE='This instance uses a loopback transport without hosted credentials or proxy settings.'
    INVALID_REQUEST='A valid request ID and operation are required.'
    INVALID_MANIFEST='An extension manifest is incompatible or invalid.'
    INVALID_ARGUMENT='The operation arguments are invalid.'
    UNSUPPORTED_PROTOCOL='This protocol version is unsupported.'
    UNKNOWN_OPERATION='The operation is not registered.'
    CONFIRMATION_REQUIRED='Explicit confirmation is required.'
    REVISION_CONFLICT='Configuration changed. Read the latest revision before retrying.'
    BUSY='Another management client owns the operation lock.'
    INTERACTIVE_REQUIRED='Use the interactive console for this operation.'
    TASK_NOT_FOUND='The requested task is no longer the latest task.'
    OPERATION_FAILED='The operation failed. Check status and the redacted logs.'
}

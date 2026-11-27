function Get-LdcLocalDevDescriptor($Health) {
    @{
        id='local-dev'; name='Local MCP development proxy'; contract=1; version='0.0.21'
        type='loopback'; engineProtocol='mcp-stdio'; health=$Health
        connection='local-only'; credentials=@{type='none';configured=$false}
        configuration=@{durationSeconds=@{type='integer';minimum=30;maximum=28800}}
        capabilities=@('start','stop','health','logs','events')
    }
}

function Get-LdcLocalDevDuration($Version) {
    $config = Read-LdcJson $Version.Profile
    if ($config.durationSeconds -isnot [int] -or $config.durationSeconds -lt 30 -or $config.durationSeconds -gt 28800) {
        throw '本地代理运行时长须为 30 到 28800 秒。'
    }
    return [string]$config.durationSeconds + 's'
}

function Get-LdcDevLaunchMutexName {
    "Local\LDC-dev-launch-$($script:Instance.key)"
}

function Invoke-LdcLocalDevLaunch($Version,[string]$RunMode) {
    $mutex = New-Object Threading.Mutex($false, (Get-LdcDevLaunchMutexName))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked -or @(Get-LdcTunnelProcesses).Count) { throw '本地测试实例已运行或启动中。' }
        Start-LdcLocalDevProxy $Version $RunMode
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Start-LdcLocalDevProxy($Version,[string]$RunMode) {
    $runtime = Split-Path -Parent $Version.PidFile
    foreach ($path in $Version.PidFile,$Version.HealthFile,$Version.EndpointFile,$Version.LogFile,$script:Instance.temporary) {
        Assert-LdcPlainPath $path
    }
    $null = [IO.Directory]::CreateDirectory($runtime)
    $null = [IO.Directory]::CreateDirectory($script:Instance.temporary)
    $duration = Get-LdcLocalDevDuration $Version
    foreach ($path in $Version.PidFile,$Version.HealthFile,$Version.EndpointFile) { [IO.File]::Delete($path) }
    # Only this isolated launch worker mutates its process environment.
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    $env:LOCAL_DC_TUNNEL_TERMINAL = if ($RunMode -eq 'terminal') { '1' } else { '0' }
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    $args = @('dev','proxy','--listen','127.0.0.1:0','--health-listen-addr','127.0.0.1:0',
        '--mcp-command','"node engine/stdio.mjs --tunnel"','--duration',$duration,
        '--url-file',('"{0}"' -f $Version.EndpointFile),'--health-url-file',('"{0}"' -f $Version.HealthFile))
    $child = Start-Process -FilePath $script:Tunnel -ArgumentList $args -WorkingDirectory $script:Project -WindowStyle Hidden -PassThru -RedirectStandardError $Version.LogFile
    try {
        $null = $child.Handle
        Write-LdcText $Version.PidFile ([string]$child.Id)
        $child.WaitForExit()
        $global:LASTEXITCODE = $child.ExitCode
    } finally {
        # The handle belongs to the child this worker created, including on partial startup.
        if (!$child.HasExited) {
            & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $child.Id /T /F | Out-Null
        }
        $child.Dispose()
    }
}

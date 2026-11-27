#Requires -Version 5.1
param(
    [ValidateSet('Start', 'Status', 'Stop', 'Local')]
    [string]$Action = 'Status',
    [switch]$Terminal
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $project 'transports\openai\bin\tunnel-client.exe'
$profile = Join-Path $PSScriptRoot 'profile.local.yaml'
$entry = Join-Path $PSScriptRoot 'stdio.mjs'
$runtime = Join-Path $PSScriptRoot 'runtime'
$health = Join-Path $runtime 'health.url'
$pidFile = Join-Path $runtime 'tunnel.pid'

function Get-ProjectTunnel {
    param([string]$SelectedProfile)
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
        Where-Object {
            $_.ExecutablePath -eq $exe -and $_.CommandLine -match '(?:^|\s)run(?:\s|$)' -and
            (!$SelectedProfile -or $_.CommandLine -match ('--profile-file\s+"?' + [regex]::Escape($SelectedProfile) + '(?:"|\s|$)'))
        }
}

function Get-HealthUrl {
    param([string]$UrlFile)
    if (!(Test-Path -LiteralPath $UrlFile -PathType Leaf)) { return }
    $value = (Get-Content -LiteralPath $UrlFile -Raw).Trim()
    if ($value -match '^http://127\.0\.0\.1:\d{1,5}/?$') { $value.TrimEnd('/') }
}

function Show-Health {
    param([string]$UrlFile, [switch]$Quiet)
    $url = Get-HealthUrl $UrlFile
    if (!$url) {
        if (!$Quiet) { Write-Host '[等待] 本机健康检查地址尚未生成。' }
        return $false
    }
    $ready = $true
    foreach ($endpoint in 'healthz', 'readyz', 'health/mcp') {
        try {
            $reply = Invoke-WebRequest -Uri "$url/$endpoint" -UseBasicParsing -TimeoutSec 2
            if ($endpoint -eq 'health/mcp') {
                $mcp = $reply.Content | ConvertFrom-Json
                $catalog = $mcp.details.tools_list
                Write-Host "[MCP] HTTP $($reply.StatusCode) $($mcp.status) $($mcp.state) tools=$($catalog.retained_count) complete=$($catalog.complete)"
            } else {
                Write-Host "[$endpoint] HTTP $($reply.StatusCode) $($reply.Content.Trim())"
            }
        } catch {
            $ready = $false
            if (!$Quiet) { Write-Host "[等待] $endpoint 尚未就绪。" }
        }
    }
    return $ready
}

function Stop-OwnedTunnel {
    param([System.Diagnostics.Process]$Owned, [switch]$LaunchedHere)
    # Holding an open process handle prevents Windows from recycling this PID.
    $null = $Owned.Handle
    if ($Owned.HasExited) { return 0 }
    $current = @(Get-ProjectTunnel $profile | Where-Object ProcessId -eq $Owned.Id)
    if ($current.Count -ne 1 -or $Owned.HasExited) { throw '无法确认 P6 隧道进程身份。' }
    if (!$LaunchedHere -and (!(Test-Path -LiteralPath $pidFile) -or
        (Get-Content -LiteralPath $pidFile -Raw).Trim() -ne [string]$Owned.Id)) {
        throw 'P6 PID 文件与运行中的进程不匹配。'
    }
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $Owned.Id /T /F | Out-Host
    return $LASTEXITCODE
}

if ($Action -eq 'Local') {
    $localArgs = @($entry)
    if ($Terminal) { $localArgs += '--terminal' }
    & node @localArgs
    exit $LASTEXITCODE
}

if ($Action -eq 'Status') {
    $running = @(Get-ProjectTunnel $profile)
    if (!$running.Count) {
        Write-Host '[已停止] P6 候选隧道。'
        exit 0
    }
    if ($running.Count -ne 1) { throw '检测到多个 P6 进程，无法唯一识别。' }
    Write-Host "[运行中] P6 候选版 PID $($running[0].ProcessId)."
    $null = Show-Health $health
    exit 0
}

if ($Action -eq 'Stop') {
    $running = @(Get-ProjectTunnel $profile)
    if (!$running.Count) { Write-Host '[已停止] P6 候选隧道。'; exit 0 }
    if ($running.Count -ne 1) { throw '检测到多个 P6 进程，无法唯一识别。' }
    $owned = Get-Process -Id $running[0].ProcessId
    try { exit (Stop-OwnedTunnel $owned) } finally { $owned.Dispose() }
}

$mode = if ($Terminal) { '完整终端模式（21 个工具）' } else { '文件模式（14 个工具）' }
Write-Host "[STARTING] Local DC P6 · $mode"
$lock = New-Object System.Threading.Mutex($false, 'Local\LocalDC-v020-tunnel')
$locked = $false
$loadedKey = $false
$oldTerminal = $env:LOCAL_DC_TUNNEL_TERMINAL
$child = $null
try {
    try { $locked = $lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked -or @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" | Where-Object { $_.CommandLine -match '(?:^|\s)run(?:\s|$)' -or !$_.CommandLine }).Count) {
        Write-Host '[BLOCKED] 已有 Local DC 隧道运行，请在准备切换时先从原控制台退出。'
        exit 1
    }
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'upstream\dist\index.js'))) { throw '缺少 P6 MCP 构建产物。' }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $allowedRoot = & $node $entry --check-root
    if ($LASTEXITCODE -ne 0 -or !$allowedRoot) { throw '检查 allowed-root.txt 和目录权限。' }
    Write-Host "[授权目录] $allowedRoot"
    $null = New-Item -ItemType Directory -Path $runtime -Force
    foreach ($staleFile in $health, $pidFile) {
        if (Test-Path -LiteralPath $staleFile -PathType Leaf) { Remove-Item -LiteralPath $staleFile }
    }
    if (!$env:CONTROL_PLANE_API_KEY) {
        Write-Host '[KEY] 使用现有 OpenAI 隧道密钥，输入内容会隐藏。'
        $secret = Read-Host 'OpenAI 隧道运行密钥' -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try {
            $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
            $loadedKey = $true
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
            $secret.Dispose()
        }
    }
    if (!$env:CONTROL_PLANE_API_KEY) { throw '启动需要现有隧道运行密钥。' }
    $env:LOCAL_DC_TUNNEL_TERMINAL = if ($Terminal) { '1' } else { '0' }
    if ($Terminal) { Write-Host '[AUTHORIZED] 终端命令使用当前 Windows 用户权限。' }
    $log = Join-Path $runtime 'tunnel.log'
    $tunnelArgs = @('run', '--profile-file', ('"{0}"' -f $profile), '--health.url-file', ('"{0}"' -f $health),
        '--pid.file', ('"{0}"' -f $pidFile), '--log.file', ('"{0}"' -f $log), '--mcp.stdio-send-initialized-notification')
    $child = Start-Process -FilePath $exe -ArgumentList $tunnelArgs -WorkingDirectory $project -WindowStyle Hidden -PassThru
    $null = $child.Handle
    if ($loadedKey) {
        Remove-Item Env:CONTROL_PLANE_API_KEY
        $loadedKey = $false
    }
    Write-Host "[INITIALIZING] 隧道 PID $($child.Id)，正在等待本机就绪。"
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $ready = $false
    while (!$child.HasExited -and [DateTime]::UtcNow -lt $deadline -and !$ready) {
        if ((Test-Path -LiteralPath $pidFile) -and
            (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq [string]$child.Id) {
            $ready = Show-Health $health -Quiet
        }
        if (!$ready) { Start-Sleep -Milliseconds 500 }
    }
    if (!$child.HasExited) {
        if ($ready) {
            Write-Host '[READY] 本机健康检查通过。刷新现有 ChatGPT 插件，再点运行状态查看工具数。'
        } else {
            Write-Host '[WAITING] 进程正在运行。点运行状态检查，持续不就绪时查看 runtime\tunnel.log。'
        }
        Write-Host '[RUNNING] 保持窗口开启。按 Ctrl+C 或使用停止服务入口退出。'
        while (!$child.WaitForExit(1000)) {}
    }
    $code = $child.ExitCode
    Write-Host "[EXIT] 隧道进程退出，退出码 $code。诊断见 runtime\tunnel.log。"
    exit $code
} finally {
    if ($loadedKey) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
    $env:LOCAL_DC_TUNNEL_TERMINAL = $oldTerminal
    if ($child) {
        try {
            if (!$child.HasExited) { $null = Stop-OwnedTunnel $child -LaunchedHere }
        } finally {
            $child.Dispose()
            if ($locked) { $lock.ReleaseMutex(); $locked = $false }
        }
    }
    if ($locked) { $lock.ReleaseMutex() }
    $lock.Dispose()
}


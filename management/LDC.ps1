#Requires -Version 5.1
param(
    [ValidateSet('Start','Stop','Menu','Status','Launch')][string]$Action = 'Menu',
    [ValidatePattern('^[a-z0-9-]+$')][string]$VersionId,
    [ValidateSet('files','terminal')][string]$Mode,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$Token
)
$ErrorActionPreference = 'Stop'
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) }
$script:ManagerFile = $PSCommandPath
$script:Project = Split-Path -Parent $PSScriptRoot
$script:Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:RegistryPath = Join-Path $PSScriptRoot 'versions.json'
$script:DataDir = Join-Path $PSScriptRoot 'runtime'
$script:SelectionPath = Join-Path $script:DataDir 'selection.json'
$script:PendingPath = Join-Path $script:DataDir 'pending.json'
$script:ActivityPath = Join-Path $script:DataDir 'activity.log'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

function Join-LdcPath {
    param([string]$Parent, [string]$Relative)
    if (!$Relative -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) {
        throw '版本登记必须使用区内相对路径。'
    }
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath((Join-Path $Parent $Relative))
    if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '版本登记路径超出对应运行区。'
    }
    return $full
}

function Assert-LdcPlainPath {
    param([string]$Path)
    # A damaged or redirected runtime must not become a source of PID or log evidence.
    $cursor = $Path
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "拒绝重解析路径：$cursor"
        }
        if ($cursor -eq $script:Project) { return }
        $cursor = Split-Path -Parent $cursor
    }
    throw '运行文件不在项目内。'
}

function Read-LdcJson {
    param([string]$Path)
    Assert-LdcPlainPath $Path
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
    }
}

function Write-LdcText {
    param([string]$Path,[string]$Text)
    Assert-LdcPlainPath $Path
    $directory = Split-Path -Parent $Path
    $null = [IO.Directory]::CreateDirectory($directory)
    $temp = Join-Path $directory ('.ldc-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = $temp + '.old'
    try {
        [IO.File]::WriteAllText($temp, $Text, $script:Utf8)
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, $backup) }
        else { [IO.File]::Move($temp, $Path) }
    } finally {
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
}

function Write-LdcJson {
    param([string]$Path,$Value)
    Write-LdcText $Path ($Value | ConvertTo-Json -Depth 5)
}

function Write-LdcEvent {
    param([string]$Event,[string]$Version,[string]$RunMode,[int]$ProcessId=0,[int]$Code=0)
    Assert-LdcPlainPath $script:ActivityPath
    $null = [IO.Directory]::CreateDirectory($script:DataDir)
    try {
        Add-Content -LiteralPath $script:ActivityPath -Encoding UTF8 -ErrorAction Stop -Value (
            '{0:o} {1} version={2} mode={3} pid={4} code={5}' -f [datetime]::UtcNow,$Event,$Version,$RunMode,$ProcessId,$Code)
    } catch { Write-Host '管理操作日志暂时不可写。' }
}

function Initialize-LdcRegistry {
    $script:Registry = Read-LdcJson $script:RegistryPath
    $script:Tunnel = Join-LdcPath $script:Project $script:Registry.tunnelExecutable
    $script:Versions = @{}
    foreach ($row in $script:Registry.versions) {
        if ($row.id -notmatch '^[a-z0-9-]+$' -or $script:Versions.ContainsKey($row.id)) { throw '版本 ID 无效或重复。' }
        $directory = Join-LdcPath $script:Project $row.directory
        $runtime = Join-LdcPath $directory $row.runtime
        $script:Versions[$row.id] = [pscustomobject]@{
            Id=$row.id; Label=$row.label; Status=$row.status; Directory=$directory
            Launcher=Join-LdcPath $directory $row.launcher
            Profile=Join-LdcPath $directory $row.profile
            Build=Join-LdcPath $directory $row.build
            PidFile=Join-Path $runtime 'tunnel.pid'; HealthFile=Join-Path $runtime 'health.url'
            LogFile=Join-Path $runtime 'tunnel.log'
            RootConfig=$(if ($row.rootConfig) { Join-LdcPath $directory $row.rootConfig })
            Validator=$(if ($row.rootValidator) { Join-LdcPath $directory $row.rootValidator })
            FixedRoot=$(if ($row.fixedRoot) { [IO.Path]::GetFullPath((Join-Path $script:Project $row.fixedRoot)) })
            FilesTools=[int]$row.filesTools; TerminalTools=[int]$row.terminalTools
        }
    }
}

function Get-LdcSelection {
    $value = Read-LdcJson $script:SelectionPath
    if (!$value) { $value = [pscustomobject]@{target=$script:Registry.defaults; rollback=$script:Registry.rollback} }
    foreach ($item in $value.target,$value.rollback) {
        if (!$item -or !$item.version -or !$script:Versions.ContainsKey($item.version) -or $item.mode -notin 'files','terminal') {
            throw '管理目标或回滚记录无效。请检查 management/runtime/selection.json 和版本登记。'
        }
    }
    return $value
}

function Get-LdcTokens {
    param([string]$CommandLine)
    if (!$CommandLine) { return }
    $pos = 0
    foreach ($match in [regex]::Matches($CommandLine, '\G\s*(?:"([^"]*)"|([^"\s]+))(?=\s|$)')) {
        $pos = $match.Index + $match.Length
        if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    }
    if ($CommandLine.Substring($pos).Trim()) { throw '无法解析进程命令行。' }
}

function Get-LdcFlag {
    param([string[]]$Tokens,[string]$Name)
    $matches = @(for ($i=0; $i -lt $Tokens.Length; $i++) { if ($Tokens[$i] -eq $Name) { $i } })
    if ($matches.Count -ne 1 -or $matches[0] -ge ($Tokens.Length-1)) { return }
    return $Tokens[($matches[0]+1)]
}

function Get-LdcProcess {
    param([int]$ProcessId)
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
}

function Get-LdcTunnelProcesses {
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
        Where-Object { $_.ExecutablePath -eq $script:Tunnel }
}

function Get-LdcBirth {
    param($Process)
    ([datetime]$Process.CreationDate).ToUniversalTime().Ticks
}

function Get-LdcListenerOwners {
    param([int]$Port)
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

function Read-LdcLoopback([string]$Url) {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { return @{ StatusCode=[int]$response.StatusCode; Content=$reader.ReadToEnd() } }
        finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}
function Get-LdcHealth {
    param([string]$Url)
    $report = @{Health=0;Ready=0;McpHttp=0;McpState='未观测';Tools=$null;Complete=$false;Control='未知';ControlStatus='未知';PollFailures=$null}
    foreach ($endpoint in 'healthz','readyz','health/control-plane','health/mcp') {
        try {
            $reply = Read-LdcLoopback "$Url/$endpoint"
            switch ($endpoint) {
                'healthz' { $report.Health = [int]$reply.StatusCode }
                'readyz'  { $report.Ready = [int]$reply.StatusCode }
                'health/control-plane' {
                    $control = $reply.Content | ConvertFrom-Json
                    if ($control.state -match '^[a-z_]+$') { $report.Control = $control.state }
                    if ($control.status -match '^[a-z_]+$') { $report.ControlStatus = $control.status }
                    $report.PollFailures = $control.details.consecutive_failures
                }
                'health/mcp' {
                    $mcp = $reply.Content | ConvertFrom-Json
                    $report.McpHttp = [int]$reply.StatusCode
                    if ($mcp.state -match '^[a-z_]+$') { $report.McpState = $mcp.state }
                    $report.Tools = $mcp.details.tools_list.retained_count
                    $report.Complete = $mcp.details.tools_list.complete -eq $true
                }
            }
        } catch { }
    }
    return $report
}

function Get-LdcMode {
    param($Process,$Version,$Health)
    $parent = Get-LdcProcess $Process.ParentProcessId
    if ($parent -and (Get-LdcBirth $parent) -le (Get-LdcBirth $Process) -and $parent.ExecutablePath -eq $script:Shell) {
        try {
            $args = @(Get-LdcTokens $parent.CommandLine)
            $entry = Get-LdcFlag $args '-File'
            if ($entry -eq $Version.Launcher -and 'Start' -in $args) {
                if ('-Terminal' -in $args) { return 'terminal' }
                return 'files'
            }
            if ($entry -eq $script:ManagerFile -and (Get-LdcFlag $args '-Action') -eq 'Launch' -and
                (Get-LdcFlag $args '-VersionId') -eq $Version.Id) {
                $mode = Get-LdcFlag $args '-Mode'
                if ($mode -in 'files','terminal') { return $mode }
            }
        } catch { }
    }
    if ($Health -and $Health.Complete -and $Version.FilesTools -ne $Version.TerminalTools) {
        if ($Health.Tools -eq $Version.FilesTools) { return 'files' }
        if ($Health.Tools -eq $Version.TerminalTools) { return 'terminal' }
    }
    return 'unknown'
}

function Get-LdcObservation {
    param([switch]$IncludeHealth)
    $items = @(Get-LdcTunnelProcesses)
    if (!$items.Count) { return [pscustomobject]@{State='stopped'} }
    if ($items.Count -ne 1) { return [pscustomobject]@{State='unsafe'; Reason='检测到多个项目隧道，无法唯一识别。'} }
    $process = $items[0]
    $state = [pscustomobject]@{State='unsafe'; Reason=''; Pid=[int]$process.ProcessId; Birth=Get-LdcBirth $process
        Version=$null; Mode='unknown'; Health=$null; Url=$null}
    try {
        $args = @(Get-LdcTokens $process.CommandLine)
        if ($args.Count -lt 2 -or $args[0] -ne $script:Tunnel -or $args[1] -ne 'run') { throw '进程启动标识不匹配。' }
        $profile = Get-LdcFlag $args '--profile-file'
        $versions = @($script:Versions.Values | Where-Object Profile -eq $profile)
        if ($versions.Count -ne 1) { throw '该隧道未登记，使用其原启动窗口管理。' }
        $version = $versions[0]
        $state.Version = $version
        if ((Get-LdcFlag $args '--pid.file') -ne $version.PidFile -or
            (Get-LdcFlag $args '--health.url-file') -ne $version.HealthFile -or
            (Get-LdcFlag $args '--log.file') -ne $version.LogFile) {
            throw '进程参数与登记运行目录不符。'
        }
        # A missing engine or profile is recoverable. Validate the argument paths and runtime,
        # without requiring the version's payload to be present to stop its process.
        foreach ($path in $script:Tunnel,$version.Profile,$version.PidFile,$version.HealthFile,$version.LogFile) {
            Assert-LdcPlainPath $path
        }
        if (!(Test-Path -LiteralPath $version.PidFile -PathType Leaf)) { throw 'PID 文件尚未生成，当前不能安全停止。' }
        $pidItem = Get-Item -LiteralPath $version.PidFile -Force
        if ($pidItem.LastWriteTimeUtc.Ticks -lt $state.Birth -or
            [IO.File]::ReadAllText($version.PidFile).Trim() -ne [string]$state.Pid) {
            throw 'PID 文件过期或与进程不符。'
        }
        if (Test-Path -LiteralPath $version.HealthFile -PathType Leaf) {
            $healthItem = Get-Item -LiteralPath $version.HealthFile -Force
            $url = [IO.File]::ReadAllText($version.HealthFile).Trim()
            if ($healthItem.LastWriteTimeUtc.Ticks -lt $state.Birth -or
                $url -notmatch '^http://127\.0\.0\.1:([1-9][0-9]{0,4})/?$' -or [int]$Matches[1] -gt 65535) {
                throw '健康地址过期或格式不符。'
            }
            # Never send a health request to a different process using a recycled port.
            $owners = @(Get-LdcListenerOwners ([uri]$url).Port)
            if ($owners.Count -and ($owners.Count -ne 1 -or [int]$owners[0] -ne $state.Pid)) {
                throw '健康地址的监听者与隧道 PID 不符。'
            }
            if ($owners.Count -eq 1) {
                $state.Url = $url.TrimEnd('/')
                if ($IncludeHealth) { $state.Health = Get-LdcHealth $state.Url }
            }
        }
        $state.Mode = Get-LdcMode $process $version $state.Health
        $state.State = 'running'
    } catch {
        $state.Reason = $_.Exception.Message
    }
    return $state
}

function Format-LdcMode {
    param([string]$Name)
    switch ($Name) {
        files { '文件模式' }
        terminal { '完整终端模式' }
        default { '未知' }
    }
}

function Show-LdcStatus {
    param($Observation,[switch]$Detail)
    try { $selection = Get-LdcSelection } catch { Write-Host ('选择记录：' + $_.Exception.Message) }
    if ($selection) {
        $v = $script:Versions[$selection.target.version]
        $r = $script:Versions[$selection.rollback.version]
        Write-Host ("目标：{0} · {1} · {2}" -f $v.Label,(Format-LdcMode $selection.target.mode),$v.Status)
        Write-Host ("回滚：{0} · {1}" -f $r.Label,(Format-LdcMode $selection.rollback.mode))
    }
    if ($Observation.State -eq 'stopped') {
        $pending = Read-LdcJson $script:PendingPath
        if (Test-LdcPending $pending) { Write-Host '实际：正在启动或等待凭据。' }
        else { Write-Host '实际：未运行。' }
        return
    }
    $version = $Observation.Version
    $label = if ($version) { $version.Label } else { '未知或未登记版本' }
    if ($Observation.State -eq 'unsafe') {
        Write-Host ("实际：{0} · PID {1} · 身份证据不足：{2}" -f $label,$Observation.Pid,$Observation.Reason)
        return
    }
    $modeLabel = Format-LdcMode $Observation.Mode
    Write-Host "实际：$label · $modeLabel · PID $($Observation.Pid) · 进程运行中"
    $expected = switch ($Observation.Mode) { files { $version.FilesTools }; terminal { $version.TerminalTools }; default { '?' } }
    if ($Observation.Health) {
        $h = $Observation.Health
        $found = if ($h.Complete) { $h.Tools } else { '待发现' }
        Write-Host ("healthz={0}  readyz={1}  最近 MCP 发现快照 HTTP={2} / {3}  工具={4}/{5}" -f $h.Health,$h.Ready,$h.McpHttp,$h.McpState,$found,$expected)
        if ($h.Complete -and $expected -ne '?' -and $h.Tools -ne $expected) { Write-Warning ('MCP 工具数量不符，实际={0}，预期={1}。请核对启动模式。' -f $h.Tools,$expected) }
        Write-Host "控制平面：$($h.ControlStatus) / $($h.Control)；连续轮询失败：$($h.PollFailures)"
        if ($h.Complete -and $expected -ne '?' -and $h.Tools -ne $expected) { Write-Host '工具数量与启动模式不符，远程验收仍待确认。' }
        if (!$h.Complete) { Write-Host '当前快照未完整发现。它不代表最近普通 Chat 调用结果；必要时从普通 Chat 实测。' }
    } else { Write-Host "healthz、readyz 和 MCP 尚未观测；预期工具 $expected。" }
    if ($Detail) {
        Write-Host "进程启动 UTC：$([datetime]::new($Observation.Birth, [DateTimeKind]::Utc).ToString('o'))"
        Write-Host "运行日志：$($version.LogFile)"
        Write-Host "当前配置范围：$(Get-LdcConfiguredRoot $version)（修改后重启生效）"
    }
}

function Get-LdcConfiguredRoot {
    param($Version)
    if (!$Version.RootConfig) { return $Version.FixedRoot }
    Assert-LdcPlainPath $Version.RootConfig
    if (Test-Path -LiteralPath $Version.RootConfig -PathType Leaf) { return [IO.File]::ReadAllText($Version.RootConfig).Trim() }
    return '[默认] ' + $Version.FixedRoot
}

function Invoke-LdcRootProbe {
    param([string]$Validator)
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $root = & $node $Validator --check-root 2>$null
    if ($LASTEXITCODE -ne 0 -or !$root) { throw '授权目录须为已存在的本机绝对目录。盘符根、UNC 和重解析路径不允许。' }
    return [string]$root
}

function Confirm-LdcAction {
    param([string]$Question)
    return (Read-Host "$Question [输入 Y 确认，其余取消]") -eq 'Y'
}

function Set-LdcRoot {
    param($Version,[string]$Proposed)
    if (!$Version.RootConfig -or !$Version.Validator) { throw '此版本使用固定授权目录。' }
    $active = Get-LdcObservation
    $pending = Read-LdcJson $script:PendingPath
    if (($active.State -ne 'stopped' -and (!$active.Version -or $active.Version.Id -eq $Version.Id)) -or
        ($pending.version -eq $Version.Id -and (Test-LdcPending $pending))) {
        throw '请先停止目标版本或结束它的启动，再修改授权目录。'
    }
    Assert-LdcPlainPath $Version.Validator
    $stage = Join-Path $script:DataDir ('root-check-' + [guid]::NewGuid().ToString('N'))
    Assert-LdcPlainPath $stage
    $null = [IO.Directory]::CreateDirectory($stage)
    $validator = Join-Path $stage 'stdio.mjs'
    $config = Join-Path $stage 'allowed-root.txt'
    try {
        # The registered validator's --check-root branch needs only its sibling config.
        [IO.File]::Copy($Version.Validator,$validator)
        [IO.File]::WriteAllText($config,$Proposed,$script:Utf8)
        $normalized = Invoke-LdcRootProbe $validator
        Write-Host "当前配置：$(Get-LdcConfiguredRoot $Version)"
        if (!(Confirm-LdcAction "将 $($Version.Label) 的文件授权目录改为 $normalized（重新启动后生效）")) { return $false }
        Write-LdcText $Version.RootConfig ($normalized + [Environment]::NewLine)
        Write-LdcEvent 'root-updated' $Version.Id 'files'
        Write-Host '已保存。重新启动该版本后生效。终端仍使用当前 Windows 用户权限。'
        return $true
    } finally {
        [IO.File]::Delete($validator)
        [IO.File]::Delete($config)
        [IO.Directory]::Delete($stage)
    }
}

function Assert-LdcLaunchable {
    param($Version)
    foreach ($path in $script:Tunnel,$Version.Launcher,$Version.Profile,$Version.Build) {
        Assert-LdcPlainPath $path
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少启动文件：$path" }
    }
    $null = Get-Command node -CommandType Application
    if ($Version.Validator) {
        Assert-LdcPlainPath $Version.Validator
        Assert-LdcPlainPath $Version.RootConfig
        $null = Invoke-LdcRootProbe $Version.Validator
    } elseif ($Version.FixedRoot -and !(Test-Path -LiteralPath $Version.FixedRoot -PathType Container)) {
        throw '固定授权目录不存在。'
    }
}

function Get-LdcOutcomePath {
    param([string]$LaunchToken)
    if ($LaunchToken -notmatch '^[a-f0-9]{32}$') { throw '启动记录无效。' }
    Join-Path $script:DataDir ("launch-$LaunchToken.json")
}

function Test-LdcPending {
    param($Pending)
    if (!$Pending -or $Pending.token -notmatch '^[a-f0-9]{32}$' -or !$Pending.pid) { return $false }
    if (Read-LdcJson (Get-LdcOutcomePath $Pending.token)) { return $false }
    $worker = Get-LdcProcess ([int]$Pending.pid)
    if (!$worker -or $worker.ExecutablePath -ne $script:Shell -or (Get-LdcBirth $worker) -ne [long]$Pending.birth) { return $false }
    try {
        $args = @(Get-LdcTokens $worker.CommandLine)
        return ((Get-LdcFlag $args '-File') -eq $script:ManagerFile -and
            (Get-LdcFlag $args '-Action') -eq 'Launch' -and (Get-LdcFlag $args '-Token') -eq $Pending.token)
    } catch { return $false }
}

function Start-LdcWorker {
    param($Version,[string]$RunMode,[string]$LaunchToken)
    $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $script:ManagerFile),
        '-Action','Launch','-VersionId',$Version.Id,'-Mode',$RunMode,'-Token',$LaunchToken)
    Start-Process -FilePath $script:Shell -ArgumentList $args -WorkingDirectory $Version.Directory -WindowStyle Normal -PassThru
}

function Invoke-LdcWorker {
    param([string]$SelectedVersion,[string]$RunMode,[string]$LaunchToken)
    $version = $script:Versions[$SelectedVersion]
    if (!$version -or $RunMode -notin 'files','terminal') { throw '启动目标无效。' }
    $outcome = Get-LdcOutcomePath $LaunchToken
    $code = 1
    try {
        Assert-LdcLaunchable $version
        Write-Host ("正在启动 {0} · {1}" -f $version.Label,(Format-LdcMode $RunMode))

        if ($RunMode -eq 'terminal') {
            Write-Host '终端命令具有当前 Windows 用户权限；文件授权目录仅约束文件工具。'

        }
        $savedEnvironment = @{}
        foreach ($name in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','CONTROL_PLANE_HTTP_PROXY','CONTROL_PLANE_API_KEY') {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
        }
        & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Prepare
        $global:LASTEXITCODE = 0
        if ($RunMode -eq 'terminal') {
            & $version.Launcher -Action Start -Terminal
        } else {
            & $version.Launcher -Action Start
        }
        $code = $LASTEXITCODE
    } catch {
        Write-Host ('启动入口失败：' + $_.Exception.Message)
    } finally {
        if ($savedEnvironment) { foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') } }
        Write-LdcJson $outcome @{version=$version.Id; mode=$RunMode; exitCode=[int]$code; utc=[datetime]::UtcNow.ToString('o')}
        Write-LdcEvent 'worker-exit' $version.Id $RunMode 0 $code
    }
    if ($code -ne 0) {
        Write-Host "退出码 $code。诊断见 $($version.LogFile)。认证失败时核对现有密钥、所属组织及权限。可在菜单 9 回滚。"
        $null = Read-Host '按 Enter 关闭启动窗口'
    }
    return $code
}

function Wait-LdcLauncherSlot {
    if (!$script:Registry.launchMutex) { return }
    $mutex = New-Object Threading.Mutex($false, [string]$script:Registry.launchMutex)
    $ready = $false
    try {
        try { $ready = $mutex.WaitOne(6000) } catch [Threading.AbandonedMutexException] { $ready = $true }
        if (!$ready) { throw '上一个启动窗口还未释放隧道，请稍后重试。' }
    } finally {
        if ($ready) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Start-LdcTarget {
    param($Target)
    $observed = Get-LdcObservation -IncludeHealth
    if ($observed.State -ne 'stopped') {
        Show-LdcStatus $observed
        if ($observed.State -eq 'running' -and $observed.Version.Id -eq $Target.version -and $observed.Mode -eq $Target.mode) {
            Write-Host '目标实例已运行。'
            return 0
        }
        Write-Host '已有其他或无法确认的实例。请通过管理菜单确认切换。'
        return 1
    }
    $pending = Read-LdcJson $script:PendingPath
    if (Test-LdcPending $pending) {
        Write-Host "已有启动窗口（PID $($pending.pid)），请在那里完成凭据输入或关闭失败的启动。"
        return 0
    }
    $version = $script:Versions[$Target.version]
    try {
        Assert-LdcLaunchable $version
        Wait-LdcLauncherSlot
    } catch {
        Write-LdcEvent 'start-preflight-failed' $version.Id $Target.mode 0 1
        throw "$($_.Exception.Message) 日志位置：$($version.LogFile)"
    }
    $launchToken = [guid]::NewGuid().ToString('N')
    Write-Host ("启动目标：{0} · {1} · {2}" -f $version.Label,(Format-LdcMode $Target.mode),$version.Status)
    $worker = Start-LdcWorker $version $Target.mode $launchToken
    try {
        $wmi = Get-LdcProcess $worker.Id
        $birth = if ($wmi) { Get-LdcBirth $wmi } else { 0 }
        Write-LdcJson $script:PendingPath @{token=$launchToken;version=$version.Id;mode=$Target.mode;pid=$worker.Id;birth=$birth}
        Write-LdcEvent 'start-request' $version.Id $Target.mode $worker.Id
        $deadline = [datetime]::UtcNow.AddSeconds(12)
        do {
            $result = Read-LdcJson (Get-LdcOutcomePath $launchToken)
            if ($result -or $worker.HasExited) {
                $code = if ($result) { [int]$result.exitCode } else { [int]$worker.ExitCode }
                Write-LdcEvent 'start-failed' $version.Id $Target.mode $worker.Id $code
                Write-Host "启动窗口已退出或报告故障，退出码 $code。日志：$($version.LogFile)。可在菜单 9 回滚。"
                return 1
            }
            $observed = Get-LdcObservation
            if ($observed.State -eq 'running' -and $observed.Version.Id -eq $version.Id -and ($observed.Mode -eq $Target.mode -or $observed.Mode -eq 'unknown')) {
                Show-LdcStatus (Get-LdcObservation -IncludeHealth)
                Write-Host "日志：$($version.LogFile)。如工具数未更新，请刷新原 ChatGPT 插件。"
                return 0
            }
            Start-Sleep -Milliseconds 350
        } while ([datetime]::UtcNow -lt $deadline)
        Write-Host "启动窗口 PID $($worker.Id) 仍在预检、等待凭据或初始化。管理窗口已结束等待，可在启动窗口用 Ctrl+C 取消。请查看该窗口，或用菜单 7 查询状态。日志：$($version.LogFile)"
        return 0
    } finally {
        $worker.Dispose()
    }
}

function Stop-LdcInstance {
    param($Observed)
    if ($Observed.State -eq 'stopped') {
        if (Test-LdcPending (Read-LdcJson $script:PendingPath)) {
            Write-Host '启动窗口仍在等待凭据或 PID 生成。请在启动窗口取消，然后复查状态。'
            return 1
        }
        Write-Host '服务未运行。'
        return 0
    }
    if ($Observed.State -ne 'running') { throw "拒绝停止：$($Observed.Reason)" }
    try { $owned = Get-Process -Id $Observed.Pid -ErrorAction Stop } catch { throw '原进程已消失。请刷新状态后再决定。' }
    try {
        $null = $owned.Handle
        $current = Get-LdcObservation
        if ($owned.HasExited -or $current.State -ne 'running' -or $current.Pid -ne $Observed.Pid -or
            $current.Birth -ne $Observed.Birth -or $current.Version.Id -ne $Observed.Version.Id) {
            throw '拒绝停止：进程身份或状态已变化。'
        }
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $owned.Id /T /F | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '停止失败，请用状态入口核验。' }
        if (!$owned.WaitForExit(6000)) { throw '停止后进程仍存活，拒绝继续切换。' }
        if ((Get-LdcObservation).State -ne 'stopped') { throw '停止后另有项目隧道出现，拒绝继续切换。' }
        Write-LdcEvent 'stopped' $Observed.Version.Id $Observed.Mode $Observed.Pid
        Write-Host "已确认 PID $($Observed.Pid) 退出。"
        return 0
    } finally {
        $owned.Dispose()
    }
}

function Invoke-LdcChange {
    param($Target,[ValidateSet('select','restart','rollback')][string]$Kind)
    $observed = Get-LdcObservation -IncludeHealth
    if ($observed.State -eq 'unsafe') { throw "拒绝切换：$($observed.Reason)" }
    if ($observed.State -eq 'stopped' -and (Test-LdcPending (Read-LdcJson $script:PendingPath))) {
        throw '启动窗口仍在等待凭据或初始化，请先完成或取消。'
    }
    if ($Kind -eq 'restart') {
        if ($observed.State -ne 'running' -or $observed.Mode -eq 'unknown') {
            throw '只有已确认版本和模式的运行实例可以重启。'
        }
        $Target = [pscustomobject]@{version=$observed.Version.Id;mode=$observed.Mode}
    }
    $selection = Get-LdcSelection
    $version = $script:Versions[$Target.version]
    $same = $observed.State -eq 'running' -and $observed.Version.Id -eq $Target.version -and $observed.Mode -eq $Target.mode
    $verb = switch ($Kind) { select { '选择' }; restart { '重启' }; rollback { '回滚至' } }
    $message = "$verb $($version.Label) · $(Format-LdcMode $Target.mode)"
    if ($observed.State -eq 'running' -and (!$same -or $Kind -eq 'restart')) {
        $message += "，将结束 PID $($observed.Pid) 的服务及其子进程"
    }
    if ($Target.mode -eq 'terminal') { $message += '；终端具有当前 Windows 用户权限' }
    if (!(Confirm-LdcAction $message)) { return 0 }
    $launch = $Kind -ne 'select' -or ($observed.State -eq 'running' -and !$same)
    if ($launch -and (!$same -or $Kind -eq 'restart')) {
        Assert-LdcLaunchable $version
        if ($observed.State -eq 'running') {
            if ((Stop-LdcInstance $observed) -ne 0) { return 1 }
            if ($Kind -ne 'rollback' -and $observed.Version.Id -ne $Target.version -and $observed.Mode -ne 'unknown' -and
                $observed.Health -and $observed.Health.Health -eq 200 -and $observed.Health.Ready -eq 200) {
                $selection.rollback = [pscustomobject]@{version=$observed.Version.Id;mode=$observed.Mode}
            }
        }
        $selection.target = $Target
        Write-LdcJson $script:SelectionPath $selection
        return (Start-LdcTarget $Target)
    }
    $selection.target = $Target
    Write-LdcJson $script:SelectionPath $selection
    Write-Host '已保存此目标，供下次启动使用。'
    return 0
}

function Get-LdcLogSummary {
    param([string]$Path)
    Assert-LdcPlainPath $Path
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    foreach ($line in (Get-Content -LiteralPath $Path -Tail 20 -Encoding UTF8)) {
        try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            $message = [string]$(if ($event.msg) { $event.msg } else { $event.message })
            if (!$message) { continue }
            $stamp = if ([string]$event.time -match '^[0-9:.TZ+-]{10,40}$') { $event.time } else { '' }
            $level = if ([string]$event.level -match '^[A-Za-z]{3,8}$') { $event.level } else { '' }
            if ($message -match '(?i)authorization|bearer|api[ _-]*key|credential|secret|sk-[a-z0-9_-]+') {
                "$stamp $level [认证或凭据信息已隐藏]"
            } else {
                "$stamp $level $($message -replace '[\x00-\x1f\x7f]', ' ')"
            }
        } catch { }
    }
}

function Show-LdcLogs {
    $observed = Get-LdcObservation
    $version = if ($observed.Version) { $observed.Version } else { $script:Versions[(Get-LdcSelection).target.version] }
    Write-Host "隧道日志：$($version.LogFile)"
    Get-LdcLogSummary $version.LogFile | Out-Host
    Write-Host "管理操作：$script:ActivityPath"
    Assert-LdcPlainPath $script:ActivityPath
    if (Test-Path -LiteralPath $script:ActivityPath -PathType Leaf) {
        Get-Content -LiteralPath $script:ActivityPath -Tail 12 | Out-Host
    }
}

function Invoke-LdcLocked {
    param([scriptblock]$Operation)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:Project.ToLowerInvariant()))).Replace('-','').Substring(0,24)
    } finally { $sha.Dispose() }
    $lock = New-Object Threading.Mutex($false, "Local\LDC-management-$key")
    $locked = $false
    try {
        try { $locked = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw '另一个管理窗口正在执行操作，请稍后再试。' }
        & $Operation
    } finally {
        if ($locked) { $lock.ReleaseMutex() }
        $lock.Dispose()
    }
}

function Read-LdcMode {
    param([string]$Default)
    Write-Host '1 文件模式    2 完整终端模式（当前 Windows 用户权限）'
    if ($Default) { Write-Host "当前选择：$(Format-LdcMode $Default)" }
    $inputMode = Read-Host '选择模式（Enter 保持原选择）'
    switch ($inputMode) {
        '1' { 'files' }
        '2' { 'terminal' }
        '' { $Default }
        default { Write-Host '无效模式，操作取消。' }
    }
}

function Invoke-LdcMenuChoice {
    param([string]$choice)
        try {
            switch ($choice) {
                '1' { $null = Invoke-LdcLocked { Start-LdcTarget (Get-LdcSelection).target } }
                '2' { $null = Invoke-LdcLocked {
                    $current = Get-LdcObservation
                    if ($current.State -ne 'running' -or (Confirm-LdcAction "停止 PID $($current.Pid) 及其子进程")) {
                        Stop-LdcInstance $current
                    }
                } }
                '3' { $null = Invoke-LdcLocked { Invoke-LdcChange $null 'restart' } }
                '4' {
                    $mode = Read-LdcMode
                    if ($mode) {
                        $null = Invoke-LdcLocked {
                            $active = Get-LdcObservation
                            $id = if ($active.State -eq 'running') { $active.Version.Id } else { (Get-LdcSelection).target.version }
                            Invoke-LdcChange ([pscustomobject]@{version=$id;mode=$mode}) 'select'
                        }
                    }
                }
                '5' {
                    foreach ($v in ($script:Versions.Values | Sort-Object Id)) { Write-Host "$($v.Id)  $($v.Label) · $($v.Status)" }
                    $id = Read-Host '输入版本 ID（Enter 取消）'
                    if ($id -and $script:Versions.ContainsKey($id)) {
                        $mode = Read-LdcMode (Get-LdcSelection).target.mode
                        if ($mode) {
                            $null = Invoke-LdcLocked { Invoke-LdcChange ([pscustomobject]@{version=$id;mode=$mode}) 'select' }
                        }
                    } elseif ($id) { Write-Host '未登记此版本。' }
                }
                '6' {
                    $v = $script:Versions[(Get-LdcSelection).target.version]
                    Write-Host "$($v.Label) 配置的文件授权目录：$(Get-LdcConfiguredRoot $v)"
                    if ($v.RootConfig) {
                        $path = Read-Host '输入新的本机目录（Enter 保持）'
                        if ($path) { $null = Invoke-LdcLocked { Set-LdcRoot $v $path } }
                    } else { Write-Host '此版本使用固定授权目录。' }
                }
                '7' { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail }
                '8' { Show-LdcLogs }
                '11' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Network }
                '12' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Configure }
                '13' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Forget }
                '14' { try { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Diagnose } finally { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail } }
                '9' { $null = Invoke-LdcLocked { Invoke-LdcChange (Get-LdcSelection).rollback 'rollback' } }
                default { Write-Host '请输入菜单编号。' }
            }
        } catch { Write-Host ("操作失败：{0}" -f $_.Exception.Message) }
}

function Show-LdcLegacyMenu {
    while ($true) {
        Write-Host ''
        Write-Host '=== Local DC 管理控制台 ==='
        Show-LdcStatus (Get-LdcObservation -IncludeHealth)
        Write-Host '1 启动服务          2 停止服务          3 重启服务'
        Write-Host '4 切换运行模式      5 切换运行版本      6 查看与设置授权目录'
        Write-Host '7 详细运行状态      8 查看运行日志      9 回滚至上一可用版本'
        Write-Host '10 退出控制台'
        Write-Host '11 网络与代理设置   12 保存或更换密钥   13 清除已保存密钥   14 网络连接诊断'
        $choice = Read-Host '选择'
        if ($null -eq $choice -or $choice -eq '10') { return }
        try {
            switch ($choice) {
                '1' { $null = Invoke-LdcLocked { Start-LdcTarget (Get-LdcSelection).target } }
                '2' { $null = Invoke-LdcLocked {
                    $current = Get-LdcObservation
                    if ($current.State -ne 'running' -or (Confirm-LdcAction "停止 PID $($current.Pid) 及其子进程")) {
                        Stop-LdcInstance $current
                    }
                } }
                '3' { $null = Invoke-LdcLocked { Invoke-LdcChange $null 'restart' } }
                '4' {
                    $mode = Read-LdcMode
                    if ($mode) {
                        $null = Invoke-LdcLocked {
                            $active = Get-LdcObservation
                            $id = if ($active.State -eq 'running') { $active.Version.Id } else { (Get-LdcSelection).target.version }
                            Invoke-LdcChange ([pscustomobject]@{version=$id;mode=$mode}) 'select'
                        }
                    }
                }
                '5' {
                    foreach ($v in ($script:Versions.Values | Sort-Object Id)) { Write-Host "$($v.Id)  $($v.Label) · $($v.Status)" }
                    $id = Read-Host '输入版本 ID（Enter 取消）'
                    if ($id -and $script:Versions.ContainsKey($id)) {
                        $mode = Read-LdcMode (Get-LdcSelection).target.mode
                        if ($mode) {
                            $null = Invoke-LdcLocked { Invoke-LdcChange ([pscustomobject]@{version=$id;mode=$mode}) 'select' }
                        }
                    } elseif ($id) { Write-Host '未登记此版本。' }
                }
                '6' {
                    $v = $script:Versions[(Get-LdcSelection).target.version]
                    Write-Host "$($v.Label) 配置的文件授权目录：$(Get-LdcConfiguredRoot $v)"
                    if ($v.RootConfig) {
                        $path = Read-Host '输入新的本机目录（Enter 保持）'
                        if ($path) { $null = Invoke-LdcLocked { Set-LdcRoot $v $path } }
                    } else { Write-Host '此版本使用固定授权目录。' }
                }
                '7' { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail }
                '8' { Show-LdcLogs }
                '11' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Network }
                '12' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Configure }
                '13' { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Forget }
                '14' { try { & (Join-Path $PSScriptRoot 'LDC-Stable.ps1') -Action Diagnose } finally { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail } }
                '9' { $null = Invoke-LdcLocked { Invoke-LdcChange (Get-LdcSelection).rollback 'rollback' } }
                default { Write-Host '请输入菜单编号。' }
            }
        } catch { Write-Host ("操作失败：{0}" -f $_.Exception.Message) }
    }
}


function Show-LdcMenu {
    $ui=Join-Path $PSScriptRoot 'LDC-Dashboard.ps1'
    if ($env:LOCAL_DC_LEGACY_MENU -eq '1' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or !(Test-Path -LiteralPath $ui)) {
        Show-LdcLegacyMenu
        return
    }
    . $ui
    Show-LdcDashboard
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Initialize-LdcRegistry
        switch ($Action) {
            'Start' { exit (Invoke-LdcLocked { Start-LdcTarget (Get-LdcSelection).target }) }
            'Stop'  { exit (Invoke-LdcLocked { Stop-LdcInstance (Get-LdcObservation) }) }
            'Menu'  { Show-LdcMenu; exit 0 }
            'Status' { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail; exit 0 }
            'Launch' { exit (Invoke-LdcWorker $VersionId $Mode $Token) }
        }
    } catch {
        Write-Host ("操作失败：{0}" -f $_.Exception.Message)
        exit 1
    }
}

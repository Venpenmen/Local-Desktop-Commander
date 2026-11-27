#Requires -Version 5.1
param(
    [ValidateSet('Start','Stop','Menu','Status','Launch')][string]$Action = 'Menu',
    [ValidatePattern('^[a-z0-9-]+$')][string]$VersionId,
    [ValidateSet('files','terminal')][string]$Mode,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$Token
)
. (Join-Path $PSScriptRoot 'LDC-Core.ps1')
. (Join-Path $PSScriptRoot 'LDC-Protocol.ps1')

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

function Invoke-LdcConsoleOperation {
    param([string]$Operation,$Arguments)
    Invoke-LdcRequest @{protocol=1;id='console';operation=$Operation;arguments=$Arguments} -Interactive
}

function Invoke-LdcMenuChoice {
    param([string]$choice)
    switch ($choice) {
        '1' { $null = Invoke-LdcConsoleOperation start }
        '2' { $null = Invoke-LdcConsoleOperation stop }
        '3' { $null = Invoke-LdcConsoleOperation restart }
        '4' {
            $mode = Read-LdcMode
            if ($mode) {
                $active = Get-LdcObservation
                $id = if ($active.State -eq 'running') { $active.Version.Id } else { (Get-LdcSelection).target.version }
                $null = Invoke-LdcConsoleOperation select @{version=$id;mode=$mode}
            }
        }
        '5' {
            foreach ($version in (Invoke-LdcConsoleOperation versions).result) {
                Write-Host "$($version.Id)  $($version.Label) · $($version.Status)"
            }
            $id = Read-Host '输入版本 ID（Enter 取消）'
            if (!$id) { return }
            if (!$script:Versions.ContainsKey($id)) { Write-Host '未登记此版本。'; return }
            $mode = Read-LdcMode (Get-LdcSelection).target.mode
            if ($mode) { $null = Invoke-LdcConsoleOperation select @{version=$id;mode=$mode} }
        }
        '6' {
            $snapshot = (Invoke-LdcConsoleOperation state).result
            if (!$snapshot) { return }
            $config = $snapshot.configuration
            $id = $config.target.version
            Write-Host '=== 文件访问权限管理 ==='
            $actual = if ($snapshot.fileAccess.actual.mode) { $snapshot.fileAccess.actual.mode } else { '未观测' }
            Write-Host "当前实际权限：$actual；下次启动：$($config.accessModes[$id])"
            if ($actual -eq 'full') { Write-Host '当前文件工具可访问 Windows 用户有权访问的所有本地路径。' }
            Write-Host "受限授权目录：$($config.roots[$id])"
            Write-Host '1 受限访问   2 完全访问   3 修改受限目录   0 返回'
            switch (Read-Host '选择（Enter 返回）') {
                '1' { $null = Invoke-LdcConsoleOperation access.set @{version=$id;mode='restricted';revision=$config.revision} }
                '2' { $null = Invoke-LdcConsoleOperation access.set @{version=$id;mode='full';revision=$config.revision} }
                '3' {
                    $path = Read-Host '输入本机绝对目录或盘符根（Enter 取消）'
                    if ($path) { $null = Invoke-LdcConsoleOperation root.set @{version=$id;path=$path;revision=$config.revision} }
                }
            }
        }
        '7' { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail }
        '8' { Show-LdcLogs }
        '9' { $null = Invoke-LdcConsoleOperation rollback }
        '11' { $null = Invoke-LdcConsoleOperation network.prompt }
        '12' { $null = Invoke-LdcConsoleOperation credential.configure }
        '13' { $null = Invoke-LdcConsoleOperation credential.forget }
        '14' {
            $diagnosis = (Invoke-LdcConsoleOperation diagnose).result
            Write-Host "OpenAI HTTPS 可达：$($diagnosis.reachable)；路径：$($diagnosis.route)"
            Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail
        }
        default { Write-Host '请输入菜单编号。' }
    }
}

function Show-LdcLegacyMenu {
    while ($true) {
        Write-Host ''
        Write-Host '=== Local DC 管理控制台 ==='
        Show-LdcStatus (Get-LdcObservation -IncludeHealth)
        Write-Host '1 启动服务          2 停止服务          3 重启服务'
        Write-Host '4 切换运行模式      5 切换运行版本      6 文件访问权限'
        Write-Host '7 详细运行状态      8 查看运行日志      9 回滚至上一可用版本'
        Write-Host '10 退出控制台'
        Write-Host '11 网络与代理设置   12 保存或更换密钥   13 清除已保存密钥   14 网络连接诊断'
        $choice = Read-Host '选择'
        if ($null -eq $choice -or $choice -eq '10') { return }
        try { Invoke-LdcMenuChoice $choice }
        catch { Write-Host ("操作失败：{0}" -f $_.Exception.Message) }
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
            'Start' { if ((Invoke-LdcConsoleOperation start).ok) { exit 0 }; exit 1 }
            'Stop'  { if ((Invoke-LdcConsoleOperation stop @{confirmed=$true}).ok) { exit 0 }; exit 1 }
            'Menu'  { Show-LdcMenu; exit 0 }
            'Status' { Show-LdcStatus (Get-LdcObservation -IncludeHealth) -Detail; exit 0 }
            'Launch' { exit (Invoke-LdcWorker $VersionId $Mode $Token) }
        }
    } catch {
        Write-Host ("操作失败：{0}" -f $_.Exception.Message)
        exit 1
    }
}

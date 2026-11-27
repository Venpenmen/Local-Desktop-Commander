# PowerShell 5.1 console dashboard. No service operations in the polling worker.
function Get-LdcCellWidth([string]$Text) {
    $n=0
    foreach($ch in $Text.ToCharArray()) {
        $v=[int]$ch
        if($v -ge 0x1100 -and ($v -le 0x115f -or $v -ge 0x2e80 -and $v -le 0xa4cf -or $v -ge 0xac00 -and $v -le 0xd7a3 -or $v -ge 0xf900 -and $v -le 0xfaff -or $v -ge 0xfe10 -and $v -le 0xfe6f -or $v -ge 0xff00 -and $v -le 0xff60 -or $v -ge 0xffe0 -and $v -le 0xffe6)) {$n+=2} else {$n++}
    }
    return $n
}
function Format-LdcCell([string]$Text,[int]$Width) {
    $Text=$Text -replace '[\x00-\x1f\x7f]',' '
    $sb=New-Object Text.StringBuilder
    $n=0
    foreach($ch in $Text.ToCharArray()) {
        $c=Get-LdcCellWidth ([string]$ch)
        if($n+$c -gt $Width){break}
        $null=$sb.Append($ch);$n+=$c
    }
    return $sb.ToString()+(' '*[Math]::Max(0,$Width-$n))
}
function Get-LdcDashboardSize {
    $width=[Console]::WindowWidth
    $height=[Console]::WindowHeight
    [pscustomobject]@{Width=[Math]::Max(1,$width-1);Height=$height;Usable=($width -ge 64 -and $height -ge 22)}
}
function Write-LdcDashboardLine([int]$Row,[string]$Text,[int]$Width,[ConsoleColor]$Color) {
    [Console]::SetCursorPosition(0,$Row)
    [Console]::ForegroundColor=$Color
    [Console]::Write((Format-LdcCell $Text $Width))
}
function Get-LdcDashboardSnapshot {
    # Use existing status formatter and capture information records, not secrets or raw process arguments.
    $output=@(Show-LdcStatus (Get-LdcObservation -IncludeHealth) 6>&1 3>&1)
    foreach($record in $output) {
        if($record -is [System.Management.Automation.InformationRecord]) {
            $message=$record.MessageData
            if($message -is [System.Management.Automation.HostInformationMessage]) {[string]$message.Message}
            else {[string]$message}
        } else {[string]$record}
    }
}
function New-LdcDashboardPoller([string]$Manager) {
    $pool=[runspacefactory]::CreateRunspace()
    $pool.Open()
    $worker=[powershell]::Create()
    $worker.Runspace=$pool
    $scriptText={
        param($managerPath)
        . $managerPath
        . (Join-Path (Split-Path -Parent $managerPath) 'LDC-Dashboard.ps1')
        Initialize-LdcRegistry
        Get-LdcDashboardSnapshot
    }
    $null=$worker.AddScript($scriptText.ToString()).AddArgument($Manager)
    [pscustomobject]@{Worker=$worker;Runspace=$pool;Async=$worker.BeginInvoke()}
}
function Close-LdcDashboardPoller($Poller) {
    if($Poller) {
        try {if(!$Poller.Async.IsCompleted){$Poller.Worker.Stop()}}catch{}
        try {$Poller.Worker.Dispose()}catch{}
        try {$Poller.Runspace.Dispose()}catch{}
    }
}
function Add-LdcDashboardLog($Logs,[string]$Message) {
    foreach($line in ($Message -split '\r?\n')) {
        if($line -match '(?i)sk-[a-z0-9_-]{12,}|bearer\s+\S+|api[_ -]?key\s*[:=]\s*\S+') {$line='[credential information hidden]'}
        $Logs.Add(('[{0:HH:mm:ss}] {1}' -f (Get-Date),$line))
    }
    while($Logs.Count -gt 500){$Logs.RemoveAt(0)}
}
function Show-LdcDashboard {
    # Console API rather than VT/alternate-screen dependencies; original menu remains for redirected hosts.
    $size=Get-LdcDashboardSize
    if(!$size.Usable){Show-LdcLegacyMenu;return}
    $fg=[Console]::ForegroundColor;$bg=[Console]::BackgroundColor
    $logs=New-Object 'System.Collections.Generic.List[string]'
    $snapshot=@('正在获取服务状态...')
    $poller=$null;$next=[datetime]::MinValue;$last='尚未刷新'
    $inputText='';$scroll=0;$dirty=$true;$lastSize=''
    Add-LdcDashboardLog $logs '管理控制台已打开；退出控制台不会停止服务。'
    try {
        [Console]::Clear()
        while($true) {
            $size=Get-LdcDashboardSize
            if(!$size.Usable) {
                Close-LdcDashboardPoller $poller;$poller=$null
                [Console]::ForegroundColor=$fg;[Console]::Clear()
                Write-Host '窗口过小，使用兼容菜单。重新打开较大窗口可恢复固定面板。'
                Show-LdcLegacyMenu;return
            }
            $sig="$($size.Width)x$($size.Height)"
            if($sig -ne $lastSize){[Console]::Clear();$lastSize=$sig;$dirty=$true}
            if($poller -and $poller.Async.IsCompleted) {
                try {
                    $new=@($poller.Worker.EndInvoke($poller.Async)|ForEach-Object {[string]$_})
                    if($new.Count){$snapshot=$new}else{$snapshot=@('状态暂不可用')}
                    if($poller.Worker.HadErrors){$snapshot+=@('状态查询存在错误，请使用 7 查看详细状态')}
                    $last=(Get-Date).ToString('HH:mm:ss')
                } catch {$snapshot=@('状态查询失败，可使用 7 重试')}
                finally {Close-LdcDashboardPoller $poller;$poller=$null}
                $next=[datetime]::UtcNow.AddSeconds(3);$dirty=$true
            }
            if(!$poller -and [datetime]::UtcNow -ge $next) {
                try {$poller=New-LdcDashboardPoller $script:ManagerFile}
                catch {$snapshot=@('状态查询暂不可用');$next=[datetime]::UtcNow.AddSeconds(3);$dirty=$true}
            }
            if($dirty) {
                $w=$size.Width;$h=$size.Height
                $sep='-'*$w
                Write-LdcDashboardLine 0 '=== Local DC 管理控制台 ===' $w Cyan
                for($i=0;$i -lt 7;$i++){
                    $line=if($i -lt $snapshot.Count){$snapshot[$i]}else{''}
                    Write-LdcDashboardLine ($i+1) $line $w $fg
                }
                Write-LdcDashboardLine 8 "最近刷新：$last  |  每 3 秒检测  |  F5 立即刷新" $w DarkGray
                Write-LdcDashboardLine 9 $sep $w DarkGray
                Write-LdcDashboardLine 10 ' 1 启动服务       2 停止服务       3 重启服务' $w $fg
                Write-LdcDashboardLine 11 ' 4 切换模式       5 切换版本       6 授权目录' $w $fg
                Write-LdcDashboardLine 12 ' 7 详细状态       8 运行日志       9 回滚版本' $w $fg
                Write-LdcDashboardLine 13 '11 网络设置      12 保存密钥      13 清除密钥' $w $fg
                Write-LdcDashboardLine 14 '14 网络诊断      10 退出控制台' $w $fg
                Write-LdcDashboardLine 15 $sep $w DarkGray
                $capacity=$h-19
                $maxScroll=[Math]::Max(0,$logs.Count-$capacity)
                $scroll=[Math]::Min($scroll,$maxScroll)
                $endIndex=$logs.Count-$scroll
                $begin=[Math]::Max(0,$endIndex-$capacity)
                Write-LdcDashboardLine 16 "操作记录  |  ↑↓ / PgUp PgDn / End  |  $endIndex/$($logs.Count)" $w Cyan
                for($i=0;$i -lt $capacity;$i++){
                    $ix=$begin+$i
                    $line=if($ix -lt $endIndex){$logs[$ix]}else{''}
                    Write-LdcDashboardLine (17+$i) $line $w $fg
                }
                Write-LdcDashboardLine ($h-2) $sep $w DarkGray
                Write-LdcDashboardLine ($h-1) ('选择：'+$inputText) $w Green
                [Console]::SetCursorPosition([Math]::Min($w-1,6+$inputText.Length),$h-1)
                $dirty=$false
            }
            if(![Console]::KeyAvailable){Start-Sleep -Milliseconds 80;continue}
            $key=[Console]::ReadKey($true)
            switch($key.Key.ToString()){
                'F5' {$next=[datetime]::MinValue}
                'UpArrow' {$scroll++}
                'DownArrow' {$scroll=[Math]::Max(0,$scroll-1)}
                'PageUp' {$scroll+=[Math]::Max(1,$size.Height-19)}
                'PageDown' {$scroll=[Math]::Max(0,$scroll-[Math]::Max(1,$size.Height-19))}
                'End' {$scroll=0}
                'Escape' {$inputText=''}
                'Backspace' {if($inputText.Length){$inputText=$inputText.Substring(0,$inputText.Length-1)}}
                'Enter' {
                    $choice=$inputText;$inputText=''
                    if($choice -eq '10'){return}
                    if($choice -match '^(?:[1-9]|1[1-4])$'){
                        Close-LdcDashboardPoller $poller;$poller=$null
                        Add-LdcDashboardLog $logs "执行菜单 $choice"
                        if($choice -in '7','8'){
                            # Read-only actions are captured and displayed in the scrollable region.
                            try {
                                $records=@(if($choice -eq '7'){Invoke-LdcMenuChoice $choice 6>&1 3>&1})
                                foreach($rec in $records){
                                    if($rec -is [System.Management.Automation.InformationRecord]) {
                                        if($rec.MessageData -is [System.Management.Automation.HostInformationMessage]){Add-LdcDashboardLog $logs ([string]$rec.MessageData.Message)}
                                        else{Add-LdcDashboardLog $logs ([string]$rec.MessageData)}
                                    }else{Add-LdcDashboardLog $logs ([string]$rec)}
                                }
                                # Show-LdcLogs uses Out-Host for its detailed records; also load safe summary explicitly.
                                if($choice -eq '8'){
                                    $obs=Get-LdcObservation
                                    $ver=if($obs.Version){$obs.Version}else{$script:Versions[(Get-LdcSelection).target.version]}
                                    foreach($line in @(Get-LdcLogSummary $ver.LogFile)){Add-LdcDashboardLog $logs $line}
                                    if(Test-Path -LiteralPath $script:ActivityPath){foreach($line in @(Get-Content -LiteralPath $script:ActivityPath -Tail 12)){Add-LdcDashboardLog $logs $line}}
                                }
                            }catch{Add-LdcDashboardLog $logs ('操作失败：'+$_.Exception.Message)}
                        }else{
                            # Native interactive action screen: no custom password handling or output capture.
                            [Console]::ForegroundColor=$fg;[Console]::Clear()
                            Write-Host "=== Local DC 操作 $choice ==="
                            try {Invoke-LdcMenuChoice $choice;Add-LdcDashboardLog $logs "菜单 $choice 已返回（具体执行结果见操作输出及管理日志）"}
                            catch{Add-LdcDashboardLog $logs "菜单 $choice 执行异常";Write-Host $_.Exception.Message}
                            $null=Read-Host '按 Enter 返回固定面板'
                            [Console]::Clear()
                        }
                        $scroll=0;$next=[datetime]::MinValue
                    }elseif($choice){Add-LdcDashboardLog $logs "无效菜单：$choice"}
                }
                default {if([char]::IsDigit($key.KeyChar) -and $inputText.Length -lt 2){$inputText+=$key.KeyChar}}
            }
            $dirty=$true
        }
    }finally{
        Close-LdcDashboardPoller $poller
        [Console]::ForegroundColor=$fg;[Console]::BackgroundColor=$bg
        try{[Console]::Clear()}catch{}
    }
}

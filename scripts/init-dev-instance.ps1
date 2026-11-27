#Requires -Version 5.1
param([Parameter(Mandatory)][ValidateSet('gui','gemini')][string]$Id)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'management/LDC-Core.ps1')
$branch = git -C $root branch --show-current
$expected = if ($Id -eq 'gui') { 'feature/management-gui' } else { 'feature/gemini-web' }
if ($LASTEXITCODE -ne 0 -or $branch -cne $expected) { throw "请在 $expected 的独立 Git 工作区运行。" }
if (Test-Path -LiteralPath (Join-Path $root 'engine/profile.local.yaml')) { throw '工作区存在托管配置，拒绝初始化测试实例。' }
if ($script:Instance.transport -eq 'local-dev' -and $script:Instance.id -cne $Id) { throw '当前工作区已有其他实例。' }
Invoke-LdcLocked {
    $workspace = Join-Path $root 'engine/workspace'
    Assert-LdcPlainPath $workspace
    $null = [IO.Directory]::CreateDirectory($workspace)
    if (!(Test-Path -LiteralPath $script:RegistryPath)) {
        Write-LdcText $script:RegistryPath ([IO.File]::ReadAllText((Join-Path $root 'management/versions.example.json')))
    }
    $duration = Join-Path $root 'engine/proxy.local.json'
    if (!(Test-Path -LiteralPath $duration)) { Write-LdcJson $duration @{durationSeconds=14400} }
    $allowed = Join-Path $root 'engine/allowed-root.txt'
    if (!(Test-Path -LiteralPath $allowed)) { Write-LdcText $allowed $workspace }
    if ($script:Instance.transport -eq 'openai') {
        Write-LdcJson (Join-Path $root 'management/instance.local.json') @{schema=1;id=$Id;transport='local-dev'}
    }
}
Write-Host "已配置 $Id 本地测试实例。使用根目录的启动、停止及管理 BAT。"

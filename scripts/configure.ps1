param([string]$AuthorizedDirectory,[string]$TunnelId,[ValidateSet('files','terminal')][string]$Mode='files')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'management/LDC-Instance.ps1')
if ((Resolve-LdcInstance $root).transport -eq 'local-dev') { throw '测试实例不接受托管配置。' }
$exe=Join-Path $root 'transports\openai\bin\tunnel-client.exe'
if(@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" | Where-Object ExecutablePath -eq $exe).Count){throw '先停止此部署的隧道，再修改配置。'}

if(!$AuthorizedDirectory){$AuthorizedDirectory=Read-Host '授权目录（本机绝对路径）'}
if(!$TunnelId){$TunnelId=Read-Host '输入已经创建的 Tunnel ID'}
if($TunnelId -notmatch '^tunnel_[a-zA-Z0-9_-]{8,100}$'){throw 'Tunnel ID 格式无效。'}
$dir=& node "$root/engine/stdio.mjs" --check-root $AuthorizedDirectory
if($LASTEXITCODE){throw '授权目录校验失败。'}
if((Read-Host '保存授权范围、模式和现有 Tunnel ID？输入 Y 确认') -ne 'Y'){return}
[IO.File]::WriteAllText("$root/engine/allowed-root.txt",[string]$dir)
$template=[IO.File]::ReadAllText("$root/transports/openai/profile.example.yaml")
[IO.File]::WriteAllText("$root/engine/profile.local.yaml",$template.Replace('TUNNEL_ID_PLACEHOLDER',$TunnelId))
$v=Get-Content "$root/management/versions.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$v.defaults.mode=$Mode
$v|ConvertTo-Json -Depth 6|Set-Content "$root/management/versions.json" -Encoding UTF8
Write-Host '已配置。通过管理菜单 11 设置代理，12 隐藏输入并保存密钥。'

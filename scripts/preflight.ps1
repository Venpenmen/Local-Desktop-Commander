param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
$d=(Resolve-Path -LiteralPath $Destination).Path
foreach($file in 'engine/profile.local.yaml','engine/allowed-root.txt','engine/upstream/dist/index.js','engine/upstream/node_modules/@modelcontextprotocol/sdk/package.json','transports/openai/bin/tunnel-client.exe','management/versions.json'){
 if(!(Test-Path -LiteralPath (Join-Path $d $file) -PathType Leaf)){throw "缺失：$file"}
}
$dir=& node "$d/engine/stdio.mjs" --check-root
if($LASTEXITCODE){throw '授权目录检查失败。'}
Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" | Select-Object ProcessId,CreationDate,ExecutablePath
Write-Host '只读预检完成。核对用户身份及 PID 后，从旧启动窗口停止旧版；确认退出再在新目录双击启动。失败则停止新实例，从旧部署启动，勿并行。'

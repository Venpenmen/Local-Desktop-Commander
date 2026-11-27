param([Parameter(Mandatory)][string]$Destination,[string]$TunnelZip)
$ErrorActionPreference='Stop'
$src=Split-Path -Parent $PSScriptRoot
$d=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $d){
 if(@(Get-ChildItem -LiteralPath $d -Force).Count){throw '部署目录必须是空目录。'}
}
if(!(Test-Path "$src/engine/upstream/dist/index.js")){throw '请先安装并构建源码。'}
$tmp=Join-Path ([IO.Path]::GetTempPath()) ('ldc-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $tmp
try {
 if(!$TunnelZip){
  $TunnelZip=Join-Path $tmp 'tunnel.zip'
  Invoke-WebRequest -UseBasicParsing 'https://github.com/openai/tunnel-client/releases/download/v0.0.21/tunnel-client-v0.0.21-windows-amd64.zip' -OutFile $TunnelZip
 }
 if((Get-FileHash -LiteralPath $TunnelZip).Hash -ne '2FAF80AE62B58485FCEF534CD3F78CD8B82E71CB04D14C2A5C73DBB4EB6C575A'){throw '隧道归档 SHA256 不符。'}
 Expand-Archive -LiteralPath $TunnelZip -DestinationPath "$tmp/tunnel"
 Push-Location $tmp
 try {
  npm.cmd pack @vscode/ripgrep-win32-x64@1.18.0 --ignore-scripts
  if($LASTEXITCODE){throw 'ripgrep 下载失败。'}
  tar -xf vscode-ripgrep-win32-x64-1.18.0.tgz
  if($LASTEXITCODE){throw 'ripgrep 解包失败。'}
 } finally {Pop-Location}
 if((Get-FileHash "$tmp/package/bin/rg.exe").Hash -ne 'F9DDE63498B3193F098355DBEC97AF99DC4F6B8FA0DF5ED04114A03012C042CB'){throw 'ripgrep 二进制 SHA256 不符。'}
 $null=New-Item -ItemType Directory -Force $d,"$d/management","$d/engine/upstream","$d/engine/workspace","$d/engine/ripgrep/bin","$d/transports/openai","$d/scripts","$d/tests"
 Get-ChildItem $src -Filter '*LDC*.bat' | Copy-Item -Destination $d
 Copy-Item "$src/README.md","$src/THIRD_PARTY_NOTICES.md" $d
 Copy-Item "$src/docs" "$d/" -Recurse
 Copy-Item "$src/management/*.ps1" "$d/management/"
 Copy-Item "$src/management/versions.example.json" "$d/management/versions.json"
 Copy-Item "$src/engine/*.ps1","$src/engine/stdio.mjs" "$d/engine/"
 Copy-Item "$src/engine/upstream/package*.json","$src/engine/upstream/LICENSE" "$d/engine/upstream/"
 Copy-Item "$src/engine/upstream/dist" "$d/engine/upstream/" -Recurse
 Copy-Item "$tmp/tunnel" "$d/transports/openai/bin" -Recurse
 Copy-Item "$src/transports/openai/profile.example.yaml" "$d/transports/openai/"
 Copy-Item "$tmp/package/bin/rg.exe" "$d/engine/ripgrep/bin/"
 Copy-Item "$tmp/package/LICENSE" "$d/engine/ripgrep/"
 Copy-Item "$src/scripts/configure.ps1","$src/scripts/verify.ps1","$src/scripts/preflight.ps1" "$d/scripts/"
 Copy-Item "$src/tests/*.mjs" "$d/tests/"
 Push-Location "$d/engine/upstream"
 try {npm.cmd ci --omit=dev --ignore-scripts --no-audit; if($LASTEXITCODE){throw '生产依赖安装失败。'}} finally {Pop-Location}
} finally {
 $resolved=(Resolve-Path -LiteralPath $tmp).Path
 if($resolved -eq $tmp -and (Split-Path -Leaf $resolved) -match '^ldc-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}

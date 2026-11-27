param([Parameter(Mandatory)][string]$Payload,[Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $Payload).Path
$zip=Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path 'LDC-v1.0.0-Windows-x64.zip'
if(Test-Path -LiteralPath $zip){throw 'Output already exists'}
foreach($file in 'engine/upstream/dist/index.js','engine/upstream/node_modules/@modelcontextprotocol/sdk/package.json','transports/openai/bin/tunnel-client.exe','README.md','README.zh-CN.md','LICENSE'){
 if(!(Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)){throw "Missing payload item: $file"}
}
foreach($file in 'engine/profile.local.yaml','engine/allowed-root.txt','engine/runtime','engine/test-runtime','management/runtime','logs'){
 if(Test-Path -LiteralPath (Join-Path $root $file)){throw "Local data in payload: $file"}
}
tar.exe -a -cf $zip --exclude './engine/upstream/node_modules' -C $root .
if($LASTEXITCODE){throw 'ZIP creation failed'}
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  LDC-v1.0.0-Windows-x64.zip" | Set-Content (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ASCII


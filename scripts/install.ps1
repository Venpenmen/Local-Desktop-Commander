$ErrorActionPreference='Stop'
Push-Location (Join-Path $PSScriptRoot '../engine/upstream')
try {
 npm.cmd ci --ignore-scripts --no-audit
 if($LASTEXITCODE){throw '依赖安装失败。'}
} finally {Pop-Location}


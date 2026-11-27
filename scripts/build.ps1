$ErrorActionPreference='Stop'
Push-Location (Join-Path $PSScriptRoot '../engine/upstream')
try {
 npm.cmd run build
 if($LASTEXITCODE){throw '构建失败。'}
} finally {Pop-Location}


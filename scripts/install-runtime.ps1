$ErrorActionPreference='Stop'
Push-Location (Join-Path $PSScriptRoot '../engine/upstream')
try {
 npm.cmd ci --omit=dev --ignore-scripts --no-audit
 if($LASTEXITCODE){throw 'Production dependency installation failed'}
} finally {Pop-Location}

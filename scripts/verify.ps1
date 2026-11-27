$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(Test-Path "$root/engine/profile.local.yaml"){throw '请使用未配置真实 profile 的隔离副本运行测试。'}
& node "$root/tests/p6-smoke.mjs"
exit $LASTEXITCODE

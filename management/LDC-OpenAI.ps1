$script:LdcOpenAiHelper = Join-Path $PSScriptRoot 'LDC-Stable.ps1'

function Get-LdcOpenAiSettings {
    . $script:LdcOpenAiHelper
    Assert-StorePath
    $proxy = $null
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        $stored = Read-LdcJson $config
        $proxy = Convert-LocalProxy ([string]$stored.proxy)
    }
    @{proxy=$proxy; credentialConfigured=(Test-Path -LiteralPath $cred -PathType Leaf)}
}

function Set-LdcOpenAiProxy($Proxy) {
    . $script:LdcOpenAiHelper
    Assert-StorePath
    if ($null -eq $Proxy) {
        [IO.File]::Delete($config)
        return
    }
    if ($Proxy -isnot [string]) { throw 'INVALID_ARGUMENT' }
    $normalized = Convert-LocalProxy $Proxy
    if (!$normalized) { throw 'INVALID_ARGUMENT' }
    Save-StoreText $config (@{proxy=$normalized} | ConvertTo-Json -Compress)
}

function Get-LdcOpenAiDiagnosis {
    . $script:LdcOpenAiHelper
    Assert-StorePath
    try {
        $route = Get-ProxyChoice
        @{reachable=$true; route=$route}
    } catch {
        @{reachable=$false; route=$null}
    }
}

function Get-LdcOpenAiDescriptor($Health) {
    @{
        id='openai'; name='OpenAI Secure MCP Tunnel'; contract=1; version='0.0.21'; type='tunnel'; engineProtocol='mcp-stdio'
        configuration=@{proxy=@{type='loopback-http-or-null'}}
        credentials=@{type='windows-dpapi'; configured=(Get-LdcOpenAiSettings).credentialConfigured}
        capabilities=@('start','stop','health','diagnose','logs','events')
        health=$Health; connection=$Health.Control
    }
}

function Invoke-LdcOpenAiLaunch($Version,[string]$RunMode) {
    $saved = @{}
    foreach ($name in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','CONTROL_PLANE_HTTP_PROXY','CONTROL_PLANE_API_KEY') {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    }
    try {
        & $script:LdcOpenAiHelper -Action Prepare
        $global:LASTEXITCODE = 0
        if ($RunMode -eq 'terminal') { & $Version.Launcher -Action Start -Terminal }
        else { & $Version.Launcher -Action Start }
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    }
}

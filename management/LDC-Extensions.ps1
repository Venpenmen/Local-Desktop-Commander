function Read-LdcExtensionManifest {
    param([string]$Path,[string]$Origin)
    $manifest = Read-LdcJson $Path
    if (!$manifest -or $manifest.schema -ne 1 -or $manifest.id -cnotmatch '^[a-z][a-z0-9-]{1,63}$' -or
        $manifest.version -cnotmatch '^\d+\.\d+\.\d+$' -or $manifest.type -notin 'transport','tool' -or
        $manifest.name -isnot [string] -or $manifest.name -cnotmatch '^[^\p{C}]{1,80}$' -or $manifest.management -ne 1 -or
        $manifest.core -ne 'mcp-stdio' -or $manifest.entry -cnotmatch '^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*(\.[a-zA-Z0-9]+)?$') {
        throw 'INVALID_MANIFEST'
    }
    foreach ($field in 'dependencies','permissions','capabilities','health','lifecycle') {
        if ($manifest.$field -isnot [array]) { throw 'INVALID_MANIFEST' }
        foreach ($item in $manifest.$field) {
            if ($item -isnot [string] -or $item -cnotmatch '^[a-z][a-z0-9.-]{0,63}$') { throw 'INVALID_MANIFEST' }
        }
    }
    if ($manifest.configuration -isnot [System.Management.Automation.PSCustomObject]) { throw 'INVALID_MANIFEST' }
    [pscustomobject]@{id=$manifest.id;name=$manifest.name;version=$manifest.version;type=$manifest.type
        management=1;core=$manifest.core;entry=$manifest.entry;dependencies=$manifest.dependencies
        permissions=$manifest.permissions;capabilities=$manifest.capabilities;configuration=$manifest.configuration
        health=$manifest.health;lifecycle=$manifest.lifecycle;origin=$Origin;executable=$Origin -eq 'builtin'}
}

function Get-LdcExtensions {
    $path = Join-Path $script:Project 'transports/openai/manifest.json'
    Read-LdcExtensionManifest $path 'builtin'
}

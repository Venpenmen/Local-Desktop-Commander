function Resolve-LdcInstance([string]$Project) {
    $base = [IO.Path]::GetFullPath($Project).TrimEnd('\')
    for ($cursor = $base; $cursor; $cursor = Split-Path -Parent $cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '实例目录不得经过重解析路径。'
        }
    }
    $marker = Join-Path $base 'management/instance.local.json'
    foreach ($path in (Split-Path -Parent $marker),$marker) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '实例配置不得使用重解析路径。'
        }
    }
    $id = 'hosted'
    $transport = 'openai'
    if (Test-Path -LiteralPath $marker) {
        $record = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
        if ($record.schema -ne 1 -or $record.id -cnotmatch '^[a-z][a-z0-9-]{1,31}$' -or
            $record.id -eq 'hosted' -or $record.transport -cne 'local-dev') { throw '实例配置无效。' }
        $id = $record.id
        $transport = 'local-dev'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($base.ToLowerInvariant()))).Replace('-','').Substring(0,24).ToLowerInvariant()
    } finally { $sha.Dispose() }
    [pscustomobject]@{id=$id; key="$id-$hash"; transport=$transport; temporary=(Join-Path $base 'management/runtime/temp')}
}

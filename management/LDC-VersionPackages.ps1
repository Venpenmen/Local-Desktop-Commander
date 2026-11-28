# B5-CORE: trusted, offline, content-hashed version packages.
# The management protocol is the only write authority for version registry and managed dirs.
function Assert-LdcPackagePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or ![IO.Path]::IsPathRooted($Path)) { throw 'INVALID_ARGUMENT' }
    $full = [IO.Path]::GetFullPath($Path)
    if (!(Test-Path -LiteralPath $full -PathType Leaf)) { throw 'INVALID_PACKAGE' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'INVALID_PACKAGE' }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    if ([IO.Path]::GetExtension($full) -cne '.zip') { throw 'INVALID_PACKAGE' }
    $length = ([IO.FileInfo]::new($full)).Length
    if ($length -lt 1 -or $length -gt 2147483648L) { throw 'INVALID_PACKAGE' }
    return $full
}
function Get-LdcHashFile([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $file = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try { return [BitConverter]::ToString($sha.ComputeHash($file)).Replace('-','').ToLowerInvariant() }
        finally { $file.Dispose() }
    } finally { $sha.Dispose() }
}
function Read-LdcVersionPackage([string]$PackagePath,[string]$ExpectedSha256) {
    $path = Assert-LdcPackagePath $PackagePath
    if ($ExpectedSha256 -cnotmatch '^[0-9a-fA-F]{64}$') { throw 'INVALID_ARGUMENT' }
    $digest = Get-LdcHashFile $path
    if ($digest -cne $ExpectedSha256.ToLowerInvariant()) { throw 'PACKAGE_HASH_MISMATCH' }
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $zip = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read)
        try {
            $list = @($zip.Entries)
            if ($list.Count -lt 2 -or $list.Count -gt 2000) { throw 'INVALID_PACKAGE' }
            $paths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            $bytes = [long]0
            $manifestEntry = $null
            foreach ($entry in $list) {
                $name = [string]$entry.FullName
                $normalized = $name.Replace([char]92,'/')
                if ($normalized.Length -lt 1 -or $normalized.Length -gt 240 -or
                    $normalized.StartsWith('/') -or $normalized.Contains(':') -or
                    $normalized.IndexOf([char]0) -ge 0 -or
                    @($normalized.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -gt 0 -or
                    !$paths.Add($normalized.TrimEnd('/'))) { throw 'INVALID_PACKAGE' }
                if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'INVALID_PACKAGE' }
                if ([long]$entry.Length -lt 0) { throw 'INVALID_PACKAGE' }
                $bytes += [long]$entry.Length
                if ($bytes -gt 4294967296L -or ([long]$entry.CompressedLength -gt 0 -and
                    [long]$entry.Length -gt [long]$entry.CompressedLength * 1500L)) { throw 'INVALID_PACKAGE' }
                if ($normalized -ceq 'ldc-package.json') { $manifestEntry = $entry }
            }
            if (!$manifestEntry -or $manifestEntry.Length -gt 16384 -or $manifestEntry.Length -lt 10) { throw 'INVALID_PACKAGE' }
            $reader = New-Object IO.StreamReader($manifestEntry.Open(),[Text.Encoding]::UTF8)
            try { $raw = $reader.ReadToEnd() } finally { $reader.Dispose() }
            try { $manifest = $raw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'INVALID_PACKAGE' }
            if ($manifest.schema -cne 1 -or $manifest.id -cnotmatch '^[a-z][a-z0-9-]{1,30}$' -or
                $manifest.id -eq 'p6' -or $manifest.directory -cne ('versions/' + $manifest.id) -or
                $manifest.runtime -cne 'runtime' -or $manifest.launcher -cne 'LocalDC.ps1' -or
                $manifest.build -cne 'upstream/dist/index.js' -or
                $manifest.rootConfig -cne 'allowed-root.txt' -or
                $manifest.rootValidator -cne 'stdio.mjs' -or
                $manifest.profile -cne 'profile.local.yaml' -or
                $manifest.filesTools -ne 14 -or $manifest.terminalTools -ne 21 -or
                [string]$manifest.label -notmatch '^.{1,80}$' -or
                @($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 1000) { throw 'INVALID_PACKAGE' }
            $fileNames = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            foreach ($file in @($manifest.files)) {
                if ($file.path -cnotmatch '^[a-zA-Z0-9._/-]{1,220}$' -or
                    $file.path.StartsWith('/') -or @($file.path.Split('/') | Where-Object { $_ -in '.','..' }).Count -gt 0 -or
                    !$fileNames.Add([string]$file.path) -or
                    $file.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
                    !$paths.Contains([string]$file.path)) { throw 'INVALID_PACKAGE' }
            }
            foreach ($entry in $list) {
                if ($entry.FullName.EndsWith('/')) { continue }
                if ($entry.FullName.Replace([char]92,'/') -cne 'ldc-package.json' -and !$fileNames.Contains($entry.FullName.Replace([char]92,'/'))) { throw 'INVALID_PACKAGE' }
            }
            foreach ($required in @('LocalDC.ps1','stdio.mjs','upstream/dist/index.js')) {
                if (!$fileNames.Contains($required)) { throw 'INVALID_PACKAGE' }
            }
            return @{path=$path;sha256=$digest;manifest=$manifest;manifestText=$raw
                manifestSha256=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))).Replace('-','').ToLowerInvariant())
                entries=$list.Count;bytes=$bytes}
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}
function Install-LdcVersionPackage($Arguments) {
    if ($Arguments.path -isnot [string] -or $Arguments.sha256 -isnot [string]) { throw 'INVALID_ARGUMENT' }
    $verified = Read-LdcVersionPackage $Arguments.path $Arguments.sha256
    $manifest = $verified.manifest
    if ($script:Versions.ContainsKey($manifest.id)) { throw 'VERSION_EXISTS' }
    $observation = Get-LdcObservation
    if ($observation.State -eq 'unsafe') { throw 'ACCESS_BUSY' }
    $parent = Join-Path $script:Project 'versions'
    Assert-LdcPlainPath $parent
    if (!(Test-Path -LiteralPath $parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $dest = Join-Path $parent ([string]$manifest.id)
    $stage = Join-Path $parent ('.ldc-staging-' + [guid]::NewGuid().ToString('N'))
    Assert-LdcPlainPath $dest
    Assert-LdcPlainPath $stage
    if (Test-Path -LiteralPath $dest) { throw 'VERSION_EXISTS' }
    $installed = $false
    $registryWritten = $false
    $originalRegistry = [IO.File]::ReadAllText($script:RegistryPath)
    try {
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $stream = [IO.File]::Open($verified.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try {
            $zip = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read)
            try {
                foreach ($file in @($manifest.files)) {
                    $entry = @($zip.Entries | Where-Object { $_.FullName.Replace([char]92,'/') -ceq [string]$file.path }) | Select-Object -First 1
                    if (!$entry) { throw 'INVALID_PACKAGE' }
                    $full = Join-LdcPath $stage ([string]$file.path)
                    [IO.Directory]::CreateDirectory((Split-Path -Parent $full)) | Out-Null
                    $read = $entry.Open()
                    try {
                        $output = [IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                        try { $read.CopyTo($output) } finally { $output.Dispose() }
                    } finally { $read.Dispose() }
                    if ((Get-LdcHashFile $full) -cne [string]$file.sha256) { throw 'PACKAGE_HASH_MISMATCH' }
                }
            } finally { $zip.Dispose() }
        } finally { $stream.Dispose() }
        # Save the immutable package manifest for subsequent read-only verification.
        $savedManifest = Join-Path $stage 'ldc-package.json'
        [IO.File]::WriteAllText($savedManifest,$verified.manifestText,$script:Utf8)
        if (Test-Path -LiteralPath $dest) { throw 'VERSION_EXISTS' }
        [IO.Directory]::Move($stage,$dest)
        $installed = $true
        $reg = Read-LdcJson $script:RegistryPath
        if (@($reg.versions | Where-Object { $_.id -eq $manifest.id }).Count -gt 0) { throw 'VERSION_EXISTS' }
        $row = [ordered]@{id=$manifest.id; label=$manifest.label; status='installed-verified'
            directory=$manifest.directory; launcher=$manifest.launcher; profile=$manifest.profile
            runtime=$manifest.runtime; build=$manifest.build; rootConfig=$manifest.rootConfig
            rootValidator=$manifest.rootValidator; fixedRoot=$manifest.directory
            filesTools=14;terminalTools=21
            manifestSha256=$verified.manifestSha256;packageSha256=$verified.sha256}
        $reg.versions = @($reg.versions) + @($row)
        Write-LdcJson $script:RegistryPath $reg
        $registryWritten = $true
        Initialize-LdcRegistry
        Write-LdcEvent 'version-installed' $manifest.id 'files'
        return @{id=$manifest.id; sha256=$verified.sha256; fileCount=@($manifest.files).Count
            registered=$true; state='completed'}
    } catch {
        if ($registryWritten) {
            try {
                Write-LdcText $script:RegistryPath $originalRegistry
                Initialize-LdcRegistry
            } catch { throw 'RECOVERY_FAILED' }
        }
        $registered = @((Read-LdcJson $script:RegistryPath).versions | Where-Object { $_.id -eq $manifest.id }).Count -gt 0
        if ($installed -and !$registered -and (Test-Path -LiteralPath $dest) -and
            (Get-LdcObservation).Version.Id -ne $manifest.id) {
            try {
                Assert-LdcSafeManagedTree $dest
                [IO.Directory]::Delete($dest,$true)
            } catch { throw 'RECOVERY_FAILED' }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $stage) { [IO.Directory]::Delete($stage,$true) }
    }
}

function Get-LdcManagedVersionRow([string]$Id) {
    if ($Id -cnotmatch '^[a-z][a-z0-9-]{1,30}$') { throw 'INVALID_ARGUMENT' }
    $registry = Read-LdcJson $script:RegistryPath
    $rows = @($registry.versions | Where-Object { $_.id -ceq $Id })
    if ($rows.Count -ne 1) { throw 'INVALID_ARGUMENT' }
    $row = $rows[0]
    if ($row.status -cne 'installed-verified' -or
        $row.directory -cne ('versions/' + $Id) -or
        $row.manifestSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'VERSION_PROTECTED'
    }
    return $row
}
function Test-LdcVersionIntegrity([string]$Id) {
    if ($Id -cnotmatch '^[a-z][a-z0-9-]{1,30}$') { throw 'INVALID_ARGUMENT' }
    $registry = Read-LdcJson $script:RegistryPath
    $row = @($registry.versions | Where-Object { $_.id -ceq $Id })
    if ($row.Count -ne 1) { throw 'INVALID_ARGUMENT' }
    if ($row[0].status -cne 'installed-verified') {
        return @{id=$Id; status='unmanaged';verified=$false;reason='legacy version without pinned package manifest'}
    }
    $record = Get-LdcManagedVersionRow $Id
    $folder = Join-LdcPath $script:Project ('versions/' + $Id)
    $metadata = Join-LdcPath $folder 'ldc-package.json'
    Assert-LdcPlainPath $metadata
    if (!(Test-Path -LiteralPath $metadata -PathType Leaf)) {
        return @{id=$Id;status='modified';verified=$false;reason='missing immutable manifest'}
    }
    if ((Get-LdcHashFile $metadata) -cne [string]$record.manifestSha256) {
        return @{id=$Id;status='modified';verified=$false;reason='manifest digest mismatch'}
    }
    $manifest = Read-LdcJson $metadata
    if ($manifest.id -cne $Id -or $manifest.directory -cne ('versions/' + $Id) -or
        @($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 1000) {
        return @{id=$Id;status='modified';verified=$false;reason='manifest identity invalid'}
    }
    $verifiedCount = 0
    $mutable = @('allowed-root.txt','access-mode.txt','profile.local.yaml','proxy.local.json')
    foreach ($entry in @($manifest.files)) {
        if ($entry.path -cnotmatch '^[a-zA-Z0-9._/-]{1,220}$' -or
            $entry.path.StartsWith('/') -or
            @($entry.path.Split('/') | Where-Object { $_ -in '.','..' }).Count -ne 0 -or
            $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
            return @{id=$Id;status='modified';verified=$false;reason='manifest payload invalid'}
        }
        # Mutable settings intentionally excluded: legitimate root/access changes do not imply a tampered engine.
        if ($entry.path -in $mutable) { continue }
        $file = Join-LdcPath $folder ([string]$entry.path)
        try {
            Assert-LdcPlainPath $file
            if (!(Test-Path -LiteralPath $file -PathType Leaf) -or
                (Get-LdcHashFile $file) -cne [string]$entry.sha256) {
                return @{id=$Id;status='modified';verified=$false;reason='installed immutable payload changed'}
            }
        } catch {
            return @{id=$Id;status='modified';verified=$false;reason='installed payload unreadable'}
        }
        $verifiedCount++
    }
    if ($verifiedCount -lt 3) {
        return @{id=$Id;status='modified';verified=$false;reason='missing required immutable files'}
    }
    return @{id=$Id;status='verified';verified=$true;files=$verifiedCount
        reason='immutable payload matches pinned manifest; mutable configuration excluded'}
}
function Assert-LdcSafeManagedTree([string]$Directory) {
    Assert-LdcPlainPath $Directory
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) { throw 'VERSION_PROTECTED' }
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($Directory)
    $count = 0
    while ($queue.Count) {
        $current = $queue.Dequeue()
        foreach ($item in (Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
            $count++
            if ($count -gt 10000 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'VERSION_PROTECTED'
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
        }
    }
}
function Remove-LdcVersionPackage([string]$Id) {
    $row = Get-LdcManagedVersionRow $Id
    $selection = Get-LdcSelection
    if ($selection.target.version -eq $Id -or $selection.rollback.version -eq $Id -or
        $script:Registry.defaults.version -eq $Id -or $script:Registry.rollback.version -eq $Id) {
        throw 'VERSION_PROTECTED'
    }
    $observation = Get-LdcObservation
    if ($observation.State -ne 'stopped' -and
        (!$observation.Version -or $observation.Version.Id -eq $Id)) {
        throw 'VERSION_PROTECTED'
    }
    $pending = Read-LdcJson $script:PendingPath
    if ($pending.version -eq $Id -and (Test-LdcPending $pending)) { throw 'VERSION_PROTECTED' }
    $dir = Join-LdcPath $script:Project ('versions/' + $Id)
    Assert-LdcSafeManagedTree $dir
    $registry = Read-LdcJson $script:RegistryPath
    $retained = @($registry.versions | Where-Object { $_.id -cne $Id })
    if ($retained.Count -ne @($registry.versions).Count - 1) { throw 'VERSION_PROTECTED' }
    $quarantine = Join-LdcPath $script:Project ('versions/.ldc-delete-' + [guid]::NewGuid().ToString('N'))
    Assert-LdcPlainPath $quarantine
    $originalRegistry = [IO.File]::ReadAllText($script:RegistryPath)
    [IO.Directory]::Move($dir,$quarantine)
    $writeAttempted = $false
    try {
        $registry.versions = $retained
        $writeAttempted = $true
        Write-LdcJson $script:RegistryPath $registry
        Initialize-LdcRegistry
    } catch {
        try {
            if ($writeAttempted) {
                Write-LdcText $script:RegistryPath $originalRegistry
                Initialize-LdcRegistry
            }
            if (Test-Path -LiteralPath $quarantine) { [IO.Directory]::Move($quarantine,$dir) }
        } catch { throw 'RECOVERY_FAILED' }
        throw
    }
    # A failed quarantine cleanup leaves isolated bytes, not a registered runnable version.
    $cleanupPending = $false
    try {
        Assert-LdcSafeManagedTree $quarantine
        [IO.Directory]::Delete($quarantine,$true)
    } catch { $cleanupPending = $true }
    Write-LdcEvent 'version-removed' $Id 'files'
    return @{id=$Id;state='completed';registered=$false;cleanupPending=$cleanupPending}
}

function Test-LdcReadyVersion($Observation,[string]$Id,[string]$Mode) {
    if (!$Observation -or $Observation.State -ne 'running' -or !$Observation.Version -or
        $Observation.Version.Id -ne $Id -or $Observation.Mode -ne $Mode -or
        !$Observation.Health -or $Observation.Health.Health -ne 200 -or
        $Observation.Health.Ready -ne 200 -or !$Observation.Health.Complete) { return $false }
    $expected = if ($Mode -eq 'terminal') { $Observation.Version.TerminalTools } else { $Observation.Version.FilesTools }
    return ($Observation.Health.Tools -eq $expected)
}
function Wait-LdcVerifiedVersion([string]$Id,[string]$Mode,[int]$Seconds=28) {
    $deadline=[datetime]::UtcNow.AddSeconds($Seconds)
    do {
        $seen=Get-LdcObservation -IncludeHealth
        if (Test-LdcReadyVersion $seen $Id $Mode) { return $seen }
        if ($seen.State -eq 'unsafe') { return $null }
        Start-Sleep -Milliseconds 450
    } while ([datetime]::UtcNow -lt $deadline)
    return $null
}
function Invoke-LdcManagedActivation($Arguments) {
    if ($Arguments.version -isnot [string] -or !$script:Versions.ContainsKey([string]$Arguments.version) -or
        $Arguments.mode -cnotin 'files','terminal') { throw 'INVALID_ARGUMENT' }
    $targetId=[string]$Arguments.version
    $targetMode=[string]$Arguments.mode
    $old=Get-LdcObservation -IncludeHealth
    $selection=Get-LdcSelection
    if (!$old -or $old.State -ne 'running' -or !$old.Version -or
        $old.Version.Id -ne $selection.target.version -or $old.Mode -ne $selection.target.mode -or
        !(Test-LdcReadyVersion $old $old.Version.Id $old.Mode)) {
        throw 'ACCESS_BUSY'
    }
    if ($targetId -eq $old.Version.Id -and $targetMode -eq $old.Mode) { throw 'INVALID_ARGUMENT' }
    if ($targetId -ne 'p6') {
        $integrity=Test-LdcVersionIntegrity $targetId
        if (!$integrity.verified) { throw 'VERSION_UNVERIFIED' }
    }
    $previous=[pscustomobject]@{version=[string]$old.Version.Id;mode=[string]$old.Mode}
    $startPid=$old.Pid
    $changed=$false
    try {
        $changed=$true
        $code=Invoke-LdcChange ([pscustomobject]@{version=$targetId;mode=$targetMode}) 'select'
        if ($code -ne 0) { throw 'VERSION_START_FAILED' }
        $new=Wait-LdcVerifiedVersion $targetId $targetMode
        if (!$new) { throw 'VERSION_NOT_READY' }
        return @{state='completed'; from=$previous.version; to=$targetId; mode=$targetMode
            ready=$true;tools=$new.Health.Tools;previousPid=$startPid;pid=$new.Pid}
    } catch {
        if (!$changed) { throw }
        $failed=$_.Exception.Message
        try {
            $current=Get-LdcObservation
            if ($current.State -eq 'unsafe') { throw 'unsafe PID ownership prevents automatic recovery' }
            $rollback=Invoke-LdcChange $previous 'rollback'
            if ($rollback -ne 0) { throw 'rollback launch failed' }
            $restored=Wait-LdcVerifiedVersion $previous.version $previous.mode
            if (!$restored) { throw 'rollback service not MCP-ready' }
            Write-LdcEvent 'version-recovered' $previous.version $previous.mode $restored.Pid
            throw 'UPGRADE_ROLLED_BACK'
        } catch {
            if ($_.Exception.Message -eq 'UPGRADE_ROLLED_BACK') { throw }
            Write-LdcEvent 'version-recovery-failed' $previous.version $previous.mode 0 1
            throw 'RECOVERY_FAILED'
        }
    }
}

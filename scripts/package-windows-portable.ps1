param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$BinaryPath = 'src-tauri/target/release/llm-client.exe',
    [string]$OutputDirectory = 'portable'
)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskReleaseConfig = Get-Content -LiteralPath (Join-Path $taskRepoRoot 'src-tauri/tauri.release.conf.json') -Raw | ConvertFrom-Json
$taskResolvedBinary = if ([IO.Path]::IsPathRooted($BinaryPath)) { $BinaryPath } else { Join-Path $taskRepoRoot $BinaryPath }
$taskFiles = [ordered]@{ 'llm-client.exe' = [IO.Path]::GetFullPath($taskResolvedBinary) }

# Keep the portable layout identical to the installed Windows application.
# Include every configured resource, including the generated license inventory.
foreach ($taskResource in $taskReleaseConfig.bundle.resources) {
    if ($taskResource -notmatch '^resources/[\w.-]+$') {
        throw "Unsupported portable resource path: $taskResource"
    }
    $taskFiles[$taskResource] = Join-Path $taskRepoRoot "src-tauri/$taskResource"
}
foreach ($taskRequired in @('resources/models-cache.json', 'resources/spine-builder.html', 'resources/LICENSE', 'resources/NOTICE', 'resources/THIRD_PARTY_LICENSES.md')) {
    if (-not $taskFiles.Contains($taskRequired)) { throw "Portable resource is not configured: $taskRequired" }
}
foreach ($taskSource in $taskFiles.Values) {
    if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) { throw "Portable input is missing: $taskSource" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid portable package version: $Version"
}

$taskResolvedOutput = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $taskRepoRoot $OutputDirectory }
$taskOutputRoot = [IO.Path]::GetFullPath($taskResolvedOutput)
New-Item -ItemType Directory -Force -Path $taskOutputRoot | Out-Null
$taskArchivePath = Join-Path $taskOutputRoot "lc_${Version}_windows_x64-portable.zip"
$taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$taskStage = Join-Path $taskTempRoot ('lc-windows-portable-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskStage | Out-Null

try {
    foreach ($taskEntry in $taskFiles.GetEnumerator()) {
        $taskDestination = Join-Path $taskStage $taskEntry.Key
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDestination) | Out-Null
        Copy-Item -LiteralPath $taskEntry.Value -Destination $taskDestination
    }
    Compress-Archive -Path (Join-Path $taskStage '*') -DestinationPath $taskArchivePath -Force

    # Inspect the archive itself: source staging checks alone cannot catch a
    # ZIP with the wrong directory layout or incomplete resource contents.
    $taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchivePath)
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try {
        if ($taskZip.Entries.Count -ne $taskFiles.Count) { throw 'Unexpected portable ZIP entries' }
        foreach ($taskEntry in $taskFiles.GetEnumerator()) {
            $taskZipEntry = $taskZip.GetEntry($taskEntry.Key)
            if ($null -eq $taskZipEntry) { throw "Portable ZIP entry is missing: $($taskEntry.Key)" }
            $taskSourceStream = [IO.File]::OpenRead($taskEntry.Value)
            $taskZipStream = $taskZipEntry.Open()
            try {
                $taskSourceHash = [Convert]::ToHexString($taskHasher.ComputeHash($taskSourceStream))
                $taskZipHash = [Convert]::ToHexString($taskHasher.ComputeHash($taskZipStream))
                if ($taskSourceHash -ne $taskZipHash) { throw "Portable ZIP contents differ: $($taskEntry.Key)" }
            } finally {
                $taskSourceStream.Dispose()
                $taskZipStream.Dispose()
            }
        }
    } finally {
        $taskHasher.Dispose()
        $taskZip.Dispose()
    }
    Write-Output "Verified portable archive: $taskArchivePath"
} finally {
    # Delete only this invocation's newly created temporary staging directory.
    $taskResolvedStage = [IO.Path]::GetFullPath($taskStage)
    $taskTempPrefix = $taskTempRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $taskResolvedStage.StartsWith($taskTempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $taskResolvedStage) -notmatch '^lc-windows-portable-[a-f0-9]{32}$') {
        throw "Refusing to remove an unexpected staging directory: $taskResolvedStage"
    }
    Remove-Item -LiteralPath $taskResolvedStage -Recurse -Force
}

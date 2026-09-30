$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$lock = Get-Content (Join-Path $projectRoot 'dependencies.lock.json') -Raw | ConvertFrom-Json
function Invoke-GitChecked([string[]] $Arguments) {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $($Arguments -join ' ')" }
}
foreach ($dependency in $lock.dependencies) {
    $destination = Join-Path $projectRoot $dependency.path
    if ((Test-Path $destination) -and !(Test-Path (Join-Path $destination '.git')) -and (Test-Path (Join-Path $projectRoot 'vendor-manifest.json'))) {
        $manifest = Get-Content (Join-Path $projectRoot 'vendor-manifest.json') -Raw | ConvertFrom-Json
        $entries = @($manifest | Where-Object { $_.path.StartsWith($dependency.path + '/') })
        if (!$entries.Count) { throw "Missing source manifest entries: $destination" }
        foreach ($entry in $entries) {
            $sourceFile = Join-Path $projectRoot $entry.path
            if (!(Test-Path $sourceFile) -or (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash -ne $entry.sha256) {
                throw "Source integrity check failed: $sourceFile"
            }
        }
        Write-Host "Verified bundled sources: $($dependency.name)"
        continue
    }
    if (Test-Path (Join-Path $destination '.git')) {
        $head = & git -C $destination rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or $head -ne $dependency.commit) { throw "Unexpected dependency revision: $destination" }
        Write-Host "Verified $($dependency.name): $head"
        continue
    }
    if ((Test-Path $destination) -and (Get-ChildItem -Force $destination | Select-Object -First 1)) {
        throw "Refusing to overwrite non-empty directory: $destination"
    }
    New-Item -ItemType Directory -Force $destination | Out-Null
    Invoke-GitChecked @('init', $destination)
    Invoke-GitChecked @('-C', $destination, 'remote', 'add', 'origin', $dependency.repository)
    Invoke-GitChecked @('-C', $destination, 'fetch', '--depth', '1', 'origin', $dependency.commit)
    Invoke-GitChecked @('-C', $destination, 'checkout', '--detach', 'FETCH_HEAD')
}

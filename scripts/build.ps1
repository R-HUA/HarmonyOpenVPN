param([switch]$Clean)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$env:DEVECO_CLI_CLT_PATH) { $env:DEVECO_CLI_CLT_PATH = 'C:\Program Files\command-line-tools' }
$sdkFile = Join-Path $env:DEVECO_CLI_CLT_PATH 'sdk/default/sdk-pkg.json'
if (!(Test-Path $sdkFile)) { throw "SDK not found under DEVECO_CLI_CLT_PATH=$env:DEVECO_CLI_CLT_PATH" }
& (Join-Path $PSScriptRoot 'bootstrap.ps1')
Push-Location $projectRoot
try {
    $nodePath = Join-Path $env:DEVECO_CLI_CLT_PATH 'tool/node/node.exe'
    & $nodePath tests/profile.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Profile regression tests failed' }
    & $nodePath tests/lifecycle.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Lifecycle regression tests failed' }
    & $nodePath tests/usability.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Usability regression tests failed' }
    & $nodePath tests/native-config-contract.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Native config contract failed' }
    & $nodePath tests/network-monitor.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Network monitor regression failed' }
    & $nodePath tests/handover-retry.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Handover retry regression failed' }
    if ($Clean) {
        devecocli build clean
        if ($LASTEXITCODE -ne 0) { throw 'CLT clean failed' }
    }
    devecocli build --build-mode debug
    if ($LASTEXITCODE -ne 0) { throw 'CLT build failed' }
    Write-Host 'Unsigned HAP: entry/build/default/outputs/default/entry-default-unsigned.hap'
} finally { Pop-Location }

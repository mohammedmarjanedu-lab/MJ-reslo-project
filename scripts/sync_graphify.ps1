param(
    [switch] $ForceFull,
    [switch] $Verbose,
    [string] $RepoRoot = "."
)

$repoRoot = (Resolve-Path $RepoRoot).Path
$graphifyDir = Join-Path $repoRoot "graphify-out"
$manifestPath = Join-Path $graphifyDir "manifest.json"

if (-not (Test-Path $manifestPath)) {
    Write-Host "[ERROR] Manifest not found at $manifestPath." -ForegroundColor Red
    exit 1
}

Write-Host "[STEP] Reading manifest..." -ForegroundColor Green
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$changedFiles = @()
$allFiles = @()

foreach ($prop in $manifest.PSObject.Properties) {
    $relPath = $prop.Name
    $fullPath = Join-Path $repoRoot $relPath
    $allFiles += $relPath

    if (-not (Test-Path $fullPath)) {
        $changedFiles += $relPath
    } else {
        $hash = (Get-FileHash -Path $fullPath -Algorithm SHA256).Hash.ToLower()
        $astHash = $prop.Value.ast_hash
        if ($hash -ne $astHash) {
            $changedFiles += $relPath
        }
    }
}

if ($ForceFull) {
    Write-Host "[WARN] ForceFull specified - updating all manifest hashes..." -ForegroundColor Yellow
    $changedFiles = $allFiles
}

Write-Host "[INFO] Total files tracked: $($allFiles.Count)" -ForegroundColor Green
Write-Host "[INFO] Changed files count: $($changedFiles.Count)" -ForegroundColor Green

Write-Host "[STEP] Updating graphify manifest hashes..." -ForegroundColor Green
$newManifest = @{}
foreach ($relPath in $allFiles) {
    $fullPath = Join-Path $repoRoot $relPath
    if (Test-Path $fullPath) {
        $currentHash = (Get-FileHash -Path $fullPath -Algorithm SHA256).Hash.ToLower()
        $newManifest[$relPath] = @{
            mtime = (Get-Item $fullPath).LastWriteTimeUtc.ToString('o')
            ast_hash = $currentHash
            semantic_hash = $currentHash
        }
    }
}
$newManifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding utf8

Write-Host "[OK] Graphify sync complete. Output in $graphifyDir" -ForegroundColor Green
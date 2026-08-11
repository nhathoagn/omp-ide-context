[CmdletBinding()]
param(
    [string]$Archive
)

$ErrorActionPreference = "Stop"

$repository = "nhathoagn/omp-ide-context"
$archiveName = "omp-ide-context.tar.gz"
$installDir = if ($env:OMP_IDE_CONTEXT_INSTALL_DIR) {
    $env:OMP_IDE_CONTEXT_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA "omp-ide-context"
}
$ompExtensionDir = if ($env:OMP_IDE_CONTEXT_EXTENSION_DIR) {
    $env:OMP_IDE_CONTEXT_EXTENSION_DIR
} else {
    Join-Path $env:USERPROFILE ".omp\agent\extensions"
}

if ($Archive -and -not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "Release archive not found: $Archive"
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    throw "Missing VS Code's 'code' command. In VS Code, run: Shell Command: Install 'code' command in PATH"
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    if (-not $Archive) {
        $Archive = Join-Path $tempDir $archiveName
        Write-Host "Downloading OMP IDE Context…"
        Invoke-WebRequest -Uri "https://github.com/$repository/releases/latest/download/$archiveName" -OutFile $Archive
    }

    tar -xzf $Archive -C $tempDir

    $ompExtension = Join-Path $tempDir "omp-extension"
    $vsix = Join-Path $tempDir "vscode-extension\omp-ide-context-vscode.vsix"
    if (-not (Test-Path -LiteralPath (Join-Path $ompExtension "package.json") -PathType Leaf) -or -not (Test-Path -LiteralPath $vsix -PathType Leaf)) {
        throw "Release archive is incomplete; refusing to install it."
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installDir), $ompExtensionDir | Out-Null
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $tempDir -Destination $installDir
    $tempDir = $null

    $linkPath = Join-Path $ompExtensionDir "omp-safe-ide-context"
    Remove-Item -LiteralPath $linkPath -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Junction -Path $linkPath -Target (Join-Path $installDir "omp-extension") | Out-Null

    & code --install-extension (Join-Path $installDir "vscode-extension\omp-ide-context-vscode.vsix") --force
    if ($LASTEXITCODE -ne 0) {
        throw "VS Code extension installation failed with exit code $LASTEXITCODE."
    }

    Write-Host ""
    Write-Host "OMP IDE Context installed. Restart OMP; its status line should show IDE:ready."
} finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}

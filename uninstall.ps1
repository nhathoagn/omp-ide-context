[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Workspace
)

$ErrorActionPreference = "Stop"
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
$vsCodeExtension = "omp-safe-ide-context.omp-ide-context-vscode"

foreach ($path in $Workspace) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Workspace does not exist: $path"
    }
}

$code = Get-Command code -ErrorAction SilentlyContinue
if ($code) {
    & code --uninstall-extension $vsCodeExtension
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "VS Code extension uninstall exited with code $LASTEXITCODE. Remove $vsCodeExtension from VS Code manually if needed."
    }
} else {
    Write-Warning "VS Code 'code' command not found; remove $vsCodeExtension from VS Code manually."
}

Remove-Item -LiteralPath (Join-Path $ompExtensionDir "omp-safe-ide-context") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue

foreach ($path in $Workspace) {
    $ompDir = Join-Path $path ".omp"
    Remove-Item -LiteralPath (Join-Path $ompDir "ide-context.json") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $ompDir "ide-context.tmp") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $ompDir "ide-context.config.json") -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $ompDir -PathType Container -and -not (Get-ChildItem -LiteralPath $ompDir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $ompDir -Force
    }
}

Write-Host "OMP IDE Context uninstalled and workspace bridge files removed."

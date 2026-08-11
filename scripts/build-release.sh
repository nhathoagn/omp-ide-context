#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_DIR="$(mktemp -d)"
ARCHIVE_NAME="omp-ide-context.tar.gz"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"
bun install --frozen-lockfile
(
  cd vscode-extension
  bun run build
)

mkdir -p "${STAGE_DIR}/omp-extension" "${STAGE_DIR}/vscode-extension" "${DIST_DIR}"

# Ship only the OMP extension source and its manifest; dependencies are supplied by OMP.
cp -R omp-extension/src "${STAGE_DIR}/omp-extension/"
cp omp-extension/package.json "${STAGE_DIR}/omp-extension/"

(
  cd vscode-extension
  ./node_modules/.bin/vsce package --no-dependencies --out "${STAGE_DIR}/vscode-extension/omp-ide-context-vscode.vsix"
)

cp README.md LICENSE SECURITY.md install.sh install.ps1 uninstall.sh uninstall.ps1 "${STAGE_DIR}/"
tar -C "${STAGE_DIR}" -czf "${DIST_DIR}/${ARCHIVE_NAME}" .

echo "Created ${DIST_DIR}/${ARCHIVE_NAME}"

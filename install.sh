#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="nhathoagn/omp-ide-context"
ARCHIVE_NAME="omp-ide-context.tar.gz"
INSTALL_DIR="${OMP_IDE_CONTEXT_INSTALL_DIR:-${HOME}/.local/share/omp-ide-context}"
OMP_EXTENSION_DIR="${HOME}/.omp/agent/extensions"

if [[ $# -eq 0 ]]; then
  ARCHIVE_PATH=""
elif [[ $# -eq 2 && "$1" == "--archive" && -f "$2" ]]; then
  ARCHIVE_PATH="$2"
else
  echo "Usage: $0 [--archive /path/to/omp-ide-context.tar.gz]"
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  echo "Missing VS Code's 'code' command."
  echo "In VS Code, run: Shell Command: Install 'code' command in PATH"
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

if [[ -z "${ARCHIVE_PATH}" ]]; then
  echo "Downloading OMP IDE Context…"
  ARCHIVE_PATH="${TEMP_DIR}/${ARCHIVE_NAME}"
  curl --fail --location --silent --show-error \
    "https://github.com/${REPOSITORY}/releases/latest/download/${ARCHIVE_NAME}" \
    --output "${ARCHIVE_PATH}"
fi

tar -xzf "${ARCHIVE_PATH}" -C "${TEMP_DIR}"

if [[ ! -f "${TEMP_DIR}/omp-extension/package.json" ]] || [[ ! -f "${TEMP_DIR}/vscode-extension/omp-ide-context-vscode.vsix" ]]; then
  echo "Release archive is incomplete; refusing to install it."
  exit 1
fi

mkdir -p "$(dirname "${INSTALL_DIR}")" "${OMP_EXTENSION_DIR}"
rm -rf "${INSTALL_DIR}"
mv "${TEMP_DIR}" "${INSTALL_DIR}"
trap - EXIT

ln -sfn "${INSTALL_DIR}/omp-extension" "${OMP_EXTENSION_DIR}/omp-safe-ide-context"
code --install-extension "${INSTALL_DIR}/vscode-extension/omp-ide-context-vscode.vsix" --force

echo
echo "OMP IDE Context installed. Restart OMP; its status line should show IDE:ready."

#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${OMP_IDE_CONTEXT_INSTALL_DIR:-${HOME}/.local/share/omp-ide-context}"
OMP_EXTENSION_DIR="${HOME}/.omp/agent/extensions"
VS_CODE_EXTENSION="omp-safe-ide-context.omp-ide-context-vscode"

usage() {
  echo "Usage: $0 --workspace /path/to/project [--workspace /path/to/another-project]"
}

workspaces=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      [[ $# -ge 2 ]] || { usage >&2; exit 1; }
      [[ -d "$2" ]] || { echo "Workspace does not exist: $2" >&2; exit 1; }
      workspaces+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

[[ ${#workspaces[@]} -gt 0 ]] || { usage >&2; exit 1; }

if command -v code >/dev/null 2>&1; then
  code --uninstall-extension "${VS_CODE_EXTENSION}" || true
else
  echo "VS Code 'code' command not found; remove ${VS_CODE_EXTENSION} from VS Code manually." >&2
fi

rm -f "${OMP_EXTENSION_DIR}/omp-safe-ide-context"
rm -rf "${INSTALL_DIR}"

for workspace in "${workspaces[@]}"; do
  omp_dir="${workspace}/.omp"
  rm -f "${omp_dir}/ide-context.json" "${omp_dir}/ide-context.tmp" "${omp_dir}/ide-context.config.json"
  rmdir "${omp_dir}" 2>/dev/null || true
done

echo "OMP IDE Context uninstalled and workspace bridge files removed."

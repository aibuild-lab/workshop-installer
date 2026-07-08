#!/usr/bin/env bash
set -euo pipefail

REPO="aibuild-lab/workshop-installer"
DEFAULT_ROOT="${HOME}/GitHub"
INSTALLER_DIR="${DEFAULT_ROOT}/workshop-installer"

if ! command -v node >/dev/null 2>&1; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Node.js is required. This launcher can only bootstrap Node automatically on macOS."
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required before this launcher can install Node."
    echo "Install Homebrew from https://brew.sh, then rerun this command."
    exit 1
  fi
  brew install node
fi

if ! command -v git >/dev/null 2>&1; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Git is required before this launcher can clone the installer repo."
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Git is required, and Homebrew is not available to install it automatically."
    echo "Install Apple Command Line Tools or Homebrew, then rerun this command."
    exit 1
  fi
  brew install git
fi

mkdir -p "${DEFAULT_ROOT}"
if [[ ! -d "${INSTALLER_DIR}/.git" ]]; then
  if command -v gh >/dev/null 2>&1; then
    gh repo clone "${REPO}" "${INSTALLER_DIR}"
  else
    git clone "https://github.com/${REPO}.git" "${INSTALLER_DIR}"
  fi
else
  git -C "${INSTALLER_DIR}" pull --ff-only
fi

node "${INSTALLER_DIR}/install.mjs" "$@"

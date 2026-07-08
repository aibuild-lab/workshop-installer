$ErrorActionPreference = "Stop"

$Repo = "aibuild-lab/workshop-installer"
$DefaultRoot = Join-Path $HOME "GitHub"
$InstallerDir = Join-Path $DefaultRoot "workshop-installer"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node.js is required, and winget is not available to install it automatically. Install Node.js LTS, then rerun this script."
  }
  winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Git is required, and winget is not available to install it automatically. Install Git, then rerun this script."
  }
  winget install --id Git.Git --source winget --accept-package-agreements --accept-source-agreements
}

New-Item -ItemType Directory -Force -Path $DefaultRoot | Out-Null
if (-not (Test-Path (Join-Path $InstallerDir ".git"))) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh repo clone $Repo $InstallerDir
  } else {
    git clone "https://github.com/$Repo.git" $InstallerDir
  }
} else {
  git -C $InstallerDir pull --ff-only
}

node (Join-Path $InstallerDir "install.mjs") @args

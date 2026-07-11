# Architecture Overview

## Repository purpose

This repo is a **workshop onboarding toolkit**, not an application. It exists to get a student's machine from zero to "ready for the AI Build Lab workshop" with a safe private repo and secrets protection in place. There is no server, no database, no application runtime. The repo contains installer scripts, Claude Code hook scripts, documentation, and tests.

## Two install flows

### 1. Claude-guided (primary)

The student pastes the contents of `SETUP-PROMPT.md` into Claude Desktop. Claude Code then acts as an interactive installer agent:

1. Detects OS (`uname -s` → Darwin/MINGW)
2. Runs a full detection sweep across all tools using a three-state model: installed-on-PATH ✅, installed-not-on-PATH ⚠️, not-installed ❌
3. Presents a plan, gets blanket confirmation
4. Installs missing tools (DETECT → STATE → PLAN → ACT → VERIFY → REPORT per tool)
5. Handles auth handoffs for GitHub CLI, Claude Code, and Infisical CLI
6. Installs secrets guard hooks
7. Runs repo setup (clone `agent-native-os`, create private `origin`, wire `upstream`)
8. Writes `.aibl/workshop-profile.json` marking secrets path as `4d-connectors`

Key design rules from `SETUP-PROMPT.md`:
- Never type the student's macOS password — hand off to Terminal
- Never report a tool as "not installed" based only on `command -v` — always cross-check filesystem fallback paths (the bash subshell vs zsh user shell gotcha)
- Safe to re-run from any partial state
- Pause and explain every system permission popup

### 2. Deterministic installer (beta)

`install.mjs` is a scripted Node.js installer that mirrors the same steps without requiring Claude Desktop. It is launched by:

- `install.sh` (macOS) — bootstraps Node/Git if missing via Homebrew, clones the installer repo, runs `install.mjs`
- `install.ps1` (Windows) — bootstraps Node/Git if missing via winget, clones the installer repo, runs `install.mjs`

The deterministic installer builds a **step plan** (`buildStepPlan()` in `install.mjs`), processes each step via `runStep()`, and records completion in a state file at `~/.aibl/workshop-installer/state.json` so `--resume` can skip completed steps.

## Step plan

The ordered steps from `buildStepPlan()`:

| # | Step ID | What it does |
|---|---------|-------------|
| 1 | `platform` | Detect and report OS (mac or windows) |
| 2 | `workspace` | Confirm workspace folder (default `~/GitHub`) |
| 3 | `git` | Install or verify Git |
| 4 | `node` | Install or verify Node.js v18+ |
| 5 | `gh` | Install or verify GitHub CLI |
| 6 | `python-env` | Install uv or accept existing Python manager (3.10+) |
| 7 | `claude` | Install or verify Claude Code |
| 8 | `infisical` | Install or verify Infisical CLI |
| 9 | `github-auth` | Verify `gh auth login` is working |
| 10 | `claude-auth` | Confirm Claude Code browser sign-in |
| 11 | `infisical-auth` | Verify Infisical CLI sign-in (without printing secrets) |
| 12 | `secrets-guard` | Copy hook scripts to `~/.claude/hooks/` and run the hooks installer |
| 13 | `repo-setup` | Run repo setup script (fresh or Cohort 1 migration) |

Steps 9–11 and some install steps require browser sign-in and will pause with instructions, then expect `--resume`.

## Workspace safety

Both flows refuse cloud-sync folders (Dropbox, OneDrive, iCloud Drive, Google Drive, Box, Creative Cloud Files) because cloud sync can corrupt `.git`, create lock conflicts, or sync secrets. The check is in `cloudSyncReason()` and is shared by `install.mjs`, `prepare-workshop-repo.mjs`, and `migrate-existing-student-repo.mjs`.

## Repo setup scripts

### `scripts/prepare-workshop-repo.mjs` (fresh setup)

1. Verifies `git`, `node`, `gh` are installed and `gh auth login` is working
2. Reads GitHub username via `gh api user`
3. Clones `aibuild-lab/agent-native-os` into `~/GitHub/agent-native-os` (if not already present)
4. Checks for uncommitted changes in sensitive files — refuses to proceed if found
5. Wires remotes: renames `origin`→`upstream` if it points at AI Build Lab, creates/verifies private `<username>/agent-native-os-private` as `origin`
6. Pushes current branch to private origin
7. Writes `.aibl/repo-state.md` (local safety report) and `.aibl/workshop-profile.json` (4D baseline)
8. Verifies final remote state — fails loudly if origin is not private or upstream is wrong

### `scripts/migrate-existing-student-repo.mjs` (Cohort 1)

Same outcome but starts from an existing local `agent-native-os` clone:
1. Resolves the course repo path
2. Refuses cloud-sync folders
3. Verifies repo shape (must be the course repo)
4. Checks for uncommitted changes (blocks if dirty)
5. Pulls upstream before creating private copy
6. Rewires remotes to the same safe model
7. Reports sibling Cairns clones if any exist

## Python environment classification

`classifyPythonEnvironment()` in `install.mjs` handles five states:

| State | Condition | Action |
|-------|-----------|--------|
| `uv` | `uv --version` works | Ensure Python 3.12 via `uv python install` |
| `existing-manager` | conda/mamba/micromamba/pyenv/mise with Python 3.10+ | Skip uv install |
| `plain-python-only` | Python 3.10+ but no manager | Install uv |
| `missing` | Nothing found | Install uv |

This ensures the installer never overwrites a working Python setup while always providing a managed environment when none exists.

## File structure

```
├── install.mjs                          # Deterministic installer (beta)
├── install.sh                           # macOS launcher
├── install.ps1                          # Windows launcher
├── SETUP-PROMPT.md                      # Claude-guided setup procedure (primary)
├── MANUAL-INSTALL.md                    # Manual install walkthrough
├── README.md                            # Student-facing instructions
├── hooks/
│   ├── README.md                        # Secrets guard documentation
│   ├── secrets-guard.js                 # PreToolUse hook
│   ├── secrets-tripwire.js              # PostToolUse/PostToolUseFailure hook
│   ├── install.mjs                      # Idempotent hooks installer
│   ├── secrets-guard.test.mjs           # Allow/block test table
│   ├── secrets-tripwire.test.mjs        # Redaction test suite
│   └── install.test.mjs                 # Matcher isolation tests
├── scripts/
│   ├── prepare-workshop-repo.mjs        # Fresh private repo setup
│   └── migrate-existing-student-repo.mjs # Cohort 1 migration
├── tests/
│   └── install.test.mjs                 # Installer unit tests
└── .github/workflows/
    └── guard-tests.yml                   # Multi-OS CI for hooks
```

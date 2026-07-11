# Installer Operations

## Deterministic installer: install.mjs

**File:** `install.mjs`

The deterministic installer is a resumable, platform-aware Node.js script. It is the beta alternative to the Claude-guided setup.

### CLI flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Print the step plan without installing tools or changing repos |
| `--resume` | Skip steps recorded as completed in the state file |
| `--yes` | Use defaults and skip confirmation prompts (headless mode) |
| `--workspace <path>` | Parent folder for workshop repos (default: `~/GitHub`) |
| `--repo-name <name>` | Private GitHub repo name (default: `agent-native-os-private`) |
| `--cohort1` | Migrate an existing Cohort 1 clone instead of creating fresh |
| `--state-file <path>` | Override resume-state file path |
| `--help` | Print usage |

Positional argument: workspace path (alternative to `--workspace`).

### Resume state

State is stored at `~/.aibl/workshop-installer/state.json` (mode `0600`):

```json
{
  "version": 1,
  "completed": ["platform", "workspace", "git", "node", ...]
}
```

After each step completes, the step ID is appended to `completed`. On `--resume`, `nextRunnableSteps()` filters out completed steps. If a step fails, the script halts — the student fixes the issue and reruns with `--resume`.

### Platform detection

`detectSupportedPlatform()` maps `process.platform`:
- `darwin` → `"mac"`
- `win32` → `"windows"`
- anything else → `"unsupported"` (halts)

### Tool install functions

Each tool has a dedicated function in `install.mjs`:

| Function | macOS method | Windows method |
|----------|-------------|----------------|
| `installGit` | `brew install git` | `winget install Git.Git` |
| `installNode` | `brew install node` | `winget install OpenJS.NodeJS.LTS` |
| `installGitHubCli` | `brew install gh` | `winget install GitHub.cli` |
| `installPythonEnvironment` | `brew install uv` or skip | `winget install astral-sh.uv` or skip |
| `installClaude` | `curl https://claude.ai/install.sh \| sh` | `irm https://claude.ai/install.ps1 \| iex` |
| `installInfisical` | `brew install infisical/get-cli/infisical` | Scoop bucket + `scoop install infisical` |

**Homebrew bootstrapping** (`ensureHomebrew()`): If Homebrew is missing, installs Apple Command Line Tools first (`xcode-select --install`), then runs the Homebrew install script. After install, writes `brew shellenv` to both `~/.bash_profile` and `~/.zshrc` to fix the bash/zsh PATH mismatch.

**Claude Code PATH** (`ensureClaudePath()`): Writes `export PATH="$HOME/.local/bin:$PATH"` to `~/.bash_profile` and `~/.zshrc` (macOS), or sets the User PATH environment variable (Windows). Also sets `CLAUDE_CODE_GIT_BASH_PATH` on Windows.

### Auth verification

| Step | Check | Failure behavior |
|------|-------|-----------------|
| `github-auth` | `gh api user --jq .login` | Halt, instruct `gh auth login`, rerun with `--resume` |
| `claude-auth` | `claude --version` binary check | Halt, instruct browser sign-in, rerun with `--resume` |
| `infisical-auth` | `infisical user` | Halt, instruct `infisical login`, rerun with `--resume`. Never run `infisical user get token`. |

### Secrets guard installation step

`installSecretsGuard()` copies `secrets-guard.js`, `secrets-tripwire.js`, and `install.mjs` from the repo's `hooks/` directory to `~/.claude/hooks/`, then runs the hooks installer and the guard test suite as a self-verify.

## Shell launchers

### install.sh (macOS)

Bootstraps dependencies if missing:
1. If `node` is missing → `brew install node` (requires Homebrew)
2. If `git` is missing → `brew install git`
3. Creates `~/GitHub` directory
4. Clones or pulls `aibuild-lab/workshop-installer` into `~/GitHub/workshop-installer`
5. Runs `node install.mjs "$@"` — passes all arguments through

### install.ps1 (Windows)

Same pattern using winget for bootstrapping:
1. If `node` is missing → `winget install OpenJS.NodeJS.LTS`
2. If `git` is missing → `winget install Git.Git`
3. Creates `~/GitHub` directory
4. Clones or pulls the installer repo
5. Runs `node install.mjs @args`

## Repo setup scripts

### prepare-workshop-repo.mjs (fresh)

**File:** `scripts/prepare-workshop-repo.mjs`

Creates the private workshop repo from scratch:

1. Verifies `git`, `node`, `gh` installed and `gh auth login` working
2. Reads GitHub username
3. Refuses cloud-sync workspace folders
4. Clones `aibuild-lab/agent-native-os` into `~/GitHub/agent-native-os` if missing
5. Verifies the clone is a git repo at the expected root
6. Checks for uncommitted changes in sensitive files — blocks if found
7. Wires remotes:
   - If `origin` points at AI Build Lab → rename to `upstream`
   - Ensure `upstream` → `aibuild-lab/agent-native-os`
   - Create or verify private `<username>/<repo-name>` as `origin`
   - Push current branch to origin
8. Ensures `.aibl/` is gitignored locally
9. Writes `.aibl/repo-state.md` (safety report) and `.aibl/workshop-profile.json` (4D baseline)
10. Final verification: origin is private, upstream is AI Build Lab

Flags: `--yes`, `--dry-run`, `--workspace <path>`, `--repo-name <name>`

### migrate-existing-student-repo.mjs (Cohort 1)

**File:** `scripts/migrate-existing-student-repo.mjs`

For students who already have an `agent-native-os` clone from when it was public:

1. Resolves the course repo path from the current directory
2. Refuses cloud-sync folders
3. Verifies repo shape matches the course repo
4. Reports sibling Cairns clones if any exist
5. Checks for uncommitted changes — blocks if dirty
6. **Pulls upstream before creating the private copy** (fix from PR #13)
7. Rewires remotes to the same safe model (upstream = AI Build Lab, origin = private)
8. Verifies final state
9. Instructs student to run `/update-course` next

## .aibl local-only files

The installer writes files under `.aibl/` in the workshop repo. These are gitignored and never committed:

| File | Contents |
|------|----------|
| `.aibl/workshop-profile.json` | Secrets path marker (`4d-connectors`) |
| `.aibl/repo-state.md` | Safety report documenting remote wiring |

The state file for the deterministic installer lives at `~/.aibl/workshop-installer/state.json` (home directory, not inside the repo).

## CI workflow

**File:** `.github/workflows/guard-tests.yml`

Runs on every PR and push to `main` across three OS matrices (Ubuntu, Windows, macOS):

1. `node hooks/secrets-guard.test.mjs` — guard bypass/regression suite
2. `node hooks/secrets-tripwire.test.mjs` — tripwire redaction suite
3. `node hooks/install.test.mjs` — installer matcher isolation suite

A red X on any platform means a bypass was reopened — do not merge.

## Manual install reference

`MANUAL-INSTALL.md` contains the complete step-by-step manual install walkthrough for both platforms, with every command, expected output, and troubleshooting. It is the fallback when the installer fails or when the student wants to understand exactly what each step does.

Quick reference commands are at the top of the file, organized by platform (Windows PowerShell and macOS Terminal), with detailed walkthroughs below each section.

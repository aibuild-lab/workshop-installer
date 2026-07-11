# Workshop Installer — OpenWiki Quickstart

## What this repository is

The **AI Build Lab Workshop Installer** is the setup toolkit for students entering the AI Build Lab workshop. It installs the required development tools (Git, Node.js, GitHub CLI, Python environment, Claude Code, Infisical CLI), wires up a safe private workshop repository, and installs a secrets-protection hook system that prevents Claude Code from accidentally printing or writing secrets.

There are **two install paths**:

1. **Claude-guided install (primary)** — A student pastes the [SETUP-PROMPT.md](../SETUP-PROMPT.md) into Claude Desktop, which walks them through detection, installation, authentication, and repo setup interactively.
2. **Deterministic installer beta** — A scripted Node.js installer (`install.mjs`) with dry-run, resume, and headless modes. Launched via `install.sh` (macOS) or `install.ps1` (Windows).

Both paths install the same tools, install the secrets guard hooks, and create the same private repo structure.

## What gets installed

| Tool | macOS | Windows | Purpose |
|------|-------|---------|---------|
| Git | Homebrew | winget (Git.Git) | Version control |
| Node.js v18+ | Homebrew | winget (OpenJS.NodeJS.LTS) | Runtime for dev tools and MCP servers |
| GitHub CLI | Homebrew | winget (GitHub.cli) | GitHub auth and repo management |
| Python env | uv (Homebrew) or existing manager | uv (winget) or existing manager | Python 3.10+ for workshop blueprints |
| Claude Code | Anthropic installer | Anthropic installer | Central workshop tool |
| Infisical CLI | Homebrew | Scoop | Secrets management (4D connectors baseline) |

If the student already has Conda, Mamba, pyenv, or mise with Python 3.10+, `uv` is skipped.

## Private repo model

After tools are installed and authenticated, the installer creates or verifies a private GitHub repo:

- **upstream** → `aibuild-lab/agent-native-os` (AI Build Lab course repo)
- **origin** → `<student-username>/agent-native-os-private` (student's private repo)
- Local clone at `~/GitHub/agent-native-os`

Personalization only begins after `origin` is confirmed private. A local `.aibl/workshop-profile.json` marks the starting secrets path as `4d-connectors` and stays out of Git.

### Cohort 1 migration

Students who already cloned `agent-native-os` while public use `scripts/migrate-existing-student-repo.mjs` (or `--cohort1`) instead of creating a fresh clone. The migration pulls upstream, creates the private origin, and preserves the existing folder.

## Secrets protection

A critical safety feature installed into `~/.claude/settings.json` (user-level, applies to every project). Two Claude Code hooks:

- **secrets-guard.js** (`PreToolUse`) — Blocks commands that would dump secrets to stdout (vault exports, `env` dumps, `cat .env`, language-eval exfil, etc.) and blocks real secret-shaped keys from being written into files via Write/Edit.
- **secrets-tripwire.js** (`PostToolUse`/`PostToolUseFailure`) — Redacts secret-shaped strings from tool output before Claude sees them, and logs near-miss events to `~/.claude/logs/secrets-tripwire.log` (names only, never values).

See [Secrets Protection](secrets-protection/overview.md) for details.

## 4D vs 8D secrets paths

- **4D connectors (baseline)** — The installer verifies Infisical CLI login but does not create a project, run `infisical init`, or start Infisical Agent. Secrets are handled via 1Password / Infisical runtime injection (`op run`, `infisical run`).
- **8D upgrade** — When the student needs API-key environment variables, they open Claude in their repo and run `/upgrade-8d-secrets`, which activates Infisical Agent with a scoped routine-read identity.

## Documentation sections

- [Architecture Overview](architecture/overview.md) — Repository structure, install flows, step plan, and how the pieces connect.
- [Secrets Protection](secrets-protection/overview.md) — Hook design, what gets blocked, installer behavior, and test coverage.
- [Installer Operations](operations/installer.md) — Deterministic installer internals, CLI flags, resume state, repo setup scripts, and CI.

## Key source files

| File | Role |
|------|------|
| `install.mjs` | Deterministic installer (beta) — step plan, tool detection, resume |
| `install.sh` / `install.ps1` | Shell launchers that bootstrap Node, clone installer, run `install.mjs` |
| `SETUP-PROMPT.md` | Full Claude-guided setup procedure (primary path) |
| `MANUAL-INSTALL.md` | Step-by-step manual install with commands and troubleshooting |
| `README.md` | Student-facing install instructions and verification steps |
| `hooks/secrets-guard.js` | PreToolUse hook — blocks secret-dumping commands and secret-shaped file writes |
| `hooks/secrets-tripwire.js` | PostToolUse hook — redacts secret-shaped output, logs near-misses |
| `hooks/install.mjs` | Idempotent hooks installer — merges into `~/.claude/settings.json` |
| `scripts/prepare-workshop-repo.mjs` | Creates/verifies private origin, wires upstream, writes safety reports |
| `scripts/migrate-existing-student-repo.mjs` | Cohort 1 migration path for existing clones |

## CI

- `.github/workflows/guard-tests.yml` — Runs secrets-guard, tripwire, and installer isolation tests on Ubuntu, Windows, and macOS for every PR and push to main.
- `.github/workflows/openwiki-update.yml` — Scheduled daily OpenWiki documentation refresh.

## Running tests

```bash
node hooks/secrets-guard.test.mjs      # allow/block table for the PreToolUse hook
node hooks/secrets-tripwire.test.mjs   # redaction suite for the PostToolUse hook
node hooks/install.test.mjs            # installer matcher isolation tests
node tests/install.test.mjs            # deterministic installer unit tests
```

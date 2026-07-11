# Secrets Protection

## Why hooks instead of CLAUDE.md rules

A written rule in CLAUDE.md only works if the model chooses to obey it every time. A `PreToolUse` hook inspects the literal command and refuses the dangerous class deterministically, regardless of model compliance. This is the core design principle behind the secrets guard system (noted in `hooks/README.md`, referencing Anthropic issue #32523).

The hooks are installed into `~/.claude/settings.json` at the **user level**, so they apply to every project, not just the workshop repo.

## Architecture: two hooks, defense in depth

### secrets-guard.js — PreToolUse (block before execution)

**File:** `hooks/secrets-guard.js`

Inspects the command before Claude Code runs it. Returns a `deny` decision with a reason string if the command matches a blocked pattern. Guards **both** the Bash tool and the PowerShell tool (Windows exposes a separate PowerShell tool a Bash-only matcher would miss).

**What it blocks:**

1. **Vault bulk dumps** — `infisical secrets`/`export`, `bw export`/`list items`, `op item get --reveal`, `supabase projects api-keys --reveal`, `--plain`
2. **Raw `op read`** as a live command (prints a secret to stdout). But `op read` inside `$(...)` fed to a program stays allowed; only printing the result is blocked.
3. **Whole-environment dumps** — bare `env`, `printenv`, `set`, `declare -p`, `export -p` (Bash); `Get-ChildItem Env:`, `[Environment]::GetEnvironmentVariables()`, bare `Get-Variable` (PowerShell)
4. **Secret-looking variable reads** — `echo $API_KEY`, `printenv SECRET_VAR`, `Write-Host $env:TOKEN` (blocked unless masked with `| head -c 4`)
5. **Secret-bearing file reads** — `cat .env`, reading `.pem`/`id_rsa`/`credentials` files. `.env.example` is allowed.
6. **Language-eval exfil** — `node -e '...process.env'`, `python3 -c '...os.environ'`, any language eval touching `.env`
7. **Docker compose config** — renders interpolated secrets to stdout
8. **Literal secret shapes in commands** — a real vendor key pattern embedded in `printf`, heredoc, `node -e writeFileSync`, or `Authorization: Bearer` header
9. **Secret-shaped file writes** — via Write/Edit/MultiEdit/NotebookEdit matcher, blocks real vendor key formats from being written into tracked files

**What it allows:**
- `op run -- <cmd>` and `infisical run -- <cmd>` (runtime injection) — but the wrapped command is recursively vetted, so `op run -- cat .env` is still blocked
- `$(op read ...)` fed to a program (injection, not printing)
- Masked first4 fingerprint checks (`... | head -c 4`)
- `printenv PATH` (single non-secret variable)
- `op whoami`, `op item list`, `bw get`
- `.env.example`, `.env.sample`, `.env.template` reads
- `env FOO=bar cmd` (setter + utility, not a dump)

**Command inspection is recursive and token-based.** The `collectInspectionCommands()` function splits shell syntax at operators (outside quotes), then recursively inspects:
- Runtime-injected children (`op run`/`infisical run` payloads after `--`)
- `env` payloads (distinguishing `env FOO=bar cmd` from bare `env`)
- Nested shell bodies (`bash -c '...'`)
- Path-qualified commands (`/usr/bin/env`)
- `env -S` / `--split-string` expansions

This closes bypass classes: prefix-loss, nested-shell, path-qualified, and wrapper injection variants.

### secrets-tripwire.js — PostToolUse / PostToolUseFailure (redact after execution)

**File:** `hooks/secrets-tripwire.js`

A defense-in-depth backstop. If a secret-shaped string somehow reaches tool output:

- **PostToolUse (success)** — Replaces each secret match with `[REDACTED: <type>]` via `updatedToolOutput`, preserving the output's shape. Claude never sees the actual value.
- **PostToolUseFailure (error)** — Cannot rewrite the error, so it emits names-only context telling the model not to reconstruct or echo the value.

Either way, logs a dated near-miss to `~/.claude/logs/secrets-tripwire.log` at mode `0600` — **names only, never the value**.

**Patterns matched** (in both guard and tripwire, with some tripwire-only additions):
Anthropic API keys (`sk-ant-`), Langfuse (`sk-lf-`), OpenAI (`sk-`), GitHub tokens (`ghp_`/`github_pat_`), Slack tokens (`xox`/`xapp`), Supabase secrets, AWS access key IDs, 1Password service tokens, Apify tokens, Firecrawl keys, Google API keys, private key blocks, DB URLs with passwords, Bearer tokens, JWTs.

## Installer: hooks/install.mjs

**File:** `hooks/install.mjs`

Idempotent installer that merges hooks into `~/.claude/settings.json`. Safe to re-run.

**Key design decisions:**

1. **Dedicated matcher groups** — Each managed hook gets its own matcher group. Repairing one hook's matcher never widens or narrows a sibling hook's matcher. Only whole-token copies of the managed script are removed during cleanup.

2. **Absolute node path** — Both the node binary and hook script paths are absolute, forward-slash, quoted strings resolved at install time. A bare `node` would be "command not found" in the shell Claude Code spawns hooks in (which doesn't load `~/.zshrc`), causing the hook to error instead of deny, leaving the command **unguarded**. Uses `process.env.CLAUDE_HOOK_NODE` or `process.execPath`.

3. **Atomic settings write** — Writes to a temp file at mode `0600`, then renames over the target. A crash mid-write cannot leave a truncated settings file.

4. **Permissions deny block** — Adds `Read(.env)`, `Read(**/.env)`, `Read(**/*.pem)`, `Read(**/id_rsa)`, `Read(**/credentials*)`, etc. to `permissions.deny`, unioned with existing entries.

5. **Backup** — Creates `~/.claude/settings.json.backup.secrets-guard` before first modification.

**Matchers registered:**
- PreToolUse: `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit` → `secrets-guard.js`
- PostToolUse: `Bash|PowerShell` → `secrets-tripwire.js`
- PostToolUseFailure: `Bash|PowerShell` → `secrets-tripwire.js`

## Test coverage

| Test file | What it validates |
|-----------|-------------------|
| `hooks/secrets-guard.test.mjs` | Allow/block decision table fed into the real hook via PreToolUse JSON. Pins real `$(op read ...)` injection shapes, `--env-file` false positives, nested shell bypasses, PowerShell Env: dumps, Write/Edit secret blocks. No secret command is ever executed. |
| `hooks/secrets-tripwire.test.mjs` | Redaction suite for PostToolUse output rewriting |
| `hooks/install.test.mjs` | Matcher isolation — verifies the installer doesn't widen/narrow sibling hooks when repairing one |

CI (`.github/workflows/guard-tests.yml`) runs all three suites on **Ubuntu, Windows, and macOS** for every PR and push to main. A red CI means a change reopened a bypass — do not merge.

## Evolution and hardening history

The git log shows a pattern of closing specific bypass classes discovered through review and testing:

- **Injection bypasses** — Wrapper commands (`op run`, `infisical run`), nested shells (`bash -c`), path-qualified commands (`/usr/bin/env`) were closed by making inspection recursive (`collectInspectionCommands`)
- **Write/Edit guard** — Added a `Write|Edit|MultiEdit|NotebookEdit` matcher to block secrets written directly into files (the original-incident class the Bash-only guard never covered)
- **Literal key blocking** — Added `SECRET_SHAPES` matching on command text and file write content to block real vendor key formats embedded in shell commands
- **Tripwire redaction** — PostToolUse `updatedToolOutput` redacts on success; PostToolUseFailure emits names-only context (cannot rewrite errors)
- **Installer isolation** — Each managed hook in its own matcher group (PR #14 review) so repairing one hook never touches a sibling's matcher
- **Absolute node pinning** — Prevents the "hook looks installed but protects nothing" failure mode where `node` isn't on PATH in the hook shell

## Known limitations

From `hooks/README.md`:
- The guard is a **strong floor, not a proof** — static matching has edge cases
- Conservative on language-eval: blocks any `node -e`/`python3 -c` that touches `process.env`/`.env`, including benign one-variable reads (workaround: `printenv NAME`)
- Best combined with narrow per-session secrets identities (4D/8D model)
- Reviewer note: Step 5.3.5 `curl`s hooks from `main`; consider pinning to a tag or commit SHA

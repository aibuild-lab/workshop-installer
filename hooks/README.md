# Secrets guard (Claude Code hooks)

Harness-level protection that stops Claude Code from printing a student's secrets to the
terminal. Installed by `SETUP-PROMPT.md` Step 5.3.5 into the student's user-level settings
(`~/.claude/settings.json`), so it applies in **every** project, not just the workshop repo.

Why a hook and not a CLAUDE.md rule: a written rule only works if the model chooses to obey
it every time. A `PreToolUse` hook inspects the literal command and refuses the dangerous
class deterministically, whether or not the model "remembers." (Anthropic issue #32523.)

## Files

- **`secrets-guard.js`** — `PreToolUse` hook. Blocks the *dump-a-secret-to-stdout* class:
  `infisical secrets`/`export`, `bw export`/`list items`, `op item get --reveal`, `--plain`,
  bare `env`/`printenv`/`set`/`declare -p`, reads of `.env`/`.pem`/`id_rsa`/`credentials`,
  language-eval exfil, `docker compose config`. **Allows** the legitimate forms: `op run` /
  `infisical run` (runtime injection), single-ref `op read` / `bw get`, `op whoami`,
  `printenv PATH`, `env FOO=bar cmd`, `.env.example`. Vault-agnostic. Written in Node (a Claude
  Code dependency) so it runs unchanged on Mac and Windows/Git Bash. It guards **both** the Bash
  tool and the PowerShell tool: on Windows, Claude Code exposes a separate PowerShell tool, so
  the guard also blocks `Get-ChildItem Env:` (and `gci`/`ls`/`-Path`/piped forms),
  `[Environment]::GetEnvironmentVariables()`, bare `Get-Variable`/`gv`, and
  `Get-Content`/`gc`/`type`/`Select-String` reads of secret files, while allowing `$env:NAME`
  single reads and `ls $env:VAR` path uses.
- **`secrets-tripwire.js`** — `PostToolUse` hook. Scans tool output for secret-shaped strings
  and warns the model not to echo them + logs a dated near-miss (names only, never values).
  Detection, not redaction — it cannot un-send output already shown.
- **`install.mjs`** — idempotent installer. Merges the hooks + `permissions.deny` block into
  `~/.claude/settings.json` without clobbering existing keys; backs the file up first.

## Validation

`secrets-guard.js` passes a 63-case allow/block table (Bash 32, PowerShell 31), validated on
both macOS and Windows. See `Secrets-Guard-Hook-Plan.md` in Wade's workbench for the table and
the full plan.

## Reviewer notes

- **Pin the source.** Step 5.3.5 `curl`s these from `main`. Consider pinning to a tag or commit
  SHA so a later edit can't silently change what students install.
- **Conservative on language-eval.** The guard blocks any `node -e` / `python3 -c` that touches
  `process.env` / `.env`, including benign one-variable reads. Safe default; workaround is
  `printenv NAME`.
- The guard is a strong floor, not a proof — static matching has edge cases. It's paired with
  the tripwire and is best combined with narrow per-session secrets identities.

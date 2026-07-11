# Secrets guard (Claude Code hooks)

Harness-level protection that stops Claude Code from printing a student's secrets to the
terminal. Installed by `SETUP-PROMPT.md` Step 5.3.5 into the student's user-level settings
(`~/.claude/settings.json`), so it applies in **every** project, not just the workshop repo.

Why a hook and not a CLAUDE.md rule: a written rule only works if the model chooses to obey
it every time. A `PreToolUse` hook inspects the literal command and refuses the dangerous
class deterministically, whether or not the model "remembers." (Anthropic issue #32523.)

## Files

- **`secrets-guard.js`** - `PreToolUse` hook. Blocks the *dump-a-secret-to-stdout* class:
  `infisical secrets`/`export`, `bw export`/`list items`, `op item get --reveal`, `--plain`,
  raw `op read`, secret-looking `echo`/`printf`/`printenv` variable reads, bare
  `env`/`printenv`/`set`/`declare -p`, reads of `.env`/`.pem`/`id_rsa`/`credentials`,
  language-eval exfil, `docker compose config`. **Allows** the legitimate forms: `op run` /
  `infisical run` (runtime injection), masked first4 checks, `bw get`, `op whoami`,
  `printenv PATH`, `env FOO=bar cmd`, `.env.example`. Vault-agnostic. Written in Node (a Claude
  Code dependency) so it runs unchanged on Mac and Windows/Git Bash. It guards **both** the Bash
  tool and the PowerShell tool: on Windows, Claude Code exposes a separate PowerShell tool, so
  the guard also blocks `Get-ChildItem Env:` (and `gci`/`ls`/`-Path`/piped forms),
  `[Environment]::GetEnvironmentVariables()`, bare `Get-Variable`/`gv`, and
  `Get-Content`/`gc`/`type`/`Select-String` reads of secret files, while allowing `$env:NAME`
  single reads and `ls $env:VAR` path uses. Command inspection is token-based and recursive, so a
  runtime-injection wrapper (`op run` / `infisical run`), a path-qualified command
  (`/usr/bin/env`), and a nested shell (`bash -c '<cmd>'`) are all vetted without dropping any
  sibling segment. It also blocks a literal vendor-shaped key embedded in a shell command
  (`printf`, heredoc, `node -e writeFileSync`, inline `Authorization: Bearer …`) and - via the
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit` matcher - a real key written straight into a file.
- **`secrets-tripwire.js`** - `PostToolUse` / `PostToolUseFailure` hook. On success it **redacts**
  every secret-shaped match from the tool output before Claude sees it (`updatedToolOutput`),
  preserving the output's shape; on failure (which cannot be rewritten) it emits names-only
  context telling the model not to echo the value. Either way it logs a dated near-miss to a
  `0600` file - names only, never the value.
- **`install.mjs`** - idempotent installer. Merges the hooks + `permissions.deny` block into
  `~/.claude/settings.json` without clobbering existing keys; backs the file up first. Each managed
  hook gets its own dedicated matcher group, so repairing our matcher never widens or narrows an
  unrelated sibling hook's matcher; only whole-token copies of our own script are removed. Settings
  are written atomically (temp + rename) at mode `0600`, and the hook scripts are set to `0700`.

## Validation

`secrets-guard.js` is validated by a runnable allow/block table - `node hooks/secrets-guard.test.mjs`
(feeds PreToolUse JSON into the hook; no secret command is executed). It covers Bash and PowerShell,
the retired repo-level guard's parity checks, and pins the real `$(op read ...)` injection shapes so a
future edit can't silently start blocking them. See `Secrets-Guard-Hook-Plan.md` in Wade's workbench
for the full plan.

## Reviewer notes

- **Pin the source.** Step 5.3.5 `curl`s these from `main`. Consider pinning to a tag or commit
  SHA so a later edit can't silently change what students install.
- **Conservative on language-eval.** The guard blocks any `node -e` / `python3 -c` that touches
  `process.env` / `.env`, including benign one-variable reads. Safe default; workaround is
  `printenv NAME`.
- The guard is a strong floor, not a proof - static matching has edge cases. It's paired with
  the tripwire and is best combined with narrow per-session secrets identities.

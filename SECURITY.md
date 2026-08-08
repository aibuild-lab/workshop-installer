# Security Policy

This repository is public, and it ships a security control: the `secrets-guard`
PreToolUse hook that stops an AI agent from printing secrets into its own context.
That combination means a good-faith finding is often, by its nature, a list of
working bypasses. Posting one as a public issue hands it to everyone still running
the previous release.

So please do not open a public issue for a security finding. Use one of the
channels below instead.

## How to report

**Preferred: GitHub private vulnerability reporting.** Go to the
[Security tab](https://github.com/aibuild-lab/workshop-installer/security/advisories/new)
and open a draft advisory. It is private to you and the maintainers, it threads
like an issue, and it converts into a published advisory once a fix ships.

**If you are on the AI Build Lab team:** file it in a private org repository
instead, and link it here once a fix is public. `agent-native-os` is the usual
home, since that is where the guard is pinned for students.

**If neither is available to you:** open a public issue that says only that you
have a security finding and how to reach you. Do not include the finding itself.
A maintainer will move it to a private channel.

## What to include

The more of this you have, the faster it gets fixed. None of it is required.

- Which release you tested. The hooks are pinned by immutable tag in
  `configs/secrets-guard.manifest.json` in `agent-native-os`; the tag plus the
  `sha256` of the installed `secrets-guard.js` pins it exactly.
- A repro. The hooks are validators: they read a `PreToolUse` JSON payload on
  stdin and print a verdict, so a repro never has to execute anything dangerous.

  ```bash
  printf '{"tool_name":"Bash","tool_input":{"command":"<command>"}}' \
    | node ~/.claude/hooks/secrets-guard.js; echo "exit=$?"
  ```

  Exit 0 with no deny output means the command would have run.
- Control cases that correctly pass, so we can tell a real gap from a probe that
  blanket-fails.
- Real values, redacted. Variable names and counts are enough to show impact.

## What happens next

- We aim to acknowledge within three working days.
- Fixes land in this repository, which is canonical for the hooks. Shipping to
  students is a separate step: merge, tag the merge commit, then re-pin `ref` and
  the hashes in `agent-native-os`. Until the tag exists, `refresh-guard` fails safe.
- We will credit you in the fix commit and the advisory unless you would rather we
  did not. Say so and we will leave you out.

## Scope

In scope: the `secrets-guard` and `secrets-tripwire` hooks, `install.mjs`, and the
setup scripts in this repository.

Out of scope: findings in Claude Code itself (report those to Anthropic), and the
documented residual limits of a static command guard. A hook inspects a command
string before it runs; it cannot follow data through a file. `cp .env /tmp/x &&
cat /tmp/x` is a known limit, not a new finding, and the same is true of anything
that launders a path through an intermediate file or an interactive session. If
you are not sure whether something is in that category, report it anyway.

#!/usr/bin/env node
// ~/.claude/hooks/secrets-guard.js
// PreToolUse hook. Blocks the "dump a secret to stdout" class before it runs.
// Cross-platform: runs on Node (a Claude Code dependency) — Mac, Mac Mini, Windows.
// Covers BOTH the Bash tool and the PowerShell tool (Windows uses both). Bash rules
// include the repo-level block-secret-print parity checks; PowerShell rules are additive
// (Env: drive dumps + Write-Host/Write-Output/echo of a secret-looking $env: var).
// Secret-name match spans KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL forms on both shells.
// Vault-agnostic: covers 1Password (op), Infisical, Bitwarden (bw), and the
// universal leaks (env / cat .env / language-eval) that no vault choice prevents.
// Allows runtime injection (op run / infisical run) but re-vets the WRAPPED command, so
// `op run -- cat .env` can't dump. Blocks raw op reads AND printed `$(op read …)` command
// substitution; feeding a program `"$(op read …)"` and masked first4 checks stay allowed.

const fs = require('fs');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason + '  [secrets-guard hook]'
    }
  }));
  process.exit(0);
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }
let input;
try { input = JSON.parse(raw); } catch (_) { process.exit(0); }

// --- Write/Edit/NotebookEdit: block a resolved secret from being written INTO a file. ---
// This is the original-incident class (a student pasted a real key into a tracked file) that the
// Bash-only guard never covered. Matches only high-confidence secret SHAPES (real vendor key
// formats), so placeholders, the word "password", and example connection URLs do not trip a block.
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
if (WRITE_TOOLS.includes(input.tool_name)) {
  const ti = input.tool_input || {};
  const parts = [ti.content, ti.new_string, ti.new_source, ti.new_str];
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.new_string === 'string') parts.push(e.new_string);
  const body = parts.filter(s => typeof s === 'string').join('\n');
  if (!body) process.exit(0);
  const SECRET_SHAPES = [
    ['an Anthropic API key',      /\bsk-ant-[A-Za-z0-9_-]{24,}/],
    ['an OpenAI-style key',       /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
    ['a private key block',       /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
    ['an AWS access key id',      /\bAKIA[0-9A-Z]{16}\b/],
    ['a GitHub token',            /\bgh[pousr]_[A-Za-z0-9]{36,}/],
    ['a Slack token',             /\bxox[bpsar]-[A-Za-z0-9-]{10,}/],
    ['a 1Password service token', /\bops_[A-Za-z0-9]{40,}/],
    ['an Apify token',            /\bapify_api_[A-Za-z0-9]{20,}/],
    ['a Firecrawl key',           /\bfc-[A-Za-z0-9]{20,}/],
    ['a Google API key',          /\bAIza[0-9A-Za-z_-]{35}\b/],
  ];
  for (const [label, re] of SECRET_SHAPES) {
    if (re.test(body))
      deny(`This write contains what looks like ${label}. Don't hard-code secrets into files — reference them at runtime (op://…, an environment variable, or a .env.example placeholder). If it is a genuine false positive, write a placeholder value instead.`);
  }
  process.exit(0);
}

// Guard both shells. PowerShell is a distinct tool on Windows and would otherwise bypass.
if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
const isPS = input.tool_name === 'PowerShell';
let c = (input.tool_input && input.tool_input.command) || '';
if (!c) process.exit(0);

function words(segment) {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
    .map(w => w.replace(/^(['"])(.*)\1$/, '$2'));
}

function commandName(word) {
  return (word || '').split(/[\\/]/).pop().toLowerCase();
}

function isSecretVar(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/^[$%{]+/, '')
    .replace(/[}%]+$/, '')
    .replace(/^env:/i, '')
    .split('=')[0];
  if (!cleaned) return false;
  const upper = cleaned.toUpperCase();
  const parts = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  return parts.some(part => ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'CREDENTIALS'].includes(part)) ||
    upper === 'APIKEY' || upper === 'TOKEN' || upper === 'SECRET' || upper === 'PASSWORD' ||
    upper.endsWith('_KEY') || upper.endsWith('_TOKEN') || upper.endsWith('_SECRET') ||
    upper.endsWith('_PASSWORD') || upper.endsWith('_PASSWD') ||
    upper.endsWith('_CREDENTIAL') || upper.endsWith('_CREDENTIALS');
}

function secretEnvRefs(segment) {
  return [...segment.matchAll(/\$(?:env:)?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gi)]
    .map(match => match[1]);
}

function isMaskedClause(clause) {
  return /\|\s*head\s+-c\s*4(?:\D|$)/i.test(clause);
}

// --- Runtime injection: op run / infisical run inject secrets into the child process. ---
// The injection itself is safe (value goes process->process). But the WRAPPED command must
// still be vetted, or `op run -- cat .env` / `op run -- printenv KEY` would dump the injected
// secret. So: block a wrapped env/printenv dump outright, then STRIP the `<mgr> run [opts] --`
// prefix and fall through, so every rule below inspects the wrapped command exactly as if it
// had run without the wrapper. Closes the "op run is a skeleton key" bypass.
if (/\b(infisical|op)\s+run\b[^\n;&|]*--\s+(?:['"]?\s*)?(?:env|printenv|run-printenv)\b/i.test(c))
  deny('Runtime injection wrapped around env/printenv still dumps injected secrets to stdout. Run the real command under the secrets manager instead.');
{
  const inj = c.match(/\b(?:infisical|op)\s+run\b[^\n]*?\s--\s+/);
  if (inj) c = c.slice(inj.index + inj[0].length);              // vet the wrapped command below
  else if (/\b(?:infisical|op)\s+run\b/.test(c)) process.exit(0); // `op run` w/ no `-- <cmd>` prints nothing
}

// Remove safe example/sample env files so they don't trip the .env file rule below.
const scrub = c.replace(/\.env\.(example|sample|template)\b/gi, ' ');
const clauses = c.split(/\|\||&&|[;&\n]/).map(s => s.trim()).filter(Boolean);
// Split into simple-command segments so "env FOO=bar cmd" (setter) is distinguished
// from a bare "env" (whole-environment dump).
const segments = c.split(/\|\||&&|[;|&\n]/).map(s => s.trim()).filter(Boolean);
// Readers differ by shell: in PowerShell, cat/type/gc are all Get-Content aliases.
const READ    = isPS ? /\b(Get-Content|gc|type|cat|more|Select-String|sls)\b/i
                     : /\b(cat|bat|less|more|head|tail|nl|xxd|od|strings)\b/;
// Credentials-file rule: reader and the word "credentials" within the same segment.
const CREDRD  = isPS ? /\b(Get-Content|gc|type|cat|more|Select-String|sls)\b[^|;&]*credentials\b/i
                     : /\b(cat|bat|less|more|head|tail)\b[^|;&]*credentials\b/;

// 1. Secrets-manager bulk dumps (any vault, any shell — these are external CLIs)
if (/\binfisical\s+secrets\b(?!\s+set\b)/.test(c)) deny('infisical secrets dumps vault values to stdout. Use `infisical run -- <cmd>` to inject at runtime.');
if (/\binfisical\s+export\b/.test(c))               deny('infisical export prints all secrets. Use `infisical run -- <cmd>`.');
if (/\bbw\s+export\b/.test(c))                       deny('bw export prints your whole Bitwarden vault. Read one item with `bw get` or inject at runtime.');
if (/\bbw\s+list\s+items\b/.test(c))                 deny('bw list items prints item contents including passwords. Use `bw get <id>` for a single field.');
if (/\bop\s+item\s+get\b[^|]*--reveal/.test(c))      deny('op item get --reveal prints field values. Inject the field instead — `op run -- <cmd>` or command substitution `"$(op read op://...)"` — so the value reaches the program, not stdout.');
if (/--plain\b/.test(c))                             deny('--plain forces raw secret values to stdout.');
// `op read` as a LIVE command prints a secret. Detect it on a quote-stripped copy so an `op read`
// that only appears INSIDE a quoted string (e.g. a grep pattern like "a|op read|b") is not a false
// positive — a quoted string can never be the command that runs.
const cUnquoted = c.replace(/"[^"]*"|'[^']*'/g, ' ');
for (const clause of cUnquoted.split(/\|\||&&|[;&\n]/).map(s => s.trim()).filter(Boolean)) {
  const masked = isMaskedClause(clause);
  for (const seg of clause.split('|').map(s => s.trim()).filter(Boolean)) {
    if (/^op\s+read\b/i.test(seg) && !masked)
      deny('op read on its own prints a secret to stdout. Inject it instead — `op run -- <cmd>` or command substitution `"$(op read op://...)"` — or, to just confirm it loaded, print a masked first4 fingerprint with `... | head -c 4`.');
  }
}

// `op read` inside a command substitution that is then PRINTED — `echo "$(op read op://…)"`.
// The quote-strip above deliberately ignores $(...) so that feeding a PROGRAM stays allowed
// (`<tool> "$(op read …)"`); piping it into a print command is the leak. Masked fingerprint OK.
if (!isMaskedClause(c) &&
    /\b(?:echo|printf|print|cat|tee|write-host|write-output|gc)\b[^\n]*(?:\$\(|`)\s*op\s+read\b/i.test(c))
  deny('Printing $(op read …) sends the secret to stdout. Feed it straight to the program (`<tool> "$(op read op://...)"`) instead of echoing it, or verify it loaded with a masked fingerprint `op read … | head -c 4`.');

// 2a. Whole-environment dumps — BASH. Check each command segment for a bare dump form.
if (!isPS) {
  for (const seg of segments) {
    if (/^env(\s+-\S+)*\s*$/.test(seg))            deny('Bare env prints every variable, including injected secrets. Name one non-secret var, e.g. `printenv PATH`.');
    if (/^printenv\s*$/.test(seg))                 deny('Bare printenv prints every variable. Name one var, e.g. `printenv PATH`.');
    if (/^set\s*$/.test(seg))                      deny('Bare `set` dumps all shell variables.');
    if (/^(declare|typeset)\s+-\w*p\w*\s*$/.test(seg)) deny('declare -p dumps all variables.');
    if (/^export\s+-p\s*$/.test(seg))              deny('export -p dumps all exported variables.');
  }
  for (const clause of clauses) {
    const masked = isMaskedClause(clause);
    for (const seg of clause.split('|').map(s => s.trim()).filter(Boolean)) {
      const w = words(seg);
      const cmd = commandName(w[0]);
      const args = w.slice(1);

      if (cmd === 'env') {
        const nonAssignments = args.filter(arg => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && !arg.startsWith('-'));
        if (args.length && nonAssignments.length === 0)
          deny('env with only assignments still prints the full environment. Run a real command after the assignments instead.');
        if (nonAssignments[0] && ['env', 'printenv', 'run-printenv'].includes(commandName(nonAssignments[0])))
          deny('env wrapped around env/printenv still prints environment values.');
        if (nonAssignments.some(isSecretVar) && !masked)
          deny('env references a secret-looking variable in a print-oriented command. Inject secrets into the child process without printing them.');
      }

      if (['printenv', 'run-printenv'].includes(cmd) && args.some(isSecretVar) && !masked)
        deny(`${cmd} would print a secret-looking variable. Verify by using the key, or print only a masked first4 fingerprint with \`... | head -c 4\`.`);

      if (['echo', 'printf'].includes(cmd) && secretEnvRefs(seg).some(isSecretVar) && !masked)
        deny(`${cmd} would print a secret-looking variable. Verify by using the key, or print only a masked first4 fingerprint with \`... | head -c 4\`.`);
    }
  }
  // (No catch-all "env ... | filter" regex here: a bare env/printenv piped into a filter is already
  //  denied above — the `segments` split includes `|`, so `env | grep X` trips the bare-dump rule at
  //  line ~107. The old regex matched the literal word "env" inside a quoted arg — e.g.
  //  `grep 'env' f | head` — which was a false positive with no added coverage.)
}

// 2b. Whole-environment dumps — POWERSHELL. The Env: drive holds injected secrets
// (op run / infisical run populate it). `$env:NAME` single reads are deliberately allowed.
if (isPS) {
  if (/\b(Get-ChildItem|gci|ls|dir)\s+(-\w+\s+)*env:(\\)?\s*(\||;|&|$)/i.test(c))
    deny('Listing the Env: drive prints every environment variable, including injected secrets. Read one with $env:NAME.');
  if (/\[Environment\]::GetEnvironmentVariables/i.test(c))
    deny('[Environment]::GetEnvironmentVariables() dumps all environment variables.');
  for (const seg of segments) {
    if (/^(Get-Variable|gv)\s*$/i.test(seg)) deny('Bare Get-Variable dumps all PowerShell variables, which may hold secrets. Name one: Get-Variable PATH.');
  }
  // Secret-looking variable printed via echo / Write-Output / Write-Host (PS aliases).
  // Mirrors the Bash echo/printf rule so Windows students get the same protection.
  for (const clause of clauses) {
    const masked = isMaskedClause(clause);
    for (const seg of clause.split('|').map(s => s.trim()).filter(Boolean)) {
      const cmd = commandName(words(seg)[0]);
      if (['echo', 'write-host', 'write-output'].includes(cmd) &&
          secretEnvRefs(seg).some(isSecretVar) && !masked)
        deny('Write-Host/Write-Output/echo of a secret-looking variable prints its value to stdout. Inject the secret at runtime; never print a key.');
    }
  }
}

// 3. Reading secret-bearing files
if (READ.test(c) && /\.env\b/.test(scrub))         deny('Reading a .env file prints secrets to stdout. Inject via your secrets manager; do not print the file.');
if (READ.test(c) && /(\.pem|id_rsa|id_ed25519|\.p12|\.pfx)\b/.test(c)) deny('Reading a key/cert file prints private material to stdout.');
if (CREDRD.test(c)) deny('Reading a credentials file prints secrets to stdout.');

// 4. Language-eval exfil of env / .env (shell-independent)
if (/\b(python3?|node|ruby|perl|php)\b[^\n]*(\.env|os\.environ|process\.env|ENV\[)/.test(c))
  deny('Reading env/.env via a language eval routes secrets to stdout.');

// 5. docker compose config renders interpolated secrets
if (/\bdocker\s+compose\s+config\b/.test(c)) deny('docker compose config renders interpolated secrets to stdout.');

process.exit(0);

#!/usr/bin/env node
// ~/.claude/hooks/secrets-guard.js
// PreToolUse hook. Blocks the "dump a secret to stdout" class before it runs.
// Cross-platform: runs on Node (a Claude Code dependency) — Mac, Mac Mini, Windows.
// Covers BOTH the Bash tool and the PowerShell tool (Windows uses both). Bash rules
// include the repo-level block-secret-print parity checks; PowerShell rules are additive.
// Vault-agnostic: covers 1Password (op), Infisical, Bitwarden (bw), and the
// universal leaks (env / cat .env / language-eval) that no vault choice prevents.
// Allows runtime injection (op run / infisical run) unless the wrapped command is
// itself an env dump. Blocks raw op reads; masked first4 checks remain allowed.

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

// Guard both shells. PowerShell is a distinct tool on Windows and would otherwise bypass.
if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
const isPS = input.tool_name === 'PowerShell';
const c = (input.tool_input && input.tool_input.command) || '';
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
  return parts.some(part => ['KEY', 'TOKEN', 'SECRET'].includes(part)) ||
    upper === 'APIKEY' || upper === 'TOKEN' || upper === 'SECRET' ||
    upper.endsWith('_KEY') || upper.endsWith('_TOKEN') || upper.endsWith('_SECRET');
}

function secretEnvRefs(segment) {
  return [...segment.matchAll(/\$(?:env:)?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gi)]
    .map(match => match[1]);
}

function isMaskedClause(clause) {
  return /\|\s*head\s+-c\s*4(?:\D|$)/i.test(clause);
}

// --- ALLOWLIST: runtime injection. Secrets go process->process, never to stdout. ---
// But do not allow a runtime-injected process to be an env dump.
if (/\b(infisical|op)\s+run\b[^\n;&|]*--\s*(?:['"]?\s*)?(?:env|printenv|run-printenv)\b/i.test(c))
  deny('Runtime injection wrapped around env/printenv still dumps injected secrets to stdout. Run the real command under the secrets manager instead.');
if (/\b(infisical|op)\s+run\b/.test(c)) process.exit(0);

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
if (/\bop\s+item\s+get\b[^|]*--reveal/.test(c))      deny('op item get --reveal prints field values. Pipe `op read` of one ref into the consumer instead.');
if (/--plain\b/.test(c))                             deny('--plain forces raw secret values to stdout.');
for (const clause of clauses) {
  if (/(?:^|\|\s*)op\s+read\b/i.test(clause) && !isMaskedClause(clause))
    deny('op read prints a secret value to stdout. Use runtime injection, or print only a masked first4 fingerprint with `... | head -c 4`.');
}

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
  // env / printenv piped into a filter still routes secret values through stdout.
  if (/\b(env|printenv)\b[^|]*\|\s*(grep|rg|ag|awk|sed|cut|sort|head|tail)\b/.test(c))
    deny('Piping env into a filter still routes secret values through stdout.');
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

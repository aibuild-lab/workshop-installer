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
//
// Bypass-hardening (PR #14 review, 8Dvibes):
//   - Runtime-injection wrappers (`op run` / `infisical run`) are neutralized IN PLACE,
//     so every other segment of the command is still vetted. `cat .env && infisical run -- true`
//     no longer slips through by discarding the leading `cat .env`, and a bare wrapper with no
//     `-- <cmd>` is not a blanket allow.
//   - Command names are matched after stripping any leading path (and a Windows .exe/.cmd
//     suffix), so `/usr/bin/env` and `/usr/local/bin/op read` match the same as `env` / `op read`.
//   - Nested shells are inspected recursively: the payload of `sh|bash|zsh -c '<cmd>'` is
//     re-vetted, so `infisical run -- bash -c 'env'` and `bash -c 'op read …'` are caught.
//   - Literal vendor-shaped secrets in a Bash/PowerShell command (printf, heredoc,
//     `node -e writeFileSync`, inline `Authorization: Bearer …`) are blocked, matching the
//     Write/Edit content guard so a shell write is not an escape hatch.

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

// High-confidence secret SHAPES (real vendor key formats). Shared by the Write/Edit content
// guard AND the Bash/PowerShell literal scan, so a literal key is blocked no matter which tool
// writes it. Placeholders, the word "password", and example connection URLs do not match.
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

// --- Write/Edit/NotebookEdit: block a resolved secret from being written INTO a file. ---
// This is the original-incident class (a student pasted a real key into a tracked file) that the
// Bash-only guard never covered.
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
if (WRITE_TOOLS.includes(input.tool_name)) {
  const ti = input.tool_input || {};
  const parts = [ti.content, ti.new_string, ti.new_source, ti.new_str];
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.new_string === 'string') parts.push(e.new_string);
  const body = parts.filter(s => typeof s === 'string').join('\n');
  if (!body) process.exit(0);
  for (const [label, re] of SECRET_SHAPES) {
    if (re.test(body))
      deny(`This write contains what looks like ${label}. Don't hard-code secrets into files — reference them at runtime (op://…, an environment variable, or a .env.example placeholder). If it is a genuine false positive, write a placeholder value instead.`);
  }
  process.exit(0);
}

// Guard both shells. PowerShell is a distinct tool on Windows and would otherwise bypass.
if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
const isPS = input.tool_name === 'PowerShell';
const original = (input.tool_input && input.tool_input.command) || '';
if (!original) process.exit(0);

function words(segment) {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
    .map(w => w.replace(/^(['"])(.*)\1$/, '$2'));
}

// Command identity, path- and extension-stripped: `/usr/bin/env` -> `env`,
// `C:\tools\op.exe` -> `op`. Used everywhere a rule keys off the executable name.
function commandName(word) {
  return (word || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// Strip a leading path/extension from the FIRST token of a segment so anchored rules
// (`^op read`, `^env`, `^printenv`) match path-qualified invocations too. Only the command
// token is rewritten; the arguments are left byte-for-byte intact.
function stripLeadingPath(segment) {
  return String(segment).replace(/^(\s*)(\S+)/, (_, ws, tok) => ws + commandName(tok));
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

// Extract the payload of a nested shell so it can be re-vetted: `bash -c '<cmd>'`,
// `sh -c "<cmd>"`, `zsh -lc '<cmd>'`. Returns the inner command strings.
function extractShellPayloads(cmd) {
  const out = [];
  const re = /\b(?:ba|z)?sh\b[^\n]*?\s-\w*c\w*\s+('([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

// Vet a single command string against every rule. Called for the original command and,
// recursively, for any nested-shell payload it wraps. `deny()` exits the process, so the
// first hit anywhere in the tree short-circuits.
function vet(cRaw, depth) {
  // Neutralize runtime-injection wrappers IN PLACE. `op run` / `infisical run` inject secrets
  // process->process (safe), but the wrapped command must still be vetted, and any sibling
  // segment before/after the wrapper must survive. Replacing only the wrapper TOKEN (not the
  // whole command) keeps `cat .env && infisical run -- true` -> `cat .env && true`, so the
  // leading dump is still caught, and a bare wrapper is dropped rather than blanket-allowed.
  let c = cRaw
    .replace(/\b(?:infisical|op)\s+run\b[^\n]*?\s--\s+/g, ' ')  // `<mgr> run [opts] -- child` -> `child`
    .replace(/\b(?:infisical|op)\s+run\b/g, ' ');               // bare `<mgr> run` prints nothing itself

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

  // 1. Secrets-manager bulk dumps (any vault, any shell — these are external CLIs).
  //    `\b`-anchored, so a leading path (`/usr/local/bin/op item get …`) still matches.
  if (/\binfisical\s+secrets\b(?!\s+set\b)/.test(c)) deny('infisical secrets dumps vault values to stdout. Use `infisical run -- <cmd>` to inject at runtime.');
  if (/\binfisical\s+export\b/.test(c))               deny('infisical export prints all secrets. Use `infisical run -- <cmd>`.');
  if (/\bbw\s+export\b/.test(c))                       deny('bw export prints your whole Bitwarden vault. Read one item with `bw get` or inject at runtime.');
  if (/\bbw\s+list\s+items\b/.test(c))                 deny('bw list items prints item contents including passwords. Use `bw get <id>` for a single field.');
  if (/\bop\s+item\s+get\b[^|]*--reveal/.test(c))      deny('op item get --reveal prints field values. Inject the field instead — `op run -- <cmd>` or command substitution `"$(op read op://...)"` — so the value reaches the program, not stdout.');
  if (/--plain\b/.test(c))                             deny('--plain forces raw secret values to stdout.');
  // `op read` as a LIVE command prints a secret. Detect it on a quote-stripped copy so an `op read`
  // that only appears INSIDE a quoted string (e.g. a grep pattern like "a|op read|b") is not a false
  // positive — a quoted string can never be the command that runs. Path is stripped per-segment so
  // `/usr/local/bin/op read …` is caught the same as `op read …`.
  const cUnquoted = c.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const clause of cUnquoted.split(/\|\||&&|[;&\n]/).map(s => s.trim()).filter(Boolean)) {
    const masked = isMaskedClause(clause);
    for (const seg of clause.split('|').map(s => s.trim()).filter(Boolean)) {
      if (/^op\s+read\b/i.test(stripLeadingPath(seg)) && !masked)
        deny('op read on its own prints a secret to stdout. Inject it instead — `op run -- <cmd>` or command substitution `"$(op read op://...)"` — or, to just confirm it loaded, print a masked first4 fingerprint with `... | head -c 4`.');
    }
  }

  // `op read` inside a command substitution that is then PRINTED — `echo "$(op read op://…)"`.
  if (!isMaskedClause(c) &&
      /\b(?:echo|printf|print|cat|tee|write-host|write-output|gc)\b[^\n]*(?:\$\(|`)\s*(?:[^\s()`]*[\\/])?op\s+read\b/i.test(c))
    deny('Printing $(op read …) sends the secret to stdout. Feed it straight to the program (`<tool> "$(op read op://...)"`) instead of echoing it, or verify it loaded with a masked fingerprint `op read … | head -c 4`.');

  // 2a. Whole-environment dumps — BASH. Check each command segment for a bare dump form
  //     (path-normalized so `/usr/bin/env` and `/usr/bin/printenv` are caught).
  if (!isPS) {
    for (const seg0 of segments) {
      const seg = stripLeadingPath(seg0);
      if (/^env(\s+-\S+)*\s*$/.test(seg))                deny('Bare env prints every variable, including injected secrets. Name one non-secret var, e.g. `printenv PATH`.');
      if (/^(printenv|run-printenv)\s*$/.test(seg))      deny('Bare printenv prints every variable. Name one var, e.g. `printenv PATH`.');
      if (/^set\s*$/.test(seg))                          deny('Bare `set` dumps all shell variables.');
      if (/^(declare|typeset)\s+-\w*p\w*\s*$/.test(seg)) deny('declare -p dumps all variables.');
      if (/^export\s+-p\s*$/.test(seg))                  deny('export -p dumps all exported variables.');
    }
    for (const clause of clauses) {
      const masked = isMaskedClause(clause);
      for (const seg of clause.split('|').map(s => s.trim()).filter(Boolean)) {
        const w = words(seg);
        const cmd = commandName(w[0]);
        const args = w.slice(1);

        if (cmd === 'env') {
          const nonAssignments = args.filter(arg => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && !arg.startsWith('-'));
          if (nonAssignments.length === 0)
            deny('env with no trailing command still prints the full environment. Run a real command after any assignments instead.');
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

  // 3. Reading secret-bearing files.
  if (READ.test(c) && /\.env\b/.test(scrub))         deny('Reading a .env file prints secrets to stdout. Inject via your secrets manager; do not print the file.');
  if (READ.test(c) && /(\.pem|id_rsa|id_ed25519|\.p12|\.pfx)\b/.test(c)) deny('Reading a key/cert file prints private material to stdout.');
  if (CREDRD.test(c)) deny('Reading a credentials file prints secrets to stdout.');

  // 4. Language-eval exfil of env / .env (shell-independent).
  if (/\b(python3?|node|ruby|perl|php)\b[^\n]*(\.env|os\.environ|process\.env|ENV\[)/.test(c))
    deny('Reading env/.env via a language eval routes secrets to stdout.');

  // 5. docker compose config renders interpolated secrets.
  if (/\bdocker\s+compose\s+config\b/.test(c)) deny('docker compose config renders interpolated secrets to stdout.');

  // 6. Recurse into nested shells: the payload of `sh|bash|zsh -c '<cmd>'` is a real command
  //    that must be vetted too. Depth-bounded so a pathological nest cannot spin.
  if (depth < 4) for (const payload of extractShellPayloads(c)) vet(payload, depth + 1);
}

// Literal vendor-shaped secret embedded directly in the command text (printf / heredoc /
// `node -e writeFileSync` / inline `Authorization: Bearer sk-…`). Scanned on the raw command
// so nesting and wrappers can't hide it. Mirrors the Write/Edit content guard.
for (const [label, re] of SECRET_SHAPES) {
  if (re.test(original))
    deny(`This command embeds what looks like ${label}. Don't hard-code secrets in commands — inject them at runtime (\`op run -- …\`, \`infisical run -- …\`, or \`"$(op read op://...)"\`).`);
}

vet(original, 0);

process.exit(0);

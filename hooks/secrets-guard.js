#!/usr/bin/env node
// ~/.claude/hooks/secrets-guard.js
// PreToolUse hook. Blocks the "dump a secret to stdout" class before it runs.
// Cross-platform: runs on Node (a Claude Code dependency) — Mac, Mac Mini, Windows.
// Vault-agnostic: covers 1Password (op), Infisical, Bitwarden (bw), and the
// universal leaks (env / cat .env / language-eval) that no vault choice prevents.
// Allows runtime injection (op run / infisical run) and single-ref reads (op read / bw get).
// Single-secret bare reads are caught by the PostToolUse tripwire, not blocked here,
// so normal workflows never get a false "denied".

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

if (input.tool_name !== 'Bash') process.exit(0);
const c = (input.tool_input && input.tool_input.command) || '';
if (!c) process.exit(0);

// --- ALLOWLIST: runtime injection. Secrets go process->process, never to stdout. ---
if (/\b(infisical|op)\s+run\b/.test(c)) process.exit(0);

// Remove safe example/sample env files so they don't trip the .env file rule below.
const scrub = c.replace(/\.env\.(example|sample|template)\b/gi, ' ');
// Split into simple-command segments so "env FOO=bar cmd" (setter) is distinguished
// from a bare "env" (whole-environment dump).
const segments = c.split(/\|\||&&|[;|&\n]/).map(s => s.trim()).filter(Boolean);
const READ = /\b(cat|bat|less|more|head|tail|nl|xxd|od|strings)\b/;

// 1. Secrets-manager bulk dumps (any vault)
if (/\binfisical\s+secrets\b(?!\s+set\b)/.test(c)) deny('infisical secrets dumps vault values to stdout. Use `infisical run -- <cmd>` to inject at runtime.');
if (/\binfisical\s+export\b/.test(c))               deny('infisical export prints all secrets. Use `infisical run -- <cmd>`.');
if (/\bbw\s+export\b/.test(c))                       deny('bw export prints your whole Bitwarden vault. Read one item with `bw get` or inject at runtime.');
if (/\bbw\s+list\s+items\b/.test(c))                 deny('bw list items prints item contents including passwords. Use `bw get <id>` for a single field.');
if (/\bop\s+item\s+get\b[^|]*--reveal/.test(c))      deny('op item get --reveal prints field values. Pipe `op read` of one ref into the consumer instead.');
if (/--plain\b/.test(c))                             deny('--plain forces raw secret values to stdout.');

// 2. Whole-environment dumps — check each command segment for a bare dump form.
for (const seg of segments) {
  if (/^env(\s+-\S+)*\s*$/.test(seg))            deny('Bare env prints every variable, including injected secrets. Name one non-secret var, e.g. `printenv PATH`.');
  if (/^printenv\s*$/.test(seg))                 deny('Bare printenv prints every variable. Name one var, e.g. `printenv PATH`.');
  if (/^set\s*$/.test(seg))                      deny('Bare `set` dumps all shell variables.');
  if (/^(declare|typeset)\s+-\w*p\w*\s*$/.test(seg)) deny('declare -p dumps all variables.');
  if (/^export\s+-p\s*$/.test(seg))              deny('export -p dumps all exported variables.');
}
// env / printenv piped into a filter still routes secret values through stdout.
if (/\b(env|printenv)\b[^|]*\|\s*(grep|rg|ag|awk|sed|cut|sort|head|tail)\b/.test(c))
  deny('Piping env into a filter still routes secret values through stdout.');

// 3. Reading secret-bearing files
if (READ.test(c) && /\.env\b/.test(scrub))         deny('Reading a .env file prints secrets to stdout. Inject via your secrets manager; do not print the file.');
if (READ.test(c) && /(\.pem|id_rsa|id_ed25519|\.p12|\.pfx)\b/.test(c)) deny('Reading a key/cert file prints private material to stdout.');
if (/\b(cat|bat|less|more|head|tail)\b[^|;&]*credentials\b/.test(c)) deny('Reading a credentials file prints secrets to stdout.');

// 4. Language-eval exfil of env / .env
if (/\b(python3?|node|ruby|perl|php)\b[^\n]*(\.env|os\.environ|process\.env|ENV\[)/.test(c))
  deny('Reading env/.env via a language eval routes secrets to stdout.');

// 5. docker compose config renders interpolated secrets
if (/\bdocker\s+compose\s+config\b/.test(c)) deny('docker compose config renders interpolated secrets to stdout.');

process.exit(0);

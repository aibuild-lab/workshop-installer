#!/usr/bin/env node
// op-tripwire: detector-rule
// ~/.claude/hooks/secrets-guard.js
// PreToolUse hook. Blocks the "dump a secret to stdout" class before it runs.
// Cross-platform: runs on Node (a Claude Code dependency) - Mac, Mac Mini, Windows.
// Covers BOTH the Bash tool and the PowerShell tool (Windows uses both). Bash rules
// include the repo-level block-secret-print parity checks; PowerShell rules are additive
// (Env: drive dumps + Write-Host/Write-Output/echo of a secret-looking $env: var).
// Secret-name match spans KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL forms on both shells.
// Vault-agnostic: covers 1Password (op), Infisical, Bitwarden (bw), and the
// universal leaks (env / cat .env / language-eval) that no vault choice prevents.
// Allows runtime injection (op run / infisical run) but re-vets the WRAPPED command, so
// `op run -- cat .env` can't dump. Blocks raw op reads AND printed `$(op read …)` command
// substitution; feeding a program `"$(op read …)"` and masked first4 checks stay allowed.
// Remote-exec and wrapper forms (ssh, docker/kubectl exec, sudo, nohup, timeout, su -c,
// find -exec) are likewise unwrapped so the inner command faces the same rules as a local run.

const fs = require('fs');

const SECRET_SHAPES = [
  ['an Anthropic API key',      /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ['a Langfuse secret key',     /\bsk-lf-[A-Za-z0-9_-]{12,}/],
  ['an OpenAI-style key',       /\bsk-(?!ant-|lf-)(?:proj-)?[A-Za-z0-9_-]{20,}/],
  // Behaviour unchanged: a BEGIN header alone is still a deny, deliberately. Requiring key material
  // in the same payload would let a key written in CHUNKS through (multiple Edits, or a truncated
  // tool payload), which is a worse trade than the friction of blocking a header in prose. The
  // escape hatch is the deny message's own advice: write a placeholder instead.
  // Written as -{5} rather than five literal dashes, which is the identical regex but stops this
  // file from tripping its own scanner when a guarded agent edits it.
  ['a private key block',       /-{5}BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-{5}/],
  ['an AWS access key id',      /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token',            /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['a Slack token',             /\b(?:xox[bpsar]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/],
  ['a Supabase secret',         /\bsb_secret_[A-Za-z0-9_-]{12,}/],
  ['a 1Password service token', /\bops_[A-Za-z0-9]{40,}/],
  ['an Apify token',            /\bapify_api_[A-Za-z0-9]{20,}/],
  ['a Firecrawl key',           /\bfc-[A-Za-z0-9]{20,}/],
  ['a Google API key',          /\bAIza[0-9A-Za-z_-]{35}\b/],
  // Live keys only. sk_test_ is deliberately excluded: Stripe's own tutorials paste test keys
  // constantly, so matching them would generate false positives during ordinary coursework.
  ['a Stripe secret key',       /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
];

function findSecretShape(text) {
  return SECRET_SHAPES.find(([, re]) => re.test(text));
}

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
  const shape = findSecretShape(body);
  if (shape)
    deny(`This write contains what looks like ${shape[0]}. Don't hard-code secrets into files - inject them from Infisical at runtime, reference an environment variable name, or write a .env.example placeholder. If it is a genuine false positive, write a placeholder value instead.`);
  process.exit(0);
}

// Guard both shells. PowerShell is a distinct tool on Windows and would otherwise bypass.
if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
const isPS = input.tool_name === 'PowerShell';
const c = (input.tool_input && input.tool_input.command) || '';
if (!c) process.exit(0);

function words(segment) {
  const tokens = [];
  let token = '';
  let started = false;
  let quote = '';
  let escaped = false;

  function push() {
    if (started) tokens.push(token);
    token = '';
    started = false;
  }

  for (const ch of String(segment || '')) {
    if (escaped) {
      token += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else token += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    token += ch;
    started = true;
  }
  if (escaped) token += '\\';
  push();
  return tokens;
}

function commandName(word) {
  return (word || '').split(/[\\/]/).pop().toLowerCase();
}

// Split shell syntax only at operators that are outside quotes. Besides avoiding false
// positives for safe searches such as `grep "env|op read"`, this lets us inspect every
// command before and after an injection wrapper without throwing either side away.
function splitShell(command, splitPipes) {
  const parts = [];
  let start = 0;
  let quote = '';
  let escaped = false;

  function push(end) {
    const part = command.slice(start, end).trim();
    if (part) parts.push(part);
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }

    const doublePipe = ch === '|' && command[i + 1] === '|';
    const doubleAmp = ch === '&' && command[i + 1] === '&';
    const redirectAmp = ch === '&' && i > 0 && command[i - 1] === '>';
    const separator = ch === '\n' || ch === ';' || doublePipe || doubleAmp ||
      (!redirectAmp && ch === '&') || (splitPipes && ch === '|');
    if (!separator) continue;

    push(i);
    if (doublePipe || doubleAmp) i++;
    start = i + 1;
  }
  push(command.length);
  return parts;
}

// Return the utility payload of an env invocation. Options with operands must consume those
// operands before we decide whether a real child exists; otherwise a safe form such as
// `env -u INFISICAL_TOKEN /bin/true` looks like an attempt to print INFISICAL_TOKEN.
function envPayload(tokens, depth = 0) {
  if (!tokens.length || commandName(tokens[0]) !== 'env') return null;
  if (depth > 4) return [];

  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === '--') return envPayload(['env', ...args.slice(i + 1)], depth + 1) || [];

    if (arg === '-S' || arg === '--split-string') {
      if (i + 1 >= args.length) return [];
      return envPayload(['env', ...words(args[i + 1]), ...args.slice(i + 2)], depth + 1) || [];
    }
    if (/^-S.+/.test(arg))
      return envPayload(['env', ...words(arg.slice(2)), ...args.slice(i + 1)], depth + 1) || [];
    if (arg.startsWith('--split-string='))
      return envPayload(['env', ...words(arg.slice('--split-string='.length)), ...args.slice(i + 1)], depth + 1) || [];

    if (['-u', '-C', '-P', '-a', '--unset', '--chdir', '--argv0'].includes(arg)) {
      i++;
      continue;
    }
    if (/^-(?:u|C|P|a).+/.test(arg) || /^--(?:unset|chdir|argv0)=/.test(arg)) continue;
    if (arg.startsWith('-')) continue;
    return args.slice(i);
  }
  return [];
}

function renderTokens(tokens) {
  return tokens.map(token => /[\s;&|]/.test(token) ? JSON.stringify(token) : token).join(' ');
}

// Options that take a SEPARATE operand token for each wrapper we unwrap. `--opt=value` and glued
// short forms (`-p2222`) are single tokens and need no entry. Anything not listed is treated as a
// flag, so an unknown operand option shifts parsing right by one token - a miss, never a false deny.
const SSH_OPERAND_OPTIONS = ['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'];
const DOCKER_EXEC_OPERAND_OPTIONS = ['-u', '--user', '-e', '--env', '-w', '--workdir', '--env-file', '--index'];
const KUBECTL_OPERAND_OPTIONS = ['-c', '--container', '-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--as', '--as-group', '--as-uid', '-s', '--server', '--token', '--certificate-authority', '--client-certificate', '--client-key', '--request-timeout', '--pod-running-timeout', '-f', '--filename', '-o', '--output'];
const SUDO_OPERAND_OPTIONS = ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user', '-r', '--role', '-t', '--type'];
const TIMEOUT_OPERAND_OPTIONS = ['-s', '--signal', '-k', '--kill-after'];

// Skip a wrapper's option tokens to reach its first positional argument. `--` ends option parsing.
function skipOptionTokens(tokens, start, operandOptions) {
  let i = start;
  while (i < tokens.length) {
    const arg = tokens[i];
    if (arg === '--') return i + 1;
    if (!arg.startsWith('-') || arg === '-') return i;
    i += operandOptions.includes(arg) ? 2 : 1;
  }
  return i;
}

// Build a conservative inspection set without executing anything. Keep the original command,
// then add runtime-injected children, env payloads, shell -c bodies, and remote-exec/wrapper
// payloads recursively. This closes both the prefix-loss bypass and nested-shell/path-qualified
// variants while preserving quoted grep patterns as inert arguments.
function collectInspectionCommands(root) {
  const commands = [];
  const seen = new Set();

  function remember(command) {
    const value = String(command || '').trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      commands.push(value);
    }
  }

  function inspectTokens(tokens, depth, includeCommand = true) {
    if (!tokens.length || depth > 8) return;
    if (includeCommand) remember(renderTokens(tokens));

    for (let i = 0; i + 1 < tokens.length; i++) {
      if (!['infisical', 'op'].includes(commandName(tokens[i])) || tokens[i + 1].toLowerCase() !== 'run') continue;
      const delimiter = tokens.indexOf('--', i + 2);
      if (delimiter >= 0 && delimiter + 1 < tokens.length)
        inspectTokens(tokens.slice(delimiter + 1), depth + 1, true);
    }

    const payload = envPayload(tokens);
    const effective = payload === null ? tokens : payload;
    if (payload && payload.length) inspectTokens(payload, depth + 1, true);
    if (!effective.length) return;

    const executable = commandName(effective[0]);
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(executable)) {
      const commandIndex = effective.findIndex((arg, index) => index > 0 &&
        (arg === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)));
      if (commandIndex >= 0 && commandIndex + 1 < effective.length)
        inspectCommand(effective[commandIndex + 1], depth + 1);
    }

    // Remote-exec and wrapper forms must face the same rules as a local run, so unwrap each to
    // its inner command and inspect that too: `ssh host "cat .env"` is the same leak as
    // `bash -c 'cat .env'`, only routed through a remote shell. (Student report - Douglas Rimer:
    // a real Postgres password printed through an ssh-wrapped command the guard never opened.)
    if (executable === 'ssh') {
      const hostIndex = skipOptionTokens(effective, 1, SSH_OPERAND_OPTIONS);
      // ssh joins post-host arguments with spaces to build the remote command line.
      if (hostIndex + 1 < effective.length)
        inspectCommand(effective.slice(hostIndex + 1).join(' '), depth + 1);
    }
    if (['docker', 'kubectl'].includes(executable)) {
      const execIndex = effective.findIndex((arg, index) => index > 0 && arg === 'exec');
      if (execIndex >= 0) {
        const operandOptions = executable === 'docker' ? DOCKER_EXEC_OPERAND_OPTIONS : KUBECTL_OPERAND_OPTIONS;
        const targetIndex = skipOptionTokens(effective, execIndex + 1, operandOptions);
        let childIndex = targetIndex + 1;
        if (executable === 'kubectl' && effective[childIndex] === '--') childIndex++;
        if (targetIndex < effective.length && childIndex < effective.length)
          inspectTokens(effective.slice(childIndex), depth + 1, true);
      }
    }
    if (['sudo', 'nohup'].includes(executable)) {
      const operandOptions = executable === 'sudo' ? SUDO_OPERAND_OPTIONS : [];
      let childIndex = skipOptionTokens(effective, 1, operandOptions);
      while (childIndex < effective.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(effective[childIndex])) childIndex++;
      if (childIndex < effective.length) inspectTokens(effective.slice(childIndex), depth + 1, true);
    }
    if (executable === 'timeout') {
      const durationIndex = skipOptionTokens(effective, 1, TIMEOUT_OPERAND_OPTIONS);
      if (durationIndex + 1 < effective.length)
        inspectTokens(effective.slice(durationIndex + 1), depth + 1, true);
    }
    if (executable === 'su') {
      for (let i = 1; i < effective.length; i++) {
        if (effective[i] === '-c' || effective[i] === '--command') {
          if (i + 1 < effective.length) inspectCommand(effective[i + 1], depth + 1);
          break;
        }
        if (effective[i].startsWith('--command=')) {
          inspectCommand(effective[i].slice('--command='.length), depth + 1);
          break;
        }
      }
    }
    if (executable === 'find') {
      for (let i = 1; i < effective.length; i++) {
        if (effective[i] !== '-exec' && effective[i] !== '-execdir') continue;
        let end = effective.findIndex((arg, index) => index > i && (arg === ';' || arg === '+'));
        if (end < 0) end = effective.length;
        if (end > i + 1) inspectTokens(effective.slice(i + 1, end), depth + 1, true);
      }
    }
  }

  function inspectCommand(command, depth) {
    if (depth > 8) return;
    remember(command);
    for (const segment of splitShell(command, true)) inspectTokens(words(segment), depth + 1, false);
  }

  inspectCommand(root, 0);
  return commands;
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
// still be vetted, and commands before/after the wrapper must never disappear from inspection.
// collectInspectionCommands keeps the full command and recursively adds only executable payloads.
const literalShape = findSecretShape(c);
if (literalShape)
  deny(`This shell command contains what looks like ${literalShape[0]}. Do not place literal secrets in Bash or PowerShell commands; inject them at runtime.`);

const inspectionCommands = collectInspectionCommands(c);
const inspection = inspectionCommands.join('\n');

const clauses = inspectionCommands.flatMap(command => splitShell(command, false));
// Split into simple-command segments so "env FOO=bar cmd" (setter) is distinguished
// from a bare "env" (whole-environment dump).
const segments = inspectionCommands.flatMap(command => splitShell(command, true));
// Readers differ by shell: in PowerShell, cat/type/gc are all Get-Content aliases. Match the
// executable token, not words inside quoted grep patterns or an unrelated neighboring command.
const READ_COMMANDS = new Set((isPS
  ? ['get-content', 'gc', 'type', 'cat', 'more', 'select-string', 'sls']
  : ['cat', 'bat', 'less', 'more', 'head', 'tail', 'nl', 'xxd', 'od', 'strings']));

// 1. Secrets-manager bulk dumps (any vault, any shell - these are external CLIs)
if (/\binfisical\s+secrets\b(?!\s+set\b)/.test(inspection)) deny('infisical secrets dumps vault values to stdout. Use `infisical run -- <cmd>` to inject at runtime.');
if (/\binfisical\s+export\b/.test(inspection))               deny('infisical export prints all secrets. Use `infisical run -- <cmd>`.');
if (/\bbw\s+export\b/.test(inspection))                       deny('bw export prints your whole Bitwarden vault. Read one item with `bw get` or inject at runtime.');
if (/\bbw\s+list\s+items\b/.test(inspection))                 deny('bw list items prints item contents including passwords. Use `bw get <id>` for a single field.');
if (/\bop\s+item\s+get\b[^|]*--reveal/.test(inspection))      deny('op item get --reveal prints field values. Use Infisical runtime injection for non-human consumers; keep 1Password use interactive and human-only.');
if (/\bsupabase\s+projects\s+api-keys\b[^|]*--reveal/i.test(inspection)) deny('supabase projects api-keys --reveal prints project secrets.');
if (/--plain\b/.test(inspection))                             deny('--plain forces raw secret values to stdout.');
// `op read` as a LIVE command prints a secret. Token inspection distinguishes an executable
// (including a path-qualified one or a nested shell payload) from inert quoted grep text.
for (const clause of clauses) {
  const masked = isMaskedClause(clause);
  for (const seg of splitShell(clause, true)) {
    const tokens = words(seg);
    if (commandName(tokens[0]) === 'op' && String(tokens[1] || '').toLowerCase() === 'read' && !masked)
      deny('op read on its own prints a secret to stdout. Use Infisical runtime injection for non-human consumers; keep 1Password use interactive and human-only. To confirm an approved value loaded, print only a masked first4 fingerprint with `... | head -c 4`.');
  }
}

// `op read` inside a command substitution that is then PRINTED - `echo "$(op read op://…)"`.
// The quote-strip above deliberately ignores $(...) so that feeding a PROGRAM stays allowed
// (`<tool> "$(op read …)"`); piping it into a print command is the leak. Masked fingerprint OK.
if (!isMaskedClause(inspection) &&
    /\b(?:echo|printf|print|cat|tee|write-host|write-output|gc)\b[^\n]*(?:\$\(|`)\s*(?:[^\s"'`]+[\\/])?op\s+read\b/i.test(inspection))
  deny('Printing $(op read …) sends the secret to stdout. Use Infisical runtime injection for non-human consumers; keep 1Password use interactive and human-only. For approved verification, print only a masked first4 fingerprint.');

// 2a. Whole-environment dumps - BASH. Check each command segment for a bare dump form.
if (!isPS) {
  for (const seg of segments) {
    const tokens = words(seg);
    const cmd = commandName(tokens[0]);
    if (cmd === 'env' && envPayload(tokens)?.length === 0)
      deny('env without a utility payload prints the environment, including injected secrets. Run a real command after its options and assignments.');
    if (['printenv', 'run-printenv'].includes(cmd) && tokens.length === 1)
      deny('Bare printenv prints every variable. Name one non-secret var, e.g. `printenv PATH`.');
    if (cmd === 'set' && tokens.length === 1) deny('Bare `set` dumps all shell variables.');
    if (['declare', 'typeset'].includes(cmd) && tokens.slice(1).some(arg => /^-\w*p\w*$/.test(arg)))
      deny('declare -p dumps all variables.');
    if (cmd === 'export' && tokens[1] === '-p') deny('export -p dumps all exported variables.');
  }
  for (const clause of clauses) {
    const masked = isMaskedClause(clause);
    for (const seg of splitShell(clause, true)) {
      const w = words(seg);
      const cmd = commandName(w[0]);
      const args = w.slice(1);

      if (['printenv', 'run-printenv'].includes(cmd) && args.some(isSecretVar) && !masked)
        deny(`${cmd} would print a secret-looking variable. Verify by using the key, or print only a masked first4 fingerprint with \`... | head -c 4\`.`);

      if (['echo', 'printf'].includes(cmd) && secretEnvRefs(seg).some(isSecretVar) && !masked)
        deny(`${cmd} would print a secret-looking variable. Verify by using the key, or print only a masked first4 fingerprint with \`... | head -c 4\`.`);
    }
  }
  // (No catch-all "env ... | filter" regex here: a bare env/printenv piped into a filter is already
  //  denied above - the `segments` split includes `|`, so `env | grep X` trips the bare-dump rule at
  //  line ~107. The old regex matched the literal word "env" inside a quoted arg - e.g.
  //  `grep 'env' f | head` - which was a false positive with no added coverage.)
}

// 2b. Whole-environment dumps - POWERSHELL. The Env: drive holds injected secrets
// (op run / infisical run populate it). `$env:NAME` single reads are deliberately allowed.
if (isPS) {
  if (/\b(Get-ChildItem|gci|ls|dir)\s+(-\w+\s+)*env:(\\)?\s*(\||;|&|$)/i.test(inspection))
    deny('Listing the Env: drive prints every environment variable, including injected secrets. Read one with $env:NAME.');
  if (/\[Environment\]::GetEnvironmentVariables/i.test(inspection))
    deny('[Environment]::GetEnvironmentVariables() dumps all environment variables.');
  for (const seg of segments) {
    if (/^(Get-Variable|gv)\s*$/i.test(seg)) deny('Bare Get-Variable dumps all PowerShell variables, which may hold secrets. Name one: Get-Variable PATH.');
  }
  // Secret-looking variable printed via echo / Write-Output / Write-Host (PS aliases).
  // Mirrors the Bash echo/printf rule so Windows students get the same protection.
  for (const clause of clauses) {
    const masked = isMaskedClause(clause);
    for (const seg of splitShell(clause, true)) {
      const cmd = commandName(words(seg)[0]);
      if (['echo', 'write-host', 'write-output'].includes(cmd) &&
          secretEnvRefs(seg).some(isSecretVar) && !masked)
        deny('Write-Host/Write-Output/echo of a secret-looking variable prints its value to stdout. Inject the secret at runtime; never print a key.');
    }
  }
}

// 3. Reading secret-bearing files
for (const segment of segments) {
  const tokens = words(segment);
  if (!READ_COMMANDS.has(commandName(tokens[0]))) continue;
  const args = tokens.slice(1).join(' ');
  const safeArgs = args.replace(/\.env\.(example|sample|template)\b/gi, ' ');
  if (/\.env\b/i.test(safeArgs))
    deny('Reading a .env file prints secrets to stdout. Inject via your secrets manager; do not print the file.');
  if (/(\.pem|id_rsa|id_ed25519|\.p12|\.pfx)\b/i.test(args))
    deny('Reading a key/cert file prints private material to stdout.');
  if (/credentials\b/i.test(args)) deny('Reading a credentials file prints secrets to stdout.');
}

// 4. Language-eval exfil of env / .env (shell-independent)
if (/\b(python3?|node|ruby|perl|php)\b[^\n]*(\.env|os\.environ|process\.env|ENV\[)/.test(inspection))
  deny('Reading env/.env via a language eval routes secrets to stdout.');

// 5. docker compose config renders interpolated secrets
if (/\bdocker\s+compose\s+config\b/.test(inspection)) deny('docker compose config renders interpolated secrets to stdout.');

process.exit(0);

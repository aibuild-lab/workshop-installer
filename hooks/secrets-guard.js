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
  ['a private key block',       /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['an AWS access key id',      /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token',            /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['a Slack token',             /\b(?:xox[bpsar]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/],
  ['a Supabase secret',         /\bsb_secret_[A-Za-z0-9_-]{12,}/],
  ['a 1Password service token', /\bops_[A-Za-z0-9]{40,}/],
  ['an Apify token',            /\bapify_api_[A-Za-z0-9]{20,}/],
  ['a Firecrawl key',           /\bfc-[A-Za-z0-9]{20,}/],
  ['a Google API key',          /\bAIza[0-9A-Za-z_-]{35}\b/],
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
// A hook that throws runs before EVERY tool call, so an unexpected payload shape must exit
// quietly rather than crash the session. `null` parses fine and is not an object.
if (!input || typeof input !== 'object') process.exit(0);

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
// Only a string is inspectable. A number/object/array command would throw in splitShell.
const rawCommand = input.tool_input && input.tool_input.command;
const c = typeof rawCommand === 'string' ? rawCommand : '';
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

// Union of every wrapper's operand options, used when unwrapping an UNKNOWN front-end. An
// unlisted operand option shifts parsing right by one token - a miss, never a false deny.
const GENERIC_OPERAND_OPTIONS = [...new Set([
  ...DOCKER_EXEC_OPERAND_OPTIONS, ...KUBECTL_OPERAND_OPTIONS, ...SUDO_OPERAND_OPTIONS,
  '-v', '--volume', '--name', '--entrypoint', '--platform', '--network', '-p', '--publish',
  '-a', '--app', '-r', '--remote', '-t', '--tag', '--project', '--zone', '--region', '--config',
])];

// Flags whose VALUE is a command to run somewhere else. Every hosting CLI spells "run this over
// there" differently, but they all hand the command to a flag - so key on the flag shape rather
// than on the vendor name. `-c` stays shell-only: too many tools use it for "count"/"config".
const NESTED_COMMAND_FLAGS = new Set([
  '-C', '--command', '--commands', '--ssh-command', '--remote-command',
  '--scripts', '--script', '--exec', '--entrypoint', '--run', '--cmd',
]);

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

    // --- Fail closed on UNRECOGNISED front-ends. (agent-native-os#94, classes 1 and 2.) ---
    // Enumerating wrappers by binary name is a race against every new container runtime and
    // hosting CLI: `docker compose exec` was covered while `docker-compose exec` was not, and
    // podman / nerdctl / lxc / incus / fly / gcloud / az / heroku / railway / doctl all shipped
    // their own spelling of the same operation. Key on the two SHAPES they share instead, so a
    // runtime nobody has heard of yet is unwrapped on the day it ships.
    for (let i = 1; i < effective.length; i++) {
      const arg = effective[i];
      const eq = arg.indexOf('=');
      if (eq > 0 && NESTED_COMMAND_FLAGS.has(arg.slice(0, eq)))
        inspectCommand(arg.slice(eq + 1), depth + 1);
      else if (NESTED_COMMAND_FLAGS.has(arg) && i + 1 < effective.length)
        inspectCommand(effective.slice(i + 1).join(' '), depth + 1);
    }

    const verbIndex = effective.findIndex((arg, index) => index > 0 && (arg === 'exec' || arg === 'run'));
    if (verbIndex > 0) {
      let target = skipOptionTokens(effective, verbIndex + 1, GENERIC_OPERAND_OPTIONS);
      if (effective[target] === '--') target++;
      // `<tool> run <cmd>` - heroku/railway style, command sits at the first positional.
      if (target < effective.length) inspectTokens(effective.slice(target), depth + 1, true);
      // `<tool> exec <container> <cmd>` / `<tool> run <image> <cmd>` - command follows the target.
      let child = target + 1;
      if (effective[child] === '--') child++;
      if (child < effective.length) inspectTokens(effective.slice(child), depth + 1, true);
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

const SHELL_KEYWORDS = new Set(['do', 'done', 'then', 'else', 'elif', 'fi', 'esac', 'case', 'if',
  'while', 'for', 'until', 'function', 'in', 'select', 'time', 'return', 'exit', 'local', 'declare']);

// Resolve the binary a segment actually invokes, or null when the leading token is not a clean
// command name: a heredoc body line, a shell keyword, a `VAR=$(...)` assignment, a bare `{`.
// The verb rules below are subcommand-shaped and would otherwise fire on prose and on fragments
// the tokenizer could not resolve - measured at 253 false positives before this gate existed.
function resolveBinary(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) && !tokens[i].includes('$(')) i++;
  const name = commandName(tokens[i]);
  if (!name || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name)) return null;
  return SHELL_KEYWORDS.has(name) ? null : name;
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
// Whole-file printers: every non-option token is a filename. The Bash list is POSIX text
// utilities - a set that has not gained a member in decades, unlike the vendor-CLI lists.
const READ_COMMANDS = new Set((isPS
  ? ['get-content', 'gc', 'type', 'cat', 'more', 'select-string', 'sls']
  : ['cat', 'bat', 'less', 'more', 'head', 'tail', 'nl', 'xxd', 'od', 'strings', 'tac',
     'sort', 'uniq', 'tee', 'rev', 'fold', 'paste', 'join', 'column', 'expand', 'unexpand',
     'pr', 'base64', 'base32', 'hexdump', 'cut', 'shuf', 'split', 'csplit', 'dd', 'cmp']));
// Pattern-taking readers: the first positional is a search pattern or filter EXPRESSION, not a
// file. Skipping it keeps `grep -n "cat .env" notes.md` and `jq .env config.json` allowed while
// `grep . .env` is caught. PowerShell uses named parameters, so this does not apply there.
const PATTERN_READ_COMMANDS = new Set(isPS ? []
  : ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'jq', 'yq']);

const SECRET_PATH_RULES = [
  [/\.env\b/i, true,
    'Reading a .env file prints secrets to stdout. Inject via your secrets manager; do not print the file.'],
  [/(\.pem|id_rsa|id_ed25519|id_ecdsa|\.p12|\.pfx|\.jks|\.keystore)\b/i, false,
    'Reading a key/cert file prints private material to stdout.'],
  [/credentials\b/i, false, 'Reading a credentials file prints secrets to stdout.'],
  // The OS hands the process environment over as a file, so it belongs with the other secret
  // paths rather than as a standalone text match. Routing it through the reader rule means it
  // fires when something READS it and not when a commit message or PR body mentions the path.
  [/\/proc\/[^/\s]+\/environ\b/, false,
    'That path is the raw process environment. Take the one value you need from your secrets manager instead.'],
];

const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

// A read whose OUTPUT cannot contain a value is not a leak. `grep -c` prints a count;
// `grep -oE '^LANGFUSE_[A-Z_]+'` prints variable NAMES. This mirrors the masked-fingerprint
// allowance already in the guard (`... | head -c 4`): confirming a key is PRESENT is fine,
// printing its value is not. Measured against real history this is how a .env gets audited
// without being read, and blocking it would push people back toward `cat`.
// Names-only requires: -o with an anchored pattern that has no `.` wildcard and either no `=`
// at all or nothing after it, so `grep -o '^[A-Z_]+=[^ ]+' .env` is still denied.
function isNamesOnlyRead(cmd, tokens) {
  if (!GREP_FAMILY.has(cmd)) return false;
  const shortFlags = tokens.filter(token => /^-[A-Za-z]+$/.test(token));
  const longFlags = tokens.filter(token => token.startsWith('--'));
  if (shortFlags.some(flag => flag.includes('c')) || longFlags.includes('--count')) return true;
  if (!shortFlags.some(flag => flag.includes('o')) && !longFlags.includes('--only-matching')) return false;
  const pattern = tokens.slice(1).find(token => !token.startsWith('-'));
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || pattern.includes('.')) return false;
  return !pattern.includes('=') || /=\$?$/.test(pattern);
}

function denyIfSecretPath(text) {
  const raw = String(text || '');
  if (!raw) return;
  const safe = raw.replace(/\.env\.(example|sample|template|dist)\b/gi, ' ');
  for (const [re, useSafe, message] of SECRET_PATH_RULES)
    if (re.test(useSafe ? safe : raw)) deny(message);
}

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
  // Get-Item is a second way to reach the drive, `Env:*` a second way to spell "all of it", and
  // `)` a terminator that `(Get-Item Env:).Value` relies on. A named read (`Get-Item Env:PATH`)
  // has a variable name after the colon and stays allowed.
  if (/\b(Get-ChildItem|gci|Get-Item|gi|ls|dir)\s+(-\w+\s+)*env:(\\|\*)?\s*(\||;|&|\)|$)/i.test(inspection))
    deny('Listing the Env: drive prints every environment variable, including injected secrets. Read one with $env:NAME.');
  // [System.Environment] is the fully-qualified spelling of the same call and must match too.
  if (/\[(?:System\.)?Environment\]::GetEnvironmentVariables/i.test(inspection))
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

  // 3a. The shell's own redirect is reader-independent, so it catches the readers no list can
  //     hold: `tee < .env`, `tr -d "" < .env`, `while read l; do echo "$l"; done < .env`.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '<' && i + 1 < tokens.length) denyIfSecretPath(tokens[i + 1]);
    else if (/^<[^<]/.test(tokens[i])) denyIfSecretPath(tokens[i].slice(1));
  }

  const cmd = commandName(tokens[0]);
  const isPatternReader = PATTERN_READ_COMMANDS.has(cmd);
  if (!READ_COMMANDS.has(cmd) && !isPatternReader) continue;
  // `sed -i` rewrites the file in place and prints nothing, so it cannot leak what it edits
  // (stripping CRLF from a .env is a real and harmless chore).
  if (cmd === 'sed' && tokens.some(token => /^-i\S*$/.test(token) || token.startsWith('--in-place'))) continue;
  let args = tokens.slice(1);
  if (isPatternReader) {
    if (isNamesOnlyRead(cmd, tokens)) continue;
    const patternIndex = args.findIndex(arg => !arg.startsWith('-'));
    args = patternIndex >= 0 ? args.slice(patternIndex + 1) : [];
  }
  denyIfSecretPath(args.join(' '));
}

// 4. Language-eval exfil of env / .env (shell-independent)
if (/\b(python3?|node|ruby|perl|php)\b[^\n]*(\.env|os\.environ|process\.env|ENV\[)/.test(inspection))
  deny('Reading env/.env via a language eval routes secrets to stdout.');

// 5. docker compose config renders interpolated secrets
if (/\bdocker\s+compose\s+config\b/.test(inspection)) deny('docker compose config renders interpolated secrets to stdout.');

// === Destination rules (agent-native-os#94). ====================================================
// Rules 1-5 above ask "does this command look like a way to print secrets?" - a question whose
// answer is an ever-growing list of spellings. Rules 6-8 ask the other question: "would this
// command's OUTPUT be the environment?" Nothing is executed in these forms, so there is no inner
// command to unwrap however far the wrapper list is extended.

// 6. Introspection renders a resource's configuration, and configuration includes the process
//    environment. The durable signal is the VERB - plain English, stable across runtimes - not
//    the vendor name. In the #94 report `docker inspect` on one API container printed 20 live
//    variables including DATABASE_URL and ADMIN_TOKEN, from a command that reads as a status check.
// `inspect` is specific enough to key on with no binary qualification: measured against 9,456
// real commands, every firing was a genuine container/image inspect.
const CONFIG_DUMP_VERBS = new Set(['inspect']);
// `show` and `describe` are ordinary English and appear as subcommands everywhere - and, in a
// heredoc commit body, as prose. Unqualified they cost 249 false blocks across the same history
// (`git show`, `hermes kanban show`, `npm show`, `reframes describe ...` in a commit message).
// Qualifying them fails toward a MISS rather than a false block, which is the correct direction
// for a verb this generic; the wrapper classes above are the ones that must fail closed.
const RUNTIME_INTROSPECTORS = new Set([
  'systemctl', 'launchctl', 'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'crictl', 'oc',
  'terraform', 'tofu', 'vault', 'nomad', 'consul', 'openstack', 'pm2', 'supervisorctl',
  'gcloud', 'az', 'lxc', 'incus', 'minikube', 'k3s', 'fly', 'flyctl', 'heroku', 'railway', 'doctl',
]);
const QUALIFIED_DUMP_VERBS = new Set(['show', 'describe']);
// `systemctl show -p Restart` selects named properties and cannot print Environment. The deny
// message below tells people to do exactly this, so it has to stay allowed.
function selectsNonEnvProperty(tokens) {
  const properties = [];
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] === '-p' || tokens[i] === '--property') && i + 1 < tokens.length)
      properties.push(tokens[i + 1]);
    else if (tokens[i].startsWith('--property='))
      properties.push(tokens[i].slice('--property='.length));
  }
  return properties.length > 0 && !properties.some(property => /environment/i.test(property));
}

for (const segment of segments) {
  const tokens = words(segment);
  const binary = resolveBinary(tokens);
  if (!binary) continue;
  if (selectsNonEnvProperty(tokens)) continue;
  const positionals = tokens.slice(1).filter(token => !token.startsWith('-'));
  for (let i = 0; i + 1 < positionals.length; i++) {
    const verb = positionals[i].toLowerCase();
    // A verb with no target introspects nothing, so `npm run inspect` stays allowed.
    const dumps = CONFIG_DUMP_VERBS.has(verb) ||
      (QUALIFIED_DUMP_VERBS.has(verb) && RUNTIME_INTROSPECTORS.has(binary));
    if (dumps)
      deny(`\`${binary} ${verb}\` renders the target's full configuration, which includes its environment variables. Read the single setting you need, or pass a --format/--property selector that excludes Env.`);
  }
  // `kubectl get pod -o yaml` prints the whole spec; plain `kubectl get pods` does not. Key on
  // the machine-readable output flag so the everyday listing command keeps working.
  if (positionals.some(token => token.toLowerCase() === 'get') &&
      /(?:^|\s)(?:-o|--output)[=\s]+(?:yaml|json)\b/i.test(segment))
    deny('Requesting a resource as yaml/json returns its full spec, environment variables included. Use a jsonpath/custom-columns selector for the field you actually need.');
}

// 7. Process-level reads. The environ path is handled as a secret path in rule 3 above, so it
//    rides the reader and redirect detection instead of matching raw text anywhere in the
//    command. What remains here is the option-shaped form, which has no path to match.
for (const segment of segments) {
  const tokens = words(segment);
  if (commandName(tokens[0]) !== 'ps') continue;
  // BSD option clusters carry `e` (ps eww, ps auxe). SysV `-e` just means "all processes" and
  // must stay allowed, so only UNDASHED clusters count here.
  if (tokens.slice(1).some(arg => !arg.startsWith('-') && /^[a-z]+$/.test(arg) && arg.includes('e')))
    deny('`ps` with the BSD `e` option prints each process\'s environment. Drop the `e` (for example `ps aux`).');
}

// 8. Platform secret stores. Match the ACTION that emits values, not the vendor. `list` is
//    names-only on every platform that offers it, so `gh secret list` and `fly secrets list`
//    stay allowed - the severity difference the #94 report drew is preserved here.
const VALUE_EMITTING_VERBS = ['reveal', 'pull', 'download', 'export', 'dump'];
const SECRET_STORE_NOUNS = ['secret', 'secrets', 'env', 'environment', 'config', 'vars', 'variables'];
for (const segment of segments) {
  const tokens = words(segment);
  if (!resolveBinary(tokens)) continue;
  const positionals = tokens.slice(1)
    .filter(token => !token.startsWith('-')).map(token => token.toLowerCase());
  for (let i = 0; i < positionals.length; i++) {
    const colon = /^(secrets?|env|environment|config|vars|variables)[:.](\w+)$/.exec(positionals[i]);
    if (colon && VALUE_EMITTING_VERBS.concat('get').includes(colon[2]))
      deny(`\`${positionals[i]}\` prints live secret values. Inject them at runtime instead.`);
    if (SECRET_STORE_NOUNS.includes(positionals[i]) && VALUE_EMITTING_VERBS.includes(positionals[i + 1]))
      deny(`\`${positionals[i]} ${positionals[i + 1]}\` writes or prints live secret VALUES. Inject them at runtime instead.`);
  }
}

process.exit(0);

#!/usr/bin/env node
// ~/.claude/hooks/secrets-tripwire.js - redact secret-shaped shell output.
// op-tripwire: detector-rule
//
// PostToolUse supports updatedToolOutput, so successful Bash/PowerShell output is
// replaced before Claude sees it. PostToolUseFailure cannot replace the error;
// for that event this hook emits names-only context and never repeats the value.

const fs = require('fs');
const os = require('os');
const path = require('path');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }

let input;
try { input = JSON.parse(raw); } catch (_) { process.exit(0); }

const eventName = input.hook_event_name || 'PostToolUse';
if (!['PostToolUse', 'PostToolUseFailure'].includes(eventName)) process.exit(0);

const PATTERNS = [
  { name: '1Password service token', re: /\bops_[A-Za-z0-9]{40,}/g },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Langfuse secret key', re: /\bsk-lf-[A-Za-z0-9_-]{12,}/g },
  { name: 'OpenAI-style key', re: /\bsk-(?!ant-|lf-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'Slack token', re: /\b(?:xox[bpsar]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/g },
  { name: 'Supabase secret', re: /\bsb_secret_[A-Za-z0-9_-]{12,}/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Apify token', re: /\bapify_api_[A-Za-z0-9_-]{20,}/g },
  { name: 'Firecrawl key', re: /\bfc-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'DB URL with password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:@/\s]+:[^@/\s]+@/g,
  },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
];

const hits = new Set();

function redactText(value) {
  let redacted = value;
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    redacted = redacted.replace(pattern.re, () => {
      hits.add(pattern.name);
      return `[REDACTED: ${pattern.name}]`;
    });
  }
  return redacted;
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

let updatedToolOutput;
if (eventName === 'PostToolUse') {
  if (!Object.prototype.hasOwnProperty.call(input, 'tool_response')) process.exit(0);
  updatedToolOutput = redactValue(input.tool_response);
} else {
  redactText(typeof input.error === 'string' ? input.error : '');
}

if (!hits.size) process.exit(0);
const names = [...hits];

try {
  const dir = path.join(os.homedir(), '.claude', 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const logPath = path.join(dir, 'secrets-tripwire.log');
  fs.appendFileSync(
    logPath,
    `[${new Date().toISOString()}] redaction: ${names.join(', ')} (names only)\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(logPath, 0o600);
} catch (_) {}

const hookSpecificOutput = {
  hookEventName: eventName,
  additionalContext:
    `SECRET TRIPWIRE: ${names.join(', ')} detected. Do not reconstruct or repeat the value. ` +
    'Treat the value as compromised and tell the user to rotate it.',
};

if (eventName === 'PostToolUse') hookSpecificOutput.updatedToolOutput = updatedToolOutput;

process.stdout.write(JSON.stringify({ hookSpecificOutput }));
process.exit(0);

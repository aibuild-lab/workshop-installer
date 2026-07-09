#!/usr/bin/env node
// ~/.claude/hooks/secrets-tripwire.js — PostToolUse. Detect-and-warn; cannot un-send.
// Scans tool output for secret-shaped strings. It CANNOT remove output the model
// already saw, so it is a tripwire, not redaction: it warns the model not to echo
// the value and logs a dated near-miss (names only, never values).

const fs = require('fs'), os = require('os'), path = require('path');

let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }
let input; try { input = JSON.parse(raw); } catch (_) { process.exit(0); }
const r = input.tool_response || {};
const out = [r.stdout, r.stderr, r.output, typeof r === 'string' ? r : '']
  .filter(Boolean).join('\n');
if (!out) process.exit(0);

const PATTERNS = [
  { name: '1Password service token', re: /\bops_[A-Za-z0-9]{40,}/ },
  { name: 'Anthropic API key',       re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },   // hyphen after sk- — missed by the old /sk-[A-Za-z0-9]{20,}/
  { name: 'OpenAI-style key',        re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Langfuse secret key',     re: /\bsk-lf-[A-Za-z0-9-]+/ },
  { name: 'GitHub token',            re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Slack token',             re: /\bxox[bpsar]-[A-Za-z0-9-]{10,}/ },
  { name: 'Supabase secret',         re: /\bsb_secret_[A-Za-z0-9]+/ },
  { name: 'AWS access key id',       re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Apify token',             re: /\bapify_api_[A-Za-z0-9]{20,}/ },
  { name: 'Firecrawl key',           re: /\bfc-[A-Za-z0-9]{20,}/ },
  { name: 'Google API key',          re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private key block',       re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'DB URL with password',    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:@/\s]+:[^@/\s]+@/ },
  { name: 'Bearer token',            re: /\bBearer\s+[A-Za-z0-9._\-]{20,}/ },
  { name: 'JWT',                     re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
];
const hits = PATTERNS.filter(p => p.re.test(out)).map(p => p.name);
if (!hits.length) process.exit(0);

try {
  const dir = path.join(os.homedir(), '.claude', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'secrets-tripwire.log'),
    `[${new Date().toISOString()}] near-miss: ${hits.join(', ')} (names only)\n`);
} catch (_) {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `SECRET TRIPWIRE: output appears to contain ${hits.join(', ')}. Do NOT repeat, summarize, or echo this value. Treat it as compromised and tell the user to rotate it.`
  }
}));
process.exit(0);

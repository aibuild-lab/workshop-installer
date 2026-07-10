#!/usr/bin/env node
// ~/.claude/hooks/secrets-tripwire.js — PostToolUse / PostToolUseFailure.
// Scans a tool's output for secret-shaped strings.
//
// PostToolUse fires only AFTER A TOOL SUCCEEDS, and at that point the output can still be
// rewritten before Claude ever reads it — so on success this hook REDACTS every match and
// returns the cleaned text via `updatedToolOutput`. That is real prevention, not just a warning.
//
// PostToolUseFailure fires after a tool FAILS; that output cannot be rewritten (the tool already
// ran), so there we fall back to a names-only warning telling Claude not to echo the value.
//
// Either way we log a dated, names-only near-miss. Values are never written to the log or the
// warning text. (PR #14 review, 8Dvibes P2.)

const fs = require('fs'), os = require('os'), path = require('path');

let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }
let input; try { input = JSON.parse(raw); } catch (_) { process.exit(0); }

const eventName = input.hook_event_name || input.hookEventName || 'PostToolUse';
// Only the success event supports output rewriting. Treat anything explicitly marked as the
// failure event (or a response flagged isError) as non-redactable.
const resp = input.tool_response ?? input.tool_output ?? {};
const canRedact = eventName !== 'PostToolUseFailure' && !(resp && resp.isError === true);

// Read the tool's textual output. Field name is kept as tool_response (what the shipping hook
// used and what production sends); tool_output is a defensive fallback. Shape-agnostic so a
// schema tweak can't silently blind the scanner.
const fields = typeof resp === 'string'
  ? [resp]
  : [resp.stdout, resp.stderr, resp.output, resp.errorMessage];
const out = fields.filter(s => typeof s === 'string' && s).join('\n');
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
  { name: 'private key block',       re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'DB URL with password',    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:@/\s]+:[^@/\s]+@/ },
  { name: 'Bearer token',            re: /\bBearer\s+[A-Za-z0-9._\-]{20,}/ },
  { name: 'JWT',                     re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
];

// Redact every match in one pass, collecting the (names-only) hit list. More specific patterns
// sit earlier so `sk-ant-…` is labelled Anthropic before the broader OpenAI shape can claim it.
const hits = new Set();
let redacted = out;
for (const p of PATTERNS) {
  const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
  redacted = redacted.replace(g, () => { hits.add(p.name); return `[REDACTED:${p.name}]`; });
}
if (!hits.size) process.exit(0);
const names = [...hits].join(', ');

// Dated, names-only near-miss log. Never the value.
try {
  const dir = path.join(os.homedir(), '.claude', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'secrets-tripwire.log'),
    `[${new Date().toISOString()}] ${eventName} near-miss: ${names} (names only)\n`);
} catch (_) {}

if (canRedact) {
  // Success path: replace what Claude sees with the redacted text.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      updatedToolOutput: redacted,
      additionalContext: `SECRET TRIPWIRE: the tool output contained ${names}; the value(s) were redacted before you saw them. Do not attempt to recover the original. Tell the user to rotate the exposed credential.`
    }
  }));
} else {
  // Failure path: the output cannot be rewritten. Warn with names only.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `SECRET TRIPWIRE: failed-tool output appears to contain ${names}. That output cannot be redacted after the fact — do NOT repeat, summarize, or echo the value. Treat it as compromised and tell the user to rotate it.`
    }
  }));
}
process.exit(0);

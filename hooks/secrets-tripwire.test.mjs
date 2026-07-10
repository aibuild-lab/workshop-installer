#!/usr/bin/env node
// Tests for secrets-tripwire.js — both PostToolUse (success: REDACT via updatedToolOutput) and
// PostToolUseFailure (failure: names-only warning, no rewrite). Run: `node hooks/secrets-tripwire.test.mjs`.
// Fake keys are built by concatenation so no contiguous literal sits in this file (gitleaks-safe).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'secrets-tripwire.js');
const FAKE_ANTHROPIC = 'sk-ant-' + 'api03-' + 'A1b2C3d4E5'.repeat(6);
const FAKE_AWS = 'AKIA' + 'ABCDEFGH12345678';

// Run the hook with a PostToolUse-family input; return parsed stdout ({} if none).
function run(event, tool_response) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'x' }, tool_response }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`hook crashed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

const failures = [];
const check = (name, cond) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failures.push(name); console.error(`FAIL - ${name}`); }
};

// === SUCCESS PATH (PostToolUse): output is redacted before Claude sees it ===
{
  const o = run('PostToolUse', { stdout: `key loaded: ${FAKE_ANTHROPIC}\ndone`, stderr: '' });
  const hs = o.hookSpecificOutput || {};
  check('success: returns updatedToolOutput', typeof hs.updatedToolOutput === 'string');
  check('success: the live secret value is gone from the replacement',
    typeof hs.updatedToolOutput === 'string' && !hs.updatedToolOutput.includes(FAKE_ANTHROPIC));
  check('success: a [REDACTED] marker is present', /\[REDACTED:/.test(hs.updatedToolOutput || ''));
  check('success: non-secret text is preserved', (hs.updatedToolOutput || '').includes('done'));
  check('success: hook output never contains the raw secret',
    !JSON.stringify(o).includes(FAKE_ANTHROPIC));
  check('success: additionalContext names the secret type', /Anthropic API key/.test(hs.additionalContext || ''));
}

// secret in stderr on success is redacted too
{
  const o = run('PostToolUse', { stdout: 'ok', stderr: `leak ${FAKE_AWS}` });
  const hs = o.hookSpecificOutput || {};
  check('success: secret in stderr is redacted', typeof hs.updatedToolOutput === 'string'
    && !hs.updatedToolOutput.includes(FAKE_AWS) && /\[REDACTED:/.test(hs.updatedToolOutput));
}

// clean output on success: no interference, no JSON emitted
{
  const o = run('PostToolUse', { stdout: 'all tests passed', stderr: '' });
  check('success: clean output produces no hook output (no false redaction)', Object.keys(o).length === 0);
}

// === FAILURE PATH (PostToolUseFailure): cannot rewrite; names-only warning ===
{
  const o = run('PostToolUseFailure', { isError: true, stderr: `boom ${FAKE_ANTHROPIC}`, errorMessage: 'exit 1' });
  const hs = o.hookSpecificOutput || {};
  check('failure: does NOT return updatedToolOutput', hs.updatedToolOutput === undefined);
  check('failure: returns names-only additionalContext', /Anthropic API key/.test(hs.additionalContext || ''));
  check('failure: hook output never contains the raw secret', !JSON.stringify(o).includes(FAKE_ANTHROPIC));
}

// a response flagged isError on the success event is still treated as non-redactable
{
  const o = run('PostToolUse', { isError: true, stderr: `boom ${FAKE_AWS}` });
  const hs = o.hookSpecificOutput || {};
  check('isError guard: no rewrite even on PostToolUse when isError=true', hs.updatedToolOutput === undefined);
  check('isError guard: still warns names-only', /AWS access key id/.test(hs.additionalContext || ''));
}

console.log(`\n${failures.length ? failures.length + ' FAILED' : 'all tripwire checks passed'}`);
process.exit(failures.length ? 1 : 0);

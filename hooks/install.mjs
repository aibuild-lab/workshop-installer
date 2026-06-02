#!/usr/bin/env node
// hooks/install.mjs — idempotently wire the secrets guard into the user's Claude Code settings.
// Assumes secrets-guard.js and secrets-tripwire.js are already present in ~/.claude/hooks/.
// Safe to re-run: it merges into ~/.claude/settings.json and never clobbers existing keys.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const claudeDir = path.join(os.homedir(), '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
const settingsPath = path.join(claudeDir, 'settings.json');

fs.mkdirSync(hooksDir, { recursive: true });

// Verify the hook scripts landed.
for (const f of ['secrets-guard.js', 'secrets-tripwire.js']) {
  if (!fs.existsSync(path.join(hooksDir, f))) {
    console.error(`ERROR: ${f} not found in ~/.claude/hooks/. Download it before running this installer.`);
    process.exit(1);
  }
}

// Load existing settings (or start fresh). Bail loudly if it exists but is corrupt —
// better to stop than to overwrite a settings file we couldn't parse.
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: ~/.claude/settings.json exists but is not valid JSON. Fix or remove it, then re-run. (${e.message})`);
    process.exit(1);
  }
}

// Back up once before first modification.
if (fs.existsSync(settingsPath)) {
  const backup = settingsPath + '.backup.secrets-guard';
  if (!fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup);
}

// 1. permissions.deny — union with our entries.
const DENY = [
  'Read(.env)', 'Read(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.*.local)',
  'Read(**/*.pem)', 'Read(**/id_rsa)', 'Read(**/id_ed25519)', 'Read(**/credentials*)',
];
settings.permissions ??= {};
settings.permissions.deny = Array.from(new Set([...(settings.permissions.deny ?? []), ...DENY]));

// 2. hooks.PreToolUse / PostToolUse — append our Bash matcher group if not already present.
settings.hooks ??= {};
function ensureHook(event, script) {
  settings.hooks[event] ??= [];
  const already = JSON.stringify(settings.hooks[event]).includes(script);
  if (!already) {
    settings.hooks[event].push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node ~/.claude/hooks/${script}` }],
    });
    return true;
  }
  return false;
}
const addedPre = ensureHook('PreToolUse', 'secrets-guard.js');
const addedPost = ensureHook('PostToolUse', 'secrets-tripwire.js');

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log('Secrets guard installed.');
console.log(`  PreToolUse  (secrets-guard.js):   ${addedPre ? 'added' : 'already present'}`);
console.log(`  PostToolUse (secrets-tripwire.js): ${addedPost ? 'added' : 'already present'}`);
console.log(`  Read deny rules: ${settings.permissions.deny.length}`);
console.log('Restart Claude Code (or start a new session) for the hooks to take effect.');

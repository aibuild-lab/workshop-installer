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
  'Read(**/.env.*)', 'Read(**/secrets/**)',
];
settings.permissions ??= {};
settings.permissions.deny = Array.from(new Set([...(settings.permissions.deny ?? []), ...DENY]));

// 2. hooks.PreToolUse / PostToolUse — register (or repair) our matcher group.
// Matcher covers both Bash and PowerShell: on Windows, Claude Code exposes a separate
// PowerShell tool that a Bash-only matcher would never inspect.
settings.hooks ??= {};

// Both the node binary AND the hook script must be absolute, quoted, forward-slash paths
// resolved at install time. There are two ways this silently fails otherwise, and a security
// control that looks installed but protects nothing is the worst possible outcome:
//   - A bare `node` is not on PATH in the shell Claude Code spawns hooks in (that shell has
//     not loaded ~/.zshrc or Homebrew's shellenv). `node` becomes "command not found", the
//     hook errors instead of returning a deny, and Claude Code runs the command UNGUARDED.
//   - A bare `~` only expands in Git Bash; through PowerShell or cmd it passes literally.
// process.execPath is the absolute path of the node already running this installer, so it is
// guaranteed to exist. Forward slashes work for node on Windows too; quoting handles spaces.
const nodeBin = process.execPath.split(path.sep).join('/');

function ensureHook(event, script) {
  settings.hooks[event] ??= [];
  const hookPath = path.join(hooksDir, script).split(path.sep).join('/');
  const command = `"${nodeBin}" "${hookPath}"`;
  // Repair any existing entry that runs this script (for example an older bare-`node` command
  // from a previous install) so re-running heals already-affected machines instead of skipping
  // them. The bare-`node` bug shipped silently, so a no-op re-run would leave students exposed.
  for (const group of settings.hooks[event]) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && typeof h.command === 'string' && h.command.includes(script)) {
        if (h.command === command) return 'already correct';
        h.command = command;
        return 'repaired';
      }
    }
  }
  settings.hooks[event].push({
    matcher: 'Bash|PowerShell',
    hooks: [{ type: 'command', command }],
  });
  return 'added';
}
const preStatus = ensureHook('PreToolUse', 'secrets-guard.js');
const postStatus = ensureHook('PostToolUse', 'secrets-tripwire.js');

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log('Secrets guard installed.');
console.log(`  PreToolUse  (secrets-guard.js):   ${preStatus}`);
console.log(`  PostToolUse (secrets-tripwire.js): ${postStatus}`);
console.log(`  Hook runtime: ${nodeBin}`);
console.log(`  Read deny rules: ${settings.permissions.deny.length}`);
console.log('Restart Claude Code (or start a new session) for the hooks to take effect.');

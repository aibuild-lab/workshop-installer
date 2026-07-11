#!/usr/bin/env node
// hooks/install.mjs - idempotently wire the secrets guard into the user's Claude Code settings.
// Assumes secrets-guard.js and secrets-tripwire.js are already present in ~/.claude/hooks/.
// Safe to re-run: it gives each managed hook a dedicated matcher group, removes only stale
// copies of that managed hook, and preserves unrelated hooks and their matchers byte-for-byte.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const claudeDir = path.join(os.homedir(), '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
const settingsPath = path.join(claudeDir, 'settings.json');
const backupPath = settingsPath + '.backup.secrets-guard';
const SETTINGS_MODE = 0o600;
const SCRIPT_MODE = 0o700;

fs.mkdirSync(hooksDir, { recursive: true });

// Verify the hook scripts landed.
for (const f of ['secrets-guard.js', 'secrets-tripwire.js']) {
  const scriptPath = path.join(hooksDir, f);
  if (!fs.existsSync(scriptPath)) {
    console.error(`ERROR: ${f} not found in ~/.claude/hooks/. Download it before running this installer.`);
    process.exit(1);
  }
  fs.chmodSync(scriptPath, SCRIPT_MODE);
}

// Load existing settings (or start fresh). Bail loudly if it exists but is corrupt -
// better to stop than to overwrite a settings file we couldn't parse.
let settings = {};
let originalText = null;
if (fs.existsSync(settingsPath)) {
  try {
    originalText = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(originalText);
  } catch (e) {
    console.error(`ERROR: ~/.claude/settings.json exists but is not valid JSON. Fix or remove it, then re-run. (${e.message})`);
    process.exit(1);
  }
}

// Back up once before first modification.
if (fs.existsSync(settingsPath)) {
  if (!fs.existsSync(backupPath)) fs.copyFileSync(settingsPath, backupPath);
  fs.chmodSync(backupPath, SETTINGS_MODE);
}

// 1. permissions.deny - union with our entries.
const DENY = [
  'Read(.env)', 'Read(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.*.local)',
  'Read(**/*.pem)', 'Read(**/id_rsa)', 'Read(**/id_ed25519)', 'Read(**/credentials*)',
  'Read(**/.env.*)', 'Read(**/secrets/**)',
];
settings.permissions ??= {};
if (!Array.isArray(settings.permissions.deny) && settings.permissions.deny !== undefined) {
  console.error('ERROR: ~/.claude/settings.json permissions.deny must be an array. Fix it, then re-run.');
  process.exit(1);
}
settings.permissions.deny = Array.from(new Set([...(settings.permissions.deny ?? []), ...DENY]));

// 2. Hook registration. Each managed script gets its own group so repairing its matcher
// never widens a sibling hook's matcher (PR #14 review, 8Dvibes P2). PostToolUseFailure cannot
// redact failed output, but the tripwire supplies names-only additionalContext without repeating
// the value. PreToolUse matcher covers Bash + PowerShell (Windows exposes a separate PowerShell
// tool a Bash-only matcher would miss) AND Write|Edit|MultiEdit|NotebookEdit, so the content guard
// can block a real key written straight into a tracked file. PostToolUse stays Bash|PowerShell
// (the tripwire scans command stdout).
settings.hooks ??= {};

// Both the node binary AND the hook script must be absolute, quoted, forward-slash paths
// resolved at install time. There are two ways this silently fails otherwise, and a security
// control that looks installed but protects nothing is the worst possible outcome:
//   - A bare `node` is not on PATH in the shell Claude Code spawns hooks in (that shell has
//     not loaded ~/.zshrc or Homebrew's shellenv). `node` becomes "command not found", the
//     hook errors instead of returning a deny, and Claude Code runs the command UNGUARDED.
//   - A bare `~` only expands in Git Bash; through PowerShell or cmd it passes literally.
// process.execPath is the absolute path of the node already running this installer, so it is
// guaranteed to exist. Fleet installs may set CLAUDE_HOOK_NODE to a stable absolute symlink
// (for example /opt/homebrew/bin/node) so a package-manager upgrade cannot strand a matcher on
// an old versioned Cellar path. Forward slashes work for node on Windows too.
const requestedNode = process.env.CLAUDE_HOOK_NODE || process.execPath;
if (!path.isAbsolute(requestedNode) || !fs.existsSync(requestedNode)) {
  console.error('ERROR: CLAUDE_HOOK_NODE must point to an existing absolute Node executable.');
  process.exit(1);
}
const nodeBin = requestedNode.split(path.sep).join('/');

// Match the hook by its script name as a WHOLE path token, not a substring. `.includes(script)`
// would wrongly treat a sibling like `secrets-guard.js-helper` as a stale copy and delete it.
function hookRunsScript(hook, script) {
  if (!hook || typeof hook.command !== 'string') return false;
  const normalized = hook.command.replaceAll('\\', '/');
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'/])${escaped}(?=$|[\\s"';&|])`).test(normalized);
}

function ensureHook(event, script, matcher) {
  const current = settings.hooks[event] ?? [];
  if (!Array.isArray(current)) {
    console.error(`ERROR: ~/.claude/settings.json hooks.${event} must be an array. Fix it, then re-run.`);
    process.exit(1);
  }

  const hookPath = path.join(hooksDir, script).split(path.sep).join('/');
  const command = `"${nodeBin}" "${hookPath}"`;
  const canonicalIndex = current.findIndex((group) =>
    group?.matcher === matcher &&
    Array.isArray(group.hooks) &&
    group.hooks.length === 1 &&
    group.hooks[0]?.type === 'command' &&
    group.hooks[0]?.command === command,
  );

  let removed = 0;
  const preserved = [];
  for (const [index, group] of current.entries()) {
    if (index === canonicalIndex) {
      preserved.push(group);
      continue;
    }
    if (!group || !Array.isArray(group.hooks)) {
      preserved.push(group);
      continue;
    }

    const removedBeforeGroup = removed;
    const remainingHooks = group.hooks.filter((hook) => {
      const managed = hookRunsScript(hook, script);
      if (managed) removed += 1;
      return !managed;
    });
    const removedFromGroup = removed - removedBeforeGroup;

    // Retain the original group and matcher for every sibling hook. A group that contained
    // only stale copies of this managed script can be removed entirely.
    if (remainingHooks.length > 0 || removedFromGroup === 0) {
      preserved.push(remainingHooks.length === group.hooks.length ? group : { ...group, hooks: remainingHooks });
    }
  }

  const next = canonicalIndex >= 0
    ? preserved
    : [...preserved, { matcher, hooks: [{ type: 'command', command }] }];
  settings.hooks[event] = next;

  if (JSON.stringify(current) === JSON.stringify(next)) return 'already correct';
  return removed > 0 ? 'repaired' : 'added';
}
const preStatus = ensureHook('PreToolUse', 'secrets-guard.js', 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit');
const postStatus = ensureHook('PostToolUse', 'secrets-tripwire.js', 'Bash|PowerShell');
const failureStatus = ensureHook('PostToolUseFailure', 'secrets-tripwire.js', 'Bash|PowerShell');

// Atomically install the updated settings: write a temp file with the restrictive mode, then
// rename it over the target so a crash mid-write cannot leave a truncated settings file.
const nextText = JSON.stringify(settings, null, 2) + '\n';
if (originalText !== nextText) {
  const tempPath = `${settingsPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tempPath, nextText, { mode: SETTINGS_MODE });
    fs.chmodSync(tempPath, SETTINGS_MODE);
    fs.renameSync(tempPath, settingsPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}
fs.chmodSync(settingsPath, SETTINGS_MODE);

console.log('Secrets guard installed.');
console.log(`  PreToolUse        (secrets-guard.js):    ${preStatus}`);
console.log(`  PostToolUse       (secrets-tripwire.js): ${postStatus}`);
console.log(`  PostToolUseFailure(secrets-tripwire.js): ${failureStatus}`);
console.log(`  Hook runtime: ${nodeBin}`);
console.log(`  Read deny rules: ${settings.permissions.deny.length}`);
console.log('Restart Claude Code (or start a new session) for the hooks to take effect.');

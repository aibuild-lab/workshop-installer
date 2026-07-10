#!/usr/bin/env node
// Integration test for hooks/install.mjs. Runs the REAL installer against a throwaway HOME and
// proves the repair path isolates our hook into its own matcher group WITHOUT touching sibling
// hooks or their matchers (PR #14 review, 8Dvibes P2). Run: `node hooks/install.test.mjs`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, 'install.mjs');
const FULL_PRE_MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';

const failures = [];
const check = (name, cond) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failures.push(name); console.error(`FAIL - ${name}`); }
};

// --- throwaway HOME with the hook scripts present (installer only checks they exist) ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-install-'));
const claudeDir = path.join(home, '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(path.join(hooksDir, 'secrets-guard.js'), '// stub\n');
fs.writeFileSync(path.join(hooksDir, 'secrets-tripwire.js'), '// stub\n');

// --- seed settings: our guard is STALE (bare `node`, narrow matcher) AND shares a PreToolUse
//     group with an unrelated sibling hook; plus an unrelated PostToolUse sibling group. ---
const siblingPre  = { type: 'command', command: 'node /custom/my-linter.js' };
const staleGuard  = { type: 'command', command: 'node ~/.claude/hooks/secrets-guard.js' };
const siblingPost = { type: 'command', command: 'node /custom/telemetry.js' };
const seed = {
  permissions: { deny: ['Read(existing-rule)'] },
  hooks: {
    PreToolUse:  [{ matcher: 'Bash', hooks: [siblingPre, staleGuard] }],  // shared group
    PostToolUse: [{ matcher: 'Edit', hooks: [siblingPost] }],             // unrelated sibling
  },
};
const settingsPath = path.join(claudeDir, 'settings.json');
fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2));

const run = () => spawnSync('node', [INSTALLER], {
  env: { ...process.env, HOME: home, USERPROFILE: home },  // os.homedir(): HOME on POSIX, USERPROFILE on Windows
  encoding: 'utf8',
});

const r = run();
if (r.status !== 0) { console.error('installer failed:\n', r.stderr || r.stdout); process.exit(1); }

const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const pre = after.hooks.PreToolUse;
const post = after.hooks.PostToolUse;
const isGuard = (h) => typeof h.command === 'string' && h.command.includes('secrets-guard.js');
const isTrip  = (h) => typeof h.command === 'string' && h.command.includes('secrets-tripwire.js');

// 1. Our guard appears exactly once, in a dedicated group, with the full matcher + absolute node.
const guardCopies = pre.flatMap(g => g.hooks).filter(isGuard);
check('guard registered exactly once', guardCopies.length === 1);
const guardGroup = pre.find(g => g.hooks.some(isGuard));
check('guard is alone in its own group', !!guardGroup && guardGroup.hooks.length === 1);
check('guard group has the full matcher', !!guardGroup && guardGroup.matcher === FULL_PRE_MATCHER);
check('guard command repaired to absolute quoted node + path (no bare node/~)',
  guardCopies.length === 1 && /^"[^"]+" "[^"]+secrets-guard\.js"$/.test(guardCopies[0].command));

// 2. THE POINT: the sibling hook and its group's matcher are untouched.
const siblingGroup = pre.find(g => g.hooks.some(h => h.command === siblingPre.command));
check('sibling PreToolUse hook still present, command unchanged', !!siblingGroup);
check('sibling group matcher NOT widened (still "Bash")', !!siblingGroup && siblingGroup.matcher === 'Bash');
check('sibling no longer shares a group with our guard', !!siblingGroup && !siblingGroup.hooks.some(isGuard));

// 3. Unrelated PostToolUse sibling group untouched; tripwire added in its own group.
const postSibling = post.find(g => g.hooks.some(h => h.command === siblingPost.command));
check('PostToolUse sibling group untouched', !!postSibling && postSibling.matcher === 'Edit' && postSibling.hooks.length === 1);
const tripGroup = post.find(g => g.hooks.some(isTrip));
check('tripwire in its own PostToolUse group (Bash|PowerShell)',
  !!tripGroup && tripGroup.hooks.length === 1 && tripGroup.matcher === 'Bash|PowerShell');
const postFail = after.hooks.PostToolUseFailure || [];
const failGroup = postFail.find(g => g.hooks.some(isTrip));
check('tripwire also registered on PostToolUseFailure (Bash|PowerShell)',
  !!failGroup && failGroup.hooks.length === 1 && failGroup.matcher === 'Bash|PowerShell');

// 4. Pre-existing permission rule preserved.
check('existing permission deny rule preserved', after.permissions.deny.includes('Read(existing-rule)'));

// 5. Idempotency: a second run changes nothing and reports already-correct.
const before2 = fs.readFileSync(settingsPath, 'utf8');
const r2 = run();
const after2 = fs.readFileSync(settingsPath, 'utf8');
check('second run leaves settings byte-for-byte identical', before2 === after2);
check('second run reports "already correct"', /already correct/.test(r2.stdout));

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${failures.length ? failures.length + ' FAILED' : 'all install-integration checks passed'}`);
process.exit(failures.length ? 1 : 0);

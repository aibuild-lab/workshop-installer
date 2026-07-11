#!/usr/bin/env node
// Integration test for hooks/install.mjs. Runs the REAL installer against a throwaway HOME and
// proves the repair path isolates each managed hook into its own matcher group WITHOUT touching
// sibling hooks or their matchers (PR #14 review, 8Dvibes P2). Run: `node hooks/install.test.mjs`.
//
// The `secrets-guard.js-helper` sibling is a deliberate trap: a substring match on
// `secrets-guard.js` would delete it. The installer must key off the whole path token and leave
// it in place.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, 'install.mjs');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-secrets-guard-test-'));
const claudeDir = path.join(tempHome, '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
const settingsPath = path.join(claudeDir, 'settings.json');
const backupPath = settingsPath + '.backup.secrets-guard';

const GUARD_MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';
const SHELL_MATCHER = 'Bash|PowerShell';

function commandRunsScript(command, script) {
  if (typeof command !== 'string') return false;
  const normalized = command.replaceAll('\\', '/');
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'/])${escaped}(?=$|[\\s"';&|])`).test(normalized);
}

function targetGroups(settings, event, script) {
  return (settings.hooks[event] ?? []).filter((group) =>
    Array.isArray(group?.hooks) && group.hooks.some((hook) => commandRunsScript(hook?.command, script)),
  );
}

function assertDedicated(settings, event, script, matcher) {
  const groups = targetGroups(settings, event, script);
  assert.equal(groups.length, 1, `${event} should have exactly one ${script} group`);
  assert.equal(groups[0].matcher, matcher, `${event} matcher should be canonical`);
  assert.equal(groups[0].hooks.length, 1, `${event} group should be dedicated`);

  const nodeBin = process.execPath.split(path.sep).join('/');
  const hookPath = path.join(hooksDir, script).split(path.sep).join('/');
  assert.equal(groups[0].hooks[0].command, `"${nodeBin}" "${hookPath}"`);
}

function assertMode(file, expected) {
  if (process.platform === 'win32') return;
  assert.equal(fs.statSync(file).mode & 0o777, expected, `${file} should be mode ${expected.toString(8)}`);
}

function runInstaller(home = tempHome) {
  const result = spawnSync(process.execPath, [installer], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_HOOK_NODE: process.execPath },
  });
  assert.equal(result.status, 0, `installer failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function assertSiblingPreserved(settings) {
  const pre = settings.hooks.PreToolUse.find((group) => group.tag === 'shared-pre');
  assert.equal(pre.matcher, 'Bash');
  assert.deepEqual(pre.hooks, [
    { type: 'command', command: 'node "/keep/unrelated-pre.js"' },
    { type: 'command', command: 'node "/keep/secrets-guard.js-helper"' },
  ]);

  const post = settings.hooks.PostToolUse.find((group) => group.tag === 'shared-post');
  assert.equal(post.matcher, 'Bash');
  assert.deepEqual(post.hooks, [
    { type: 'command', command: 'node "/keep/unrelated-post.js"' },
  ]);

  const failure = settings.hooks.PostToolUseFailure.find((group) => group.tag === 'shared-failure');
  assert.equal(failure.matcher, 'PowerShell');
  assert.deepEqual(failure.hooks, [
    { type: 'command', command: 'node "/keep/unrelated-failure.js"' },
  ]);
}

try {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const script of ['secrets-guard.js', 'secrets-tripwire.js']) {
    fs.copyFileSync(path.join(here, script), path.join(hooksDir, script));
    fs.chmodSync(path.join(hooksDir, script), 0o644);
  }

  const initial = {
    marker: { preserve: true },
    permissions: {
      allow: ['Bash(git:*)'],
      deny: ['Read(custom.secret)'],
    },
    hooks: {
      PreToolUse: [
        {
          tag: 'shared-pre',
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node "~/.claude/hooks/secrets-guard.js"' },
            { type: 'command', command: 'node "/keep/unrelated-pre.js"' },
            { type: 'command', command: 'node "/keep/secrets-guard.js-helper"' },
          ],
        },
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: 'node "/stale/secrets-guard.js"' }],
        },
      ],
      PostToolUse: [
        {
          tag: 'shared-post',
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node "~/.claude/hooks/secrets-tripwire.js"' },
            { type: 'command', command: 'node "/keep/unrelated-post.js"' },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          tag: 'shared-failure',
          matcher: 'PowerShell',
          hooks: [
            { type: 'command', command: 'node "~/.claude/hooks/secrets-tripwire.js"' },
            { type: 'command', command: 'node "/keep/unrelated-failure.js"' },
          ],
        },
      ],
      Notification: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node "/keep/notification.js"' }],
        },
      ],
    },
  };
  const initialText = JSON.stringify(initial, null, 2) + '\n';
  fs.writeFileSync(settingsPath, initialText, { mode: 0o644 });

  runInstaller();
  const installed = readSettings();

  assert.deepEqual(installed.marker, initial.marker);
  assert.deepEqual(installed.permissions.allow, initial.permissions.allow);
  assert(installed.permissions.deny.includes('Read(custom.secret)'));
  assert(installed.permissions.deny.includes('Read(**/.env)'));
  assert.deepEqual(installed.hooks.Notification, initial.hooks.Notification);
  assertSiblingPreserved(installed);
  assertDedicated(installed, 'PreToolUse', 'secrets-guard.js', GUARD_MATCHER);
  assertDedicated(installed, 'PostToolUse', 'secrets-tripwire.js', SHELL_MATCHER);
  assertDedicated(installed, 'PostToolUseFailure', 'secrets-tripwire.js', SHELL_MATCHER);

  assert.equal(fs.readFileSync(backupPath, 'utf8'), initialText);
  assertMode(settingsPath, 0o600);
  assertMode(backupPath, 0o600);
  assertMode(path.join(hooksDir, 'secrets-guard.js'), 0o700);
  assertMode(path.join(hooksDir, 'secrets-tripwire.js'), 0o700);

  const firstInstalledText = fs.readFileSync(settingsPath, 'utf8');
  const secondOutput = runInstaller();
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstInstalledText);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), initialText);
  assert.equal((secondOutput.match(/already correct/g) ?? []).length, 3);

  // Simulate settings drift while the installed hook files remain byte-identical. The
  // installer must remove only its stale entries and rebuild all three dedicated groups.
  const drifted = readSettings();
  drifted.hooks.PreToolUse = drifted.hooks.PreToolUse.filter(
    (group) => !group.hooks?.some((hook) => commandRunsScript(hook.command, 'secrets-guard.js')),
  );
  drifted.hooks.PreToolUse.find((group) => group.tag === 'shared-pre').hooks.unshift(
    { type: 'command', command: 'node "/stale/secrets-guard.js"' },
  );
  drifted.hooks.PostToolUse.find(
    (group) => group.hooks?.some((hook) => commandRunsScript(hook.command, 'secrets-tripwire.js')),
  ).matcher = 'Bash';
  drifted.hooks.PostToolUseFailure = drifted.hooks.PostToolUseFailure.filter(
    (group) => !group.hooks?.some((hook) => commandRunsScript(hook.command, 'secrets-tripwire.js')),
  );

  const guardBeforeRepair = fs.readFileSync(path.join(hooksDir, 'secrets-guard.js'));
  const tripwireBeforeRepair = fs.readFileSync(path.join(hooksDir, 'secrets-tripwire.js'));
  fs.writeFileSync(settingsPath, JSON.stringify(drifted, null, 2) + '\n', { mode: 0o600 });

  runInstaller();
  const repaired = readSettings();
  assertSiblingPreserved(repaired);
  assertDedicated(repaired, 'PreToolUse', 'secrets-guard.js', GUARD_MATCHER);
  assertDedicated(repaired, 'PostToolUse', 'secrets-tripwire.js', SHELL_MATCHER);
  assertDedicated(repaired, 'PostToolUseFailure', 'secrets-tripwire.js', SHELL_MATCHER);
  assert.deepEqual(fs.readFileSync(path.join(hooksDir, 'secrets-guard.js')), guardBeforeRepair);
  assert.deepEqual(fs.readFileSync(path.join(hooksDir, 'secrets-tripwire.js')), tripwireBeforeRepair);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), initialText);

  console.log('install integration: PASS');
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

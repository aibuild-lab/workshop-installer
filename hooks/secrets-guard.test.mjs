#!/usr/bin/env node
// Allow/block table for secrets-guard.js. Run: `node hooks/secrets-guard.test.mjs`
// Feeds PreToolUse JSON into the real hook and checks the decision. No secret
// command is ever executed — only the hook's static matcher runs.
//
// The "real-workflow allow" block pins the exact `$(op read ...)` injection
// shapes Wade runs day to day, so a future edit that accidentally blocks them
// fails CI instead of silently breaking his automation.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'secrets-guard.js');

// decision('Bash'|'PowerShell', command) -> 'allow' | 'deny'
function decision(tool, command) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`hook crashed: ${r.stderr}`);
  return /"permissionDecision":"deny"/.test(r.stdout) ? 'deny' : 'allow';
}

// [tool, command, expected]
const CASES = [
  // --- real-workflow ALLOW: $(op read ...) injection must never be blocked ---
  ['Bash', `n8n --url "$(op read 'op://Agent Vault/N8N Instance/url')/api/v1" --key "$(op read 'op://Agent Vault/N8N API Key/credential')"`, 'allow'],
  ['Bash', `export APIFY_TOKEN=$(op read "op://Agent Vault/Apify API Token/credential")`, 'allow'],
  ['Bash', `npx -y firecrawl-cli@latest init --all -k "$(op read 'op://Agent Vault/Firecrawl API Key/credential')"`, 'allow'],
  ['Bash', `claude mcp add --transport http exa --scope user "https://mcp.exa.ai/mcp?exaApiKey=$(op read 'op://Agent Vault/Exa API Key/credential')"`, 'allow'],
  ['Bash', `export ANTHROPIC_API_KEY=$(op read "op://Agent Vault/Anthropic API Key/credential" 2>/dev/null)`, 'allow'],

  // --- other legitimate forms ---
  ['Bash', 'op run -- npm test', 'allow'],
  ['Bash', 'infisical run -- npm test', 'allow'],
  ['Bash', `op read "op://Agent Vault/Anthropic API Key/credential" | head -c 4`, 'allow'],
  ['Bash', 'printenv PATH', 'allow'],
  ['Bash', 'env FOO=bar npm start', 'allow'],
  ['Bash', 'cat .env.example', 'allow'],
  ['Bash', 'git status', 'allow'],
  ['Bash', 'op whoami', 'allow'],
  ['Bash', 'op item list --vault "Agent Vault"', 'allow'],
  ['PowerShell', 'git status', 'allow'],
  ['PowerShell', '$env:PATH', 'allow'],

  // --- the real leak path: Claude printing a raw secret ---
  ['Bash', `op read "op://Agent Vault/Anthropic API Key/credential"`, 'deny'],
  ['Bash', 'echo $ANTHROPIC_API_KEY', 'deny'],
  ['Bash', 'printenv OPENAI_API_KEY', 'deny'],
  ['Bash', 'cat .env', 'deny'],

  // --- runtime-injection-wrapped env dumps (the bypass #9 closes) ---
  ['Bash', 'infisical run -- printenv', 'deny'],
  ['Bash', 'op run -- printenv', 'deny'],

  // --- assignment-only env still dumps the environment ---
  ['Bash', 'env FOO=bar', 'deny'],

  // --- bulk dumps ---
  ['Bash', 'infisical secrets', 'deny'],
  ['Bash', 'bw export', 'deny'],
  ['Bash', 'op item get "Anthropic API Key" --reveal', 'deny'],
  ['Bash', 'env', 'deny'],
  ['PowerShell', 'Get-Content .env', 'deny'],
];

let pass = 0;
const fails = [];
for (const [tool, command, expected] of CASES) {
  const got = decision(tool, command);
  if (got === expected) { pass++; }
  else fails.push({ tool, command, expected, got });
}

for (const f of fails) {
  console.error(`FAIL [${f.tool}] expected ${f.expected}, got ${f.got}:\n  ${f.command}`);
}
console.log(`${pass}/${CASES.length} passed`);
process.exit(fails.length ? 1 : 0);

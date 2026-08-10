#!/usr/bin/env node
// op-tripwire: detector-rule
// Allow/block table for secrets-guard.js. Run: `node hooks/secrets-guard.test.mjs`
// Feeds PreToolUse JSON into the real hook and checks the decision. No secret
// command is ever executed - only the hook's static matcher runs.
//
// The "real-workflow allow" block pins the exact `$(op read ...)` injection
// shapes Wade runs day to day, so a future edit that accidentally blocks them
// fails CI instead of silently breaking his automation.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'secrets-guard.js');
const FAKE_ANTHROPIC = 'sk-ant-' + 'api03-' + 'A1b2C3d4E5'.repeat(6);
const FAKE_LANGFUSE = 'sk-lf-' + 'L'.repeat(20);
const FAKE_GITHUB_PAT = 'github_pat_' + 'G'.repeat(24);
const FAKE_SLACK_APP = 'xapp-' + 'S'.repeat(24);
const FAKE_SUPABASE = 'sb_secret_' + 'U'.repeat(20);
const FAKE_STRIPE_LIVE = 'sk_live_' + 'S'.repeat(20);
const FAKE_STRIPE_RESTRICTED = 'rk_live_' + 'R'.repeat(20);
const FAKE_STRIPE_TEST = 'sk_test_' + 'T'.repeat(20);

// decision('Bash'|'PowerShell', command) -> 'allow' | 'deny'
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
function decision(tool, arg) {
  // Bash/PowerShell take a command string; Write/Edit take a tool_input (string -> {content}).
  const tool_input = WRITE_TOOLS.includes(tool)
    ? (typeof arg === 'string' ? { content: arg } : arg)
    : { command: arg };
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input }),
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
  // --env-file is an OPTION (loads a file into the child), not the `-- env` dump
  // command. The guard must not confuse the two. (regression: --\s* false positive)
  ['Bash', 'op run --env-file=secrets.env -- npm start', 'allow'],
  ['Bash', 'op run --env-file=.env.prod -- ./deploy.sh', 'allow'],
  ['Bash', 'infisical run --env-file="creds.env" -- node server.js', 'allow'],
  ['Bash', 'op run', 'allow'],
  ['Bash', 'git status && op run', 'allow'],
  ['Bash', `infisical run -- bash -c 'test -n "$API_KEY"; exec /bin/true'`, 'allow'],
  ['Bash', `env -u INFISICAL_TOKEN /bin/bash -c 'test -n "$API_KEY"; exec /bin/true'`, 'allow'],
  ['Bash', '/usr/bin/env FOO=bar /bin/true', 'allow'],
  ['Bash', 'env --ignore-environment FOO=bar /usr/bin/printenv PATH', 'allow'],
  ['Bash', `env -S 'FOO=bar /bin/true'`, 'allow'],
  ['Bash', 'env -- FOO=bar /bin/true', 'allow'],
  ['Bash', 'env -i -u FOO -C /tmp FOO=bar /bin/true', 'allow'],
  ['Bash', `env --split-string='FOO=bar /bin/true'`, 'allow'],
  ['Bash', 'env --unset=FOO /bin/true', 'allow'],
  ['Bash', 'infisical run -- /usr/bin/env -u FOO /bin/true', 'allow'],
  ['Bash', `op read "op://Agent Vault/Anthropic API Key/credential" | head -c 4`, 'allow'],
  ['Bash', `/usr/local/bin/op read "op://Agent Vault/Anthropic API Key/credential" | head -c 4`, 'allow'],
  ['Bash', 'printenv PATH', 'allow'],
  ['Bash', 'env FOO=bar npm start', 'allow'],
  ['Bash', 'cat .env.example', 'allow'],
  ['Bash', 'git status', 'allow'],
  ['Bash', 'op whoami', 'allow'],
  ['Bash', 'op item list --vault "Agent Vault"', 'allow'],
  // `op read` INSIDE a quoted string (grep pattern, docs) is not a live command - must NOT block
  ['Bash', 'grep -n "op read" notes.md', 'allow'],
  ['Bash', 'grep -niE "1password|op read|op://" file.md', 'allow'],
  ['Bash', 'rg "how to op read from the vault" docs/', 'allow'],
  ['Bash', 'grep -n "cat .env && op run" notes.md', 'allow'],
  // Commit/PR message text is inert data, not an executable reader command. These pin the
  // student-reported false positive without weakening executable siblings or literal-key scans.
  ['Bash', 'git commit -m "fix cat parsing in .env loader"', 'allow'],
  ['Bash', 'git commit --message="document cat .env behavior"', 'allow'],
  ['Bash', 'gh pr create --title "fix cat parsing in .env loader" --body "mentions printenv and op read"', 'allow'],
  ['Bash', 'echo "cat .env"', 'allow'],
  // the word "env" inside a quoted arg, piped to a filter - the old line-138 false positive
  ['Bash', `grep 'env' config.txt | head`, 'allow'],
  ['PowerShell', 'git status', 'allow'],
  ['PowerShell', '$env:PATH', 'allow'],
  ['PowerShell', 'Write-Host "build complete"', 'allow'],
  ['PowerShell', 'Write-Host $env:PATH', 'allow'],
  ['Bash', 'echo $HOME', 'allow'],
  ['Bash', 'printf "%s\\n" "sk-ant-PLACEHOLDER" > .env.example', 'allow'],
  ['Bash', 'supabase projects api-keys', 'allow'],

  // --- the real leak path: Claude printing a raw secret ---
  ['Bash', `op read "op://Agent Vault/Anthropic API Key/credential"`, 'deny'],
  ['Bash', 'echo $ANTHROPIC_API_KEY', 'deny'],
  ['Bash', 'printenv OPENAI_API_KEY', 'deny'],
  ['Bash', 'cat .env', 'deny'],
  ['Bash', 'git commit -m safe && cat .env', 'deny'],
  ['Bash', 'cat .env && git commit -m safe', 'deny'],
  ['Bash', 'git commit -m safe && bash <<EOF\ncat .env\nEOF', 'deny'],
  ['Bash', `git commit -m "${FAKE_ANTHROPIC}"`, 'deny'],

  // --- runtime-injection-wrapped env dumps (the bypass #9 closes) ---
  ['Bash', 'infisical run -- printenv', 'deny'],
  ['Bash', 'op run -- printenv', 'deny'],
  // --env-file flag is fine, but a real `-- env` dump tail after it must still block.
  ['Bash', 'op run --env-file=x.env -- env', 'deny'],
  ['Bash', 'cat .env && infisical run -- true', 'deny'],
  ['Bash', 'cat .env && op run', 'deny'],
  ['Bash', 'env && infisical run -- true', 'deny'],
  ['Bash', 'echo $API_KEY && infisical run -- true', 'deny'],
  ['Bash', 'op item get thing --reveal && infisical run -- true', 'deny'],
  ['Bash', `infisical run -- bash -c 'env'`, 'deny'],
  ['Bash', `op run -- sh -c 'printenv'`, 'deny'],
  ['Bash', `infisical run -- /bin/bash -lc '/usr/bin/env'`, 'deny'],

  // --- assignment-only env still dumps the environment ---
  ['Bash', 'env FOO=bar', 'deny'],
  ['Bash', '/usr/bin/env', 'deny'],
  ['Bash', '/usr/bin/printenv', 'deny'],
  ['Bash', 'env -u INFISICAL_TOKEN', 'deny'],
  ['Bash', 'env --chdir /tmp', 'deny'],
  ['Bash', 'env FOO=bar /usr/bin/env', 'deny'],
  ['Bash', 'env -u FOO /usr/bin/printenv API_KEY', 'deny'],
  ['Bash', `env -S 'printenv API_KEY'`, 'deny'],
  ['Bash', `env --split-string='printenv API_KEY'`, 'deny'],
  ['Bash', 'env --unset FOO', 'deny'],
  ['Bash', `infisical run -- /usr/bin/env -u FOO /bin/bash -c 'printenv API_KEY'`, 'deny'],

  // --- bulk dumps ---
  ['Bash', 'infisical secrets', 'deny'],
  ['Bash', 'bw export', 'deny'],
  ['Bash', 'op item get "Anthropic API Key" --reveal', 'deny'],
  ['Bash', 'supabase projects api-keys --reveal', 'deny'],
  ['Bash', '/usr/local/bin/supabase projects api-keys --reveal', 'deny'],
  ['Bash', 'env', 'deny'],
  ['PowerShell', 'Get-Content .env', 'deny'],

  // --- PowerShell secret-print coverage (the layer ported from Wade's §6) ---
  ['PowerShell', 'Write-Host $env:OPENAI_API_KEY', 'deny'],
  ['PowerShell', 'Write-Output $env:ANTHROPIC_API_KEY', 'deny'],
  ['PowerShell', 'echo $env:STRIPE_SECRET', 'deny'],

  // --- broader secret names (PASSWORD / CREDENTIAL), both shells ---
  ['Bash', 'echo $DB_PASSWORD', 'deny'],
  ['Bash', 'printf $MY_CREDENTIAL', 'deny'],
  ['PowerShell', 'Write-Host $env:DB_PASSWORD', 'deny'],

  // --- Path-qualified and nested shell secret reads remain executable, not inert docs text. ---
  ['Bash', `/usr/local/bin/op read 'op://vault/item/field'`, 'deny'],
  ['Bash', `bash -c 'op read op://vault/item/field'`, 'deny'],
  ['Bash', `infisical run -- bash -c '/usr/local/bin/op read op://vault/item/field'`, 'deny'],

  // --- Write/Edit: block a real-looking secret written into a file. Fake keys are built by
  //     concat so no contiguous key literal sits in this test file (would trip gitleaks). ---
  ['Write', 'const port = 3000;\nexport const NAME = "app";', 'allow'],
  ['Write', 'Set your ANTHROPIC_API_KEY in .env before running (never commit it).', 'allow'],
  ['Write', 'DB_URL=postgres://user:password@localhost:5432/dev  # placeholder', 'allow'],
  ['Write', 'KEY=' + FAKE_ANTHROPIC, 'deny'],
  ['Write', 'LANGFUSE=' + FAKE_LANGFUSE, 'deny'],
  ['Write', 'GITHUB=' + FAKE_GITHUB_PAT, 'deny'],
  ['Write', 'SLACK=' + FAKE_SLACK_APP, 'deny'],
  ['Write', 'SUPABASE=' + FAKE_SUPABASE, 'deny'],
  ['Write', 'STRIPE_SECRET_KEY=' + FAKE_STRIPE_LIVE, 'deny'],
  ['Write', 'STRIPE=' + FAKE_STRIPE_RESTRICTED, 'deny'],
  // sk_test_ is deliberately NOT matched. Stripe's own tutorials paste test keys constantly, so
  // matching them would fire during ordinary coursework for no real exposure.
  ['Write', 'STRIPE_SECRET_KEY=' + FAKE_STRIPE_TEST, 'allow'],
  ['Write', 'STRIPE_SECRET_KEY=sk_live_your_key_here  # placeholder', 'allow'],
  ['Bash', `echo ${FAKE_STRIPE_LIVE}`, 'deny'],
  ['PowerShell', `Write-Output ${FAKE_STRIPE_LIVE}`, 'deny'],
  ['Bash', `stripe listen --api-key ${FAKE_STRIPE_RESTRICTED}`, 'deny'],
  ['Bash', `echo ${FAKE_STRIPE_TEST}`, 'allow'],
  ['Write', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'deny'],
  ['Edit', { new_string: 'AWS=' + 'AKIA' + 'ABCDEFGH12345678' }, 'deny'],
  ['Edit', { new_string: 'a clean replacement line' }, 'allow'],
  ['NotebookEdit', { new_source: 'print("hello world")' }, 'allow'],

  // --- Literal secret shapes must not bypass Write/Edit via shell-authored files. ---
  ['Bash', `printf '%s\\n' '${FAKE_ANTHROPIC}' > config.json`, 'deny'],
  ['Bash', `cat > config.json <<'EOF'\n${FAKE_ANTHROPIC}\nEOF`, 'deny'],
  ['Bash', `node -e 'require("fs").writeFileSync("config.json", "${FAKE_ANTHROPIC}")'`, 'deny'],
  ['PowerShell', `Set-Content -Path config.json -Value '${FAKE_ANTHROPIC}'`, 'deny'],

  // --- op run / infisical run now RE-VET the wrapped command (not a blanket allow) ---
  ['Bash', 'op run -- cat config.json', 'allow'],           // wrapped non-secret read is fine
  ['Bash', `mytool --token "$(op read 'op://Agent Vault/x/credential')"`, 'allow'], // program injection stays allowed
  ['Bash', 'op run -- cat .env', 'deny'],                   // wrapped .env read now caught
  ['Bash', 'infisical run -- cat .env', 'deny'],

  // --- printed command-substitution of a vault read (Fable audit finding 2b) ---
  ['Bash', `echo "$(op read 'op://Agent Vault/Anthropic API Key/credential')"`, 'deny'],
  ['Bash', 'echo $(op read op://vault/item/field)', 'deny'],
  ['Bash', 'echo "$(op read op://vault/item/field | head -c 4)"', 'allow'], // masked verify stays allowed

  // === PR #14 review regressions (installer repo) - each proves one named bypass stays closed ===
  // Wrapper-prefix: a bare wrapper is not a blanket allow, and a sibling dump on either side runs.
  ['Bash', 'cat .env && infisical run', 'deny'],
  ['Bash', 'infisical run -- true && cat .env', 'deny'],
  ['Bash', 'infisical run -- /usr/bin/env', 'deny'],
  // Nested-shell: the payload of `sh|bash -c '<cmd>'` is re-vetted, benign payloads stay allowed.
  ['Bash', `bash -c 'cat .env'`, 'deny'],
  ['Bash', `sh -c "printenv OPENAI_API_KEY"`, 'deny'],
  ['Bash', 'op run -- bash -c "npm run build"', 'allow'],
  ['Bash', `bash -c 'npm test'`, 'allow'],
  ['Bash', `sh -c 'echo hello'`, 'allow'],
  // Path-qualified: a leading path is stripped for rule matching; a benign path-qualified command stays allowed.
  ['Bash', '/usr/bin/git status', 'allow'],
  // Shell-authored literal key: an inline vendor-shaped secret is blocked (built by concat so no
  // contiguous key literal sits in this test file and trips gitleaks).
  ['Bash', `curl -H "Authorization: Bearer ` + 'sk-ant-' + 'api03-' + 'Z9y8X7w6V5'.repeat(6) + `" https://api.example.com`, 'deny'],

  // === Remote-exec / wrapper unwrapping (Douglas Rimer report: a real Postgres password printed
  // through an ssh-wrapped command the guard never opened). The inner command must face the same
  // rules as a local run - `ssh host "cat .env"` denies exactly like `bash -c 'cat .env'`. ===
  ['Bash', 'ssh prod-db "cat .env"', 'deny'],
  ['Bash', 'ssh -p 2222 deploy@prod-db "cat .env"', 'deny'],
  ['Bash', 'ssh -tt prod-db "printenv DB_PASSWORD"', 'deny'],
  ['Bash', `ssh prod-db "bash -c 'cat .env'"`, 'deny'],
  ['Bash', 'docker exec web cat .env', 'deny'],
  ['Bash', 'docker exec -u root web printenv API_KEY', 'deny'],
  ['Bash', 'docker compose exec web cat .env', 'deny'],
  ['Bash', 'docker compose -f docker-compose.yml exec web env', 'deny'],
  ['Bash', 'kubectl exec web-pod -- cat .env', 'deny'],
  ['Bash', 'kubectl exec -n prod -it web-pod -- env', 'deny'],
  ['Bash', 'sudo cat .env', 'deny'],
  ['Bash', 'sudo -u root printenv DB_PASSWORD', 'deny'],
  ['Bash', 'sudo bash -c "cat .env"', 'deny'],
  ['Bash', 'nohup cat .env', 'deny'],
  ['Bash', 'timeout 5 cat .env', 'deny'],
  ['Bash', 'timeout -s KILL 5 printenv API_KEY', 'deny'],
  ['Bash', 'su -c "cat .env"', 'deny'],
  ['Bash', 'su postgres -c "printenv DB_PASSWORD"', 'deny'],
  ['Bash', 'find . -exec cat .env \\;', 'deny'],
  // Benign wrapped commands stay allowed - unwrapping must not turn remote work into a deny.
  ['Bash', 'ssh prod-db "ls"', 'allow'],
  ['Bash', 'ssh -p 2222 deploy@prod-db "ls -la /app"', 'allow'],
  ['Bash', 'ssh prod-db uptime', 'allow'],
  ['Bash', 'docker exec web ls', 'allow'],
  ['Bash', 'docker exec -it web bash', 'allow'],
  ['Bash', 'docker compose exec web npm test', 'allow'],
  ['Bash', 'kubectl exec web-pod -- ls /app', 'allow'],
  ['Bash', 'sudo ls -la', 'allow'],
  ['Bash', 'timeout 5 npm test', 'allow'],
  ['Bash', 'nohup node server.js &', 'allow'],
  ['Bash', 'su -c "ls"', 'allow'],
  ['Bash', 'find . -name "*.log" -exec ls {} \\;', 'allow'],
  // Wrapper syntax inside quoted text is inert data, not an executable command.
  ['Bash', 'git commit -m "document ssh host cat .env behavior"', 'allow'],
  ['Bash', 'grep -n "kubectl exec" notes.md', 'allow'],

  // === agent-native-os#94: the read path was guarded by a wrapper allowlist. =================
  // Robin Bertus probed 37 read-path commands against secrets-guard-2026-07-28; 26 passed.
  // Classes 1-2 are gaps in an enumeration; classes 3-5 cannot be closed by extending it at all,
  // because nothing is executed and there is no inner command to unwrap.

  // -- class 1: the wrapper allowlist keyed on the binary NAME, so a rename walked through --
  ['Bash', 'docker-compose exec api env', 'deny'],
  ['Bash', 'podman exec api printenv', 'deny'],
  ['Bash', 'nerdctl exec api printenv', 'deny'],
  ['Bash', 'lxc exec c1 -- printenv', 'deny'],
  ['Bash', 'incus exec c1 -- printenv', 'deny'],
  ['Bash', 'docker run --rm alpine env', 'deny'],
  // -- class 2: every PaaS ships its own "run this over there" verb --
  ['Bash', 'fly ssh console -C printenv', 'deny'],
  ['Bash', 'flyctl ssh console -C printenv', 'deny'],
  ['Bash', 'gcloud compute ssh vm-1 --command printenv', 'deny'],
  ['Bash', 'az vm run-command invoke -g rg -n vm --scripts printenv', 'deny'],
  ['Bash', 'heroku run printenv', 'deny'],
  ['Bash', 'railway run printenv', 'deny'],
  ['Bash', 'doctl compute ssh droplet --ssh-command printenv', 'deny'],
  ['Bash', 'flatpak run --command=printenv org.x.App', 'deny'],
  // -- class 3: introspection prints the environment without executing anything --
  ['Bash', 'docker inspect api', 'deny'],
  ['Bash', "docker inspect --format '{{.Config.Env}}' api", 'deny'],
  ['Bash', 'podman inspect api', 'deny'],
  ['Bash', 'kubectl describe pod api', 'deny'],
  ['Bash', 'kubectl get pod api -o yaml', 'deny'],
  ['Bash', 'systemctl show myunit', 'deny'],
  ['Bash', 'systemctl show --property=Environment myunit', 'deny'],
  // -- class 4: platform stores. `list` is names-only everywhere and stays allowed. --
  ['Bash', 'vercel env pull', 'deny'],
  ['Bash', 'heroku config:get DATABASE_URL', 'deny'],
  ['Bash', 'gh secret list', 'allow'],
  ['Bash', 'fly secrets list', 'allow'],
  // -- class 5: the OS hands the environment over directly --
  ['Bash', 'cat /proc/1/environ', 'deny'],
  ['Bash', "tr '\\0' '\\n' < /proc/self/environ", 'deny'],
  ['Bash', 'strings /proc/1/environ', 'deny'],
  ['Bash', 'ssh api-host cat /proc/1/environ', 'deny'],
  ['Bash', 'ps eww', 'deny'],
  ['Bash', 'ps auxe', 'deny'],
  // ...but WRITING about the path is not reading it. Caught in live use: a `gh pr merge --body`
  // describing this very fix was blocked by an earlier draft that matched the path as raw text.
  ['Bash', 'gh pr merge 19 --squash --body "adds a rule for /proc/<pid>/environ reads"', 'allow'],
  ['Bash', 'git commit -m "document the /proc/1/environ class"', 'allow'],
  ['Bash', 'grep -rn "/proc/self/environ" docs/', 'allow'],

  // -- the reader allowlist: any printer outside the set read .env untouched --
  ['Bash', 'grep . .env', 'deny'],
  ['Bash', 'sed -n p .env', 'deny'],
  ['Bash', 'awk 1 .env', 'deny'],
  ['Bash', 'cut -d= -f2 .env', 'deny'],
  ['Bash', 'sort .env', 'deny'],
  ['Bash', 'dd if=.env', 'deny'],
  ['Bash', 'tee < .env', 'deny'],
  ['Bash', 'tr -d "" < .env', 'deny'],
  ['Bash', 'while read l; do echo "$l"; done < .env', 'deny'],
  // -- PowerShell: the fully-qualified type name and Get-Item reach the same drive --
  ['PowerShell', '[System.Environment]::GetEnvironmentVariables()', 'deny'],
  ['PowerShell', '(Get-Item Env:).Value', 'deny'],
  ['PowerShell', 'Get-Item Env:* | Out-String', 'deny'],
  ['PowerShell', 'Get-Item Env:PATH', 'allow'],

  // === False-positive guards for the #94 fix. Each pins a real command from 9,489 collected
  // === from this machine's actual history, where an earlier draft of the fix blocked it.
  // `show`/`describe` unqualified cost 249 false blocks; they are runtime-qualified now.
  ['Bash', 'git show HEAD', 'allow'],
  ['Bash', 'git show HEAD~3:src/index.js', 'allow'],
  ['Bash', 'git describe --tags --abbrev=0', 'allow'],
  ['Bash', 'npm show react versions', 'allow'],
  ['Bash', 'hermes kanban show t_8b01fe26', 'allow'],
  ['Bash', 'npm run inspect', 'allow'],
  ['Bash', 'npm run test -- --grep env', 'allow'],
  ['Bash', 'bundle exec rspec spec/', 'allow'],
  ['Bash', 'docker ps', 'allow'],
  ['Bash', 'docker run --rm -it ubuntu bash', 'allow'],
  ['Bash', 'kubectl get pods', 'allow'],
  ['Bash', 'kubectl get svc -o wide', 'allow'],
  ['Bash', 'ps aux', 'allow'],
  ['Bash', 'ps -ef', 'allow'],
  ['Bash', 'ps -eo pid,ppid,cmd', 'allow'],
  // A verb sitting in prose is not a command: heredoc commit bodies must not trip the rule.
  ['Bash', "git commit -F - <<'EOF'\ndocs: the proposal reframes describe-first authoring\nEOF", 'allow'],
  // `systemctl show -p <prop>` is the remediation the deny message recommends.
  ['Bash', 'systemctl --user show hermes-gateway.service -p Restart -p RestartSec', 'allow'],
  ['Bash', 'systemctl --user show hermes-gateway.service -p Environment', 'deny'],
  // Auditing a .env WITHOUT printing values - the names-only idiom, and its value-printing sibling.
  ['Bash', `grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' ~/.hermes/.env`, 'allow'],
  ['Bash', `grep -ohE "^LANGFUSE[A-Z_]*=" ~/.hermes/.env`, 'allow'],
  ['Bash', 'grep -c "^EXA_API_KEY=" ~/.hermes/.env', 'allow'],
  ['Bash', `grep -oE '^[A-Z_]+=[^ ]+' .env`, 'deny'],
  // `sed -i` rewrites in place and prints nothing.
  ['Bash', `sed -i 's/\\r$//' intake-get.sh intake.env`, 'allow'],
  // A quoted search pattern is not a filename.
  ['Bash', 'jq .env config.json', 'allow'],
  ['Bash', 'jq -r ".scripts.build" package.json', 'allow'],
  ['Bash', 'rg -n "cat .env" docs/', 'allow'],
  ['Bash', "awk -F, '{print $2}' data.csv", 'allow'],
  ['Bash', 'sort access.log | uniq -c | head', 'allow'],
];

// A PreToolUse hook runs before every tool call, so an unexpected payload shape must exit
// quietly instead of throwing - a crashing guard breaks the whole session, not just one command.
const MALFORMED_PAYLOADS = [
  '', 'not json', 'null', '[1,2,3]', '{}',
  '{"tool_name":"Bash"}',
  '{"tool_name":"Bash","tool_input":null}',
  '{"tool_name":"Bash","tool_input":{"command":42}}',
  '{"tool_name":"Bash","tool_input":{"command":{"a":1}}}',
  '{"tool_name":"Bash","tool_input":{"command":["ls"]}}',
  '{"tool_name":"Edit","tool_input":{"edits":"nope"}}',
  '{"tool_name":"MultiEdit","tool_input":{"edits":[null,{"new_string":"x"}]}}',
];
const malformedFails = [];
for (const payload of MALFORMED_PAYLOADS) {
  const r = spawnSync('node', [HOOK], { input: payload, encoding: 'utf8' });
  if (r.status !== 0 || (r.stderr || '').trim())
    malformedFails.push(`${JSON.stringify(payload).slice(0, 50)} -> exit ${r.status} ${(r.stderr || '').split('\n')[0].slice(0, 80)}`);
}
for (const f of malformedFails) console.error(`FAIL [malformed] ${f}`);

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
console.log(`${pass}/${CASES.length} passed, ${MALFORMED_PAYLOADS.length - malformedFails.length}/${MALFORMED_PAYLOADS.length} malformed payloads handled without crashing`);
process.exit(fails.length || malformedFails.length ? 1 : 0);

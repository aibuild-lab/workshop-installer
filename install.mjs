#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

export const DEFAULT_REPO_NAME = "agent-native-os-private";
export const DEFAULT_INSTALLER_REPO = "aibuild-lab/workshop-installer";
export const DEFAULT_PYTHON_VERSION = "3.12";
export const STATE_VERSION = 1;
export const PYTHON_MANAGER_COMMANDS = ["conda", "mamba", "micromamba", "pyenv", "mise"];

const ENTRYPOINT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(ENTRYPOINT);

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      parsed[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

export function defaultWorkspace(home = os.homedir()) {
  return path.join(home, "GitHub");
}

export function defaultStateFile(home = os.homedir()) {
  return path.join(home, ".aibl", "workshop-installer", "state.json");
}

export function resolveWorkspace(value, home = os.homedir()) {
  const raw = value || defaultWorkspace(home);
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

export function cloudSyncReason(targetPath) {
  const normalized = String(targetPath || "").replaceAll("\\", "/").toLowerCase();
  const blocked = [
    "dropbox",
    "onedrive",
    "icloud drive",
    "clouddocs",
    "mobile documents",
    "google drive",
    "my drive",
    "box",
    "creative cloud files",
  ];
  const match = blocked.find((segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`));
  return match ? `The path appears to be inside ${match}.` : null;
}

export function detectSupportedPlatform(platform = process.platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "unsupported";
}

export function parsePythonVersion(output) {
  const match = String(output || "").match(/(?:Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

export function pythonVersionIsSupported(version) {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 10);
}

export function classifyPythonEnvironment({ uvAvailable = false, managerVersions = {}, plainPythonVersion = null } = {}) {
  if (uvAvailable) return { kind: "uv", manager: "uv" };
  for (const manager of PYTHON_MANAGER_COMMANDS) {
    if (pythonVersionIsSupported(managerVersions[manager])) {
      return { kind: "existing-manager", manager };
    }
  }
  if (pythonVersionIsSupported(plainPythonVersion)) return { kind: "plain-python-only" };
  return { kind: "missing" };
}

export function buildStepPlan({ platform, workspace, repoName = DEFAULT_REPO_NAME, cohort1 = false }) {
  const common = [
    { id: "workspace", label: `Confirm workspace: ${workspace}` },
    { id: "git", label: "Install or verify Git" },
    { id: "node", label: "Install or verify Node.js v18+" },
    { id: "gh", label: "Install or verify GitHub CLI" },
    { id: "python-env", label: "Install or verify Python environment" },
    { id: "claude", label: "Install or verify Claude Code" },
    { id: "infisical", label: "Install or verify Infisical CLI" },
    { id: "github-auth", label: "Verify GitHub CLI sign-in" },
    { id: "claude-auth", label: "Confirm Claude Code browser sign-in" },
    { id: "infisical-auth", label: "Verify Infisical CLI sign-in without printing secrets" },
    { id: "secrets-guard", label: "Install Claude Code secrets guard" },
  ];
  const repoLabel = cohort1
    ? "Run Cohort 1 migration for an existing agent-native-os clone"
    : `Create or verify private workshop repo '${repoName}'`;
  return [
    { id: "platform", label: `Detected platform: ${platform}` },
    ...common,
    { id: "repo-setup", label: repoLabel },
  ];
}

export function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return { version: STATE_VERSION, completed: [] };
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!Array.isArray(parsed.completed)) parsed.completed = [];
  if (!parsed.version) parsed.version = STATE_VERSION;
  return parsed;
}

export function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function nextRunnableSteps(plan, state, resume) {
  if (!resume) return plan;
  const completed = new Set(state.completed || []);
  return plan.filter((step) => !completed.has(step.id));
}

function printHelp() {
  console.log(`AI Build Lab deterministic installer beta

Usage:
  node install.mjs [workspace] [options]

Options:
  --dry-run              Print the plan without installing tools or changing repos
  --resume               Skip steps recorded as completed in the state file
  --yes                  Use defaults and skip confirmation prompts
  --workspace <path>     Parent folder for workshop repos (default: ~/GitHub)
  --repo-name <name>     Private GitHub repo name (default: ${DEFAULT_REPO_NAME})
  --cohort1              Migrate an existing Cohort 1 agent-native-os clone
  --state-file <path>    Override resume-state file path
  --help                 Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const platform = detectSupportedPlatform();
  if (platform === "unsupported") {
    fail(`Unsupported platform: ${process.platform}. This beta installer supports macOS and Windows only.`);
  }

  const dryRun = args["dry-run"] === true;
  const assumeYes = args.yes === true;
  const resume = args.resume === true;
  const cohort1 = args.cohort1 === true;
  const repoName = String(args["repo-name"] || DEFAULT_REPO_NAME);
  const workspaceArg = args.workspace || args._[0];
  const workspace = await chooseWorkspace({ workspaceArg, assumeYes, dryRun });
  const stateFile = resolveStateFile(args["state-file"]);

  printHeader({ dryRun, platform, workspace, cohort1, repoName, resume, stateFile });

  const unsafeReason = cloudSyncReason(workspace);
  if (unsafeReason) {
    fail(
      [
        `Unsafe workspace folder: ${workspace}`,
        "",
        `Why this stopped: ${unsafeReason}`,
        "Git repos inside cloud sync folders can corrupt .git, create lock conflicts, or sync secrets.",
        `Use the safe default instead: ${defaultWorkspace()}`,
      ].join("\n"),
    );
  }

  const plan = buildStepPlan({ platform, workspace, repoName, cohort1 });
  const state = loadState(stateFile);
  const runnable = nextRunnableSteps(plan, state, resume);

  console.log("Plan:");
  for (const step of plan) {
    const skipped = resume && !runnable.includes(step) ? " (already completed)" : "";
    console.log(`- ${step.label}${skipped}`);
  }
  console.log("");

  if (dryRun) {
    console.log("Dry run complete. No tools were installed and no repos were changed.");
    return;
  }

  if (!assumeYes) {
    const confirmed = await confirm(`Proceed with workspace '${workspace}'? Type yes to continue: `);
    if (!confirmed) fail("Stopped before making changes.");
  }

  for (const step of runnable) {
    await runStep(step, { platform, workspace, repoName, cohort1, assumeYes });
    markCompleted(stateFile, state, step.id);
  }

  console.log("");
  console.log("Deterministic installer complete.");
  console.log(`Workshop workspace: ${workspace}`);
  console.log(cohort1 ? "Cohort 1 migration path was used." : `Private repo name: ${repoName}`);
}

async function chooseWorkspace({ workspaceArg, assumeYes, dryRun }) {
  if (workspaceArg) return resolveWorkspace(String(workspaceArg));
  const fallback = defaultWorkspace();
  if (assumeYes || dryRun || !process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`Workspace folder [${fallback}]: `);
  rl.close();
  return resolveWorkspace(answer.trim() || fallback);
}

function resolveStateFile(value) {
  return value ? resolveWorkspace(String(value)) : defaultStateFile();
}

function printHeader({ dryRun, platform, workspace, cohort1, repoName, resume, stateFile }) {
  console.log("AI Build Lab deterministic installer beta");
  console.log("=========================================");
  console.log("");
  if (dryRun) console.log("DRY RUN: no changes will be made.");
  if (resume) console.log(`Resume state: ${stateFile}`);
  console.log(`Platform: ${platform}`);
  console.log(`Workspace: ${workspace}`);
  console.log(cohort1 ? "Mode: Cohort 1 migration" : `Mode: fresh private repo (${repoName})`);
  console.log("");
}

async function runStep(step, context) {
  console.log(`\n> ${step.label}`);
  switch (step.id) {
    case "platform":
    case "workspace":
      return;
    case "git":
      return installGit(context.platform);
    case "node":
      return installNode(context.platform);
    case "gh":
      return installGitHubCli(context.platform);
    case "python-env":
      return installPythonEnvironment(context.platform);
    case "claude":
      return installClaude(context.platform);
    case "infisical":
      return installInfisical(context.platform);
    case "github-auth":
      return verifyOrGuideGitHubAuth();
    case "claude-auth":
      return verifyOrGuideClaudeAuth(context.platform, context.assumeYes);
    case "infisical-auth":
      return verifyOrGuideInfisicalAuth();
    case "secrets-guard":
      return installSecretsGuard();
    case "repo-setup":
      return runRepoSetup(context);
    default:
      fail(`Unknown installer step: ${step.id}`);
  }
}

function installGit(platform) {
  if (commandSucceeds("git", ["--version"])) return console.log("Git is installed.");
  if (platform === "mac") {
    const brew = ensureHomebrew();
    run(brew, ["install", "git"]);
    return requireCommand("git", ["--version"], "Git install did not verify.");
  }
  requireCommand("winget", ["--version"], "winget is required on Windows 10 build 2004+ or Windows 11.");
  run("winget", ["install", "--id", "Git.Git", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
  requireCommand("git", ["--version"], "Git install did not verify. Open a fresh terminal and rerun.");
}

function installNode(platform) {
  if (nodeIsUsable()) return console.log("Node.js v18+ is installed.");
  if (platform === "mac") {
    const brew = ensureHomebrew();
    run(brew, ["install", "node"]);
    return requireNode();
  }
  requireCommand("winget", ["--version"], "winget is required on Windows 10 build 2004+ or Windows 11.");
  run("winget", ["install", "--id", "OpenJS.NodeJS.LTS", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
  requireNode();
}

function installGitHubCli(platform) {
  if (commandSucceeds("gh", ["--version"])) return console.log("GitHub CLI is installed.");
  if (platform === "mac") {
    const brew = ensureHomebrew();
    run(brew, ["install", "gh"]);
  } else {
    requireCommand("winget", ["--version"], "winget is required on Windows 10 build 2004+ or Windows 11.");
    run("winget", ["install", "--id", "GitHub.cli", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
  }
  requireCommand("gh", ["--version"], "GitHub CLI install did not verify.");
}

function installPythonEnvironment(platform) {
  const state = detectPythonEnvironment();
  if (state.kind === "uv") {
    console.log("uv is installed. Ensuring Python 3.12 is available through uv.");
    ensureUvPython();
    return;
  }
  if (state.kind === "existing-manager") {
    console.log(`Existing Python manager detected (${state.manager}) with Python 3.10+. Skipping uv install.`);
    return;
  }
  if (state.kind === "plain-python-only") {
    console.log("Python 3.10+ is installed, but no Python environment manager was detected. Installing uv.");
  }
  if (state.kind === "missing") {
    console.log("No acceptable Python environment was detected. Installing uv.");
  }
  installUv(platform);
  ensureUvPython();
}

function detectPythonEnvironment() {
  const managerVersions = {};
  for (const manager of PYTHON_MANAGER_COMMANDS) {
    if (commandSucceeds(manager, ["--version"])) {
      managerVersions[manager] = currentPythonVersion();
    }
  }
  return classifyPythonEnvironment({
    uvAvailable: commandSucceeds("uv", ["--version"]),
    managerVersions,
    plainPythonVersion: currentPythonVersion(),
  });
}

function currentPythonVersion() {
  for (const command of ["python3", "python"]) {
    const result = run(command, ["--version"], { allowFail: true, silent: true });
    if (result.status === 0) {
      const version = parsePythonVersion(`${result.stdout} ${result.stderr}`);
      if (version) return version;
    }
  }
  return null;
}

function installUv(platform) {
  if (platform === "mac") {
    const brew = ensureHomebrew();
    run(brew, ["install", "uv"]);
  } else {
    requireCommand("winget", ["--version"], "winget is required on Windows 10 build 2004+ or Windows 11.");
    run("winget", ["install", "--id=astral-sh.uv", "-e", "--accept-package-agreements", "--accept-source-agreements"]);
  }
  requireCommand("uv", ["--version"], "uv install did not verify. Open a fresh terminal and rerun with --resume.");
}

function ensureUvPython() {
  run("uv", ["python", "install", DEFAULT_PYTHON_VERSION]);
  requireCommand("uv", ["run", "--python", DEFAULT_PYTHON_VERSION, "python", "--version"], "uv-managed Python did not verify.");
}

function installClaude(platform) {
  if (commandSucceeds("claude", ["--version"]) || claudeBinaryExists(platform)) {
    ensureClaudePath(platform);
    return console.log("Claude Code is installed.");
  }
  if (platform === "mac") {
    run("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | sh"]);
  } else {
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
  }
  ensureClaudePath(platform);
  if (!claudeBinaryExists(platform) && !commandSucceeds("claude", ["--version"])) fail("Claude Code install did not verify.");
}

function installInfisical(platform) {
  if (commandSucceeds("infisical", ["--version"])) return console.log("Infisical CLI is installed.");
  if (platform === "mac") {
    const brew = ensureHomebrew();
    run(brew, ["install", "infisical/get-cli/infisical"]);
  } else {
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; if (!(Get-Command scoop -ErrorAction SilentlyContinue)) { iwr -useb get.scoop.sh | iex }; scoop bucket add org https://github.com/Infisical/scoop-infisical.git; scoop install infisical"]);
  }
  requireCommand("infisical", ["--version"], "Infisical CLI install did not verify.");
}

function ensureHomebrew() {
  const existing = homebrewCommand();
  if (existing) return existing;
  if (!commandSucceeds("xcode-select", ["-p"])) {
    console.log("Apple Command Line Tools are missing. macOS may open an installer dialog.");
    run("xcode-select", ["--install"], { allowFail: true });
    fail("Finish the Apple Command Line Tools installer, then rerun with --resume.");
  }
  run("sh", ["-c", '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"']);
  ensureMacShellPath();
  const installed = homebrewCommand();
  if (!installed) fail("Homebrew install did not verify.");
  return installed;
}

function verifyOrGuideGitHubAuth() {
  if (commandSucceeds("gh", ["api", "user", "--jq", ".login"])) return console.log("GitHub CLI is signed in.");
  console.log("GitHub CLI is not signed in. Run: gh auth login");
  fail("After GitHub browser sign-in completes, rerun with --resume.");
}

async function verifyOrGuideClaudeAuth(platform, assumeYes) {
  const claude = platform === "windows" ? path.join(os.homedir(), ".local", "bin", "claude.exe") : path.join(os.homedir(), ".local", "bin", "claude");
  if (!commandSucceeds(claude, ["--version"]) && !commandSucceeds("claude", ["--version"])) {
    fail("Claude Code is not reachable. Open a fresh terminal, run 'claude', complete sign-in, then rerun with --resume.");
  }
  if (assumeYes) {
    console.log("Claude Code binary verifies. --yes mode assumes browser sign-in is already complete.");
    return;
  }
  console.log("Claude Code browser sign-in is interactive and cannot be checked without launching a Claude session.");
  console.log("Open a fresh terminal, run 'claude', complete browser sign-in, then return here.");
  const confirmed = await confirm("Type yes after Claude Code sign-in succeeds: ");
  if (!confirmed) fail("Complete Claude Code sign-in, then rerun with --resume.");
}

function verifyOrGuideInfisicalAuth() {
  if (commandSucceeds("infisical", ["user"])) return console.log("Infisical CLI is signed in.");
  console.log("Infisical CLI is not signed in. Run: infisical login");
  fail("After Infisical browser sign-in completes, rerun with --resume. Do not run 'infisical user get token'.");
}

function installSecretsGuard() {
  const sourceDir = path.join(REPO_ROOT, "hooks");
  const hooksDir = path.join(os.homedir(), ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const file of ["secrets-guard.js", "secrets-tripwire.js", "install.mjs"]) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(hooksDir, file));
  }
  run(process.execPath, [path.join(hooksDir, "install.mjs")]);
  run(process.execPath, [path.join(sourceDir, "secrets-guard.test.mjs")]);
}

function runRepoSetup({ workspace, repoName, cohort1 }) {
  if (cohort1) {
    run(process.execPath, [path.join(REPO_ROOT, "scripts", "migrate-existing-student-repo.mjs"), "--yes"]);
    return;
  }
  run(process.execPath, [
    path.join(REPO_ROOT, "scripts", "prepare-workshop-repo.mjs"),
    "--yes",
    "--workspace",
    workspace,
    "--repo-name",
    repoName,
  ]);
}

function ensureClaudePath(platform) {
  if (platform === "mac") {
    ensureLine(path.join(os.homedir(), ".bash_profile"), 'export PATH="$HOME/.local/bin:$PATH"');
    ensureLine(path.join(os.homedir(), ".zshrc"), 'export PATH="$HOME/.local/bin:$PATH"');
  } else {
    run("powershell.exe", ["-NoProfile", "-Command", '[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\\.local\\bin", "User")']);
    run("powershell.exe", ["-NoProfile", "-Command", '[Environment]::SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", "C:\\Program Files\\Git\\bin\\bash.exe", "User")'], { allowFail: true });
  }
}

function ensureMacShellPath() {
  const brewPath = homebrewCommand() || "/opt/homebrew/bin/brew";
  const line = `eval "$(${brewPath} shellenv)"`;
  ensureLine(path.join(os.homedir(), ".bash_profile"), line);
  ensureLine(path.join(os.homedir(), ".zshrc"), line);
}

function homebrewCommand() {
  if (commandSucceeds("brew", ["--version"])) return "brew";
  for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (fs.existsSync(candidate) && commandSucceeds(candidate, ["--version"])) return candidate;
  }
  return null;
}

function ensureLine(filePath, line) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (existing.split(/\r?\n/).includes(line)) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(filePath, `${existing}${prefix}${line}\n`);
}

function nodeIsUsable() {
  const result = run("node", ["--version"], { allowFail: true, silent: true });
  if (result.status !== 0) return false;
  const major = Number(result.stdout.trim().replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 18;
}

function requireNode() {
  if (!nodeIsUsable()) fail("Node.js v18+ is required and did not verify.");
}

function claudeBinaryExists(platform) {
  const name = platform === "windows" ? "claude.exe" : "claude";
  return fs.existsSync(path.join(os.homedir(), ".local", "bin", name));
}

function requireCommand(command, args, message) {
  if (!commandSucceeds(command, args)) fail(message);
}

function commandSucceeds(command, args) {
  return run(command, args, { allowFail: true, silent: true }).status === 0;
}

function markCompleted(stateFile, state, stepId) {
  if (!state.completed.includes(stepId)) state.completed.push(stepId);
  state.updatedAt = new Date().toISOString();
  saveState(stateFile, state);
}

async function confirm(question) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.silent ? "pipe" : "inherit",
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0 && !options.allowFail) {
    fail(`Command failed: ${[command, ...commandArgs].join(" ")}`);
  }
  return { status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function fail(message) {
  console.error("");
  console.error(message);
  console.error("");
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === ENTRYPOINT) {
  main().catch((error) => fail(error.message || String(error)));
}

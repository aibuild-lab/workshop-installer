#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_UPSTREAM = "aibuild-lab/agent-native-os";
const DEFAULT_UPSTREAM_URL = "https://github.com/aibuild-lab/agent-native-os.git";
const DEFAULT_PRIVATE_REPO_NAME = "agent-native-os-private";
const DEFAULT_LOCAL_DIR = "agent-native-os";
const ALLOWED_UPSTREAMS = new Set([DEFAULT_UPSTREAM]);

const args = parseArgs(process.argv.slice(2));
const dryRun = args["dry-run"] === true;
const assumeYes = args.yes === true;
const workspaceRoot = resolveWorkspace(args.workspace);
const repoName = String(args["repo-name"] || DEFAULT_PRIVATE_REPO_NAME);
const repoPath = path.join(workspaceRoot, DEFAULT_LOCAL_DIR);

main().catch((error) => {
  fail(error.message || String(error));
});

async function main() {
  printHeader();

  const unsafeReason = cloudSyncReason(workspaceRoot);
  if (unsafeReason) {
    const safeDefault = path.join(os.homedir(), "GitHub");
    fail(
      [
        `Unsafe workspace folder: ${workspaceRoot}`,
        "",
        `Why this stopped: ${unsafeReason}`,
        "Git repos inside cloud sync folders can corrupt .git, create lock conflicts, or sync secrets.",
        "",
        `Use this safe default instead: ${safeDefault}`,
        `Command: node scripts/prepare-workshop-repo.mjs --workspace "${safeDefault}"`,
      ].join("\n"),
    );
  }

  verifyCommand("git", ["--version"]);
  verifyCommand("node", ["--version"]);
  verifyCommand("gh", ["--version"]);
  verifyGitHubAuth();
  const githubUser = readGitHubUser();

  console.log(`GitHub user: ${githubUser}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Local repo: ${repoPath}`);
  console.log(`Student private repo: ${githubUser}/${repoName}`);
  console.log("");

  if (!fs.existsSync(repoPath)) {
    await confirmAndRun(
      [
        `Create workspace folder if needed: ${workspaceRoot}`,
        `Clone ${DEFAULT_UPSTREAM} into ${repoPath}`,
      ],
      () => {
        fs.mkdirSync(workspaceRoot, { recursive: true });
        const cloneResult = run("gh", ["repo", "clone", DEFAULT_UPSTREAM, repoPath], { allowFail: true });
        if (cloneResult.status !== 0) {
          handleCloneFailure(cloneResult, DEFAULT_UPSTREAM, repoPath);
        }
      },
    );
    if (dryRun) {
      console.log("Dry run complete. Rerun without --dry-run to create and inspect the repo.");
      return;
    }
  } else if (!isGitRepo(repoPath)) {
    fail(
      [
        `The target folder exists but is not a Git repo: ${repoPath}`,
        "Choose a different workspace or move that folder before continuing.",
      ].join("\n"),
    );
  }

  const repoRoot = git(repoPath, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (path.resolve(repoRoot) !== path.resolve(repoPath)) {
    fail(`Expected ${repoPath} to be the repo root, but Git reported ${repoRoot}.`);
  }

  const branch = currentBranch(repoPath);
  const dirty = dirtyFiles(repoPath);
  const sensitive = sensitiveDirtyFiles(dirty);
  if (sensitive.length > 0) {
    fail(
      [
        "This repo has local changes in files that may contain personalization, secrets, or app work.",
        "I will not overwrite or rewire remotes until you decide what to do with them.",
        "",
        "Files to review:",
        ...sensitive.map((file) => `- ${file}`),
        "",
        "Ask a TA or Claude to help commit, stash, or inspect these changes before rerunning this script.",
      ].join("\n"),
    );
  }

  const remotes = getRemotes(repoPath);
  const mutations = [];

  const originUrl = remotes.origin;
  const upstreamUrl = remotes.upstream;

  if (originUrl && isAllowedUpstreamRemote(originUrl)) {
    mutations.push({
      label: "Rename origin to upstream because origin currently points at AI Build Lab",
      run: () => {
        if (getRemotes(repoPath).upstream) {
          git(repoPath, ["remote", "remove", "origin"]);
        } else {
          git(repoPath, ["remote", "rename", "origin", "upstream"]);
        }
      },
    });
  }

  const remotesAfterOriginPlan = applyRemotePlanPreview(remotes);
  const originAfterRename = remotesAfterOriginPlan.origin;
  const upstreamAfterRename = remotesAfterOriginPlan.upstream;

  if (!upstreamAfterRename) {
    mutations.push({
      label: `Add upstream remote: ${DEFAULT_UPSTREAM_URL}`,
      run: () => git(repoPath, ["remote", "add", "upstream", DEFAULT_UPSTREAM_URL]),
    });
  } else if (!isAllowedUpstreamRemote(upstreamAfterRename)) {
    blockDisallowedRemote("upstream", upstreamAfterRename);
  } else if (normalizeRemoteSlug(upstreamAfterRename) !== DEFAULT_UPSTREAM) {
    mutations.push({
      label: `Set upstream remote to ${DEFAULT_UPSTREAM_URL}`,
      run: () => git(repoPath, ["remote", "set-url", "upstream", DEFAULT_UPSTREAM_URL]),
    });
  }

  if (originAfterRename) {
    await verifyPrivateOrigin(originAfterRename, githubUser);
  } else {
    const existing = viewRepo(`${githubUser}/${repoName}`);
    if (existing) {
      verifyRepoRecordIsSafeOrigin(existing, githubUser);
      mutations.push({
        label: `Add existing private repo as origin: ${existing.nameWithOwner}`,
        run: () => git(repoPath, ["remote", "add", "origin", `https://github.com/${existing.nameWithOwner}.git`]),
      });
      mutations.push({
        label: `Push current branch '${branch}' to private origin`,
        run: () => git(repoPath, ["push", "-u", "origin", branch]),
      });
    } else {
      mutations.push({
        label: `Create private GitHub repo ${githubUser}/${repoName}, set it as origin, and push`,
        run: () =>
          run("gh", [
            "repo",
            "create",
            repoName,
            "--private",
            "--source=.",
            "--remote=origin",
            "--push",
          ], { cwd: repoPath }),
      });
    }
  }

  mutations.push({
    label: "Ensure .aibl/ is ignored locally",
    run: () => ensureAiblIgnored(repoPath),
  });
  mutations.push({
    label: "Write local repo safety report to .aibl/repo-state.md",
    run: () => writeRepoState(repoPath, githubUser, branch),
  });
  mutations.push({
    label: "Write baseline 4D secrets profile to .aibl/workshop-profile.json",
    run: () => writeWorkshopProfile(repoPath),
  });

  await confirmAndRun(
    mutations.map((mutation) => mutation.label),
    () => {
      for (const mutation of mutations) {
        console.log(`\n> ${mutation.label}`);
        mutation.run();
      }
    },
  );
  if (dryRun) {
    console.log("Dry run complete. Rerun without --dry-run to apply the repo safety plan.");
    return;
  }

  const finalRemotes = getRemotes(repoPath);
  if (!finalRemotes.origin) {
    fail("Safety check failed: origin is still missing after setup.");
  }
  if (!finalRemotes.upstream || !isAllowedUpstreamRemote(finalRemotes.upstream)) {
    fail("Safety check failed: upstream is missing or does not point to AI Build Lab.");
  }
  await verifyPrivateOrigin(finalRemotes.origin, githubUser);

  console.log("");
  console.log("Repo setup complete.");
  console.log(`- Private origin is ready: ${normalizeRemoteSlug(finalRemotes.origin) || finalRemotes.origin}`);
  console.log(`- AI Build Lab remains upstream: ${DEFAULT_UPSTREAM}`);
  console.log("- Secrets path is set to 4D connectors by default.");
  console.log("- It is safe to personalize this local repo.");
  console.log("");
  console.log("When you need API-key env vars, open Claude in your repo and run /upgrade-8d-secrets. Claude will help you create or use a scoped routine-read Infisical identity.");
  console.log(`Next: cd "${repoPath}" && claude`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function resolveWorkspace(value) {
  const raw = value || path.join(os.homedir(), "GitHub");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function printHeader() {
  console.log("AI Build Lab private workshop repo setup");
  console.log("========================================");
  console.log("");
  console.log("Goal: AI Build Lab stays upstream; your private repo becomes origin.");
  console.log("This script never runs personalization.");
  if (dryRun) console.log("DRY RUN: no changes will be made.");
  console.log("");
}

function verifyCommand(command, versionArgs) {
  const result = run(command, versionArgs, { allowFail: true });
  if (result.status !== 0) {
    fail(`Missing required command: ${command}. Install it before running this script.`);
  }
}

function verifyGitHubAuth() {
  const result = run("gh", ["api", "user", "--jq", ".login"], { allowFail: true });
  if (result.status !== 0) {
    fail(
      [
        "GitHub CLI is not authenticated.",
        "Run this first, then rerun the setup script:",
        "",
        "  gh auth login",
      ].join("\n"),
    );
  }
}

function readGitHubUser() {
  const result = run("gh", ["api", "user", "--jq", ".login"]);
  const login = result.stdout.trim();
  if (!login) fail("Could not read your GitHub username with gh api user --jq .login.");
  return login;
}

function handleCloneFailure(result, upstream, target) {
  const combined = `${result.stderr || ""} ${result.stdout || ""}`.toLowerCase();
  const looksLikeAccessIssue =
    combined.includes("404") ||
    combined.includes("not found") ||
    combined.includes("could not resolve") ||
    combined.includes("repository not found");

  if (!looksLikeAccessIssue) {
    const detail = (result.stderr || "").trim() || (result.stdout || "").trim() || `exit code ${result.status}`;
    fail(`Command failed: gh repo clone ${upstream} ${target}\n${detail}`);
  }

  const whoami = run("gh", ["api", "user", "--jq", ".login"], { allowFail: true });
  const currentLogin = whoami.status === 0 ? whoami.stdout.trim() : "(could not detect)";

  fail(
    [
      `Could not access ${upstream}.`,
      "",
      "This usually means one of three things:",
      "",
      "1. You have not been invited to the cohort yet. Check the email you used on the signup",
      "   form for a GitHub invitation from AI Build Lab.",
      "",
      "2. You were invited but have not clicked Accept yet. Open the invitation email and click",
      "   the green Accept button, then re-run this script.",
      "",
      "3. You are signed in to gh as a different GitHub account than the one on your signup form.",
      `   You are currently signed in as: ${currentLogin}`,
      "   To switch accounts: gh auth logout, then gh auth login as the correct account.",
      "",
      "If none of those apply, ping a TA in Slack with this error and your GitHub username.",
    ].join("\n"),
  );
}

function isGitRepo(dir) {
  return run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { allowFail: true }).status === 0;
}

function git(cwd, argsForGit) {
  return run("git", ["-C", cwd, ...argsForGit]);
}

function currentBranch(cwd) {
  const result = git(cwd, ["branch", "--show-current"]);
  return result.stdout.trim() || "main";
}

function getRemotes(cwd) {
  const result = git(cwd, ["remote", "-v"]);
  const remotes = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== "fetch") continue;
    remotes[match[1]] = match[2];
  }
  return remotes;
}

function dirtyFiles(cwd) {
  const result = git(cwd, ["status", "--porcelain"]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..\s+/, "").replace(/^..\s+/, ""));
}

function sensitiveDirtyFiles(files) {
  return files.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    if (normalized === ".aibl/repo-state.md" || normalized.startsWith(".aibl/")) return false;
    if (normalized === "CLAUDE.md" || normalized === "AGENTS.md") return true;
    if (normalized === ".env" || normalized.startsWith(".env.")) return true;
    if (normalized.includes("/.env") || normalized.endsWith(".env")) return true;
    if (normalized.startsWith("apps/")) return true;
    if (normalized.includes("vault")) return true;
    return false;
  });
}

function applyRemotePlanPreview(remotes) {
  const preview = { ...remotes };
  if (preview.origin && isAllowedUpstreamRemote(preview.origin)) {
    if (!preview.upstream) preview.upstream = preview.origin;
    delete preview.origin;
  }
  return preview;
}

async function verifyPrivateOrigin(remoteUrl, githubUser) {
  const slug = normalizeRemoteSlug(remoteUrl);
  if (!slug) {
    fail(`Could not identify GitHub owner/repo from origin remote: ${remoteUrl}`);
  }
  if (hasInternalRepoName(slug)) {
    blockDisallowedRemote("origin", remoteUrl);
  }
  const repo = viewRepo(slug);
  if (!repo) {
    fail(`Could not inspect origin with GitHub CLI: ${slug}`);
  }
  verifyRepoRecordIsSafeOrigin(repo, githubUser);
}

function verifyRepoRecordIsSafeOrigin(repo, githubUser) {
  const [owner] = repo.nameWithOwner.split("/");
  if (owner.toLowerCase() !== githubUser.toLowerCase()) {
    fail(
      [
        `Origin is not owned by the signed-in GitHub user.`,
        `Signed-in user: ${githubUser}`,
        `Origin repo: ${repo.nameWithOwner}`,
      ].join("\n"),
    );
  }
  if (!repo.isPrivate) {
    const forkText = repo.isFork
      ? "This is a public fork. Public forks cannot reliably become private while staying connected."
      : "This origin repo is public.";
    fail(
      [
        "Origin is not safe for personalization.",
        forkText,
        "",
        "Create a fresh private repo, set it as origin, and keep AI Build Lab as upstream.",
        `Suggested private repo name: ${repoName}`,
      ].join("\n"),
    );
  }
}

function viewRepo(slug) {
  const result = run(
    "gh",
    ["repo", "view", slug, "--json", "nameWithOwner,isPrivate,isFork,parent"],
    { allowFail: true },
  );
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`GitHub CLI returned unreadable repo metadata for ${slug}.`);
  }
}

function isAllowedUpstreamRemote(remoteUrl) {
  const slug = normalizeRemoteSlug(remoteUrl);
  return slug ? ALLOWED_UPSTREAMS.has(slug) : false;
}

function normalizeRemoteSlug(remoteUrl) {
  let value = String(remoteUrl || "").trim();
  value = value.replace(/^git@github\.com:/, "");
  value = value.replace(/^ssh:\/\/git@github\.com\//, "");
  value = value.replace(/^https:\/\/github\.com\//, "");
  value = value.replace(/^http:\/\/github\.com\//, "");
  value = value.replace(/\.git$/, "");
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

function hasInternalRepoName(slug) {
  const repo = slug.split("/")[1] || slug;
  return repo.endsWith("-hq") || repo.includes("internal") || repo.includes("founders");
}

function blockDisallowedRemote(name, remoteUrl) {
  fail(
    [
      `Refusing to use ${name} remote: ${remoteUrl}`,
      "This default setup script is allowlisted only for aibuild-lab/agent-native-os.",
      "It will not configure HQ, internal, founders, or non-course repos.",
    ].join("\n"),
  );
}

function ensureAiblIgnored(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (/^\.aibl\/$/m.test(existing)) return;
  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  fs.appendFileSync(gitignorePath, `${prefix}\n# Local AI Build Lab setup state\n.aibl/\n`);
}

function writeRepoState(cwd, githubUser, branch) {
  const stateDir = path.join(cwd, ".aibl");
  fs.mkdirSync(stateDir, { recursive: true });
  const remotes = getRemotes(cwd);
  const now = new Date().toISOString();
  const report = [
    "# AI Build Lab Repo State",
    "",
    `Generated: ${now}`,
    `GitHub user: ${githubUser}`,
    `Local path: ${cwd}`,
    `Branch: ${branch}`,
    "",
    "## Remotes",
    "",
    `- origin: ${remotes.origin || "(missing)"}`,
    `- upstream: ${remotes.upstream || "(missing)"}`,
    "",
    "## Safety Status",
    "",
    "- Private origin verified.",
    "- AI Build Lab upstream verified.",
    "- Safe to run personalization in this local repo.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(stateDir, "repo-state.md"), report);
}

function writeWorkshopProfile(cwd) {
  const stateDir = path.join(cwd, ".aibl");
  fs.mkdirSync(stateDir, { recursive: true });
  const profile = {
    secretsPath: "4d-connectors",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(stateDir, "workshop-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

async function confirmAndRun(planLines, action) {
  if (planLines.length === 0) return;
  console.log("Plan:");
  for (const line of planLines) console.log(`- ${line}`);
  console.log("");
  if (dryRun) {
    console.log("Dry run only; no changes made.");
    return;
  }
  if (!assumeYes) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("Proceed? Type yes to continue: ");
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      fail("Stopped before making changes.");
    }
  }
  action();
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0 && !options.allowFail) {
    const stderr = result.stderr ? result.stderr.trim() : "";
    const stdout = result.stdout ? result.stdout.trim() : "";
    const detail = stderr || stdout || `exit code ${status}`;
    fail(`Command failed: ${formatCommand(command, commandArgs)}\n${detail}`);
  }
  return {
    status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function cloudSyncReason(targetPath) {
  const normalized = targetPath.replaceAll("\\", "/").toLowerCase();
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
  if (!match) return null;
  return `The path appears to be inside ${match}.`;
}

function fail(message) {
  console.error("");
  console.error(message);
  console.error("");
  process.exit(1);
}

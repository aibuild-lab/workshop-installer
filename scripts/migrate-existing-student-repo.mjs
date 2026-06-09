#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const COURSE_REPO = "aibuild-lab/agent-native-os";
const COURSE_URL = `https://github.com/${COURSE_REPO}.git`;
const PRIVATE_REPO_NAME = "agent-native-os-private";
const args = parseArgs(process.argv.slice(2));
const assumeYes = args.yes === true;
const dryRun = args["dry-run"] === true;

main().catch((error) => fail(error.message || String(error)));

async function main() {
  printHeader();
  verifyCommand("git", ["--version"]);
  verifyCommand("node", ["--version"]);
  verifyCommand("gh", ["--version"]);
  verifyGitHubAuth();
  const githubUser = readGitHubUser();

  const repoRoot = resolveCourseRepo();
  refuseCloudSync(repoRoot);
  verifyCourseRepoShape(repoRoot);
  verifyCourseAccess(githubUser);
  reportSiblingCairnsClones(repoRoot);

  const branch = currentBranch(repoRoot);
  const remotes = getRemotes(repoRoot);
  const dirty = dirtyFiles(repoRoot);
  if (dirty.length > 0) {
    fail(
      [
        "This repo has uncommitted changes. I will not rewire remotes until local work is committed or stashed.",
        "",
        "Changed files:",
        ...dirty.map((file) => `- ${file}`),
      ].join("\n"),
    );
  }

  const plan = buildPlan(repoRoot, remotes, githubUser, branch);
  await confirmAndRun(plan);
  if (dryRun) {
    console.log("Dry run complete. No changes made.");
    return;
  }

  const finalRemotes = getRemotes(repoRoot);
  if (normalizeRemoteSlug(finalRemotes.upstream) !== COURSE_REPO) fail("Migration failed: upstream is not AI Build Lab.");
  verifyPrivateOrigin(finalRemotes.origin, githubUser);

  console.log("");
  console.log("Cohort 1 repo migration complete.");
  console.log(`- origin: ${normalizeRemoteSlug(finalRemotes.origin)}`);
  console.log(`- upstream: ${COURSE_REPO}`);
  console.log("- Secrets path is set to 4D connectors by default.");
  console.log("When you need API-key env vars, open Claude in your repo and run /upgrade-8d-secrets. Claude will help you create or use a scoped routine-read Infisical identity.");
  console.log("Next: open Claude Code inside this folder and run /update-course.");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
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

function printHeader() {
  console.log("AI Build Lab Cohort 1 repo migration");
  console.log("====================================");
  console.log("");
  console.log("Goal: keep your existing course folder, make your private repo origin, and keep AI Build Lab as upstream.");
  if (dryRun) console.log("DRY RUN: no changes will be made.");
  console.log("");
}

function resolveCourseRepo() {
  if (args.repo) return path.resolve(String(args.repo));
  const candidates = [
    path.join(os.homedir(), "GitHub", "agent-native-os"),
    path.join(os.homedir(), "Documents", "agent-native-os"),
    path.join(os.homedir(), "agent-native-os"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, ".git")));
  if (found) return found;
  fail(
    [
      "I could not find your existing agent-native-os folder automatically.",
      "Rerun with:",
      "",
      "  node scripts/migrate-existing-student-repo.mjs --repo /path/to/agent-native-os",
    ].join("\n"),
  );
}

function verifyCourseRepoShape(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) fail(`Not a Git repo: ${repoRoot}`);
  if (!fs.existsSync(path.join(repoRoot, "START-HERE.md")) || !fs.existsSync(path.join(repoRoot, "configs"))) {
    fail(`This does not look like agent-native-os: ${repoRoot}`);
  }
}

function verifyCommand(command, versionArgs) {
  const result = run(command, versionArgs, { allowFail: true });
  if (result.status !== 0) fail(`Missing required command: ${command}.`);
}

function verifyGitHubAuth() {
  const result = run("gh", ["api", "user", "--jq", ".login"], { allowFail: true });
  if (result.status !== 0) fail(["GitHub CLI is not signed in.", "Run: gh auth login", "Then rerun this migration."].join("\n"));
}

function readGitHubUser() {
  const result = run("gh", ["api", "user", "--jq", ".login"]);
  const login = result.stdout.trim();
  if (!login) fail("Could not read your GitHub username.");
  return login;
}

function verifyCourseAccess(githubUser) {
  const result = run("gh", ["repo", "view", COURSE_REPO, "--json", "nameWithOwner"], { allowFail: true });
  if (result.status === 0) return;
  fail(
    [
      "I cannot access the AI Build Lab course repo yet.",
      "Message Gigawatt with this exact text, then rerun this migration after you are added:",
      "",
      `Hi Gigawatt, my GitHub username is ${githubUser}. Please add me to the AI Build Lab GitHub org and the Cohort 1 Agent Native OS team so I can migrate my workshop repo.`,
    ].join("\n"),
  );
}

function buildPlan(repoRoot, remotes, githubUser, branch) {
  const plan = [];
  const preview = { ...remotes };
  if (preview.origin && normalizeRemoteSlug(preview.origin) === COURSE_REPO) {
    if (preview.upstream) {
      plan.push({
        label: "Remove origin because it points at AI Build Lab and upstream already exists",
        run: () => git(repoRoot, ["remote", "remove", "origin"]),
      });
    } else {
      plan.push({
        label: "Rename origin to upstream because origin currently points at AI Build Lab",
        run: () => git(repoRoot, ["remote", "rename", "origin", "upstream"]),
      });
      preview.upstream = preview.origin;
    }
    delete preview.origin;
  }

  if (!preview.upstream) {
    plan.push({
      label: `Add AI Build Lab as upstream: ${COURSE_URL}`,
      run: () => git(repoRoot, ["remote", "add", "upstream", COURSE_URL]),
    });
  } else if (normalizeRemoteSlug(preview.upstream) !== COURSE_REPO) {
    fail(`Existing upstream does not point at ${COURSE_REPO}: ${preview.upstream}`);
  }

  if (preview.origin) {
    verifyPrivateOrigin(preview.origin, githubUser);
  } else {
    const existing = viewRepo(`${githubUser}/${PRIVATE_REPO_NAME}`);
    if (existing) {
      verifyRepoRecordIsSafeOrigin(existing, githubUser);
      plan.push({
        label: `Add existing private repo as origin: ${existing.nameWithOwner}`,
        run: () => git(repoRoot, ["remote", "add", "origin", `https://github.com/${existing.nameWithOwner}.git`]),
      });
      plan.push({
        label: `Push current branch '${branch}' to private origin`,
        run: () => git(repoRoot, ["push", "-u", "origin", branch]),
      });
    } else {
      plan.push({
        label: `Create private GitHub repo ${githubUser}/${PRIVATE_REPO_NAME}, set it as origin, and push`,
        run: () =>
          run("gh", ["repo", "create", PRIVATE_REPO_NAME, "--private", "--source=.", "--remote=origin", "--push"], {
            cwd: repoRoot,
          }),
      });
    }
  }

  plan.push({
    label: "Fetch AI Build Lab upstream main",
    run: () => git(repoRoot, ["fetch", "upstream", "main"]),
  });
  plan.push({
    label: "Ensure .aibl/ is ignored locally",
    run: () => ensureAiblIgnored(repoRoot),
  });
  plan.push({
    label: "Write baseline 4D secrets profile to .aibl/workshop-profile.json",
    run: () => writeWorkshopProfile(repoRoot),
  });
  return plan;
}

function reportSiblingCairnsClones(repoRoot) {
  const parent = path.dirname(repoRoot);
  const names = ["research-papers-cairns", "tool-docs-cairns", "youtube-cairns-vault"];
  const found = names.filter((name) => fs.existsSync(path.join(parent, name, ".git")));
  if (found.length === 0) return;
  console.log("I found old separate Cairns clones next to this repo:");
  for (const name of found) console.log(`- ${path.join(parent, name)}`);
  console.log("I will not delete them. Current Cairns snapshots now live inside agent-native-os/cairns/ after /update-course.");
  console.log("");
}

function currentBranch(repoRoot) {
  return git(repoRoot, ["branch", "--show-current"]).stdout.trim() || "main";
}

function dirtyFiles(repoRoot) {
  return git(repoRoot, ["status", "--porcelain"]).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^..\s+/, "").replace(/^..\s+/, ""));
}

function getRemotes(repoRoot) {
  const result = git(repoRoot, ["remote", "-v"]);
  const remotes = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (match && match[3] === "fetch") remotes[match[1]] = match[2];
  }
  return remotes;
}

function verifyPrivateOrigin(remoteUrl, githubUser) {
  const slug = normalizeRemoteSlug(remoteUrl);
  const repo = viewRepo(slug);
  if (!repo) fail(`Could not inspect origin repo: ${slug}`);
  verifyRepoRecordIsSafeOrigin(repo, githubUser);
}

function verifyRepoRecordIsSafeOrigin(repo, githubUser) {
  const [owner] = repo.nameWithOwner.split("/");
  if (owner.toLowerCase() !== githubUser.toLowerCase()) {
    fail(`Origin is not owned by the signed-in GitHub user. Origin: ${repo.nameWithOwner}; user: ${githubUser}`);
  }
  if (!repo.isPrivate) fail(`Origin is not private: ${repo.nameWithOwner}`);
}

function viewRepo(slug) {
  const result = run("gh", ["repo", "view", slug, "--json", "nameWithOwner,isPrivate,isFork"], { allowFail: true });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

async function confirmAndRun(plan) {
  console.log("Plan:");
  for (const step of plan) console.log(`- ${step.label}`);
  console.log("");
  if (dryRun) return;
  if (!assumeYes) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("Proceed? Type yes to continue: ");
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") fail("Stopped before making changes.");
  }
  for (const step of plan) {
    console.log(`\n> ${step.label}`);
    step.run();
  }
}

function ensureAiblIgnored(repoRoot) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (/^\.aibl\/$/m.test(existing)) return;
  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  fs.appendFileSync(gitignorePath, `${prefix}\n# Local AI Build Lab setup state\n.aibl/\n`);
}

function writeWorkshopProfile(repoRoot) {
  const stateDir = path.join(repoRoot, ".aibl");
  fs.mkdirSync(stateDir, { recursive: true });
  const profile = {
    secretsPath: "4d-connectors",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(stateDir, "workshop-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

function refuseCloudSync(targetPath) {
  const normalized = targetPath.replaceAll("\\", "/").toLowerCase();
  const blocked = ["dropbox", "onedrive", "icloud drive", "clouddocs", "mobile documents", "google drive", "my drive", "box", "creative cloud files"];
  const match = blocked.find((segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`));
  if (match) fail(`Refusing to migrate a Git repo inside a cloud-sync folder: ${match}. Move the repo to ~/GitHub first.`);
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

function git(repoRoot, gitArgs) {
  return run("git", ["-C", repoRoot, ...gitArgs]);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: options.cwd, encoding: "utf8" });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0 && !options.allowFail) {
    const detail = (result.stderr || result.stdout || `exit ${status}`).trim();
    fail(`Command failed: ${[command, ...commandArgs].join(" ")}\n${detail}`);
  }
  return { status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function fail(message) {
  console.error("");
  console.error(message);
  console.error("");
  process.exit(1);
}

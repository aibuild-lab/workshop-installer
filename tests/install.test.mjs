import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO_NAME,
  buildStepPlan,
  classifyPythonEnvironment,
  cloudSyncReason,
  defaultStateFile,
  defaultWorkspace,
  detectSupportedPlatform,
  loadState,
  nextRunnableSteps,
  parsePythonVersion,
  parseArgs,
  pythonVersionIsSupported,
  resolveWorkspace,
  saveState,
} from "../install.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("parseArgs handles flags, values, equals, and positional workspace", () => {
  const args = parseArgs(["~/Code", "--dry-run", "--workspace=/tmp/aibl", "--repo-name", "custom-private", "--cohort1"]);
  assert.equal(args._[0], "~/Code");
  assert.equal(args["dry-run"], true);
  assert.equal(args.workspace, "/tmp/aibl");
  assert.equal(args["repo-name"], "custom-private");
  assert.equal(args.cohort1, true);
});

test("workspace defaults to ~/GitHub and expands tilde", () => {
  const home = path.join(os.tmpdir(), "aibl-home");
  assert.equal(defaultWorkspace(home), path.join(home, "GitHub"));
  assert.equal(resolveWorkspace(undefined, home), path.join(home, "GitHub"));
  assert.equal(resolveWorkspace("~/Workshop", home), path.join(home, "Workshop"));
});

test("cloud sync folders are refused", () => {
  assert.match(cloudSyncReason("/Users/student/Dropbox/agent-native-os"), /dropbox/);
  assert.match(cloudSyncReason("/Users/student/Library/Mobile Documents/agent-native-os"), /mobile documents/);
  assert.equal(cloudSyncReason("/Users/student/GitHub/agent-native-os"), null);
});

test("cohort1 routes repo setup to migration wording", () => {
  const plan = buildStepPlan({
    platform: "mac",
    workspace: "/Users/student/GitHub",
    repoName: DEFAULT_REPO_NAME,
    cohort1: true,
  });
  assert.match(plan.at(-1).label, /Cohort 1 migration/);
});

test("fresh setup includes private repo name", () => {
  const plan = buildStepPlan({
    platform: "windows",
    workspace: "C:\\Users\\Student\\GitHub",
    repoName: "student-private",
    cohort1: false,
  });
  assert.match(plan.at(-1).label, /student-private/);
});

test("setup plan includes Python environment before sign-ins", () => {
  const plan = buildStepPlan({
    platform: "mac",
    workspace: "/Users/student/GitHub",
    repoName: DEFAULT_REPO_NAME,
    cohort1: false,
  });
  const ids = plan.map((step) => step.id);
  assert.ok(ids.includes("python-env"));
  assert.ok(ids.indexOf("python-env") > ids.indexOf("gh"));
  assert.ok(ids.indexOf("python-env") < ids.indexOf("github-auth"));
});

test("python version parser accepts Python 3.10 or newer", () => {
  assert.deepEqual(parsePythonVersion("Python 3.12.4"), { major: 3, minor: 12, patch: 4 });
  assert.equal(pythonVersionIsSupported(parsePythonVersion("Python 3.10.0")), true);
  assert.equal(pythonVersionIsSupported(parsePythonVersion("Python 3.9.19")), false);
  assert.equal(pythonVersionIsSupported(parsePythonVersion("not python")), false);
});

test("python environment policy prefers uv and accepts existing managers", () => {
  assert.deepEqual(classifyPythonEnvironment({ uvAvailable: true }), { kind: "uv", manager: "uv" });
  assert.deepEqual(
    classifyPythonEnvironment({
      managerVersions: { conda: parsePythonVersion("Python 3.11.8") },
    }),
    { kind: "existing-manager", manager: "conda" },
  );
  assert.deepEqual(
    classifyPythonEnvironment({
      managerVersions: { conda: parsePythonVersion("Python 3.9.18"), pyenv: parsePythonVersion("Python 3.12.1") },
    }),
    { kind: "existing-manager", manager: "pyenv" },
  );
  assert.deepEqual(
    classifyPythonEnvironment({
      plainPythonVersion: parsePythonVersion("Python 3.12.0"),
    }),
    { kind: "plain-python-only" },
  );
  assert.deepEqual(classifyPythonEnvironment(), { kind: "missing" });
});

test("resume skips completed state entries", () => {
  const plan = [
    { id: "git", label: "Install Git" },
    { id: "node", label: "Install Node" },
    { id: "repo-setup", label: "Repo setup" },
  ];
  const pending = nextRunnableSteps(plan, { completed: ["git", "node"] }, true);
  assert.deepEqual(pending.map((step) => step.id), ["repo-setup"]);
  assert.equal(nextRunnableSteps(plan, { completed: ["git"] }, false).length, 3);
});

test("state round-trips to an override file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibl-install-test-"));
  const stateFile = path.join(dir, "state.json");
  saveState(stateFile, { version: 1, completed: ["workspace"] });
  assert.deepEqual(loadState(stateFile).completed, ["workspace"]);
});

test("default state file lives under ~/.aibl", () => {
  const home = path.join(os.tmpdir(), "home");
  assert.equal(defaultStateFile(home), path.join(home, ".aibl", "workshop-installer", "state.json"));
});

test("platform detection is explicit", () => {
  assert.equal(detectSupportedPlatform("darwin"), "mac");
  assert.equal(detectSupportedPlatform("win32"), "windows");
  assert.equal(detectSupportedPlatform("linux"), "unsupported");
});

test("CLI dry-run prints the deterministic plan without writing state", () => {
  const stateFile = path.join(os.tmpdir(), `aibl-dry-run-${process.pid}.json`);
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "install.mjs"),
    "--dry-run",
    "--workspace",
    path.join(os.tmpdir(), "aibl-workspace"),
    "--state-file",
    stateFile,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run complete/);
  assert.match(result.stdout, /Install or verify Python environment/);
  assert.match(result.stdout, /Create or verify private workshop repo/);
  assert.equal(fs.existsSync(stateFile), false);
});

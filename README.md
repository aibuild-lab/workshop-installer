# AI Build Lab Installer

A guided setup for the workshop's required tools and first safe repo:

- Git
- Node.js
- GitHub CLI
- Claude Code
- Infisical CLI
- A private GitHub repo at `<your-username>/agent-native-os-private`, seeded from `aibuild-lab/agent-native-os`

## Cohort 1 students: migrate your existing repo

If you joined Cohort 1 and already cloned `agent-native-os` while it was public, keep your existing folder. Run this migration instead of starting over:

```bash
mkdir -p "$HOME/GitHub"
if [ ! -d "$HOME/GitHub/workshop-installer/.git" ]; then gh repo clone aibuild-lab/workshop-installer "$HOME/GitHub/workshop-installer"; fi
cd "$HOME/GitHub/workshop-installer"
git pull --ff-only
node scripts/migrate-existing-student-repo.mjs
```

If the script says you need GitHub access, send the exact printed message to Gigawatt. After you are added to the AI Build Lab GitHub org and Cohort 1 team, rerun the same command.

What the migration does:

- keeps your existing local `agent-native-os` folder
- creates or verifies your private `<your-username>/agent-native-os-private` repo
- makes your private repo `origin`
- keeps AI Build Lab's course repo as `upstream`
- preserves old separate Cairns clones if you have them

## How to install

1. **Open Claude Desktop.** If you don't have it, download from [claude.ai/download](https://claude.ai/download) and sign in with your Claude account.

2. **Start a new session and select your user-level folder.** When Claude Desktop asks you to pick a folder for this session, choose the folder named after your username. That's your home folder, where your shell configuration files and Claude Code's install location live.

   - **Mac:** In the file picker, press `Cmd + Shift + H` to jump to your home folder, or look for the house icon in Finder's sidebar. The folder is named after your username.
   - **Windows:** In the file picker, click "This PC" or "Computer" in the sidebar, then double-click "Local Disk (C:)", then "Users", then click the folder with your username (e.g. `Owner`). The full path is `C:\Users\<your-username>`.

   **Why this matters:** The setup will install tools that modify files in your home folder (your shell's startup scripts, Claude Code's binary location). If you choose a different folder, Claude won't have direct access to those files and the install will hit permission errors.

3. **Paste this prompt into the Claude Desktop chat:**

   ```
   You are the AI Build Lab workshop installer assistant. I'm a student preparing for the workshop.

   Fetch the full setup procedure from this URL and follow it from the beginning, step by step, without summarizing:

   https://raw.githubusercontent.com/aibuild-lab/workshop-installer/main/SETUP-PROMPT.md

   Start by greeting me and detecting my operating system as the procedure instructs. Do not skip steps. Do not ask me what I want to do, the procedure tells you what to do.

   If you can't fetch the URL, say so and I'll paste the procedure into chat directly.
   ```

   **If Claude says it can't open or read the link**, open the URL in your browser, press `Cmd + A` then `Cmd + C` on Mac (`Ctrl + A` then `Ctrl + C` on Windows), come back to Claude, and paste the full prompt text into chat instead. Same setup, just delivered manually.

4. **Follow Claude's instructions.** Claude will detect your operating system, check what's already installed, and walk you through any setup needed. The whole process takes ~10-15 minutes for the tools (a bit longer if you're on a fresh Mac and need to install Apple Command Line Tools and Homebrew first), plus a few minutes to sign in and prepare your private workshop repo.

5. **Sign in to Infisical CLI, then prepare your private workshop repo.** After GitHub and Claude Code sign-in, Claude will also walk you through `infisical login`. If you do not already have an Infisical account, create one at [app.infisical.com](https://app.infisical.com) first. The installer only verifies CLI login. It does **not** create an Infisical project, run `infisical init`, or start Infisical Agent. Your repo starts on the 4D connector path. If you later need API-key environment variables, open Claude from your repo and run `/upgrade-8d-secrets`.

   After sign-ins are complete, Claude will run the repo setup gate. The safe model is:

   - AI Build Lab's course repo (`aibuild-lab/agent-native-os`) stays connected as `upstream`.
   - A fresh private GitHub repo on your account (`<your-username>/agent-native-os-private`) becomes `origin`.
   - Personalization starts only after `origin` is confirmed private.

   **What the gate actually does:** it clones the workshop repo (`agent-native-os`) into `~/GitHub/agent-native-os` on your computer, creates the private GitHub repo on your account, pushes the workshop files up to it, and wires the connections so future pushes go to your private repo. The setup script itself lives inside this installer repo, which is why Claude clones the installer first and then runs the script from inside it. If the course repo is private, you must accept your AI Build Lab GitHub org invite first.

   The setup uses `~/GitHub` by default. Do not put workshop repos inside Dropbox, OneDrive, iCloud Drive, Google Drive, Box, or Creative Cloud Files. Cloud sync can corrupt `.git`, create lock conflicts, or sync secrets.

   The setup also writes a local-only `.aibl/workshop-profile.json` file that marks your starting secret path as `4d-connectors`. That file stays out of Git.

## What you'll see during install (and what to click)

A couple of system popups appear during install. They look intimidating at first; here's what each one is and what to click. If a popup confuses you, ask Claude in chat and it'll walk you through.

### "Trust this workspace?" or "Do you trust this folder?" (Claude Desktop)

When you select your home folder in Claude Desktop, you'll see a prompt asking if you trust the workspace. **Click Trust.**

What "trusting" means: Claude Code (the engine inside Claude Desktop that runs commands during install) can read and edit files in the folder you selected. What it doesn't mean: nothing leaves your machine, no files get sent anywhere, and Claude doesn't get access to anything outside the folder you picked. You stay in control. Every meaningful change is announced to you first.

### macOS file-access popups (Documents, Downloads, Desktop, etc.)

During or after install, macOS may show popups like *"&lt;app&gt; wants access to files in your Documents folder"*. These are macOS asking your permission, not the workshop tool itself.

For the workshop:

- **Documents, Downloads, Desktop, Applications:** Click **Allow**. The install (and Claude Code during the workshop) reads or writes in these folders to do its job. Denying any of these may cause an install step to fail with a clear error message.
- **Photos, Music, Calendar, Contacts:** Click **Deny**. The workshop has no reason to access these.

You can change any of these later in System Settings → Privacy & Security → Files and Folders. Granting or denying these doesn't affect anything outside the workshop tools.

### Mac password prompt (during Homebrew install only)

If your machine doesn't have Homebrew yet, Claude will hand off to your Terminal so you can run the Homebrew installer there. That installer asks for your Mac password. **You type your password into your own Terminal, not into Claude Desktop. Claude never sees your password.**

When you type the password, macOS will show NOTHING as you type (no characters, no dots, no asterisks). That's a security feature, not a bug. Type the password and press Enter. If you make a typo, hit Backspace 15 to 20 times to clear the field, then type again.

### UAC prompts (Windows)

On Windows, you'll see *"Do you want to allow this app to make changes to your device?"* dialogs ~2 to 3 times during install. Click **Yes**. These are Windows confirming that `winget` is allowed to install software. No password is typed; just click Yes.

### Windows: use Git Bash for Claude Code (NOT PowerShell or cmd)

After install, when you sign in to Claude Code, you must use **Git Bash**. PowerShell and Command Prompt are not the right terminal for Claude Code on Windows.

To open Git Bash: press the Windows key (or click the search box in your taskbar), type **Git Bash**, press Enter. The window opens with a `$` prompt; that's the right one.

If you sign in via PowerShell or Command Prompt instead, you'll see an error like *"no stdin data received in 3s, proceeding without it"* or *"Input must be provided either through stdin or as a prompt argument when using --print"*. Close that window and open Git Bash instead.

**If you see "no stdin data received" or similar when running plain `claude` in Git Bash:** you're on an older Claude Code build that has a small Git Bash compatibility issue. Git Bash on Windows handles interactive programs a little differently than other terminals, and older builds didn't handle that cleanly. The fix is a tiny tool called `winpty` that acts as a translator between Git Bash and Claude Code. Type `winpty claude` instead, and set up an alias so plain `claude` works going forward:

```
echo "alias claude='winpty claude'" >> ~/.bashrc
source ~/.bashrc
```

After that, plain `claude` works in any new Git Bash window. Most students on current Claude Code builds won't need this.

## Verify your install (Mac users)

If your tools work in one place but not another (Claude Desktop says they're missing while your real Terminal works fine, or vice versa), or you just want to confirm everything is set up correctly, run a quick audit.

**The goal is for BOTH your shells to find your tools:** your real Terminal (zsh on modern macOS) AND Claude Desktop's bash subshell. The two shells have different startup files (`~/.zshrc` for zsh, `~/.bash_profile` for bash), and if only one of them is configured, tools will appear missing to whichever shell is unconfigured. The audit below catches that gap.

### Step 1: Audit (read your shell config files)

Open Terminal and paste this single command:

```
echo "=== ~/.bash_profile ===" ; cat ~/.bash_profile 2>/dev/null ; echo "" ; echo "=== ~/.zshrc ===" ; cat ~/.zshrc 2>/dev/null
```

It dumps the contents of both files. You're looking for two lines in EACH file:
- A line containing `brew shellenv`
- A line containing `~/.local/bin`

If both files have both lines, you're set up correctly. Skip the recovery step.

If either file is missing either line, run the recovery step below.

### Step 2: Recovery (only if the audit found gaps)

In Terminal, paste these one at a time:

```
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.bash_profile
```

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bash_profile
```

```
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
```

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then close Claude Desktop completely (`Cmd + Q`) and reopen it. Your tools will now be visible to both your real Terminal and Claude Desktop.

The recovery commands are idempotent. If you run them and one of the lines is already in the file, you'll get a duplicate line, which is harmless. So when in doubt, run the recovery; you can't break anything.

**Note for Apple Silicon vs Intel:** the commands above use `/opt/homebrew/bin/brew shellenv`, which is the Apple Silicon path. If you're on an Intel Mac, replace `/opt/homebrew/bin/brew` with `/usr/local/bin/brew` in the brew lines.

After the shell config audit is clean, open a fresh Terminal window and run:

```
git --version
node --version
gh --version
claude --version
infisical --version
```

All five should return version strings.

## Verify your install (Windows users)

Open a fresh PowerShell window (not the one that ran the install). Run these one at a time:

```
git --version
```

```
node --version
```

```
gh --version
```

```
claude --version
```

```
infisical --version
```

All five should return version strings. If any fail, the install step for that specific tool didn't complete. Re-run the SETUP-PROMPT.md flow in Claude Desktop and it will detect what's still missing and finish the job.

**Why a fresh PowerShell window:** PATH and environment variable updates from the install only take effect for new shells, not the one that ran the install. If you run the version commands in the same PowerShell that ran the install, you may see false "command not found" errors. Always open a fresh PowerShell window for verification.

Windows doesn't have the bash/zsh shell mismatch issue Mac has, so a tool failing here means it's genuinely not installed (not "installed but invisible"). Re-running the install will fix it.

## Prepare your private workshop repo manually

The guided setup prompt normally handles this. If a TA asks you to run it manually, use these commands after `gh auth login` is working.

**Why you clone the installer repo first:** the setup script (`prepare-workshop-repo.mjs`) lives inside this installer repo. You clone the installer to get the script, then run the script from inside it. The script handles cloning the actual workshop repo (`agent-native-os`) into a sibling folder and wiring up your private origin.

### macOS or Linux shell

```bash
mkdir -p "$HOME/GitHub"
if [ ! -d "$HOME/GitHub/workshop-installer/.git" ]; then gh repo clone aibuild-lab/workshop-installer "$HOME/GitHub/workshop-installer"; fi
cd "$HOME/GitHub/workshop-installer"
git pull --ff-only
node scripts/prepare-workshop-repo.mjs
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\GitHub" | Out-Null
if (!(Test-Path "$HOME\GitHub\workshop-installer\.git")) { gh repo clone aibuild-lab/workshop-installer "$HOME\GitHub\workshop-installer" }
Set-Location "$HOME\GitHub\workshop-installer"
git pull --ff-only
node scripts/prepare-workshop-repo.mjs
```

When it completes, you should see: private `origin` is ready, AI Build Lab remains `upstream`, and it is safe to personalize.

## Upgrade to 8D secrets later

The baseline installer already installs and signs you in to Infisical CLI. It does not start Infisical Agent for everyone.

When you need local API-key environment variables for a script, MCP server, scheduled job, or 8D blueprint, open Claude Code from your private `agent-native-os` repo and run:

```text
/upgrade-8d-secrets
```

That command activates Infisical Agent after a facilitator gives you scoped routine-read Universal Auth machine identity details. It does not use project `.env` files. Admin-write and break-glass credentials are separate facilitator/admin practices and are not installed by the baseline setup. Later 8D automation field notes live inside the private `agent-native-os` repo.

If `infisical --version` is missing later, use the manual guide to install the CLI first, then return to `/upgrade-8d-secrets`.

If you are switching from 1Password, `/upgrade-8d-secrets` only activates Infisical for future env-var tools. It does not move existing 1Password items or rewrite any `op://` references in your tool configs.

## If anything goes wrong

See [MANUAL-INSTALL.md](MANUAL-INSTALL.md) for step-by-step manual install instructions covering both platforms, with every command, expected output, and common error fix.

For Infisical specifically:

- If `infisical` is not found after install, open a fresh terminal and run `infisical --version`. If it still fails, rerun the Infisical CLI install step in the manual guide.
- If browser login does not complete, rerun `infisical login`.
- If you do not have an Infisical project yet, that is okay. This installer only verifies CLI login. If you later need API-key env vars, run `/upgrade-8d-secrets` from your private repo after a facilitator gives you scoped routine-read machine identity details.

## Need help?

Ask in the workshop Slack channel.

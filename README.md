# AI Build Lab Installer

A guided setup for the workshop's four required tools: Git, Node.js, GitHub CLI, and Claude Code.

## How to install

1. **Open Claude Desktop.** If you don't have it, download from [claude.ai/download](https://claude.ai/download) and sign in with your Claude account.

2. **Start a new session and select your user-level folder.** When Claude Desktop asks you to pick a folder for this session, choose the folder named after your username. That's your home folder, where your shell configuration files and Claude Code's install location live.

   - **Mac:** In the file picker, press `Cmd + Shift + H` to jump to your home folder, or look for the house icon in Finder's sidebar. The folder is named after your username.
   - **Windows:** In the file picker, click "This PC" or "Computer" in the sidebar, then double-click "Local Disk (C:)", then "Users", then click the folder with your username (e.g. `Owner`). The full path is `C:\Users\<your-username>`.

   **Why this matters:** The setup will install tools that modify files in your home folder (your shell's startup scripts, Claude Code's binary location). If you choose a different folder, Claude won't have direct access to those files and the install will hit permission errors.

3. **Paste this URL into the Claude Desktop chat:**

   ```
   https://raw.githubusercontent.com/aibuild-lab/workshop-installer/main/SETUP-PROMPT.md
   ```

4. **Follow Claude's instructions.** Claude will detect your operating system, check what's already installed, and walk you through any setup needed. The whole process takes ~10–15 minutes (a bit longer if you're on a fresh Mac and need to install Apple Command Line Tools and Homebrew first).

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

All four should return version strings. If any fail, the install step for that specific tool didn't complete. Re-run the SETUP-PROMPT.md flow in Claude Desktop and it will detect what's still missing and finish the job.

**Why a fresh PowerShell window:** PATH and environment variable updates from the install only take effect for new shells, not the one that ran the install. If you run the version commands in the same PowerShell that ran the install, you may see false "command not found" errors. Always open a fresh PowerShell window for verification.

Windows doesn't have the bash/zsh shell mismatch issue Mac has, so a tool failing here means it's genuinely not installed (not "installed but invisible"). Re-running the install will fix it.

## If anything goes wrong

See [MANUAL-INSTALL.md](MANUAL-INSTALL.md) for step-by-step manual install instructions covering both platforms, with every command, expected output, and common error fix.

## Need help?

Ask in the workshop Slack channel.

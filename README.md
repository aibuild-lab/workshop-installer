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

## Verify your install (Mac users)

If Claude Desktop is reporting tools as "missing" but they work fine in your real Terminal, or you just want to confirm everything is set up correctly, run a quick audit. This is a Mac-specific issue: Claude Desktop runs commands in a bash subshell, while your real Terminal is zsh, and the two shells have different startup files. If only one of those files is configured, tools will appear missing to one shell but not the other.

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

## If anything goes wrong

See [MANUAL-INSTALL.md](MANUAL-INSTALL.md) for step-by-step manual install instructions covering both platforms, with every command, expected output, and common error fix.

## Need help?

Ask in the workshop Slack channel.

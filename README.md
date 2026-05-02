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

## If anything goes wrong

See [MANUAL-INSTALL.md](MANUAL-INSTALL.md) for step-by-step manual install instructions covering both platforms, with every command, expected output, and common error fix.

## Need help?

Ask in the workshop Slack channel.

# Manual Install Guide — AI Build Lab Workshop Tools

This guide walks through installing the four workshop tools (**Git**, **Node.js**, **GitHub CLI**, **Claude Code**) one step at a time, on your own. Use it when:

- The automatic installer ([install.ps1 / install.sh](README.md#install--pick-the-one-for-your-operating-system)) failed for some reason
- You want to understand exactly what's getting installed before you run anything
- You hit an edge case the installer doesn't handle (uncommon, but possible)
- You're learning, and prefer step-by-step over magic one-liners

Every step shows you the command, what to expect, and what to do if something goes wrong.

---

## Quick reference (all commands in one place)

If you just want the commands without explanation, here they are. **Paste one command at a time — do not paste multiple at once.** Wait for each one to finish before moving to the next. Detailed walkthroughs follow below.

### Windows (paste in PowerShell, one at a time)

**Install Git:**

```powershell
winget install --id Git.Git --source winget --accept-package-agreements --accept-source-agreements
```

**Install Node.js LTS:**

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
```

**Install GitHub CLI:**

```powershell
winget install --id GitHub.cli --source winget --accept-package-agreements --accept-source-agreements
```

**Install Claude Code:**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Set PowerShell ExecutionPolicy (so future tools can run):**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

**Add Claude to PATH (only if `claude --version` doesn't work in a fresh PowerShell window):**

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.local\bin", "User")
```

### macOS (paste in Terminal, one at a time)

**Install Apple Command Line Tools (skip if already installed):**

```bash
xcode-select --install
```

**Install Homebrew:**

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Install Git:**

```bash
brew install git
```

**Install Node.js:**

```bash
brew install node
```

**Install GitHub CLI:**

```bash
brew install gh
```

**Install Claude Code:**

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

**Reload your shell (only if `claude` isn't found after install):**

```bash
exec zsh
```

---

## Verify before you start

These four commands tell you what's already installed. Run them first — anything that returns a real version is something you can skip.

### Windows (PowerShell)

```powershell
git --version
node --version
gh --version
claude --version
```

### macOS (Terminal)

```bash
git --version
node --version
gh --version
claude --version
```

For each command:
- **Returns a version like `git version 2.54.0`** → that tool is installed, skip it
- **Returns `command not found` or similar** → you'll install it below
- **Returns a version BUT it's older than what we need** → for Node specifically, we need v18 or newer. If you see `v16.x.x` or older, you'll upgrade

---

## Windows — step by step

These steps assume Windows 10 (build 2004+) or Windows 11. If you're on an older Windows, you'll need to upgrade first — `winget` isn't available on older builds.

### Before you start

**The four tool installs are independent.** No tool requires another to be installed first — you can do Git, Node.js, GitHub CLI, and Claude Code in any order, and you can stop after any step. If you already have Git installed, you can skip that step entirely.

**Prerequisites:**

- **Windows 10 build 2004+ or Windows 11** — older versions don't have `winget`. To check your version, press the Windows key, type `winver`, press Enter, and confirm the build number is 19041 (2004) or higher.
- **PowerShell** — built into Windows. Press the Windows key, type `PowerShell`, press Enter.
- **A working internet connection** — most downloads are 50-200 MB each.
- **Ability to click Yes on UAC prompts** — each `winget install` fires one. You don't need full admin rights on the machine, just the ability to approve UAC prompts when they appear.

### Step 1 — Install Git for Windows

**Why:** Git is version control. Every workshop project uses it. Also, `git bash` on Windows is the recommended shell for Claude Code.

**Command (paste in PowerShell):**

```powershell
winget install --id Git.Git --source winget --accept-package-agreements --accept-source-agreements
```

**What happens:**
- A UAC prompt fires asking *"Do you want to allow this app to make changes to your device?"* — click **Yes**
- `winget` downloads Git for Windows (~50 MB)
- The installer runs silently with default options
- You'll see progress output ending with `Successfully installed`

**Verify:**

```powershell
git --version
```

Expected output: `git version 2.54.0.windows.1` (or similar — version may differ)

**Common issues:**
- *"command 'git' not found"* after install → close and reopen PowerShell. The PATH update from winget doesn't show up in the same shell that did the install.
- *"winget: command not found"* → your Windows is too old, or winget isn't installed. Get App Installer from the Microsoft Store first.

### Step 2 — Configure Git Bash for Claude Code

**Why:** Claude Code on Windows works best when it knows where Git Bash is. The AI Build Lab installer sets this up automatically — but if you're going manual, you set it yourself.

**Command (paste in PowerShell):**

```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH", "C:\Program Files\Git\bin\bash.exe", "User")
```

**What happens:**
- Sets a User-scoped environment variable that Claude Code reads at startup
- No visible output — silent success
- Persists across PowerShell sessions

**Verify (open a NEW PowerShell window first):**

```powershell
$env:CLAUDE_CODE_GIT_BASH_PATH
```

Expected output: `C:\Program Files\Git\bin\bash.exe`

**Common issues:**
- *"Path doesn't exist"* → Git for Windows installed somewhere unusual. Find `bash.exe` (it's typically at `C:\Program Files\Git\bin\bash.exe`) and adjust the path.

### Step 3 — Install Node.js LTS (v18 or newer)

**Why:** Node is the runtime for npm, which workshop tools and many MCP servers use. Claude Code requires Node 18+.

**Command (paste in PowerShell):**

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
```

**What happens:**
- UAC prompt — click Yes
- Downloads Node.js LTS (~30 MB)
- Installs silently
- ~1-2 min total

**Verify (open a NEW PowerShell window):**

```powershell
node --version
```

Expected output: `v22.x.x` or similar (any version with `v18`, `v20`, `v22` is fine)

**Common issues:**
- Existing Node v16 or older → you can either uninstall the old one first (Settings → Apps → Node.js → Uninstall) or just install over it. The newer install should take precedence.

### Step 4 — Install GitHub CLI

**Why:** Workshop projects clone from and push to GitHub. The CLI handles auth and lets you do common GitHub operations from the terminal.

**Command (paste in PowerShell):**

```powershell
winget install --id GitHub.cli --source winget --accept-package-agreements --accept-source-agreements
```

**What happens:**
- UAC prompt — click Yes
- Downloads GitHub CLI (~30 MB)
- Installs silently
- ~1 min total

**Verify (open a NEW PowerShell window):**

```powershell
gh --version
```

Expected output: `gh version 2.92.0 (2026-04-28)` (or similar)

### Step 5 — Install Claude Code (native binary)

**Why:** This is the workshop's central tool. We use Anthropic's native binary install path because it auto-updates and is Anthropic's recommended setup.

**Command (paste in PowerShell):**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**What happens:**
- Downloads Anthropic's installer script
- Runs it in-memory (no file saved to disk)
- Installs `claude.exe` to `C:\Users\<your-user>\.local\bin\claude.exe`
- Prints a "Setup notes" message about adding the directory to PATH
- Prints "Claude Code successfully installed!"

**⚠️ Important — the PATH gotcha:** Anthropic's installer **does NOT add `~\.local\bin` to your PATH automatically.** It tells you to do it yourself. The next step handles that.

### Step 6 — Add Claude's install dir to your User PATH

**Why:** Without this, typing `claude` in a new PowerShell window will say "command not recognized" because Windows doesn't know where to find `claude.exe`.

**Command (paste in PowerShell):**

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.local\bin", "User")
```

**What happens:**
- Reads your current User-scoped PATH
- Appends `C:\Users\<you>\.local\bin` to it
- Saves the new PATH to the User environment
- No visible output — silent success
- Persists across PowerShell sessions

**Verify (open a NEW PowerShell window):**

```powershell
claude --version
```

Expected output: `2.1.123 (Claude Code)` (or similar — version may differ)

**Common issues:**
- *"`claude` not recognized"* even after this step → close ALL PowerShell windows and open a fresh one. The environment update only applies to shells started after the change.
- The PATH already contains `\.local\bin` (you added it before) → harmless, just adds a duplicate entry. You can manually remove duplicates via Settings → System → About → Advanced system settings → Environment Variables → User PATH → edit.

### Step 7 — Set PowerShell ExecutionPolicy

**Why:** Default Windows 11 PowerShell blocks all `.ps1` scripts. Some workshop tools you'll install later via npm create `.ps1` wrappers (like `claude.ps1` would, if you'd used the npm install path). Setting `RemoteSigned` allows local scripts to run while still blocking unsigned remote ones — the standard developer-machine policy.

**Command (paste in PowerShell — admin not required):**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

**What happens:**
- Sets PowerShell ExecutionPolicy at the CurrentUser scope to RemoteSigned
- No admin needed (CurrentUser scope only affects your account, not the system)
- No visible output — silent success
- Persists permanently

**Verify:**

```powershell
Get-ExecutionPolicy -Scope CurrentUser
```

Expected output: `RemoteSigned`

### Step 8 — Final verification

In a brand-new PowerShell window:

```powershell
git --version
node --version
gh --version
claude --version
```

All four should return real version strings. If any return "command not recognized," go back to that tool's step and check the Verify section.

### Step 9 — Sign in to GitHub and Claude

**GitHub:**

```powershell
gh auth login
```

Follow the prompts — choose `GitHub.com`, `HTTPS`, `Login with a web browser`, copy the one-time code, paste in the browser, authorize.

**Claude Code (open Git Bash first):**

Press the Windows key, type `Git Bash`, press Enter. In the new Git Bash window:

```bash
claude
```

Follow the sign-in flow.

You're done.

---

## macOS — step by step

These steps assume macOS 12 (Monterey) or newer. If you're on an Intel Mac, the same steps work — only the Homebrew install location differs (handled automatically).

### Before you start

**The order matters slightly more on Mac than on Windows.** Apple Command Line Tools must be installed before Homebrew (Homebrew needs them to compile). Homebrew must be installed before Git/Node/gh (we install those via Homebrew). After Homebrew is in place, **Git, Node, gh, and Claude Code are all independent of each other** — install them in any order.

**Prerequisites:**

- **macOS 12 (Monterey) or newer** — older macOS may not work with current Homebrew or current Node.
- **Terminal** — built into macOS. Press `Cmd + Space`, type `Terminal`, press Enter.
- **A working internet connection** — Homebrew install + tool downloads add up to ~500 MB.
- **Your Mac account password** — you'll be prompted during Homebrew install. The password won't show as you type (security feature, not a bug).
- **Apple Command Line Tools and Homebrew first** — these aren't optional; the rest of the installs depend on them.

### Step 1 — Install Apple Command Line Tools

**Why:** macOS doesn't ship with `git`, `make`, or other compiler/build tools by default. Apple's Command Line Tools (CLT) provides them. Homebrew won't work without CLT.

**Command (paste in Terminal):**

```bash
xcode-select --install
```

**What happens:**
- A GUI dialog pops up: *"The xcode-select command requires the command line developer tools. Would you like to install the tools now?"*
- Click **Install**
- Click **Agree** to the license
- Waits ~5-10 minutes downloading Apple's tools (~750 MB)
- The dialog closes when done

**Verify:**

```bash
xcode-select -p
```

Expected output: `/Library/Developer/CommandLineTools` or `/Applications/Xcode.app/Contents/Developer`

**Common issues:**
- *"`xcode-select`: error: command line tools are already installed"* → great, you already have them. Skip to Step 2.
- The GUI installer hangs at "Finding software..." → usually resolves itself, just wait. If stuck for >20 min, cancel and try `softwareupdate --install --all` instead.

### Step 2 — Install Homebrew

**Why:** Homebrew is the standard package manager for macOS. We use it for git, node, and gh.

**Command (paste in Terminal):**

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**What happens:**
- Downloads Homebrew's official install script
- Runs it as a sub-shell
- Prompts you to enter your Mac password (the password won't show as you type — that's normal)
- Asks you to press Enter to continue (a couple of times)
- Downloads and installs Homebrew (~5 min on first run, longer on Apple Silicon if `softwareupdate` runs)
- Prints "Installation successful!" and "Next steps" with how to add brew to your PATH

**⚠️ On Apple Silicon (M1/M2/M3):** Homebrew installs to `/opt/homebrew`. The "Next steps" output tells you to add this to your shell's PATH. Run those commands as printed.

**On Intel Macs:** Homebrew installs to `/usr/local`. Already on PATH, no action needed.

**Verify:**

```bash
brew --version
```

Expected output: `Homebrew 4.x.x`

**Common issues:**
- *"`brew`: command not found"* immediately after install → run the "Next steps" commands Homebrew printed (they add brew to your shell rc), or `exec zsh` to reload your shell config.
- Slow / hung at "Cloning into..." → kill (Ctrl+C) and rerun. Sometimes git mirror servers are slow.

### Step 3 — Install Git via Homebrew

**Why:** macOS includes a stock Git, but it's often outdated. Brew installs the latest.

**Command:**

```bash
brew install git
```

**What happens:**
- Brew downloads + builds (or fetches a binary bottle for) git
- ~30 sec on Apple Silicon, longer on older Macs
- Prints what got installed at the end

**Verify:**

```bash
git --version
```

Expected output: `git version 2.54.0` (or similar)

### Step 4 — Install Node.js via Homebrew

**Command:**

```bash
brew install node
```

**Verify:**

```bash
node --version
```

Expected output: `v22.x.x` or `v20.x.x` (any v18+)

### Step 5 — Install GitHub CLI via Homebrew

**Command:**

```bash
brew install gh
```

**Verify:**

```bash
gh --version
```

Expected output: `gh version 2.92.0 (2026-04-28)`

### Step 6 — Install Claude Code (native binary)

**Why:** Same reasoning as Windows — we use Anthropic's native binary path because it auto-updates and is Anthropic's recommended install.

**Command:**

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

**What happens:**
- Downloads Anthropic's install script
- Runs it
- Installs `claude` to `~/.local/bin/claude`
- Updates your shell rc (`.zshrc` typically) to add `~/.local/bin` to PATH

**Verify (in a NEW Terminal window):**

```bash
claude --version
```

Expected output: `2.1.123 (Claude Code)`

**Common issues:**
- *"`claude`: command not found"* → Anthropic's installer added the PATH update to your shell rc, but the current Terminal session hasn't reloaded it. Run:
  ```bash
  exec zsh
  ```
  Or close the Terminal window and open a new one.
- The install fails partway through → check internet, then retry. The Anthropic install is well-tested but does fail occasionally on flaky connections.

### Step 7 — Final verification

In a brand-new Terminal window:

```bash
git --version
node --version
gh --version
claude --version
```

All four should return real version strings.

### Step 8 — Sign in to GitHub and Claude

**GitHub:**

```bash
gh auth login
```

Follow the prompts — choose `GitHub.com`, `HTTPS`, `Login with a web browser`, copy the one-time code, paste in the browser, authorize.

**Claude Code:**

```bash
claude
```

Follow the sign-in flow.

You're done.

---

## Common errors and fixes (both platforms)

### Error: `running scripts is disabled on this system` (Windows)

**What it looks like:**
```
File C:\Users\<you>\AppData\Roaming\npm\<tool>.ps1 cannot be loaded because running scripts is disabled on this system.
+ CategoryInfo          : SecurityError: (:) [], PSSecurityException
```

**Why it happens:** Default Windows 11 PowerShell ExecutionPolicy is `Restricted`, which blocks all `.ps1` scripts including npm-installed wrappers.

**Fix:** Run Step 7 of the Windows guide:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

### Error: `'claude' is not recognized as an internal or external command` (Windows)

**Why it happens:** `claude.exe` is at `C:\Users\<you>\.local\bin\` but that directory isn't on your PATH.

**Fix:** Run Step 6 of the Windows guide, then open a new PowerShell window.

### Error: `claude: command not found` (macOS)

**Why it happens:** Anthropic's installer updated your shell rc but the current Terminal session hasn't reloaded it.

**Fix:** Run `exec zsh` (or `exec bash` if you're on bash), or just close and reopen Terminal.

### Error: `winget: command not found` (Windows)

**Why it happens:** Your Windows version is too old (pre-2004) or winget got removed somehow.

**Fix:** Install **App Installer** from the Microsoft Store, then reopen PowerShell. If you're on Windows 10 below 2004, you'll need to update Windows first (Settings → Update & Security → Windows Update).

### Error: `xcode-select: error: command line tools are already installed` (macOS)

**Why it happens:** Apple's Command Line Tools are already installed. Not actually an error.

**Fix:** Continue to Step 2.

### Error: `Permission denied (publickey)` when running `gh auth login`

**Why it happens:** You're trying SSH-based auth but haven't set up SSH keys with GitHub.

**Fix:** Choose **HTTPS** in the `gh auth login` flow instead of SSH. GitHub CLI will use a token-based auth via browser, which works without SSH key setup. Or set up SSH keys separately if you prefer (`ssh-keygen` + add public key to GitHub).

### Error: Mac password prompt accepts but seems wrong

**What it looks like:** You type your password during Homebrew install, but Terminal shows nothing as you type.

**Why it happens:** macOS hides characters during password entry as a security feature. The password IS being entered, you just can't see the characters.

**Fix:** Just type your password and press Enter. If you get the password wrong, the install will tell you and prompt again.

### Error: Homebrew install hangs or fails

**Possible causes:**
- Slow internet (Homebrew downloads several hundred MB)
- macOS `softwareupdate` running concurrently and blocking
- A previous failed install left things in a half-state

**Fix:** Kill the Homebrew process (Ctrl+C in Terminal), wait a minute, and retry. If it consistently fails, check `https://status.brew.sh` for any reported outages.

### Error: After install, `git --version` works but other tools don't

**Why it happens:** The install of one of the later tools (Node, gh, claude) failed silently while the earlier ones succeeded. This is rare but can happen on flaky connections.

**Fix:** Re-run JUST the failing tool's install command. The installs are idempotent — re-running won't break what's already there.

---

## When all else fails

- **Ask in Slack** — the workshop's `#agent-native-os` channel has TAs watching during pre-setup hours
- **Show up to a pre-setup huddle** — Wade and Hunter are co-hosting Thursday 1:30 PM ET, Saturday 10 AM ET, and Saturday 4 PM ET. Walk-throughs happen live.
- **Check the recordings** — pre-setup huddles are recorded and posted in Slack afterward, so if you can't make a live session you can watch the install walkthrough on demand.

If you're stuck after trying the steps in this guide and asking for help, share:
- Your operating system + version
- The exact command you ran
- The exact error message (screenshot or copy-paste)

That makes it 10x faster for a TA to unblock you.

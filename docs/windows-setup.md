# Running agent-afk on Windows

## Current status

agent-afk runs on Windows natively. The full unit suite gates every PR on
`windows-2022` (assertions only; coverage floors are enforced on ubuntu because
~110 platform-gated tests leave win32-skipped branches uncovered). Some features
remain unimplemented on native Windows (clipboard image paste); see the
checklist below. Issue #703 is closed.

The recommended path for Windows users today is **WSL2**, which provides full
compatibility with zero workarounds.

## Quick start with WSL2

[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) runs a real
Linux kernel on Windows. Inside WSL2, agent-afk runs exactly as it does on a
native Linux machine — all features work, all tests pass.

### 1. Install WSL2

From an **elevated** PowerShell or Command Prompt:

```powershell
wsl --install
```

This installs Ubuntu by default. Reboot if prompted.

### 2. Set up Node.js and pnpm

Inside your WSL2 terminal:

```bash
# Install Node.js ≥ 22 via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22

# Install pnpm
corepack enable
corepack prepare pnpm@11 --activate
```

### 3. Install agent-afk

```bash
npm install -g agent-afk
```

### 4. Configure

```bash
# Set your API key
afk config env set ANTHROPIC_API_KEY sk-ant-...

# (Optional) Set up Telegram notifications
afk telegram setup

# Verify installation
afk --version
afk chat "hello"
```

### 5. Access Windows files from WSL2

Your Windows drives are mounted under `/mnt/`:

```bash
cd /mnt/c/Users/YourName/Projects/my-repo
afk interactive
```

VS Code's [WSL extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl)
lets you run `code .` from inside WSL2 to open the current directory.

## Windows Terminal integration

[Windows Terminal](https://aka.ms/terminal) is the recommended terminal for
WSL2. agent-afk already detects Windows Terminal via the `WT_SESSION`
environment variable.

## Limitations of WSL2

- **File performance**: accessing files on the Windows filesystem (`/mnt/c/…`)
  is slower than the Linux filesystem (`~/…`). Clone repos inside WSL2's home
  directory for best performance.
- **Service management**: `afk service install` inside WSL2 uses systemd (if
  enabled) or requires manual service management. On native Windows, `afk
  service install` uses the Task Scheduler backend (`schtasks`) — run it from
  an elevated PowerShell prompt.
- **GUI clipboard**: clipboard operations (`pbcopy`/`pbpaste` equivalents)
  work via `wl-copy`/`xclip` if a Wayland/X11 server is running (WSLg in
  Windows 11), or via `clip.exe` from within WSL2 for paste-to-Windows.

## Desktop computer-use tools (native Windows only)

The `desktop_screenshot` tool and future desktop input tools require a **native
Windows interactive terminal session**. They do not work inside WSL2: the
desktop tools call the Windows desktop APIs directly, and a WSL2 Linux process
cannot reach the Windows interactive desktop.

If you are running agent-afk inside WSL2 and invoke a desktop tool, you will
see: *"Desktop tools require native Windows. Run afk in a native Windows
interactive terminal, not WSL2."*

> **Note (Step 0W pending):** Windows desktop support is a proposal that has
> not been tested on real Windows hardware. The Step 0W feasibility spike
> (see the spec) is required before making any capability claim. Whether a
> Windows daemon or Telegram service context can reach the interactive desktop
> is also unknown until Step 0W. Set `AFK_DESKTOP_ENABLED=1` only after
> Step 0W confirms that your environment is supported.

## Native Windows support (WIP)

The following areas are being addressed for native Windows compatibility:

- [x] Process group kill → platform-safe tree kill (`taskkill /F /T`)
- [x] Credential denylist → Windows `%APPDATA%` / `%USERPROFILE%` paths
- [x] Editor settings discovery → Windows `%APPDATA%` paths for VS Code/Cursor
- [x] Path handling → `path.sep`/`path.basename`/`path.join` throughout
- [x] Env-var list separator → `;` on Windows (matching PATH convention)
- [ ] Shell strategy → `cmd.exe` vs PowerShell vs WSL bash (decision pending; `pnpm test` currently uses bash via Git Bash)
- [x] Service layer → Windows service/Task Scheduler backend (`schtasks`)
- [ ] Keychain/OAuth → Windows Credential Manager integration
- [x] Unit test suite green on `windows-2022` CI (required gate, closes #703)

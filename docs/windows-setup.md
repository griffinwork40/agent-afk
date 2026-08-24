# Running agent-afk on Windows

## Current status

agent-afk is developed primarily on macOS and Linux. Native Windows support
is tracked in [#703](https://github.com/griffinwork40/agent-afk/issues/703)
and is a work in progress — the test suite does not yet pass on Windows, and
some features (service management, clipboard image paste) are unavailable on
native Windows.

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
corepack prepare pnpm@latest --activate
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
  enabled) or requires manual service management. The native Windows service
  layer (Task Scheduler / SCM) is not yet supported.
- **GUI clipboard**: clipboard operations (`pbcopy`/`pbpaste` equivalents)
  work via `wl-copy`/`xclip` if a Wayland/X11 server is running (WSLg in
  Windows 11), or via `clip.exe` from within WSL2 for paste-to-Windows.

## Native Windows support (WIP)

The following areas are being addressed for native Windows compatibility:

- [x] Process group kill → platform-safe tree kill (`taskkill /F /T`)
- [x] Credential denylist → Windows `%APPDATA%` / `%USERPROFILE%` paths
- [x] Editor settings discovery → Windows `%APPDATA%` paths for VS Code/Cursor
- [x] Path handling → `path.sep`/`path.basename`/`path.join` throughout
- [x] Env-var list separator → `;` on Windows (matching PATH convention)
- [ ] Shell strategy → `cmd.exe` vs PowerShell vs WSL bash (decision pending)
- [ ] Service layer → Windows service/Task Scheduler backend
- [ ] Keychain/OAuth → Windows Credential Manager integration
- [ ] Full test suite green on `windows-latest` CI

Track progress in [#703](https://github.com/griffinwork40/agent-afk/issues/703).

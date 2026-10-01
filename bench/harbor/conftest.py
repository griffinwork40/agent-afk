"""pytest conftest: put harbor site-packages FIRST so 'bench/harbor/' namespace
does not shadow the installed harbor package."""

import sys
import os
import subprocess


def _find_harbor_site() -> str | None:
    """Return the harbor tool's site-packages path, or None if not installed."""
    # 1. If harbor is importable from the current interpreter, nothing to do.
    try:
        import harbor  # noqa: F401 — presence check only
        return None
    except ModuleNotFoundError:
        pass

    # 2. Try to locate it via `uv tool dir harbor`.
    try:
        result = subprocess.run(
            ["uv", "tool", "dir", "harbor"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            tool_dir = result.stdout.strip()
            if tool_dir and os.path.isdir(tool_dir):
                # Walk lib/pythonX.Y/site-packages inside the tool dir.
                lib = os.path.join(tool_dir, "lib")
                if os.path.isdir(lib):
                    for entry in os.scandir(lib):
                        candidate = os.path.join(entry.path, "site-packages")
                        if os.path.isdir(candidate):
                            return candidate
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # 3. Harbor not found — tests that need it will be skipped via importorskip.
    return None


_HARBOR_SITE = _find_harbor_site()

if _HARBOR_SITE and _HARBOR_SITE not in sys.path:
    # Insert at position 0 so it takes precedence over the bench/harbor namespace package.
    sys.path.insert(0, _HARBOR_SITE)

# Also ensure the repo root (parent of bench/) is on sys.path for 'bench.harbor.afk_agent'.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.append(_REPO_ROOT)

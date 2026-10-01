"""pytest conftest: put harbor site-packages FIRST so 'bench/harbor/' namespace
does not shadow the installed harbor package."""

import sys
import os

_HARBOR_SITE = "/Users/griffinlong/.local/share/uv/tools/harbor/lib/python3.13/site-packages"

if _HARBOR_SITE not in sys.path:
    # Insert at position 0 so it takes precedence over the bench/harbor namespace package.
    sys.path.insert(0, _HARBOR_SITE)

# Also ensure the repo root (parent of bench/) is on sys.path for 'bench.harbor.afk_agent'.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.append(_REPO_ROOT)

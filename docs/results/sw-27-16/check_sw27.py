#!/usr/bin/env python3
"""Standalone exact verifier for SW(27,16). Python 3 standard library only; no numpy, no scipy.
Exact integer arithmetic throughout.

Usage:
    python3 check_sw27.py              # verify SW_27_16.txt in the same directory; exit 0 = PASS
    python3 check_sw27.py PATH         # verify a specific file
    python3 check_sw27.py --selftest   # also confirm checker rejects every single-entry corruption

Checks performed:
  1. File parses to a 27x27 matrix over {-1, 0, 1}.
  2. W = W^T  (symmetric).
  3. W * W^T = 16 * I  (all 729 dot products, exact integers).
  4. Every row has exactly 16 nonzero entries.
  5. [selftest] Every single-entry mutation of W is rejected.
"""
import hashlib
import os
import sys

N, WT = 27, 16
HERE = os.path.dirname(os.path.abspath(__file__))

# SHA-256 of the canonical SW_27_16.txt released with this checker.
EXPECTED_SHA256 = "39529f6a93853f3e4ac53bfc8a8cdea689cb8b75c3995bcfe1011a81b431d2cf"


def load_matrix(path):
    rows = []
    with open(path) as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith("#"):
                rows.append([int(x) for x in s.replace(",", " ").split()])
    return rows


def check_matrix(W):
    """Return None if W is a valid SW(27,16), else a reason string."""
    if len(W) != N:
        return f"expected {N} rows, got {len(W)}"
    for i, r in enumerate(W):
        if len(r) != N:
            return f"row {i} has {len(r)} columns, expected {N}"
    for i in range(N):
        for j in range(N):
            if W[i][j] not in (-1, 0, 1):
                return f"entry ({i},{j}) = {W[i][j]} not in {{-1,0,1}}"
            if W[i][j] != W[j][i]:
                return f"not symmetric at ({i},{j}): W[i][j]={W[i][j]}, W[j][i]={W[j][i]}"
    for i in range(N):
        wt = sum(x * x for x in W[i])
        if wt != WT:
            return f"row {i} has weight {wt}, expected {WT}"
    for i in range(N):
        for k in range(i, N):
            s = sum(W[i][j] * W[k][j] for j in range(N))
            want = WT if i == k else 0
            if s != want:
                return f"(W W^T)[{i}][{k}] = {s}, expected {want}"
    return None


def main():
    selftest = "--selftest" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if args:
        mpath = args[0]
    else:
        mpath = os.path.join(HERE, "SW_27_16.txt")

    ok = True

    # Hash check (only for the canonical file)
    with open(mpath, "rb") as f:
        raw = f.read()
    digest = hashlib.sha256(raw).hexdigest()
    print(f"File: {mpath}")
    print(f"SHA-256: {digest}")
    if digest == EXPECTED_SHA256:
        print("SHA-256 matches canonical SW_27_16.txt: OK")
    else:
        print("SHA-256 does not match canonical (file differs or using alternate path)")

    W = load_matrix(mpath)
    reason = check_matrix(W)
    if reason is None:
        diag = [W[i][i] for i in range(N)]
        trace = sum(diag)
        print(f"[1] 27x27, entries in {{-1,0,1}}: OK")
        print(f"[2] W = W^T (symmetric): OK")
        print(f"[3] W W^T = 16 I (729 dot products, exact integers): OK")
        print(f"[4] All row weights = 16: OK")
        print(f"    Diagonal: {diag.count(0)} zeros / {diag.count(1)} +1s / {diag.count(-1)} -1s  trace={trace}")
    else:
        print(f"FAIL: {reason}")
        ok = False

    if selftest and reason is None:
        missed = 0
        for i in range(N):
            for j in range(N):
                for v in (-1, 0, 1):
                    if v == W[i][j]:
                        continue
                    old = W[i][j]
                    W[i][j] = v
                    if check_matrix(W) is None:
                        missed += 1
                    W[i][j] = old
        status = "OK" if missed == 0 else f"FAIL ({missed} accepted)"
        print(f"[selftest] single-entry corruptions wrongly accepted (must be 0): {missed}  {status}")
        ok = ok and missed == 0

    print("OVERALL:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

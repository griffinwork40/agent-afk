#!/usr/bin/env python3
"""Exact verifier for the SW(25,16) certificate. Python 3 standard library only; exact integer arithmetic.

    python3 verify.py             # all checks; exit status 0 = PASS, 1 = FAIL
    python3 verify.py --selftest  # also confirm the checker rejects 25*25 single-entry corruptions

Checks:
  1. SW_25_16.txt is a 25x25 matrix over {-1,0,1}, W = W^T, and W W^T = 16 I (all 625 entries computed).
  2. blocks.txt: B0 = B0^T; the rule W[5I+r][5J+c] = B_{(J-I) mod 5}[r][c] (B3 = B2^T, B4 = B1^T)
     reproduces SW_25_16.txt exactly.
  3. The block identities used in PROOF.md: S_d = sum_k B_k B_{k+d}^T gives S_0 = 16 I, S_1 = S_2 = 0.
"""
import hashlib
import os
import sys

N, WT, M = 25, 16, 5
HERE = os.path.dirname(os.path.abspath(__file__))


def read_rows(path):
    rows = []
    with open(path) as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith('#'):
                rows.append(s)
    return rows


def load_matrix(path):
    return [[int(x) for x in s.split()] for s in read_rows(path)]


def load_blocks(path):
    blocks, cur = {}, None
    for s in read_rows(path):
        if s[0] == 'B':
            cur = int(s[1:])
            blocks[cur] = []
        else:
            blocks[cur].append([int(x) for x in s.split()])
    return blocks


def T(A):
    return [list(r) for r in zip(*A)]


def mul(A, B):
    Bt = T(B)
    return [[sum(a * b for a, b in zip(r, c)) for c in Bt] for r in A]


def add(A, B):
    return [[a + b for a, b in zip(r, s)] for r, s in zip(A, B)]


def matrix_ok(W):
    """Return None if W is an SW(25,16), else a reason string."""
    if len(W) != N or any(len(r) != N for r in W):
        return 'not 25x25'
    for i in range(N):
        for j in range(N):
            if W[i][j] not in (-1, 0, 1):
                return 'entry (%d,%d) = %d not in {-1,0,1}' % (i, j, W[i][j])
            if W[i][j] != W[j][i]:
                return 'not symmetric at (%d,%d)' % (i, j)
    for i in range(N):
        for j in range(N):
            d = sum(W[i][k] * W[j][k] for k in range(N))
            if d != (WT if i == j else 0):
                return '(W W^T)[%d][%d] = %d' % (i, j, d)
    return None


def main():
    selftest = '--selftest' in sys.argv
    mpath, bpath = os.path.join(HERE, 'SW_25_16.txt'), os.path.join(HERE, 'blocks.txt')
    W = load_matrix(mpath)
    with open(mpath, 'rb') as f:
        print('SW_25_16.txt sha256:', hashlib.sha256(f.read()).hexdigest())
    ok = True

    r = matrix_ok(W)
    print('[1] entries in {-1,0,1}, W = W^T, W W^T = 16 I :', 'PASS' if r is None else 'FAIL: ' + r)
    ok = ok and r is None
    if r is None:
        print('    row weights:', sorted(set(sum(x * x for x in row) for row in W)),
              ' trace:', sum(W[i][i] for i in range(N)))

    B = load_blocks(bpath)
    B[3], B[4] = T(B[2]), T(B[1])
    rebuilt = [[B[((c // M) - (r // M)) % M][r % M][c % M] for c in range(N)] for r in range(N)]
    r2 = B[0] == T(B[0]) and rebuilt == W
    print('[2] B0 symmetric and block rule reproduces SW_25_16.txt :', 'PASS' if r2 else 'FAIL')
    ok = ok and r2

    S = {}
    for d in range(M):
        acc = [[0] * M for _ in range(M)]
        for k in range(M):
            acc = add(acc, mul(B[k], T(B[(k + d) % M])))
        S[d] = acc
    I16 = [[WT if i == j else 0 for j in range(M)] for i in range(M)]
    Z = [[0] * M for _ in range(M)]
    r3 = S[0] == I16 and S[1] == Z and S[2] == Z
    for d in range(3):
        print('    S_%d =' % d, S[d])
    print('[3] S_0 = 16 I, S_1 = 0, S_2 = 0 :', 'PASS' if r3 else 'FAIL')
    ok = ok and r3

    if selftest:
        missed = 0
        for i in range(N):
            for j in range(N):
                for v in (-1, 0, 1):
                    if v == W[i][j]:
                        continue
                    old = W[i][j]
                    W[i][j] = v
                    if matrix_ok(W) is None:
                        missed += 1
                    W[i][j] = old
        print('[selftest] single-entry corruptions accepted (must be 0):', missed)
        ok = ok and missed == 0

    print('OVERALL:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

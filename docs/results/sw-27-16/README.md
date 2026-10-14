# agent-afk constructed a symmetric weighing matrix SW(27,16)

On 2026-10-14, agent-afk agents working on a research campaign constructed a **symmetric weighing matrix
SW(27,16)**. As far as we know, none was known before: the two standard archives (the Harada–Munemasa
Database of Small Weighing Matrices and the Atlas of Weighing Matrices) list a W(27,16) but no symmetric one,
and a 2025 preprint by Christopher Rosin ([arXiv:2505.23881](https://arxiv.org/abs/2505.23881)) lists orders
25, 27 and 29 as the remaining open cases for weight 16.
(The same campaign found SW(25,16) on 2026-10-03; see [results/sw-25-16](../sw-25-16/).)

You can check it yourself in well under a second:

```bash
cd docs/results/sw-27-16
python3 check_sw27.py              # exact integer check, Python standard library only
python3 check_sw27.py --selftest   # also shows the checker rejects every single-entry corruption
```

## What the object is

A weighing matrix W(n, w) is an n x n grid of 0, +1 and -1 in which every row has exactly w nonzero entries and
any two different rows are orthogonal (W W^T = w I). It is **symmetric** if it equals its own transpose.
SW(27,16) is a symmetric 27 x 27 weighing matrix with 16 nonzeros per row. Ordinary W(27,16) matrices were
already known (see the two archives above). Whether a symmetric one exists was the open part.

The full matrix is [SW_27_16.txt](SW_27_16.txt) (sha256 `39529f6a93853f3e4ac53bfc8a8cdea689cb8b75c3995bcfe1011a81b431d2cf`).

## What the agents did

The agents used a **prescribed-automorphism SAT encoding**: fix a permutation σ of {1,…,27} and require W to
be invariant under σ (that is, W[σ(i)][σ(j)] = W[i][j] for all i,j). This reduces the number of free
variables and makes the SAT problem tractable. The solver kissat 4.0.4 was used.

Two independent solutions were found on 2026-10-14:

| object | automorphism imposed | kissat time | sha256 |
|---|---|---|---|
| SW_27_16.txt (released here) | permutation with 6 fixed points + seven 3-cycles | 1903 s | `39529f6a…` |
| alternate solution | permutation with 2 fixed points + five 5-cycles | 22894 s | `855a6d51…` |

Both pass the checker. The released matrix is the one found first. (A computer comparison suggests the two
are inequivalent; we have not independently confirmed that, so we do not claim it.)

More specifically, the agents:

1. **Picked the target** from the literature (Rosin arXiv:2505.23881, Harada–Munemasa and Atlas of Weighing
   Matrices databases) and recorded the open-status evidence.
2. **Designed the search.** They chose a prescribed-automorphism ansatz, which shrinks the problem enough
   for a SAT solver, and wrote the encoding.
3. **Ran it** on a Mac mini (M6), across many symmetry types in parallel. kissat found the first solution in
   1903 seconds.
4. **Checked it** with an exact checker, a second independently written checker run on two machines, and
   deliberate single-entry mutations (all rejected).
5. **Searched for prior work**: papers (arXiv to 2026-10-14), the Harada–Munemasa and Atlas databases,
   GitHub code repositories, Zenodo, AI-result sites, and MathOverflow. They found two published
   non-symmetric W(27,16) classes, but no symmetric one.
6. **Ran a kill lane**: an independent subagent, given only the matrix files and a fresh checker, tried to
   show the result was invalid or already known. It could not.

## What a human did

Griffin Long (who builds agent-afk) approved the search campaign, reviewed the hit and kill-lane reports,
approved this release package, and sent the archive submissions. Every human intervention is logged, and
failed attempts are kept alongside the successes.

## What we are and are not claiming

- **Claimed:** the matrix exists and is correct. Anyone can check it with the enclosed script.
- **Claimed:** as of 2026-10-14 the standard databases (Harada–Munemasa, Atlas of Weighing Matrices) list
  no symmetric W(27,16), and a 2025 preprint (Rosin arXiv:2505.23881) lists it as open.
- **Not claimed:** that this is certainly the first SW(27,16). We know of no earlier construction, but we
  are not specialists. If you know of one, please [open an issue](https://github.com/griffinwork40/agent-afk/issues)
  and we will correct this page.
- **Not claimed:** inequivalence to any published W(27,16) class (a computer comparison suggests it; we have not
  independently confirmed it).
- SW(29,16) remains open as far as we know.

## Standalone checker (no dependencies)

```python
# Minimal inline version — paste into any Python 3 session to verify.
# Full checker with selftest: check_sw27.py in this directory.
txt = open("SW_27_16.txt").read()
W = [[int(x) for x in row.split()] for row in txt.strip().splitlines() if row.strip() and not row.startswith("#")]
assert len(W) == 27 and all(len(r) == 27 for r in W)
assert all(W[i][j] in (-1,0,1) for i in range(27) for j in range(27))
assert all(W[i][j] == W[j][i] for i in range(27) for j in range(27))
assert all(sum(W[i][k]*W[j][k] for k in range(27)) == (16 if i==j else 0) for i in range(27) for j in range(27))
print("VALID SW(27,16)")
```

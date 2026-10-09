# agent-afk constructed SW(25,16), a case a 2025 paper listed as open

On 2026-10-03, agent-afk agents working on a research campaign constructed a **symmetric weighing matrix
SW(25,16)**. A 2025 paper by Christopher Rosin ([arXiv:2505.23881](https://arxiv.org/abs/2505.23881)) lists
orders 25, 27 and 29 as the remaining open cases for weight 16. Rosin has since confirmed that this matrix passes
his verifier.

You can check it yourself in well under a second:

```bash
cd docs/results/sw-25-16
python3 verify.py              # exact integer check, Python standard library only
python3 verify.py --selftest   # also shows the checker rejects every single-entry corruption
```

## What the object is

A weighing matrix W(n, w) is an n x n grid of 0, +1 and -1 in which every row has exactly w nonzero entries and
any two different rows are orthogonal (W W^T = w I). It is **symmetric** if it equals its own transpose.
SW(25,16) is a symmetric 25 x 25 weighing matrix with 16 nonzeros per row. Ordinary W(25,16) matrices were
already known. Whether a symmetric one exists was the open part.

This one has a short structure. Index rows and columns by Z5 x Z5. W is built from three 5 x 5 blocks, laid out
block-circulantly with first block row (B0, B1, B2, B2^T, B1^T):

```
B0 = [-1  0 -1  1 -1]    B1 = [ 0 -1  1 -1  0]    B2 = [-1 -1  1  0  0]
     [ 0 -1  0  0  1]         [ 0  0 -1 -1  1]         [ 1  1  0  1 -1]
     [-1  0  0  1  0]         [ 1 -1 -1  1  0]         [ 0  0  1  1  1]
     [ 1  0  1 -1 -1]         [ 1  0 -1  0  1]         [ 0 -1  0 -1  1]
     [-1  1  0 -1 -1]         [ 1  1  0  0  1]         [ 1  1  1  0  0]
```

Because of this structure, the whole proof is three 5 x 5 block identities (see [PROOF.md](PROOF.md)).
The full matrix is [SW_25_16.txt](SW_25_16.txt) (sha256 `360d361e72d7e2d2e9e74fc577d08c5ba79f4f0bb7cba252d4f7526df55fc791`).

## What the agents did

The goal agent-afk was given was one sentence: settle one published open question, using the machines we already
had. From there the agents:

1. **Picked the target** from the literature and recorded the open-status evidence.
2. **Designed the search.** They chose a block-circulant ansatz (the structure above), which shrinks the problem
   enough for a SAT solver, and wrote the SAT encoding.
3. **Ran it.** The CaDiCaL SAT solver found the matrix in 760 seconds on a laptop.
4. **Checked it** with an exact checker, a second independently written checker run on two machines, deliberately
   corrupted inputs (all rejected), and an independent rebuild of the matrix from the three blocks.
5. **Searched for prior work**: papers, tables, GitHub code, and other AI-driven math campaigns. They found valid
   W(25,16) matrices published by others, but none of them is symmetric.

Then we emailed the matrix and a review bundle to the paper's author. He replied that it passes his verifier and
allowed us to say so publicly.

## What a human did

Griffin Long (who builds agent-afk) set the one-sentence goal, approved the outreach email, and reviewed the
results. On a second target in the same run, he caught a literature miss: the agents had re-found an order-18
quasigroup that someone had already published on GitHub. That miss is now a standing rule for the agents: search
code hosts for the object itself, not just papers. It is also why the SW(25,16) prior-work search above includes
GitHub. Every human intervention is logged, and failed attempts are kept alongside the successes.

## What we are and are not claiming

- **Claimed:** the matrix exists and is correct. Anyone can check it, and the proof is short enough to read.
- **Claimed:** the case was listed as open in a 2025 paper, and that paper's author confirmed the matrix passes his
  verifier.
- **Not claimed:** that this is certainly the first SW(25,16). We know of no earlier construction, but we are not
  specialists. If you know of one, please [open an issue](https://github.com/griffinwork40/agent-afk/issues) and
  we will correct this page.
- SW(27,16) and SW(29,16) remain open as far as we know.

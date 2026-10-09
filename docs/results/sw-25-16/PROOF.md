# A symmetric weighing matrix SW(25,16)

**Theorem.** There is a 25 x 25 matrix W with entries in {0, 1, -1} such that W = W^T and W W^T = 16 I.

## Construction

Index rows and columns by pairs (I, r) with I, r in Z_5 (matrix index 5I + r). Put

    W = [ B_{(J - I) mod 5} ]_{I,J in Z_5},     B_3 := B_2^T,  B_4 := B_1^T,

with

    B0 = [-1  0 -1  1 -1]    B1 = [ 0 -1  1 -1  0]    B2 = [-1 -1  1  0  0]
         [ 0 -1  0  0  1]         [ 0  0 -1 -1  1]         [ 1  1  0  1 -1]
         [-1  0  0  1  0]         [ 1 -1 -1  1  0]         [ 0  0  1  1  1]
         [ 1  0  1 -1 -1]         [ 1  0 -1  0  1]         [ 0 -1  0 -1  1]
         [-1  1  0 -1 -1]         [ 1  1  0  0  1]         [ 1  1  1  0  0]

So W is block-circulant (5 x 5 blocks) with first block row (B0, B1, B2, B2^T, B1^T); the blocks themselves are
not circulant. The explicit matrix is `SW_25_16.txt`.

## Proof

Write B_{-d} for B_{(-d) mod 5}. By definition B_{-1} = B_1^T and B_{-2} = B_2^T, hence also B_{-3} = B_3^T,
B_{-4} = B_4^T, and B_0 = B_0^T holds by inspection. So **B_{-d} = B_d^T for every d in Z_5**.

*Symmetry.* Block (I,J) of W^T is (block (J,I) of W)^T = (B_{I-J})^T = B_{J-I} = block (I,J) of W. So W = W^T.

*Orthogonality.* For e in Z_5 let S_e = sum_{k in Z_5} B_k B_{k+e}^T. Block (I,J) of W W^T is

    sum_K B_{K-I} B_{K-J}^T = sum_k B_k B_{k+(I-J)}^T = S_{I-J}      (substituting k = K - I).

Moreover S_{-e} = sum_k B_k B_{k-e}^T = sum_k B_{k+e} B_k^T = S_e^T. Hence W W^T = 16 I_25 if and only if

    S_0 = 16 I_5,   S_1 = 0,   S_2 = 0,

since then S_3 = S_2^T = 0 and S_4 = S_1^T = 0. Using B_3 = B_2^T, B_4 = B_1^T these are the three identities

    S_0 = B0 B0 + B1 B1^T + B2 B2^T + B2^T B2 + B1^T B1  = 16 I_5
    S_1 = B0 B1^T + B1 B2^T + B2 B2 + B2^T B1 + B1^T B0  = 0
    S_2 = B0 B2^T + B1 B2 + B2 B1 + B2^T B0 + B1^T B1^T  = 0

which hold by direct computation (each term is listed in the appendix; `verify.py` recomputes them).
Entries lie in {0, 1, -1} by inspection. QED

Remarks. The diagonal of S_0 shows each row of W has exactly 16 nonzero entries. W has trace -20;
consistent with W^2 = 16 I, its eigenvalues are +4 (multiplicity 10) and -4 (multiplicity 15).

## Appendix: the fifteen 5 x 5 products (rows listed top to bottom)

S_0 terms:

    B0 B0     = [[4,-1,2,-2,1],[-1,2,0,-1,-2],[2,0,2,-2,0],[-2,-1,-2,4,1],[1,-2,0,1,4]]
    B1 B1^T   = [[3,0,-1,-1,-1],[0,3,0,2,1],[-1,0,4,2,0],[-1,2,2,3,2],[-1,1,0,2,3]]
    B2 B2^T   = [[3,-2,1,1,-1],[-2,4,0,-3,2],[1,0,3,0,1],[1,-3,0,3,-1],[-1,2,1,-1,3]]
    B2^T B2   = [[3,3,0,1,-1],[3,4,0,2,-2],[0,0,3,1,1],[1,2,1,3,-1],[-1,-2,1,-1,3]]
    B1^T B1   = [[3,0,-2,1,2],[0,3,0,0,1],[-2,0,4,-1,-2],[1,0,-1,3,-1],[2,1,-2,-1,3]]
    sum       = 16 I

S_1 terms:

    B0 B1^T   = [[-2,-1,1,-1,-2],[1,1,1,1,0],[-1,-1,0,-1,-1],[2,-1,-1,-1,0],[0,0,-3,-2,-1]]
    B1 B2^T   = [[2,-2,0,2,0],[-1,-2,-1,2,-1],[-1,1,0,0,-1],[-2,0,0,1,0],[-2,1,1,0,2]]
    B2 B2     = [[0,0,0,0,2],[-1,-2,0,0,0],[1,0,2,0,2],[0,1,1,0,0],[0,0,2,2,0]]
    B2^T B1   = [[1,2,-2,0,2],[0,2,-1,0,1],[2,-1,0,0,1],[0,-1,-1,0,0],[2,-1,-1,2,0]]
    B1^T B0   = [[-1,1,1,-1,-2],[1,1,1,-3,0],[-1,1,-2,1,-1],[0,1,1,0,0],[0,0,1,-2,-1]]
    sum       = 0

S_2 terms:

    B0 B2^T   = [[0,1,-1,-2,-2],[1,-2,1,2,-1],[1,0,1,-1,-1],[0,1,-1,0,2],[0,0,-2,-1,0]]
    B1 B2     = [[-1,0,1,1,1],[1,2,0,0,-2],[-2,-3,0,-3,1],[0,0,1,-1,-1],[1,1,2,1,-1]]
    B2 B1     = [[1,0,-1,3,-1],[0,-2,-1,-2,1],[3,0,-2,1,2],[0,1,2,1,-1],[1,-2,-1,-1,1]]
    B2^T B0   = [[0,0,1,-2,1],[-1,0,0,-1,2],[-3,1,-1,1,-2],[-2,-1,-1,2,2],[0,1,1,0,-2]]
    B1^T B1^T = [[0,-1,0,0,1],[-1,2,0,1,0],[1,2,2,2,0],[2,-1,-1,-2,-2],[-2,0,0,1,2]]
    sum       = 0

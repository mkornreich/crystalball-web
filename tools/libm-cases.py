"""Reference results for the math functions the engine uses.

For each function, deterministic inputs over the ranges Crystal Ball's kernels
use, with glibc's result (Python's math module calls the platform libm, the same
one .NET's Math calls on Linux) and the correctly rounded result (mpmath at 200
bits). Values are IEEE-754 bit patterns in hex.

    python3 -I tools/libm-cases.py [count-per-function] > libm-cases.json
"""

import json
import math
import random
import struct
import sys

import mpmath

mpmath.mp.prec = 200


def bits(x):
    return struct.pack(">d", x).hex()


def cr(v):
    return float(mpmath.mpf(v))


def gen(rng, n):
    def wide(lo, hi):
        # log-uniform magnitude
        return math.exp(rng.uniform(math.log(lo), math.log(hi)))

    cases = {}
    cases["exp"] = [rng.uniform(-745, 709.7) for _ in range(n // 4)] + [rng.uniform(-40, 40) for _ in range(n // 2)] + [rng.uniform(-1, 1) for _ in range(n // 4)]
    cases["log"] = [wide(1e-300, 1e300) for _ in range(n // 2)] + [rng.uniform(0.5, 2) for _ in range(n // 4)] + [rng.uniform(1e-6, 1) for _ in range(n // 4)]
    cases["log10"] = [wide(1e-300, 1e300) for _ in range(n // 2)] + [rng.uniform(0.1, 1000) for _ in range(n // 2)]
    cases["pow"] = [(wide(1e-6, 1e6), rng.uniform(-30, 30)) for _ in range(n // 2)] + [(rng.uniform(0, 1), rng.uniform(0, 200)) for _ in range(n // 4)] + [(wide(1e-3, 1e3), float(rng.randint(-40, 40))) for _ in range(n // 4)]
    cases["sin"] = [rng.uniform(-4, 4) for _ in range(n)]
    cases["asin"] = [rng.uniform(-1, 1) for _ in range(n)]
    cases["tan"] = [rng.uniform(1e-6, 1.5707) for _ in range(n)]
    cases["atan"] = [wide(1e-9, 1e9) * rng.choice((-1, 1)) for _ in range(n)]
    return cases


REF = {
    "exp": (math.exp, lambda x: mpmath.exp(x)),
    "log": (math.log, lambda x: mpmath.log(x)),
    "log10": (math.log10, lambda x: mpmath.log10(x)),
    "pow": (lambda a: math.pow(*a), lambda a: mpmath.power(mpmath.mpf(a[0]), mpmath.mpf(a[1]))),
    "sin": (math.sin, lambda x: mpmath.sin(x)),
    "asin": (math.asin, lambda x: mpmath.asin(x)),
    "tan": (math.tan, lambda x: mpmath.tan(x)),
    "atan": (math.atan, lambda x: mpmath.atan(x)),
}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    rng = random.Random(20261023)
    out = {}
    for name, xs in gen(rng, n).items():
        glibc, exact = REF[name]
        rows = []
        for x in xs:
            try:
                g = glibc(x)
            except (OverflowError, ValueError):
                continue
            c = cr(exact(x))
            if math.isinf(c) or math.isinf(g):
                continue
            args = [bits(v) for v in x] if isinstance(x, tuple) else [bits(x)]
            rows.append([args, bits(g), bits(c)])
        out[name] = rows
    json.dump(out, sys.stdout)


main()

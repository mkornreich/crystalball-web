#!/usr/bin/env bash
# Rebuild libm.ts's reference data from the system C library (glibc 2.43, x86-64 with FMA):
#  1. random inputs with the system's results (tools/libm-gencases.c) → <cases-dir>/<fn>.bin
#  2. a sample of them as the unit-test fixture (tools/libm-fixture.py)
# Then `npx vite-node tools/libm-check.ts -- <cases-dir>` compares all of them.
# Regenerating libm-data.ts itself needs glibc's sources built standalone (see STATE.md):
#   tools/libm-dumptables*.c → tables-*.json → tools/glibc-libm-data.py.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=${1:-../extract/glibc/cases}
n=${2:-2000000}
mkdir -p "$dir"
tmp=$(mktemp -d)
gcc -O2 -fno-builtin tools/libm-gencases.c -lm -o "$tmp/gencases"
"$tmp/gencases" "$dir" "$n"
python3 -I - "$dir" <<'PY'
import math, random, struct, sys
rng = random.Random(7); out = open(sys.argv[1] + '/fma.bin', 'wb'); n = 0
def anyd():
    while True:
        v = struct.unpack('<d', struct.pack('<Q', rng.getrandbits(64)))[0]
        if math.isfinite(v): return v
while n < 1000000:
    u = rng.random()
    if u < 0.3: a, b, c = rng.uniform(-10, 10), rng.uniform(-10, 10), rng.uniform(-10, 10)
    elif u < 0.6:
        a, b = rng.uniform(-1e3, 1e3), rng.uniform(-1e3, 1e3); c = -(a * b) * (1 + rng.uniform(-1e-15, 1e-15))
    elif u < 0.8:
        a, b = math.ldexp(rng.random(), rng.randint(-600, 600)), math.ldexp(rng.random(), rng.randint(-400, 400))
        c = math.ldexp(rng.random(), rng.randint(-1000, 1000)) * rng.choice((-1, 1))
    else: a, b, c = anyd(), anyd(), anyd()
    try: r = math.fma(a, b, c)
    except (OverflowError, ValueError): continue
    out.write(struct.pack('<4d', a, b, c, r)); n += 1
PY
python3 -I tools/libm-fixture.py "$dir" 600 > src/engine/__tests__/fixtures/libm-glibc.json
rm -rf "$tmp"

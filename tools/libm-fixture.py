"""Write src/engine/__tests__/fixtures/libm-glibc.json: a sample of the system libm's
results (from the raw cases extract/glibc/build/gencases writes) for the unit test.
The full million-case comparison is tools/libm-check.ts.

    python3 -I tools/libm-fixture.py <cases-dir> [per-function] > src/engine/__tests__/fixtures/libm-glibc.json
"""
import json, os, struct, sys

d = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 600
out = {}
for fn, arity in (("fma", 4), ("exp", 2), ("log", 2), ("log10", 2), ("pow", 3), ("sin", 2), ("tan", 2), ("atan", 2), ("asin", 2)):
    path = os.path.join(d, fn + ".bin")
    if not os.path.exists(path):
        continue
    raw = open(path, "rb").read()
    rec = 8 * arity
    total = len(raw) // rec
    step = max(1, total // n)
    rows = []
    for i in range(0, total, step):
        vals = struct.unpack("<%dd" % arity, raw[i * rec:(i + 1) * rec])
        rows.append([struct.pack(">d", v).hex() for v in vals])
        if len(rows) >= n:
            break
    out[fn] = rows
json.dump(out, sys.stdout)

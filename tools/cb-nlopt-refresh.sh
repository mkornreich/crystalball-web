#!/usr/bin/env bash
# Re-run Crystal Ball's NLOptimizer and .NET Random on the harness's test problems
# (harness/dist `nlopt` / `random`) and refresh the optimizer fixture: every
# evaluation for the short runs, the first 300 plus counts and results for the long ones.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
run() { DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} "${DOTNET:-$HOME/.dotnet/dotnet}" ../harness/dist/bin/Release/net8.0/CbDist.dll "$1" | grep '^{'; }
run random > "$tmp/random.jsonl"
run nlopt > "$tmp/nlopt.jsonl"
node -e '
const fs = require("fs");
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const random = read(process.argv[1]);
const problems = read(process.argv[2]).map((p) => ({ ...p, evalCount: p.evals.length, evals: p.evals.slice(0, 300) }));
fs.writeFileSync("src/engine/__tests__/fixtures/cb-nlopt.json", JSON.stringify({ random, problems }));
' "$tmp/random.jsonl" "$tmp/nlopt.jsonl"
rm -rf "$tmp"

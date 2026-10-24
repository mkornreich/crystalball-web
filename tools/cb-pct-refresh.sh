#!/usr/bin/env bash
# Re-evaluate tools/cb-pct-cases.mjs (parameters entered as percentiles) in the real
# Crystal Ball engine and refresh the fixture. Needs the harness at ../harness/dist.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
node tools/cb-pct-cases.mjs cases > "$tmp/cases.json"
# Crystal Ball logs its optimizer to stdout; the answers are the last line.
DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} "${DOTNET:-$HOME/.dotnet/dotnet}" ../harness/dist/bin/Release/net8.0/CbDist.dll eval "$tmp/cases.json" | tail -1 > "$tmp/answers.json"
node tools/cb-pct-cases.mjs merge "$tmp/cases.json" "$tmp/answers.json" > src/engine/__tests__/fixtures/cb-percentiles.json
rm -rf "$tmp"

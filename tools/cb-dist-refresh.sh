#!/usr/bin/env bash
# Re-evaluate tools/cb-dist-cases.mjs in the real Crystal Ball engine and refresh the fixture.
# Needs the harness at ../harness/dist built against the CB 11.1.3 binaries.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
node tools/cb-dist-cases.mjs cases > "$tmp/cases.json"
DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} "${DOTNET:-$HOME/.dotnet/dotnet}" ../harness/dist/bin/Release/net8.0/CbDist.dll eval "$tmp/cases.json" > "$tmp/answers.json"
node tools/cb-dist-cases.mjs merge "$tmp/cases.json" "$tmp/answers.json" > src/engine/__tests__/fixtures/cb-distributions.json
rm -rf "$tmp"

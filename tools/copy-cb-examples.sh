#!/usr/bin/env bash
# Copy the Crystal Ball example workbooks the dashboard's gallery uses (see
# src/dashboard/examples.ts) from an extracted Crystal Ball install into
# examples/crystal-ball/, where the build picks them up, and the few the tests
# read into src/cbfile/__tests__/fixtures/. They are Oracle's files, so both are
# git-ignored; point CB_EXAMPLES at your install's Examples dir.
set -euo pipefail
cd "$(dirname "$0")/.."
src="${CB_EXAMPLES:-../extract/msi/INSTALLDIR_NOT_SET/Examples}"
dst=examples/crystal-ball
mkdir -p "$dst"
grep -o "file: '[^']*'" src/dashboard/examples.ts | sed "s/file: '//; s/'$//" | while IFS= read -r f; do
  if [ -f "$src/$f" ]; then cp "$src/$f" "$dst/"; echo "copied $f"; else echo "missing $src/$f" >&2; fi
done
fixtures=src/cbfile/__tests__/fixtures
mkdir -p "$fixtures"
for f in 'Futura Apartments.xlsx' 'Vision Research.xlsx' 'Multi-Zone Reserves.xlsx'; do
  if [ -f "$src/$f" ]; then cp "$src/$f" "$fixtures/"; echo "copied $f (tests)"; else echo "missing $src/$f" >&2; fi
done

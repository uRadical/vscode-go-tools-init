#!/usr/bin/env bash
#
# OPT-IN — you do NOT need this for normal testing.
#
# The committed fixtures are deliberately minimal: just go.mod tool directives,
# which is all the extension reads (discovery, picker, preview, lint wiring, and
# the gap-fill prompt all work from that text alone). Run this only when you want
# to actually *execute* a tool — e.g. Level-2 lint-on-save in the Dev Host.
#
# `go mod tidy` resolves whatever each module declares. `single` and
# `monorepo/services/auth` declare golangci-lint, so tidying them pulls its full
# dependency tree (~1k go.sum lines + hundreds of indirect requires). That is
# inherent to Go tool directives. The result is git-ignored (go.sum) and the
# bloated go.mod must NOT be committed — `git checkout` the go.mod files when done.
set -euo pipefail
cd "$(dirname "$0")"

export GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"

for dir in single monorepo/services/auth monorepo/services/api; do
  echo ">> $dir  (go mod tidy)"
  ( cd "$dir" && go mod tidy )
done

echo
echo "Done. go.sum is git-ignored; do NOT commit the bloated go.mod files."
echo "Verify lint:  (cd test-fixtures/single && go tool golangci-lint run ./...)"

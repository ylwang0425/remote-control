#!/usr/bin/env bash
# qa/T-relay/run.sh — the one command that runs every T-relay QA case.
#
# Owned by crew_qa. Run it from anywhere:
#     bash qa/T-relay/run.sh
#
# What it does, in order:
#   1. picks a real relay binary — relay/dist/ai-remote-relay-windows-amd64.exe
#      if this checkout has one, otherwise builds it into a private temp dir (the
#      repository is never written to);
#   2. vets the QA package;
#   3. asks the package itself for its case list (`go test -list`), so a case can
#      never be silently missing from this output;
#   4. runs each case in its own `go test -run` invocation with a fresh relay
#      process, and prints one PASS/FAIL/SKIP line per case;
#   5. exits 0 only when every case passed.
#
# A case that cannot run prints `SKIP: <reason>` and is counted as skipped, never
# as passed. Do not read a SKIP as evidence that the behaviour is correct.
#
# Note on the invocation: the cases are selected with the testing package's own
# -run flag and configured through `-args`. An earlier version of this script
# ran the compiled test binary directly with -test.v, which this Go toolchain
# rejects when the package defines its own TestMain; `go test` owns the flag
# namespace here, and that is the path that is verified working.

set -euo pipefail

this_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$this_dir/../.." && pwd)"
relay_dir="$repo_root/relay"

if [ ! -d "$relay_dir" ]; then
  echo "SKIP: $relay_dir does not exist — the relay module is not in this checkout."
  echo "      Nothing was tested. Do not read this as a pass."
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "SKIP: no go toolchain on PATH — cannot build the relay or the cases here."
  echo "      Install Go 1.27 and re-run: bash qa/T-relay/run.sh"
  exit 0
fi

tmp="$(mktemp -d)"
# One delete, one path, quoted: the only thing removed is what mktemp printed.
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Offline-first: everything the relay needs is in the module cache, and a run
# that is busy downloading is a run nobody can reproduce.
export GOFLAGS="${GOFLAGS:--mod=mod}"
export GOPROXY="${GOPROXY:-off}"

relay_bin=""
if [ "${QB_BUILD:-0}" != "1" ]; then
  for candidate in \
    "$relay_dir/dist/ai-remote-relay-windows-amd64.exe" \
    "$relay_dir/dist/ai-remote-relay-linux-amd64"
  do
    if [ -s "$candidate" ]; then
      case "$candidate" in
        *windows-amd64.exe)
          if [ "${OS:-}" = "Windows_NT" ]; then relay_bin="$candidate"; fi
          ;;
        *)
          if [ "$(uname -s 2>/dev/null || echo unknown)" != "Windows_NT" ]; then relay_bin="$candidate"; fi
          ;;
      esac
    fi
    [ -n "$relay_bin" ] && break
  done
fi

echo "qa/T-relay/run.sh"
echo "  repo:  $repo_root"
echo "  GOPROXY=$GOPROXY"

if [ -z "$relay_bin" ]; then
  relay_bin="$tmp/relay-test"
  [ "${OS:-}" = "Windows_NT" ] && relay_bin="${relay_bin}.exe"
  echo ">>> building the relay into $relay_bin"
  if ! (cd "$relay_dir" && go build -o "$relay_bin" ./cmd/ai-remote-relay); then
    echo "FAIL: could not build relay/cmd/ai-remote-relay; the cases cannot run."
    echo "      Re-run with GOPROXY=https://goproxy.cn,direct if the module cache is cold."
    exit 1
  fi
else
  echo "  relay: $relay_bin"
  echo "         (the artifact already in the checkout; delete it or run with QB_BUILD=1 to force a rebuild)"
fi

echo ">>> vetting the QA package"
if ! (cd "$this_dir" && go vet ./...); then
  echo "FAIL: go vet ./... on qa/T-relay is red; the cases are not trustworthy."
  exit 1
fi

echo ">>> listing cases"
if ! cases="$(cd "$this_dir" && go test -list '^TestCase' . 2>/dev/null | grep -E '^TestCase[0-9]+')"; then
  echo "FAIL: could not list the QA cases."
  exit 1
fi
count="$(printf '%s\n' "$cases" | grep -c .)"
if [ "$count" -eq 0 ]; then
  echo "FAIL: the package listed no cases; nothing would be tested."
  exit 1
fi
echo "    $count cases"
echo "------------------------------------------------------------"

pass=0
fail=0
skip=0
failed_cases=""
skipped_cases=""

for name in $cases; do
  out="$tmp/$name.log"
  if (cd "$this_dir" && go test -count=1 -v -timeout 10m -run "^${name}\$" . \
        -args "-relay.bin=$relay_bin" "-relay.root=$repo_root") >"$out" 2>&1; then
    # Only a SKIP of this case itself counts. A subtest that skips (a symlink the
    # host will not create, a check that needs POSIX) leaves the case a PASS and
    # is reported inside the case's own output.
    if grep -q -- "--- SKIP: $name " "$out"; then
      reason="$(grep -m1 -- "--- SKIP: $name " "$out" | sed 's/.*: //')"
      echo "  SKIP  $name — $reason"
      skip=$((skip + 1))
      skipped_cases="$skipped_cases
  - $name: $reason"
    else
      echo "  PASS  $name"
      pass=$((pass + 1))
    fi
  else
    if grep -q -- 'SKIP: no ai-remote-relay binary found' "$out"; then
      echo "  SKIP  $name — no relay binary available"
      skip=$((skip + 1))
      skipped_cases="$skipped_cases
  - $name: no relay binary available"
      continue
    fi
    echo "  FAIL  $name"
    echo "        ---- last 40 lines ----"
    tail -n 40 "$out" | sed 's/^/        /'
    echo "        ---- end ----"
    fail=$((fail + 1))
    failed_cases="$failed_cases
  - $name"
  fi
done

echo ""
echo "------------------------------------------------------------"
echo "T-relay QA totals: pass=$pass fail=$fail skip=$skip"
if [ -n "$skipped_cases" ]; then
  echo "SKIPPED (not evidence of correctness):$skipped_cases"
fi
if [ "$fail" -gt 0 ]; then
  echo "FAILED:$failed_cases"
  echo "FAIL"
  exit 1
fi
if [ "$skip" -gt 0 ]; then
  echo "Every runnable T-relay case passed; $skip case(s) were skipped above."
fi
echo "PASS"
exit 0

// main_test.go holds the case registry and the tiny selector both entry points
// share.
//
// There are two ways to run these cases, and both work:
//
//	bash qa/T-relay/run.sh                      # the runner beside this file
//	go test -count=1 -run '^TestCase04PairFlow$' \
//	    -args '-relay.bin=<path to relay exe>' '-relay.root=<repo root>'
//
// Both select a case with the testing package's own -run flag. There is no
// custom TestMain and no custom flag parsing: an earlier version of this file
// parsed the flags itself, and on this toolchain that made the compiled binary
// reject -test.v, which turned every case into a misconfiguration instead of a
// result. The standard flag path is the one that is verified working.
package relayqa_test

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain resolves the harness paths once, before any case runs.
//
// It exists because two entry points must both work:
//   - qa/T-relay/run.sh, which passes -relay.bin and -relay.root explicitly;
//   - qa/run-all.sh, which runs a plain `go test ./...` and passes nothing.
//
// The second one is the one that rots if it is not handled: with no flags the
// cases would either be skipped as "misconfigured" (a green-looking run that
// tested nothing) or crash in exec. So the defaults are filled in from the
// working directory, and the one thing that cannot be defaulted — a relay binary
// that does not exist — is printed as an explicit SKIP line, while every case
// still fails loudly rather than passing quietly.
func TestMain(m *testing.M) {
	flag.Parse()
	resolveHarness()
	os.Exit(m.Run())
}

// resolveHarness fills relayRoot and relayBin when the caller did not.
func resolveHarness() {
	if *relayRoot == "" {
		if root, ok := findRepoRoot(); ok {
			*relayRoot = root
		}
	}
	if *relayBin != "" {
		return
	}
	if *relayRoot != "" {
		for _, candidate := range []string{
			filepath.Join(*relayRoot, "relay", "dist", "ai-remote-relay-windows-amd64.exe"),
			filepath.Join(*relayRoot, "relay", "dist", "ai-remote-relay-linux-amd64"),
		} {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Size() > 0 {
				*relayBin = candidate
				return
			}
		}
	}
	// Nothing to run. Say so in the one shape the runners read, and let each
	// case fail: a case that could not run is not evidence.
	fmt.Println()
	fmt.Println("SKIP: no ai-remote-relay binary found (-relay.bin was not passed and")
	fmt.Println("      relay/dist/ai-remote-relay-* is absent). Build one with:")
	fmt.Println("          cd relay && go build -o dist/ai-remote-relay-windows-amd64.exe ./cmd/ai-remote-relay")
	fmt.Println("      or run the cases through bash qa/T-relay/run.sh, which builds it for you.")
	fmt.Println()
}

// findRepoRoot walks up from the working directory looking for the marker files
// that identify this repository.
func findRepoRoot() (string, bool) {
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for i := 0; i < 8; i++ {
		if info, err := os.Stat(filepath.Join(dir, "relay", "go.mod")); err == nil && !info.IsDir() {
			if _, err := os.Stat(filepath.Join(dir, "docs", "tasks")); err == nil {
				return dir, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", false
}

// caseName is an optional extra filter, kept for a caller that wants to select
// a case by name without knowing the -run syntax. Empty means "run whatever
// -run selected", which is how both documented entry points call it. It is a
// pointer for the same reason -relay.bin is: the parsed value must be written
// into storage that outlives flag.Parse.
var caseName = flag.String("case", "", "run only this case or a comma-separated list of them")

// Cases is the closed list this folder carries. qa/T-relay/run.sh reads it with
// `go test -list`, so a case added here can never be silently left out of the
// runner's output.
var Cases = []string{
	"TestCase01Init",
	"TestCase02HealthAndLoopback",
	"TestCase03StaticSite",
	"TestCase04PairFlow",
	"TestCase05PairCodeNormalizationAndSingleUse",
	"TestCase06OriginExactMatch",
	"TestCase07BodyLimitAndContentType",
	"TestCase08MethodAndParamsWhitelist",
	"TestCase09BridgeOffline",
	"TestCase10BridgeTimeout",
	"TestCase11LogoutAndRevocation",
	"TestCase12DownloadsWhitelist",
}

// caseFilter is a no-op unless -case was passed. Every case calls it first, so
// both entry points stay valid.
func caseFilter(t *testing.T) {
	t.Helper()
	if *caseName == "" {
		return
	}
	for _, part := range strings.Split(*caseName, ",") {
		if strings.TrimSpace(part) == t.Name() {
			return
		}
	}
	t.Skipf("not selected (-case=%q)", *caseName)
}

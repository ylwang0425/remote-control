package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestInitCreatesPrivateConfigWithHighEntropyToken covers R2:
// `ai-remote-relay --init --config <abs path>` must generate a high-entropy
// bridgeToken and write a private (0600) config file.
func TestInitCreatesPrivateConfigWithHighEntropyToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.json")

	cfg, err := Init(path, false)
	if err != nil {
		t.Fatalf("Init(%q) returned error: %v", path, err)
	}

	if len(cfg.BridgeToken) < 40 {
		t.Fatalf("bridgeToken too short: %d chars (want >= 40)", len(cfg.BridgeToken))
	}
	if strings.ContainsAny(cfg.BridgeToken, " \t\n\"'\\") {
		t.Fatalf("bridgeToken contains unsafe characters: %q", cfg.BridgeToken)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) returned error: %v", path, err)
	}
	var onDisk Config
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("config file is not valid JSON: %v", err)
	}
	if onDisk.BridgeToken != cfg.BridgeToken {
		t.Fatalf("bridgeToken on disk (%d chars) does not match returned token (%d chars)",
			len(onDisk.BridgeToken), len(cfg.BridgeToken))
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load(%q) returned error: %v", path, err)
	}
	if reloaded.BridgeToken != cfg.BridgeToken {
		t.Fatal("reloaded config does not carry the same bridgeToken")
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat(%q) returned error: %v", path, err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("config file mode = %04o, want 0600", got)
		}
	}
}

// TestInitRefusesToOverwriteExistingConfig covers R2: a repeated --init must not
// silently replace the private config (that would revoke every paired device by
// accident). Replacing needs an explicit force.
func TestInitRefusesToOverwriteExistingConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.json")

	first, err := Init(path, false)
	if err != nil {
		t.Fatalf("first Init returned error: %v", err)
	}

	second, err := Init(path, false)
	if !errors.Is(err, ErrAlreadyInitialized) {
		t.Fatalf("second Init error = %v, want ErrAlreadyInitialized", err)
	}
	if second != nil {
		t.Fatal("second Init returned a config; want nil")
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load after refused Init returned error: %v", err)
	}
	if reloaded.BridgeToken != first.BridgeToken {
		t.Fatal("refused Init changed the bridge token on disk")
	}

	forced, err := Init(path, true)
	if err != nil {
		t.Fatalf("forced Init returned error: %v", err)
	}
	if forced.BridgeToken == first.BridgeToken {
		t.Fatal("forced Init reused the old bridge token; want a fresh one")
	}
}

// TestValidateRejectsUnsafeConfiguration covers invariant 1 of the contract
// (§3.1: the relay only ever listens on loopback) and §5.3 (an allowed origin
// is an exact string, never a wildcard).
func TestValidateRejectsUnsafeConfiguration(t *testing.T) {
	token, err := NewBridgeToken()
	if err != nil {
		t.Fatalf("NewBridgeToken returned error: %v", err)
	}

	base := func() *Config {
		c := Default()
		c.BridgeToken = token
		return c
	}

	if err := Validate(base()); err != nil {
		t.Fatalf("Validate(default config) returned error: %v", err)
	}

	cases := []struct {
		name string
		mut  func(*Config)
	}{
		{"listen on all interfaces", func(c *Config) { c.ListenAddr = "0.0.0.0:8080" }},
		{"listen on a public address", func(c *Config) { c.ListenAddr = "101.43.98.18:8080" }},
		{"listen address is not host:port", func(c *Config) { c.ListenAddr = "8080" }},
		{"wildcard allowed origin", func(c *Config) { c.AllowedOrigins = []string{"*"} }},
		{"origin with a trailing slash", func(c *Config) { c.AllowedOrigins = []string{"https://101.43.98.18/"} }},
		{"empty bridge token", func(c *Config) { c.BridgeToken = "" }},
		{"short bridge token", func(c *Config) { c.BridgeToken = "short" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mut(c)
			if err := Validate(c); err == nil {
				t.Fatalf("Validate accepted an unsafe config (%s); want an error", tc.name)
			}
		})
	}
}

// TestLoadAppliesDefaultsForOmittedFields covers R2: a config file that only
// carries what --init wrote must still come back fully populated, so an
// operator editing the file by hand cannot accidentally disable a safety
// limit by deleting a line.
func TestLoadAppliesDefaultsForOmittedFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay.json")
	token, err := NewBridgeToken()
	if err != nil {
		t.Fatalf("NewBridgeToken returned error: %v", err)
	}
	body := []byte(`{"listenAddr":"127.0.0.1:8080","bridgeToken":"` + token + `"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	def := Default()
	if cfg.LogMaxBytes != def.LogMaxBytes {
		t.Fatalf("LogMaxBytes = %d, want default %d", cfg.LogMaxBytes, def.LogMaxBytes)
	}
	if cfg.LogMaxFiles != def.LogMaxFiles {
		t.Fatalf("LogMaxFiles = %d, want default %d", cfg.LogMaxFiles, def.LogMaxFiles)
	}
	if len(cfg.AllowedOrigins) != 1 || cfg.AllowedOrigins[0] != def.AllowedOrigins[0] {
		t.Fatalf("AllowedOrigins = %v, want %v", cfg.AllowedOrigins, def.AllowedOrigins)
	}
	if cfg.BridgeToken != token {
		t.Fatal("Load dropped the bridge token")
	}
	// The protocol's safety limits are constants, not configuration. If a future
	// change reintroduces one of them as a field, this test is the reminder that
	// an operator must not be able to think they tuned a protection.
	if cfg.ListenAddr != def.ListenAddr {
		t.Fatalf("ListenAddr = %q, want default %q", cfg.ListenAddr, def.ListenAddr)
	}
}

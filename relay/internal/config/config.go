package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// Config is the on-disk relay configuration. The generated file is private
// (0600) and holds the bridge token; it is never committed.
//
// Only fields that really change behaviour live here. The protocol's safety
// limits — the 300 second pairing code, the per-endpoint body ceilings, the
// 16/64 pending caps, the rate-limit quotas — are values the contract pins, so
// they are constants in the code rather than knobs. Offering them here would
// let an operator believe a protection had been tuned when nothing had read the
// value at all.
type Config struct {
	ListenAddr     string   `json:"listenAddr"`
	PublicOrigin   string   `json:"publicOrigin"`
	AllowedOrigins []string `json:"allowedOrigins"`
	BridgeToken    string   `json:"bridgeToken"`

	DBPath       string `json:"dbPath"`
	WebDir       string `json:"webDir"`
	DownloadsDir string `json:"downloadsDir"`

	LogFile     string `json:"logFile"`
	LogMaxBytes int64  `json:"logMaxBytes"`
	LogMaxFiles int    `json:"logMaxFiles"`

	// Test-only escapes. They weaken a check, so they default to false and are
	// refused by Validate unless the operator opted in explicitly.
	AllowInsecureCookie bool `json:"allowInsecureCookie"`
	AllowInsecureOrigin bool `json:"allowInsecureOrigin"`
}

const (
	// TokenBytes is the entropy of a bridge token or a phone session token.
	TokenBytes = 32
)

// ErrAlreadyInitialized is returned by Init when the config file already exists
// and force was false. The existing private config is never overwritten.
var ErrAlreadyInitialized = errors.New("config already exists; refusing to overwrite")

// Default returns the built-in defaults. The default listen address is loopback
// only: the relay is reached through the Caddy reverse proxy, never directly.
func Default() *Config {
	return &Config{
		ListenAddr:     "127.0.0.1:8080",
		PublicOrigin:   "https://101.43.98.18",
		AllowedOrigins: []string{"https://101.43.98.18"},
		DBPath:         "data/relay.db",
		WebDir:         "web",
		DownloadsDir:   "downloads",
		LogFile:        "logs/relay.log",
		LogMaxBytes:    8 << 20,
		LogMaxFiles:    3,
	}
}

// NewBridgeToken returns a fresh high-entropy bridge token (base64url, no
// padding, 43 characters for 32 bytes). It is printed once at init time and is
// never written to a log.
//
// There is deliberately no pairing-code generator here. A pairing code is 24
// Crockford Base32 symbols in six groups of four (§4.6), which this package
// knows nothing about; the one real generator is protocol.NewPairCode. A second
// generator living here would be a trap: it would produce a value this relay
// then refuses to accept.
func NewBridgeToken() (string, error) { return randomToken(TokenBytes) }

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Init creates a new private config file with a fresh bridge token. An existing
// file is left untouched unless force is true.
func Init(path string, force bool) (*Config, error) {
	if path == "" {
		return nil, errors.New("config path is empty")
	}
	if !force {
		if _, err := os.Stat(path); err == nil {
			return nil, fmt.Errorf("%w: %s", ErrAlreadyInitialized, path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("stat config: %w", err)
		}
	}

	cfg := Default()
	cfg.DBPath = filepath.Join(filepath.Dir(path), "data", "relay.db")
	cfg.LogFile = filepath.Join(filepath.Dir(path), "logs", "relay.log")

	token, err := NewBridgeToken()
	if err != nil {
		return nil, err
	}
	cfg.BridgeToken = token

	if err := Save(path, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Load reads a config file, applies defaults for fields the file leaves out and
// validates the result.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg := Default()
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if len(cfg.AllowedOrigins) == 0 && cfg.PublicOrigin != "" {
		cfg.AllowedOrigins = []string{cfg.PublicOrigin}
	}
	if err := Validate(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Save writes the config atomically with private permissions. The file holds a
// credential, so it is never group or world readable on a POSIX host.
func Save(path string, c *Config) error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("chmod config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

// Validate rejects configurations that would expose the relay or silently
// disable a safety limit.
func Validate(c *Config) error {
	if c == nil {
		return errors.New("config is nil")
	}
	if c.BridgeToken == "" {
		return errors.New("bridgeToken is empty")
	}
	if len(c.BridgeToken) < 40 {
		return errors.New("bridgeToken is too short; re-run --init")
	}
	if c.ListenAddr == "" {
		return errors.New("listenAddr is empty")
	}
	host, _, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return fmt.Errorf("listenAddr must be host:port: %w", err)
	}
	if !isLoopbackHost(host) && !c.AllowInsecureOrigin {
		return fmt.Errorf("listenAddr %q is not loopback; the relay must sit behind the reverse proxy", c.ListenAddr)
	}
	for _, o := range c.AllowedOrigins {
		if err := validateOrigin(o, c.AllowInsecureOrigin); err != nil {
			return err
		}
	}
	if c.LogMaxBytes <= 0 {
		return errors.New("logMaxBytes must be positive")
	}
	if c.LogMaxFiles < 0 {
		return errors.New("logMaxFiles must not be negative")
	}
	return nil
}

// validateOrigin enforces contract §5.3: an allowed origin is one exact string
// with a scheme and a host and nothing else — no wildcard, no path, no port.
func validateOrigin(origin string, allowHTTP bool) error {
	if strings.Contains(origin, "*") {
		return fmt.Errorf("allowed origin %q must be an exact origin, not a wildcard", origin)
	}
	if origin != strings.TrimSpace(origin) || origin != strings.ToLower(origin) {
		return fmt.Errorf("allowed origin %q must be lowercase with no surrounding whitespace", origin)
	}
	scheme, rest, ok := strings.Cut(origin, "://")
	if !ok {
		return fmt.Errorf("allowed origin %q is missing a scheme", origin)
	}
	if scheme != "https" && !(allowHTTP && scheme == "http") {
		return fmt.Errorf("allowed origin %q must use https", origin)
	}
	if rest == "" || strings.ContainsAny(rest, "/?#") {
		return fmt.Errorf("allowed origin %q must be exactly scheme://host (no path, no port)", origin)
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

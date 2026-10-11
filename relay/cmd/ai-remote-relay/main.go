// Command ai-remote-relay is the relay server: one Go process that brokers the
// phone's HTTP session and the desktop's WebSocket bridge.
//
// It listens on loopback only. Public traffic reaches it through Caddy, which
// terminates TLS at https://101.43.98.18.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/ai-remote/relay/internal/adminauth"
	"github.com/ai-remote/relay/internal/bridge"
	"github.com/ai-remote/relay/internal/config"
	"github.com/ai-remote/relay/internal/logx"
	"github.com/ai-remote/relay/internal/server"
	"github.com/ai-remote/relay/internal/store"
)

// version is the relay's own build label. It is never reported over the wire:
// §7.1 forbids /health from leaking anything but liveness.
const version = "1.0.0"

func main() {
	configPath := flag.String("config", "relay.json", "path to the relay config file")
	initOnly := flag.Bool("init", false, "create a new private config file with a fresh bridge token and exit")
	initAdmin := flag.Bool("init-admin", false, "add the first admin verifier; read its password from stdin")
	adminUsername := flag.String("admin-username", "", "username to configure with --init-admin")
	force := flag.Bool("force", false, "with --init, replace an existing private config")
	showVersion := flag.Bool("version", false, "print the build label and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	abs, err := filepath.Abs(*configPath)
	if err != nil {
		fatal("resolve config path", err)
	}

	if *initOnly {
		if *initAdmin {
			fatal("initialise config", errors.New("--init and --init-admin cannot be used together"))
		}
		runInit(abs, *force)
		return
	}
	if *initAdmin {
		runInitAdmin(abs, *adminUsername)
		return
	}
	runServer(abs)
}

// runInitAdmin adds an admin verifier without ever accepting the password as a
// command-line value or writing it to config or logs. A local operator pipes a
// password on stdin and supplies the non-secret username with --admin-username.
func runInitAdmin(abs, username string) {
	if strings.TrimSpace(username) != username || username == "" || len(username) > 128 {
		fatal("initialise admin", errors.New("--admin-username is required and must be trimmed"))
	}
	for _, r := range username {
		if unicode.IsControl(r) {
			fatal("initialise admin", errors.New("--admin-username contains a control character"))
		}
	}
	cfg, err := config.Load(abs)
	if err != nil {
		fatal("load config", err)
	}
	if cfg.Admin != nil {
		fatal("initialise admin", errors.New("an admin verifier already exists; refusing to replace it"))
	}
	password, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil {
		fatal("read admin password from stdin", err)
	}
	if len(password) > 4096 {
		fatal("initialise admin", errors.New("admin password input exceeds 4096 bytes"))
	}
	password = trimOneLineEnding(password)
	if len(password) < 12 {
		fatal("initialise admin", errors.New("admin password must be at least 12 bytes"))
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		clear(password)
		fatal("generate admin salt", err)
	}
	hash, err := adminauth.Derive(password, salt, adminauth.Iterations)
	clear(password)
	if err != nil {
		fatal("derive admin password verifier", err)
	}
	cfg.Admin = &config.Admin{
		Username:     username,
		PasswordSalt: base64.StdEncoding.EncodeToString(salt),
		PasswordHash: base64.StdEncoding.EncodeToString(hash),
	}
	clear(hash)
	if err := config.Validate(cfg); err != nil {
		clear(password)
		fatal("validate admin config", err)
	}
	if err := config.Save(abs, cfg); err != nil {
		fatal("save admin verifier", err)
	}
	fmt.Printf("saved admin verifier for %q to %s\n", username, abs)
}

func trimOneLineEnding(value []byte) []byte {
	if len(value) > 0 && value[len(value)-1] == '\n' {
		value = value[:len(value)-1]
	}
	if len(value) > 0 && value[len(value)-1] == '\r' {
		value = value[:len(value)-1]
	}
	return value
}

// runInit creates the private config. It never prints the bridge token: the
// token is a credential and this output is frequently captured by journald or a
// terminal scrollback. The operator reads it from the 0600 file, which is also
// the only place it should ever be copied from.
func runInit(abs string, force bool) {
	cfg, err := config.Init(abs, force)
	if err != nil {
		if errors.Is(err, config.ErrAlreadyInitialized) {
			fmt.Fprintf(os.Stderr, "refusing to overwrite %s\n", abs)
			fmt.Fprintln(os.Stderr, "that file holds the bridge token. Pass --force only if you mean to")
			fmt.Fprintln(os.Stderr, "replace it: every already-paired phone must pair again.")
			os.Exit(2)
		}
		fatal("initialise config", err)
	}

	fmt.Printf("wrote %s\n", abs)
	fmt.Printf("  listenAddr   %s\n", cfg.ListenAddr)
	fmt.Printf("  publicOrigin %s\n", cfg.PublicOrigin)
	fmt.Printf("  database     %s\n", cfg.DBPath)
	fmt.Printf("  log file     %s\n", cfg.LogFile)
	fmt.Printf("  bridgeToken  %d characters, written to the file with mode 0600\n", len(cfg.BridgeToken))
	fmt.Println()
	fmt.Println("The bridge token is a credential. Read it from the config file with:")
	fmt.Printf("  sudo sed -n 's/.*\"bridgeToken\": \"\\(.*\\)\".*/\\1/p' %s\n", abs)
	fmt.Println("Do not paste it into a chat, an issue or a build log.")
}

// runServer loads the config and serves until a signal arrives.
func runServer(abs string) {
	cfg, err := config.Load(abs)
	if err != nil {
		fatal("load config", err)
	}

	logWriter, err := logx.New(cfg.LogFile, cfg.LogMaxBytes, cfg.LogMaxFiles)
	if err != nil {
		fatal("open log file", err)
	}
	defer logWriter.Close()

	// Logs go to stdout (which systemd captures into the journal, itself
	// size-capped by the unit) and to the bounded file.
	logger := slog.New(slog.NewTextHandler(io.MultiWriter(os.Stdout, logWriter), &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		fatal("open database", err)
	}
	defer st.Close()

	hub := bridge.NewHub()
	srv, err := server.New(server.Options{Config: cfg, Store: st, Hub: hub, Logger: logger})
	if err != nil {
		fatal("build server", err)
	}

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// An RPC may legitimately wait up to its 60 second ceiling, and the
		// bridge socket is long-lived.
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Bind explicitly so a loopback-only promise is verified, not assumed.
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		fatal("listen", err)
	}
	defer listener.Close()

	logger.Info("relay starting", "version", version, "listen", listener.Addr().String(), "pool", "loopback")

	go func() {
		if err := httpSrv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal("serve", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Info("relay stopping")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("graceful shutdown did not finish", "error", err)
	}
}

func fatal(what string, err error) {
	fmt.Fprintf(os.Stderr, "ai-remote-relay: %s: %v\n", what, err)
	os.Exit(1)
}

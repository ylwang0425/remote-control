// Command ai-remote-relay is the relay server: one Go process that brokers the
// phone's HTTP session and the desktop's WebSocket bridge.
//
// It listens on loopback only. Public traffic reaches it through Caddy, which
// terminates TLS at https://101.43.98.18.
package main

import (
	"context"
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
	"syscall"
	"time"

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
		runInit(abs, *force)
		return
	}
	runServer(abs)
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

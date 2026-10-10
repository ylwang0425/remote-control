package server

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/ai-remote/relay/internal/bridge"
	"github.com/ai-remote/relay/internal/protocol"
	"github.com/ai-remote/relay/internal/store"
)

// The §10.5 heartbeat numbers, and §8.2's frame ceiling.
const (
	heartbeatInterval = 20 * time.Second
	idleTimeout       = 60 * time.Second
	pingGrace         = 10 * time.Second
	maxFrameBytes     = 262144
)

// pairCreateQuota is §8.4.4: at most 10 pair.create frames per minute on one
// bridge connection.
const pairCreateQuota = 10

// handleBridge serves /bridge: the desktop's one outbound long connection.
//
// Order matters here, and it is a security property rather than a style choice.
// Every check below the rate limiter can write an audit row, and an audit row is
// a real SQLite write. An unauthenticated caller could therefore make this
// process write to disk just by looping `curl https://…/bridge`. So the per-IP
// rate limit and the concurrency cap run FIRST, before the Origin and token
// checks and before any Audit call. Refusing a flood then costs no disk at all.
func (s *Server) handleBridge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w, "GET")
		return
	}

	ip := clientIP(r)
	if !s.limits.allow("bridge", ip) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	if !s.limits.enter(ip) {
		w.Header().Set("Retry-After", "5")
		s.fail(w, protocol.CodeRateLimited)
		return
	}
	defer s.limits.leave(ip)

	// Past the limiter, a refused handshake may now be recorded. §8.1: a browser
	// Origin on the bridge is always refused; a desktop bridge is not a browser
	// and must not send one.
	if r.Header.Get("Origin") != "" {
		_ = s.st.Audit("bridge.reject", "", "origin present", s.now())
		s.fail(w, protocol.CodeOriginForbidden)
		return
	}

	presented, ok := bearerToken(r)
	if !ok || !constantTimeEqual(presented, s.cfg.BridgeToken) {
		// §8.1: audit the refusal, and never the token itself.
		_ = s.st.Audit("bridge.reject", "", "invalid bridge token", s.now())
		s.failWith(w, protocol.CodeUnauthenticated, "invalid bridge token")
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin was checked above. Letting the library check again would
		// answer with its own error body instead of the contract's.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxFrameBytes)

	conn := s.hub.Register(func(ctx context.Context, frame []byte) error {
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return ws.Write(writeCtx, websocket.MessageText, frame)
	})
	defer s.hub.Unregister(conn)
	defer s.forgetPairCreate(conn)

	s.bridgeLoop(r.Context(), ws, conn)
}

type readResult struct {
	typ  websocket.MessageType
	data []byte
	err  error
}

// bridgeLoop reads frames until the connection dies or breaks a rule. All
// heartbeat state lives in this one goroutine, so it needs no lock.
func (s *Server) bridgeLoop(ctx context.Context, ws *websocket.Conn, conn *bridge.Conn) {
	readCh := make(chan readResult, 1)
	readerCtx, cancelReader := context.WithCancel(ctx)
	defer cancelReader()
	go func() {
		for {
			readCtx, cancel := context.WithTimeout(readerCtx, idleTimeout)
			typ, data, err := ws.Read(readCtx)
			cancel()
			select {
			case readCh <- readResult{typ: typ, data: data, err: err}:
			case <-readerCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()

	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()

	helloSent := false
	var lastSeen = time.Now()
	var pingSentAt time.Time

	for {
		select {
		case <-ctx.Done():
			return

		case <-heartbeat.C:
			if err := s.hub.Send(conn, map[string]any{"type": "ping"}); err != nil {
				return
			}
			pingSentAt = time.Now()

		case res := <-readCh:
			if res.err != nil {
				return
			}
			if res.typ == websocket.MessageBinary {
				// §8.5: binary frames are a protocol error.
				_ = ws.Close(websocket.StatusUnsupportedData, "binary frames are not allowed")
				return
			}
			now := time.Now()
			lastSeen = now
			pingSentAt = time.Time{}
			s.hub.Touch(conn)

			frame, err := protocol.ParseFrame(res.data)
			if err != nil {
				// §8.5: not JSON, or no string type, closes with 1002.
				_ = ws.Close(websocket.StatusProtocolError, "malformed frame")
				return
			}

			if !helloSent {
				if frame.Type != protocol.FrameHello {
					// §8.4.1: the first frame must be a hello.
					_ = ws.Close(websocket.StatusPolicyViolation, "bad hello")
					return
				}
				if err := frame.ValidateHello(); err != nil {
					_ = ws.Close(websocket.StatusPolicyViolation, "bad hello")
					return
				}
				s.hub.Hello(conn, frame.ClientName, derefCaps(frame.Capabilities))
				helloSent = true
				if err := s.sendHelloOK(conn); err != nil {
					return
				}
				continue
			}

			switch frame.Type {
			case protocol.FrameHello:
				// A repeat hello replaces the declaration and is answered again
				// (§8.4.1, idempotent).
				if err := frame.ValidateHello(); err != nil {
					_ = ws.Close(websocket.StatusPolicyViolation, "bad hello")
					return
				}
				s.hub.Hello(conn, frame.ClientName, derefCaps(frame.Capabilities))
				if err := s.sendHelloOK(conn); err != nil {
					return
				}
			case protocol.FramePing:
				if err := s.hub.Send(conn, map[string]any{"type": "pong"}); err != nil {
					return
				}
			case protocol.FramePong:
				// Touch already recorded the activity.
			case protocol.FramePairCreate:
				s.handlePairCreate(conn, frame)
			case protocol.FrameResponse:
				s.hub.Deliver(frame.ID, res.data)
			default:
				// §8.5: an unknown type is ignored and the connection continues.
				_ = s.st.Audit("bridge.unknown_frame", "", string(frame.Type), s.now())
			}
		}

		// §10.5: a ping that went unanswered past its grace window, with no
		// other frame in that time, is death.
		if !pingSentAt.IsZero() && time.Since(pingSentAt) > pingGrace && time.Since(lastSeen) > pingGrace {
			_ = ws.Close(websocket.StatusGoingAway, "heartbeat timeout")
			return
		}
	}
}

// sendHelloOK tells the desktop the connection is ready and hands it the
// heartbeat numbers it must use (§8.4.2).
func (s *Server) sendHelloOK(conn *bridge.Conn) error {
	return s.hub.Send(conn, map[string]any{
		"type":                "hello.ok",
		"version":             protocol.Version,
		"serverTime":          s.now().UTC().Format(time.RFC3339),
		"heartbeatIntervalMs": int(heartbeatInterval / time.Millisecond),
		"idleTimeoutMs":       int(idleTimeout / time.Millisecond),
		"requestTimeoutMs":    30000,
		"maxPending":          16,
	})
}

// handlePairCreate mints one pairing code for the desktop that asked (§8.4.4).
func (s *Server) handlePairCreate(conn *bridge.Conn, frame *protocol.Frame) {
	if !protocol.IsUUIDv4(frame.ID) {
		// The desktop owns this id; a malformed one cannot be echoed back.
		_ = s.st.Audit("bridge.bad_pair_create", "", "id is not a uuid v4", s.now())
		return
	}
	if !s.allowPairCreate(conn) {
		// §8.4.4: the failure path reuses the response frame. A
		// pair.created-shaped error is explicitly not allowed.
		_ = s.hub.Send(conn, map[string]any{
			"type": "response", "id": frame.ID, "ok": false,
			"error": map[string]any{"code": string(protocol.CodeRateLimited), "message": "too many requests"},
		})
		return
	}

	code, err := protocol.NewPairCode()
	if err != nil {
		s.log.Error("pair code generation failed")
		return
	}
	symbols, ok := protocol.NormalizePairCode(code)
	if !ok {
		s.log.Error("generated pair code failed its own normalization")
		return
	}
	hash := store.HashToken(symbols)
	now := s.now()
	expiresAt := now.Add(300 * time.Second)

	if err := s.st.InsertPairCode(hash, frame.ID, now, expiresAt); err != nil {
		s.log.Error("pair code insert failed")
		return
	}
	s.mu.Lock()
	s.codeOwners[hash] = codeOwner{conn: conn, codeID: frame.ID}
	s.mu.Unlock()

	if err := s.hub.Send(conn, map[string]any{
		"type":      "pair.created",
		"id":        frame.ID,
		"code":      code,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
		"url":       s.cfg.PublicOrigin + "/#pair=" + code,
	}); err != nil {
		s.log.Warn("bridge write failed")
	}
}

// allowPairCreate applies §8.4.4's per-connection quota.
func (s *Server) allowPairCreate(conn *bridge.Conn) bool {
	now := time.Now()
	s.pairMu.Lock()
	defer s.pairMu.Unlock()
	c := s.pairCreate[conn]
	if c == nil || now.Sub(c.window) > time.Minute {
		c = &counters{window: now}
		s.pairCreate[conn] = c
	}
	c.hit++
	return c.hit <= pairCreateQuota
}

func (s *Server) forgetPairCreate(conn *bridge.Conn) {
	s.pairMu.Lock()
	delete(s.pairCreate, conn)
	s.pairMu.Unlock()
}

func derefCaps(caps *protocol.Capabilities) protocol.Capabilities {
	if caps == nil {
		return protocol.Capabilities{}
	}
	return *caps
}

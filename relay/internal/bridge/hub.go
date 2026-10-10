// Package bridge owns the relay's side of the /bridge WebSocket: which desktop
// connections are online, how a phone call is dispatched to one of them, and
// the bounded table of calls that are still in flight (protocol-v1 §8, §10).
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
)

// Defaults from §10.2: a single bridge connection may hold 16 calls in flight
// and the relay as a whole 64.
const (
	DefaultMaxPerConn = 16
	DefaultMaxGlobal  = 64
)

// ErrSendFailed is returned by a transport when the frame could not be written.
var ErrSendFailed = errors.New("bridge send failed")

// SendFunc writes one frame to a bridge connection.
type SendFunc func(ctx context.Context, frame []byte) error

// Reply is the outcome of one forwarded call. Exactly one of Result, Err and
// Code carries the answer.
type Reply struct {
	// Result is the bridge's result object on success.
	Result json.RawMessage
	// Err is a business failure the bridge reported.
	Err *protocol.ErrorBody
	// Code is a relay-level failure (offline, busy, timeout, bad response).
	Code protocol.Code
}

// Conn is one accepted /bridge connection.
type Conn struct {
	mu         sync.Mutex
	send       SendFunc
	clientName string
	caps       protocol.Capabilities
	helloed    bool
	lastSeen   time.Time
	pending    int
	closed     bool
}

// Hub owns every bridge connection and the table of in-flight calls.
type Hub struct {
	mu        sync.Mutex
	conns     []*Conn
	pending   map[string]*pendingCall
	maxPer    int
	maxGlobal int
	now       func() time.Time
}

type pendingCall struct {
	conn   *Conn
	method string
	done   chan Reply
	once   sync.Once
	closed bool
}

// NewHub builds an empty hub.
func NewHub() *Hub {
	return &Hub{
		pending:   make(map[string]*pendingCall),
		maxPer:    DefaultMaxPerConn,
		maxGlobal: DefaultMaxGlobal,
		now:       time.Now,
	}
}

// SetLimits overrides the per-connection and global pending caps. Tests use it
// so they do not have to open 64 sockets to reach the boundary.
func (h *Hub) SetLimits(perConn, global int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.maxPer = perConn
	h.maxGlobal = global
}

// Register attaches a connection. It is not online until Hello arrives.
func (h *Hub) Register(send SendFunc) *Conn {
	c := &Conn{send: send, lastSeen: time.Now()}
	h.mu.Lock()
	h.conns = append(h.conns, c)
	h.mu.Unlock()
	return c
}

// Hello marks a connection as online with the capabilities it declared. It is
// idempotent: a second hello simply replaces the declaration (§8.4.1).
func (h *Hub) Hello(c *Conn, clientName string, caps protocol.Capabilities) {
	c.mu.Lock()
	c.clientName = clientName
	c.caps = caps
	c.helloed = true
	c.lastSeen = time.Now()
	c.mu.Unlock()
}

// Touch records that any frame arrived, which is what the idle judgement uses.
func (h *Hub) Touch(c *Conn) {
	c.mu.Lock()
	c.lastSeen = time.Now()
	c.mu.Unlock()
}

// Capabilities returns the declaration this connection last sent.
func (h *Hub) Capabilities(c *Conn) protocol.Capabilities {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.caps
}

// Unregister drops a connection and fails everything it had in flight (§10.2).
func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	c.mu.Lock()
	c.closed = true
	c.helloed = false
	c.mu.Unlock()
	for i, existing := range h.conns {
		if existing == c {
			h.conns = append(h.conns[:i], h.conns[i+1:]...)
			break
		}
	}
	var doomed []*pendingCall
	for id, call := range h.pending {
		if call.conn == c {
			doomed = append(doomed, call)
			delete(h.pending, id)
		}
	}
	h.mu.Unlock()

	for _, call := range doomed {
		call.resolve(Reply{
			Err:  &protocol.ErrorBody{Code: protocol.CodeBridgeBadResponse, Message: "bridge disconnected"},
			Code: protocol.CodeBridgeBadResponse,
		})
	}
}

// BridgeOnline reports whether at least one connection has completed hello and
// is still up (§7.1).
func (h *Hub) BridgeOnline() bool { return h.onlineLocked() > 0 }

func (h *Hub) onlineLocked() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.conns {
		c.mu.Lock()
		if c.helloed && !c.closed {
			n++
		}
		c.mu.Unlock()
	}
	return n
}

// PendingCount reports how many calls are in flight across the hub.
func (h *Hub) PendingCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.pending)
}

// Pick chooses a connection for the next dispatch (§10.3): online only, then
// under its own cap, then the least busy, then the most recently heard from.
func (h *Hub) Pick() (*Conn, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pickLocked()
}

func (h *Hub) pickLocked() (*Conn, bool) {
	var best *Conn
	var bestPending int
	var bestSeen time.Time
	for _, c := range h.conns {
		c.mu.Lock()
		online := c.helloed && !c.closed && c.pending < h.maxPer
		pending := c.pending
		seen := c.lastSeen
		c.mu.Unlock()
		if !online {
			continue
		}
		if best == nil || pending < bestPending || (pending == bestPending && seen.After(bestSeen)) {
			best, bestPending, bestSeen = c, pending, seen
		}
	}
	return best, best != nil
}

// Send marshals one frame and writes it to a specific connection. The server
// uses it for the frames the hub itself does not originate: hello.ok, pong and
// pair.created/pair.used.
func (h *Hub) Send(c *Conn, v any) error {
	c.mu.Lock()
	send := c.send
	closed := c.closed
	c.mu.Unlock()
	if send == nil || closed {
		return ErrSendFailed
	}
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return send(ctx, payload)
}

// Deliver routes one response frame to the call waiting for that id. An id that
// is unknown, already answered, or already reclaimed is dropped without
// touching any other call's state (§8.5, §10.2).
func (h *Hub) Deliver(id string, frame []byte) {
	h.mu.Lock()
	call, ok := h.pending[id]
	if ok {
		delete(h.pending, id)
		call.conn.mu.Lock()
		call.conn.pending--
		call.conn.mu.Unlock()
	}
	h.mu.Unlock()
	if !ok {
		return
	}
	call.conn.mu.Lock()
	caps := call.conn.caps
	call.conn.mu.Unlock()
	call.resolve(interpretResponse(call.method, frame, caps))
}

// resolve completes a call exactly once, whichever side gets there first.
func (c *pendingCall) resolve(r Reply) {
	c.once.Do(func() { c.done <- r })
}

// interpretResponse turns a response frame into a Reply, validating it against
// §8.4.8 before anything reaches the phone.
func interpretResponse(method string, frame []byte, caps protocol.Capabilities) Reply {
	parsed, err := protocol.ParseFrame(frame)
	if err != nil || parsed.Type != protocol.FrameResponse {
		return badResponse()
	}
	if parsed.OK == nil {
		return badResponse()
	}
	if *parsed.OK {
		if _, ok := protocol.ValidateResult(method, parsed.Result); !ok {
			return badResponse()
		}
		// §9.5: a desktop that declared no session source keeps its connection
		// and reports an empty list, rather than forwarding whatever it sent.
		if method == "sessions.list" && len(caps.Tools) == 0 {
			return Reply{Result: trimSessionsList(parsed.Result)}
		}
		return Reply{Result: parsed.Result}
	}
	if parsed.Error == nil || parsed.Error.Code == "" {
		return badResponse()
	}
	if !parsed.Error.Code.BridgeReportable() {
		return badResponse()
	}
	message := protocol.SanitizeMessage(parsed.Error.Message)
	if message == "" {
		message = parsed.Error.Code.CanonicalMessage()
	}
	return Reply{Err: &protocol.ErrorBody{Code: parsed.Error.Code, Message: message}}
}

func badResponse() Reply {
	return Reply{
		Err:  &protocol.ErrorBody{Code: protocol.CodeBridgeBadResponse, Message: protocol.CodeBridgeBadResponse.CanonicalMessage()},
		Code: protocol.CodeBridgeBadResponse,
	}
}

// trimSessionsList replaces the sessions array with an empty one, leaving every
// other field of the result — including capabilities — exactly as the desktop
// sent it.
func trimSessionsList(result json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(result, &fields); err != nil {
		return result
	}
	fields["sessions"] = json.RawMessage(`[]`)
	out, err := json.Marshal(fields)
	if err != nil {
		return result
	}
	return out
}

// Call forwards one request to a chosen connection and waits for its answer.
// It never sends the request twice: after a timeout or a disconnect the call is
// finished, and a late frame for that id is dropped on arrival (§10.2, §11.7).
func (h *Hub) Call(ctx context.Context, method string, params json.RawMessage, timeout time.Duration) Reply {
	if timeout <= 0 {
		timeout = time.Duration(protocol.DefaultTimeoutMs(method)) * time.Millisecond
	}

	h.mu.Lock()
	conn, ok := h.pickLocked()
	if !ok {
		anyOnline := false
		for _, c := range h.conns {
			c.mu.Lock()
			if c.helloed && !c.closed {
				anyOnline = true
			}
			c.mu.Unlock()
		}
		h.mu.Unlock()
		if anyOnline {
			return Reply{Code: protocol.CodeBridgeBusy}
		}
		return Reply{Code: protocol.CodeBridgeOffline}
	}
	if len(h.pending) >= h.maxGlobal {
		h.mu.Unlock()
		return Reply{Code: protocol.CodeBridgeBusy}
	}

	id, err := protocol.NewRequestID()
	if err != nil {
		h.mu.Unlock()
		return Reply{Code: protocol.CodeInternal}
	}
	call := &pendingCall{conn: conn, method: method, done: make(chan Reply, 1)}
	h.pending[id] = call
	conn.pending++
	h.mu.Unlock()

	payload, err := json.Marshal(map[string]any{
		"type":      "request",
		"id":        id,
		"method":    method,
		"params":    json.RawMessage(defaultParams(params)),
		"timeoutMs": int(timeout / time.Millisecond),
	})
	if err != nil {
		h.reclaim(id, conn)
		return Reply{Code: protocol.CodeInternal}
	}
	if err := conn.send(ctx, payload); err != nil {
		h.reclaim(id, conn)
		return Reply{Code: protocol.CodeBridgeOffline}
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-call.done:
		return r
	case <-timer.C:
		h.reclaim(id, conn)
		return Reply{Code: protocol.CodeBridgeTimeout}
	case <-ctx.Done():
		h.reclaim(id, conn)
		return Reply{Code: protocol.CodeBridgeBadResponse}
	}
}

func defaultParams(params json.RawMessage) []byte {
	if len(params) == 0 {
		return []byte(`{}`)
	}
	return params
}

// reclaim removes a pending entry and frees its connection slot, once.
func (h *Hub) reclaim(id string, conn *Conn) {
	h.mu.Lock()
	_, ok := h.pending[id]
	if ok {
		delete(h.pending, id)
		conn.mu.Lock()
		if conn.pending > 0 {
			conn.pending--
		}
		conn.mu.Unlock()
	}
	h.mu.Unlock()
}

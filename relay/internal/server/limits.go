package server

import (
	"crypto/subtle"
	"sync"
	"time"
)

// constantTimeEqual compares two secrets without leaking their length beyond
// what the protocol already exposes.
func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// bucket is one sliding window: a quota per window, plus an optional burst
// allowance on top of it.
//
// burst is the contract's "允许瞬时 20 次" (§6.3, /api/rpc): the window quota
// still bounds sustained traffic, and burst raises the ceiling for that same
// window so a momentary spike is not refused. It is a real limit with a real
// effect — quota+burst, and nothing beyond that — rather than a field that
// looks like a switch and reads nothing.
type bucket struct {
	window time.Duration
	quota  int
	burst  int
}

// The limits §6.3 pins. They are contract values, not deployment knobs.
var (
	bucketHealth = bucket{window: time.Minute, quota: 120}
	// §6.3 gives /api/pair "无额外突发", so its burst is zero on purpose.
	// Tightening this to a non-zero value would hand a code-guessing attacker
	// more attempts than the contract allows.
	bucketPair   = bucket{window: time.Minute, quota: 5}
	bucketRPC    = bucket{window: time.Minute, quota: 120, burst: 20}
	bucketLogout = bucket{window: time.Minute, quota: 10}
	bucketDown   = bucket{window: time.Minute, quota: 30}
	// bucketBridge bounds handshake attempts. The contract's §6.3 table does not
	// name /bridge, but every handshake past this bucket may write an audit row,
	// so it needs a ceiling of its own.
	bucketBridge      = bucket{window: time.Minute, quota: 60}
	bucketAdminLogin  = bucket{window: time.Minute, quota: 5}
	bucketAdminRPC    = bucket{window: time.Minute, quota: 120, burst: 20}
	bucketAdminEnroll = bucket{window: time.Minute, quota: 10}
	bucketEnrollment  = bucket{window: time.Minute, quota: 10}
)

// bucketTTL is how long an idle per-IP counter is kept before the sweep drops
// it. It must exceed the longest window above, or a live bucket would be
// discarded and its quota reset early.
const bucketTTL = time.Hour

// hourQuota is §6.3's second, slower limit on /api/pair: 20 per hour.
const hourQuota = 20

// maxInFlightPerIP is §6.3's cap on concurrent work from one address.
const maxInFlightPerIP = 64

// globalRPCRate is §6.3's whole-relay ceiling: 500 /api/* requests per second,
// above which the relay answers 503 bridge_busy instead of falling over.
const globalRPCRate = 500

type counters struct {
	hit    int
	window time.Time
}

// limiters holds every in-memory rate limit. Losing them on restart is
// acceptable: this is abuse control, not accounting (§6.3).
type limiters struct {
	mu       sync.Mutex
	byIP     map[string]map[string]*counters
	hourly   map[string]*counters
	inFlight map[string]int
	global   counters
}

func newLimiters() *limiters {
	return &limiters{
		byIP:     make(map[string]map[string]*counters),
		hourly:   make(map[string]*counters),
		inFlight: make(map[string]int),
	}
}

// allow applies a bucket to one client for one endpoint.
func (l *limiters) allow(name, ip string) bool {
	spec := specFor(name)
	return l.allowBucket(name, ip, spec)
}

func specFor(name string) bucket {
	switch name {
	case "pair":
		return bucketPair
	case "rpc":
		return bucketRPC
	case "fleet":
		return bucketRPC
	case "logout":
		return bucketLogout
	case "downloads":
		return bucketDown
	case "bridge":
		return bucketBridge
	case "admin_login":
		return bucketAdminLogin
	case "admin_rpc":
		return bucketAdminRPC
	case "admin_enrollment":
		return bucketAdminEnroll
	case "enrollment":
		return bucketEnrollment
	default:
		return bucketHealth
	}
}

func (l *limiters) allowBucket(name, ip string, spec bucket) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	perIP := l.byIP[ip]
	if perIP == nil {
		perIP = make(map[string]*counters)
		l.byIP[ip] = perIP
	}
	c := perIP[name]
	if c == nil || now.Sub(c.window) > spec.window {
		c = &counters{window: now}
		perIP[name] = c
	}
	c.hit++
	// The window quota bounds sustained traffic; the burst allowance raises the
	// ceiling for that same window, so a momentary spike is absorbed without
	// letting anything past quota+burst.
	if c.hit > spec.quota+spec.burst {
		return false
	}
	if name == "pair" {
		hourly := l.hourly[ip]
		if hourly == nil || now.Sub(hourly.window) > time.Hour {
			hourly = &counters{window: now}
			l.hourly[ip] = hourly
		}
		hourly.hit++
		if hourly.hit > hourQuota {
			return false
		}
	}
	return true
}

// allowGlobalRPC applies the relay-wide per-second ceiling.
func (l *limiters) allowGlobalRPC() bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.global.window) >= time.Second {
		l.global = counters{window: now}
	}
	l.global.hit++
	return l.global.hit <= globalRPCRate
}

// enter counts one concurrent request from an address, refusing past the cap.
func (l *limiters) enter(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[ip] >= maxInFlightPerIP {
		return false
	}
	l.inFlight[ip]++
	return true
}

func (l *limiters) leave(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[ip] > 0 {
		l.inFlight[ip]--
	}
}

// sweep drops per-IP state that has gone idle. Without it both maps grow for as
// long as the process runs, because every distinct source address that ever made
// one request leaves an entry behind — and on a public socket that is an
// unbounded memory growth an attacker does not even have to authenticate for.
func (l *limiters) sweep(now time.Time) int {
	l.mu.Lock()
	defer l.mu.Unlock()

	dropped := 0
	for ip, perEndpoint := range l.byIP {
		for name, c := range perEndpoint {
			if now.Sub(c.window) > bucketTTL {
				delete(perEndpoint, name)
				dropped++
			}
		}
		if len(perEndpoint) == 0 && l.inFlight[ip] == 0 {
			delete(l.byIP, ip)
		}
	}
	for ip, c := range l.hourly {
		if now.Sub(c.window) > bucketTTL {
			delete(l.hourly, ip)
			dropped++
		}
	}
	return dropped
}

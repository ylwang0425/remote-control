package protocol

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// uuidV4Pattern is the shape §4.1 pins for every id on the wire.
var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// NewRequestID returns a fresh lower-case UUID v4 for a request frame. The relay
// allocates it, and §4.1 forbids reusing one after it has been answered or
// reclaimed.
func NewRequestID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// IsUUIDv4 reports whether s is a lower-case UUID v4.
func IsUUIDv4(s string) bool { return uuidV4Pattern.MatchString(s) }

// maxMessageRunes is §6.1's ceiling for error.message.
const maxMessageRunes = 120

// SanitizeMessage makes a bridge-supplied error message safe to hand to a
// phone: control characters go, the length is capped, and a newline cannot be
// used to forge a log line or a UI row. §8.4.8 requires the desktop to clean
// its own text; this is the relay's second line of defence, because a bridge is
// the one component the relay does not control.
func SanitizeMessage(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		sb.WriteRune(r)
	}
	out := strings.TrimSpace(sb.String())
	runes := []rune(out)
	if len(runes) > maxMessageRunes {
		out = string(runes[:maxMessageRunes])
	}
	return out
}

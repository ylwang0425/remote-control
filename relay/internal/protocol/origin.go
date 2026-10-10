package protocol

import "strings"

// OriginAllowed reports whether a request's Origin header is acceptable.
//
// Contract §5.3: exactly one string is allowed. Before comparing, only two
// things happen — surrounding whitespace is trimmed and the whole string is
// lowercased. Everything else is a byte comparison, so a missing header, the
// literal "null", a different scheme, an explicit default port, a trailing
// slash or a longer hostname that merely ends with the allowed one are all
// refused. A browser Origin header cannot carry more than one value, so any
// whitespace inside the value fails the comparison naturally.
func OriginAllowed(origin string, allowed []string) bool {
	normalized := strings.ToLower(strings.TrimSpace(origin))
	if normalized == "" {
		return false
	}
	for _, a := range allowed {
		if normalized == strings.ToLower(strings.TrimSpace(a)) {
			return true
		}
	}
	return false
}

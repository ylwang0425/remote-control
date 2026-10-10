package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ai-remote/relay/internal/protocol"
)

// apkNamePattern is §7.5 rule 3: 1–128 characters, ending in .apk.
var apkNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$`)

// handleDownload serves the APK whitelist and nothing else.
//
// Every refusal is the same 404 with the same message, so this endpoint cannot
// be turned into a filesystem probe (§7.5). It never falls back to the static
// site, and the static site never falls back here (R19 item 1).
//
// Origin rule, which is deliberately looser here than on /api/*:
// the APK is a PUBLIC whitelisted file. A browser address-bar download, a phone
// "save link" and a plain `curl` all send NO Origin header — requiring one would
// make the download impossible for exactly the users it exists for. So a missing
// Origin is accepted on GET/HEAD, while a PRESENT Origin that is not the exact
// configured one is still refused. /api/* and /bridge keep the strict rule: a
// missing Origin there is a 403.
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.methodNotAllowed(w, "GET, HEAD")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if !protocol.OriginAllowed(origin, s.cfg.AllowedOrigins) {
			s.fail(w, protocol.CodeOriginForbidden)
			return
		}
	}
	if !s.limits.allow("downloads", clientIP(r)) {
		w.Header().Set("Retry-After", "30")
		s.fail(w, protocol.CodeRateLimited)
		return
	}

	name, ok := apkFromPath(r.URL.Path)
	if !ok {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	root := s.cfg.DownloadsDir
	if root == "" {
		s.fail(w, protocol.CodeNotFound)
		return
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	full := filepath.Join(absRoot, name)
	if filepath.Dir(full) != absRoot {
		s.fail(w, protocol.CodeNotFound)
		return
	}

	// Rule 7: refuse a symlink rather than following it out of the whitelist.
	info, err := os.Lstat(full)
	if err != nil {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		s.fail(w, protocol.CodeNotFound)
		return
	}

	file, err := os.Open(full)
	if err != nil {
		s.fail(w, protocol.CodeNotFound)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

// apkFromPath applies §7.5 rules 1–5 and returns the file name to serve.
func apkFromPath(rawPath string) (string, bool) {
	const prefix = "/downloads/"
	if !strings.HasPrefix(rawPath, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(rawPath, prefix)
	if rest == "" {
		return "", false
	}
	// Rule 5: decode first, then check the decoded form, so %2e%2e%2f cannot
	// slip past a check that only looked at the raw text.
	decoded, err := decodePercentOnce(rest)
	if err != nil {
		return "", false
	}
	decoded = strings.ReplaceAll(decoded, "\\", "/")
	if decoded == "" || strings.Contains(decoded, "/") || strings.Contains(decoded, "..") ||
		strings.ContainsRune(decoded, 0) || strings.Contains(decoded, ":") {
		return "", false
	}
	// Rules 3 and 4: an .apk name with no path segment in it. A JSON, log, key
	// or database file can never satisfy this, so it is 404 by construction.
	if !apkNamePattern.MatchString(decoded) {
		return "", false
	}
	if path.Base(decoded) != decoded {
		return "", false
	}
	return decoded, true
}

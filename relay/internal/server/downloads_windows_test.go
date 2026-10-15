package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ai-remote/relay/internal/protocol"
)

func TestWindowsReleaseDownloads(t *testing.T) {
	e := newEnv(t)
	const contents = "PK\x03\x04 reviewed Windows release"
	for _, name := range []string{"AI-Remote-Windows.zip", "AI-Remote-Windows-1.1.1.zip", "AI-Remote-Dispatch-Skill.zip", "AI-Remote-Dispatch-Skill-1.0.0.zip"} {
		if err := os.WriteFile(filepath.Join(e.download, name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			resp := e.request(method, "/downloads/"+name, "", "", "", "")
			body := readBody(t, resp)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s %s: status %d", method, name, resp.StatusCode)
			}
			if got := resp.Header.Get("Content-Type"); got != "application/zip" {
				t.Fatalf("ZIP Content-Type = %q", got)
			}
			if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="`+name+`"` {
				t.Fatalf("ZIP Content-Disposition = %q", got)
			}
			if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("ZIP response is missing its download headers")
			}
			if resp.ContentLength != int64(len(contents)) {
				t.Fatalf("ZIP Content-Length = %d", resp.ContentLength)
			}
			if method == http.MethodGet && body != contents || method == http.MethodHead && body != "" {
				t.Fatalf("unexpected %s ZIP body", method)
			}
		}
		for _, origin := range []string{testOrigin, "https://foreign.example"} {
			resp := e.request(http.MethodGet, "/downloads/"+name, origin, "", "", "")
			if origin != testOrigin {
				decodeFailure(t, resp, http.StatusForbidden, protocol.CodeOriginForbidden)
			} else if readBody(t, resp) != contents || resp.StatusCode != http.StatusOK {
				t.Fatal("same-origin ZIP download failed")
			}
		}
	}
	request, err := http.NewRequest(http.MethodGet, e.srv.URL+"/downloads/AI-Remote-Windows-1.1.1.zip", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-3")
	response, err := e.srv.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if body := readBody(t, response); response.StatusCode != http.StatusPartialContent || body != contents[:4] {
		t.Fatal("Windows download did not preserve byte-range support")
	}
}

func TestWindowsDownloadsRefuseOtherFiles(t *testing.T) {
	e := newEnv(t)
	for _, name := range []string{
		"secrets.zip", "AI-Remote-Windows-development.zip", "AI-Remote-Windows-1.1.zip",
		"AI-Remote-Windows-1.1.1-debug.zip", "AI-Remote-Windows-1.1.1.zip.bak",
		"AI-Remote-Windows.zip.json", "AI-Remote-Windows-1.1.1.ZIP",
		"AI-Remote-Windows-" + strings.Repeat("1", 128) + ".1.1.zip",
		"AI-Remote-Dispatch-Skill-debug.zip", "AI-Remote-Dispatch-Skill-1.0.0.zip.json",
		"AI-Remote-Dispatch-Skill-1.0.zip", "AI-Remote-Dispatch-Skill-1.0.0.zip.bak",
	} {
		if err := os.WriteFile(filepath.Join(e.download, name), []byte("private fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		decodeFailure(t, e.request(http.MethodGet, "/downloads/"+name, "", "", "", ""), http.StatusNotFound, protocol.CodeNotFound)
	}
	for _, target := range []string{
		"/downloads/../AI-Remote-Windows.zip", "/downloads/..%2fAI-Remote-Windows.zip",
		"/downloads/%2e%2e%5cAI-Remote-Windows.zip", "/downloads/AI-Remote-Windows.zip/extra",
		"/downloads/", "/AI-Remote-Windows.zip",
	} {
		decodeFailure(t, e.request(http.MethodGet, target, "", "", "", ""), http.StatusNotFound, protocol.CodeNotFound)
	}
	decodeFailure(t, e.request(http.MethodPost, "/downloads/AI-Remote-Windows.zip", "", "", "", ""), http.StatusMethodNotAllowed, protocol.CodeMethodNotAllowed)
}

func TestWindowsDownloadRejectsSymlink(t *testing.T) {
	e := newEnv(t)
	outside := filepath.Join(t.TempDir(), "private.zip")
	if err := os.WriteFile(outside, []byte("private fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(e.download, "AI-Remote-Windows.zip")); err != nil {
		t.Skipf("symlinks unavailable on this host: %v", err)
	}
	decodeFailure(t, e.request(http.MethodGet, "/downloads/AI-Remote-Windows.zip", "", "", "", ""), http.StatusNotFound, protocol.CodeNotFound)
}

type slowReleaseWriter struct {
	http.ResponseWriter
}

func (w slowReleaseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w slowReleaseWriter) Write(body []byte) (int, error) {
	time.Sleep(1200 * time.Millisecond)
	return w.ResponseWriter.Write(body)
}

func TestReleaseDownloadOutlivesRPCWriteTimeout(t *testing.T) {
	e := newEnv(t)
	const contents = "PK\x03\x04 slow Windows download"
	if err := os.WriteFile(filepath.Join(e.download, "AI-Remote-Windows.zip"), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.s.Handler().ServeHTTP(slowReleaseWriter{w}, r)
	}))
	server.Config.WriteTimeout = time.Second
	server.Start()
	t.Cleanup(server.Close)
	resp, err := server.Client().Get(server.URL + "/downloads/AI-Remote-Windows.zip")
	if err != nil {
		t.Fatalf("download hit the ordinary server write deadline: %v", err)
	}
	if body := readBody(t, resp); resp.StatusCode != http.StatusOK || body != contents {
		t.Fatalf("slow release download was truncated: status %d", resp.StatusCode)
	}
}

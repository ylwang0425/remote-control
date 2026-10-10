// Package logx provides the relay's bounded log writer.
//
// It is a size cap, not a sanitiser. There is deliberately no redaction function
// here: a redactor that callers might trust is worse than none, because it
// invites passing a secret in and hoping. The rule is that a secret never
// reaches a log call at all, and the one place that must clean foreign text is
// protocol.SanitizeMessage, which guards the error strings a bridge sends.
package logx

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Writer is an io.Writer that rotates its file once it passes maxBytes, keeping
// at most maxFiles rotated copies.
type Writer struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	maxFiles int
	file     *os.File
	size     int64
}

// New opens (or creates) path for appending and returns a bounded writer.
func New(path string, maxBytes int64, maxFiles int) (*Writer, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("logx: maxBytes must be positive")
	}
	if maxFiles < 0 {
		return nil, fmt.Errorf("logx: maxFiles must not be negative")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("logx: create log dir: %w", err)
	}
	w := &Writer{path: path, maxBytes: maxBytes, maxFiles: maxFiles}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Writer) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("logx: open log: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("logx: stat log: %w", err)
	}
	w.file = f
	w.size = info.Size()
	return nil
}

// Write appends p, rotating first when the file would exceed its cap.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, os.ErrClosed
	}
	if w.size+int64(len(p)) > w.maxBytes && w.size > 0 {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate closes the current file, shifts the rotated copies along and starts a
// fresh one. Rotation failures never stop the caller from logging.
func (w *Writer) rotate() error {
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("logx: close for rotation: %w", err)
	}
	w.file = nil
	if w.maxFiles == 0 {
		if err := os.Remove(w.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("logx: remove old log: %w", err)
		}
		return w.open()
	}
	if err := os.Remove(fmt.Sprintf("%s.%d", w.path, w.maxFiles)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("logx: remove oldest log: %w", err)
	}
	for i := w.maxFiles - 1; i >= 1; i-- {
		from := fmt.Sprintf("%s.%d", w.path, i)
		to := fmt.Sprintf("%s.%d", w.path, i+1)
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("logx: rotate %s: %w", from, err)
		}
	}
	if err := os.Rename(w.path, w.path+".1"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("logx: rotate current log: %w", err)
	}
	return w.open()
}

// Close releases the file.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

var _ io.Writer = (*Writer)(nil)

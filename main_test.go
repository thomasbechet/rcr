package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git not installed")
	}
	root := t.TempDir()
	runGit(t, root, "init", "-q")
	runGit(t, root, "config", "user.name", "RCR Test")
	runGit(t, root, "config", "user.email", "test@example.invalid")
	return root
}

func runGit(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func write(t *testing.T, root, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func getSnapshot(t *testing.T, root string) snapshot {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := collect(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCollectChanges(t *testing.T) {
	root := fixture(t)
	write(t, root, "changed.txt", "original\n")
	write(t, root, "deleted.txt", "delete\n")
	write(t, root, "old.txt", "rename me\n")
	write(t, root, ".gitignore", "ignored.txt\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "initial")
	write(t, root, "changed.txt", "staged\n")
	runGit(t, root, "add", "changed.txt")
	write(t, root, "changed.txt", "unstaged\n")
	runGit(t, root, "mv", "old.txt", "new.txt")
	if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	write(t, root, "odd\tname\n<script>.txt", "<script>alert(1)</script>\n")
	write(t, root, ":(glob)*", "literal pathspec\n")
	write(t, root, "binary", "\x00\x01")
	write(t, root, "ignored.txt", "secret\n")
	s := getSnapshot(t, root)
	found := map[string]change{}
	for _, c := range s.Changes {
		found[c.Section+":"+c.Path] = c
	}
	if len(found) != 7 {
		t.Fatalf("got %d changes: %+v", len(found), s.Changes)
	}
	if c := found["unstaged:changed.txt"]; !strings.Contains(c.Diff, "-staged\n+unstaged") {
		t.Fatalf("unstaged: %+v", c)
	}
	if c := found["staged:changed.txt"]; !strings.Contains(c.Diff, "-original\n+staged") {
		t.Fatalf("staged: %+v", c)
	}
	if c := found["staged:new.txt"]; c.Status != "R" || c.OldPath != "old.txt" || !strings.Contains(c.Diff, "rename from") {
		t.Fatalf("rename: %+v", c)
	}
	if c := found["unstaged:deleted.txt"]; c.Status != "D" {
		t.Fatalf("deleted: %+v", c)
	}
	if c := found["untracked:binary"]; !strings.Contains(c.Notice, "Binary") {
		t.Fatalf("binary: %+v", c)
	}
	if c := found["untracked:odd\tname\n<script>.txt"]; !strings.Contains(c.Diff, "+<script>") {
		t.Fatalf("odd filename: %+v", c)
	}
}

func TestUnbornAndCleanRepository(t *testing.T) {
	root := fixture(t)
	if s := getSnapshot(t, root); len(s.Changes) != 0 || s.Changes == nil {
		t.Fatalf("empty: %+v", s)
	}
	write(t, root, "first", "hello")
	runGit(t, root, "add", "first")
	s := getSnapshot(t, root)
	if len(s.Changes) != 1 || s.Changes[0].Section != "staged" || s.Changes[0].Status != "A" {
		t.Fatalf("unborn: %+v", s)
	}
	runGit(t, root, "commit", "-qm", "initial")
	if s := getSnapshot(t, root); len(s.Changes) != 0 {
		t.Fatalf("clean: %+v", s)
	}
}

func TestLiteralTrackedPath(t *testing.T) {
	root := fixture(t)
	write(t, root, ":(glob)*", "before\n")
	write(t, root, "other", "before\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "initial")
	write(t, root, ":(glob)*", "literal\n")
	write(t, root, "other", "unrelated\n")
	s := getSnapshot(t, root)
	for _, c := range s.Changes {
		if c.Path == ":(glob)*" && (strings.Contains(c.Diff, "unrelated") || !strings.Contains(c.Diff, "+literal")) {
			t.Fatalf("pathspec expanded: %+v", c)
		}
	}
}

func TestUntrackedPreview(t *testing.T) {
	root := t.TempDir()
	write(t, root, "empty", "")
	write(t, root, "no-newline", "one\ntwo")
	if _, notice := untrackedDiff(root, "empty"); notice != "Empty file" {
		t.Fatal(notice)
	}
	if diff, _ := untrackedDiff(root, "no-newline"); !strings.Contains(diff, "@@ -0,0 +1,2 @@") || !strings.Contains(diff, "\\ No newline at end of file") {
		t.Fatal(diff)
	}
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("DO NOT SHOW"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if diff, notice := untrackedDiff(root, "link"); notice != "" || strings.Contains(diff, "DO NOT SHOW") || !strings.Contains(diff, secret) {
		t.Fatalf("symlink: %q %q", diff, notice)
	}
	write(t, root, "large", strings.Repeat("x", maxOutput+1))
	if _, notice := untrackedDiff(root, "large"); !strings.Contains(notice, "limit") {
		t.Fatal(notice)
	}
}

func TestHTTPRefresh(t *testing.T) {
	root := fixture(t)
	a := &app{root: root, current: getSnapshot(t, root)}
	h := a.handler()
	request := func(method, path string, header bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if header {
			r.Header.Set("X-RCR-Refresh", "1")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	write(t, root, "new", "new content\n")
	w := request("GET", "/api/diffs", false)
	var s snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Changes) != 0 {
		t.Fatal("GET must not refresh")
	}
	if w := request("POST", "/api/refresh", false); w.Code != http.StatusForbidden {
		t.Fatal(w.Code)
	}
	if w := request("GET", "/api/refresh", false); w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}
	w = request("POST", "/api/refresh", true)
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Changes) != 1 {
		t.Fatal(s)
	}
	a.refreshMu.Lock()
	if w := request("POST", "/api/refresh", true); w.Code != http.StatusConflict {
		t.Fatal(w.Code)
	}
	a.refreshMu.Unlock()
	if w := request("GET", "/", false); w.Code != 200 || !strings.Contains(w.Body.String(), "Remote code review") || w.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("UI: %d", w.Code)
	}
	if w := request("GET", "/app.js", false); w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Failed refreshes must preserve the last successful snapshot.
	a.root = t.TempDir()
	if w := request("POST", "/api/refresh", true); w.Code != 500 {
		t.Fatal(w.Code)
	}
	if len(a.current.Changes) != 1 {
		t.Fatal("failed refresh lost snapshot")
	}
}

func TestParseNames(t *testing.T) {
	if _, err := parseNames([]byte("R100\x00old\x00"), "staged"); err == nil {
		t.Fatal("accepted incomplete rename")
	}
	changes, err := parseNames([]byte("M\x00a\nb\x00R100\x00old\x00new\x00"), "staged")
	if err != nil || len(changes) != 2 || changes[0].Path != "a\nb" || changes[1].OldPath != "old" {
		t.Fatalf("%+v %v", changes, err)
	}
}

func TestOutputLimit(t *testing.T) {
	var b cappedBuffer
	if _, err := b.Write(make([]byte, maxOutput+1)); err == nil {
		t.Fatal("output limit not enforced")
	}
}

func TestParseListenAddress(t *testing.T) {
	for _, address := range []string{"localhost:8080", "127.0.0.1:1", "0.0.0.0:65535", "review.example:9090", "[::1]:8080", "[::]:8080", "[fe80::1%lo]:8080"} {
		got, err := parseListenAddress(address)
		if err != nil || got != address {
			t.Errorf("%q: got %q, %v", address, got, err)
		}
	}
	for _, address := range []string{"", "8080", "localhost", ":8080", "localhost:", "localhost:0", "localhost:65536", "localhost:-1", "localhost:+8080", "localhost:http", "localhost:99999999999999999999", "::1:8080", "http://localhost:8080", "host name:8080", "localhost:8080/path"} {
		if got, err := parseListenAddress(address); err == nil {
			t.Errorf("accepted %q as %q", address, got)
		}
	}
}

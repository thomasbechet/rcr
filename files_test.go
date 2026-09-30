package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRepositoryFilesExcludesMissingPaths(t *testing.T) {
	root := fixture(t)
	if err := os.Mkdir(filepath.Join(root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	write(t, root, "folder/deleted.txt", "deleted\n")
	write(t, root, "staged.txt", "staged\n")
	write(t, root, "kept.txt", "kept\n")
	if err := os.Symlink("missing-target", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "initial")
	if err := os.Remove(filepath.Join(root, "folder/deleted.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "folder")); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "rm", "staged.txt")
	write(t, root, "new.txt", "new\n")
	check := func(want []string) {
		t.Helper()
		files, err := repositoryFiles(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(files, want) {
			t.Fatalf("inventory: %v, want %v", files, want)
		}
	}
	check([]string{"kept.txt", "link", "new.txt"})
	// A staged deletion recreated on disk is an untracked file and belongs in Files.
	write(t, root, "staged.txt", "recreated\n")
	check([]string{"kept.txt", "link", "new.txt", "staged.txt"})
}

func TestFileBrowser(t *testing.T) {
	root := fixture(t)
	write(t, root, "unchanged.txt", "unchanged\n")
	write(t, root, "deleted.txt", "deleted\n")
	write(t, root, ".gitignore", "ignored\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "initial")
	if err := os.Mkdir(filepath.Join(root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	write(t, root, "folder/new + #.txt", "<script>not executed</script>\n")
	write(t, root, "ignored", "private\n")
	write(t, root, "binary", "\x00binary")
	if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	a := &app{root: root, current: getSnapshot(t, root)}
	h := a.handler()
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	w := get("/api/files")
	var names []string
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &names); err != nil {
		t.Fatal(err)
	}
	if len(names) != 4 {
		t.Fatalf("inventory: %v", names)
	}
	for _, name := range names {
		if strings.HasPrefix(name, ".git/") || name == "ignored" || name == "deleted.txt" {
			t.Fatalf("exposed %q", name)
		}
	}
	for _, name := range []string{"unchanged.txt", "folder/new + #.txt", "binary"} {
		w := get("/api/file?path=" + url.QueryEscape(name))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
		var p filePreview
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Path != name {
			t.Fatal(p)
		}
		if name == "binary" && (!strings.Contains(p.Notice, "Binary") || p.Content != "") {
			t.Fatal(p)
		}
		if name == "unchanged.txt" && p.Content != "unchanged\n" {
			t.Fatal(p)
		}
	}
	for name, status := range map[string]int{"../secret": 400, "/etc/passwd": 400, ".git/config": 400, "folder/../../secret": 400, "ignored": 404, "missing": 404, "deleted.txt": 404, "": 400} {
		if w := get("/api/file?path=" + url.QueryEscape(name)); w.Code != status {
			t.Fatalf("%q: %d, want %d", name, w.Code, status)
		}
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/files", nil))
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
}

func TestPreviewSymlinkBoundaries(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, outside, "secret", "secret contents")
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	p, err := readPreview(root, "link")
	if err != nil || p.Content != filepath.Join(outside, "secret") || !strings.Contains(p.Notice, "not followed") {
		t.Fatalf("%+v %v", p, err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := readPreview(root, "escape/secret"); err == nil {
		t.Fatal("followed external directory symlink")
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	write(t, root, ".git/config", "private Git config")
	if err := os.Symlink(".git", filepath.Join(root, "metadata")); err != nil {
		t.Fatal(err)
	}
	if _, err := readPreview(root, "metadata/config"); err == nil {
		t.Fatal("followed internal directory symlink")
	}
	if _, err := readPreview(root, ".git/config"); err == nil {
		t.Fatal("exposed metadata")
	}
	write(t, root, "large", strings.Repeat("x", maxOutput+1))
	p, err = readPreview(root, "large")
	if err != nil || p.Content != "" || !strings.Contains(p.Notice, "limit") {
		t.Fatalf("%+v %v", p, err)
	}
	write(t, root, "empty", "")
	p, err = readPreview(root, "empty")
	if err != nil || p.Notice != "Empty file" {
		t.Fatalf("%+v %v", p, err)
	}
}

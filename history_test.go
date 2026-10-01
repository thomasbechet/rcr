package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHistory(t *testing.T) {
	root := fixture(t)
	a := &app{root: root}
	request := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	w := request("/api/history")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"commits":[]`) {
		t.Fatalf("empty history: %s", w.Body.String())
	}
	write(t, root, "file.txt", "first\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-qm", "Initial <commit>")
	runGit(t, root, "branch", "other")
	write(t, root, "file.txt", "second\n")
	runGit(t, root, "commit", "-qam", "Second commit")
	w = request("/api/history")
	var history struct {
		Branches []string
		Commits  []historyCommit
	}
	if err := json.Unmarshal(w.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Commits) != 2 || history.Commits[0].Subject != "Second commit" || history.Commits[1].Subject != "Initial <commit>" {
		t.Fatalf("history: %+v", history)
	}
	w = request("/api/history?branch=" + url.QueryEscape("other"))
	if err := json.Unmarshal(w.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Commits) != 1 {
		t.Fatalf("branch history: %s", w.Body.String())
	}
	w = request("/api/commit?hash=" + history.Commits[0].Hash)
	var preview struct{ Diff string }
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview.Diff, "+first") {
		t.Fatalf("root diff: %s", preview.Diff)
	}
	for _, path := range []string{"/api/history?branch=--all", "/api/commit?hash=HEAD", "/api/commit?hash=--help"} {
		if w := request(path); w.Code != 400 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	data, err := git(context.Background(), root, "status", "--porcelain")
	if err != nil || len(data) != 0 {
		t.Fatalf("history modified repository: %s, %v", data, err)
	}
}

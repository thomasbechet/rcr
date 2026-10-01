package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type historyCommit struct {
	Hash    string `json:"hash"`
	Parents string `json:"parents"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
	Refs    string `json:"refs"`
}

func (a *app) history(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	data, err := git(ctx, a.root, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	branches := []string{}
	for _, branch := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if branch != "" {
			branches = append(branches, branch)
		}
	}
	branch := r.URL.Query().Get("branch")
	ref := "HEAD"
	if branch != "" {
		found := false
		for _, name := range branches {
			if name == branch {
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "unknown branch", http.StatusBadRequest)
			return
		}
		ref = branch
	}
	commits := []historyCommit{}
	// Unborn repositories have no HEAD yet.
	if _, err := git(ctx, a.root, "rev-parse", "--verify", "HEAD"); err == nil {
		data, err = git(ctx, a.root, "log", "-100", "--date=iso-strict", "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00", "--end-of-options", ref, "--")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		fields := strings.Split(string(data), "\x00")
		for i := 0; i+5 < len(fields); i += 6 {
			commits = append(commits, historyCommit{strings.TrimSpace(fields[i]), fields[i+1], fields[i+2], fields[i+3], fields[i+4], fields[i+5]})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Branches []string        `json:"branches"`
		Commits  []historyCommit `json:"commits"`
	}{branches, commits})
}

var commitHash = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

func (a *app) commit(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if !commitHash.MatchString(hash) {
		http.Error(w, "invalid commit hash", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	data, err := git(ctx, a.root, "show", "--format=fuller", "--stat", "--patch", "--root", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Diff string `json:"diff"`
	}{strings.ToValidUTF8(string(data), "�")})
}

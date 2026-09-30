package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type filePreview struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Notice  string `json:"notice,omitempty"`
}

// Use Git's inventory instead of exposing arbitrary files or Git metadata.
func repositoryFiles(ctx context.Context, root string) ([]string, error) {
	data, err := git(ctx, root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	seen := make(map[string]bool)
	files := []string{}
	for _, name := range strings.Split(string(data), "\x00") {
		if validFilePath(name) && !seen[name] {
			seen[name] = true
			// The index retains unstaged deletions. Only list paths on disk,
			// using Lstat so dangling symbolic links remain browseable.
			if _, err := dir.Lstat(name); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				return nil, err
			}
			files = append(files, name)
		}
	}
	if len(files) > 20000 {
		return nil, errors.New("repository file list exceeds 20,000 files")
	}
	sort.Strings(files)
	return files, nil
}

func validFilePath(name string) bool {
	if name == "" || !fs.ValidPath(name) || strings.ContainsRune(name, 0) {
		return false
	}
	if os.PathSeparator == '\\' && strings.ContainsRune(name, '\\') {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.EqualFold(part, ".git") {
			return false
		}
	}
	return true
}

func readPreview(root, name string) (filePreview, error) {
	p := filePreview{Path: name}
	if !validFilePath(name) {
		return p, fs.ErrPermission
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return p, err
	}
	defer dir.Close()
	// Do not traverse directory symlinks, even when they point within the root.
	for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
		info, err := dir.Lstat(parent)
		if err != nil {
			return p, err
		}
		if !info.IsDir() {
			return p, fs.ErrPermission
		}
	}
	info, err := dir.Lstat(name)
	if err != nil {
		return p, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := dir.Readlink(name)
		p.Content, p.Notice = target, "Symbolic link target (not followed)"
		return p, err
	}
	if !info.Mode().IsRegular() {
		p.Notice = "Non-regular file; preview unavailable"
		return p, nil
	}
	f, err := dir.Open(name)
	if err != nil {
		return p, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxOutput+1))
	if err != nil {
		return p, err
	}
	if len(data) > maxOutput {
		p.Notice = "File exceeds 4 MiB preview limit"
		return p, nil
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		p.Notice = "Binary file; preview unavailable"
		return p, nil
	}
	p.Content = string(data)
	if len(data) == 0 {
		p.Notice = "Empty file"
	}
	return p, nil
}

func (a *app) fileList(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	files, err := repositoryFiles(ctx, a.root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

func (a *app) fileContent(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("path")
	if !validFilePath(name) {
		http.Error(w, "invalid repository path", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	files, err := repositoryFiles(ctx, a.root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	i := sort.SearchStrings(files, name)
	if i == len(files) || files[i] != name {
		http.Error(w, "file is not in the repository inventory", http.StatusNotFound)
		return
	}
	p, err := readPreview(a.root, name)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, fs.ErrNotExist) {
			status = http.StatusNotFound
		}
		if errors.Is(err, fs.ErrPermission) {
			status = http.StatusForbidden
		}
		http.Error(w, "file is unavailable or cannot be safely read", status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(p)
}

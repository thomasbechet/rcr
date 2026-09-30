package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed web/*
var assets embed.FS

const maxOutput = 4 << 20

type change struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
	Section string `json:"section"`
	Diff    string `json:"diff"`
	Notice  string `json:"notice,omitempty"`
}

type snapshot struct {
	Repository string    `json:"repository"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Changes    []change  `json:"changes"`
}

type cappedBuffer struct{ data []byte }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > maxOutput {
		return 0, fmt.Errorf("Git output exceeds %d MiB limit", maxOutput>>20)
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func git(ctx context.Context, root string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-pager", "--literal-pathspecs", "-c", "core.quotePath=true"}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	var out, stderr cappedBuffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(stderr.data)))
	}
	return out.data, nil
}

func parseNames(data []byte, section string) ([]change, error) {
	var changes []change
	parts := strings.Split(string(data), "\x00")
	for i := 0; i < len(parts)-1; {
		status := parts[i]
		i++
		if status == "" || i >= len(parts)-1 {
			return nil, errors.New("invalid Git name-status output")
		}
		c := change{Status: status[:1], Section: section, Path: parts[i]}
		i++
		if c.Status == "R" || c.Status == "C" {
			if i >= len(parts)-1 {
				return nil, errors.New("invalid Git rename output")
			}
			c.OldPath, c.Path = c.Path, parts[i]
			i++
		}
		changes = append(changes, c)
	}
	return changes, nil
}

func collect(ctx context.Context, root string) (snapshot, error) {
	s := snapshot{Repository: root, Changes: []change{}}
	for _, section := range []string{"unstaged", "staged"} {
		args := []string{"diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z"}
		if section == "staged" {
			args = append(args, "--cached")
		}
		data, err := git(ctx, root, args...)
		if err != nil {
			return s, err
		}
		changes, err := parseNames(data, section)
		if err != nil {
			return s, err
		}
		s.Changes = append(s.Changes, changes...)
	}
	data, err := git(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return s, err
	}
	for _, path := range strings.Split(string(data), "\x00") {
		if path != "" {
			s.Changes = append(s.Changes, change{Path: path, Status: "?", Section: "untracked"})
		}
	}
	if len(s.Changes) > 500 {
		return s, errors.New("more than 500 changed files; narrow the changes before refreshing")
	}
	total := 0
	for i := range s.Changes {
		c := &s.Changes[i]
		if c.Section == "untracked" {
			c.Diff, c.Notice = untrackedDiff(root, c.Path)
		} else {
			args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3"}
			if c.Section == "staged" {
				args = append(args, "--cached")
			}
			args = append(args, "--", c.Path)
			if c.OldPath != "" {
				args = append(args, c.OldPath)
			}
			data, err := git(ctx, root, args...)
			if err != nil {
				return s, err
			}
			c.Diff = strings.ToValidUTF8(string(data), "�")
			if strings.Contains(c.Diff, "\nBinary files ") {
				c.Notice = "Binary file changed"
			}
		}
		total += len(c.Diff)
		if total > 16<<20 {
			return s, errors.New("diff snapshot exceeds 16 MiB limit")
		}
	}
	s.UpdatedAt = time.Now()
	return s, nil
}

func untrackedDiff(root, path string) (string, string) {
	full := filepath.Join(root, path)
	info, err := os.Lstat(full)
	if err != nil {
		return "", err.Error()
	}
	var data []byte
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(full)
		if err != nil {
			return "", err.Error()
		}
		data = []byte(target)
	} else {
		if !info.Mode().IsRegular() {
			return "", "Non-regular file; preview unavailable"
		}
		f, err := os.Open(full)
		if err != nil {
			return "", err.Error()
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, maxOutput+1))
		if err != nil {
			return "", err.Error()
		}
	}
	if len(data) > maxOutput {
		return "", "File exceeds 4 MiB preview limit"
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return "", "Binary file; preview unavailable"
	}
	if len(data) == 0 {
		return "", "Empty file"
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	var out strings.Builder
	fmt.Fprintf(&out, "--- /dev/null\n+++ %s\n@@ -0,0 +1,%d @@\n", strconv.Quote("b/"+path), len(lines))
	for _, line := range lines {
		out.WriteString("+" + line + "\n")
	}
	if data[len(data)-1] != '\n' {
		out.WriteString("\\ No newline at end of file\n")
	}
	return out.String(), ""
}

type app struct {
	root      string
	mu        sync.RWMutex
	refreshMu sync.Mutex
	current   snapshot
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	for path, method := range map[string]string{"/api/diffs": "GET", "/api/refresh": "POST", "/api/files": "GET", "/api/file": "GET"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", method)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		})
	}
	mux.HandleFunc("GET /api/files", a.fileList)
	mux.HandleFunc("GET /api/file", a.fileContent)
	mux.HandleFunc("GET /api/diffs", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		defer a.mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(a.current)
	})
	mux.HandleFunc("POST /api/refresh", func(w http.ResponseWriter, r *http.Request) {
		// A custom header prevents cross-origin form submissions. No CORS is enabled.
		if r.Header.Get("X-RCR-Refresh") != "1" {
			http.Error(w, "missing refresh header", http.StatusForbidden)
			return
		}
		if !a.refreshMu.TryLock() {
			http.Error(w, "refresh already in progress", http.StatusConflict)
			return
		}
		defer a.refreshMu.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		s, err := collect(ctx, a.root)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		a.mu.Lock()
		a.current = s
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s)
	})
	web, _ := fs.Sub(assets, "web")
	mux.Handle("/", http.FileServer(http.FS(web)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		mux.ServeHTTP(w, r)
	})
}

func run() error {
	flags := flag.NewFlagSet("rcr", flag.ContinueOnError)
	listen := flags.String("listen", "127.0.0.1", "listen address (non-loopback exposes source code without authentication)")
	flags.Usage = func() { fmt.Fprintln(flags.Output(), "Usage: rcr [--listen address] <port>"); flags.PrintDefaults() }
	if err := flags.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 1 {
		flags.Usage()
		return errors.New("exactly one port is required")
	}
	port, err := strconv.Atoi(flags.Arg(0))
	if err != nil || port < 1 || port > 65535 {
		return errors.New("port must be an integer between 1 and 65535")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	data, err := git(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("run RCR inside a Git working tree (Git must be installed): %w", err)
	}
	root := strings.TrimSuffix(string(data), "\n")
	s, err := collect(ctx, root)
	if err != nil {
		return err
	}
	a := &app{root: root, current: s}
	address := net.JoinHostPort(*listen, strconv.Itoa(port))
	ln, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(*listen)
	if *listen != "localhost" && (ip == nil || !ip.IsLoopback()) {
		log.Print("WARNING: source code is exposed without authentication; use only on a trusted network")
	}
	log.Printf("RCR: http://%s — %s", address, root)
	server := &http.Server{Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 40 * time.Second, IdleTimeout: 60 * time.Second}
	stop, stopCancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopCancel()
	go func() {
		<-stop.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

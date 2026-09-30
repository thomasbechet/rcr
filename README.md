# RCR

A read-only web viewer for local Git changes. One executable, embedded web UI, no configuration files or frontend dependencies. Git must be installed on the machine running RCR.

## Build and run

```sh
go build -o rcr .
cd /path/to/your/repository
/path/to/rcr 8080
```

Open `http://127.0.0.1:8080`. RCR discovers the repository from its working directory (including when started in a subdirectory) and shows repository-wide unstaged, staged, and untracked changes. Ignored files are excluded. **Refresh** collects a new snapshot; there is no polling. Failed refreshes preserve the previous snapshot.

## Remote access

Run RCR on the remote machine, then forward its port from your local machine:

```sh
ssh -L 8080:127.0.0.1:8080 user@remote-host
```

For a trusted network only, opt into direct access:

```sh
rcr --listen 0.0.0.0 8080
```

**There is no authentication or TLS. Direct access exposes source code and repository paths.** Prefer an SSH tunnel. Flags go before the port. Ctrl+C stops the server.

## Behavior and limits

- Added, modified, deleted, renamed, mode-changed, and untracked files; unified diffs with line numbers.
- Binary files receive a notice. Untracked symbolic links show their target, not the target file's contents.
- Git external diff helpers and text conversion are disabled. RCR does not stage, commit, or edit files.
- Up to 500 changes, 4 MiB per Git command or untracked preview, 16 MiB total diff text, and 30 seconds per refresh. Oversized untracked files show a notice; exceeding other limits reports an error.
- Git commands collect changes sequentially. Avoid editing while refreshing if you need a consistent snapshot.
- Commit history, branch comparisons, and comments are outside the current scope.

## Test

```sh
go test -race ./...
go vet ./...
```

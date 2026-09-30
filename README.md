# RCR

A read-only web viewer for local Git changes. One executable, embedded web UI, no configuration files or frontend dependencies. Git must be installed on the machine running RCR.

## Build and run

```sh
go build -o rcr .
cd /path/to/your/repository
/path/to/rcr 8080
```

Open `http://127.0.0.1:8080`. RCR discovers the repository from its working directory (including when started in a subdirectory) and shows repository-wide unstaged, staged, and untracked changes. Ignored files are excluded. **Refresh** collects a new snapshot; there is no polling. Failed refreshes preserve the previous snapshot.

Click a file in the changed-file list to view its diff. Only the selected diff is displayed, and its sidebar entry is highlighted. Refresh keeps the selection and updates its diff; if the change disappears, select another file. Staged and unstaged changes for the same path are separate selections.

Switch to **Files** to browse expandable folders and view current file contents with line numbers, including unchanged tracked files and non-ignored untracked files. Click **Changes** to return to diffs. File contents are read on selection; **Refresh** also reloads the file tree and selected preview. Deleted tracked files remain listed but cannot be opened. Ignored untracked files and Git metadata are not exposed.

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
- The file browser supports up to 20,000 inventory entries and 4 MiB per preview. Binary and oversized files show a notice. Symbolic links show their target path only; directory symlinks are not traversed. File previews are confined to the repository.
- Git commands collect changes sequentially. Avoid editing while refreshing if you need a consistent snapshot.
- Commit history, branch comparisons, and comments are outside the current scope.

## Test

```sh
go test -race ./...
go vet ./...
node --test web_test.cjs # Optional UI behavior tests; Node is not needed to build or run RCR.
```

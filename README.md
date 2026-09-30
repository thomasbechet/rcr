# RCR

A read-only web viewer for local Git changes. One executable, embedded web UI, no configuration files or frontend dependencies. Git must be installed on the machine running RCR.

## Build and run

```sh
go build -o rcr .
cd /path/to/your/repository
/path/to/rcr localhost:8080
```

Open `http://localhost:8080`. Pass exactly one `hostname:port` argument. IPv4 (`127.0.0.1:8080`) and bracketed IPv6 (`[::1]:8080`) are also supported; ports must be between 1 and 65535. The previous port-only and `--listen` syntax is no longer supported. RCR discovers the repository from its working directory (including when started in a subdirectory) and shows repository-wide unstaged, staged, and untracked changes. Ignored files are excluded. **Refresh** collects a new snapshot; there is no polling. Failed refreshes preserve the previous snapshot.

Click a file in the changed-file list to view its diff. Only the selected diff is displayed, and its sidebar entry is highlighted. Refresh keeps the selection and updates its diff; if the change disappears, select another file. Staged and unstaged changes for the same path are separate selections.

Click **Open in Files** in a diff heading to view the file's current contents in the Files tab. Its parent folders expand and its tree entry is selected and brought into view. Returning to Changes keeps your diff selection. Files no longer on disk show an unavailable notice instead; their diffs remain in Changes.

Click a file path in a diff or file-preview heading to copy its repository-relative path. In a file preview, tap the first line number, then long-press the last line number for half a second to select the range and tap **Copy lines**. Moving your finger cancels the long-press so scrolling still works. On desktop, Shift-click another line number also selects a range. Line-number buttons work with Enter/Space (hold Shift to extend). Copying preserves source indentation and line endings, without line numbers or highlighting markup. Touch code rows stay compact with 22-pixel line spacing and a wider line-number gutter.

Each changed file shows green **+added** and red **−deleted** line totals in the sidebar and diff heading. Counts exclude diff metadata and context lines; binary and metadata-only changes show zero textual changes.

The compact header stays visible while the file list and content pane scroll independently. Long repository paths are shortened visually; hover to see the full path. On narrow screens the header uses two rows.

On narrow screens and touch-enabled devices, folder and file rows use compact 36-pixel tap targets, with 32-pixel-high navigation and viewer buttons. Tap anywhere on a folder row to expand or collapse it. Indentation guides clarify nested folders, and the phone layout gives the independently scrollable tree up to 40% of the screen height. Mouse-only desktop layouts remain unchanged.

Switch to **Files** to browse expandable folders and view current file contents with line numbers, including unchanged tracked files and non-ignored untracked files. Click **Changes** to return to diffs. File contents are read on selection; **Refresh** also reloads the file tree and selected preview. Paths removed from disk are excluded from Files; their deletion diffs remain available in Changes. Ignored untracked files and Git metadata are not exposed.

File previews include lightweight syntax highlighting for Go, Zig, JavaScript/TypeScript (including JSX/TSX), Python, Rust, C/C++, Java, C#, Ruby, shell scripts, SQL, JSON, YAML, CSS/SCSS/Less, and HTML/XML/SVG. Languages are selected by file extension; Python and shell shebangs are also recognized. Other files remain plain text. Highlighting is lexical, not a full parser; embedded languages and template expressions are not highlighted separately.

Files previews also mark added lines in green and modified lines in amber, using the latest change snapshot. A red line-number gutter marker shows where lines were deleted; hover or focus a line-number button for change details. Staged changes are translated through unstaged edits to align with current file contents. Use **Refresh** after editing to update these markers. Selecting lines temporarily replaces the row background but retains gutter change markers.

## Remote access

Run `rcr 127.0.0.1:8080` on the remote machine, then forward its port from your local machine:

```sh
ssh -L 8080:127.0.0.1:8080 user@remote-host
```

For a trusted network only, opt into direct access:

```sh
rcr 0.0.0.0:8080
```

**There is no authentication or TLS. Direct access exposes source code and repository paths.** Prefer an SSH tunnel and bind to `localhost` or a loopback IP. Ctrl+C stops the server. Use `rcr --help` for usage.

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

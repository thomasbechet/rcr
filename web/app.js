'use strict';

const $ = id => document.getElementById(id);
const labels = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked' };
const statuses = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'New' };
let currentSnapshot = null;
let view = 'changes';
let selectedPath = null;
let selectedChange = null;
let fileRequest = 0;
let treeRequest = 0;
const openFolders = new Set();
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function diffStats(text) {
  let added = 0, deleted = 0, inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) inHunk = true;
    else if (inHunk && line.startsWith('+')) added++;
    else if (inHunk && line.startsWith('-')) deleted++;
  }
  return { added, deleted };
}

function changeStats(change) {
  const { added, deleted } = diffStats(change.diff);
  const stats = element('span', 'diff-stats');
  stats.title = `${added} added lines, ${deleted} deleted lines`;
  stats.setAttribute('aria-label', stats.title);
  stats.append(element('span', 'stat-added', `+${added}`), element('span', 'stat-deleted', `−${deleted}`));
  return stats;
}

function renderPatch(text) {
  const table = element('table', 'patch');
  const body = document.createElement('tbody');
  table.append(body);
  let oldLine = null, newLine = null;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    let kind = 'meta', old = '', next = '';
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); kind = 'hunk';
    } else if (oldLine !== null && line.startsWith('+')) {
      kind = 'addition'; next = newLine++;
    } else if (oldLine !== null && line.startsWith('-')) {
      kind = 'deletion'; old = oldLine++;
    } else if (oldLine !== null && line.startsWith(' ')) {
      kind = 'context'; old = oldLine++; next = newLine++;
    }
    const row = element('tr', kind);
    row.append(element('td', 'number', old), element('td', 'number', next), element('td', 'code', line));
    body.append(row);
  }
  return table;
}

function render(data) {
  currentSnapshot = data;
  $('repository').textContent = data.repository;
  $('updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
  $('summary').textContent = `${data.changes.length} changed file${data.changes.length === 1 ? '' : 's'}`;
  if (view !== 'changes') return;
  $('files').replaceChildren(); $('diffs').replaceChildren();
  if (!data.changes.length) {
    $('diffs').append(element('div', 'empty', 'Working tree is clean. Refresh to check for changes.'));
    selectedChange = null;
    return;
  }
  let selection = null;
  for (const [section, label] of Object.entries(labels)) {
    const changes = data.changes.filter(c => c.section === section);
    if (!changes.length) continue;
    $('files').append(element('h2', '', `${label} · ${changes.length}`));
    for (const change of changes) {
      const key = JSON.stringify([change.section, change.path]);
      const link = element('button', 'file-link'); link.type = 'button'; link.dataset.change = key;
      link.append(element('span', `badge status-${change.status}`, change.status), element('span', 'path', change.path), changeStats(change));
      link.title = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      link.addEventListener('click', () => showChange(change));
      $('files').append(link);
      if (key === selectedChange) selection = change;
    }
  }
  if (selection) showChange(selection);
  else {
    selectedChange = null;
    $('diffs').append(element('div', 'empty', 'Select a changed file to view its diff.'));
  }
}

function showChange(change) {
  selectedChange = JSON.stringify([change.section, change.path]);
  for (const link of $('files').querySelectorAll('.file-link')) {
    if (link.dataset.change === selectedChange) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
  const panel = element('article', 'file');
  const heading = element('h2', 'viewer-heading');
  heading.append(element('span', `badge status-${change.status}`, `${labels[change.section]} · ${statuses[change.status] || change.status}`), element('span', 'path', change.oldPath ? `${change.oldPath} → ${change.path}` : change.path), changeStats(change));
  panel.append(heading);
  if (change.notice) panel.append(element('p', 'notice', change.notice));
  if (change.diff) {
    const scroll = element('div', 'patch-scroll'); scroll.append(renderPatch(change.diff)); panel.append(scroll);
  } else if (!change.notice) panel.append(element('p', 'notice', 'No textual changes (file mode or metadata changed).'));
  $('diffs').replaceChildren(panel);
}

async function requestJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function markSelectedFile() {
  for (const button of $('files').querySelectorAll('.tree-file')) {
    if (button.dataset.path === selectedPath) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function renderTree(paths) {
  const root = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ name: parts.at(-1), path });
  }
  function children(node, container, prefix) {
    for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name + '/';
      const details = element('details', 'tree-folder');
      const summary = element('summary', 'path', name + '/');
      const contents = element('div', 'tree-children');
      details.append(summary, contents);
      let populated = false;
      function populate() {
        if (!populated) { children(folder, contents, path); populated = true; markSelectedFile(); }
      }
      details.addEventListener('toggle', () => {
        if (details.open) { openFolders.add(path); populate(); }
        else openFolders.delete(path);
      });
      if (openFolders.has(path)) { details.open = true; populate(); }
      container.append(details);
    }
    for (const file of node.files) {
      const button = element('button', 'tree-file path', file.name);
      button.type = 'button'; button.dataset.path = file.path; button.title = file.path;
      button.addEventListener('click', () => showFile(file.path));
      container.append(button);
    }
  }
  $('files').replaceChildren(element('h2', '', `Repository · ${paths.length}`));
  children(root, $('files'), '');
  markSelectedFile();
}

async function showFile(path) {
  selectedPath = path;
  markSelectedFile();
  const request = ++fileRequest;
  $('diffs').setAttribute('aria-busy', 'true');
  $('diffs').replaceChildren(element('p', 'notice', `Loading ${path}…`));
  try {
    const file = await requestJSON('/api/file?path=' + encodeURIComponent(path));
    if (request !== fileRequest || view !== 'files') return;
    const panel = element('article', 'file');
    panel.append(element('h2', 'viewer-heading path', file.path));
    if (file.notice) panel.append(element('p', 'notice', file.notice));
    if (file.content) {
      const scroll = element('div', 'patch-scroll');
      const table = element('table', 'patch source');
      const body = element('tbody');
      const lines = file.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      lines.forEach((line, index) => {
        const row = element('tr');
        row.append(element('td', 'number', index + 1), element('td', 'code', line));
        body.append(row);
      });
      table.append(body); scroll.append(table); panel.append(scroll);
    }
    $('diffs').replaceChildren(panel);
  } catch (err) {
    if (request === fileRequest && view === 'files') $('diffs').replaceChildren(element('p', 'notice', `Could not open ${path}: ${err.message}`));
  } finally {
    if (request === fileRequest) $('diffs').setAttribute('aria-busy', 'false');
  }
}

async function loadFiles() {
  const request = ++treeRequest;
  try {
    const paths = await requestJSON('/api/files');
    if (request !== treeRequest || view !== 'files') return;
    renderTree(paths);
    if (selectedPath && paths.includes(selectedPath)) await showFile(selectedPath);
    else {
      selectedPath = null;
      ++fileRequest;
      $('diffs').setAttribute('aria-busy', 'false');
      $('diffs').replaceChildren(element('div', 'empty', paths.length ? 'Select a file to view its current contents.' : 'No repository files.'));
    }
  } catch (err) {
    if (request === treeRequest && view === 'files') {
      $('files').replaceChildren(element('p', 'notice', `Could not list files: ${err.message}`));
    }
  }
}

function setView(next) {
  if (view === next) return;
  view = next; ++fileRequest; ++treeRequest;
  $('diffs').setAttribute('aria-busy', 'false');
  $('changes-view').setAttribute('aria-pressed', String(view === 'changes'));
  $('files-view').setAttribute('aria-pressed', String(view === 'files'));
  $('files').setAttribute('aria-label', view === 'changes' ? 'Changed files' : 'Repository files');
  $('diffs').setAttribute('aria-label', view === 'changes' ? 'Diffs' : 'File contents');
  if (view === 'changes') { if (currentSnapshot) render(currentSnapshot); }
  else {
    $('files').replaceChildren(element('p', 'notice', 'Loading files…'));
    $('diffs').replaceChildren(element('div', 'empty', 'Select a file to view its current contents.'));
    loadFiles();
  }
}

async function load(refresh = false) {
  $('refresh').disabled = true;
  $('refresh').textContent = refresh ? 'Refreshing…' : 'Loading…';
  $('error').hidden = true;
  try {
    const response = await fetch(refresh ? '/api/refresh' : '/api/diffs', refresh ? { method: 'POST', headers: { 'X-RCR-Refresh': '1' } } : {});
    if (!response.ok) throw new Error(await response.text());
    render(await response.json());
    if (view === 'files') await loadFiles();
  } catch (err) {
    $('error').textContent = `Could not load changes: ${err.message}`; $('error').hidden = false;
    if (!$('diffs').childElementCount) $('summary').textContent = 'Changes unavailable';
  } finally {
    $('refresh').disabled = false; $('refresh').textContent = '↻ Refresh';
  }
}
$('refresh').addEventListener('click', () => load(true));
$('changes-view').addEventListener('click', () => setView('changes'));
$('files-view').addEventListener('click', () => setView('files'));
load();

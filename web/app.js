'use strict';

const $ = id => document.getElementById(id);
const labels = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked' };
let currentSnapshot = null;
let view = 'changes';
let selectedPath = null;
let selectedChange = null;
let fileRequest = 0;
let treeRequest = 0;
let codeFontSize = 12;
const minCodeFontSize = 3, maxCodeFontSize = 24;
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
  return lineStats(diffStats(change.diff));
}

function lineStats({ added, deleted }) {
  const stats = element('span', 'diff-stats');
  stats.title = `${added} added lines, ${deleted} deleted lines`;
  stats.setAttribute('aria-label', stats.title);
  stats.append(element('span', 'stat-added', `+${added}`), element('span', 'stat-deleted', `−${deleted}`));
  return stats;
}

async function writeClipboard(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* Plain HTTP and denied permissions may need the legacy API. */ }
  }
  const active = document.activeElement;
  const selection = globalThis.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const buffer = element('textarea', 'clipboard-buffer');
  buffer.value = text; buffer.setAttribute('readonly', '');
  document.body.append(buffer);
  try {
    buffer.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard access is unavailable');
  } finally {
    buffer.remove();
    active?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

async function copyText(text, feedback) {
  feedback.textContent = '';
  try { await writeClipboard(text); feedback.textContent = ''; }
  catch { feedback.textContent = 'Could not copy. Select the text and copy manually.'; }
}

function copyFeedback() {
  const feedback = element('span', 'copy-feedback');
  feedback.setAttribute('role', 'status');
  return feedback;
}

function copyPathButton(path, feedback, label = path) {
  const button = element('button', 'path copy-path', label);
  button.type = 'button'; button.title = `Copy repository-relative path: ${path}`;
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', () => copyText(path, feedback));
  return button;
}

function updateCodeZoom() {
  for (const table of $('diffs').querySelectorAll('.patch')) table.style.fontSize = `${codeFontSize}px`;
  for (const button of $('diffs').querySelectorAll('.zoom-reset')) {
    const percent = Math.round(codeFontSize / 12 * 100);
    button.textContent = `${percent}%`;
    button.setAttribute('aria-label', `Code zoom ${percent}%; reset to 100%`);
  }
}

function setCodeZoom(size) {
  codeFontSize = Math.max(minCodeFontSize, Math.min(maxCodeFontSize, Math.round(size)));
  updateCodeZoom();
}

function codeScroll() {
  const scroll = element('div', 'patch-scroll');
  let wheelDelta = 0, pinch = null;
  scroll.addEventListener('wheel', event => {
    if (!event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    wheelDelta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    const steps = Math.trunc(wheelDelta / 40);
    if (steps) { wheelDelta -= steps * 40; setCodeZoom(codeFontSize - steps); }
  }, { passive: false });
  function distance(touches) {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  }
  scroll.addEventListener('touchstart', event => {
    wheelDelta = 0;
    if (event.touches.length > 1) scroll.cancelLinePress?.();
    if (event.touches.length !== 2) { pinch = null; return; }
    event.preventDefault();
    const gap = distance(event.touches);
    pinch = gap > 0 ? { gap, size: codeFontSize } : null;
  }, { passive: false });
  scroll.addEventListener('touchmove', event => {
    if (event.touches.length !== 2) { pinch = null; return; }
    event.preventDefault();
    if (pinch) setCodeZoom(pinch.size * distance(event.touches) / pinch.gap);
  }, { passive: false });
  for (const name of ['touchend', 'touchcancel']) scroll.addEventListener(name, () => { pinch = null; });
  return scroll;
}

function codeZoomControls() {
  const controls = element('span', 'code-zoom');
  controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Code zoom');
  const reset = element('button', 'zoom-reset', '100%');
  reset.type = 'button'; reset.title = 'Reset code zoom to 100%';
  reset.setAttribute('aria-label', reset.title);
  reset.addEventListener('click', () => setCodeZoom(12));
  controls.append(reset);
  return controls;
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
  $('repository').title = data.repository;
  $('updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
  const totals = { added: 0, deleted: 0 };
  for (const change of data.changes) {
    const stats = diffStats(change.diff);
    totals.added += stats.added;
    totals.deleted += stats.deleted;
  }
  $('summary').replaceChildren(
    element('span', '', `${data.changes.length} changed file${data.changes.length === 1 ? '' : 's'}`),
    lineStats(totals),
  );
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
  const feedback = copyFeedback();
  heading.append(copyPathButton(change.path, feedback, change.oldPath ? `${change.oldPath} → ${change.path}` : change.path), changeStats(change));
  const open = element('button', 'open-in-files', 'Open in Files');
  open.type = 'button'; open.title = `View current contents of ${change.path}`;
  open.addEventListener('click', () => openInFiles(change.path));
  heading.append(open, feedback);
  panel.append(heading);
  if (change.notice) panel.append(element('p', 'notice', change.notice));
  if (change.diff) {
    heading.append(codeZoomControls());
    const scroll = codeScroll(); scroll.append(renderPatch(change.diff)); panel.append(scroll);
  } else if (!change.notice) panel.append(element('p', 'notice', 'No textual changes (file mode or metadata changed).'));
  $('diffs').replaceChildren(panel);
  updateCodeZoom();
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
  const changes = new Map();
  for (const change of currentSnapshot?.changes || []) {
    const kind = change.status === 'A' || change.status === '?' ? 'added' : 'modified';
    // A newly staged file remains added even if it also has unstaged edits.
    if (changes.get(change.path) !== 'added') changes.set(change.path, kind);
  }
  const root = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    const kind = changes.get(path);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
      if (kind && node.kind !== 'modified') node.kind = kind;
    }
    node.files.push({ name: parts.at(-1), path, kind });
  }
  function children(node, container, prefix) {
    for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name + '/';
      const details = element('details', 'tree-folder');
      const summary = element('summary', 'path' + (folder.kind ? ` tree-${folder.kind}` : ''), name + '/');
      summary.title = path + (folder.kind ? ` — Contains ${folder.kind} files` : '');
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
      const button = element('button', 'tree-file path' + (file.kind ? ` tree-${file.kind}` : ''), file.name);
      button.type = 'button'; button.dataset.path = file.path;
      button.title = file.path + (file.kind ? ` — ${file.kind === 'added' ? 'Added' : 'Modified'}` : '');
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
    const heading = element('h2', 'viewer-heading');
    const feedback = copyFeedback();
    heading.append(copyPathButton(file.path, feedback));
    panel.append(heading);
    if (file.notice) panel.append(element('p', 'notice', file.notice));
    if (!file.content) {
      const changed = sourceLineChanges(currentSnapshot?.changes || [], file.path, 0);
      const removed = [...changed.deletions.values()].reduce((total, count) => total + count, 0);
      if (removed) panel.append(element('p', 'notice', `${removed} line${removed === 1 ? '' : 's'} deleted; no remaining lines to mark.`));
    }
    if (file.content) {
      heading.append(codeZoomControls());
      const scroll = codeScroll();
      const table = element('table', 'patch source');
      const body = element('tbody');
      const lines = sourceTokenLines(file.content, file.path);
      const changed = sourceLineChanges(currentSnapshot?.changes || [], file.path, lines.length);
      const rawLines = file.content.split('\n');
      const copy = element('button', 'copy-lines', 'Copy lines');
      copy.type = 'button'; copy.disabled = true;
      copy.title = 'Select line numbers, then copy their source text';
      heading.append(copy);
      let anchor = null, start = null, end = null;
      const rows = [], selectors = [], rowKinds = [];
      function selectLine(index, extend) {
        if (anchor === null || !extend) anchor = index;
        start = Math.min(anchor, index); end = Math.max(anchor, index);
        rows.forEach((row, i) => {
          const selected = i >= start && i <= end;
          row.className = [rowKinds[i], selected ? 'line-selected' : ''].filter(Boolean).join(' ');
          selectors[i].setAttribute('aria-pressed', String(selected));
        });
        copy.disabled = false;
        copy.textContent = start === end ? `Copy line ${start + 1}` : `Copy lines ${start + 1}–${end + 1}`;
        feedback.textContent = '';
      }
      copy.addEventListener('click', () => {
        if (start === null) return;
        // Preserve source whitespace and the selected final line's terminator.
        const text = rawLines.slice(start, end + 1).join('\n') + (end < rawLines.length - 1 ? '\n' : '');
        copyText(text, feedback);
      });
      lines.forEach((line, index) => {
        const kind = changed.lines.get(index);
        const rowKind = kind ? `source-${kind}` : '';
        const row = element('tr', rowKind);
        rowKinds.push(rowKind);
        const number = element('td', 'number');
        const selector = element('button', 'line-number', index + 1);
        selector.type = 'button'; selector.title = `Select line ${index + 1} (long-press or Shift-click to extend)`;
        if (kind) { selector.className += ` source-${kind}`; selector.title += ` — ${kind === 'added' ? 'Added' : 'Modified'} line`; }
        const deletedBefore = changed.deletions.get(index) || 0;
        const deletedAfter = index === lines.length - 1 ? changed.deletions.get(lines.length) || 0 : 0;
        if (deletedBefore) {
          selector.className += ' source-deleted';
          selector.title += ` — ${deletedBefore} deleted line(s) before this line`;
        }
        if (deletedAfter) {
          selector.className += ' source-deleted-after';
          selector.title += ` — ${deletedAfter} deleted line(s) after this line`;
        }
        selector.setAttribute('aria-label', selector.title); selector.setAttribute('aria-pressed', 'false');
        let press = null, timer = null, suppressClick = false;
        function cancelPress() {
          if (timer !== null) clearTimeout(timer);
          timer = null; press = null;
          if (scroll.cancelLinePress === cancelPress) scroll.cancelLinePress = null;
        }
        selector.addEventListener('pointerdown', event => {
          cancelPress(); suppressClick = false;
          if (!['touch', 'pen'].includes(event.pointerType) || event.isPrimary === false || event.button > 0) return;
          press = { id: event.pointerId, x: event.clientX, y: event.clientY };
          scroll.cancelLinePress = cancelPress;
          timer = setTimeout(() => {
            timer = null;
            if (request !== fileRequest || view !== 'files') { cancelPress(); return; }
            suppressClick = true;
            selectLine(index, true);
          }, 500);
        });
        selector.addEventListener('pointermove', event => {
          if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
        });
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) selector.addEventListener(name, cancelPress);
        // Suppress the native touch menu only in the gutter; source text still
        // supports ordinary browser text selection and scrolling.
        selector.addEventListener('contextmenu', event => {
          if (press || suppressClick) event.preventDefault();
        });
        selector.addEventListener('click', event => {
          if (suppressClick) { suppressClick = false; event?.preventDefault(); return; }
          selectLine(index, Boolean(event?.shiftKey));
        });
        // Native keyboard activation does not consistently preserve Shift.
        selector.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectLine(index, event.shiftKey); }
        });
        number.append(selector); rows.push(row); selectors.push(selector);
        const code = element('td', 'code');
        if (line.some(token => token.kind)) {
          for (const token of line) code.append(element('span', token.kind ? `syntax-${token.kind}` : '', token.text));
        } else code.textContent = line.map(token => token.text).join('');
        row.append(number, code);
        body.append(row);
      });
      table.append(body); scroll.append(table); panel.append(scroll);
    }
    heading.append(feedback);
    $('diffs').replaceChildren(panel);
    updateCodeZoom();
  } catch (err) {
    if (request === fileRequest && view === 'files') $('diffs').replaceChildren(element('p', 'notice', `Could not open ${path}: ${err.message}`));
  } finally {
    if (request === fileRequest) $('diffs').setAttribute('aria-busy', 'false');
  }
}

function openInFiles(path) {
  selectedPath = path;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) openFolders.add(parts.slice(0, i).join('/') + '/');
  setView('files', path);
}

async function loadFiles(revealPath = null) {
  const request = ++treeRequest;
  try {
    const paths = await requestJSON('/api/files');
    if (request !== treeRequest || view !== 'files') return;
    renderTree(paths);
    if (revealPath) {
      const button = [...$('files').querySelectorAll('.tree-file')].find(node => node.dataset.path === revealPath);
      if (button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest' }); }
    }
    if (selectedPath && paths.includes(selectedPath)) await showFile(selectedPath);
    else {
      selectedPath = null;
      ++fileRequest;
      $('diffs').setAttribute('aria-busy', 'false');
      $('diffs').replaceChildren(element('div', 'empty', revealPath ? `${revealPath} is no longer available in the repository file list. Its diff is still available in Changes.` : paths.length ? 'Select a file to view its current contents.' : 'No repository files.'));
    }
  } catch (err) {
    if (request === treeRequest && view === 'files') {
      $('files').replaceChildren(element('p', 'notice', `Could not list files: ${err.message}`));
    }
  }
}

function setView(next, revealPath = null) {
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
    loadFiles(revealPath);
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

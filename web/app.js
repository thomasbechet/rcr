'use strict';

const $ = id => document.getElementById(id);
const labels = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked' };
const statuses = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'New' };
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  $('repository').textContent = data.repository;
  $('updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
  $('summary').textContent = `${data.changes.length} changed file${data.changes.length === 1 ? '' : 's'}`;
  $('files').replaceChildren(); $('diffs').replaceChildren();
  if (!data.changes.length) {
    $('diffs').append(element('div', 'empty', 'Working tree is clean. Refresh to check for changes.'));
    return;
  }
  let index = 0;
  for (const [section, label] of Object.entries(labels)) {
    const changes = data.changes.filter(c => c.section === section);
    if (!changes.length) continue;
    $('files').append(element('h2', '', `${label} · ${changes.length}`));
    $('diffs').append(element('h2', 'section-heading', label));
    for (const change of changes) {
      const id = `file-${index++}`;
      const link = element('a', 'file-link'); link.href = `#${id}`;
      link.append(element('span', `badge status-${change.status}`, change.status), element('span', 'path', change.path));
      link.title = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      link.addEventListener('click', () => { document.getElementById(id).open = true; });
      $('files').append(link);
      const details = element('details', 'file'); details.id = id; details.open = true;
      const summary = element('summary');
      summary.append(element('span', `badge status-${change.status}`, statuses[change.status] || change.status), element('span', 'path', change.oldPath ? `${change.oldPath} → ${change.path}` : change.path));
      details.append(summary);
      if (change.notice) details.append(element('p', 'notice', change.notice));
      if (change.diff) {
        const scroll = element('div', 'patch-scroll'); scroll.append(renderPatch(change.diff)); details.append(scroll);
      } else if (!change.notice) details.append(element('p', 'notice', 'No textual changes (file mode or metadata changed).'));
      $('diffs').append(details);
    }
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
  } catch (err) {
    $('error').textContent = `Could not load changes: ${err.message}`; $('error').hidden = false;
    if (!$('diffs').childElementCount) $('summary').textContent = 'Changes unavailable';
  } finally {
    $('refresh').disabled = false; $('refresh').textContent = '↻ Refresh';
  }
}
$('refresh').addEventListener('click', () => load(true));
load();

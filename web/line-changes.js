'use strict';

// Zero-based edit blocks allow staged line positions to be translated through
// unstaged edits before decorating the current (working-tree) source.
function sourceEdits(diff) {
  const edits = [];
  let oldLine = null, newLine = null, block = null;
  function flush() { if (block) edits.push(block); block = null; }
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]) - (hunk[2] === '0' ? 0 : 1);
      newLine = Number(hunk[3]) - (hunk[4] === '0' ? 0 : 1);
    } else if (line.startsWith('diff --git ')) {
      flush(); oldLine = null; newLine = null;
    } else if (oldLine !== null && (line.startsWith('+') || line.startsWith('-'))) {
      if (!block) block = { oldStart: oldLine, newStart: newLine, removed: 0, added: 0 };
      if (line.startsWith('-')) { block.removed++; oldLine++; }
      else { block.added++; newLine++; }
    } else if (oldLine !== null && line.startsWith(' ')) {
      flush(); oldLine++; newLine++;
    }
  }
  flush();
  return edits;
}

function translateSourceLine(line, edits, boundary = false) {
  let shift = 0;
  for (const edit of edits) {
    if (line < edit.oldStart) break;
    if (line < edit.oldStart + edit.removed) return boundary ? edit.newStart : null;
    shift += edit.added - edit.removed;
  }
  return line + shift;
}

function sourceLineChanges(changes, path, lineCount) {
  const matching = changes.filter(change => change.path === path);
  const lines = new Map(), deletions = new Map();
  if (matching.some(change => change.status === 'A' || change.status === '?')) {
    for (let i = 0; i < lineCount; i++) lines.set(i, 'added');
    return { lines, deletions };
  }
  const staged = matching.filter(change => change.section === 'staged').flatMap(change => sourceEdits(change.diff || ''));
  const unstaged = matching.filter(change => change.section === 'unstaged').flatMap(change => sourceEdits(change.diff || ''));
  const stagedLines = new Map();
  function decorate(edits, target) {
    for (const edit of edits) {
      for (let i = 0; i < edit.added; i++) target.set(edit.newStart + i, i < edit.removed ? 'modified' : 'added');
    }
  }
  decorate(staged, stagedLines);
  for (const [line, kind] of stagedLines) {
    const current = translateSourceLine(line, unstaged);
    if (current !== null && current >= 0 && current < lineCount) lines.set(current, kind);
  }
  decorate(unstaged, lines);
  // Edits to a newly inserted staged line are still additions relative to HEAD.
  for (const edit of unstaged) {
    for (let i = 0; i < Math.min(edit.added, edit.removed); i++) {
      if (stagedLines.get(edit.oldStart + i) === 'added') lines.set(edit.newStart + i, 'added');
    }
  }
  function markDeletion(edit, translate) {
    const count = edit.removed - edit.added;
    if (count <= 0) return;
    const boundary = edit.newStart + edit.added;
    const current = translate ? translateSourceLine(boundary, unstaged, true) : boundary;
    if (current >= 0) deletions.set(current, (deletions.get(current) || 0) + count);
  }
  for (const edit of staged) markDeletion(edit, true);
  for (const edit of unstaged) markDeletion(edit, false);
  return { lines, deletions };
}

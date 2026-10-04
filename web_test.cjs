// Dependency-free UI behavior tests. Run with: node --test web_test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.listeners = {}; this.textContent = ''; this.className = '';
    this.style = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrolledIntoView = options; }
  get childElementCount() { return this.children.length; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.className.split(' ').includes(selector.slice(1))) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(changes = []) {
  const nodes = new Map();
  const snapshot = { repository: '/repo', updatedAt: new Date().toISOString(), changes };
  const paths = ['unchanged.txt', 'src/new + #.js'];
  const calls = [];
  const copied = [];
  const context = vm.createContext({
    setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
      createElement(tag) { return new Node(tag); },
    },
    fetch: async url => {
      calls.push(url);
      let data = snapshot;
      if (url === '/api/files') data = paths;
      if (url.startsWith('/api/file?')) data = { path: new URL('http://rcr' + url).searchParams.get('path'), content: '<script>safe text</script>\nsecond line\n' };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(fs.readFileSync('web/syntax.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/line-changes.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8'), context);
  return { nodes, context, calls, snapshot, paths, copied };
}

test('code view stays hidden without a selection and closing a diff clears selection', async () => {
  const { nodes } = setup([
    { path: 'first.txt', section: 'unstaged', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  await tick();
  assert.equal(nodes.get('code-view').hidden, true);
  assert.equal(nodes.get('workspace').dataset.codeOpen, 'false');
  const link = nodes.get('files').querySelectorAll('.file-link')[0];
  link.listeners.click();
  assert.equal(nodes.get('code-view').hidden, false);
  nodes.get('close-code').listeners.click();
  assert.equal(nodes.get('code-view').hidden, true);
  assert.equal(nodes.get('workspace').dataset.codeOpen, 'false');
  assert.equal(link.attributes['aria-current'], undefined);
  assert.equal(link.focused, true);
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(nodes.get('code-view').hidden, true);
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  assert.equal(nodes.get('code-view').hidden, false);
});

test('closing a loading file cancels its preview and preserves the expanded tree', async () => {
  const { nodes, context } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  assert.equal(nodes.get('code-view').hidden, true);
  const folder = nodes.get('files').querySelectorAll('.tree-folder')[0];
  folder.open = true; folder.listeners.toggle();
  const button = nodes.get('files').querySelectorAll('.tree-file').find(node => node.dataset.path === 'src/new + #.js');
  let resolve;
  const fetch = context.fetch;
  context.fetch = () => new Promise(done => { resolve = done; });
  button.listeners.click();
  assert.equal(nodes.get('code-view').hidden, false);
  nodes.get('close-code').listeners.click();
  resolve({ ok: true, json: async () => ({ path: button.dataset.path, content: 'late content' }) });
  await tick();
  assert.equal(nodes.get('code-view').hidden, true);
  assert.equal(nodes.get('diffs').childElementCount, 0);
  assert.equal(nodes.get('diffs').attributes['aria-busy'], 'false');
  assert.equal(button.attributes['aria-current'], undefined);
  assert.equal(button.focused, true);
  assert.equal(folder.open, true);
  context.fetch = fetch;
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(nodes.get('code-view').hidden, true);
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  assert.equal(nodes.get('code-view').hidden, false);
});

test('browse folders and unchanged files, then return to diffs', async () => {
  const { nodes, calls } = setup();
  await tick();
  assert.match(nodes.get('diffs').children[0].textContent, /clean/);
  nodes.get('files-view').listeners.click();
  await tick();
  assert.equal(nodes.get('files-view').attributes['aria-pressed'], 'true');
  let buttons = nodes.get('files').querySelectorAll('.tree-file');
  assert.equal(buttons.length, 1); // Folder children are populated lazily.
  buttons[0].listeners.click();
  await tick();
  assert.equal(buttons[0].attributes['aria-current'], 'true');
  const table = nodes.get('diffs').children[0].children[1].children[0];
  assert.equal(table.children[0].children.length, 2);
  assert.equal(table.children[0].children[0].children[1].textContent, '<script>safe text</script>');
  const folder = nodes.get('files').querySelectorAll('.tree-folder')[0];
  folder.open = true; folder.listeners.toggle();
  buttons = nodes.get('files').querySelectorAll('.tree-file');
  const nested = buttons.find(node => node.dataset.path === 'src/new + #.js');
  nested.listeners.click();
  await tick();
  assert.ok(calls.includes('/api/file?path=src%2Fnew%20%2B%20%23.js'));
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('changes-view').attributes['aria-pressed'], 'true');
  assert.match(nodes.get('diffs').children[0].textContent, /clean/);
});

test('late file responses cannot overwrite the diff view', async () => {
  const { nodes, context } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  nodes.get('changes-view').listeners.click();
  resolve({ ok: true, json: async () => ({ path: 'unchanged.txt', content: 'late content' }) });
  await tick();
  assert.match(nodes.get('diffs').children[0].textContent, /clean/);
  assert.equal(nodes.get('diffs').attributes['aria-busy'], 'false');
});

test('file tree colors added and modified files and collapsed parent folders', async () => {
  const { nodes, paths } = setup([
    { path: 'src/new + #.js', section: 'unstaged', status: 'M', diff: '' },
    { path: 'src/new + #.js', section: 'staged', status: 'A', diff: '' },
    { path: 'src/nested/edited.js', section: 'staged', status: 'M', diff: '' },
    { path: 'new/file.txt', section: 'untracked', status: '?', diff: '' },
  ]);
  paths.push('src/nested/edited.js', 'new/file.txt');
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  const folders = nodes.get('files').querySelectorAll('.tree-folder');
  const addedFolder = folders.find(folder => folder.children[0].textContent === 'new/');
  const mixedFolder = folders.find(folder => folder.children[0].textContent === 'src/');
  assert.match(addedFolder.children[0].className, /tree-added/);
  assert.match(mixedFolder.children[0].className, /tree-modified/);
  for (const folder of folders) { folder.open = true; folder.listeners.toggle(); }
  const nested = nodes.get('files').querySelectorAll('.tree-folder').find(folder => folder.children[0].textContent === 'nested/');
  assert.match(nested.children[0].className, /tree-modified/);
  nested.open = true; nested.listeners.toggle();
  const buttons = nodes.get('files').querySelectorAll('.tree-file');
  assert.equal(buttons.find(button => button.dataset.path === 'unchanged.txt').className, 'tree-file path');
  for (const path of ['src/new + #.js', 'new/file.txt']) {
    const button = buttons.find(button => button.dataset.path === path);
    assert.match(button.className, /tree-added/);
    assert.match(button.title, /Added/);
  }
  const modified = buttons.find(button => button.dataset.path === 'src/nested/edited.js');
  assert.match(modified.className, /tree-modified/);
  assert.match(modified.title, /Modified/);
  modified.listeners.click();
  await tick();
  assert.equal(modified.attributes['aria-current'], 'true');
  assert.match(modified.className, /tree-modified/);
});

test('refresh updates tree colors without losing expanded folders or selection', async () => {
  const { nodes, snapshot } = setup([
    { path: 'src/new + #.js', section: 'untracked', status: '?', diff: '' },
  ]);
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  const folder = nodes.get('files').querySelectorAll('.tree-folder')[0];
  folder.open = true; folder.listeners.toggle();
  nodes.get('files').querySelectorAll('.tree-added').find(node => node.tag === 'button').listeners.click();
  await tick();
  snapshot.changes[0].status = 'M';
  snapshot.changes[0].section = 'unstaged';
  nodes.get('refresh').listeners.click();
  await tick();
  let button = nodes.get('files').querySelectorAll('.tree-file').find(node => node.dataset.path === 'src/new + #.js');
  assert.match(button.className, /tree-modified/);
  assert.equal(button.attributes['aria-current'], 'true');
  assert.equal(nodes.get('files').querySelectorAll('.tree-folder')[0].open, true);
  snapshot.changes.length = 0;
  nodes.get('refresh').listeners.click();
  await tick();
  button = nodes.get('files').querySelectorAll('.tree-file').find(node => node.dataset.path === 'src/new + #.js');
  assert.equal(button.className, 'tree-file path');
  assert.equal(nodes.get('files').querySelectorAll('.tree-folder')[0].children[0].className, 'path');
});

test('refresh reloads the file tree and selected preview', async () => {
  const { nodes, calls } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  calls.length = 0;
  nodes.get('refresh').listeners.click();
  await tick();
  assert.deepEqual(calls, ['/api/refresh', '/api/files', '/api/file?path=unchanged.txt']);
  assert.equal(nodes.get('files-view').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('refresh').disabled, false);
});

test('refresh removes a deleted file and clears its selected preview', async () => {
  const { nodes, calls, paths } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  paths.shift();
  calls.length = 0;
  nodes.get('refresh').listeners.click();
  await tick();
  assert.deepEqual(calls, ['/api/refresh', '/api/files']);
  assert.equal(nodes.get('files').querySelectorAll('.tree-file').length, 0);
  assert.match(nodes.get('diffs').children[0].textContent, /Select a file/);
  assert.equal(nodes.get('diffs').attributes['aria-busy'], 'false');
});

test('only the selected diff is displayed and highlighted', async () => {
  const { nodes } = setup([
    { path: 'first.txt', section: 'unstaged', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new\n' },
    { path: 'second.txt', section: 'untracked', status: '?', diff: '@@ -0,0 +1 @@\n+hello\n' },
  ]);
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.file').length, 0);
  assert.match(nodes.get('diffs').children[0].textContent, /Select a changed file/);
  const links = nodes.get('files').querySelectorAll('.file-link');
  assert.equal(links[0].querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(links[0].querySelectorAll('.stat-deleted')[0].textContent, '−1');
  assert.equal(links[1].querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(links[1].querySelectorAll('.stat-deleted')[0].textContent, '−0');
  links[1].listeners.click();
  let panels = nodes.get('diffs').querySelectorAll('.file');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].querySelectorAll('.copy-path')[0].textContent, 'second.txt');
  assert.equal(panels[0].children[0].querySelectorAll('.badge').length, 0);
  assert.equal(panels[0].children[0].querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(links[1].attributes['aria-current'], 'true');
  assert.equal(links[0].attributes['aria-current'], undefined);
  links[0].listeners.click();
  panels = nodes.get('diffs').querySelectorAll('.file');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].querySelectorAll('.copy-path')[0].textContent, 'first.txt');
  assert.equal(links[0].attributes['aria-current'], 'true');
  assert.equal(links[1].attributes['aria-current'], undefined);
  assert.equal(nodes.has('collapse-all'), false);
});

test('Open in Files reveals a nested renamed file and preserves the selected diff', async () => {
  const path = 'src/nested/new + #.go';
  const { nodes, calls, paths } = setup([
    { path, oldPath: 'old.go', section: 'staged', status: 'R', diff: '' },
  ]);
  paths.push(path);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  const open = nodes.get('diffs').querySelectorAll('.open-in-files')[0];
  assert.equal(open.textContent, 'Open in Files');
  calls.length = 0;
  open.listeners.click();
  await tick();
  assert.equal(nodes.get('files-view').attributes['aria-pressed'], 'true');
  assert.deepEqual(calls, ['/api/files', '/api/file?path=src%2Fnested%2Fnew%20%2B%20%23.go']);
  assert.ok(nodes.get('files').querySelectorAll('.tree-folder').every(folder => folder.open));
  const selected = nodes.get('files').querySelectorAll('.tree-file').find(button => button.dataset.path === path);
  assert.equal(selected.attributes['aria-current'], 'true');
  assert.equal(selected.focused, true);
  assert.equal(selected.scrolledIntoView.block, 'nearest');
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-path')[0].textContent, path);
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[0].attributes['aria-current'], 'true');
  assert.match(nodes.get('diffs').querySelectorAll('.copy-path')[0].textContent, /old.go →/);
});

test('Open in Files supports unstaged, staged, and untracked changes', async () => {
  for (const [section, status] of [['unstaged', 'M'], ['staged', 'A'], ['untracked', '?']]) {
    const { nodes, calls } = setup([{ path: 'unchanged.txt', section, status, diff: '' }]);
    await tick();
    nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
    nodes.get('diffs').querySelectorAll('.open-in-files')[0].listeners.click();
    await tick();
    assert.ok(calls.includes('/api/file?path=unchanged.txt'));
    assert.equal(nodes.get('files').querySelectorAll('.tree-file')[0].attributes['aria-current'], 'true');
  }
});

test('Open in Files explains unavailable files without requesting a missing preview', async () => {
  const { nodes, calls } = setup([{ path: 'deleted.txt', section: 'unstaged', status: 'D', diff: '-gone\n' }]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  calls.length = 0;
  nodes.get('diffs').querySelectorAll('.open-in-files')[0].listeners.click();
  await tick();
  assert.deepEqual(calls, ['/api/files']);
  assert.match(nodes.get('diffs').children[0].textContent, /deleted.txt is no longer available/);
  assert.equal(nodes.get('diffs').attributes['aria-busy'], 'false');
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[0].attributes['aria-current'], 'true');
});

test('returning to Changes while navigation loads ignores the late tree response', async () => {
  const { nodes, context } = setup([{ path: 'unchanged.txt', section: 'unstaged', status: 'M', diff: '' }]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  nodes.get('diffs').querySelectorAll('.open-in-files')[0].listeners.click();
  nodes.get('changes-view').listeners.click();
  resolve({ ok: true, json: async () => ['unchanged.txt'] });
  await tick();
  assert.equal(nodes.get('changes-view').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('files').querySelectorAll('.tree-file').length, 0);
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[0].attributes['aria-current'], 'true');
});

test('line totals count hunk content, not headers or context', async () => {
  const { context } = setup();
  await tick();
  const cases = [
    ['', 0, 0],
    ['diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n', 0, 0],
    ['diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n', 0, 0],
    ['--- a/file\n+++ b/file\n@@ -1,3 +1,3 @@\n context\n---actual deletion\n+++actual addition\n unchanged\n@@ -10 +10,2 @@\n-old\n+new\n+extra\n\\ No newline at end of file\n', 3, 2],
    ['--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+one\n+two\n', 2, 0],
  ];
  for (const [patch, added, deleted] of cases) {
    context.patch = patch;
    const result = vm.runInContext('diffStats(patch)', context);
    assert.equal(result.added, added);
    assert.equal(result.deleted, deleted);
  }
});

test('header totals aggregate all change sections and update in both views', async () => {
  const { nodes, snapshot } = setup([
    { path: 'same.txt', section: 'staged', status: 'M', diff: '--- a/same.txt\n+++ b/same.txt\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n' },
    { path: 'same.txt', section: 'unstaged', status: 'M', diff: '@@ -1,2 +1 @@\n-new\n-extra\n+working\n' },
    { path: 'new.txt', section: 'untracked', status: '?', diff: '@@ -0,0 +1 @@\n+hello\n' },
    { path: 'binary', section: 'staged', status: 'M', diff: 'Binary files a/binary and b/binary differ\n' },
  ]);
  await tick();
  const summary = nodes.get('summary');
  assert.equal(summary.children[0].textContent, '4 changed files');
  assert.equal(summary.querySelectorAll('.stat-added')[0].textContent, '+4');
  assert.equal(summary.querySelectorAll('.stat-deleted')[0].textContent, '−3');
  assert.equal(summary.children[1].attributes['aria-label'], '4 added lines, 3 deleted lines');
  nodes.get('files-view').listeners.click();
  await tick();
  snapshot.changes.splice(0, snapshot.changes.length, { path: 'new.txt', section: 'untracked', status: '?', diff: '@@ -0,0 +1 @@\n+hello\n' });
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(summary.children[0].textContent, '1 changed file');
  assert.equal(summary.querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(summary.querySelectorAll('.stat-deleted')[0].textContent, '−0');
  snapshot.changes.length = 0;
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(summary.children[0].textContent, '0 changed files');
  assert.equal(summary.querySelectorAll('.stat-added')[0].textContent, '+0');
  assert.equal(summary.querySelectorAll('.stat-deleted')[0].textContent, '−0');
});

test('refresh preserves the selected section and clears vanished changes', async () => {
  const { nodes, snapshot } = setup([
    { path: 'same.txt', section: 'unstaged', status: 'M', diff: '+working tree\n' },
    { path: 'same.txt', section: 'staged', status: 'M', diff: '+index\n' },
  ]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[1].listeners.click();
  snapshot.changes[1].diff = '+updated index\n';
  nodes.get('refresh').listeners.click();
  await tick();
  const panel = nodes.get('diffs').querySelectorAll('.file')[0];
  assert.equal(panel.querySelectorAll('.copy-path')[0].textContent, 'same.txt');
  assert.equal(panel.children[0].querySelectorAll('.badge').length, 0);
  assert.equal(panel.children[1].children[0].children[0].children[0].children[2].textContent, '+updated index');
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[1].attributes['aria-current'], 'true');
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('diffs').querySelectorAll('.file').length, 1);
  snapshot.changes.pop();
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.file').length, 0);
  assert.match(nodes.get('diffs').children[0].textContent, /Select a changed file/);
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[0].attributes['aria-current'], undefined);
});

test('Go and Zig source lexers preserve text and highlight language tokens', async () => {
  const { context } = setup();
  await tick();
  const cases = [
    {
      path: 'main.go',
      content: 'package main\n/* func\nvar */\nfunc main() {\n\ts := `first\n<script>second</script>`\n\tprintln("hello\\\"world", 0xff, 1.5e-2, true) // comment\n}\n',
      expected: { package: 'keyword', func: 'keyword', println: 'builtin', '0xff': 'number', '1.5e-2': 'number', true: 'literal', '/* func\nvar */': 'comment', '`first\n<script>second</script>`': 'string', '"hello\\\"world"': 'string' },
    },
    {
      path: 'main.zig',
      content: 'const std = @import("std");\npub fn main() void {\n\tconst value: u32 = 0xff; // comment\n\tconst text =\n\t  \\\\<script>first</script>\n\t  \\\\second\n\t;\n\t_ = @as(f64, 1.5e-2);\n}\n',
      expected: { const: 'keyword', pub: 'keyword', fn: 'keyword', void: 'type', u32: 'type', f64: 'type', '@import': 'builtin', '@as': 'builtin', '"std"': 'string', '0xff': 'number', '1.5e-2': 'number', '\\\\<script>first</script>': 'string' },
    },
  ];
  for (const { path, content, expected } of cases) {
    context.sourcePath = path; context.sourceContent = content;
    const tokens = vm.runInContext('sourceTokens(sourceContent, sourcePath)', context);
    assert.equal(tokens.map(token => token.text).join(''), content);
    for (const [text, kind] of Object.entries(expected)) {
      assert.equal(tokens.find(token => token.text === text)?.kind, kind, text);
    }
    const lines = vm.runInContext('sourceTokenLines(sourceContent, sourcePath)', context);
    assert.equal(lines.map(line => line.map(token => token.text).join('')).join('\n') + '\n', content);
    assert.equal(lines.length, content.split('\n').length - 1);
  }
});

test('unsupported files stay plain and incomplete multiline tokens retain their contents', async () => {
  const { context } = setup();
  await tick();
  context.sourceContent = 'const x = "<script>";\n';
  let tokens = vm.runInContext('sourceTokens(sourceContent, "notes.txt")', context);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].kind, '');
  for (const content of ['/* unfinished\ncomment', '`unfinished\nstring']) {
    context.sourceContent = content;
    tokens = vm.runInContext('sourceTokens(sourceContent, "main.go")', context);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].text, content);
    assert.equal(tokens[0].kind, content.startsWith('/*') ? 'comment' : 'string');
  }
});

test('file previews render highlighted source safely with unchanged line numbers', async () => {
  const { nodes, context } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: 'package main\nvar s = `<script>\nunsafe</script>`\n' }) });
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const rows = nodes.get('diffs').querySelectorAll('.source')[0].children[0].children;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.children[0].children[0].textContent), [1, 2, 3]);
  assert.equal(rows[0].querySelectorAll('.syntax-keyword')[0].textContent, 'package');
  assert.equal(rows[1].querySelectorAll('.syntax-string')[0].textContent, '`<script>');
  assert.equal(rows[2].querySelectorAll('.syntax-string')[0].textContent, 'unsafe</script>`');
  assert.ok(rows.every(row => row.children[1].children.every(node => node.tag === 'span')));
});

test('common languages highlight their comments, strings, keywords, and builtins', async () => {
  const { context } = setup();
  await tick();
  const cases = [
    ['app.js', 'export const x = `hello\nworld`; // note\nconsole.log(true);', { export: 'keyword', '`hello\nworld`': 'string', '// note': 'comment', console: 'builtin', true: 'literal' }],
    ['app.tsx', 'interface User { name: string }\nconst view = "<script>";', { interface: 'keyword', string: 'type', '"<script>"': 'string' }],
    ['app.py', 'def greet():\n  text = f"""hello\nworld""" # note\n  print(True)', { def: 'keyword', 'f"""hello\nworld"""': 'string', '# note': 'comment', print: 'builtin', True: 'literal' }],
    ['app.rs', 'fn main() { let x: u32 = 42; println!(r##"a "quote""##); } // note', { fn: 'keyword', u32: 'type', '42': 'number', 'println!': 'builtin', 'r##"a "quote""##': 'string', '// note': 'comment' }],
    ['app.cpp', '#include <stdio.h>\nint main() { return 0; } /* note\nend */', { '#include': 'builtin', int: 'type', return: 'keyword', '/* note\nend */': 'comment' }],
    ['App.java', 'public class App { boolean ok = true; String s = "hello"; }', { public: 'keyword', class: 'keyword', boolean: 'type', true: 'literal', '"hello"': 'string' }],
    ['App.cs', 'namespace App { public string Name = null; }', { namespace: 'keyword', public: 'keyword', string: 'type', null: 'literal' }],
    ['app.rb', 'def hello\n  puts "hi" # note\nend', { def: 'keyword', puts: 'builtin', '"hi"': 'string', '# note': 'comment', end: 'keyword' }],
    ['app.sh', '#!/bin/sh\nif test "$HOME"; then echo ${USER}; fi # note', { if: 'keyword', test: 'builtin', '"$HOME"': 'string', '${USER}': 'builtin', '# note': 'comment' }],
    ['query.sql', "SELECT * FROM users WHERE name = 'it''s safe' AND active = TRUE; -- note", { SELECT: 'keyword', FROM: 'keyword', "'it''s safe'": 'string', TRUE: 'literal', '-- note': 'comment' }],
    ['data.json', '{"name": "<script>", "active": true, "count": 42}', { '"name"': 'property', '"<script>"': 'string', true: 'literal', '42': 'number' }],
    ['data.yml', 'name: "hello"\nactive: true # note', { name: 'property', '"hello"': 'string', true: 'literal', '# note': 'comment' }],
    ['app.css', '/* note */\nbody { color: #80d5a1; content: "hello"; }', { '/* note */': 'comment', color: 'property', '#80d5a1': 'literal', '"hello"': 'string' }],
    ['page.html', '<!-- note\nend --><div class="hello">&amp;</div>', { '<!-- note\nend -->': 'comment', '<div': 'keyword', class: 'property', '"hello"': 'string', '&amp;': 'literal' }],
  ];
  for (const [path, content, expected] of cases) {
    context.sourcePath = path; context.sourceContent = content;
    const tokens = vm.runInContext('sourceTokens(sourceContent, sourcePath)', context);
    assert.equal(tokens.map(token => token.text).join(''), content, path);
    for (const [text, kind] of Object.entries(expected)) {
      assert.equal(tokens.find(token => token.text === text)?.kind, kind, `${path}: ${text}`);
    }
    const lines = vm.runInContext('sourceTokenLines(sourceContent, sourcePath)', context);
    assert.equal(lines.map(line => line.map(token => token.text).join('')).join('\n'), content, path);
  }
});

test('language aliases, uppercase extensions, and script shebangs select a lexer', async () => {
  const { context } = setup();
  await tick();
  const cases = [
    ['app.MJS', 'const'], ['app.cjs', 'const'], ['app.jsx', 'const'], ['app.mts', 'const'], ['app.cts', 'const'],
    ['app.pyw', 'def'], ['app.c', 'return'], ['app.h', 'return'], ['app.hpp', 'return'], ['app.cc', 'return'], ['app.cxx', 'return'],
    ['app.rake', 'def'], ['app.bash', 'if'], ['app.zsh', 'if'], ['app.jsonc', 'true'], ['app.yaml', 'true'],
    ['app.scss', '@media'], ['app.less', '@media'], ['app.htm', '<div'], ['app.xml', '<node'], ['app.svg', '<svg'],
    ['bin/script', '#!/usr/bin/env python3\ndef'], ['bin/script', '#!/usr/bin/env bash\nif'],
  ];
  for (const [path, content] of cases) {
    context.sourcePath = path; context.sourceContent = content;
    const tokens = vm.runInContext('sourceTokens(sourceContent, sourcePath)', context);
    assert.ok(tokens.some(token => token.kind), path);
    assert.equal(tokens.map(token => token.text).join(''), content, path);
  }
  // Object prototype names are not language registrations.
  context.sourceContent = 'plain text';
  const tokens = vm.runInContext('sourceTokens(sourceContent, "file.constructor")', context);
  assert.equal(tokens[0].kind, '');
});

test('header paths copy repository-relative paths in both views, including rename destinations', async () => {
  const { nodes, copied } = setup([
    { path: 'src/new + #.js', oldPath: 'old.js', section: 'staged', status: 'R', diff: '' },
  ]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  const path = nodes.get('diffs').querySelectorAll('.copy-path')[0];
  assert.equal(path.textContent, 'old.js → src/new + #.js');
  await path.listeners.click();
  assert.deepEqual(copied, ['src/new + #.js']);
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-feedback')[0].textContent, '');
  nodes.get('diffs').querySelectorAll('.open-in-files')[0].listeners.click();
  await tick();
  await nodes.get('diffs').querySelectorAll('.copy-path')[0].listeners.click();
  assert.deepEqual(copied, ['src/new + #.js', 'src/new + #.js']);
});

test('line selection copies exact source text, supports reverse ranges, and resets per file', async () => {
  const { nodes, context, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: 'package main\r\n\tvar s = "<script>"\r\n\r\nlast' }) });
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  const rows = nodes.get('diffs').querySelectorAll('.source')[0].children[0].children;
  const copy = nodes.get('diffs').querySelectorAll('.copy-lines')[0];
  assert.equal(copy.disabled, true);
  selectors[1].listeners.click({ shiftKey: false });
  assert.equal(selectors[1].attributes['aria-pressed'], 'true');
  assert.equal(rows[1].className, 'line-selected');
  assert.equal(copy.textContent, 'Copy line 2');
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), '\tvar s = "<script>"\r\n');
  selectors[3].listeners.click({ shiftKey: false });
  selectors[1].listeners.click({ shiftKey: true });
  assert.equal(copy.textContent, 'Copy lines 2–4');
  assert.deepEqual(selectors.map(selector => selector.attributes['aria-pressed']), ['false', 'true', 'true', 'true']);
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), '\tvar s = "<script>"\r\n\r\nlast');
  selectors[2].listeners.click();
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), '\r\n');
  assert.deepEqual(selectors.map(selector => selector.attributes['aria-pressed']), ['false', 'false', 'true', 'false']);
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].disabled, true);
  assert.ok(nodes.get('diffs').querySelectorAll('.line-number').every(selector => selector.attributes['aria-pressed'] === 'false'));
});

test('keyboard line selection extends ranges and preserves trailing newlines', async () => {
  const { nodes, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  let prevented = 0;
  selectors[0].listeners.keydown({ key: 'Enter', shiftKey: false, preventDefault() { prevented++; } });
  selectors[1].listeners.keydown({ key: ' ', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  nodes.get('diffs').querySelectorAll('.copy-lines')[0].listeners.click();
  await tick();
  assert.equal(copied.at(-1), '<script>safe text</script>\nsecond line\n');
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-feedback')[0].textContent, '');
});

test('mobile range selection uses long-press without an extra range button', async () => {
  const { nodes, context, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: 'first\n\tsecond\n\nlast' }) });
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  const timers = pressTimers(context);
  assert.equal(nodes.get('diffs').querySelectorAll('.select-range').length, 0);
  const copy = nodes.get('diffs').querySelectorAll('.copy-lines')[0];
  selectors[0].listeners.click();
  selectors[2].listeners.pointerdown(touchDown);
  timers.fire();
  selectors[2].listeners.pointerup();
  assert.equal(copy.textContent, 'Copy lines 1–3');
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), 'first\n\tsecond\n\n');
  selectors[3].listeners.click();
  assert.equal(copy.textContent, 'Copy line 4');
  selectors[1].listeners.pointerdown(touchDown);
  timers.fire();
  selectors[1].listeners.pointerup();
  assert.equal(copy.textContent, 'Copy lines 2–4');
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), '\tsecond\n\nlast');
});

function pressTimers(context) {
  const pending = new Map();
  let id = 0;
  context.setTimeout = (callback, delay) => { assert.equal(delay, 500); pending.set(++id, callback); return id; };
  context.clearTimeout = timer => pending.delete(timer);
  return { pending, fire() { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(); } };
}
const touchDown = { pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 };

test('history lists branches and commits, opens a diff, and ignores late responses', async () => {
  const { nodes, context } = setup();
  await tick();
  const calls = [];
  const commit = { hash: 'a'.repeat(40), subject: '<script>commit</script>', author: 'Test', date: '2026-01-01', parents: '', refs: 'HEAD -> main' };
  context.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => url.startsWith('/api/commit') ? { diff: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n' } : { branches: ['main', 'feature/test'], commits: [commit] } };
  };
  nodes.get('history-view').listeners.click();
  await tick();
  assert.equal(nodes.get('history-view').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('code-view').hidden, true);
  let buttons = nodes.get('files').querySelectorAll('.commit-link');
  assert.equal(buttons[0].children[0].textContent, commit.subject);
  buttons[0].listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(buttons[0].attributes['aria-current'], 'true');
  assert.equal(nodes.get('code-view').hidden, false);
  nodes.get('close-code').listeners.click();
  assert.equal(nodes.get('code-view').hidden, true);
  assert.equal(buttons[0].attributes['aria-current'], undefined);
  assert.equal(buttons[0].focused, true);
  const branch = nodes.get('files').querySelectorAll('.history-branch')[0];
  branch.value = 'feature/test'; branch.listeners.change();
  await tick();
  assert.ok(calls.includes('/api/history?branch=feature%2Ftest'));
  assert.equal(nodes.get('code-view').hidden, true);
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  nodes.get('files').querySelectorAll('.commit-link')[0].listeners.click();
  nodes.get('changes-view').listeners.click();
  resolve({ ok: true, json: async () => ({ diff: '+late' }) });
  await tick();
  assert.match(nodes.get('diffs').children[0].textContent, /clean/);
});

test('long-press selects a range without the release click collapsing it', async () => {
  const { nodes, context, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const timers = pressTimers(context);
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  selectors[0].listeners.click();
  selectors[1].listeners.pointerdown(touchDown);
  timers.fire();
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].textContent, 'Copy lines 1–2');
  let prevented = 0;
  selectors[1].listeners.contextmenu({ preventDefault() { prevented++; } });
  selectors[1].listeners.pointerup();
  selectors[1].listeners.click({ preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].textContent, 'Copy lines 1–2');
  nodes.get('diffs').querySelectorAll('.copy-lines')[0].listeners.click();
  await tick();
  assert.equal(copied.at(-1), '<script>safe text</script>\nsecond line\n');
  // A subsequent ordinary tap selects just one line again.
  selectors[1].listeners.pointerdown(touchDown);
  selectors[1].listeners.pointerup();
  selectors[1].listeners.click();
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].textContent, 'Copy line 2');
  // Reverse ranges also work with pen input.
  selectors[0].listeners.pointerdown({ ...touchDown, pointerType: 'pen' });
  timers.fire();
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].textContent, 'Copy lines 1–2');
  selectors[0].listeners.pointerup();
});

test('desktop long-click extends ranges and suppresses the release click', async () => {
  const { nodes, context, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const timers = pressTimers(context);
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  const mouseDown = { ...touchDown, pointerType: 'mouse' };
  selectors[0].listeners.click();
  selectors[1].listeners.pointerdown(mouseDown);
  timers.fire();
  selectors[1].listeners.pointerup();
  selectors[1].listeners.click({ preventDefault() {} });
  const copy = nodes.get('diffs').querySelectorAll('.copy-lines')[0];
  assert.equal(copy.textContent, 'Copy lines 1–2');
  copy.listeners.click();
  await tick();
  assert.equal(copied.at(-1), '<script>safe text</script>\nsecond line\n');
  selectors[1].listeners.pointerdown(mouseDown);
  selectors[1].listeners.pointerup();
  assert.equal(timers.pending.size, 0);
  selectors[1].listeners.click();
  assert.equal(copy.textContent, 'Copy line 2');
  selectors[0].listeners.pointerdown(mouseDown);
  timers.fire();
  selectors[0].listeners.pointerup();
  selectors[0].listeners.click({ preventDefault() {} });
  assert.equal(copy.textContent, 'Copy lines 1–2');
});

test('long-press cancels on scrolling, early release, pointer cancellation, and navigation', async () => {
  const { nodes, context } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const timers = pressTimers(context);
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  selectors[0].listeners.click();
  for (const name of ['pointermove', 'pointerup', 'pointercancel', 'pointerleave']) {
    selectors[1].listeners.pointerdown(touchDown);
    selectors[1].listeners[name]({ ...touchDown, clientY: 40 });
    assert.equal(timers.pending.size, 0, name);
    timers.fire();
    assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines')[0].textContent, 'Copy line 1');
  }
  for (const event of [{ ...touchDown, pointerType: 'mouse', button: 2 }, { ...touchDown, pointerType: 'mouse', button: 1 }, { ...touchDown, isPrimary: false }]) {
    selectors[1].listeners.pointerdown(event);
    assert.equal(timers.pending.size, 0);
  }
  selectors[1].listeners.pointerdown(touchDown);
  nodes.get('changes-view').listeners.click();
  timers.fire();
  assert.match(nodes.get('diffs').children[0].textContent, /clean/);
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-lines').length, 0);
});

test('clipboard fallback cleans up and reports success or failure without changing the path', async () => {
  const { nodes, context } = setup([{ path: 'unchanged.txt', section: 'unstaged', status: 'M', diff: '' }]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  const body = new Node('body');
  const buffers = [];
  context.document.body = body;
  const create = context.document.createElement;
  context.document.createElement = tag => {
    const node = create(tag);
    if (tag === 'textarea') {
      buffers.push(node);
      node.select = () => { node.selected = true; };
      node.remove = () => { body.children = body.children.filter(child => child !== node); };
    }
    return node;
  };
  const active = new Node('button');
  context.document.activeElement = active;
  context.navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); };
  context.document.execCommand = command => command === 'copy';
  const path = nodes.get('diffs').querySelectorAll('.copy-path')[0];
  await path.listeners.click();
  assert.equal(buffers[0].value, 'unchanged.txt');
  assert.equal(buffers[0].selected, true);
  assert.equal(body.children.length, 0);
  assert.equal(active.focused, true);
  assert.equal(nodes.get('diffs').querySelectorAll('.copy-feedback')[0].textContent, '');
  context.navigator = undefined; // Non-secure remote HTTP can lack the modern API.
  context.document.execCommand = () => false;
  await path.listeners.click();
  assert.equal(body.children.length, 0);
  assert.equal(path.textContent, 'unchanged.txt');
  assert.match(nodes.get('diffs').querySelectorAll('.copy-feedback')[0].textContent, /Could not copy/);
});

test('source edit blocks distinguish additions, replacements, and deleted boundaries', async () => {
  const { context } = setup();
  await tick();
  context.sourceChanges = [{ path: 'main.go', section: 'unstaged', status: 'M', diff: '--- a/main.go\n+++ b/main.go\n@@ -1,5 +1,5 @@\n keep\n-old\n+new\n+added\n keep\n-removed\n keep\n' }];
  const result = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 5)', context);
  assert.deepEqual(Array.from(result.lines, entry => [...entry]), [[1, 'modified'], [2, 'added']]);
  assert.deepEqual(Array.from(result.deletions, entry => [...entry]), [[4, 1]]);
  context.sourceChanges[0].diff = '@@ -2,2 +1,0 @@\n-last\n-final\n';
  const eof = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 1)', context);
  assert.deepEqual(Array.from(eof.deletions, entry => [...entry]), [[1, 2]]);
});

test('staged highlights move with unstaged edits and removed staged lines disappear', async () => {
  const { context } = setup();
  await tick();
  context.sourceChanges = [
    { path: 'main.go', section: 'staged', status: 'M', diff: '@@ -2,2 +2,3 @@\n-old\n+changed\n+inserted\n keep\n' },
    { path: 'main.go', section: 'unstaged', status: 'M', diff: '@@ -0,0 +1 @@\n+prefix\n@@ -3 +4 @@\n-inserted\n+edited addition\n' },
  ];
  let result = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 6)', context);
  assert.equal(result.lines.get(0), 'added');
  assert.equal(result.lines.get(2), 'modified');
  assert.equal(result.lines.get(3), 'added');
  assert.equal(result.lines.has(4), false);
  context.sourceChanges[1].diff = '@@ -2,2 +1,0 @@\n-changed\n-inserted\n';
  result = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 2)', context);
  assert.equal(result.lines.size, 0);
  assert.deepEqual(Array.from(result.deletions, entry => [...entry]), [[1, 2]]);
});

test('new files mark every current line as added and unrelated files stay unchanged', async () => {
  const { context } = setup();
  await tick();
  for (const status of ['A', '?']) {
    context.sourceChanges = [{ path: 'main.go', section: status === 'A' ? 'staged' : 'untracked', status, diff: '' }];
    const result = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 3)', context);
    assert.deepEqual(Array.from(result.lines, entry => [...entry]), [[0, 'added'], [1, 'added'], [2, 'added']]);
    const other = vm.runInContext('sourceLineChanges(sourceChanges, "other.go", 3)', context);
    assert.equal(other.lines.size, 0);
    assert.equal(other.deletions.size, 0);
  }
});

test('multiple hunks shift staged deletions and metadata-only changes mark no source lines', async () => {
  const { context } = setup();
  await tick();
  context.sourceChanges = [
    { path: 'main.go', section: 'staged', status: 'M', diff: '@@ -2 +1,0 @@\n-deleted\n@@ -8 +7 @@\n-old\n+updated\n\\ No newline at end of file\n' },
    { path: 'main.go', section: 'unstaged', status: 'M', diff: '@@ -0,0 +1,2 @@\n+one\n+two\n' },
  ];
  const result = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 10)', context);
  assert.equal(result.lines.get(8), 'modified');
  assert.equal(result.deletions.get(3), 1);
  for (const diff of ['diff --git a/old.go b/main.go\nsimilarity index 100%\nrename from old.go\nrename to main.go\n', 'Binary files a/main.go and b/main.go differ\n', 'old mode 100644\nnew mode 100755\n']) {
    context.sourceChanges = [{ path: 'main.go', section: 'staged', status: 'R', diff }];
    const metadata = vm.runInContext('sourceLineChanges(sourceChanges, "main.go", 2)', context);
    assert.equal(metadata.lines.size, 0);
    assert.equal(metadata.deletions.size, 0);
  }
});

test('file preview highlights changes while preserving syntax, selection, and copying', async () => {
  const { nodes, context, copied, snapshot } = setup([
    { path: 'main.go', section: 'unstaged', status: 'M', diff: '@@ -1,3 +1,3 @@\n package main\n-var old = 1\n+var next = 2\n+var added = 3\n-removed\n' },
  ]);
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: 'package main\nvar next = 2\nvar added = 3\n' }) });
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const rows = nodes.get('diffs').querySelectorAll('.source')[0].children[0].children;
  assert.equal(rows[0].className, '');
  assert.equal(rows[1].className, 'source-modified');
  assert.equal(rows[2].className, 'source-modified');
  assert.equal(rows[1].querySelectorAll('.syntax-keyword')[0].textContent, 'var');
  const selectors = nodes.get('diffs').querySelectorAll('.line-number');
  selectors[1].listeners.click();
  assert.equal(rows[1].className, 'source-modified line-selected');
  selectors[2].listeners.click({ shiftKey: true });
  nodes.get('diffs').querySelectorAll('.copy-lines')[0].listeners.click();
  await tick();
  assert.equal(copied.at(-1), 'var next = 2\nvar added = 3\n');
  snapshot.changes.length = 0;
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.source-modified').length, 0);
});

test('deletions at EOF get a gutter marker and empty files get a deletion notice', async () => {
  const { nodes, context } = setup([
    { path: 'main.go', section: 'unstaged', status: 'M', diff: '@@ -1,2 +1 @@\n keep\n-deleted\n' },
  ]);
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: 'keep\n' }) });
  const file = nodes.get('files').querySelectorAll('.tree-file')[0];
  file.listeners.click();
  await tick();
  const selector = nodes.get('diffs').querySelectorAll('.source-deleted-after')[0];
  assert.match(selector.title, /1 deleted line\(s\) after/);
  context.fetch = async () => ({ ok: true, json: async () => ({ path: 'main.go', content: '', notice: 'Empty file' }) });
  context.currentChanges = [{ path: 'main.go', section: 'unstaged', status: 'M', diff: '@@ -1,2 +0,0 @@\n-first\n-second\n' }];
  vm.runInContext('currentSnapshot.changes = currentChanges', context);
  file.listeners.click();
  await tick();
  assert.ok(nodes.get('diffs').querySelectorAll('.notice').some(node => /2 lines deleted/.test(node.textContent)));
});

test('code zoom resizes text without rerendering or clearing line selection', async () => {
  const { nodes, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const table = nodes.get('diffs').querySelectorAll('.patch')[0];
  const line = nodes.get('diffs').querySelectorAll('.line-number')[0];
  line.listeners.click();
  assert.equal(table.style.fontSize, '12px');
  nodes.get('diffs').querySelectorAll('.patch-scroll')[0].listeners.wheel({ ctrlKey: true, deltaY: 40, preventDefault() {} });
  assert.equal(table.style.fontSize, '11px');
  assert.equal(nodes.get('diffs').querySelectorAll('.zoom-reset')[0].textContent, '92%');
  assert.equal(nodes.get('diffs').querySelectorAll('.line-number')[0], line);
  assert.equal(line.attributes['aria-pressed'], 'true');
  nodes.get('diffs').querySelectorAll('.copy-lines')[0].listeners.click();
  await tick();
  assert.equal(copied.at(-1), '<script>safe text</script>\n');
});

test('code zoom enforces size limits and can reset to the default', async () => {
  const { nodes } = setup([
    { path: 'unchanged.txt', section: 'unstaged', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  const table = nodes.get('diffs').querySelectorAll('.patch')[0];
  const scroll = nodes.get('diffs').querySelectorAll('.patch-scroll')[0];
  assert.equal(nodes.get('diffs').querySelectorAll('.zoom-out').length, 0);
  assert.equal(nodes.get('diffs').querySelectorAll('.zoom-in').length, 0);
  const reset = nodes.get('diffs').querySelectorAll('.zoom-reset')[0];
  scroll.listeners.wheel({ ctrlKey: true, deltaY: 10000, preventDefault() {} });
  assert.equal(table.style.fontSize, '3px');
  assert.equal(reset.textContent, '25%');
  scroll.listeners.wheel({ ctrlKey: true, deltaY: -10000, preventDefault() {} });
  assert.equal(table.style.fontSize, '24px');
  assert.equal(reset.textContent, '200%');
  reset.listeners.click();
  assert.equal(table.style.fontSize, '12px');
  assert.equal(reset.textContent, '100%');
  assert.equal(reset.attributes['aria-label'], 'Code zoom 100%; reset to 100%');
});

test('zoom survives file navigation, switching views, and refresh', async () => {
  const { nodes } = setup([
    { path: 'unchanged.txt', section: 'unstaged', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  nodes.get('diffs').querySelectorAll('.patch-scroll')[0].listeners.wheel({ ctrlKey: true, deltaY: 80, preventDefault() {} });
  nodes.get('diffs').querySelectorAll('.open-in-files')[0].listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.patch')[0].style.fontSize, '10px');
  const folder = nodes.get('files').querySelectorAll('.tree-folder')[0];
  folder.open = true; folder.listeners.toggle();
  nodes.get('files').querySelectorAll('.tree-file').find(button => button.dataset.path === 'src/new + #.js').listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.patch')[0].style.fontSize, '10px');
  assert.equal(nodes.get('diffs').querySelectorAll('.zoom-reset')[0].textContent, '83%');
  nodes.get('refresh').listeners.click();
  await tick();
  assert.equal(nodes.get('diffs').querySelectorAll('.patch')[0].style.fontSize, '10px');
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('diffs').querySelectorAll('.patch')[0].style.fontSize, '10px');
});

test('Ctrl-wheel zooms code while ordinary wheel keeps browser scrolling', async () => {
  const { nodes } = setup([{ path: 'unchanged.txt', section: 'unstaged', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new\n' }]);
  await tick();
  nodes.get('files').querySelectorAll('.file-link')[0].listeners.click();
  const scroll = nodes.get('diffs').querySelectorAll('.patch-scroll')[0];
  const table = nodes.get('diffs').querySelectorAll('.patch')[0];
  let prevented = 0;
  const wheel = { ctrlKey: false, deltaY: 80, deltaMode: 0, preventDefault() { prevented++; } };
  scroll.listeners.wheel(wheel);
  assert.equal(prevented, 0);
  assert.equal(table.style.fontSize, '12px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true });
  assert.equal(prevented, 1);
  assert.equal(table.style.fontSize, '10px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true, deltaY: -40 });
  assert.equal(table.style.fontSize, '11px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true, deltaY: 20 });
  assert.equal(table.style.fontSize, '11px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true, deltaY: 20 });
  assert.equal(table.style.fontSize, '10px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true, deltaY: 1000 });
  assert.equal(table.style.fontSize, '3px');
  scroll.listeners.wheel({ ...wheel, ctrlKey: true, deltaY: -1000 });
  assert.equal(table.style.fontSize, '24px');
});

test('two-finger pinch zooms code, cancels line presses, and leaves one-finger scrolling alone', async () => {
  const { nodes, context } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const timers = pressTimers(context);
  const line = nodes.get('diffs').querySelectorAll('.line-number')[0];
  const scroll = nodes.get('diffs').querySelectorAll('.patch-scroll')[0];
  const table = nodes.get('diffs').querySelectorAll('.patch')[0];
  let prevented = 0;
  const gesture = gap => ({ touches: [{ clientX: 0, clientY: 0 }, { clientX: gap, clientY: 0 }], preventDefault() { prevented++; } });
  const single = { touches: [{ clientX: 0, clientY: 0 }], preventDefault() { prevented++; } };
  scroll.listeners.touchstart(single);
  scroll.listeners.touchmove(single);
  assert.equal(prevented, 0);
  line.listeners.pointerdown(touchDown);
  assert.equal(timers.pending.size, 1);
  scroll.listeners.touchstart(gesture(100));
  assert.equal(timers.pending.size, 0);
  scroll.listeners.touchmove(gesture(75));
  assert.equal(table.style.fontSize, '9px');
  assert.equal(nodes.get('diffs').querySelectorAll('.zoom-reset')[0].textContent, '75%');
  assert.equal(line.attributes['aria-pressed'], 'false');
  scroll.listeners.touchmove(gesture(200));
  assert.equal(table.style.fontSize, '24px');
  scroll.listeners.touchend();
  scroll.listeners.touchmove(gesture(100));
  assert.equal(table.style.fontSize, '24px');
  scroll.listeners.touchstart(gesture(100));
  scroll.listeners.touchmove(gesture(5));
  assert.equal(table.style.fontSize, '3px');
  scroll.listeners.touchcancel();
  scroll.listeners.touchmove(gesture(200));
  assert.equal(table.style.fontSize, '3px');
  scroll.listeners.touchstart(gesture(0));
  scroll.listeners.touchmove(gesture(100));
  assert.equal(table.style.fontSize, '3px');
});

test('line selection and successful copying stay silent, but copy errors remain visible', async () => {
  const { nodes, context, copied } = setup();
  await tick();
  nodes.get('files-view').listeners.click();
  await tick();
  nodes.get('files').querySelectorAll('.tree-file')[0].listeners.click();
  await tick();
  const feedback = nodes.get('diffs').querySelectorAll('.copy-feedback')[0];
  await nodes.get('diffs').querySelectorAll('.copy-path')[0].listeners.click();
  assert.equal(feedback.textContent, '');
  const lines = nodes.get('diffs').querySelectorAll('.line-number');
  lines[0].listeners.click();
  assert.equal(feedback.textContent, '');
  lines[1].listeners.click({ shiftKey: true });
  assert.equal(feedback.textContent, '');
  const copy = nodes.get('diffs').querySelectorAll('.copy-lines')[0];
  assert.equal(copy.textContent, 'Copy lines 1–2');
  copy.listeners.click();
  assert.equal(feedback.textContent, '');
  await tick();
  assert.equal(feedback.textContent, '');
  assert.equal(copied.at(-1), '<script>safe text</script>\nsecond line\n');
  vm.runInContext('writeClipboard = async () => { throw new Error("Clipboard unavailable"); }', context);
  copy.listeners.click();
  await tick();
  assert.match(feedback.textContent, /Could not copy/);
});

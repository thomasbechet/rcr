// Dependency-free UI behavior tests. Run with: node --test web_test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.listeners = {}; this.textContent = ''; this.className = '';
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
  const context = vm.createContext({
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
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8'), context);
  return { nodes, context, calls, snapshot, paths };
}

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
  assert.equal(panels[0].children[0].children[1].textContent, 'second.txt');
  assert.equal(panels[0].children[0].querySelectorAll('.stat-added')[0].textContent, '+1');
  assert.equal(links[1].attributes['aria-current'], 'true');
  assert.equal(links[0].attributes['aria-current'], undefined);
  links[0].listeners.click();
  panels = nodes.get('diffs').querySelectorAll('.file');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].children[0].children[1].textContent, 'first.txt');
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
  assert.equal(nodes.get('diffs').children[0].children[0].textContent, path);
  nodes.get('changes-view').listeners.click();
  assert.equal(nodes.get('files').querySelectorAll('.file-link')[0].attributes['aria-current'], 'true');
  assert.match(nodes.get('diffs').children[0].children[0].children[1].textContent, /old.go →/);
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
  assert.match(panel.children[0].children[0].textContent, /Staged/);
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
  assert.deepEqual(rows.map(row => row.children[0].textContent), [1, 2, 3]);
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

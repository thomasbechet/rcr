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
function setup() {
  const nodes = new Map();
  const snapshot = { repository: '/repo', updatedAt: new Date().toISOString(), changes: [] };
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
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8'), context);
  return { nodes, context, calls };
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

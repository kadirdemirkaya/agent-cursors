import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon.mjs';
import { projectFileFilter, keepProjectFiles } from '../hook.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const gitTest = HAS_GIT ? test : test.skip;

function folder(files, prefix = 'ac-proj-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};

function repo() {
  const root = folder({
    '.gitignore': 'docs/\nnode_modules/\n',
    'src/App.jsx': '<main className="app">A</main>\n',
    'src/New.tsx': 'export const N = () => <p className="n">Yeni</p>;\n',
    'docs/report.html': '<table><tr><td>Rapor</td></tr></table>\n',
    'docs/kept.html': '<p id="kept">Izlenen</p>\n',
    'reports/day.html': '<h1>Gun</h1>\n',
  });
  git(root, 'init', '-q');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n/reports/\n');
  git(root, 'add', '.gitignore', 'src/App.jsx');
  git(root, 'add', '-f', 'docs/kept.html');
  return root;
}

gitTest('projectFileFilter: git deposunda yok sayılan dosyalar proje dışı, izlenen ve yeni dosyalar proje içi', () => {
  const root = repo();
  try {
    const p = (rel) => path.join(root, ...rel.split('/'));
    const files = ['src/App.jsx', 'src/New.tsx', 'src/Henuz.tsx', 'docs/report.html', 'docs/kept.html', 'reports/day.html', 'node_modules/x/index.js'].map(p);
    const inProject = projectFileFilter(files, root);
    assert.equal(inProject(p('src/App.jsx')), true, 'izlenen dosya');
    assert.equal(inProject(p('src/New.tsx')), true, 'eklenmemiş ama yok sayılmayan dosya');
    assert.equal(inProject(p('src/Henuz.tsx')), true, 'henüz yazılmamış yeni dosya');
    assert.equal(inProject(p('docs/report.html')), false, '.gitignore');
    assert.equal(inProject(p('reports/day.html')), false, '.git/info/exclude');
    assert.equal(inProject(p('node_modules/x/index.js')), false);
    assert.equal(inProject(p('docs/kept.html')), true, 'izlenen dosya yok sayılmaz');
    assert.equal(projectFileFilter(['docs/report.html'], root)('docs/report.html'), false);
    if (process.platform === 'win32') {
      const lower = p('docs/report.html').replace(/^[A-Z]:/, (d) => d.toLowerCase());
      assert.equal(projectFileFilter([lower], root)(lower), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('projectFileFilter: git deposu değilse yalnızca .agent-cursors/routes.json ile kayıtlı klasör proje sayılır', () => {
  const plain = folder({ 'rapor.html': '<p>x</p>\n', 'state/.agent-cursors/daemon.json': '{}', 'state/out.html': '<p>y</p>\n' });
  const marked = folder({ '.agent-cursors/routes.json': '{}', 'src/App.jsx': '<p className="a">x</p>\n' });
  try {
    const a = path.join(plain, 'rapor.html');
    const b = path.join(marked, 'src', 'App.jsx');
    const c = path.join(plain, 'state', 'out.html');
    const inProject = projectFileFilter([a, b, c], plain, { ignored: () => { throw new Error('git çağrılmamalı'); } });
    assert.equal(inProject(a), false);
    assert.equal(inProject(b), true);
    assert.equal(inProject(c), false, 'routes.json\'suz .agent-cursors/ klasörü kayıt değildir');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(marked, { recursive: true, force: true });
  }
});

test('projectFileFilter: git çalışmazsa depo içindeki dosya proje sayılır', () => {
  const root = folder({ '.git/HEAD': 'ref: refs/heads/main\n', 'docs/r.html': '<p>x</p>\n' });
  try {
    const file = path.join(root, 'docs', 'r.html');
    assert.equal(projectFileFilter([file], root, { ignored: () => null })(file), true);
    assert.equal(projectFileFilter([file], root, { ignored: () => new Set(['docs/r.html']) })(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keepProjectFiles: proje dışı imleç olayları atılır, HUD satırı outside işaretlenir; görsel dosya yoksa git çağrılmaz', () => {
  const root = folder({ '.git/HEAD': 'ref: refs/heads/main\n' });
  try {
    const ok = path.join(root, 'src', 'App.jsx');
    const out = path.join(root, 'docs', 'r.html');
    const calls = [];
    const ignored = (r, rels) => { calls.push(rels); return new Set(['docs/r.html']); };
    const dom = [{ file: ok, kind: 'text' }, { file: out, kind: 'remove' }];
    dom.handled = true;
    const actions = [
      { surface: 'file', action: 'edit', file: out, meta: { added: 0, removed: 1 } },
      { surface: 'file', action: 'edit', file: ok, meta: { added: 1, removed: 1 } },
      { surface: 'shell', action: 'run', file: '', meta: { command: 'ls' } },
    ];
    const r = keepProjectFiles(dom, actions, root, { ignored });
    assert.deepEqual(r.domEvents.map((e) => e.file), [ok]);
    assert.equal(r.domEvents.handled, true);
    assert.deepEqual(r.actions.map((a) => a.meta.outside === true), [true, false, false]);
    assert.equal(r.actions[0].meta.removed, 1);
    assert.equal(calls.length, 1, 'kök başına tek git çağrısı');

    const docs = keepProjectFiles([], [{ surface: 'file', action: 'edit', file: path.join(root, 'README.md'), meta: {} }], root, { ignored });
    assert.equal(calls.length, 1, 'README düzenlemesi git çağırmaz');
    assert.equal(docs.actions[0].meta.outside, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function sse(port) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/events?cid=pf&v=1' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      resolve({ close: () => r.destroy(), events: () => buf.split('\n').filter((l) => l.startsWith('data: {"id"')).map((l) => JSON.parse(l.slice(6))) });
    });
    r.on('error', reject);
  });
}

function runHook(port, input) {
  const child = spawn(process.execPath, [path.join(ROOT, 'hook.mjs')], { env: { ...process.env, AGENT_CURSORS_PORT: String(port) }, stdio: ['pipe', 'ignore', 'ignore'] });
  const t0 = Date.now();
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 })));
  child.stdin.end(JSON.stringify(input));
  return done;
}

gitTest('hook: git\'in yok saydığı HTML raporunda imleç oynamaz ve ajan bekletilmez; HUD satırı outside', async () => {
  const root = repo();
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port);
  await sleep(50);
  try {
    const file = path.join(root, 'docs', 'report.html');
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'pf_1', cwd: root, tool_input: { file_path: file, old_string: '<tr><td>Rapor</td></tr>', new_string: '' } };
    const pre = await runHook(d.port, input);
    assert.equal(pre.code, 0);
    assert.ok(pre.ms < 1500, `bekletilmemeli: ms=${pre.ms}`);
    const post = await runHook(d.port, { ...input, hook_event_name: 'PostToolUse', tool_response: {} });
    assert.equal(post.code, 0);
    await sleep(150);
    assert.equal(s.events().filter((e) => !e.surface || e.surface === 'dom').length, 0, 'imleç olayı yok');
    const hud = s.events().filter((e) => e.surface === 'file');
    assert.equal(hud.length, 1);
    assert.equal(hud[0].meta.outside, true);

    const app = path.join(root, 'src', 'App.jsx');
    const tracked = runHook(d.port, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'pf_2', cwd: root, tool_input: { file_path: app, old_string: '>A<', new_string: '>B<' } });
    await sleep(400);
    const dom = s.events().filter((e) => e.surface === 'dom' || !e.surface);
    assert.equal(dom.length, 1);
    assert.equal(dom[0].file, app);
    await fetch(`http://127.0.0.1:${d.port}/ack`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ id: dom[0].id }) });
    assert.equal((await tracked).code, 0);
  } finally { s.close(); await d.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

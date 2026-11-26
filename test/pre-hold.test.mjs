import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon.mjs';
import { buildEvents, eventsFromChange, planPreEvents, groupOf } from '../hook.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pre-'));

const tmpProject = () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.agent-cursors'));
  fs.writeFileSync(path.join(dir, '.agent-cursors', 'routes.json'), '{}');
  return dir;
};

const JSX = `export default function Hero() {
  return (
    <section id="hero" className="hero">
      <h1 className="hero-title">Merhaba</h1>
      <button className="btn w-32" onClick={() => go()}>Basla</button>
    </section>
  );
}
`;
const reader = (files) => (p) => { if (!(p in files)) throw new Error('yok'); return files[p]; };

test('eventsFromChange: metin değişimi MEVCUT (eski) metni hedefler', () => {
  const after = JSX.replace('>Merhaba<', '>Selam<');
  const [ev] = eventsFromChange('/x/Hero.jsx', JSX, after);
  assert.equal(ev.kind, 'text');
  assert.equal(ev.phase, 'pre');
  assert.deepEqual(ev.hint.classes, ['hero-title']);
  assert.equal(ev.hint.text, 'Merhaba');
  assert.equal(ev.startLine, 4);
});

test('eventsFromChange: class değişimi → eski class ile hedef (sayfada hâlâ o var)', () => {
  const [ev] = eventsFromChange('/x/Hero.jsx', JSX, JSX.replace('w-32', 'w-48'));
  assert.equal(ev.kind, 'resize');
  assert.ok(ev.hint.classes.includes('w-32'));
  assert.ok(ev.hint.classes.includes('btn'));
});

test('eventsFromChange: ekleme → ebeveyne git, yeni elemanı next olarak ver', () => {
  const after = JSX.replace('    </section>', '      <p className="hero-sub">Alt baslik</p>\n    </section>');
  const [ev] = eventsFromChange('/x/Hero.jsx', JSX, after);
  assert.equal(ev.kind, 'add');
  assert.equal(ev.hint.id, 'hero');
  assert.deepEqual(ev.next.classes, ['hero-sub']);
});

test('eventsFromChange: tek satırda biten ekleme doğru sınıflanır (diff kayması)', () => {
  const before = '<ul id="perks"><li class="perk">Bir</li></ul>';
  const after = '<ul id="perks"><li class="perk">Bir</li><li class="perk new-perk">Iki</li></ul>';
  const [ev] = eventsFromChange('/x/p.html', before, after);
  assert.equal(ev.kind, 'add');
  assert.deepEqual(ev.next.classes, ['perk', 'new-perk']);
});

test('eventsFromChange: HTML içindeki <style> bloğu CSS olarak hedeflenir', () => {
  const before = '<style>\n.btn-primary { padding: 4px; }\n</style>\n<button class="btn-primary">A</button>';
  const after = before.replace('padding: 4px;', 'padding: 4px; color: red;');
  const [ev] = eventsFromChange('/x/p.html', before, after);
  assert.equal(ev.kind, 'style');
  assert.deepEqual(ev.hint.classes, ['btn-primary']);
});

test('eventsFromChange: CSS — önce mevcut kural, sonra yeni kural', () => {
  const before = '.card { color: red; }\n.btn { padding: 4px; }\n';
  const after = '.card { color: red; }\n.btn { padding: 12px; background: blue; }\n.chip { color: green; }\n';
  const evs = eventsFromChange('/x/app.css', before, after);
  assert.deepEqual(evs.map((e) => e.hint.classes[0]), ['btn', 'chip']);
  assert.ok(evs.every((e) => e.kind === 'style'));
});

test('eventsFromChange: aynı içerik → olay yok', () => {
  assert.deepEqual(eventsFromChange('/x/a.html', '<p>a</p>', '<p>a</p>'), []);
});

test('planPreEvents: Edit dosyayı OKUR ama değiştirmez; MultiEdit sırayla uygular', () => {
  const file = '/p/Hero.jsx';
  const read = reader({ [file]: JSX });
  const evs = planPreEvents({ tool_name: 'MultiEdit', tool_input: { file_path: file, edits: [
    { old_string: '>Merhaba<', new_string: '>Selam<' },
    { old_string: 'w-32', new_string: 'w-64' },
  ] } }, read);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.kind), ['text', 'resize']);
});

test('planPreEvents: simüle edilemeyen Edit → null (eski yola düşer), md dosyası → boş', () => {
  const file = '/p/Hero.jsx';
  const read = reader({ [file]: JSX });
  assert.equal(planPreEvents({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'YOK', new_string: 'x' } }, read), null);
  assert.deepEqual(planPreEvents({ tool_name: 'Edit', tool_input: { file_path: '/p/README.md', old_string: 'a', new_string: 'b' } }, read), []);
});

test('planPreEvents: Write yeni dosya → add + next; var olan dosya → tüm görünür hedefler', () => {
  const fresh = planPreEvents({ tool_name: 'Write', tool_input: { file_path: '/p/New.jsx', content: '<div id="x" className="fresh">Hi</div>' } }, reader({}));
  assert.equal(fresh[0].kind, 'add');
  assert.equal(fresh[0].next.id, 'x');
  const file = '/p/Hero.jsx';
  const over = planPreEvents({ tool_name: 'Write', tool_input: { file_path: file, content: JSX.replace('hero-title', 'hero-title big') } }, reader({ [file]: JSX }));
  assert.ok(over.length >= 2);
  assert.ok(over.every((event) => event.kind === 'edit'));
  assert.ok(over.some((event) => event.hint.classes.includes('hero')));
});

test('planPreEvents: Codex apply_patch (bağlam satırları ve fazladan boşluk toleransı)', () => {
  const file = '/p/Hero.jsx';
  const patch = `*** Begin Patch
*** Update File: Hero.jsx
@@
       <h1 className="hero-title">Merhaba</h1>
-      <button className="btn w-32" onClick={() => go()}>Basla</button>
+      <button className="btn w-48" onClick={() => go()}>Basla</button>
     </section>
*** End Patch`;
  const evs = planPreEvents({ tool_name: 'apply_patch', cwd: '/p', tool_input: { command: patch } }, reader({ [file]: JSX }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'resize');
  assert.ok(evs[0].hint.classes.includes('w-32'));
  assert.equal(buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/p', tool_input: { command: patch } }, reader({ [file]: JSX }))[0].phase, 'pre');
});

test('planPreEvents: Codex yeni dosya ve silme', () => {
  const evs = planPreEvents({ tool_name: 'apply_patch', cwd: '/p', tool_input: { command: `*** Begin Patch
*** Add File: Card.jsx
+<div id="card" className="card">Merhaba</div>
*** Delete File: Hero.jsx
*** End Patch` } }, reader({ '/p/Hero.jsx': JSX }));
  assert.deepEqual(evs.map((e) => e.kind), ['add', 'remove']);
  assert.equal(evs[0].next.id, 'card');
  assert.equal(evs[1].hint.id, 'hero');
});

test('planPreEvents: sed -i basit yerine koyma', () => {
  const file = '/p/Hero.jsx';
  const evs = planPreEvents({ tool_name: 'Bash', cwd: '/p', tool_input: { command: "sed -i 's/w-32/w-40/' Hero.jsx" } }, reader({ [file]: JSX }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'resize');
});

test('groupOf: tool_use_id yoksa araç girdisinden kararlı anahtar', () => {
  const a = { session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'a', old_string: 'x' } };
  assert.equal(groupOf(a), groupOf({ ...a }));
  assert.notEqual(groupOf(a), groupOf({ ...a, tool_input: { file_path: 'b' } }));
  assert.equal(groupOf({ tool_use_id: 'tu1' }), 'tu1');
});

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

function sse(port, query = '') {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: `/events${query}` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      resolve({ get text() { return buf; }, close: () => r.destroy(), events: () => buf.split('\n').filter((l) => l.startsWith('data: {"id"')).map((l) => JSON.parse(l.slice(6))) });
    });
    r.on('error', reject);
  });
}

const EV = (id, extra = {}) => ({ id, file: '/x/a.html', startLine: 1, endLine: 1, kind: 'style', hint: { id: 'h', classes: [], tag: '', text: '' }, ...extra });

test('daemon: hold=true → bütün olayların ack\'i gelene kadar yanıt tutulur', async () => {
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port, '?cid=t1&v=1');
  await sleep(50);
  try {
    let answered = false;
    const p = req(d.port, 'POST', '/batch', { group: 'g1', phase: 'pre', hold: true, holdMs: 3000, events: [EV('e1'), EV('e2')] }).then((r) => { answered = true; return r; });
    await sleep(250);
    assert.equal(answered, false, 'ack gelmeden yanıt verilmemeli');
    const evs = s.events();
    assert.equal(evs[0].gate, true);
    assert.equal(evs[1].gate, true, 'bütün olaylar bekletilir');
    const t0 = Date.now();
    await req(d.port, 'POST', '/ack', { id: 'e1', cid: 't1' });
    await sleep(100);
    assert.equal(answered, false, 'ikinci imleç ulaşmadan yanıt verilmemeli');
    await req(d.port, 'POST', '/ack', { id: 'e2', cid: 't1' });
    const r = await p;
    assert.ok(Date.now() - t0 < 700);
    assert.equal(r.json.held, true);
    assert.equal(r.json.acked, true);
  } finally { s.close(); await d.close(); }
});

test('daemon: ack hiç gelmezse zaman aşımında serbest bırakır', async () => {
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port, '?cid=t1&v=1');
  await sleep(50);
  try {
    const t0 = Date.now();
    const r = await req(d.port, 'POST', '/batch', { group: 'g2', phase: 'pre', hold: true, holdMs: 400, events: [EV('t1e')] });
    const dt = Date.now() - t0;
    assert.ok(dt >= 350 && dt < 1200, `dt=${dt}`);
    assert.equal(r.json.acked, false);
  } finally { s.close(); await d.close(); }
});

test('daemon: bağlı/görünür sekme yoksa hiç beklemez', async () => {
  const d = await startDaemon({ port: 0 });
  try {
    let t0 = Date.now();
    let r = await req(d.port, 'POST', '/batch', { group: 'g3', phase: 'pre', hold: true, holdMs: 3000, events: [EV('n1')] });
    assert.ok(Date.now() - t0 < 300);
    assert.equal(r.json.held, false);

    const s = await sse(d.port, '?cid=hid&v=0');
    await sleep(50);
    t0 = Date.now();
    r = await req(d.port, 'POST', '/batch', { group: 'g4', phase: 'pre', hold: true, holdMs: 3000, events: [EV('n2')] });
    assert.ok(Date.now() - t0 < 300);
    assert.equal(r.json.held, false);

    await req(d.port, 'POST', '/vis', { cid: 'hid', v: true });
    const p = req(d.port, 'POST', '/batch', { group: 'g5', phase: 'pre', hold: true, holdMs: 3000, events: [EV('n3')] });
    await sleep(150);
    await req(d.port, 'POST', '/ack', { id: 'n3' });
    assert.equal((await p).json.held, true);
    s.close();
  } finally { await d.close(); }
});

test('daemon: Pre gösterildiyse aynı group\'un Post\'u tekrar yayınlanmaz', async () => {
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port, '?cid=t1&v=1');
  await sleep(50);
  try {
    await req(d.port, 'POST', '/batch', { group: 'same', phase: 'pre', events: [EV('p1')] });
    const post = await req(d.port, 'POST', '/batch', { group: 'same', phase: 'post', events: [EV('p2')] });
    assert.equal(post.json.skipped, true);
    const other = await req(d.port, 'POST', '/batch', { group: 'other', phase: 'post', events: [EV('p3')] });
    assert.equal(other.json.skipped, undefined);
    await sleep(50);
    assert.deepEqual(s.events().map((e) => e.id), ['p1', 'p3']);
  } finally { s.close(); await d.close(); }
});

test('daemon: phase ve next olay şemasında korunur; /shutdown özel başlık ister', async () => {
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port);
  await sleep(50);
  try {
    await req(d.port, 'POST', '/batch', { phase: 'pre', events: [EV('x1', { phase: 'pre', next: { id: 'yeni', classes: [], tag: '', text: '' } })] });
    await sleep(50);
    const [ev] = s.events();
    assert.equal(ev.phase, 'pre');
    assert.equal(ev.next.id, 'yeni');
    assert.equal((await req(d.port, 'POST', '/shutdown', {})).status, 403);
    assert.equal((await req(d.port, 'GET', '/health')).json.protocol, 5);
  } finally { s.close(); await d.close(); }
});

function runHook(port, input, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'hook.mjs')], { env: { ...process.env, AGENT_CURSORS_PORT: String(port), ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
  const t0 = Date.now();
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 })));
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}

test('hook: PreToolUse imleç ack\'ine kadar bekler, sonra exit 0', async () => {
  const dir = tmpProject();
  const file = path.join(dir, 'a.html');
  fs.writeFileSync(file, '<h1 id="t">Merhaba</h1>\n');
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port, '?cid=t1&v=1');
  await sleep(50);
  try {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'tu_1', cwd: dir, tool_input: { file_path: file, old_string: 'Merhaba', new_string: 'Selam' } };
    const h = runHook(d.port, input);
    await sleep(500);
    assert.equal(h.child.exitCode, null, 'ack gelmeden hook çıkmamalı (araç çalışmamalı)');
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1 id="t">Merhaba</h1>\n');
    const ev = s.events()[0];
    assert.equal(ev.gate, true);
    assert.equal(ev.kind, 'text');
    assert.equal(ev.hint.id, 't');
    assert.equal(ev.hint.text, 'Merhaba');
    await req(d.port, 'POST', '/ack', { id: ev.id });
    const r = await h.done;
    assert.equal(r.code, 0);
    assert.ok(r.ms < 1500, `ms=${r.ms}`);

    const post = runHook(d.port, { ...input, hook_event_name: 'PostToolUse', tool_response: {} });
    await post.done;
    await sleep(100);
    const after = s.events().slice(1);
    assert.equal(after.filter((e) => e.surface === 'dom').length, 0);
    assert.deepEqual(after.map((e) => [e.surface, e.text]), [['file', 'Edited a.html (+1/−1)']]);
  } finally { s.close(); await d.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook: AGENT_CURSORS_HOLD_MS=0 bekletmez; ack gelmezse üst sınırda çıkar', async () => {
  const dir = tmpProject();
  const file = path.join(dir, 'a.html');
  fs.writeFileSync(file, '<h1 id="t">Merhaba</h1>\n');
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port, '?cid=t1&v=1');
  await sleep(50);
  try {
    const mk = (id) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: id, cwd: dir, tool_input: { file_path: file, old_string: 'Merhaba', new_string: 'Selam' } });
    const off = await runHook(d.port, mk('a'), { AGENT_CURSORS_HOLD_MS: '0' }).done;
    assert.equal(off.code, 0);
    assert.ok(off.ms < 800, `ms=${off.ms}`);
    const capped = await runHook(d.port, mk('b'), { AGENT_CURSORS_HOLD_MS: '500' }).done;
    assert.equal(capped.code, 0);
    assert.ok(capped.ms >= 450 && capped.ms < 1500, `ms=${capped.ms}`);
  } finally { s.close(); await d.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook: eski sürüm daemon (/batch yok) için /event\'e düşer', async () => {
  const got = [];
  const old = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => {
      if (rq.url === '/event') { got.push(JSON.parse(b)); rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"ok":true}'); } else { rs.writeHead(404); rs.end('{}'); }
    });
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  const dir = tmpProject();
  const file = path.join(dir, 'a.html');
  fs.writeFileSync(file, '<h1 id="t">Merhaba</h1>\n');
  try {
    const h = runHook(old.address().port, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'z', cwd: dir, tool_input: { file_path: file, old_string: 'Merhaba', new_string: 'Selam' } });
    assert.equal((await h.done).code, 0);
    assert.equal(got.length, 1);
    assert.equal(got[0].hint.id, 't');
  } finally { old.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install.mjs: Claude ve Codex için Pre+Post kurar, eski kurulumu yeniler, kaldırır', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    const hookPath = path.join(ROOT, 'hook.mjs').replace(/\\/g, '/');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { PostToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node "${hookPath}"` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo baska' }] },
    ] } }));
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'install.mjs'), dir, ...a], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    const ours = (list) => list.flatMap((e) => e.hooks).filter((h) => h.command.includes(hookPath));
    assert.equal(ours(claude.hooks.PreToolUse).length, 1);
    assert.equal(ours(claude.hooks.PostToolUse).length, 1);
    assert.ok(claude.hooks.PostToolUse.some((e) => e.hooks.some((h) => h.command === 'echo baska')));
    assert.equal(claude.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|Bash|PowerShell|TodoWrite|TaskCreate|TaskUpdate|mcp__.*');
    assert.ok(claude.hooks.PreToolUse[0].hooks[0].timeout >= 5);
    const postOurs = claude.hooks.PostToolUse.find((e) => e.hooks.some((h) => h.command.includes(hookPath)));
    assert.equal(postOurs.matcher, 'Edit|Write|MultiEdit|Bash|PowerShell|TodoWrite|TaskCreate|TaskUpdate|mcp__.*|Read');
    const codex =JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.PreToolUse[0].matcher, '*');
    assert.equal(ours(codex.hooks.PostToolUse).length, 1);

    assert.equal(run('--uninstall').status, 0);
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(after.hooks.PreToolUse, undefined);
    assert.equal(after.hooks.PostToolUse.length, 1);
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'echo baska');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

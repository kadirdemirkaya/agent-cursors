import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDaemon, normalizeEvent, normalizeDelta } from '../daemon.mjs';
import { eventsFromHunks, agentOf, sessionOf, readFilesOf, readEvents, planPreEvents } from '../hook.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = (file, a, b) => {
  const evs = eventsFromHunks(file, a, b);
  assert.equal(evs.length, 1, JSON.stringify(evs));
  return evs[0];
};

const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-imp-'));
  fs.mkdirSync(path.join(dir, '.agent-cursors'));
  fs.writeFileSync(path.join(dir, '.agent-cursors', 'routes.json'), '{}');
  return dir;
};

test('delta: text → eski ve yeni görünen metin', () => {
  const ev = one('/x/A.jsx', '<button className="btn">Kaydet</button>\n', '<button className="btn">Gönder</button>\n');
  assert.equal(ev.kind, 'text');
  assert.deepEqual(ev.delta, { from: 'Kaydet', to: 'Gönder' });
});

test('delta: JSX metnindeki kesme işareti metni bölmez; uzun metin 40 karakterde kırpılır', () => {
  const ev = one('/x/A.jsx', "<p className=\"lead\">\n  Acme'nin firmaları\n</p>\n", "<p className=\"lead\">\n  Acme'nin bütün firmaları burada listelenir ve aranır\n</p>\n");
  assert.equal(ev.delta.from, "Acme'nin firmaları");
  assert.equal(ev.delta.to.length, 40);
  assert.ok(ev.delta.to.endsWith('…'));
});

test('delta: style → kaldırılan/eklenen sınıflar; CSS bildirimleri', () => {
  const a = one('/x/A.jsx', '<a className="btn px-4 bg-blue-500">x</a>\n', '<a className="btn px-4 bg-emerald-500">x</a>\n');
  assert.equal(a.kind, 'style');
  assert.deepEqual(a.delta, { removed: ['bg-blue-500'], added: ['bg-emerald-500'] });
  const css = one('/x/a.css', '.card {\n  color: #111;\n}\n', '.card {\n  color: #e11d48;\n}\n');
  assert.deepEqual(css.delta, { removed: ['color: #111'], added: ['color: #e11d48'] });
  const inline = one('/x/A.jsx', "<div className=\"box\" style={{ padding: 4 }}>x</div>\n", "<div className=\"box\" style={{ padding: 8 }}>x</div>\n");
  assert.deepEqual(inline.delta, { removed: ['padding: 4px'], added: ['padding: 8px'] });
});

test('delta: resize → büyüme/küçülme yönü (utility sınıf ölçeği ve CSS uzunluğu)', () => {
  assert.deepEqual(one('/x/A.jsx', '<div className="panel w-64">x</div>\n', '<div className="panel w-96">x</div>\n').delta.size, { w: 1, h: 0 });
  assert.deepEqual(one('/x/A.jsx', '<div className="panel h-[300px]">x</div>\n', '<div className="panel h-[120px]">x</div>\n').delta.size, { w: 0, h: -1 });
  assert.deepEqual(one('/x/a.css', '.card {\n  width: 200px;\n}\n', '.card {\n  width: 320px;\n}\n').delta.size, { w: 1, h: 0 });
});

test('delta: add/remove → eklenen/silinen öğenin adı (div/span değil)', () => {
  const add = one('/x/A.jsx', '<ul className="list">\n  <li>a</li>\n</ul>\n', '<ul className="list">\n  <li>a</li>\n  <VendorCard id="v" />\n</ul>\n');
  assert.equal(add.kind, 'add');
  assert.deepEqual(add.delta, { el: 'VendorCard' });
  const rem = one('/x/A.jsx', '<section className="s">\n  <Banner />\n  <p className="t">x</p>\n</section>\n', '<section className="s">\n  <p className="t">x</p>\n</section>\n');
  assert.equal(rem.kind, 'remove');
  assert.deepEqual(rem.delta, { el: 'Banner' });
  const div = one('/x/A.jsx', '<ul className="list">\n  <li>a</li>\n</ul>\n', '<ul className="list">\n  <li>a</li>\n  <div className="x">b</div>\n</ul>\n');
  assert.equal(div.delta, undefined);
});

test('normalizeDelta: kısa, temiz ve şemaya uygun tutar', () => {
  assert.equal(normalizeDelta(null), null);
  assert.equal(normalizeDelta({ from: 'a' }), null);
  const d = normalizeDelta({
    from: 'x'.repeat(80), to: 'b\u0007c', removed: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 5], added: 'no',
    el: '<script>', size: { w: 2, h: -1 }, extra: 'yok',
  });
  assert.equal(d.from.length, 40);
  assert.equal(d.to, 'b c');
  assert.deepEqual(d.removed, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(d.added, undefined);
  assert.equal(d.el, undefined);
  assert.deepEqual(d.size, { w: 0, h: -1 });
  assert.equal(d.extra, undefined);
});

test('normalizeEvent: delta, anchor, agent ve session korunur; geçersizleri atılır', () => {
  const ok = normalizeEvent({ file: 'a.jsx', kind: 'text', delta: { from: 'a', to: 'b' }, anchor: 'component', agent: 'codex', session: 'abcd1234' }).event;
  assert.deepEqual(ok.delta, { from: 'a', to: 'b' });
  assert.equal(ok.anchor, 'component');
  assert.equal(ok.agent, 'codex');
  assert.equal(ok.session, 'abcd1234');
  const bad = normalizeEvent({ file: 'a.jsx', anchor: 'x', agent: 'gpt', session: 'not a hash!' }).event;
  assert.deepEqual(Object.keys(bad).sort(), ['endLine', 'file', 'hint', 'id', 'kind', 'startLine', 'surface']);
});

test('agentOf/sessionOf: Claude Code ve Codex ayrılır; oturum kısa özettir', () => {
  assert.equal(agentOf({ transcript_path: 'C:\\Users\\u\\.claude\\projects\\p\\s.jsonl' }), 'claude');
  assert.equal(agentOf({ transcript_path: '/home/u/.codex/sessions/2026/x.jsonl' }), 'codex');
  assert.equal(agentOf({ turn_id: 't1', tool_name: 'Bash' }), 'codex');
  assert.equal(agentOf({ tool_name: 'apply_patch' }), 'codex');
  assert.equal(agentOf({ tool_name: 'Edit' }), 'claude');
  const s = sessionOf({ session_id: 'f1e2d3c4-aaaa-bbbb' });
  assert.match(s, /^[a-f0-9]{8}$/);
  assert.equal(sessionOf({ session_id: 'f1e2d3c4-aaaa-bbbb' }), s);
  assert.notEqual(sessionOf({ session_id: 'baska' }), s);
  assert.equal(sessionOf({}), '');
});

test('readFilesOf: Read aracı ve kabukta yalnızca okuyan komutlar', () => {
  const cwd = path.join(os.tmpdir(), 'ac-read-cwd');
  const post = (tool_name, tool_input) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, cwd });
  assert.deepEqual(readFilesOf(post('Read', { file_path: 'src/Hero.jsx', offset: 40 })), [{ file: path.join(cwd, 'src', 'Hero.jsx'), line: 40 }]);
  assert.deepEqual(readFilesOf(post('Bash', { command: "sed -n '1,80p' src/App.jsx" })), [{ file: path.join(cwd, 'src', 'App.jsx'), line: 1 }]);
  assert.deepEqual(readFilesOf(post('Bash', { command: 'nl -ba src/App.jsx | head -50' })).map((r) => path.basename(r.file)), ['App.jsx']);
  assert.deepEqual(readFilesOf(post('Bash', { command: "sed -i 's/a/b/' src/App.jsx" })), []);
  assert.deepEqual(readFilesOf(post('Bash', { command: 'cat src/App.jsx > out.txt' })), []);
  assert.deepEqual(readFilesOf({ ...post('Read', { file_path: 'a.jsx' }), hook_event_name: 'PreToolUse' }), []);
});

test('readEvents: okunan bileşenin kök elemanına bekletmesiz "read" olayı; test/DOM-suz dosyalar yok', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src', 'Hero.jsx'), 'import x from "y";\nexport default function Hero() {\n  return <section id="hero" className="hero"><h1>Merhaba</h1></section>;\n}\n');
  fs.writeFileSync(path.join(dir, 'src', 'api.ts'), 'export const get = () => fetch("/x");\n');
  fs.writeFileSync(path.join(dir, 'test', 'Hero.test.jsx'), 'export default () => <div className="t">x</div>;\n');
  const read = (file) => readEvents({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dir, file) }, cwd: dir });
  const evs = read('src/Hero.jsx');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'read');
  assert.equal(evs[0].phase, 'post');
  assert.equal(evs[0].anchor, 'component');
  assert.equal(evs[0].hint.id, 'hero');
  assert.deepEqual(read('src/api.ts'), []);
  assert.deepEqual(read('test/Hero.test.jsx'), []);
  assert.deepEqual(read('src/yok.jsx'), []);
});

function req(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.end(data);
  });
}
function sse(port) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/events?cid=t&v=0' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      resolve({ get text() { return buf; }, close: () => r.destroy() });
    });
    r.on('error', reject);
  });
}
const EV = (id, extra = {}) => ({ id, file: '/x/A.jsx', startLine: 1, endLine: 1, kind: 'text', hint: { id: 'h', classes: [], tag: '', text: '' }, ...extra });

test('daemon: Post geldi → Pre olaylarının id\'leriyle bir kez `applied` yayınlanır (geçmişe yazılmaz)', async () => {
  const d = await startDaemon({ port: 0 });
  const s = await sse(d.port);
  try {
    await req(d.port, '/batch', { group: 'tu1', phase: 'pre', hold: false, events: [EV('a1', { delta: { from: 'x', to: 'y' } }), EV('a2')] });
    await req(d.port, '/batch', { group: 'tu1:act', phase: 'post', hold: false, events: [{ surface: 'file', action: 'edit', file: '/x/A.jsx', text: 'Edited A.jsx' }] });
    await req(d.port, '/batch', { group: 'tu1', phase: 'post', hold: false, events: [EV('a3')] });
    await sleep(100);
    const applied = s.text.split('\n\n').filter((b) => b.startsWith('event: applied'));
    assert.equal(applied.length, 1);
    assert.deepEqual(JSON.parse(applied[0].split('data: ')[1]).ids, ['a1', 'a2']);
    assert.ok(/event: hello\ndata: \{[^\n]*"protocol":5/.test(s.text));
    assert.ok(s.text.includes('"delta":{"from":"x","to":"y"}'));
    const hist = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: d.port, path: '/history?limit=50' }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve(JSON.parse(buf)));
    }));
    assert.ok(hist.events.every((h) => h.event && h.event.file));
  } finally {
    s.close();
    await d.close();
  }
});

test('düz HTML: <script> içindeki yorumdaki `<etiket` sonraki betik düzenlemelerinin hedefi olmaz', () => {
  const page = [
    '<!DOCTYPE html><html><head><title>t</title></head><body>',
    '<main><div class="tabs" id="tabs"></div></main>',
    '<script>',
    '// gömülü mod (?gom=1#<karar JSON>)',
    '/* blok yorum <kutu> */',
    'const url = "http://x/<y";',
    'const tpl = `<p class="satir">${a // değil yorum',
    '}</p>`;',
    'function load() {',
    '  return 1;',
    '}',
    '</script>',
    '</body></html>',
  ].join('\n');
  const after = page.replace('  return 1;', '  return 2;');
  const evs = eventsFromHunks('C:/p/agac.html', page, after);
  assert.equal(evs.length, 1, JSON.stringify(evs));
  assert.notEqual(evs[0].hint.tag, 'karar');
  assert.notEqual(evs[0].hint.tag, 'kutu');
  assert.equal(evs[0].hint.tag, 'script');
});

test('planPreEvents: CRLF dosyada LF\'li çok satırlı Edit dosyanın tamamına değil değişen satıra gider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-crlf-'));
  const file = path.join(dir, 'index.html');
  const lines = ['<!DOCTYPE html><html><head><title>t</title></head><body>', '<main>'];
  for (let i = 0; i < 40; i++) lines.push(`  <p class="satir s${i}">satır ${i}</p>`);
  lines.push('  <div class="kutu">eski</div>', '</main>', '</body></html>', '');
  fs.writeFileSync(file, lines.join('\r\n'));
  const evs = planPreEvents({
    hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir,
    tool_input: { file_path: file, old_string: '  <p class="satir s39">satır 39</p>\n  <div class="kutu">eski</div>', new_string: '  <p class="satir s39">satır 39</p>\n  <div class="kutu">yeni</div>' },
  });
  assert.ok(evs && evs.length >= 1, JSON.stringify(evs));
  assert.equal(evs[0].startLine, 43, JSON.stringify(evs));
  assert.ok(evs[0].endLine - evs[0].startLine < 3, JSON.stringify(evs));
  assert.deepEqual(evs[0].hint.classes, ['kutu']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('düz HTML: betik dizgisindeki `<npcId>` etiket sayılmaz; şablondaki gerçek etiket sayılır', () => {
  const page = [
    '<!DOCTYPE html><html><head><title>t</title></head><body>',
    '<main id="m"></main>',
    '<script>',
    'const d = { t: "cmd.bot.<npcId> ile emir yazar" };',
    'function kart(x) {',
    '  return 1;',
    '}',
    'const tpl = `<section class="kart">',
    '  <b>${x}</b>',
    '</section>`;',
    '</script>',
    '</body></html>',
  ].join('\n');
  const a = eventsFromHunks('C:/p/index.html', page, page.replace('  return 1;', '  return 2;'));
  assert.equal(a[0].hint.tag, 'script', JSON.stringify(a));
  const b = eventsFromHunks('C:/p/index.html', page, page.replace('  <b>${x}</b>', '  <b class="kalin">${x}</b>'));
  assert.notEqual(b[0].hint.tag, 'npcid', JSON.stringify(b));
  assert.ok(b[0].hint.tag === 'b' || (b[0].hint.classes || []).includes('kart'), JSON.stringify(b));
});

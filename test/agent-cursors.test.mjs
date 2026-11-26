import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KINDS, normalizeEvent, normalizeHint, mergeHint, extractHint, enrichEvent, emptyHint, startDaemon,
} from '../daemon.mjs';
import { guessKind, locate, rangeFromPatch, buildEvents, countLines } from '../hook.mjs';

test('normalizeEvent: geçerli olayı şemaya oturtur', () => {
  const r = normalizeEvent({ id: 'a1', file: '/x/Hero.jsx', startLine: 12, endLine: 18, kind: 'style', hint: { id: 'hero', classes: ['a', 'b'], tag: 'DIV', text: 'Merhaba' } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.event).sort(), ['endLine', 'file', 'hint', 'id', 'kind', 'startLine', 'surface']);
  assert.equal(r.event.surface, 'dom');
  assert.deepEqual(r.event.hint, { id: 'hero', classes: ['a', 'b'], tag: 'div', text: 'Merhaba' });
  assert.equal(r.event.kind, 'style');
});

test('normalizeEvent: varsayılanlar ve düzeltmeler', () => {
  const r = normalizeEvent({ file: 'a.html', startLine: 10, endLine: 3, kind: 'bilinmeyen' });
  assert.equal(r.ok, true);
  assert.equal(r.event.endLine, 10);
  assert.equal(r.event.kind, 'edit');
  assert.ok(r.event.id.length > 8);
  assert.deepEqual(r.event.hint, emptyHint());
});

test('normalizeEvent: file yoksa veya nesne değilse reddeder', () => {
  assert.equal(normalizeEvent({}).ok, false);
  assert.equal(normalizeEvent({ file: '  ' }).ok, false);
  assert.equal(normalizeEvent(null).ok, false);
  assert.equal(normalizeEvent([]).ok, false);
});

test('normalizeEvent: 7 tür kabul edilir (read dahil)', () => {
  for (const kind of KINDS) assert.equal(normalizeEvent({ file: 'a.js', kind }).event.kind, kind);
  assert.equal(KINDS.length, 7);
});

test('normalizeHint: geçersiz sınıf adlarını eler', () => {
  const h = normalizeHint({ classes: ['ok', 'has space', '${x}', 'md:flex', 5], id: 'bad id' });
  assert.deepEqual(h.classes, ['ok', 'md:flex']);
  assert.equal(h.id, '');
});

test('mergeHint: gönderenin hint\'i doluysa kazanır', () => {
  const auto = { id: 'x', classes: [], tag: 'p', text: '' };
  assert.equal(mergeHint({ id: '', classes: [], tag: '', text: 'T' }, auto).text, 'T');
  assert.equal(mergeHint(emptyHint(), auto).id, 'x');
});

test('extractHint: HTML satırından id, class, etiket ve metin', () => {
  const src = '<div>\n  <h1 id="title" class="hero big">Merhaba Dünya</h1>\n</div>';
  assert.deepEqual(extractHint(src, 2, 2), { id: 'title', classes: ['hero', 'big'], tag: 'h1', text: 'Merhaba Dünya' });
});

test('extractHint: JSX className ve bileşen etiketi (DOM etiketi değilse boş)', () => {
  const src = 'return (\n  <Button className="btn primary" id="cta">Kaydet</Button>\n);';
  const h = extractHint(src, 2, 2);
  assert.equal(h.id, 'cta');
  assert.deepEqual(h.classes, ['btn', 'primary']);
  assert.equal(h.tag, '');
  assert.equal(h.text, 'Kaydet');
});

test('extractHint: şablon sabit sınıfında dinamik kısımları atar, JSX ifadelerini metinden çıkarır', () => {
  const src = '<p className={`lead ${active ? "on" : ""}`}>Merhaba {name}, hoş geldin</p>';
  const h = extractHint(src, 1, 1);
  assert.deepEqual(h.classes, ['lead']);
  assert.equal(h.tag, 'p');
  assert.match(h.text, /^Merhaba\s*,\s*hoş geldin$/);
});

test('extractHint: çok satırlı etiketin ortasındaki aralıkta açılış etiketi yukarıda aranır', () => {
  const src = '<section\n  id="features"\n  class="grid">\n  <p>x</p>\n</section>';
  const h = extractHint(src, 2, 3);
  assert.equal(h.id, 'features');
  assert.deepEqual(h.classes, ['grid']);
  assert.equal(h.tag, 'section');
});

test('extractHint: CSS dosyasında çevreleyen seçiciyi bulur', () => {
  const src = '.hero .title:hover {\n  color: red;\n  width: 10px;\n}\n#cta { margin: 0; }';
  const a = extractHint(src, 2, 3, { file: 'a.css' });
  assert.deepEqual(a.classes, ['title']);
  const b = extractHint(src, 5, 5, { file: 'a.css' });
  assert.equal(b.id, 'cta');
});

test('extractHint: <style> bloğundaki bildirimler seçiciye bağlanır', () => {
  const src = '<style>\n  .card {\n    padding: 8px;\n  }\n</style>';
  assert.deepEqual(extractHint(src, 3, 3, { file: 'a.html' }).classes, ['card']);
});

test('extractHint: betikte getElementById', () => {
  const src = 'const el = document.getElementById("panel");\nel.hidden = true;';
  assert.equal(extractHint(src, 1, 1, { file: 'a.js' }).id, 'panel');
});

test('extractHint: generic tür parametresi etiket sayılmaz, çıkarılamazsa boş kalır', () => {
  assert.deepEqual(extractHint('const [a, b] = useState<string>("");\nlet x = 1;', 1, 2), emptyHint());
  assert.deepEqual(extractHint('', 1, 1), emptyHint());
  assert.deepEqual(extractHint(null, 1, 1), emptyHint());
});

test('extractHint: çok büyük dosyanın tamamı için hint üretmez', () => {
  const src = Array.from({ length: 100 }, (_, i) => `<p id="p${i}">x</p>`).join('\n');
  assert.deepEqual(extractHint(src, 1, 100), emptyHint());
  assert.equal(extractHint(src, 5, 5).id, 'p4');
});

test('enrichEvent: dosyayı okuyup hint ekler, okunamazsa boş bırakır', async () => {
  const ev = normalizeEvent({ file: 'x.html', startLine: 1, endLine: 1, kind: 'text' }).event;
  const ok = await enrichEvent(ev, async () => '<h2 id="t" class="x">Başlık</h2>');
  assert.equal(ok.hint.id, 't');
  assert.equal(ok.hint.text, 'Başlık');
  const bad = await enrichEvent(ev, async () => { throw new Error('yok'); });
  assert.deepEqual(bad.hint, emptyHint());
});

test('guessKind: ekleme, silme, metin, boyut, stil, genel', () => {
  assert.equal(guessKind('', '<div>yeni</div>'), 'add');
  assert.equal(guessKind('<p>eski</p>', ''), 'remove');
  assert.equal(guessKind('<ul><li>a</li></ul>', '<ul><li>a</li><li>b</li></ul>'), 'add');
  assert.equal(guessKind('<ul><li>a</li><li>b</li></ul>', '<ul><li>a</li></ul>'), 'remove');
  assert.equal(guessKind('<h1>Merhaba</h1>', '<h1>Selam dünya</h1>'), 'text');
  assert.equal(guessKind('.a {\n  width: 300px;\n}', '.a {\n  width: 400px;\n}'), 'resize');
  assert.equal(guessKind('<div class="w-64 p-2">', '<div class="w-96 p-2">'), 'resize');
  assert.equal(guessKind('.a {\n  color: red;\n}', '.a {\n  color: blue;\n}'), 'style');
  assert.equal(guessKind('<div class="p-2">', '<div class="p-4">'), 'style');
  assert.equal(guessKind('let a = foo(1);', 'let a = bar(2);'), 'edit');
});

test('locate: new_string\'in dosyadaki satır aralığını bulur', () => {
  const content = 'a\nb\n<div>\n  <p>x</p>\n</div>\nz';
  assert.deepEqual(locate(content, '<div>\n  <p>x</p>\n</div>'), { start: 3, end: 5 });
  assert.deepEqual(locate(content, '\n\nb\n'), { start: 2, end: 2 });
  assert.equal(locate(content, 'yok'), null);
  assert.equal(locate(content, ''), null);
});

test('rangeFromPatch: ilk değişiklik kümesinin yeni satırları', () => {
  const patch = [{ oldStart: 3, oldLines: 4, newStart: 3, newLines: 5, lines: [' a', ' b', '-eski', '+yeni1', '+yeni2', ' c'] }];
  assert.deepEqual(rangeFromPatch(patch), { start: 5, end: 6 });
  const del = [{ newStart: 10, lines: [' a', '-silinen', ' b'] }];
  assert.deepEqual(rangeFromPatch(del), { start: 11, end: 11 });
  assert.equal(rangeFromPatch([]), null);
  assert.equal(rangeFromPatch(undefined), null);
});

test('buildEvents: Edit → konum ve tür', () => {
  const content = 'l1\nl2\n<h1 id="t">Selam</h1>\nl4';
  const evs = buildEvents(
    { tool_name: 'Edit', tool_input: { file_path: '/p/a.html', old_string: '<h1 id="t">Merhaba</h1>', new_string: '<h1 id="t">Selam</h1>' } },
    () => content,
  );
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'text');
  assert.equal(evs[0].startLine, 3);
  assert.equal(evs[0].endLine, 3);
  assert.equal(evs[0].file, '/p/a.html');
  assert.deepEqual(Object.keys(evs[0]).sort(), ['endLine', 'file', 'hint', 'id', 'kind', 'startLine']);
});

test('buildEvents: Edit silme → remove, hint silinen metinden', () => {
  const evs = buildEvents(
    { tool_name: 'Edit', tool_input: { file_path: '/p/a.html', old_string: '<article class="card--old">x</article>', new_string: '' } },
    () => 'a\nb\nc',
  );
  assert.equal(evs[0].kind, 'remove');
  assert.deepEqual(evs[0].hint.classes, ['card--old']);
  assert.equal(evs[0].hint.tag, 'article');
});

test('buildEvents: bulunamazsa 1-son aralığı', () => {
  const evs = buildEvents(
    { tool_name: 'Edit', tool_input: { file_path: '/p/a.html', old_string: 'x', new_string: 'yy' } },
    () => 'a\nb\nc',
  );
  assert.deepEqual([evs[0].startLine, evs[0].endLine], [1, 3]);
});

test('buildEvents: dosya okunamazsa da olay üretir', () => {
  const evs = buildEvents(
    { tool_name: 'Edit', tool_input: { file_path: '/yok/a.html', old_string: 'x', new_string: 'yy' } },
    () => { throw new Error('ENOENT'); },
  );
  assert.equal(evs.length, 1);
  assert.deepEqual([evs[0].startLine, evs[0].endLine], [1, 1]);
});

test('buildEvents: structuredPatch varsa onu kullanır', () => {
  const evs = buildEvents(
    {
      tool_name: 'Edit',
      tool_input: { file_path: '/p/a.css', old_string: 'width: 1px;', new_string: 'width: 2px;' },
      tool_response: { structuredPatch: [{ newStart: 1, lines: [' a', ' b', '-width: 1px;', '+width: 2px;'] }] },
    },
    () => 'a\nb\nwidth: 2px;',
  );
  assert.deepEqual([evs[0].startLine, evs[0].endLine], [3, 3]);
  assert.equal(evs[0].kind, 'resize');
});

test('buildEvents: MultiEdit her düzenleme için bir olay, en fazla 5', () => {
  const edits = Array.from({ length: 8 }, (_, i) => ({ old_string: `<p>a${i}</p>`, new_string: `<p>b${i}</p>` }));
  const evs = buildEvents({ tool_name: 'MultiEdit', tool_input: { file_path: '/p/a.html', edits } }, () => '<p>b0</p>');
  assert.equal(evs.length, 5);
});

test('buildEvents: Write ve ilgisiz araçlar', () => {
  const html = '<h1 class="title">a</h1>\n<p class="lead">b</p>';
  const w = buildEvents({ tool_name: 'Write', tool_input: { file_path: '/p/n.html', content: html }, tool_response: { type: 'create' } }, () => html);
  assert.equal(w[0].kind, 'add');
  assert.equal(w[0].created, true);
  assert.deepEqual(w[0].next.classes, ['title']);
  assert.deepEqual(buildEvents({ tool_name: 'Write', tool_input: { file_path: '/p/n2.html', content: 'a\nb' }, tool_response: { type: 'create' } }, () => 'a\nb'), []);
  assert.deepEqual(buildEvents({ tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(buildEvents(null), []);
  assert.deepEqual(buildEvents({ tool_name: 'Edit', tool_input: {} }), []);
  assert.equal(countLines('a\r\nb\r\nc'), 3);
});

test('hook.mjs: stdin\'den okur, daemon yokken bile exit 0 ve sessiz', async () => {
  const { spawnSync } = await import('node:child_process');
  const hook = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'hook.mjs');
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: {} });
  const r = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const bad = spawnSync(process.execPath, [hook], { input: 'bozuk json', encoding: 'utf8', timeout: 5000 });
  assert.equal(bad.status, 0);
});

function httpRequest(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function openSSE(port, p = '/events') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = '';
      const waiters = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        for (const w of [...waiters]) if (w.test(buf)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(buf); }
      });
      resolve({
        res,
        get text() { return buf; },
        waitFor: (re) => new Promise((ok, no) => {
          if (re.test(buf)) return ok(buf);
          const t = setTimeout(() => no(new Error('SSE zaman aşımı: ' + buf)), 3000);
          waiters.push({ test: (b) => re.test(b), resolve: (b) => { clearTimeout(t); ok(b); } });
        }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

test('daemon: CORS, overlay.js, SSE yayını, hint zenginleştirme', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  const file = path.join(dir, 'Hero.html');
  fs.writeFileSync(file, '<div>\n  <h1 id="baslik" class="hero">Merhaba</h1>\n</div>\n');
  const d = await startDaemon({ port: 0 });
  try {
    const health = await httpRequest(d.port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['access-control-allow-origin'], '*');

    const pre = await httpRequest(d.port, 'OPTIONS', '/event');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');

    const js = await httpRequest(d.port, 'GET', '/overlay.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal(js.headers['access-control-allow-origin'], '*');
    assert.match(js.body, /__agentCursors/);

    const sse = await openSSE(d.port);
    assert.equal(sse.res.headers['access-control-allow-origin'], '*');
    assert.match(sse.res.headers['content-type'], /text\/event-stream/);
    await sse.waitFor(/event: hello/);

    const post = await httpRequest(d.port, 'POST', '/event', { id: 'e1', file, startLine: 2, endLine: 2, kind: 'style' });
    assert.equal(post.status, 200);
    const pj = JSON.parse(post.body);
    assert.equal(pj.ok, true);
    assert.equal(pj.clients, 1);
    assert.equal(pj.hint, undefined);

    const text = await sse.waitFor(/data: .*e1/);
    const dataLine = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"e1"'));
    const ev = JSON.parse(dataLine.slice(6));
    assert.equal(ev.kind, 'style');
    assert.deepEqual(ev.hint, { id: 'baslik', classes: ['hero'], tag: 'h1', text: 'Merhaba' });

    sse.close();
    const again = await openSSE(d.port, '/events?last=0');
    const replay = await again.waitFor(/data: .*e1/);
    assert.match(replay, /"e1"/);
    again.close();

    const bad = await httpRequest(d.port, 'POST', '/event', '{bozuk');
    assert.equal(bad.status, 400);
    const noFile = await httpRequest(d.port, 'POST', '/event', { kind: 'add' });
    assert.equal(noFile.status, 400);
    assert.equal((await httpRequest(d.port, 'GET', '/yok')).status, 404);
  } finally {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: izinli olmayan uzantılı dosyalardan hint okunmaz', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  const secret = path.join(dir, '.env');
  fs.writeFileSync(secret, '<p id="gizli">anahtar</p>');
  const d = await startDaemon({ port: 0 });
  try {
    const sse = await openSSE(d.port);
    await sse.waitFor(/event: hello/);
    await httpRequest(d.port, 'POST', '/event', { id: 's1', file: secret, startLine: 1, endLine: 1, kind: 'edit' });
    const text = await sse.waitFor(/data: .*s1/);
    assert.ok(!text.includes('gizli'));
    sse.close();
  } finally {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension/overlay.js kök overlay.js ile aynı ve manifest geçerli', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.equal(fs.readFileSync(path.join(root, 'extension/overlay.js'), 'utf8'), fs.readFileSync(path.join(root, 'overlay.js'), 'utf8'));
  const m = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.ok(m.content_scripts[0].matches.includes('http://localhost/*'));
  assert.deepEqual(m.content_scripts[0].js, ['overlay.js']);
});

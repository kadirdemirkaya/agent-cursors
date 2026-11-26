import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent, normalizeHint, normalizeOwner, extractHint, cssNestDepth } from '../daemon.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsFromHunks, htmlIndexStack, ownerOf } from '../hook.mjs';

const one = (file, a, b) => {
  const evs = eventsFromHunks(file, a, b);
  assert.equal(evs.length, 1, JSON.stringify(evs));
  return evs[0];
};

test('6.2 hook: `.card > .title` → hint.selector ve cssProps', () => {
  const ev = one('/x/a.css', '.card > .title {\n  color: red;\n}\n', '.card > .title {\n  color: blue;\n  letter-spacing: 2px;\n}\n');
  assert.equal(ev.hint.selector, '.card > .title');
  assert.deepEqual(ev.hint.classes, ['title']);
  assert.deepEqual(ev.cssProps, ['color', 'letter-spacing']);
});

test('6.2 hook: `nav a:hover` seçicisi korunur (temizliği overlay yapar); tek etiketli `a` gönderilmez', () => {
  assert.equal(one('/x/a.css', 'nav a:hover {\n  color: red;\n}\n', 'nav a:hover {\n  color: blue;\n}\n').hint.selector, 'nav a:hover');
  assert.equal(one('/x/a.css', 'a {\n  color: red;\n}\n', 'a {\n  color: blue;\n}\n').hint.selector, undefined);
  assert.equal(one('/x/a.css', 'body {\n  color: red;\n}\n', 'body {\n  color: blue;\n}\n').hint.selector, undefined);
});

test('6.2 hook: öznitelik seçicisi ve @media içindeki kural seçici taşır', () => {
  assert.equal(one('/x/a.css', '[data-state="open"] {\n  color: red;\n}\n', '[data-state="open"] {\n  color: blue;\n}\n').hint.selector, '[data-state="open"]');
  const m = one('/x/a.css', '@media (min-width: 1px) {\n  .card .title {\n    color: red;\n  }\n}\n', '@media (min-width: 1px) {\n  .card .title {\n    color: blue;\n  }\n}\n');
  assert.equal(m.hint.selector, '.card .title');
});

test('6.2 hook: SCSS iç içe kural ve `&` seçici göndermez (v1)', () => {
  const nested = one('/x/a.scss', '.a {\n  .b {\n    color: red;\n  }\n}\n', '.a {\n  .b {\n    color: blue;\n  }\n}\n');
  assert.deepEqual(nested.hint.classes, ['b']);
  assert.equal(nested.hint.selector, undefined);
  const amp = one('/x/a.scss', '.a {\n  &:hover {\n    color: red;\n  }\n}\n', '.a {\n  &:hover {\n    color: blue;\n  }\n}\n');
  assert.equal(amp.hint.selector, undefined);
});

test('6.2 hook: tek dosyalı bileşenin <style> bloğu (betikteki süslü parantezler iç içe sayılmaz)', () => {
  const head = '<template><p class="t">x</p></template>\n<script>\nexport default { data() { return {} } }\n</script>\n<style scoped>\n';
  const ev = one('/x/A.vue', `${head}.card .t {\n  color: red;\n}\n</style>\n`, `${head}.card .t {\n  color: blue;\n}\n</style>\n`);
  assert.equal(ev.hint.selector, '.card .t');
  assert.deepEqual(ev.cssProps, ['color']);
});

test('6.2 daemon: cssNestDepth', () => {
  const lines = ['@media x {', '  .a {', '    .b {', '      color: red;', '    }', '  }', '}'];
  assert.equal(cssNestDepth(lines, 1), 0);
  assert.equal(cssNestDepth(lines, 2), 1);
  assert.equal(cssNestDepth(lines, 6), 0);
});

test('6.2 daemon: extractHint CSS dalı selector üretir; normalizeHint uzun/geçersiz seçiciyi düşürür', () => {
  const h = extractHint('.card .title {\n  color: red;\n}\n', 2, 2, { file: '/x/a.css' });
  assert.equal(h.selector, '.card .title');
  assert.equal(normalizeHint({ selector: '.a '.repeat(80) }).selector, undefined);
  assert.equal(normalizeHint({ selector: '.a{x}' }).selector, undefined);
  assert.equal(normalizeHint({ selector: '.a\u0001' }).selector, undefined);
  assert.equal(normalizeHint({ selector: '&:hover' }).selector, undefined);
  assert.equal(normalizeHint({ selector: '  .card   >  .title ' }).selector, '.card > .title');
});

test('6.2 daemon: normalizeEvent cssProps süzer (≤ 8, yalnızca özellik adı)', () => {
  const { event } = normalizeEvent({ file: '/x/a.css', kind: 'style', hint: { classes: ['a'] }, cssProps: ['color', 'letter-spacing', '--brand', 'COLOR', 'x:y', 'a b', 1, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  assert.deepEqual(event.cssProps, ['color', 'letter-spacing', '--brand', 'p1', 'p2', 'p3', 'p4', 'p5']);
  const { event: plain } = normalizeEvent({ file: '/x/a.css', kind: 'style', hint: { classes: ['a'] } });
  assert.equal(plain.cssProps, undefined);
});

test('6.4 hook: ata zinciri (dıştan içe), bileşen adları (<Card>) zincire girmez', () => {
  const before = '<section className="hero">\n  <Card>\n    <div className="cta">\n      <button className="btn">Kaydol</button>\n    </div>\n  </Card>\n</section>\n';
  const ev = one('/x/Hero.jsx', before, before.replace('Kaydol', 'Katıl'));
  assert.deepEqual(ev.hint.classes, ['btn']);
  assert.deepEqual(ev.hint.path, [{ tag: 'section', classes: ['hero'] }, { tag: 'div', classes: ['cta'] }]);
});

test('6.4 hook: sınıfsız yapısal etiket (li, nav) zincire girer; sınıfsız div girmez', () => {
  const before = '<nav>\n  <ul className="menu">\n    <li>\n      <div>\n        <a className="link" href="#">Ana</a>\n      </div>\n    </li>\n  </ul>\n</nav>\n';
  const ev = one('/x/Nav.jsx', before, before.replace('Ana', 'Anasayfa'));
  assert.deepEqual(ev.hint.path, [{ tag: 'nav' }, { tag: 'ul', classes: ['menu'] }, { tag: 'li' }]);
});

test('6.4 hook: eklenen elemanın (next) zinciri de taşınır', () => {
  const before = '<section id="team">\n  <ul className="list">\n    <li className="item">A</li>\n  </ul>\n</section>\n';
  const after = before.replace('</ul>', '  <li className="item new">B</li>\n  </ul>');
  const ev = one('/x/Team.jsx', before, after);
  assert.equal(ev.kind, 'add');
  assert.deepEqual(ev.next.path, [{ tag: 'section', id: 'team' }, { tag: 'ul', classes: ['list'] }]);
});

test('6.4 daemon: normalizePath doğrular ve en fazla 4 öğe tutar', () => {
  const h = normalizeHint({ classes: ['btn'], path: [{ tag: 'html' }, { tag: 'main' }, { tag: 'section', classes: ['a', 'b c', 'x{'] }, { id: 'bad id' }, { tag: 'div', id: 'ok', classes: ['k1', 'k2', 'k3', 'k4', 'k5'] }, { tag: 'Bad' }, 'x', { tag: 'li' }] });
  assert.deepEqual(h.path, [{ tag: 'main' }, { tag: 'section', classes: ['a'] }, { tag: 'div', id: 'ok', classes: ['k1', 'k2', 'k3', 'k4'] }, { tag: 'li' }]);
  const { event } = normalizeEvent({ file: '/x/A.jsx', kind: 'add', hint: { classes: ['l'] }, next: { classes: ['n'], path: [{ tag: 'ul', classes: ['l'] }] } });
  assert.deepEqual(event.next.path, [{ tag: 'ul', classes: ['l'] }]);
});

const htmlDoc = (body) => `<!doctype html>\n<html>\n<head><title>x</title><script>var a = "<div>";</script></head>\n<body>\n${body}\n</body>\n</html>\n`;

test('6.7 hook: sınıfsız <p> ve iç içe listede indeks yolu (yorum sayılmaz, script sayılır)', () => {
  const body = '<h1>Başlık</h1>\n<!-- yorum <p> -->\n<p>Birinci</p>\n<p>İkinci</p>\n<script>if (a < b) {}</script>\n<ul>\n  <li>a</li>\n  <li><span>b</span></li>\n</ul>';
  assert.deepEqual(one('/x/index.html', htmlDoc(body), htmlDoc(body.replace('İkinci', 'İkinci!'))).hint.ipath, [2]);
  assert.deepEqual(one('/x/index.html', htmlDoc(body), htmlDoc(body.replace('<span>b</span>', '<span>bb</span>'))).hint.ipath, [4, 1, 0]);
});

test('6.7 hook: normalize edilecek yapı / JSX / gövdesiz dosya → ipath yok', () => {
  const table = '<table>\n<tr><td>x</td></tr>\n</table>';
  assert.equal(one('/x/index.html', htmlDoc(table), htmlDoc(table.replace('x', 'y'))).hint.ipath, undefined);
  const openP = '<p>aç\n<div>blok</div>';
  assert.equal(one('/x/index.html', htmlDoc(openP), htmlDoc(openP.replace('blok', 'blok2'))).hint.ipath, undefined);
  assert.equal(one('/x/A.jsx', '<p>a</p>\n<p>b</p>\n', '<p>a</p>\n<p>bc</p>\n').hint.ipath, undefined);
  assert.equal(htmlIndexStack('<p>a</p><p>b</p>', 12), null);
});

test('6.7 daemon: ipath tam sayı dizisi, derinlik ≤ 24, 0–9999', () => {
  assert.deepEqual(normalizeHint({ tag: 'p', ipath: [1, 0, 3] }).ipath, [1, 0, 3]);
  assert.equal(normalizeHint({ tag: 'p', ipath: [1, -1] }).ipath, undefined);
  assert.equal(normalizeHint({ tag: 'p', ipath: [1.5] }).ipath, undefined);
  assert.equal(normalizeHint({ tag: 'p', ipath: [10000] }).ipath, undefined);
  assert.equal(normalizeHint({ tag: 'p', ipath: new Array(25).fill(0) }).ipath, undefined);
  assert.equal(normalizeHint({ tag: 'p', ipath: '1,2' }).ipath, undefined);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('6.8 hook: ownerOf — dosyada tanımlı bileşenler, olayın satırını kapsayan önce', () => {
  const src = [
    "import React, { memo, forwardRef } from 'react';",
    'function helper() {}',
    'export function Header() { return <header className="h" />; }',
    'const Card = memo(function Card(props) { return <div className="card" />; });',
    'export const Price = ({ value }: { value: number }) => <span className="price">{value}</span>;',
    'const Input = forwardRef<HTMLInputElement, P>((p, ref) => <input ref={ref} />);',
    'export default function Hero() {',
    '  return <section className="hero"><Card /></section>;',
    '}',
  ].join('\n');
  const o = ownerOf(src, '/x/src/Hero.tsx', 8);
  assert.equal(o.file, 'Hero.tsx');
  assert.deepEqual(o.names, ['Hero', 'Input', 'Price', 'Card']);
  assert.deepEqual(ownerOf('<template><p/></template>', '/x/Team.vue'), { names: ['Team'], file: 'Team.vue' });
  assert.equal(ownerOf('const x = 1;', '/x/util.ts'), null);
  assert.equal(ownerOf('a { color: red }', '/x/a.css'), null);
});

test('6.8 daemon: normalizeOwner yalnızca tanımlayıcı ve dosya adı geçirir', () => {
  assert.deepEqual(normalizeOwner({ names: ['Hero', 'bad name', 'x<y', 'Card'], file: 'Hero.jsx' }), { names: ['Hero', 'Card'], file: 'Hero.jsx' });
  assert.deepEqual(normalizeOwner({ names: ['A'], file: '/abs/path/Hero.jsx' }), { names: ['A'] });
  assert.equal(normalizeOwner({ names: [], file: '' }), null);
  assert.equal(normalizeOwner('Hero'), null);
  const { event } = normalizeEvent({ file: '/x/Hero.jsx', kind: 'style', hint: { classes: ['card'], owner: { names: ['Hero'], file: 'Hero.jsx' } } });
  assert.deepEqual(event.hint.owner, { names: ['Hero'], file: 'Hero.jsx' });
});

test('6.8 overlay: sahip okuyucusu bridge.js ile birebir aynı; manifest köprüyü MAIN dünyada ekler', () => {
  const block = (s) => s.slice(s.indexOf('/* owner-read:start */'), s.indexOf('/* owner-read:end */'));
  const overlay = fs.readFileSync(path.join(ROOT, 'overlay.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'extension', 'bridge.js'), 'utf8');
  assert.ok(block(bridge).includes('function ownerRead'));
  assert.equal(block(overlay), block(bridge));
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(m.content_scripts[0].js, ['overlay.js']);
  assert.equal(m.content_scripts[0].world, undefined);
  assert.deepEqual(m.content_scripts[1].js, ['bridge.js']);
  assert.equal(m.content_scripts[1].world, 'MAIN');
  assert.deepEqual(m.content_scripts[1].matches, m.content_scripts[0].matches);
  assert.equal(fs.readFileSync(path.join(ROOT, 'extension', 'overlay.js'), 'utf8'), overlay);
});

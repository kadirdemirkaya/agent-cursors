import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeEvent, enrichEvent } from '../daemon.mjs';
import { buildEvents, planPreEvents, applyFileRoutes, applyRouteHints, routeOfFile } from '../hook.mjs';

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-new-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const readerWithout = (missing) => (p) => {
  if (path.normalize(p).toLowerCase() === path.normalize(missing).toLowerCase()) throw new Error('ENOENT');
  return fs.readFileSync(p, 'utf8');
};

const NEXT_FILES = {
  'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } }),
  'tsconfig.json': '{\n  // yorumlu tsconfig\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },\n}\n',
  'src/app/layout.tsx': 'export default function L({ children }) { return <html><body className="app-body">{children}</body></html>; }\n',
  'src/app/(panel)/dashboard/page.tsx': 'export default function D() { return <main className="dash-home">Ana</main>; }\n',
  'src/app/(panel)/dashboard/team/page.tsx': 'import { TeamContent } from "@/components/team/TeamContent";\nexport default function P() { return <TeamContent />; }\n',
  'src/components/team/TeamContent.tsx': [
    'import { VendorsPanel } from "@/components/team/VendorsPanel";',
    'export function TeamContent() {',
    '  return (',
    '    <div className="team-root">',
    '      <section role="tabpanel" id="team-panel-members" className="flex flex-col gap-6"><p className="members-note">Üyeler</p></section>',
    '      <section role="tabpanel" id="team-panel-vendors" hidden className="flex flex-col gap-6">',
    '        <VendorsPanel />',
    '      </section>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
  'src/api/vendors.ts': 'export async function listVendors() { return fetch("/api/vendors"); }\n',
};
const VENDORS_PANEL = [
  'import { useState } from "react";',
  'export function VendorsPanel() {',
  '  const [open] = useState(false);',
  '  return (',
  '    <div className="vendor-toolbar flex items-center">',
  '      <table className="vendor-table w-full"><tbody><tr className="vendor-row"><td>Firma</td></tr></tbody></table>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

test('routeOfFile: Next app/pages, rota grupları, layout öneki, SvelteKit', () => {
  const root = path.join(os.tmpdir(), 'r');
  const at = (rel) => path.join(root, ...rel.split('/'));
  assert.deepEqual(routeOfFile(at('src/app/(panel)/dashboard/team/page.tsx'), root, 'next'), { url: '/dashboard/team', prefix: false });
  assert.deepEqual(routeOfFile(at('app/page.tsx'), root, 'next'), { url: '/', prefix: false });
  assert.deepEqual(routeOfFile(at('app/(panel)/dashboard/layout.tsx'), root, 'next'), { url: '/dashboard', prefix: true });
  assert.deepEqual(routeOfFile(at('app/blog/[slug]/page.tsx'), root, 'next'), { url: '/blog/[slug]', prefix: false });
  assert.equal(routeOfFile(at('app/api/x/route.ts'), root, 'next'), null);
  assert.equal(routeOfFile(at('app/feed/(..)photo/page.tsx'), root, 'next'), null);
  assert.deepEqual(routeOfFile(at('pages/settings/index.tsx'), root, 'next'), { url: '/settings', prefix: false });
  assert.equal(routeOfFile(at('pages/api/hello.ts'), root, 'next'), null);
  assert.deepEqual(routeOfFile(at('src/routes/(app)/about/+page.svelte'), root, 'sveltekit'), { url: '/about', prefix: false });
  assert.equal(routeOfFile(at('src/components/A.tsx'), root, 'next'), null);
  assert.equal(routeOfFile(at('src/pages/Projects.jsx'), root, ''), null);
});

test('yeni bileşen: bağlama yeri (kullanıldığı tabpanel) hint, sayfa URL\'si import zincirinden', () => {
  const root = project(NEXT_FILES);
  const file = path.join(root, 'src', 'components', 'team', 'VendorsPanel.tsx');
  const read = readerWithout(file);
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: VENDORS_PANEL } };
  const evs = applyFileRoutes(buildEvents(input, read), read);
  assert.ok(evs.length >= 2, 'her işaretli eleman bir olay');
  for (const ev of evs) {
    assert.equal(ev.created, true);
    assert.equal(ev.kind, 'add');
    assert.equal(ev.hint.id, 'team-panel-vendors', 'imleç içeriğin belireceği alana gider');
    assert.equal(ev.url, '/dashboard/team');
    assert.deepEqual(ev.urls, ['/dashboard/team']);
  }
  assert.ok(evs.every((ev) => ev.next && ev.next.classes.length));
  assert.ok(evs.some((ev) => ev.next.classes.includes('vendor-table')));
  assert.ok(evs.some((ev) => ev.next.classes.includes('vendor-row')));
});

test('yeni .ts yardımcı dosyası ve Node aracı imleç üretmez (eski yola da düşmez)', () => {
  const root = project(NEXT_FILES);
  const file = path.join(root, 'src', 'api', 'vendorsV2.ts');
  const read = readerWithout(file);
  assert.equal(buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: 'export const a = [1].length;\n' } }, read).length, 0);
  const api = path.join(root, 'src', 'api', 'vendors.ts');
  assert.equal(buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: api, old_string: '/api/vendors', new_string: '/api/v2/vendors' } }).length, 0);
  const comp = path.join(root, 'src', 'components', 'Old.js');
  fs.writeFileSync(comp, 'export default function Old() { return <p className="old-note">a</p>; }\n');
  const evs = buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: comp, old_string: '>a<', new_string: '>b<' } });
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].hint.classes, ['old-note']);
});

test('yeni rota sayfası: kendi URL\'si; işaretsiz olsa da tek gezinme olayı', () => {
  const root = project(NEXT_FILES);
  const file = path.join(root, 'src', 'app', '(panel)', 'dashboard', 'reports', 'page.tsx');
  const read = readerWithout(file);
  const marked = applyFileRoutes(planPreEvents({ tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: 'export default function R() { return <section className="reports-page">R</section>; }\n' } }, read), read);
  assert.equal(marked[0].url, '/dashboard/reports');
  assert.deepEqual(marked[0].next.classes, ['reports-page']);
  const bare = applyFileRoutes(planPreEvents({ tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: 'import { TeamContent } from "@/components/team/TeamContent";\nexport default function R() { return <TeamContent />; }\n' } }, read), read);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].created, true);
  assert.equal(bare[0].url, '/dashboard/reports');
});

test('var olan bileşen düzenlemesi: render eden sayfanın URL\'si (layout öneki dahil)', () => {
  const root = project(NEXT_FILES);
  const file = path.join(root, 'src', 'components', 'team', 'TeamContent.tsx');
  const evs = applyFileRoutes(buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: file, old_string: '>Üyeler<', new_string: '>Ekip üyeleri<' } }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].url, '/dashboard/team');
  assert.deepEqual(evs[0].urls, ['/dashboard/team']);
});

test('dev sunucu projesi: <Bileşen /> eklenince next, bileşenin kök elemanı olur', () => {
  const root = project({
    'package.json': JSON.stringify({ devDependencies: { vite: '8.0.0' } }),
    'src/WeatherCard.jsx': 'export default function WeatherCard() {\n  return <section className="weather-card"><b className="weather-temp">18</b></section>;\n}\n',
    'src/App.jsx': "import WeatherCard from './WeatherCard'\nexport default function App() {\n  return (\n    <main className=\"main-content\">\n      <div className=\"content-columns\">x</div>\n    </main>\n  )\n}\n",
  });
  const app = path.join(root, 'src', 'App.jsx');
  const evs = planPreEvents({ tool_name: 'Edit', cwd: root, tool_input: { file_path: app, old_string: '<div className="content-columns">', new_string: '<WeatherCard />\n      <div className="content-columns">' } });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'add');
  assert.deepEqual(evs[0].hint.classes, ['main-content']);
  assert.deepEqual(evs[0].next.classes, ['weather-card']);
  assert.equal(applyFileRoutes(evs)[0].urls, undefined, 'dosya tabanlı rota yoksa URL uydurulmaz');
});

test('routes.json görünüm eşlemesi yeni elemanın (next) sınıflarına da uygulanır', () => {
  const root = project({ '.agent-cursors/routes.json': JSON.stringify({ views: [{ match: 'weather-', view: 'Bugün' }] }) });
  const file = path.join(root, 'src', 'W.jsx');
  const fresh = applyRouteHints([{ file, kind: 'add', hint: { id: '', classes: [], tag: '', text: '' }, next: { id: '', classes: ['weather-card'], tag: '', text: '' } }], root)[0];
  assert.equal(fresh.next.view, 'Bugün');
  assert.equal(fresh.hint.view, 'Bugün', 'hint boşsa görünüm hint\'e de taşınır');
  const mount = applyRouteHints([{ file, kind: 'add', hint: { id: '', classes: ['main-content'], tag: '', text: '' }, next: { id: '', classes: ['weather-card'], tag: '', text: '' } }], root)[0];
  assert.equal(mount.next.view, 'Bugün');
  assert.equal(mount.hint.view, undefined, 'ortak ebeveynin görünümü uydurulmaz');
});

test('daemon: urls ve created korunur; created olayın hint\'i dosyadan doldurulmaz', async () => {
  const n = normalizeEvent({ file: '/p/A.tsx', kind: 'add', created: true, urls: ['/dashboard/team', '/*', 'javascript:alert(1)', 5], next: { classes: ['x'] } });
  assert.equal(n.ok, true);
  assert.deepEqual(n.event.urls, ['/dashboard/team', '/*']);
  assert.equal(n.event.created, true);
  const enriched = await enrichEvent(n.event, async () => '<div class="from-file">x</div>');
  assert.deepEqual(enriched.hint.classes, []);
  const plain = await enrichEvent(normalizeEvent({ file: '/p/A.html', startLine: 1 }).event, async () => '<div class="from-file">x</div>');
  assert.deepEqual(plain.hint.classes, ['from-file']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { normalizeEvent, normalizeHint, startDaemon } from '../daemon.mjs';
import { eventsFromChange, eventsFromStructuredTool, planPreEvents, visualTargets } from '../hook.mjs';

const PROJECTS = `<section className="projects-summary">Özet</section>
<section className="project-grid">{projects.map((project) => <article className={\`project-card \${project.color}\`}><div className="project-card-top"><h2>{project.title}</h2></div></article>)}</section>
<button className="projects-toolbar">Filtrele</button>`;

test('visualTargets: tek satırdaki map kartını repeat olarak ve ayrı hedefler olarak çıkarır', () => {
  const targets = visualTargets(PROJECTS, '/demo/src/App.jsx');
  const card = targets.find((target) => target.hint.classes.includes('project-card'));
  assert.ok(card, 'project-card hedefi bulunmalı');
  assert.equal(card.hint.repeat, true);
  assert.ok(targets.some((target) => target.hint.classes.includes('project-grid')));
  assert.ok(targets.length >= 3);
});

test('Write/plan yolları tüm görünür hedefleri taşır', () => {
  const structured = eventsFromStructuredTool({
    tool_name: 'structured_write', cwd: '/demo', tool_input: { file_path: 'src/App.jsx', content: PROJECTS },
  }, () => { throw new Error('yeni dosya'); });
  assert.ok(structured.length >= 3);
  assert.ok(structured.some((event) => event.hint.repeat === true));

  const planned = planPreEvents({
    tool_name: 'Write', cwd: '/demo', tool_input: { file_path: 'src/App.jsx', content: PROJECTS },
  }, () => { throw new Error('yeni dosya'); });
  assert.ok(planned.length >= 3);
  assert.ok(planned.every((event) => event.next || event.hint.repeat));
});

test('eventsFromChange: map kartının iç değişimi repeat hedefini korur', () => {
  const before = `<section className="project-grid">{projects.map((project) => <article className={\`project-card \${project.color}\`}><h2>{project.title} Eski</h2></article>)}</section>`;
  const after = before.replace('Eski', 'Yeni');
  const [event] = eventsFromChange('/demo/src/App.jsx', before, after);
  assert.ok(event.hint.classes.includes('project-card'));
  assert.equal(event.hint.repeat, true);
});

test('eventsFromChange: map veri dizisindeki değişimi kartların tamamına bağlar', () => {
  const before = `const projects = [{ title: 'Eski' }];
export function App() { return <section className="project-grid">{projects.map((project) => <article className={\`project-card \${project.color}\`}>{project.title}</article>)}</section>; }`;
  const after = before.replace("'Eski'", "'Yeni'");
  const [event] = eventsFromChange('/demo/src/App.jsx', before, after);
  assert.ok(event.hint.classes.includes('project-card'));
  assert.equal(event.hint.repeat, true);
});

test('normalizeHint/Event: nth, repeat, view ve url korunur', () => {
  const hint = normalizeHint({ classes: ['project-card'], nth: 2, repeat: true, view: 'Projelerim', url: '/projects' });
  assert.deepEqual(hint, { id: '', classes: ['project-card'], tag: '', text: '', nth: 2, repeat: true, view: 'Projelerim', url: '/projects' });
  const event = normalizeEvent({ file: '/demo/src/App.jsx', url: '/projects', hint }).event;
  assert.equal(event.url, '/projects');
  assert.equal(event.hint.nth, 2);
  assert.equal(event.hint.repeat, true);
  assert.equal(event.hint.view, 'Projelerim');
});

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('daemon: /history son N olayı döndürür', async () => {
  const daemon = await startDaemon({ port: 0 });
  try {
    daemon.broadcast(normalizeEvent({ id: 'history-1', file: '/x/a.html' }).event);
    daemon.broadcast(normalizeEvent({ id: 'history-2', file: '/x/b.html' }).event);
    const response = await request(daemon.port, '/history?limit=1');
    const body = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].event.id, 'history-2');
  } finally {
    await daemon.close();
  }
});

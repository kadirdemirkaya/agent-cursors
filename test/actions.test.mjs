import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { buildActions } from '../hook.mjs';
import { enrichEvent, normalizeEvent, startDaemon } from '../daemon.mjs';

const PATCH = `*** Begin Patch
*** Update File: src/Service.cs
@@
-old line
+new line
+another line
*** End Patch`;

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function connectSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events?cid=actions&v=1' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      resolve({
        close: () => req.destroy(),
        events: () => text.split('\n').filter((line) => line.startsWith('data: {"id"')).map((line) => JSON.parse(line.slice(6))),
      });
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('buildActions: apply_patch görsel olmayan dosyayı file/edit olarak üretir', () => {
  const actions = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'apply_patch', cwd: '/workspace', tool_input: { command: PATCH },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].surface, 'file');
  assert.equal(actions[0].action, 'edit');
  assert.equal(path.basename(actions[0].file), 'Service.cs');
  assert.deepEqual(actions[0].meta, { added: 2, removed: 1 });
});

test('buildActions: FE (görsel) dosya da HUD aksiyonu üretir (overlay fe modu bunları gösterir)', () => {
  const patch = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'apply_patch', cwd: '/workspace', tool_input: {
      command: PATCH.replace('Service.cs', 'App.html'),
    },
  });
  assert.equal(patch.length, 1);
  assert.equal(patch[0].surface, 'file');
  assert.equal(path.basename(patch[0].file), 'App.html');

  const edit = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/workspace',
    tool_input: { file_path: 'src/App.jsx', old_string: '<h1>A</h1>', new_string: '<h1>B</h1>\n<p>x</p>' },
  });
  assert.equal(edit[0].text, 'Edited App.jsx (+2/−1)');
});

test('buildActions: Edit ve Write file aksiyonları üretir', () => {
  const edit = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/workspace',
    tool_input: { file_path: 'src/app.py', old_string: 'before\n', new_string: 'after\nnext' },
  });
  assert.equal(edit[0].surface, 'file');
  assert.equal(edit[0].action, 'edit');
  assert.deepEqual(edit[0].meta, { added: 2, removed: 1 });

  const write = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: '/workspace',
    tool_input: { file_path: 'src/new.py', content: 'one\ntwo\n' }, tool_response: { type: 'create' },
  });
  assert.equal(write[0].action, 'add');
  assert.deepEqual(write[0].meta, { added: 2, removed: 0 });
});

test('buildActions: Bash PostToolUse shell/run aksiyonu üretir', () => {
  const actions = buildActions({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' },
    tool_response: { exit_code: 0, duration_ms: 1200 },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].surface, 'shell');
  assert.equal(actions[0].action, 'run');
  assert.equal(actions[0].meta.command, 'npm test');
  assert.equal(actions[0].meta.exit, 0);
});

test('buildActions: TodoWrite plan aksiyonu, PreToolUse ise boş üretir', () => {
  const plan = buildActions({ hook_event_name: 'PostToolUse', tool_name: 'TodoWrite' });
  assert.deepEqual([plan[0].surface, plan[0].action], ['plan', 'plan']);
  assert.deepEqual(buildActions({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite' }), []);
});

test('normalizeEvent: DOM dışı aksiyon, legacy DOM ve boş payload', () => {
  const action = normalizeEvent({ surface: 'shell', action: 'run', meta: { command: 'npm test', nested: { no: true } }, text: '$ npm test' });
  assert.equal(action.ok, true);
  assert.equal(action.event.file, '');
  assert.equal(action.event.surface, 'shell');
  assert.deepEqual(action.event.meta, { command: 'npm test' });
  assert.equal(normalizeEvent({}).ok, false);
  assert.equal(normalizeEvent({ file: 'a.html', startLine: 1, endLine: 1, kind: 'edit' }).event.surface, 'dom');
});

test('enrichEvent: DOM dışı olay dosyaya dokunmadan korunur', async () => {
  const event = normalizeEvent({ surface: 'shell', action: 'run', text: '$ npm test' }).event;
  let reads = 0;
  const result = await enrichEvent(event, async () => { reads++; return 'should not read'; });
  assert.equal(reads, 0);
  assert.deepEqual(result, event);
});

test('daemon: DOM dışı batch hold istese bile bekletilmez', async () => {
  const daemon = await startDaemon({ port: 0 });
  const sse = await connectSse(daemon.port);
  try {
    const response = await request(daemon.port, 'POST', '/batch', {
      group: 'action-hold', phase: 'post', hold: true, holdMs: 5000,
      events: [{ surface: 'shell', action: 'run', text: '$ npm test' }],
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.held, false);
  } finally {
    sse.close();
    await daemon.close();
  }
});

test("daemon: DOM pre bekletilir, :act grubu post dedupe'a takılmaz", async () => {
  const daemon = await startDaemon({ port: 0 });
  const sse = await connectSse(daemon.port);
  try {
    const started = Date.now();
    const pre = await request(daemon.port, 'POST', '/batch', {
      group: 'dom-and-act', phase: 'pre', hold: true, holdMs: 200,
      events: [{ id: 'dom-wait', file: '/x/a.html', startLine: 1, endLine: 1, kind: 'edit' }],
    });
    assert.equal(pre.json.held, true);
    assert.ok(Date.now() - started >= 150, 'DOM pre batch ACK/zaman aşımını beklemeli');

    const action = await request(daemon.port, 'POST', '/batch', {
      group: 'dom-and-act:act', phase: 'post', hold: false,
      events: [{ id: 'action-after-pre', surface: 'shell', action: 'run', text: '$ npm test' }],
    });
    assert.equal(action.json.skipped, undefined);
    await sleep(20);
    assert.ok(sse.events().some((event) => event.id === 'action-after-pre'));
  } finally {
    sse.close();
    await daemon.close();
  }
});

import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const HOST = '127.0.0.1';
const ORDER = ['resize', 'text', 'style', 'add', 'remove'];

const SCENARIOS = {
  resize: { file: 'src/Hero.jsx', startLine: 12, endLine: 18, hint: { id: 'hero', classes: [], tag: 'section', text: '' } },
  text: { file: 'src/Navbar.jsx', startLine: 8, endLine: 8, hint: { id: '', classes: ['nav-link'], tag: 'a', text: 'Fiyatlar' } },
  style: { file: 'src/Button.css', startLine: 4, endLine: 9, hint: { id: 'cta-button', classes: ['btn-primary'], tag: 'button', text: '' } },
  add: { file: 'src/Perks.jsx', startLine: 30, endLine: 34, hint: { id: 'perks', classes: [], tag: 'ul', text: '' } },
  remove: { file: 'src/Cards.jsx', startLine: 40, endLine: 52, hint: { id: '', classes: ['card--old'], tag: 'article', text: '' } },
  edit: { file: 'src/Form.jsx', startLine: 21, endLine: 23, hint: { id: 'email', classes: [], tag: 'input', text: '' } },
};

const { values } = parseArgs({
  options: {
    kind: { type: 'string', default: 'all' },
    delay: { type: 'string', default: '3200' },
    port: { type: 'string', default: process.env.AGENT_CURSORS_PORT || '7373' },
    hold: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Kullanım: node simulate.mjs --kind resize|text|style|add|remove|edit|all [--delay 3200] [--port 7373] [--hold]');
  process.exit(0);
}

const port = Number(values.port) || 7373;
const delay = Math.max(0, Number(values.delay) || 0);
const kinds = values.kind === 'all' ? ORDER : [values.kind];
for (const k of kinds) {
  if (!SCENARIOS[k]) {
    console.error(`Bilinmeyen tür: ${k}. Geçerli: ${Object.keys(SCENARIOS).join(', ')}, all`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: HOST,
        port,
        path,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

try {
  await request('GET', '/health');
} catch {
  console.error(`Daemon çalışmıyor (http://${HOST}:${port}). Önce şunu çalıştırın:  node daemon.mjs`);
  process.exit(1);
}

let warned = false;
for (let i = 0; i < kinds.length; i++) {
  const kind = kinds[i];
  const sc = SCENARIOS[kind];
  const t0 = Date.now();
  const res = values.hold
    ? await request('POST', '/batch', { group: crypto.randomUUID(), phase: 'pre', hold: true, holdMs: 2200, events: [{ id: crypto.randomUUID(), kind, ...sc }] })
    : await request('POST', '/event', { id: crypto.randomUUID(), kind, ...sc });
  if (res.status !== 200 || !res.json || !res.json.ok) {
    console.error(`✗ ${kind}: daemon olayı reddetti (HTTP ${res.status})`);
    process.exit(1);
  }
  console.log(`▶ ${kind.padEnd(6)} → ${sc.file.split('/').pop()}:${sc.startLine}-${sc.endLine}  (bağlı tarayıcı: ${res.json.clients})${values.hold ? `  imleç varışı: ${res.json.acked ? Date.now() - t0 + ' ms' : 'ack yok (zaman aşımı/sekme yok)'}` : ''}`);
  if (res.json.clients === 0 && !warned) {
    warned = true;
    console.warn('  ! Bağlı tarayıcı yok. demo.html dosyasını tarayıcıda açın (overlay.js SSE\'ye bağlanır).');
  }
  if (i < kinds.length - 1) await sleep(delay);
}
console.log('Bitti.');

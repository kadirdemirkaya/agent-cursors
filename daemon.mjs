import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 7373;

export const PROTOCOL = 5;
export const KINDS = Object.freeze(['resize', 'text', 'style', 'add', 'remove', 'edit', 'read']);
const SURFACES = new Set(['dom', 'file', 'shell', 'git', 'test', 'plan']);

const META_KEYS = new Set(['added', 'removed', 'exit', 'durationMs', 'command', 'outside']);

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SPAN = 40;
const HISTORY_SIZE = 200;
const REPLAY_WINDOW_MS = 8000;
const PING_MS = 10000;
const DEFAULT_HOLD_MS = 2500;
const MAX_HOLD_MS = 6000;
const GROUP_TTL_MS = 60000;

const READABLE_EXT = new Set([
  '.html', '.htm', '.xhtml', '.jsx', '.tsx', '.js', '.mjs', '.cjs', '.ts', '.mts',
  '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less', '.styl',
  '.md', '.mdx', '.php', '.erb', '.ejs', '.hbs', '.njk', '.liquid', '.twig',
  '.pug', '.cshtml', '.razor', '.svg',
]);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl']);

export const emptyHint = () => ({ id: '', classes: [], tag: '', text: '' });

const isValidClass = (c) => typeof c === 'string' && c.length > 0 && c.length <= 80 && !/[\s{}$`'"<>]/.test(c);
const isValidId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\s{}$`'"<>]/.test(s);

export function normalizeHint(h) {
  const o = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const classes = Array.isArray(o.classes)
    ? [...new Set(o.classes.filter(isValidClass))].slice(0, 12)
    : [];
  const id = str(o.id, 200);
  const hint = {
    id: isValidId(id) ? id : '',
    classes,
    tag: str(o.tag, 40).toLowerCase(),
    text: str(o.text, 120),
  };
  const nth = Math.floor(Number(o.nth));
  if (Number.isFinite(nth) && nth >= 0) hint.nth = nth;
  if (typeof o.repeat === 'boolean') hint.repeat = o.repeat;
  const view = str(o.view, 60);
  if (view) hint.view = view;
  const url = str(o.url, 300);
  if (url && !/[\u0000-\u001f\u007f]/.test(url)) hint.url = url;
  const selector = cleanSelectorText(o.selector);
  if (selector) hint.selector = selector;
  const path = normalizePath(o.path);
  if (path.length) hint.path = path;
  if (Array.isArray(o.ipath) && o.ipath.length && o.ipath.length <= 24 && o.ipath.every((n) => Number.isInteger(n) && n >= 0 && n <= 9999)) hint.ipath = o.ipath.slice();
  const owner = normalizeOwner(o.owner);
  if (owner) hint.owner = owner;
  return hint;
}

export function normalizeOwner(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const names = Array.isArray(v.names) ? [...new Set(v.names.filter((n) => typeof n === 'string' && /^[A-Za-z_$][\w$]{0,60}$/.test(n)))].slice(0, 4) : [];
  const file = typeof v.file === 'string' && /^[^\\/\u0000-\u001f\u007f<>"'`]{1,80}$/.test(v.file) ? v.file : '';
  if (!names.length && !file) return null;
  const out = { names };
  if (file) out.file = file;
  return out;
}

export function normalizePath(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v.slice(0, 8)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const tag = typeof item.tag === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(item.tag) ? item.tag : '';
    const id = typeof item.id === 'string' && isValidId(item.id) ? item.id : '';
    const classes = Array.isArray(item.classes) ? [...new Set(item.classes.filter(isValidClass))].slice(0, 4) : [];
    if (!tag && !id && !classes.length) continue;
    const o = {};
    if (tag) o.tag = tag;
    if (id) o.id = id;
    if (classes.length) o.classes = classes;
    out.push(o);
  }
  return out.slice(-4);
}

export function cleanSelectorText(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 200 || /[\u0000-\u001f\u007f{}`;<]/.test(s) || s.includes('&')) return '';
  return s;
}

export function normalizeCssProps(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((p) => typeof p === 'string' && p.length <= 40 && /^-{0,2}[a-z][a-z0-9-]*$/.test(p)))].slice(0, 8);
}

export function hasHint(h) {
  return !!(h && (h.id || h.tag || h.text || h.selector || (h.classes && h.classes.length)));
}

export function normalizeDelta(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const clip = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) : '');
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map(clip).filter(Boolean))].slice(0, 6) : []);
  const out = {};
  const from = clip(d.from);
  const to = clip(d.to);
  if (from && to) { out.from = from; out.to = to; }
  const removed = list(d.removed);
  const added = list(d.added);
  if (removed.length) out.removed = removed;
  if (added.length) out.added = added;
  const el = clip(d.el);
  if (el && /^[A-Za-z][\w.:-]*$/.test(el)) out.el = el;
  if (d.size && typeof d.size === 'object') {
    const dir = (v) => (v === 1 || v === -1 ? v : 0);
    const size = { w: dir(d.size.w), h: dir(d.size.h) };
    if (size.w || size.h) out.size = size;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeMeta(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const meta = {};
  for (const key of META_KEYS) {
    const item = source[key];
    if (typeof item === 'string') meta[key] = item.slice(0, 200);
    else if (typeof item === 'boolean') meta[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) meta[key] = item;
  }
  return meta;
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'olay bir nesne olmalı' };
  }
  const surface = SURFACES.has(raw.surface) ? raw.surface : (raw.file ? 'dom' : 'file');
  const file = typeof raw.file === 'string' ? raw.file.trim() : '';
  const action = typeof raw.action === 'string' ? raw.action.trim().slice(0, 40) : '';
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 200) : '';
  const meta = normalizeMeta(raw.meta);
  if (surface === 'dom' && !file) {
    return { ok: false, error: 'file zorunlu' };
  }
  if (surface !== 'dom' && !file && !action && !text && !Object.keys(meta).length) {
    return { ok: false, error: 'aksiyon bilgisi zorunlu' };
  }
  const toLine = (v, d) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : d;
  };
  const startLine = toLine(raw.startLine, 1);
  let endLine = toLine(raw.endLine, startLine);
  if (endLine < startLine) endLine = startLine;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'edit';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 100) : crypto.randomUUID();
  const event = { id, surface, file, startLine, endLine, kind, hint: normalizeHint(raw.hint) };
  if (action) event.action = action;
  if (Object.keys(meta).length) event.meta = meta;
  if (text) event.text = text;
  if (raw.phase === 'pre' || raw.phase === 'post') event.phase = raw.phase;
  const url = typeof raw.url === 'string' ? raw.url.trim().slice(0, 300) : event.hint.url || '';
  if (url && !/[\u0000-\u001f\u007f]/.test(url)) event.url = url;
  if (Array.isArray(raw.urls)) {
    const urls = [...new Set(raw.urls.filter((u) => typeof u === 'string' && u.startsWith('/') && u.length <= 300 && !/[\u0000-\u001f\u007f]/.test(u)))].slice(0, 8);
    if (urls.length) event.urls = urls;
  }
  if (raw.created === true) event.created = true;
  if (raw.next && typeof raw.next === 'object') {
    const next = normalizeHint(raw.next);
    if (hasHint(next)) event.next = next;
  }
  const delta = normalizeDelta(raw.delta);
  if (delta) event.delta = delta;
  const cssProps = normalizeCssProps(raw.cssProps);
  if (cssProps.length) event.cssProps = cssProps;
  if (raw.anchor === 'component') event.anchor = 'component';
  if (raw.agent === 'claude' || raw.agent === 'codex') event.agent = raw.agent;
  if (typeof raw.session === 'string' && /^[a-f0-9]{4,16}$/.test(raw.session)) event.session = raw.session;
  return { ok: true, event };
}

export function mergeHint(provided, auto) {
  return hasHint(provided) ? provided : auto || emptyHint();
}

const TAG_RE = /(?<![\w$)\]])<([A-Za-z][\w.:-]*)((?:=>|[^<>])*)/g;
const ID_RE = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`$]*)["'`]\s*\})/;
const CLASS_RE = /(?:^|\s)(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\}|\{\s*["']([^"']*)["']\s*\})/;
const CLASS_EXPR_RE = /(?:^|\s)(?:class|className)\s*=\s*\{[^}]*?["'`]([^"'`$]+)["'`]/;
const CODEISH_RE = /[=;(){}[\]<>]|=>|^\s*(?:import|export|const|let|var|function|return|if|else|for|while)\b|^\/\//;
const CSS_DECL_RE = /^[a-z-]+\s*:\s*\S/;
const SELECTOR_LINE_RE = /^\s*([^{};@/][^{};]*)\{/;

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v)) || lo));
const domTag = (name) => (/^[a-z][a-z0-9-]*$/.test(name || '') ? name : '');

function splitClasses(raw) {
  return [...new Set(String(raw || '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(isValidClass))].slice(0, 12);
}

function parseAttrs(attrs) {
  let id = '';
  const im = ID_RE.exec(attrs);
  if (im) {
    const v = (im[1] ?? im[2] ?? im[3] ?? '').trim();
    if (isValidId(v)) id = v;
  }
  let raw = '';
  const cm = CLASS_RE.exec(attrs);
  if (cm) raw = cm[1] ?? cm[2] ?? cm[3] ?? cm[4] ?? '';
  else {
    const em = CLASS_EXPR_RE.exec(attrs);
    if (em) raw = em[1];
  }
  return { id, classes: splitClasses(raw) };
}

function findElements(chunk) {
  const out = [];
  for (const m of chunk.matchAll(TAG_RE)) {
    out.push({ name: m[1], ...parseAttrs(m[2] || '') });
  }
  return out;
}

function pickElement(els) {
  return els.find((e) => e.id) || els.find((e) => e.classes.length) || els[0] || null;
}

function findOpeningTagAbove(lines, idx) {
  for (let i = idx; i >= 0 && i > idx - 30; i--) {
    const ms = [...lines[i].matchAll(TAG_RE)];
    if (ms.length) return ms[ms.length - 1][1];
  }
  return '';
}

function extractText(chunk) {
  let t = chunk
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/^[^<>]*?(?<!=)>/, '');
  t = t.replace(/<\/?[A-Za-z][^<>]*>?/g, '\n');
  for (let i = 0; i < 3; i++) t = t.replace(/\{[^{}]*\}/g, ' ');
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  let best = '';
  for (const raw of t.split(/\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 2 || !/\p{L}/u.test(s)) continue;
    if (CODEISH_RE.test(s) || CSS_DECL_RE.test(s)) continue;
    if (s.length > best.length) best = s;
  }
  if (best.length > 60) {
    const cut = best.slice(0, 60);
    const sp = cut.lastIndexOf(' ');
    best = (sp > 30 ? cut.slice(0, sp) : cut).trim();
  }
  return best;
}

function looksLikeSelector(sel) {
  const s = sel.trim();
  if (!s) return false;
  if (/^(?:if|else|for|while|switch|function|class|const|let|var|return|try|catch|do|async|export|import|static)\b/.test(s)) return false;
  const stripped = s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
  return !/[=;]/.test(stripped) && (/[.#\w*&]/.test(stripped) || /^\[[^\]]+\]/.test(s));
}

function parseSelector(sel) {
  const first = sel.split(',')[0].trim();
  const compound = (first.split(/[\s>+~]+/).filter(Boolean).pop() || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/::?[\w-]+(\([^)]*\))?/g, '');
  const tm = /^([a-zA-Z][\w-]*)/.exec(compound);
  const idm = /#([\w-]+)/.exec(compound);
  const classes = [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return {
    id: idm ? idm[1] : '',
    classes: splitClasses(classes.join(' ')),
    tag: tm ? domTag(tm[1].toLowerCase()) : '',
    text: '',
  };
}

export function cssNestDepth(lines, idx) {
  let from = Math.max(0, idx - 600);
  for (let i = idx - 1; i >= from; i--) if (/<style\b/i.test(lines[i])) { from = i + 1; break; }
  const stack = [];
  for (let i = from; i < idx && i < lines.length; i++) {
    const t = lines[i].replace(/\/\*.*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
    let head = '';
    for (const ch of t) {
      if (ch === '{') { stack.push(head.trim().startsWith('@') ? '@' : 'r'); head = ''; }
      else if (ch === '}') { stack.pop(); head = ''; }
      else if (ch === ';') head = '';
      else head += ch;
    }
    if (!/[{};]/.test(t)) head = '';
  }
  return stack.filter((k) => k === 'r').length;
}

function cssHintFor(lines, s, e) {
  const found = cssSelectorFor(lines, s, e, true);
  if (!found) return emptyHint();
  const h = parseSelector(found.sel);
  const selector = cleanSelectorText(found.sel);
  if (selector && cssNestDepth(lines, found.line) === 0) h.selector = selector;
  return h;
}

function cssSelectorFor(lines, s, e, withLine = false) {
  const out = (sel, line) => (withLine ? (sel ? { sel, line } : null) : sel);
  for (let i = s - 1; i <= e - 1 && i < lines.length; i++) {
    const m = SELECTOR_LINE_RE.exec(lines[i]);
    if (m && looksLikeSelector(m[1])) return out(m[1].trim(), i);
  }
  let depth = 0;
  for (let i = s - 2; i >= 0 && i > s - 202; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    const opens = (t.match(/\{/g) || []).length;
    const closes = (t.match(/\}/g) || []).length;
    const net = opens - closes;
    if (net < 0) { depth += -net; continue; }
    if (net === 0) continue;
    if (depth >= net) { depth -= net; continue; }
    if (t.startsWith('@')) continue;
    let selText = '';
    const m = SELECTOR_LINE_RE.exec(lines[i]);
    if (m) selText = m[1];
    else if (t.startsWith('{')) {
      for (let k = i - 1; k >= 0; k--) {
        if (lines[k].trim()) { selText = lines[k]; break; }
      }
    }
    return out(looksLikeSelector(selText) ? selText.trim() : '', i);
  }
  return out('', 0);
}

function scriptQueryHint(chunk) {
  const out = emptyHint();
  const gid = /getElementById\(\s*["'`]([^"'`$]+)["'`]/.exec(chunk);
  if (gid && isValidId(gid[1])) out.id = gid[1];
  const qs = /querySelector(?:All)?\(\s*["'`]([^"'`$]+)["'`]/.exec(chunk);
  if (qs) {
    const h = parseSelector(qs[1]);
    if (!out.id) out.id = h.id;
    out.classes = h.classes;
    out.tag = h.tag;
  }
  return hasHint(out) ? out : null;
}

export function extractHint(source, startLine, endLine, opts = {}) {
  if (typeof source !== 'string' || !source) return emptyHint();
  const lines = source.split(/\r?\n/);
  const total = lines.length;
  const s = clampInt(startLine, 1, total);
  let e = clampInt(endLine, s, total);
  if (s === 1 && e >= total && total > MAX_SPAN) return emptyHint();
  if (e - s + 1 > MAX_SPAN) e = s + MAX_SPAN - 1;

  const ext = path.extname(opts.file || '').toLowerCase();
  const chunk = lines.slice(s - 1, e).join('\n');

  if (STYLE_EXT.has(ext)) return cssHintFor(lines, s, e);

  const els = findElements(chunk);
  let el = pickElement(els);
  if (!el) {
    const a = parseAttrs(' ' + chunk);
    if (a.id || a.classes.length) el = { name: findOpeningTagAbove(lines, s - 2), ...a };
  }
  if (el) {
    return {
      id: el.id,
      classes: el.classes,
      tag: domTag(el.name),
      text: extractText(chunk),
    };
  }

  if (/[\w-]+\s*:\s*[^;{}]+;?/.test(chunk) || /\{/.test(chunk)) {
    const h = cssHintFor(lines, s, e);
    if (hasHint(h)) return h;
  }

  const q = scriptQueryHint(chunk);
  if (q) return q;

  const text = extractText(chunk);
  return { ...emptyHint(), text };
}

export async function readSource(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (!READABLE_EXT.has(ext)) return null;
  const st = await fsp.stat(file);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  return fsp.readFile(file, 'utf8');
}

export async function enrichEvent(ev, readFile = readSource) {
  if (ev.surface && ev.surface !== 'dom') return ev;
  if (!ev.file) return ev;
  if (ev.created) return ev;
  let src = null;
  try {
    src = await readFile(ev.file);
  } catch {
    src = null;
  }
  const auto = typeof src === 'string' ? extractHint(src, ev.startLine, ev.endLine, { file: ev.file }) : emptyHint();
  return { ...ev, hint: mergeHint(ev.hint, auto) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('gövde çok büyük'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const formatSSE = (seq, event) => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;

export function createDaemon(options = {}) {
  const { overlayPath = path.join(__dirname, 'overlay.js'), readFile = readSource, log = () => {} } = options;
  const clients = new Set();
  const history = [];
  const gates = new Map();
  const groups = new Map();
  const preIds = new Map();
  let seq = 0;

  const visibleCount = () => {
    let n = 0;
    for (const c of clients) if (!c._ac || c._ac.visible !== false) n++;
    return n;
  };

  function seenGroup(group) {
    const now = Date.now();
    for (const [k, t] of groups) if (now - t > GROUP_TTL_MS) groups.delete(k);
    return !!group && groups.has(group);
  }

  function waitForAck(id, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setTimeout(() => { gates.delete(id); resolve({ acked: false, waited: Date.now() - t0 }); }, ms);
      gates.set(id, { release: () => { clearTimeout(timer); gates.delete(id); resolve({ acked: true, waited: Date.now() - t0 }); } });
    });
  }

  function signalApplied(group) {
    const base = String(group || '').replace(/:(?:act|fs|read)$/, '');
    const entry = base ? preIds.get(base) : null;
    if (!entry) return 0;
    preIds.delete(base);
    const frame = `event: applied\ndata: ${JSON.stringify({ ids: entry.ids })}\n\n`;
    for (const c of [...clients]) {
      try {
        c.write(frame);
      } catch {
        clients.delete(c);
      }
    }
    return entry.ids.length;
  }

  function rememberPre(group, list) {
    const now = Date.now();
    for (const [k, v] of preIds) if (now - v.at > GROUP_TTL_MS) preIds.delete(k);
    const ids = list.filter((ev) => ev.surface === 'dom' && ev.phase === 'pre').map((ev) => ev.id);
    if (group && ids.length) preIds.set(group, { at: now, ids: ids.slice(0, 30) });
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function broadcast(event) {
    seq += 1;
    history.push({ seq, at: Date.now(), event });
    if (history.length > HISTORY_SIZE) history.shift();
    const frame = formatSSE(seq, event);
    for (const c of [...clients]) {
      try {
        c.write(frame);
      } catch {
        clients.delete(c);
      }
    }
    return clients.size;
  }

  async function serveOverlay(res) {
    try {
      const body = await fsp.readFile(overlayPath);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      json(res, 404, { ok: false, error: 'overlay.js bulunamadı' });
    }
  }

  function serveEvents(req, res, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setKeepAlive(true);
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.write('retry: 1500\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, version: 1, protocol: PROTOCOL })}\n\n`);

    const lastRaw = req.headers['last-event-id'] || url.searchParams.get('last');
    const last = lastRaw ? Number(lastRaw) : NaN;
    if (Number.isFinite(last) && last >= 0) {
      const now = Date.now();
      for (const h of history) {
        if (h.seq > last && now - h.at <= REPLAY_WINDOW_MS) res.write(formatSSE(h.seq, h.event));
      }
    }
    res._ac = { cid: String(url.searchParams.get('cid') || '').slice(0, 64), visible: url.searchParams.get('v') !== '0' };
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function serveHistory(res, url) {
    const wanted = Math.floor(Number(url.searchParams.get('limit')));
    const limit = Number.isFinite(wanted) ? Math.min(HISTORY_SIZE, Math.max(1, wanted)) : 20;
    const items = history.slice(-limit).map((item) => ({ seq: item.seq, at: item.at, event: item.event }));
    return json(res, 200, { ok: true, events: items });
  }

  async function parseJson(req, res) {
    try {
      return JSON.parse(await readBody(req));
    } catch (err) {
      json(res, err && err.status === 413 ? 413 : 400, { ok: false, error: 'geçersiz gövde' });
      return undefined;
    }
  }

  async function receiveBatch(rawList, opts, res) {
    const group = typeof opts.group === 'string' ? opts.group.slice(0, 120) : '';
    const phase = opts.phase === 'pre' ? 'pre' : opts.phase === 'post' ? 'post' : '';
    if (phase === 'post') signalApplied(group);
    if (phase === 'post' && seenGroup(group)) {
      return json(res, 200, { ok: true, skipped: true, clients: clients.size });
    }
    const list = [];
    for (const raw of Array.isArray(rawList) ? rawList.slice(0, 30) : []) {
      const n = normalizeEvent(raw);
      if (!n.ok) return json(res, 400, { ok: false, error: n.error });
      if (phase && !n.event.phase) n.event.phase = phase;
      list.push(await enrichEvent(n.event, readFile));
    }
    if (!list.length) return json(res, 400, { ok: false, error: 'olay yok' });
    if (group) groups.set(group, Date.now());
    if (phase === 'pre') rememberPre(group, list);

    const visible = visibleCount();
    const hold = !!opts.hold && visible > 0 && list.some((ev) => ev.surface === 'dom' && ev.phase === 'pre');
    const holdMs = Math.min(MAX_HOLD_MS, Math.max(100, Number(opts.holdMs) || DEFAULT_HOLD_MS));
    let delivered = 0;
    const gateIds = hold ? list.map((ev) => ev.id) : [];
    const waits = gateIds.map((id) => waitForAck(id, holdMs));
    list.forEach((ev) => {
      const out = hold
        ? { ...ev, gate: true, ...(opts.paintAck === true ? { paintAck: true } : {}) }
        : ev;
      delivered = broadcast(out);
      const label = ev.text || (ev.file ? path.basename(ev.file) : '') || ev.action || 'action';
      log(`[agent-cursors] ${ev.phase || '-'} ${ev.surface || 'dom'}/${ev.action || ev.kind} ${label} → ${delivered} tarayıcı${out.gate ? ' (bekletiliyor)' : ''}`);
    });
    const results = waits.length ? await Promise.all(waits) : [];
    const acked = results.length > 0 && results.every((result) => result.acked);
    const waited = results.length ? Math.max(...results.map((result) => result.waited)) : 0;
    return json(res, 200, {
      ok: true, id: list[0].id, ids: list.map((e) => e.id), clients: delivered, visible,
      held: gateIds.length > 0, acked, waited,
    });
  }

  async function receiveEvent(req, res) {
    const body = await parseJson(req, res);
    if (body === undefined) return undefined;
    const n = normalizeEvent(body);
    if (!n.ok) return json(res, 400, { ok: false, error: n.error });
    return receiveBatch([body], { hold: !!body.hold, holdMs: body.holdMs, group: body.group, phase: body.phase, paintAck: body.paintAck }, res);
  }

  async function receiveBatchRequest(req, res) {
    const body = await parseJson(req, res);
    if (body === undefined) return undefined;
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'geçersiz gövde' });
    return receiveBatch(body.events, body, res);
  }

  async function receiveAck(req, res) {
    const body = await parseJson(req, res);
    if (body === undefined) return undefined;
    const g = body && typeof body.id === 'string' ? gates.get(body.id) : null;
    if (g) g.release();
    return json(res, 200, { ok: true, released: !!g });
  }

  async function receiveVis(req, res) {
    const body = await parseJson(req, res);
    if (body === undefined) return undefined;
    if (body && typeof body.cid === 'string') {
      for (const c of clients) if (c._ac && c._ac.cid === body.cid) c._ac.visible = body.v !== false && body.v !== 0;
    }
    return json(res, 200, { ok: true, visible: visibleCount() });
  }

  const server = http.createServer((req, res) => {
    setCors(res);
    const url = new URL(req.url || '/', `http://${HOST}`);
    const run = async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/overlay.js') return serveOverlay(res);
      if (req.method === 'GET' && url.pathname === '/events') return serveEvents(req, res, url);
      if (req.method === 'GET' && url.pathname === '/history') return serveHistory(res, url);
      if (req.method === 'POST' && url.pathname === '/event') return receiveEvent(req, res);
      if (req.method === 'POST' && url.pathname === '/batch') return receiveBatchRequest(req, res);
      if (req.method === 'POST' && url.pathname === '/ack') return receiveAck(req, res);
      if (req.method === 'POST' && url.pathname === '/vis') return receiveVis(req, res);
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (req.headers['x-agent-cursors'] !== '1') return json(res, 403, { ok: false, error: 'yasak' });
        json(res, 200, { ok: true });
        setTimeout(() => { if (typeof options.onShutdown === 'function') options.onShutdown(); }, 50);
        return undefined;
      }
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return json(res, 200, { ok: true, name: 'agent-cursors', protocol: PROTOCOL, clients: clients.size, visible: visibleCount() });
      }
      return json(res, 404, { ok: false, error: 'bulunamadı' });
    };
    run().catch(() => {
      try {
        if (!res.headersSent) json(res, 500, { ok: false, error: 'iç hata' });
        else res.end();
      } catch {
      }
    });
  });

  const pingTimer = setInterval(() => {
    for (const c of [...clients]) {
      try {
        c.write('event: ping\ndata: {}\n\n');
      } catch {
        clients.delete(c);
      }
    }
  }, PING_MS);
  pingTimer.unref();

  function close() {
    clearInterval(pingTimer);
    for (const g of [...gates.values()]) g.release();
    for (const c of [...clients]) {
      try {
        c.end();
      } catch {
      }
    }
    clients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  return { server, clients, broadcast, close };
}

function describeHint(h) {
  const parts = [];
  if (h.tag) parts.push(h.tag);
  if (h.id) parts.push('#' + h.id);
  if (h.classes && h.classes.length) parts.push('.' + h.classes.join('.'));
  if (h.text) parts.push(`"${h.text}"`);
  return parts.length ? parts.join(' ') : '(hint yok)';
}

export function startDaemon(opts = {}) {
  const port = opts.port ?? (Number(process.env.AGENT_CURSORS_PORT) || DEFAULT_PORT);
  const d = createDaemon(opts);
  return new Promise((resolve, reject) => {
    d.server.once('error', reject);
    d.server.listen(port, HOST, () => {
      d.server.off('error', reject);
      resolve({ ...d, port: d.server.address().port });
    });
  });
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  let stopRef = () => process.exit(0);
  startDaemon({ log: (m) => console.log(m), onShutdown: () => stopRef() })
    .then((d) => {
      console.log(`[agent-cursors] http://${HOST}:${d.port} dinleniyor`);
      console.log(`[agent-cursors] overlay: <script src="http://${HOST}:${d.port}/overlay.js"></script>`);
      const stop = () => d.close().then(() => process.exit(0));
      stopRef = stop;
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.log('[agent-cursors] port zaten kullanımda; daemon büyük olasılıkla zaten çalışıyor.');
        process.exit(0);
      }
      console.error('[agent-cursors] başlatılamadı:', err);
      process.exit(1);
    });
}

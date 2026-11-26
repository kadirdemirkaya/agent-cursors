import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractHint, emptyHint, cleanSelectorText, cssNestDepth, normalizeCssProps, HOST, DEFAULT_PORT } from './daemon.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DAEMON_PATH = path.join(__dirname, 'daemon.mjs');

const HANDLED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'exec', 'local_shell']);

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan']);
const POST_TIMEOUT_MS = 300;
const RESTART_WAIT_MS = 200;
const RESTART_TRIES = 4;
const STDIN_TIMEOUT_MS = 1000;
const envHold = Number(process.env.AGENT_CURSORS_HOLD_MS);

export const HOLD_MS = Number.isFinite(envHold) && process.env.AGENT_CURSORS_HOLD_MS !== undefined && process.env.AGENT_CURSORS_HOLD_MS !== '' ? Math.max(0, Math.min(5000, envHold)) : 5000;
const MAX_EVENTS = 5;
export const MAX_CODEX_EVENTS = 24;
const VISUAL_SOURCE_EXTS = new Set([
  '.html', '.htm', '.xhtml', '.jsx', '.tsx', '.js', '.mjs', '.cjs', '.ts', '.mts',
  '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less', '.styl', '.svg',
  '.php', '.erb', '.ejs', '.hbs', '.njk', '.liquid', '.twig', '.pug', '.cshtml', '.razor',
]);
const isVisualSourceFile = (file) => VISUAL_SOURCE_EXTS.has(path.extname(String(file)).toLowerCase());

const OPEN_TAG_RE = /(?<![\w$)\]])<[A-Za-z][\w.:-]*/g;

const TAG_RE = /(?<![\w$)\]])<([A-Za-z][\w.:-]*)((?:=>|[^<>])*)/g;
const SKIP_VISUAL_TAGS = new Set(['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'title', 'template']);
const STRUCTURAL_TAGS = new Set(['section', 'article', 'main', 'header', 'nav', 'aside', 'li', 'tr', 'form']);

const STATE_CLASS_RE = /^(?:active|selected|completed|done|disabled|open|closed|hidden|visible|show|is-[\w-]+|has-[\w-]+)$/i;
const RESIZE_RE = new RegExp(
  [
    '\\b(?:min-|max-)?(?:width|height|inline-size|block-size|flex-basis|aspect-ratio|zoom|scale)\\b',
    '\\bgrid-template-(?:columns|rows)\\b',
    '(?:^|[\\s"\'`])(?:min-|max-)?[wh]-(?:\\[|\\d|full|screen|auto|fit|min|max|px|[a-z]+\\/)',
    '(?:^|[\\s"\'`])size-(?:\\[|\\d|full|auto|px)',
    '(?:^|[\\s"\'`])(?:col|row)-span-',
    '\\b(?:width|height)\\s*=',
  ].join('|'),
  'i',
);
const STYLE_RE =
  /\b(?:color|background|border|shadow|opacity|font|radius|outline|fill|stroke|filter|gradient|margin|padding|gap|transition|transform|cursor|display|position|class(?:Name)?|style)\b|(?:^|[\s"'`])(?:bg|text|rounded|shadow|ring|font|p[xytrbl]?|m[xytrbl]?|gap)-/i;

const countOpenTags = (s) => (String(s).match(OPEN_TAG_RE) || []).length;
const skeleton = (s) => (String(s).match(/<[^>]*>/g) || []).join('');

function changedLines(o, n) {
  let p = 0;
  const max = Math.min(o.length, n.length);
  while (p < max && o[p] === n[p]) p++;
  let q = 0;
  while (q < max - p && o[o.length - 1 - q] === n[n.length - 1 - q]) q++;
  const core = (s) => {
    const a = p <= 0 ? 0 : s.lastIndexOf('\n', p - 1) + 1;
    const endIdx = s.length - q;
    const k = s.indexOf('\n', endIdx);
    return s.slice(a, k < 0 ? s.length : k);
  };
  return [core(o), core(n)];
}

export function guessKind(oldStr = '', newStr = '') {
  const o = String(oldStr);
  const n = String(newStr);
  if (!o.trim() && n.trim()) return 'add';
  if (o.trim() && !n.trim()) return 'remove';
  if (!o.trim() && !n.trim()) return 'edit';

  const oTags = countOpenTags(o);
  const nTags = countOpenTags(n);
  if (nTags > oTags) return 'add';
  if (nTags < oTags) return 'remove';
  if (oTags > 0 && skeleton(o) === skeleton(n)) return 'text';

  const [co, cn] = changedLines(o, n);
  const both = `${co}\n${cn}`;
  if (RESIZE_RE.test(both)) return 'resize';
  if (STYLE_RE.test(both)) return 'style';
  if (oTags === 0 && nTags === 0 && !/[=;(){}[\]<>]/.test(co + cn)) return 'text';
  return 'edit';
}

export function countLines(s) {
  if (!s) return 1;
  return String(s).replace(/\r\n/g, '\n').split('\n').length;
}

export function locate(content, newStr) {
  if (typeof content !== 'string' || typeof newStr !== 'string' || !newStr.trim()) return null;
  const c = content.replace(/\r\n/g, '\n');
  const t = newStr.replace(/\r\n/g, '\n');
  let idx = c.indexOf(t);
  let found = t;
  if (idx < 0) {
    found = t.trim();
    idx = found ? c.indexOf(found) : -1;
  }
  if (idx < 0) return null;
  const lead = (found.match(/^\s*/)[0].match(/\n/g) || []).length;
  const body = found.trim();
  const start = c.slice(0, idx).split('\n').length + lead;
  return { start, end: start + body.split('\n').length - 1 };
}

export function rangeFromPatch(patch) {
  if (!Array.isArray(patch) || !patch.length) return null;
  const hunk = patch[0];
  if (!hunk || !Array.isArray(hunk.lines) || !Number.isFinite(hunk.newStart)) return null;
  let n = hunk.newStart;
  let first = null;
  let last = null;
  for (const line of hunk.lines) {
    if (typeof line !== 'string') return null;
    const c = line[0];
    if (c === '+') {
      if (first === null) first = n;
      last = n;
      n++;
    } else if (c === '-') {
      if (first === null) first = n;
      if (last === null) last = n;
    } else if (first !== null) {
      break;
    } else {
      n++;
    }
  }
  if (first === null) return null;
  return { start: Math.max(1, first), end: Math.max(first, last ?? first) };
}

export function visualTargets(source, file, baseLine = 1, options = {}) {
  if (typeof source !== 'string' || !source) return [];
  const ext = path.extname(file).toLowerCase();
  const targets = [];
  const onlySources = options && options.sourceNames ? new Set(options.sourceNames) : null;
  const limit = Number.isFinite(options && options.limit) ? options.limit : MAX_CODEX_EVENTS;
  const add = (line, hint, extra = {}) => {
    if (!hasVisualHint(hint) && !hint.selector) return;
    targets.push({ line: Math.max(1, baseLine + line - 1), hint, ...extra });
  };

  if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext)) {
    const rule = /(?:^|})\s*([^{}]+?)\s*\{/g;
    const cssSource = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '));
    for (const match of cssSource.matchAll(rule)) {
      const selectors = match[1].trim();
      if (!selectors || selectors.startsWith('@')) continue;
      const line = cssSource.slice(0, match.index + match[0].length - 1).split('\n').length;
      for (const selector of selectors.split(',')) {
        const css = `${selector.trim()} {\n}`;
        let hint = extractHint(css, 1, 1, { file });
        if (!hasVisualHint(hint)) {
          const id = [...selector.matchAll(/#([\w-]+)/g)].at(-1)?.[1] || '';
          const classes = [...new Set([...selector.matchAll(/\.([\w-]+)/g)].map((item) => item[1]))];
          if (id || classes.length) hint = { id, classes, tag: '', text: '' };
        }
        const sel = cleanSelectorText(selector);
        hint = { ...hint };
        delete hint.selector;
        if (sel && (hasVisualHint(hint) || usefulSelector(sel))) hint.selector = sel;
        add(line, hint);
        if (targets.length >= limit) return targets;
      }
    }
    return targets;
  }

  if (!['.html', '.htm', '.xhtml', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.php', '.erb', '.ejs', '.hbs', '.njk', '.liquid', '.twig', '.pug', '.cshtml', '.razor'].includes(ext)) return targets;

  const candidates = [];
  const mapSourceAt = (tagOffset) => {
    const before = source.slice(Math.max(0, tagOffset - 480), tagOffset);
    const mapAt = before.lastIndexOf('.map');
    if (mapAt < 0 || !/^\.map\s*\(/.test(before.slice(mapAt))) return '';
    const outer = before.slice(0, mapAt).replace(/\$\{[^}]*\}/g, ' ');
    return [...outer.matchAll(/\{\s*([A-Za-z_$][\w$]*)\b/g)].at(-1)?.[1] || '';
  };
  const pathAt = new Map();
  {
    const stack = [];
    for (const match of source.matchAll(MARKUP_TOKEN_RE)) {
      const name = match[1];
      if (match[0][1] === '/') {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name.toLowerCase() === name.toLowerCase()) { stack.length = i; break; }
        continue;
      }
      if (stack.length) pathAt.set(match.index || 0, pathFromStack(stack));
      if (!VOID_TAGS.has(name.toLowerCase()) && !/\/\s*>$/.test(match[0])) {
        stack.push({ name, hint: extractHint(match[0], 1, 1, { file }), at: match.index || 0 });
      }
      if (stack.length > 200) break;
    }
  }
  for (const match of source.matchAll(TAG_RE)) {
    const tag = String(match[1] || '').toLowerCase();
    if (SKIP_VISUAL_TAGS.has(tag)) continue;
    const hint = extractHint(match[0], 1, 1, { file });
    if (!hasVisualHint(hint)) continue;
    const at = match.index || 0;
    const line = source.slice(0, at).replace(/\r\n/g, '\n').split('\n').length;
    const nearby = source.slice(Math.max(0, at - 240), at);
    const mapRoot = /\.map\s*\([\s\S]{0,240}?=>\s*$/.test(nearby);
    const sourceName = mapRoot ? mapSourceAt(at) : '';
    if (onlySources && !onlySources.has(sourceName)) continue;
    if (mapRoot || /\bv-for\b|\{#each\b/.test(nearby)) hint.repeat = true;
    const anc = pathAt.get(at);
    if (anc && anc.length) hint.path = anc;
    candidates.push({ line, tag, hint, sourceName });
  }

  const structural = candidates.some((item) => item.hint.id || STRUCTURAL_TAGS.has(item.tag));
  const kept = [];
  for (const item of candidates) {
    const generic = !item.hint.id && /^(?:div|span|p|h[1-6])$/.test(item.tag);
    if (generic && structural) continue;
    const childOfKnownTarget = kept.some((parent) => (parent.hint.classes || []).some((base) =>
      (item.hint.classes || []).some((name) => name !== base && name.startsWith(`${base}-`))));
    if (childOfKnownTarget) continue;
    kept.push(item);
  }

  const counts = new Map();
  for (const item of kept) {
    const key = item.hint.id ? `id:${item.hint.id}` : `class:${(item.hint.classes || [])[0] || ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Map();
  for (const item of kept) {
    const key = item.hint.id ? `id:${item.hint.id}` : `class:${(item.hint.classes || [])[0] || ''}`;
    const nth = seen.get(key) || 0;
    seen.set(key, nth + 1);
    if ((counts.get(key) || 0) > 1) item.hint.nth = nth;
    add(item.line, item.hint, item.sourceName ? { sourceName: item.sourceName } : {});
    if (targets.length >= limit) break;
  }
  return targets;
}

function arrayClosesAfter(source, open, offset) {
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); if (nl < 0) return false; i = nl; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) return false; i = end + 1; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return i > offset; }
  }
  return false;
}

function dataAliases(source, name) {
  const aliases = new Set([name]);
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let depth = 0; depth < 3; depth++) {
    let added = false;
    for (const alias of [...aliases]) {
      const key = esc(alias);
      const stateRe = new RegExp(`\\[\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*[A-Za-z_$][\\w$]*\\s*\\]\\s*=\\s*useState\\s*\\(\\s*${key}\\b`, 'g');
      for (const match of source.matchAll(stateRe)) {
        if (!aliases.has(match[1])) { aliases.add(match[1]); added = true; }
      }
      const derivedRe = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${key}\\s*\\.\\s*(?:filter|slice|sort|concat|map|reduce)\\s*\\(`, 'g');
      for (const match of source.matchAll(derivedRe)) {
        if (!aliases.has(match[1])) { aliases.add(match[1]); added = true; }
      }
    }
    if (!added) break;
  }
  return aliases;
}

function repeatedDataTargets(source, file, offset) {
  const bindings = [...String(source || '').matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)];
  let dataName = '';
  for (let i = bindings.length - 1; i >= 0; i--) {
    const open = (bindings[i].index || 0) + bindings[i][0].length - 1;
    if (open < offset && arrayClosesAfter(source, open, offset)) { dataName = bindings[i][1]; break; }
  }
  if (!dataName) return [];
  const aliases = dataAliases(source, dataName);
  return visualTargets(source, file, 1, { sourceNames: aliases });
}

function usefulSelector(sel) {
  return String(sel).split(',').some((part) => {
    const s = part.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
    if (!s || /^(?:html|body|\*|:root)$/i.test(s)) return false;
    if (/[.#[]/.test(s)) return true;
    const compounds = s.split(/\s*[\s>+~]\s*/).filter((c) => c && !/^(?:html|body|\*)$/i.test(c));
    return compounds.length >= 2;
  });
}

function hasVisualHint(hint) {
  if (!hint) return false;
  if (hint.id) return true;
  return !!(hint.classes && hint.classes.some((name) => typeof name === 'string' && name && !STATE_CLASS_RE.test(name)));
}

function withRepeatHint(source, tagOffset, hint) {
  if (!hint || hint.repeat) return hint;
  const nearby = String(source || '').slice(Math.max(0, Number(tagOffset) - 240), Math.max(0, Number(tagOffset)));
  return /\.map\s*\(|\bv-for\b|\{#each\b/.test(nearby) ? { ...hint, repeat: true } : hint;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const MARKUP_TOKEN_RE = /<\/?([A-Za-z][\w.:-]*)\b((?:=>|[^<>])*)>/g;

const SCRIPT_HOST_RE = /\.(?:html?|xhtml|vue|svelte|astro)$/i;
function blankJsComments(code) {
  const out = code.split('');
  const n = code.length;
  const tpl = [];
  let i = 0;
  let q = '';
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const ch = code[i];
    if (q) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === q || ch === '\n') q = '';
      i++;
      continue;
    }
    if (tpl.length && tpl[tpl.length - 1] === 0) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { tpl.pop(); i++; continue; }
      if (ch === '$' && code[i + 1] === '{') { tpl[tpl.length - 1] = 1; i += 2; continue; }
      i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '\'' || ch === '"') { q = ch; i++; continue; }
    if (ch === '`') { tpl.push(0); i++; continue; }
    if (tpl.length) {
      if (ch === '{') tpl[tpl.length - 1]++;
      else if (ch === '}') { tpl[tpl.length - 1]--; if (tpl[tpl.length - 1] === 0) { i++; continue; } }
    }
    i++;
  }
  return out.join('').replace(/<(\/?)([A-Za-z][\w.:-]*)/g, (m, slash, name) =>
    (HTML_TAG_RE.test(name.toLowerCase()) || name.includes('-') ? m : ' '.repeat(m.length)));
}
function blankScriptComments(source, file) {
  if (!SCRIPT_HOST_RE.test(String(file || '')) || !/<script\b/i.test(source)) return source;
  let out = '';
  let last = 0;
  const open = /<script\b[^>]*>/gi;
  let m;
  while ((m = open.exec(source))) {
    const start = m.index + m[0].length;
    const close = source.toLowerCase().indexOf('</script', start);
    const end = close < 0 ? source.length : close;
    out += source.slice(last, start) + blankJsComments(source.slice(start, end));
    last = end;
    open.lastIndex = end;
    if (close < 0) break;
  }
  return out + source.slice(last);
}

function openTagStack(source, offset, file) {
  const prefix = blankScriptComments(source.slice(0, Math.max(0, offset)), file);
  const stack = [];
  for (const match of prefix.matchAll(MARKUP_TOKEN_RE)) {
    const name = match[1];
    if (match[0][1] === '/') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name.toLowerCase() === name.toLowerCase()) { stack.length = i; break; }
      }
    } else if (!VOID_TAGS.has(name.toLowerCase()) && !/\/\s*>$/.test(match[0])) {
      stack.push({ name, hint: extractHint(match[0], 1, 1, { file }), at: match.index || 0 });
    }
  }
  return stack;
}

function pathFromStack(stack) {
  const out = [];
  for (let i = stack.length - 1; i >= 0 && out.length < 4; i--) {
    const node = stack[i];
    if (/^[A-Z]/.test(node.name) || node.name.includes('.')) continue;
    const tag = node.name.toLowerCase();
    if (SKIP_VISUAL_TAGS.has(tag)) continue;
    const id = node.hint.id || '';
    const classes = (node.hint.classes || []).filter((c) => !STATE_CLASS_RE.test(c)).slice(0, 4);
    if (!id && !classes.length && !STRUCTURAL_TAGS.has(tag)) continue;
    const item = { tag };
    if (id) item.id = id;
    if (classes.length) item.classes = classes;
    out.unshift(item);
  }
  return out;
}

const BLOCK_IN_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
export function htmlIndexStack(source, offset) {
  const src = String(source || '').slice(0, Math.max(0, offset)).replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => ' '.repeat(m.length));
  const bodyAt = src.search(/<body\b/i);
  if (bodyAt < 0) return null;
  const re = /<(\/?)([A-Za-z][\w:-]*)\b[^<>]*?(\/?)>/g;
  re.lastIndex = src.indexOf('>', bodyAt) + 1;
  if (re.lastIndex <= 0) return null;
  const stack = [{ name: 'body', ipath: [], kids: 0, at: bodyAt }];
  let m;
  while ((m = re.exec(src))) {
    const name = m[2].toLowerCase();
    const top = stack.at(-1);
    if (m[1]) {
      if (name === 'body' || name === 'html') return null;
      if (top.name !== name) return null;
      stack.pop();
      if (!stack.length) return null;
      continue;
    }
    if (name === 'body' || name === 'html' || name === 'head') return null;
    if (name === 'tr' && top.name === 'table') return null;
    if (BLOCK_IN_P.has(name) && stack.some((n) => n.name === 'p')) return null;
    if (name === 'li' && top.name === 'li') return null;
    const node = { name, ipath: [...top.ipath, top.kids++], kids: 0, at: m.index };
    if (node.ipath.length > 24 || top.kids > 9999) return null;
    if (VOID_TAGS.has(name) || m[3]) continue;
    if (name === 'script' || name === 'style' || name === 'template' || name === 'textarea') {
      const close = src.toLowerCase().indexOf(`</${name}`, re.lastIndex);
      if (close < 0) { stack.push(node); break; }
      const end = src.indexOf('>', close);
      if (end < 0) return null;
      re.lastIndex = end + 1;
      continue;
    }
    stack.push(node);
  }
  return stack;
}

function htmlIpath(file, source, offset, at = -1) {
  if (!/\.(?:html?|xhtml)$/i.test(String(file || ''))) return null;
  const end = at >= 0 ? source.indexOf('>', at) + 1 : offset;
  const stack = htmlIndexStack(source, Math.max(offset, end));
  if (!stack) return null;
  const node = at >= 0 ? stack.find((n) => n.at === at) : stack.at(-1);
  return node && node.ipath.length ? node.ipath : null;
}

export function ancestorsAt(source, offset, file = '') {
  return pathFromStack(openTagStack(String(source || ''), offset, file));
}

const withPath = (hint, path) => (path && path.length ? { ...hint, path } : hint);

function markupHintAt(source, offset, file, fallbackText = '') {
  const stack = openTagStack(source, offset, file);

  const open = source.lastIndexOf('<', offset);
  const close = source.lastIndexOf('>', offset);
  if (open > close && /^<[A-Za-z][\w.:-]*\b/.test(source.slice(open, offset))) {
    const tagEnd = source.indexOf('>', open);
    const partial = tagEnd >= 0 ? source.slice(open, tagEnd + 1) : `${source.slice(open, offset)}>`;
    const hint = extractHint(partial, 1, 1, { file });
    if (hint.id || hint.classes.length) return withIpath(withPath(withRepeatHint(source, open, hint), pathFromStack(stack.filter((n) => n.at < open))), htmlIpath(file, source, offset, open));
  }

  const active = stack.at(-1);
  let target = [...stack].reverse().find((node) => node.hint.id || node.hint.classes.length);
  const hint = target
    ? withPath(withRepeatHint(source, target.at, { ...target.hint }), pathFromStack(stack.slice(0, stack.indexOf(target))))
    : active ? { ...active.hint } : emptyHint();
  if (!hint.tag && active) hint.tag = active.name.toLowerCase();
  if (fallbackText) hint.text = extractHint(fallbackText, 1, Math.max(1, countLines(fallbackText)), { file }).text || hint.text;
  const node = target || active;
  return node ? withIpath(hint, htmlIpath(file, source, offset, node.at)) : hint;
}

const withIpath = (hint, ipath) => (ipath && ipath.length ? { ...hint, ipath } : hint);

function eventsFromTextChange(file, before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldPart = before.slice(prefix, before.length - suffix);
  const newPart = after.slice(prefix, after.length - suffix);
  const source = newPart ? after : before;
  const offset = newPart ? prefix : prefix;
  const lineAt = (text, at) => text.slice(0, at).split(/\r?\n/).length;
  const start = lineAt(source, offset);
  const end = start + Math.max(0, (newPart || oldPart).split(/\r?\n/).length - 1);
  const kind = guessKind(oldPart, newPart);
  const ext = path.extname(file).toLowerCase();
  if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext) && newPart) {
    const targets = visualTargets(newPart, file, start);
    if (targets.length) return targets.map((target) => makeEvent(file, target.line, target.line, kind, target.hint));
  }
  const hint = newPart ? markupHintAt(after, prefix, file, newPart) : markupHintAt(before, prefix, file, oldPart);
  if (!hasVisualHint(hint)) {
    const repeated = repeatedDataTargets(source, file, offset);
    if (repeated.length) return repeated.map((target) => makeEvent(file, target.line, target.line, kind, target.hint));
  }
  return [makeEvent(file, start, end, kind, hint)];
}

function eventsFromShellCommand(command, cwd, readText = defaultReadText) {
  if (typeof command !== 'string' || !command) return [];
  const writes = [];
  const add = (file, kind = '', value = '') => {
    if (!file || !isVisualSourceFile(file)) return;
    const abs = pathIn(file, cwd);
    const existing = writes.find((item) => item.file === abs);
    if (existing) {
      if (!existing.kind && kind) existing.kind = kind;
      if (value) existing.value = existing.value ? `${existing.value}\n${value}` : value;
    } else writes.push({ file: abs, kind, value });
  };
  const psVars = new Map();
  for (const match of command.matchAll(/\$([\w]+)\s*=\s*(['"])(.*?)\2/g)) psVars.set(match[1].toLowerCase(), match[3]);
  const resolvePsPath = (raw) => {
    const value = String(raw || '').trim();
    const variable = /^\$([\w]+)$/.exec(value);
    return variable ? psVars.get(variable[1].toLowerCase()) || '' : value.replace(/^['"]|['"]$/g, '');
  };

  const sourceFiles = new Map();
  for (const match of command.matchAll(/\$([\w]+)\s*=\s*Get-Content\b([^;]*)/gi)) {
    const args = match[2].match(/"[^"]*"|'[^']*'|\$[\w]+|[^\s]+/g) || [];
    const candidate = args.filter((arg) => !arg.startsWith('-')).at(-1);
    if (candidate) {
      const sourceFile = resolvePsPath(candidate);
      sourceFiles.set(match[1].toLowerCase(), path.isAbsolute(sourceFile) ? path.normalize(sourceFile) : path.resolve(cwd, sourceFile));
    }
  }
  const replacements = new Map();
  const replaceRe = /\$([\w]+)\s*=\s*\$\1\.Replace\(\s*(['"])(.*?)\2\s*,\s*(['"])(.*?)\4\s*\)/gi;
  for (const match of command.matchAll(replaceRe)) {
    const file = sourceFiles.get(match[1].toLowerCase());
    if (!file) continue;
    const list = replacements.get(file) || [];
    list.push({ oldText: match[3], newText: match[5] });
    replacements.set(file, list);
  }

  const ps = /\b(Set-Content|Add-Content|Out-File|Remove-Item|Clear-Content)\b(?:(?!;)[\s\S])*?-(?:Path|FilePath)\s+(?:"([^"]+)"|'([^']+)'|(\$[\w]+)|([^\s;]+))/gi;
  for (const match of command.matchAll(ps)) {
    const rawPath = match[2] || match[3] || match[4] || match[5];
    const file = resolvePsPath(rawPath);
    const op = match[1].toLowerCase();
    if (op === 'remove-item') add(file, 'remove');
    else if (op === 'clear-content') add(file, 'edit', '');
    else add(file, op === 'add-content' ? 'append' : '', '');
  }

  const addContent = /\bAdd-Content\b(?:(?!;)[\s\S])*?-(?:Value|InputObject)\s+("([\s\S]*?)"|'([\s\S]*?)')/gi;
  for (const match of command.matchAll(addContent)) {
    const statementStart = command.lastIndexOf('Add-Content', match.index);
    const statement = command.slice(statementStart, command.indexOf(';', statementStart) < 0 ? command.length : command.indexOf(';', statementStart));
    const pathMatch = /-(?:Path|FilePath)\s+(?:"([^"]+)"|'([^']+)'|(\$[\w]+)|([^\s;]+))/i.exec(statement);
    const file = pathMatch ? resolvePsPath(pathMatch[1] || pathMatch[2] || pathMatch[3] || pathMatch[4]) : '';
    const rawValue = match[2] ?? match[3] ?? '';
    const value = match[1].startsWith('"') ? rawValue.replace(/`r`n|`n|`r/g, '\n').replace(/`t/g, '\t').replace(/``/g, '`') : rawValue.replace(/''/g, "'");
    if (file) add(file, 'append', value);
  }

  const js = /\b(?:writeFileSync|writeFile|write_text|WriteAllText)\s*\(\s*(['"])([^'"]+)\1/gi;
  for (const match of command.matchAll(js)) add(match[2]);
  const redir = /(?:>|>>|\btee\s+(?:-a\s+)?)(?:\s*)(?:"([^"]+\.(?:html?|xhtml|jsx|tsx|js|mjs|ts|css|scss))"|'([^']+\.(?:html?|xhtml|jsx|tsx|js|mjs|ts|css|scss))'|([^\s;|]+\.(?:html?|xhtml|jsx|tsx|js|mjs|ts|css|scss)))/gi;
  for (const match of command.matchAll(redir)) add(match[1] || match[2] || match[3]);

  const events = [];
  for (const item of writes) {
    const current = safeRead(readText, item.file);
    const ext = path.extname(item.file).toLowerCase();
    const kind = item.kind === 'remove' ? 'remove' : item.kind === 'append' ? (['.css', '.scss', '.sass', '.less'].includes(ext) ? 'style' : current === null ? 'add' : 'edit') : item.kind || (['.css', '.scss', '.sass', '.less'].includes(ext) ? 'style' : current === null ? 'add' : 'edit');
    if (kind === 'remove') {
      events.push(makeEvent(item.file, 1, 1, 'remove', current ? extractHint(current, 1, Math.min(8, countLines(current)), { file: item.file }) : emptyHint()));
      continue;
    }

    const changes = replacements.get(item.file) || [];
    if (changes.length && current !== null) {
      let simulated = current;
      for (const change of changes) simulated = simulated.replace(change.oldText, change.newText);
      if (simulated !== current) events.push(...eventsFromHunks(item.file, current, simulated));
      else {
        for (const change of changes) {
          const at = current.indexOf(change.newText);
          if (at >= 0) {
            const hint = markupHintAt(current, at, item.file, change.newText);
            const line = current.slice(0, at).split(/\r?\n/).length;
            events.push(makeEvent(item.file, line, line, guessKind(change.oldText, change.newText), hint));
          }
        }
      }
      continue;
    }

    if (item.value) {
      const baseLine = current === null ? 1 : countLines(current);
      const targets = visualTargets(item.value, item.file, item.kind === 'append' ? baseLine : 1);
      if (targets.length) {
        for (const target of targets) events.push(makeEvent(item.file, target.line, target.line, kind, target.hint));
        continue;
      }
      if (item.kind === 'append' && current !== null) {
        const simulated = `${current}${current.endsWith('\n') || !current ? '' : '\n'}${item.value}`;
        events.push(...eventsFromHunks(item.file, current, simulated));
        continue;
      }
    }

    if (current !== null) {
      const targets = visualTargets(current, item.file, 1);
      if (targets.length) for (const target of targets) events.push(makeEvent(item.file, target.line, target.line, kind, target.hint));
      else events.push(makeEvent(item.file, 1, Math.max(1, countLines(current)), kind, extractHint(current, 1, Math.min(8, countLines(current)), { file: item.file })));
    } else {
      events.push(makeEvent(item.file, 1, 1, 'add'));
    }
  }
  return applyRouteHints(events.slice(0, MAX_CODEX_EVENTS), cwd);
}

export function eventsFromStructuredTool(input, readText = defaultReadText) {
  const toolName = String(input.tool_name || '');
  if (!/(?:write|edit|create|delete|remove|patch|replace|append|save|move|rename)/i.test(toolName)) return [];
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const events = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const entries = Object.entries(node);
    const pathEntry = entries.find(([key, value]) => /^(?:file_?path|filepath|path|file|filename|target|uri)$/i.test(key) && typeof value === 'string' && /\.(?:html?|xhtml|jsx|tsx|js|mjs|cjs|ts|css|scss|sass|less|vue|svelte|astro)(?:$|[?#])/i.test(value));
    if (pathEntry) {
      let file = pathEntry[1];
      if (file.startsWith('file:')) {
        try { file = fileURLToPath(file); } catch {}
      }
      file = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
      const current = safeRead(readText, file);
      const valueOf = (key) => entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      const oldText = valueOf('old_string') ?? valueOf('oldText');
      const newText = valueOf('new_string') ?? valueOf('newText') ?? valueOf('content') ?? valueOf('contents') ?? valueOf('text') ?? valueOf('body');
      if (/delete|remove/i.test(toolName)) {
        events.push(makeEvent(file, 1, 1, 'remove', current ? extractHint(current, 1, Math.min(8, countLines(current)), { file }) : emptyHint()));
      } else if (typeof oldText === 'string' && typeof newText === 'string' && current !== null) {
        const next = current.includes(oldText) ? current.replace(oldText, newText) : current;
        if (next !== current) events.push(...eventsFromHunks(file, current, next));
        else {
          const at = current.indexOf(newText);
          if (at >= 0) {
            const line = current.slice(0, at).split(/\r?\n/).length;
            events.push(makeEvent(file, line, line, guessKind(oldText, newText), markupHintAt(current, at, file, newText)));
          }
        }
      } else if (typeof newText === 'string') {
        const next = newText;
        const targets = visualTargets(next, file, 1);
        if (targets.length) {
          const kind = current === null ? 'add' : 'edit';
          for (const target of targets) events.push(makeEvent(file, target.line, target.line, kind, target.hint));
        } else if (current !== next) events.push(...eventsFromTextChange(file, current || '', next));
        else events.push(makeEvent(file, 1, Math.max(1, countLines(next)), 'edit', extractHint(next, 1, Math.min(8, countLines(next)), { file })));
      } else if (current !== null) {
        const targets = visualTargets(current, file, 1);
        if (targets.length) for (const target of targets) events.push(makeEvent(file, target.line, target.line, 'edit', target.hint));
        else events.push(makeEvent(file, 1, Math.max(1, countLines(current)), 'edit', extractHint(current, 1, Math.min(8, countLines(current)), { file })));
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
  };
  visit(ti);
  return applyRouteHints(events.slice(0, MAX_CODEX_EVENTS), cwd);
}

function patchFileHeader(line) {
  const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
  if (!match) return null;
  return {
    action: match[1] === 'Add' ? 'add' : match[1] === 'Delete' ? 'delete' : 'edit',
    file: match[2].trim(),
  };
}

export function patchFileOps(patchText) {
  if (typeof patchText !== 'string' || !patchText) return [];
  const ops = [];
  let current = null;
  const flush = () => {
    if (!current || !current.file) return;
    ops.push(current);
    current = null;
  };
  for (const line of patchText.replace(/\r\n/g, '\n').split('\n')) {
    const header = patchFileHeader(line);
    if (header) {
      flush();
      current = { ...header, added: 0, removed: 0 };
      continue;
    }
    if (!current || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  flush();
  return ops;
}

export function eventsFromCodexPatch(command, cwd = process.cwd(), readText = defaultReadText) {
  if (typeof command !== 'string' || !command) return [];
  const lines = command.replace(/\r\n/g, '\n').split('\n');
  const events = [];
  let file = '';
  let oldLines = [];
  let newLines = [];
  let rangeStart = null;
  let rangeEnd = null;
  let newLine = 1;
  let inferRangeFromResult = false;

  const flush = (clearFile = false) => {
    if (!file || rangeStart === null) {
      if (clearFile) file = '';
      return;
    }
    const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
    if (!isVisualSourceFile(abs)) {
      oldLines = [];
      newLines = [];
      rangeStart = rangeEnd = null;
      inferRangeFromResult = false;
      if (clearFile) file = '';
      return;
    }
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');
    const kind = guessKind(oldText, newText);
    let start = rangeStart;
    let end = rangeEnd;
    const current = safeRead(readText, abs);
    const locatedNew = newText.trim() && current !== null ? locate(current, newText) : null;
    const locatedOld = oldText.trim() && current !== null ? locate(current, oldText) : null;
    if (inferRangeFromResult) {
      if (locatedNew) ({ start, end } = locatedNew);
      else if (locatedOld) ({ start, end } = locatedOld);
      else start = end = 1;
    }
    if (newText.trim()) {
      const baseLine = (locatedNew || locatedOld)?.start ?? start ?? 1;
      const targets = visualTargets(newText, abs, baseLine);
      if (targets.length) {
        for (const target of targets) events.push(makeEvent(abs, target.line, target.line, kind, target.hint));
        oldLines = [];
        newLines = [];
        rangeStart = rangeEnd = null;
        inferRangeFromResult = false;
        if (clearFile) file = '';
        return;
      }
    }
    let hint = emptyHint();
    if (!newText.trim() && oldText.trim()) hint = extractHint(oldText, 1, countLines(oldText), { file: abs });
    else {
      const content = safeRead(readText, abs);
      if (content !== null) hint = extractHint(content, start, end, { file: abs });
    }
    events.push(makeEvent(abs, start, end, kind, hint));
    oldLines = [];
    newLines = [];
    rangeStart = rangeEnd = null;
    inferRangeFromResult = false;
    if (clearFile) file = '';
  };

  for (const line of lines) {
    const fileOp = patchFileHeader(line);
    if (fileOp) {
      flush(true);
      file = fileOp.file;
      if (fileOp.action === 'delete') {
        const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
        if (isVisualSourceFile(abs)) events.push(makeEvent(abs, 1, 1, 'remove'));
        file = '';
      }
      continue;
    }
    const hunk = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? )?@@/.exec(line);
    if (hunk) {
      flush();
      inferRangeFromResult = !hunk[2];
      newLine = hunk[2] ? Math.max(1, Number(hunk[2])) : 1;
      continue;
    }
    if (!file || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (rangeStart === null) rangeStart = newLine;
      rangeEnd = newLine++;
      newLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (rangeStart === null) rangeStart = newLine;
      rangeEnd = Math.max(rangeEnd ?? newLine, newLine);
      oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      if (rangeStart !== null) flush();
      newLine++;
    }
  }
  flush();
  return applyRouteHints(events.slice(0, MAX_CODEX_EVENTS), cwd);
}

function makeEvent(file, start, end, kind, hint, extra) {
  const s = Math.max(1, start);
  const ev = { id: crypto.randomUUID(), file, startLine: s, endLine: Math.max(s, end), kind, hint: hint || emptyHint() };
  return extra ? Object.assign(ev, extra) : ev;
}

const defaultReadText = (p) => fs.readFileSync(p, 'utf8');

function safeRead(readText, file) {
  try {
    const v = readText(file);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function loadRoutes(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.agent-cursors', 'routes.json'), 'utf8'));
    const clean = (list, fields) => (Array.isArray(list) ? list : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const out = {};
      for (const [key, max] of Object.entries(fields)) {
        if (typeof item[key] === 'string' && item[key].trim()) out[key] = item[key].trim().slice(0, max);
      }
      return out.match && (out.view || out.url) ? [out] : [];
    }).slice(0, 40);
    return { views: clean(raw.views, { match: 120, view: 60 }), routes: clean(raw.routes, { match: 240, url: 300 }) };
  } catch {
    return { views: [], routes: [] };
  }
}

const routesDirCache = new Map();
function routesDirFor(file, cwd) {
  if (typeof file !== 'string' || !file) return cwd;
  let dir = path.dirname(path.isAbsolute(file) ? file : path.resolve(cwd, file));
  if (routesDirCache.has(dir)) return routesDirCache.get(dir);
  const start = dir;
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.agent-cursors', 'routes.json'))) { routesDirCache.set(start, dir); return dir; }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  routesDirCache.set(start, cwd);
  return cwd;
}

export function applyRouteHints(events, cwd = process.cwd()) {
  const list = Array.isArray(events) ? events : [];
  const configs = new Map();
  const configFor = (event) => {
    const dir = routesDirFor(event && event.file, cwd);
    if (!configs.has(dir)) configs.set(dir, loadRoutes(dir));
    return configs.get(dir);
  };
  const viewOf = (config, h) => {
    const names = [h && h.id, ...(h && Array.isArray(h.classes) ? h.classes : [])].filter(Boolean);
    const view = config.views.find((item) => names.some((name) => name.startsWith(item.match)));
    return view ? view.view : '';
  };
  return list.map((event) => {
    if (!event || typeof event !== 'object') return event;
    const config = configFor(event);
    if (!config.views.length && !config.routes.length) return event;
    const hint = event.hint && typeof event.hint === 'object' ? { ...event.hint } : emptyHint();
    if (!hint.view) {
      const view = viewOf(config, hint);
      if (view) hint.view = view;
    }
    let next = event.next && typeof event.next === 'object' ? event.next : null;
    if (next && !next.view) {
      const view = viewOf(config, next);
      if (view) next = { ...next, view };
    }
    if (!hint.view && next && next.view && !hasHint(hint)) hint.view = next.view;
    const route = config.routes.find((item) => typeof event.file === 'string' && event.file.replace(/\\/g, '/').includes(item.match.replace(/\\/g, '/')));
    const out = { ...event, hint };
    if (next) out.next = next;
    if (route && !out.url) {
      hint.url = route.url;
      out.url = route.url;
    }
    return out;
  });
}

const ROUTE_SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte', '.astro', '.mdx']);
const ROUTE_SCAN_SKIP = new Set(['node_modules', '.next', '.nuxt', '.svelte-kit', '.output', '.git', '.turbo', '.vercel', '.cache', 'dist', 'build', 'out', 'coverage', 'public']);
const ROUTE_SCAN_MAX_FILES = 3000;
const ROUTE_SCAN_BUDGET_MS = 400;
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.astro', '.mdx'];
const JSX_CLAUSE_RE = /(?:^|[;\n\r}])[ \t]*(?:import|export)\s+(?:type\s+)?([\w$*\s{},]+?)\s+from\s+['"]([^'"\n]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

const fileKey = (p) => {
  const n = path.normalize(String(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function projectRootOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 25; i++) {
    try { if (fs.existsSync(path.join(dir, 'package.json'))) return dir; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readJsonLoose(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); } catch {}
    const stripped = raw.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function frameworkOf(root) {
  const pkg = readJsonLoose(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.nuxt || deps.nuxt3) return 'nuxt';
  if (deps.astro) return 'astro';
  return '';
}

function aliasesOf(root) {
  const out = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readJsonLoose(path.join(root, name));
    const opts = cfg && cfg.compilerOptions;
    if (!opts || !opts.paths || typeof opts.paths !== 'object') continue;
    const base = path.resolve(root, typeof opts.baseUrl === 'string' ? opts.baseUrl : '.');
    for (const [key, targets] of Object.entries(opts.paths)) {
      if (!Array.isArray(targets)) continue;
      const star = key.endsWith('*');
      out.push({
        prefix: star ? key.slice(0, -1) : key, star,
        targets: targets.filter((t) => typeof t === 'string').map((t) => path.resolve(base, star ? t.replace(/\*$/, '') : t)),
      });
    }
    break;
  }
  const src = path.join(root, 'src');
  if (!out.some((a) => a.prefix === '@/')) out.push({ prefix: '@/', star: true, targets: [src + path.sep] });
  if (!out.some((a) => a.prefix === '~/')) out.push({ prefix: '~/', star: true, targets: [src + path.sep] });
  if (!out.some((a) => a.prefix === '$lib/')) out.push({ prefix: '$lib/', star: true, targets: [path.join(src, 'lib') + path.sep] });
  return out;
}

function bindingsOf(clause) {
  const names = [];
  const text = String(clause || '').replace(/\btype\s+/g, ' ');
  const brace = text.indexOf('{');
  const head = brace >= 0 ? text.slice(0, brace) : text;
  for (const part of head.split(',')) {
    const name = part.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  if (brace >= 0) {
    const inner = text.slice(brace + 1, text.indexOf('}', brace) >= 0 ? text.indexOf('}', brace) : undefined);
    for (const part of inner.split(',')) {
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(part.trim());
      if (m) names.push(m[1]);
    }
  }
  return names;
}

function importsOf(source) {
  const out = [];
  const text = String(source || '');
  for (const m of text.matchAll(JSX_CLAUSE_RE)) out.push({ spec: m[2], names: bindingsOf(m[1]) });
  for (const m of text.matchAll(BARE_IMPORT_RE)) out.push({ spec: m[1] || m[2], names: [] });
  for (const m of text.matchAll(/(?:^|[;\n\r])[ \t]*import\s+['"]([^'"\n]+)['"]/g)) out.push({ spec: m[1], names: [] });
  return out;
}

function listSources(root, deadline) {
  const files = new Map();
  const stack = [root];
  while (stack.length && files.size < ROUTE_SCAN_MAX_FILES && Date.now() < deadline) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ROUTE_SCAN_SKIP.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && ROUTE_SCAN_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const abs = path.join(dir, entry.name);
        files.set(fileKey(abs), abs);
      }
    }
  }
  return files;
}

const routeContexts = new Map();

function routeContext(file, readText = defaultReadText) {
  const root = projectRootOf(file);
  if (!root) return null;
  if (routeContexts.has(root)) return routeContexts.get(root);
  const deadline = Date.now() + ROUTE_SCAN_BUDGET_MS;
  const ctx = {
    root, framework: frameworkOf(root), aliases: aliasesOf(root), files: listSources(root, deadline),
    deadline, readText, reverse: null, sources: new Map(),
  };
  routeContexts.set(root, ctx);
  return ctx;
}

function sourceOf(ctx, file) {
  const key = fileKey(file);
  if (ctx.sources.has(key)) return ctx.sources.get(key);
  const text = safeRead(ctx.readText, file);
  const value = typeof text === 'string' && text.length <= 400000 ? text : null;
  ctx.sources.set(key, value);
  return value;
}

function addVirtualSource(ctx, file, text) {
  if (!ctx || typeof text !== 'string') return;
  ctx.files.set(fileKey(file), file);
  ctx.sources.set(fileKey(file), text);
  if (ctx.reverse) addEdges(ctx, file, text);
}

function resolveSpec(ctx, spec, from) {
  if (typeof spec !== 'string' || !spec) return null;
  const bases = [];
  if (spec.startsWith('.')) bases.push(path.resolve(path.dirname(from), spec));
  else {
    for (const alias of ctx.aliases) {
      if (alias.star ? spec.startsWith(alias.prefix) : spec === alias.prefix) {
        const rest = alias.star ? spec.slice(alias.prefix.length) : '';
        for (const target of alias.targets) bases.push(alias.star ? path.join(target, rest) : target);
      }
    }
  }
  for (const base of bases) {
    const tries = [base, ...RESOLVE_EXTS.map((ext) => base + ext), ...RESOLVE_EXTS.map((ext) => path.join(base, `index${ext}`))];
    const stripped = base.replace(/\.(?:m?js|jsx)$/, '');
    if (stripped !== base) tries.push(...RESOLVE_EXTS.map((ext) => stripped + ext));
    for (const candidate of tries) {
      const hit = ctx.files.get(fileKey(candidate));
      if (hit) return hit;
    }
  }
  return null;
}

function addEdges(ctx, file, text) {
  for (const imp of importsOf(text)) {
    const target = resolveSpec(ctx, imp.spec, file);
    if (!target) continue;
    const key = fileKey(target);
    if (!ctx.reverse.has(key)) ctx.reverse.set(key, []);
    ctx.reverse.get(key).push({ from: file, names: imp.names });
  }
}

function reverseGraph(ctx) {
  if (ctx.reverse) return ctx.reverse;
  ctx.reverse = new Map();
  const deadline = Math.max(ctx.deadline, Date.now() + 150);
  for (const file of [...ctx.files.values()]) {
    if (Date.now() > deadline) break;
    const text = sourceOf(ctx, file);
    if (text && /\bimport\b|\brequire\s*\(|\bexport\b/.test(text)) addEdges(ctx, file, text);
  }
  return ctx.reverse;
}

export function routeOfFile(file, root, framework) {
  if (!framework || !root) return null;
  const rel = path.relative(root, file).split(/[\\/]/);
  if (!rel.length || rel[0] === '..' || path.isAbsolute(rel[0])) return null;
  const segs = rel[0] === 'src' ? rel.slice(1) : rel;
  const name = (segs.at(-1) || '').replace(/\.[^.]+$/, '');
  const clean = (dirs) => {
    const out = [];
    for (const seg of dirs) {
      if (seg.startsWith('(.')) return null;
      if (/^\(.*\)$/.test(seg) || seg.startsWith('@')) continue;
      out.push(seg);
    }
    return `/${out.join('/')}`;
  };
  const pagesRoute = (dirs) => {
    if (dirs[0] === 'api') return null;
    if (name.startsWith('_')) return name === '_app' || name === '_layout' ? { url: clean(dirs), prefix: true } : null;
    const url = clean(name === 'index' ? dirs : [...dirs, name]);
    return url ? { url, prefix: false } : null;
  };
  const dirs = segs.slice(1, -1);
  if (framework === 'next') {
    if (segs[0] === 'app') {
      if (name === 'page') { const url = clean(dirs); return url ? { url, prefix: false } : null; }
      if (name === 'layout' || name === 'template') { const url = clean(dirs); return url ? { url, prefix: true } : null; }
      return null;
    }
    if (segs[0] === 'pages') return pagesRoute(dirs);
    return null;
  }
  if (framework === 'sveltekit' && segs[0] === 'routes') {
    if (name === '+page') { const url = clean(dirs); return url ? { url, prefix: false } : null; }
    if (name === '+layout') { const url = clean(dirs); return url ? { url, prefix: true } : null; }
    return null;
  }
  if ((framework === 'nuxt' || framework === 'astro') && segs[0] === 'pages') return pagesRoute(dirs);
  if (framework === 'nuxt' && (segs[0] === 'layouts' || (segs.length === 1 && name === 'app'))) return { url: '/', prefix: true };
  if (framework === 'astro' && segs[0] === 'layouts') return { url: '/', prefix: true };
  return null;
}

const routeUrl = (r) => (r.prefix ? (r.url === '/' ? '/*' : `${r.url}/*`) : r.url);

function routeInfo(ctx, file) {
  const own = routeOfFile(file, ctx.root, ctx.framework);
  const reverse = reverseGraph(ctx);
  const importers = reverse.get(fileKey(file)) || [];
  if (own) return { urls: [routeUrl(own)], importers };
  const pages = [];
  const layouts = [];
  const seen = new Set([fileKey(file)]);
  let frontier = [file];
  for (let depth = 0; depth < 8 && frontier.length && seen.size < 800; depth++) {
    const next = [];
    for (const current of frontier) {
      for (const edge of reverse.get(fileKey(current)) || []) {
        const key = fileKey(edge.from);
        if (seen.has(key)) continue;
        seen.add(key);
        const route = routeOfFile(edge.from, ctx.root, ctx.framework);
        if (route) (route.prefix ? layouts : pages).push(routeUrl(route));
        else next.push(edge.from);
      }
    }
    frontier = next;
  }
  return { urls: [...new Set([...pages, ...layouts])].slice(0, 8), importers };
}

function usageHint(source, file, names) {
  for (const name of names) {
    if (!/^[A-Z][\w$]*$/.test(name)) continue;
    const m = new RegExp(`(?<![\\w$)\\]])<${escapeRe(name)}(?=[\\s/>])`).exec(source);
    if (!m) continue;
    const hint = markupHintAt(source, m.index, file);
    if (hasVisualHint(hint)) return { id: hint.id || '', classes: [...(hint.classes || [])], tag: hint.tag || '', text: '', ...(hint.repeat ? { repeat: true } : {}) };
  }
  return null;
}

function mountHint(ctx, file, importers) {
  const ext = path.extname(file).toLowerCase();
  if (CSS_EXTS.includes(ext)) return null;
  for (const edge of importers.slice(0, 6)) {
    const source = sourceOf(ctx, edge.from);
    if (!source) continue;
    const names = edge.names.length ? edge.names : [path.basename(file).replace(/\.[^.]+$/, '')];
    const hint = usageHint(source, edge.from, names);
    if (hint) return hint;
  }
  return null;
}

const jsxName = (file) => file.replace(/\.(?:m?js|cjs|ts|mts)$/i, '.jsx');

function componentRootHint(ctx, name, file, source) {
  let target = null;
  for (const imp of importsOf(source)) {
    if (imp.names.includes(name)) { target = resolveSpec(ctx, imp.spec, file); if (target) break; }
  }
  if (!target) {
    const hits = [...ctx.files.values()].filter((f) => path.basename(f).replace(/\.[^.]+$/, '') === name);
    if (hits.length === 1) target = hits[0];
  }
  if (!target) return null;
  const text = sourceOf(ctx, target);
  if (!text) return null;
  const first = visualTargets(text, jsxName(target), 1, { limit: 1 })[0];
  return first ? first.hint : null;
}

function enrichComponentNext(events, ch, readText) {
  if (typeof ch.after !== 'string' || !/<[A-Z]/.test(ch.after)) return;
  const count = (text) => {
    const m = new Map();
    for (const x of String(text || '').matchAll(/(?<![\w$)\]])<([A-Z][\w$]*)(?=[\s/>])/g)) m.set(x[1], (m.get(x[1]) || 0) + 1);
    return m;
  };
  const before = count(ch.before);
  const added = [...count(ch.after)].filter(([name, n]) => n > (before.get(name) || 0)).map(([name]) => name);
  if (!added.length) return;
  const ctx = routeContext(ch.file, readText);
  if (!ctx) return;
  const lines = ch.after.split('\n');
  for (const ev of events) {
    if (!ev || ev.kind === 'remove' || (ev.next && hasVisualHint(ev.next))) continue;
    const chunk = lines.slice(Math.max(0, ev.startLine - 1), Math.max(ev.startLine, ev.endLine)).join('\n');
    const name = added.find((n) => new RegExp(`(?<![\\w$)\\]])<${escapeRe(n)}(?=[\\s/>])`).test(chunk));
    if (!name) continue;
    const root = componentRootHint(ctx, name, ch.file, ch.after);
    if (!root || sameHint(root, ev.hint)) continue;
    ev.next = root;
    ev.kind = 'add';
  }
}

export function creationEvents(file, text, readText = defaultReadText, phase = 'pre') {
  const ext = path.extname(file).toLowerCase();
  const targets = visualTargets(text, file, 1);
  const ctx = routeContext(file, readText);
  if (ctx) addVirtualSource(ctx, file, text);
  const route = ctx ? routeOfFile(file, ctx.root, ctx.framework) : null;
  if (!targets.length) {
    return route ? [makeEvent(file, 1, 1, 'add', emptyHint(), { phase, created: true })] : [];
  }
  let site = null;
  if (ctx && !route) site = mountHint(ctx, file, reverseGraph(ctx).get(fileKey(file)) || []);
  const kind = CSS_EXTS.includes(ext) ? 'style' : 'add';
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const delta = kind === 'add' && /^[A-Z][\w]*$/.test(base) ? { el: clipDelta(base) } : null;
  return targets.slice(0, MAX_CODEX_EVENTS).map((target) =>
    makeEvent(file, target.line, target.line, kind, site ? { ...site, classes: [...site.classes] } : emptyHint(), { phase, next: target.hint, created: true, ...(delta ? { delta } : {}) }));
}

export function applyFileRoutes(events, readText = defaultReadText) {
  const list = Array.isArray(events) ? events : [];
  const cache = new Map();
  return list.map((event) => {
    if (!event || typeof event !== 'object' || (event.surface && event.surface !== 'dom')) return event;
    if (event.url || typeof event.file !== 'string' || !event.file || !path.isAbsolute(event.file)) return event;
    const key = fileKey(event.file);
    if (!cache.has(key)) {
      let urls = [];
      try {
        const ctx = routeContext(event.file, readText);
        if (ctx && ctx.framework) urls = routeInfo(ctx, event.file).urls;
      } catch { urls = []; }
      cache.set(key, urls);
    }
    const urls = cache.get(key);
    if (!urls.length) return event;
    const first = urls.find((u) => !u.endsWith('/*')) || urls[0];
    return { ...event, url: first.endsWith('/*') ? first.slice(0, -2) || '/' : first, urls };
  });
}

const PROJECT_MARKER = path.join('.agent-cursors', 'routes.json');
const GIT_TIMEOUT_MS = 1500;

function projectAnchorOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 64; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) return { kind: 'git', root: dir }; } catch {}
    try { if (fs.statSync(path.join(dir, PROJECT_MARKER)).isFile()) return { kind: 'marker', root: dir }; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitIgnoredPaths(root, rels) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key];
  try {
    const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: root, env, input: rels.join('\0') + '\0', encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
    });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    return new Set(String(r.stdout || '').split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

export function projectFileFilter(files, cwd = process.cwd(), { ignored = gitIgnoredPaths } = {}) {
  const abs = (file) => (path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file));
  const verdict = new Map();
  const byRoot = new Map();
  for (const file of files) {
    if (typeof file !== 'string' || !file) continue;
    const full = abs(file);
    const key = fileKey(full);
    if (verdict.has(key)) continue;
    const anchor = projectAnchorOf(full);
    verdict.set(key, !!anchor);
    if (!anchor || anchor.kind !== 'git') continue;
    if (!byRoot.has(anchor.root)) byRoot.set(anchor.root, []);
    byRoot.get(anchor.root).push({ key, rel: path.relative(anchor.root, full).split(path.sep).join('/') });
  }
  for (const [root, items] of byRoot) {
    const hidden = ignored(root, items.map((item) => item.rel));
    if (!hidden) continue;
    for (const item of items) if (hidden.has(item.rel)) verdict.set(item.key, false);
  }
  return (file) => typeof file !== 'string' || !file || verdict.get(fileKey(abs(file))) !== false;
}

export function keepProjectFiles(domEvents, actions, cwd = process.cwd(), opts) {
  const dom = Array.isArray(domEvents) ? domEvents : [];
  const acts = Array.isArray(actions) ? actions : [];
  const files = [
    ...dom.map((event) => event && event.file),
    ...acts.filter((action) => action && action.surface === 'file' && isVisualSourceFile(action.file)).map((action) => action.file),
  ].filter((file) => typeof file === 'string' && file);
  if (!files.length) return { domEvents: dom, actions: acts };
  const inProject = projectFileFilter(files, cwd, opts);
  const keptDom = dom.filter((event) => !event || inProject(event.file));
  if (dom.handled) keptDom.handled = true;
  return {
    domEvents: keptDom,
    actions: acts.map((action) => (action && action.surface === 'file' && isVisualSourceFile(action.file) && !inProject(action.file)
      ? { ...action, meta: { ...(action.meta || {}), outside: true } }
      : action)),
  };
}

const ACTION_SURFACES = new Set(['file', 'shell', 'git', 'test', 'plan']);

function actionLineCount(s) {
  if (typeof s !== 'string' || !s) return 0;
  const normalized = s.replace(/\r\n/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n').length : normalized.split('\n').length;
}

function truncate(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function labelFor(action) {
  if (action === 'add') return 'Created';
  if (action === 'delete') return 'Deleted';
  return 'Edited';
}

function makeAction({ surface, action, file = '', meta = {}, text = '' }) {
  return {
    surface: ACTION_SURFACES.has(surface) ? surface : 'file',
    action,
    file,
    startLine: 1,
    endLine: 1,
    kind: 'edit',
    hint: emptyHint(),
    meta,
    text: truncate(text, 200),
  };
}

export function buildActions(input) {
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'PostToolUse') return [];
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const resp = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const out = [];

  if (tool === 'apply_patch') {
    for (const op of patchFileOps(String(ti.command || ''))) {
      const file = path.isAbsolute(op.file) ? path.normalize(op.file) : path.resolve(cwd, op.file);
      out.push(makeAction({
        surface: 'file', action: op.action, file,
        meta: { added: op.added, removed: op.removed },
        text: `${labelFor(op.action)} ${path.basename(file)} (+${op.added}/−${op.removed})`,
      }));
    }
    return out;
  }

  if (HANDLED_TOOLS.has(tool)) {
    let file = ti.file_path;
    if (typeof file !== 'string' || !file) return [];
    file = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
    let added = 0;
    let removed = 0;
    let action = 'edit';
    if (tool === 'Write') {
      added = actionLineCount(typeof ti.content === 'string' ? ti.content : '');
      action = resp.type === 'create' ? 'add' : 'edit';
    } else {
      const edits = tool === 'MultiEdit' && Array.isArray(ti.edits) ? ti.edits : [ti];
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') continue;
        removed += actionLineCount(typeof edit.old_string === 'string' ? edit.old_string : '');
        added += actionLineCount(typeof edit.new_string === 'string' ? edit.new_string : '');
      }
    }
    out.push(makeAction({
      surface: 'file', action, file,
      meta: { added, removed },
      text: `${labelFor(action)} ${path.basename(file)} (+${added}/−${removed})`,
    }));
    return out;
  }

  if (SHELL_TOOLS.has(tool)) {
    let command = ti.command;
    if (Array.isArray(command)) command = command.join(' ');
    if (typeof command !== 'string' || !command) return [];
    const meta = { command: truncate(command, 200) };
    const exit = num(resp.exit_code ?? resp.exitCode ?? resp.code);
    const durationMs = num(resp.duration_ms ?? resp.durationMs);
    if (exit !== undefined) meta.exit = exit;
    if (durationMs !== undefined) meta.durationMs = durationMs;
    out.push(makeAction({ surface: 'shell', action: 'run', meta, text: `$ ${truncate(command, 80)}` }));
    return out;
  }

  if (PLAN_TOOLS.has(tool)) {
    out.push(makeAction({ surface: 'plan', action: 'plan', text: 'Plan güncellendi' }));
  }
  return out;
}

const PLAIN_SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const TEST_FILE_RE = /(?:^|[\\/])(?:__tests__|__mocks__|tests?|e2e|cypress|playwright)[\\/]|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i;

export function isTestFile(file) {
  if (typeof file !== 'string' || !file) return false;
  const abs = path.isAbsolute(file) ? file : path.resolve(file);
  const anchor = projectAnchorOf(abs);
  return TEST_FILE_RE.test(anchor ? path.relative(anchor.root, abs) : path.basename(abs));
}

function dropNonVisualScripts(events, input, readText) {
  if (!Array.isArray(events) || !events.length) return events;
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const extra = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.new_string) : [])]
    .filter((v) => typeof v === 'string');
  const verdict = new Map();
  const visual = (file) => {
    if (verdict.has(file)) return verdict.get(file);
    const texts = [safeRead(readText, file), ...extra].filter((v) => typeof v === 'string' && v);
    const ok = texts.some((text) => visualTargets(text, jsxName(file), 1, { limit: 1 }).length > 0);
    verdict.set(file, ok);
    return ok;
  };
  const out = events.filter((event) => {
    if (!event || (event.surface && event.surface !== 'dom') || typeof event.file !== 'string') return true;
    if (isTestFile(event.file)) return false;
    if (!PLAIN_SCRIPT_EXTS.has(path.extname(event.file).toLowerCase())) return true;
    return visual(event.file);
  });
  if (events.handled) out.handled = true;
  return out;
}

export function buildEvents(input, readText = defaultReadText) {
  return dropNonVisualScripts(buildEventsRaw(input, readText), input, readText);
}

function buildEventsRaw(input, readText = defaultReadText) {
  if (!input || typeof input !== 'object') return [];
  const tool = input.tool_name;
  if (input.hook_event_name === 'PreToolUse') {
    const planned = planPreEvents(input, readText);
    if (planned && (planned.length || planned.handled)) return planned;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
    return eventsFromShellCommand(command, typeof input.cwd === 'string' ? input.cwd : process.cwd(), readText);
  }
  if (tool === 'apply_patch') {
    const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
    return eventsFromCodexPatch(command, typeof input.cwd === 'string' ? input.cwd : process.cwd(), readText);
  }
  if (!HANDLED_TOOLS.has(tool)) return eventsFromStructuredTool(input, readText);
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  let file = ti.file_path;
  if (typeof file !== 'string' || !file) return [];
  if (!path.isAbsolute(file)) file = path.resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), file);
  if (!isVisualSourceFile(file)) return [];

  const content = safeRead(readText, file);
  const total = content === null ? 1 : countLines(content);
  const resp = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};

  if (tool === 'Write') {
    const text = content !== null ? content : typeof ti.content === 'string' ? ti.content : '';
    if (input.hook_event_name !== 'PreToolUse' && resp.type === 'create') {
      try { return creationEvents(file, text, readText, 'post'); } catch { return []; }
    }
    if (input.hook_event_name === 'PreToolUse') {
      const targets = visualTargets(text, file, 1);
      if (targets.length) return targets.map((target) => makeEvent(file, target.line, target.line, content === null ? 'add' : 'edit', target.hint));
    }
    return [makeEvent(file, 1, countLines(text), resp.type === 'create' ? 'add' : 'edit')];
  }

  const edits =
    tool === 'MultiEdit'
      ? Array.isArray(ti.edits) ? ti.edits : []
      : [{ old_string: ti.old_string, new_string: ti.new_string }];

  const events = [];
  for (const edit of edits.slice(0, MAX_EVENTS)) {
    if (!edit || typeof edit !== 'object') continue;
    const oldStr = typeof edit.old_string === 'string' ? edit.old_string : '';
    const newStr = typeof edit.new_string === 'string' ? edit.new_string : '';
    const kind = guessKind(oldStr, newStr);
    if (input.hook_event_name === 'PreToolUse') {
      const oldRange = content !== null ? locate(content, oldStr) : null;
      const targets = visualTargets(newStr, file, oldRange?.start ?? 1);
      if (targets.length) {
        for (const target of targets) events.push(makeEvent(file, target.line, target.line, kind, target.hint));
        continue;
      }
    }

    let range = input.hook_event_name === 'PreToolUse' ? null : tool === 'Edit' ? rangeFromPatch(resp.structuredPatch) : null;
    if (!range && content !== null) range = locate(content, input.hook_event_name === 'PreToolUse' ? oldStr : newStr);
    if (!range) range = { start: 1, end: total };

    let hint = emptyHint();
    if (!newStr.trim() && oldStr.trim()) hint = extractHint(oldStr, 1, countLines(oldStr), { file });

    events.push(makeEvent(file, range.start, range.end, kind, hint));
  }
  return events;
}

const CSS_EXTS = ['.css', '.scss', '.sass', '.less', '.styl'];

const lineAtOffset = (text, at) => text.slice(0, Math.max(0, at)).split('\n').length;

function diffRegion(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { prefix, oldPart: before.slice(prefix, before.length - suffix), newPart: after.slice(prefix, after.length - suffix) };
}

function slideToBoundary(before, region) {
  let { prefix, oldPart, newPart } = region;
  if (oldPart && newPart) return region;
  const isInsert = !oldPart;
  let part = isInsert ? newPart : oldPart;
  for (let i = 0; i < 200 && prefix > 0 && part && !/^[<\s]/.test(part) && before[prefix - 1] === part[part.length - 1]; i++) {
    part = before[prefix - 1] + part.slice(0, -1);
    prefix--;
  }
  return isInsert ? { prefix, oldPart, newPart: part } : { prefix, oldPart: part, newPart };
}

function insideStyleBlock(text, offset) {
  const open = text.lastIndexOf('<style', offset);
  return open >= 0 && open > text.lastIndexOf('</style', offset);
}

function expandLines(text, a, b) {
  const from = a <= 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1;
  const nl = text.indexOf('\n', Math.max(b, from));
  return text.slice(from, nl < 0 ? text.length : nl);
}

function kindOfPart(part, ext, removed) {
  if (countOpenTags(part) > 0) return removed ? 'remove' : 'add';
  if (CSS_EXTS.includes(ext) && /\{/.test(part)) return removed ? 'remove' : 'add';
  if (RESIZE_RE.test(part)) return 'resize';
  if (STYLE_RE.test(part)) return 'style';
  return 'edit';
}

function sameHint(a, b) {
  return !!a && !!b && a.id === b.id && (a.classes || []).join(' ') === (b.classes || []).join(' ');
}

function preHint(before, offset, oldPart, file) {
  if (oldPart.trim() && /<[A-Za-z]/.test(oldPart)) {
    const own = extractHint(oldPart, 1, countLines(oldPart), { file });
    if (hasVisualHint(own)) {
      const ownAt = Math.max(0, offset) + Math.max(0, oldPart.indexOf('<'));
      return withPath(withRepeatHint(before, ownAt, own), ancestorsAt(before, ownAt, file));
    }
  }
  return markupHintAt(before, offset, file, oldPart);
}

function lineHunks(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const whole = [{ aStart: p, aEnd: a.length - s, newLines: B }];
  if (!A.length || !B.length || A.length > 1500 || B.length > 1500 || A.length * B.length > 400000) return whole;
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (cur) { hunks.push(cur); cur = null; }
      i++; j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur = cur || { aStart: p + i, aEnd: p + i, newLines: [] };
      cur.newLines.push(B[j]);
      j++;
    } else {
      cur = cur || { aStart: p + i, aEnd: p + i, newLines: [] };
      cur.aEnd = p + i + 1;
      i++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks.length ? hunks : whole;
}

export function eventsFromHunks(file, before, after) {
  const prev = typeof before === 'string' ? before : '';
  if (typeof after !== 'string' || prev === after) return [];
  const lines = prev.split('\n');
  const hunks = [];
  for (const h of lineHunks(prev, after)) {
    const n = h.aEnd - h.aStart;
    if (n > 1 && n === h.newLines.length && n <= 40) {
      for (let k = 0; k < n; k++) {
        if (lines[h.aStart + k] !== h.newLines[k]) hunks.push({ aStart: h.aStart + k, aEnd: h.aStart + k + 1, newLines: [h.newLines[k]] });
      }
    } else hunks.push(h);
  }
  if (hunks.length < 2) return eventsFromChange(file, before, after);
  const out = [];
  const seen = new Set();
  let delta = 0;
  for (const h of hunks) {
    const partial = [...lines.slice(0, h.aStart), ...h.newLines, ...lines.slice(h.aEnd)].join('\n');
    for (const ev of eventsFromChange(file, prev, partial)) {
      const hint = ev.hint || {};
      const key = [ev.startLine, ev.kind, hint.id, (hint.classes || []).join('.'), hint.tag, hint.text, hint.nth, ev.next ? JSON.stringify(ev.next) : ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...ev, startLine: ev.startLine + delta, endLine: ev.endLine + delta });
      if (out.length >= MAX_CODEX_EVENTS) return out;
    }
    delta += h.newLines.length - (h.aEnd - h.aStart);
  }
  return out.length ? out : eventsFromChange(file, before, after);
}

const DELTA_MAX = 40;
const DELTA_TOKENS = 6;
function clipDelta(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > DELTA_MAX ? `${t.slice(0, DELTA_MAX - 1)}…` : t;
}
const CODEISH_TEXT_RE = /[=;{}[\]<>]|=>|\b(?:return|const|let|var|function|import|export)\b/;

function textRun(s, a, b) {
  const scan = (stopL, stopR) => {
    let L = a;
    let R = b;
    while (L > 0 && a - L < 160 && !stopL.test(s[L - 1])) L--;
    while (R < s.length && R - b < 160 && !stopR.test(s[R])) R++;
    return s.slice(L, R).replace(/\s+/g, ' ').trim();
  };
  const jsx = scan(/[>}\n]/, /[<{\n]/);
  if (jsx && !/[="`;(),:]|=>|^'|'$/.test(jsx)) return jsx;
  return scan(/[\n'"`]/, /[\n'"`]/);
}

function textDelta(prev, after, prefix, oldPart, newPart) {
  const from = textRun(prev, prefix, prefix + oldPart.length);
  const to = textRun(after, prefix, prefix + newPart.length);
  if (!from || !to || from === to || CODEISH_TEXT_RE.test(from) || CODEISH_TEXT_RE.test(to)) return null;
  return { from: clipDelta(from), to: clipDelta(to) };
}

const CLASS_TOKEN_RE = /^!?(?:[\w-]+:)*-?[a-z][a-z0-9]*(?:-[\w./[\]#%(),]+)+$/i;
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function styleTokens(line, ext) {
  const out = [];
  const cssLike = CSS_EXTS.includes(ext) || /^\s*[a-z-]+\s*:\s*[^:]+;?\s*$/i.test(line);
  if (cssLike) {
    for (const m of line.matchAll(/(^|[\s{;])([a-z-]+)\s*:\s*([^;{}\n]+?)\s*(?=;|\}|$)/gi)) out.push(`${m[2].toLowerCase()}: ${m[3]}`);
    return out;
  }
  if (/\bstyle\s*=\s*\{\{/.test(line)) {
    for (const m of line.matchAll(/\b([a-zA-Z]+)\s*:\s*(?:(['"])([^'"\n]{1,40})\2|(-?\d+(?:\.\d+)?))/g)) out.push(`${kebab(m[1])}: ${m[3] ?? `${m[4]}px`}`);
  }
  for (const m of line.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
    for (const tok of m[2].split(/\s+/)) if (tok && tok.length <= DELTA_MAX && CLASS_TOKEN_RE.test(tok)) out.push(tok);
  }
  return out;
}

function tokenDiff(a, b) {
  const left = new Map();
  for (const t of b) left.set(t, (left.get(t) || 0) + 1);
  const out = [];
  for (const t of a) {
    const n = left.get(t) || 0;
    if (n > 0) left.set(t, n - 1);
    else if (!out.includes(t)) out.push(t);
  }
  return out;
}

const SIZE_NAMED = {
  0: 0, px: 0.25, xs: 80, sm: 96, md: 112, lg: 128, xl: 144, '2xl': 168, '3xl': 192, '4xl': 224, '5xl': 256,
  '6xl': 288, '7xl': 320, prose: 260, min: 150, fit: 200, max: 250, auto: 200, full: 400, screen: 480,
  svh: 480, dvh: 480, lvh: 480, svw: 480, dvw: 480, lvw: 480,
};

function sizeValue(v) {
  const s = String(v || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SIZE_NAMED, s)) return SIZE_NAMED[s];
  let m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return (400 * Number(m[1])) / Math.max(1, Number(m[2]));
  m = /^(-?\d*\.?\d+)(px|rem|em|%|vw|vh|ch|fr)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'px': return n / 4;
    case 'rem': case 'em': return n * 4;
    case '%': return n * 4;
    case 'vw': case 'vh': return n * 4.8;
    case 'ch': return n * 2;
    default: return n;
  }
}

function sizeToken(tok) {
  const t = /^[a-z-]+:\s/.test(tok) ? tok : tok.replace(/^!?(?:[\w-]+:)*/, '');
  let m = /^(?:(min|max)-)?(w|h|size|basis)-(.+)$/.exec(t);
  if (m) {
    const value = sizeValue(m[3]);
    const axis = m[2] === 'h' ? 'h' : m[2] === 'size' ? 'wh' : 'w';
    return value === null ? null : { axis, fam: `${m[1] || ''}${m[2]}`, value };
  }
  m = /^(col|row)-span-(\d+|full)$/.exec(t);
  if (m) return { axis: m[1] === 'row' ? 'h' : 'w', fam: `${m[1]}-span`, value: m[2] === 'full' ? 99 : Number(m[2]) };
  m = /^((?:min-|max-)?(?:width|height|inline-size|block-size)|flex-basis):\s*(.+)$/.exec(t);
  if (m) {
    const value = sizeValue(m[2].split(/\s+/)[0]);
    return value === null ? null : { axis: /height|block/.test(m[1]) ? 'h' : 'w', fam: m[1], value };
  }
  return null;
}

function sizeDir(removed, added) {
  const dir = { w: 0, h: 0 };
  const olds = removed.map(sizeToken).filter(Boolean);
  for (const nt of added.map(sizeToken).filter(Boolean)) {
    const ot = olds.find((o) => o.fam === nt.fam);
    if (!ot || ot.value === nt.value) continue;
    const s = nt.value > ot.value ? 1 : -1;
    if (nt.axis !== 'h' && !dir.w) dir.w = s;
    if (nt.axis !== 'w' && !dir.h) dir.h = s;
  }
  return dir.w || dir.h ? dir : null;
}

function elementName(part) {
  const m = /(?<![\w$)\]])<([A-Za-z][\w.]*)/.exec(String(part || ''));
  if (!m) return '';
  const name = m[1];
  if (/^(?:div|span|Fragment|React\.Fragment|template|slot)$/.test(name)) return '';
  return /^[A-Za-z][\w.:-]*$/.test(name) ? clipDelta(name) : '';
}

export function deltaOf(kind, ext, prev, after, prefix, oldPart, newPart, oldEx, newEx) {
  try {
    if (kind === 'text') return textDelta(prev, after, prefix, oldPart, newPart);
    if (kind === 'add' || kind === 'remove') {
      const el = elementName(kind === 'add' ? newPart : oldPart);
      return el ? { el } : null;
    }
    if (kind === 'style' || kind === 'resize' || kind === 'edit') {
      const a = styleTokens(oldEx, ext);
      const b = styleTokens(newEx, ext);
      const removed = tokenDiff(a, b).slice(0, DELTA_TOKENS).map(clipDelta);
      const added = tokenDiff(b, a).slice(0, DELTA_TOKENS).map(clipDelta);
      if (!removed.length && !added.length) return null;
      const out = { removed, added };
      if (kind === 'resize') {
        const size = sizeDir(removed, added);
        if (size) out.size = size;
      }
      return out;
    }
  } catch {}
  return null;
}

export function eventsFromChange(file, before, after) {
  const prev = typeof before === 'string' ? before : '';
  if (typeof after !== 'string' || prev === after) return [];
  const ext = path.extname(file).toLowerCase();
  const { prefix, oldPart, newPart } = slideToBoundary(prev, diffRegion(prev, after));
  const oldBlank = !oldPart.trim();
  const newBlank = !newPart.trim();
  if (oldBlank && newBlank) return [];

  const startLine = lineAtOffset(after, prefix);
  const endLine = startLine + Math.max(0, newPart.split('\n').length - 1);
  const oldEx = expandLines(prev, prefix, prefix + oldPart.length);
  const newEx = expandLines(after, prefix, prefix + newPart.length);
  const wholeLines = (part) => (prefix === 0 || prev[prefix - 1] === '\n') && part.endsWith('\n');
  let kind;
  if (oldBlank || newBlank) {
    const part = oldBlank ? newPart : oldPart;
    const structural = countOpenTags(part) > 0 || (CSS_EXTS.includes(ext) && /\{/.test(part));
    kind = structural || wholeLines(part) ? kindOfPart(part, ext, !oldBlank) : guessKind(oldEx, newEx);
  } else kind = guessKind(oldEx, newEx);

  const styleCtx = CSS_EXTS.includes(ext) || insideStyleBlock(prev, prefix) ? '.css' : ext;
  const delta = deltaOf(kind, styleCtx, prev, after, prefix, oldPart, newPart, oldEx, newEx);
  if (CSS_EXTS.includes(ext)) return cssEvents(file, file, prev, after, prefix, oldPart, newPart, kind, delta);
  if (insideStyleBlock(prev, prefix)) return cssEvents(`${file}.css`, file, prev, after, prefix, oldPart, newPart, kind, delta);
  return markupEvents(file, prev, after, prefix, oldPart, newPart, kind, delta);
}

function cssEvents(cssFile, file, prev, after, prefix, oldPart, newPart, kind, delta = null) {
  const oldBlank = !oldPart.trim();
  const startOld = lineAtOffset(prev, prefix);
  const startLine = lineAtOffset(after, prefix);
  const endLine = startLine + Math.max(0, newPart.split('\n').length - 1);
  const oldEx = expandLines(prev, prefix, prefix + oldPart.length);
  const newEx = expandLines(after, prefix, prefix + newPart.length);
  const rules = [];
  const seen = new Set();
  const prevLines = prev.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const push = (hint, line, nestLines = null, nestLine = 0) => {
    if (!hasHint(hint)) return;
    let h = hint;
    if (h.selector && ((nestLines && cssNestDepth(nestLines, nestLine - 1) > 0) || !(hasVisualHint(h) || usefulSelector(h.selector)))) {
      h = { ...h };
      delete h.selector;
      if (!hasHint(h)) return;
    }
    const key = `${h.id}|${(h.classes || []).join('.')}|${h.tag}|${h.selector || ''}`;
    if (!seen.has(key)) { seen.add(key); rules.push({ line, hint: h }); }
  };
  if (!oldBlank) push(extractHint(prev, startOld, startOld + oldPart.split('\n').length - 1, { file: cssFile }), startLine);
  if (/\{/.test(oldEx)) visualTargets(oldEx, cssFile, startOld).forEach((t) => push(t.hint, startLine, prevLines, t.line));
  if (/\{/.test(newEx)) visualTargets(newEx, cssFile, startLine).forEach((t) => push(t.hint, t.line, afterLines, t.line));
  if (!rules.length) push(extractHint(after, startLine, endLine, { file: cssFile }), startLine);
  const props = cssChangedProps(oldEx, newEx);
  const extra = () => {
    const o = delta ? { phase: 'pre', delta } : { phase: 'pre' };
    if (props.length) o.cssProps = props;
    return o;
  };
  if (rules.length) return rules.slice(0, MAX_CODEX_EVENTS).map((r) => makeEvent(file, startLine, endLine, kind, r.hint, extra()));
  return [makeEvent(file, startLine, endLine, kind, emptyHint(), extra())];
}

export function cssChangedProps(oldEx, newEx) {
  const a = styleTokens(String(oldEx || ''), '.css');
  const b = styleTokens(String(newEx || ''), '.css');
  const names = [...tokenDiff(a, b), ...tokenDiff(b, a)].map((tok) => tok.split(':')[0].trim().toLowerCase());
  return normalizeCssProps(names);
}

function markupEvents(file, prev, after, prefix, oldPart, newPart, kind, delta = null) {
  const startLine = lineAtOffset(after, prefix);
  const endLine = startLine + Math.max(0, newPart.split('\n').length - 1);

  let hint = preHint(prev, prefix, oldPart, file);
  let next = null;
  if (kind === 'add') {
    const own = newPart.trim() ? extractHint(newPart, 1, countLines(newPart), { file }) : emptyHint();
    if (hasVisualHint(own)) next = withPath(own, ancestorsAt(after, prefix + Math.max(0, newPart.indexOf('<')), file));
  } else if (!hasVisualHint(hint)) {
    const post = markupHintAt(after, prefix, file, newPart);
    if (hasVisualHint(post)) hint = post;
  }
  if (!hasVisualHint(hint) && !next) {
    const repeated = repeatedDataTargets(prev, file, prefix);
    if (repeated.length) {
      return repeated.slice(0, MAX_CODEX_EVENTS).map((target) =>
        makeEvent(file, target.line, target.line, kind, target.hint, delta ? { phase: 'pre', delta } : { phase: 'pre' }));
    }
  }
  if (!hasHint(hint) && next) hint = emptyHint();
  const extra = { phase: 'pre' };
  if (delta) extra.delta = delta;
  if (next && !sameHint(next, hint)) extra.next = next;
  return [makeEvent(file, startLine, endLine, kind, hint, extra)];
}

function hasHint(h) {
  return !!(h && (h.id || h.tag || h.text || h.selector || (h.classes && h.classes.length)));
}

function applyReplace(content, oldStr, newStr, all = false) {
  if (typeof content !== 'string' || typeof oldStr !== 'string' || typeof newStr !== 'string' || !oldStr) return null;
  let c = content;
  let o = oldStr;
  let n = newStr;
  if (!c.includes(o)) {
    const crlf = c.includes('\r\n');
    c = c.replace(/\r\n/g, '\n');
    o = o.replace(/\r\n/g, '\n');
    n = n.replace(/\r\n/g, '\n');
    if (!c.includes(o)) return null;
    const out = all ? c.split(o).join(n) : c.replace(o, () => n);
    return crlf ? out.replace(/\n/g, '\r\n') : out;
  }
  return all ? c.split(o).join(n) : c.replace(o, () => n);
}

function replaceBlock(content, oldLines, newLines) {
  const oldText = oldLines.join('\n');
  if (!oldText.trim()) return null;
  const at = content.indexOf(oldText);
  if (at >= 0) return content.slice(0, at) + newLines.join('\n') + content.slice(at + oldText.length);
  const lines = content.split('\n');
  const want = oldLines.map((l) => l.trimEnd());
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (lines[i + k].trimEnd() !== want[k]) { ok = false; break; }
    if (ok) return [...lines.slice(0, i), ...newLines, ...lines.slice(i + want.length)].join('\n');
  }
  return null;
}

function parseCodexPatch(command) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const line of String(command).replace(/\r\n/g, '\n').split('\n')) {
    let m;
    if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) { flush(); cur = { op: 'update', file: m[1].trim(), hunks: [], h: null }; continue; }
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) { flush(); cur = { op: 'add', file: m[1].trim(), add: [] }; continue; }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) { flush(); cur = { op: 'delete', file: m[1].trim() }; continue; }
    if (/^\*\*\* End Patch/.test(line)) { flush(); continue; }
    if (/^\*\*\* (?:Begin Patch|Move to:|End of File)/.test(line)) continue;
    if (!cur) continue;
    if (cur.op === 'update') {
      if (line.startsWith('@@')) { cur.h = { old: [], next: [] }; cur.hunks.push(cur.h); continue; }
      if (!cur.h) { cur.h = { old: [], next: [] }; cur.hunks.push(cur.h); }
      const c = line[0];
      if (c === '+') cur.h.next.push(line.slice(1));
      else if (c === '-') cur.h.old.push(line.slice(1));
      else if (c === ' ') { cur.h.old.push(line.slice(1)); cur.h.next.push(line.slice(1)); }
      else if (line === '') { cur.h.old.push(''); cur.h.next.push(''); }
    } else if (cur.op === 'add' && line.startsWith('+')) cur.add.push(line.slice(1));
  }
  flush();
  return out;
}

function fromMsysPath(file) {
  if (process.platform !== 'win32') return file;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(String(file));
  if (!m) return file;
  const root = `${m[1].toUpperCase()}:\\`;
  try { if (!fs.existsSync(root)) return file; } catch { return file; }
  return path.join(root, (m[2] || '').replace(/\//g, '\\'));
}

function pathIn(file, cwd) {
  const f = fromMsysPath(file);
  return path.isAbsolute(f) ? path.normalize(f) : path.resolve(cwd, f);
}

function changesFromHeredoc(command, cwd, readText) {
  const changes = [];
  const PATH = `("[^"]+"|'[^']+'|[^\\s;|&<>]+)`;
  const header = new RegExp(`\\bcat\\s*(?:(>>?)\\s*${PATH}\\s*<<-?\\s*(['"]?)(\\w+)\\3|<<-?\\s*(['"]?)(\\w+)\\5\\s*(>>?)\\s*${PATH})`, 'g');
  for (const m of command.matchAll(header)) {
    const op = m[1] || m[7];
    const rawPath = m[2] || m[8];
    const tag = m[4] || m[6];
    const lineEnd = command.indexOf('\n', m.index + m[0].length);
    if (!op || !rawPath || !tag || lineEnd < 0) continue;
    const rest = command.slice(lineEnd + 1);
    const close = new RegExp(`^[\\t ]*${tag}[\\t ]*\\r?$`, 'm').exec(rest);
    if (!close) continue;
    const body = rest.slice(0, close.index).replace(/\r?\n$/, '');
    const abs = pathIn(rawPath.replace(/^['"]|['"]$/g, ''), cwd);
    if (!isVisualSourceFile(abs)) continue;
    const before = safeRead(readText, abs);
    if (op === '>>') {
      const after = before === null ? body : `${before}${before.endsWith('\n') || !before ? '' : '\n'}${body}`;
      changes.push({ file: abs, before, after });
    } else changes.push({ file: abs, before, after: body, fullWrite: true });
  }
  return changes;
}

function changesFromCodexPatch(command, cwd, readText) {
  const changes = [];
  for (const item of parseCodexPatch(command)) {
    const abs = pathIn(item.file, cwd);
    if (!isVisualSourceFile(abs)) continue;
    const before = safeRead(readText, abs);
    if (item.op === 'delete') { changes.push({ file: abs, before, after: null, removed: true }); continue; }
    if (item.op === 'add') { changes.push({ file: abs, before: null, after: item.add.join('\n') }); continue; }
    if (before === null) continue;
    let after = before.replace(/\r\n/g, '\n');
    const base = after;
    let failed = false;
    for (const hunk of item.hunks) {
      if (!hunk.old.join('').trim()) { after = `${after}${after.endsWith('\n') || !after ? '' : '\n'}${hunk.next.join('\n')}`; continue; }
      const next = replaceBlock(after, hunk.old, hunk.next);
      if (next === null) { failed = true; continue; }
      after = next;
    }
    if (failed && after === base) continue;
    changes.push({ file: abs, before: base, after });
  }
  return changes;
}

function changesFromSed(command, cwd, readText) {
  const changes = [];
  const re = /\bsed\s+(?:-[A-Za-z]*i[A-Za-z.]*\s+|-i\S*\s+)(?:-e\s+)?(['"])s([\/|#,@])((?:\\.|(?!\2).)*)\2((?:\\.|(?!\2).)*)\2([gI]*)\1\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g;
  for (const m of command.matchAll(re)) {
    const abs = pathIn(m[6].replace(/^['"]|['"]$/g, ''), cwd);
    if (!isVisualSourceFile(abs)) continue;
    const before = safeRead(readText, abs);
    if (before === null) continue;
    let after = before;
    try {
      const unescape = (v) => v.split(`\\${m[2]}`).join(m[2]);
      const pattern = new RegExp(unescape(m[3]), `${m[5].includes('g') ? 'g' : ''}${m[5].includes('I') ? 'i' : ''}m`);
      after = before.replace(pattern, unescape(m[4]).replace(/\\n/g, '\n').replace(/&/g, '$&'));
    } catch {}
    if (after !== before) changes.push({ file: abs, before, after });
  }
  return changes;
}

const SCRIPT_MAX_BYTES = 1024 * 1024;
const SCRIPT_MAX_OPS = 400;
const SCRIPT_CMD_RE = /(?:^|[\s;&|(`'"])(?:python(?:3(?:\.\d+)?)?|py|node)(?:\.exe)?(?=[\s"'])/m;
const SCRIPT_PATH_RE = new RegExp(`^[^\\n<>{}"'\`;=|*?]{1,260}\\.(?:${[...VISUAL_SOURCE_EXTS].map((e) => e.slice(1)).join('|')})$`, 'i');
const SEGMENT_RE = /^[\w@.()[\]+-]{1,80}$/;
const OTHER_PATH_RE = /^(?=[^\n]*[\\/.])[^\n<>{}"'`;=|*?\s]{1,260}\.(?:cs|csproj|sln|md|mdx|json|ya?ml|toml|txt|py|go|rs|java|kt|rb|sql|sh|ps1|env|xml|ini|cfg|lock|config|resx|proto|graphql|gql)$/i;
const isScriptPath = (v) => typeof v === 'string' && v === v.trim() && SCRIPT_PATH_RE.test(v);

function unescapeLiteral(s, lang) {
  const py = lang === 'py';
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', "'": "'", '"': '"' };
  return s.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(\r?\n)|([\s\S]))/g,
    (m, x, ub, u, U, nl, ch) => {
      try {
        if (x) return String.fromCharCode(parseInt(x, 16));
        if (ub) return py ? m : String.fromCodePoint(parseInt(ub, 16));
        if (u) return String.fromCharCode(parseInt(u, 16));
        if (U) return py ? String.fromCodePoint(parseInt(U, 16)) : m.slice(1);
      } catch { return m; }
      if (nl !== undefined) return '';
      if (ch === 'a' && py) return '\x07';
      if (ch === '`' && !py) return '`';
      if (Object.prototype.hasOwnProperty.call(simple, ch)) return simple[ch];
      return py ? m : ch;
    });
}

function readQuoted(text, i, lang, prefix = '') {
  const q = text[i];
  const triple = lang === 'py' && text.startsWith(q.repeat(3), i);
  const open = triple ? 3 : 1;
  const n = text.length;
  let j = i + open;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (triple ? text.startsWith(q.repeat(3), j) : ch === q) break;
    if (!triple && q !== '`' && ch === '\n') return { v: null, end: j };
    j++;
  }
  const body = text.slice(i + open, Math.min(j, n));
  const end = Math.min(n, j + open);
  let v = prefix.includes('r') ? body : unescapeLiteral(body, lang);
  if (prefix.includes('f')) v = /\{(?!\{)/.test(body.replace(/\{\{|\}\}/g, '')) ? null : v.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
  if (q === '`' && /\$\{/.test(body)) v = null;
  return { v, end };
}

export function scriptTokens(text, lang) {
  const py = lang === 'py';
  const toks = [];
  const n = text.length;
  let i = 0;
  const lastSignificant = () => {
    for (let k = i - 1; k >= 0; k--) if (!/\s/.test(text[k])) return text[k];
    return '';
  };
  while (i < n) {
    const c = text[i];
    if (py && c === '#') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (!py && c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (!py && c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (!py && c === '/' && (!lastSignificant() || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant()))) {
      let j = i + 1, cls = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
        else if (text[j] === '/' && !cls) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (py && /^(?:[rbuf]|rb|br|fr|rf)$/i.test(word) && (text[j] === '"' || text[j] === "'")) {
        const s = readQuoted(text, j, lang, word.toLowerCase());
        toks.push({ t: 's', v: s.v, start: i, end: s.end });
        i = s.end;
        continue;
      }
      toks.push({ t: 'id', v: word, start: i, end: j });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || (!py && c === '`')) {
      const s = readQuoted(text, i, lang);
      toks.push({ t: 's', v: s.v, start: i, end: s.end });
      i = s.end;
      continue;
    }
    i++;
  }
  const merged = [];
  for (const tok of toks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.t === 's' && tok.t === 's') {
      const gap = text.slice(prev.end, tok.start);
      if (/^\s*\+\s*$/.test(gap) || (py && /^\s*$/.test(gap))) {
        prev.v = prev.v === null || tok.v === null ? null : prev.v + tok.v;
        prev.end = tok.end;
        continue;
      }
    }
    merged.push({ ...tok });
  }
  return merged;
}

export function changesFromScriptText(text, lang, roots, readText = defaultReadText) {
  if (typeof text !== 'string' || !text || !roots.length) return [];
  const py = lang === 'py';
  const toks = scriptTokens(text, lang);
  const gapAt = (k) => text.slice(toks[k].end, k + 1 < toks.length ? toks[k + 1].start : text.length);
  const gapBefore = (k) => text.slice(k > 0 ? toks[k - 1].end : 0, toks[k].start);

  const assigns = new Map();
  const targets = new Set();
  for (let k = 0; k + 1 < toks.length; k++) {
    const tok = toks[k];
    if (tok.t !== 'id' || toks[k + 1].t !== 's' || !/^\s*=\s*$/.test(gapAt(k))) continue;
    const before = gapBefore(k);
    const declared = k > 0 && toks[k - 1].t === 'id' && /^(?:const|let|var)$/.test(toks[k - 1].v) && /^\s+$/.test(before);
    const stmtStart = /(?:^|[\n;])[ \t]*$/.test(before) || (k === 0 && /^\s*$/.test(before));
    if (!declared && !stmtStart) continue;
    if (!/^[ \t]*(?:[;\r\n#]|\/\/|$)/.test(gapAt(k + 1))) continue;
    if (!assigns.has(tok.v)) assigns.set(tok.v, []);
    assigns.get(tok.v).push({ pos: tok.start, v: toks[k + 1].v });
    targets.add(k);
  }
  const resolveVar = (name, pos) => {
    const list = assigns.get(name);
    if (!list) return undefined;
    let found;
    for (const a of list) if (a.pos < pos) found = a;
    return found ? found.v : undefined;
  };
  const vals = toks.map((tok, k) => {
    if (tok.t === 's') return { v: tok.v, start: tok.start, end: tok.end, k };
    if (targets.has(k) || text[tok.start - 1] === '.') return null;
    if (/^\s*=(?!=)/.test(gapAt(k))) return null;
    const v = resolveVar(tok.v, tok.start);
    return v === undefined ? null : { v, start: tok.start, end: tok.end, k, ref: true };
  });

  const runs = [];
  let cur = null;
  for (let k = 0; k < toks.length; k++) {
    const val = vals[k];
    if (!val) { cur = null; continue; }
    const sep = cur ? gapAt(k - 1) : '';
    if (cur && /^\s*,\s*$/.test(sep) && cur.sep !== '/') cur.items.push(val);
    else if (cur && /^\s*\/\s*$/.test(sep) && (cur.sep === '/' || cur.items.length === 1)) { cur.sep = '/'; cur.items.push(val); }
    else { cur = { items: [val], sep: ',' }; runs.push(cur); }
  }

  const paths = [];
  const others = [];
  const ops = [];
  const used = new Set();
  const notePath = (rel, pos) => {
    if (isScriptPath(rel)) { paths.push({ rel, pos }); return true; }
    if (OTHER_PATH_RE.test(rel)) { others.push({ pos }); return true; }
    return false;
  };
  for (const run of runs) {
    const items = run.items;
    const lead = text.slice(Math.max(0, items[0].start - 80), items[0].start);
    const joinable = run.sep === '/' || /(?:join|resolve)\s*\(\s*(?:[\w.$]+(?:\([^()]*\))?\s*,\s*)?$/.test(lead);
    if (joinable && items.length > 1) {
      const last = items[items.length - 1];
      if (typeof last.v === 'string' && items.every((it) => typeof it.v === 'string' && (it === last || SEGMENT_RE.test(it.v) || /^[\w.@-]+(?:[\\/][\w.@()[\]+-]+)*$/.test(it.v)))) {
        if (notePath(items.map((it) => it.v).join('/'), items[0].start)) {
          for (const it of items) used.add(it);
          continue;
        }
      }
    }
    for (const it of items) if (typeof it.v === 'string' && notePath(it.v, it.start)) used.add(it);
  }
  if (!paths.length) return [];

  const WRITE_FNS = /^(?:writeFileSync|writeFile|outputFileSync|appendFileSync|appendFile)$/;
  for (let k = 1; k < toks.length; k++) {
    const val = vals[k];
    if (!val || used.has(val) || typeof val.v !== 'string') continue;
    const prev = toks[k - 1];
    if (py && prev.t === 'id' && /^write(?:_text)?$/.test(prev.v) && text[prev.start - 1] === '.' && /^\s*\(\s*$/.test(gapBefore(k))) {
      const p = [...paths].reverse().find((item) => item.pos < val.start && val.start - item.pos < 600);
      if (!p) continue;
      const between = text.slice(p.pos, val.start);
      const append = /open\s*\([^)]*['"]a\+?b?['"]/.test(between);
      if (prev.v !== 'write_text' && !/open\s*\([^)]*['"](?:w|a)\+?b?['"]/.test(between)) continue;
      ops.push({ type: 'write', pos: val.start, rel: p.rel, content: val.v, append });
      used.add(val);
    } else if (!py && k > 1 && vals[k - 1] && isScriptPath(vals[k - 1].v) && /^\s*,\s*$/.test(gapBefore(k))
      && toks[k - 2].t === 'id' && WRITE_FNS.test(toks[k - 2].v) && /^\s*\(\s*$/.test(gapBefore(k - 1))) {
      ops.push({ type: 'write', pos: val.start, rel: vals[k - 1].v, content: val.v, append: /^append/.test(toks[k - 2].v) });
      used.add(val);
    }
  }

  for (const run of runs) {
    if (run.sep === '/') continue;
    const items = run.items.filter((it) => !used.has(it));
    const lead = text.slice(Math.max(0, run.items[0].start - 40), run.items[0].start);
    const all = py ? !/,\s*1\s*\)/.test(text.slice(run.items[run.items.length - 1].end, run.items[run.items.length - 1].end + 8)) : /replaceAll\s*\(\s*$/.test(lead);
    for (let p = 0; p + 1 < items.length; p += 2) {
      const oldV = items[p].v, newV = items[p + 1].v;
      if (typeof oldV !== 'string' || typeof newV !== 'string' || oldV === newV || oldV.trim().length < 3) continue;
      ops.push({ type: 'pair', pos: items[p].start, oldV, newV, all });
    }
  }
  if (!ops.length) return [];
  ops.sort((a, b) => a.pos - b.pos);

  const resolved = new Map();
  const resolvePath = (rel) => {
    if (resolved.has(rel)) return resolved.get(rel);
    const f = fromMsysPath(rel);
    let file = null;
    if (path.isAbsolute(f)) file = path.normalize(f);
    else {
      for (const root of roots) {
        const cand = path.resolve(root, f);
        if (safeRead(readText, cand) !== null) { file = cand; break; }
      }
      if (!file) file = path.resolve(roots[0], f);
    }
    resolved.set(rel, file);
    return file;
  };
  const state = new Map();
  const stateOf = (file) => {
    if (!state.has(file)) {
      const before = safeRead(readText, file);
      state.set(file, { before, cur: before, fullWrite: false });
    }
    return state.get(file);
  };
  const candidates = [...new Set(paths.map((p) => resolvePath(p.rel)))].filter(isVisualSourceFile).slice(0, 40);
  for (const op of ops.slice(0, SCRIPT_MAX_OPS)) {
    if (op.type === 'write') {
      const file = resolvePath(op.rel);
      if (!isVisualSourceFile(file)) continue;
      const st = stateOf(file);
      if (op.append) st.cur = `${st.cur ?? ''}${op.content}`;
      else { st.cur = op.content; st.fullWrite = st.before !== null; }
      continue;
    }
    const seg = [...paths].reverse().find((p) => p.pos < op.pos);
    const otherSeg = [...others].reverse().find((p) => p.pos < op.pos);
    if (otherSeg && (!seg || otherSeg.pos > seg.pos)) continue;
    const order = seg ? [resolvePath(seg.rel), ...candidates] : candidates;
    for (const file of order) {
      if (!isVisualSourceFile(file)) continue;
      const st = stateOf(file);
      if (typeof st.cur !== 'string') continue;
      const at = st.cur.indexOf(op.oldV);
      if (at < 0) {
        if (st.cur.includes('\r\n') && st.cur.includes(op.oldV.replace(/\r?\n/g, '\r\n'))) {
          const o = op.oldV.replace(/\r?\n/g, '\r\n'), nv = op.newV.replace(/\r?\n/g, '\r\n');
          st.cur = op.all ? st.cur.split(o).join(nv) : st.cur.replace(o, () => nv);
          break;
        }
        continue;
      }
      st.cur = op.all ? st.cur.split(op.oldV).join(op.newV) : st.cur.slice(0, at) + op.newV + st.cur.slice(at + op.oldV.length);
      break;
    }
  }
  const changes = [];
  for (const [file, st] of state) {
    if (typeof st.cur !== 'string' || st.cur === st.before) continue;
    const ch = { file, before: st.before, after: st.cur };
    if (st.fullWrite) ch.fullWrite = true;
    changes.push(ch);
  }
  return changes;
}

function shellLex(command) {
  const toks = [];
  const n = command.length;
  const heredocs = [];
  let i = 0;
  const readHeredocBodies = () => {
    for (const h of heredocs.splice(0)) {
      const rest = command.slice(i);
      const close = new RegExp(`^${h.strip ? '\\t*' : ''}${escapeRe(h.tag)}[ \\t]*\\r?$`, 'm').exec(rest);
      if (!close) { h.tok.body = rest; i = n; return; }
      h.tok.body = rest.slice(0, close.index).replace(/\r?\n$/, '');
      i += close.index + close[0].length;
    }
  };
  while (i < n) {
    const c = command[i];
    if (c === '\n') { toks.push({ t: 'op', v: '\n' }); i++; if (heredocs.length) readHeredocBodies(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) { const e = command.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' && /\s/.test(command[i + 1] || ' ')) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (command.startsWith('<<<', i)) { toks.push({ t: 'redir', v: '<<<' }); i += 3; continue; }
    if (two === '<<') {
      let j = i + 2;
      let strip = false;
      if (command[j] === '-') { strip = true; j++; }
      while (command[j] === ' ' || command[j] === '\t') j++;
      const m = /^(['"]?)([\w.-]+)\1/.exec(command.slice(j));
      if (m) {
        const tok = { t: 'heredoc', tag: m[2], quoted: !!m[1], body: '' };
        toks.push(tok);
        heredocs.push({ tag: m[2], strip, tok });
        i = j + m[0].length;
        continue;
      }
    }
    const redir = /^(?:\d?>>?|<|&>)&?\d?/.exec(command.slice(i, i + 4));
    if (redir && (c === '>' || c === '<' || c === '&' || /\d/.test(c) && /[<>]/.test(command[i + 1] || ''))) {
      toks.push({ t: 'redir', v: redir[0] });
      i += redir[0].length;
      continue;
    }
    const parts = [];
    while (i < n) {
      const ch = command[i];
      if (/[\s;&|()<>]/.test(ch)) break;
      if (ch === "'") {
        const e = command.indexOf("'", i + 1);
        parts.push({ q: 's', s: command.slice(i + 1, e < 0 ? n : e) });
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (ch === '"') {
        let s = '';
        i++;
        while (i < n && command[i] !== '"') {
          if (command[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(command[i + 1])) { s += command[i + 1] === '\n' ? '' : command[i + 1]; i += 2; continue; }
          s += command[i];
          i++;
        }
        i++;
        parts.push({ q: 'd', s });
        continue;
      }
      if (ch === '\\' && i + 1 < n) { parts.push({ q: 's', s: command[i + 1] === '\n' ? '' : command[i + 1] }); i += 2; continue; }
      let j = i;
      while (j < n && !/[\s;&|()<>'"\\]/.test(command[j])) j++;
      parts.push({ q: 'n', s: command.slice(i, j) });
      i = j;
    }
    toks.push({ t: 'w', parts });
  }
  return toks;
}

function expandWord(parts, env) {
  let out = '';
  for (const part of parts || []) {
    if (part.q === 's') { out += part.s; continue; }
    let s = part.s.replace(/\$\{(\w+)\}|\$env:(\w+)|\$(\w+)/gi, (m, a, e, b) => {
      if (e) return process.env[e] ?? process.env[e.toUpperCase()] ?? m;
      const name = a || b;
      if (name === 'PWD') return env.dir;
      if (env.vars.has(name)) return env.vars.get(name);
      if (name === 'HOME' || name === 'TEMP' || name === 'TMP' || name === 'TMPDIR' || name === 'USERPROFILE') {
        return process.env[name] ?? (name === 'HOME' ? os.homedir() : m);
      }
      return m;
    });
    if (part.q === 'n' && out === '' && s.startsWith('~')) s = os.homedir() + s.slice(1);
    out += s;
  }
  return out;
}

export function scriptsInCommand(command, cwd, readText = defaultReadText) {
  if (typeof command !== 'string' || !SCRIPT_CMD_RE.test(command)) return [];
  const out = [];
  const env = { dir: cwd, vars: new Map() };
  const toks = shellLex(command);
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  let cmd = [];
  const flush = () => {
    const words = [];
    let heredoc = null, herestring = null, stdinFile = '';
    for (let k = 0; k < cmd.length; k++) {
      const tok = cmd[k];
      if (tok.t === 'heredoc') heredoc = tok;
      else if (tok.t === 'redir') {
        const target = cmd[k + 1] && cmd[k + 1].t === 'w' ? expandWord(cmd[k + 1].parts, env) : '';
        if (tok.v === '<<<') herestring = target;
        else if (tok.v === '<') stdinFile = target;
        if (target) k++;
      } else if (tok.t === 'w') words.push(tok);
    }
    cmd = [];
    let w = 0;
    while (w < words.length) {
      const first = words[w].parts[0];
      const raw = expandWord(words[w].parts, env);
      if (raw === 'export' && w + 1 < words.length) { w++; continue; }
      const m = first && first.q === 'n' ? /^([A-Za-z_]\w*)=/.exec(first.s) : null;
      if (!m) break;
      env.vars.set(m[1], raw.slice(m[0].length));
      w++;
    }
    if (w >= words.length) return;
    const name = path.basename(expandWord(words[w].parts, env)).toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(w + 1).map((word) => expandWord(word.parts, env));
    if ((name === 'cd' || name === 'set-location' || name === 'pushd') && args.length) {
      const target = args.find((a) => !a.startsWith('-'));
      if (target) env.dir = pathIn(target, env.dir);
      return;
    }
    const lang = /^(?:python(?:3(?:\.\d+)?)?|py)$/.test(name) ? 'py' : name === 'node' ? 'js' : '';
    if (!lang) return;
    let code = null, file = null, stdin = false;
    let a = 0;
    for (; a < args.length; a++) {
      const arg = args[a];
      if (arg === '-') { stdin = true; a++; break; }
      if (lang === 'py') {
        if (arg === '-m') return;
        if (/^-[A-Za-z]*c$/.test(arg)) { code = args[a + 1] ?? ''; a += 2; break; }
        if (arg === '-X' || arg === '-W') { a++; continue; }
        if (arg.startsWith('-')) continue;
      } else {
        if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') { code = args[a + 1] ?? ''; a += 2; break; }
        const eq = /^--(?:eval|print)=([\s\S]*)$/.exec(arg);
        if (eq) { code = eq[1]; a++; break; }
        if (arg === '-r' || arg === '--require' || arg === '--import' || arg === '--loader') { a++; continue; }
        if (arg.startsWith('-')) continue;
      }
      file = arg;
      a++;
      break;
    }
    const rest = args.slice(a);
    const roots = [env.dir];
    for (const arg of rest) {
      if (!arg || arg.startsWith('-')) continue;
      const p = pathIn(arg, env.dir);
      if (!roots.includes(p) && isDir(p)) roots.push(p);
    }
    let text = code;
    if (text === null && file) {
      const abs = pathIn(file, env.dir);
      try { if (fs.statSync(abs).size > SCRIPT_MAX_BYTES) return; } catch {}
      text = safeRead(readText, abs);
      if (text !== null && !roots.includes(path.dirname(abs))) roots.push(path.dirname(abs));
    }
    if (text === null && (stdin || !file)) {
      if (heredoc) text = heredoc.body;
      else if (herestring) text = herestring;
      else if (stdinFile && !/^(?:\/dev\/null|\$null|nul)$/i.test(stdinFile)) text = safeRead(readText, pathIn(stdinFile, env.dir));
    }
    if (typeof text === 'string' && text) out.push({ lang, text, roots });
  };
  for (const tok of toks) {
    if (tok.t === 'op') { flush(); continue; }
    cmd.push(tok);
  }
  flush();
  for (const m of command.matchAll(/@(['"])\r?\n([\s\S]*?)\r?\n\1@\s*\|\s*(python(?:3(?:\.\d+)?)?|py|node)(?:\.exe)?\b/gi)) {
    out.push({ lang: /^node$/i.test(m[3]) ? 'js' : 'py', text: m[2], roots: [cwd] });
  }
  return out.slice(0, 8);
}

function changesFromScripts(command, cwd, readText) {
  const changes = [];
  for (const script of scriptsInCommand(command, cwd, readText)) {
    try { changes.push(...changesFromScriptText(script.text, script.lang, script.roots, readText)); } catch {}
  }
  return changes;
}

function leadingDir(command, cwd) {
  const m = /^\s*(?:cd|Set-Location|pushd)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n)/i.exec(String(command || ''));
  return m ? pathIn(m[1] || m[2] || m[3], cwd) : cwd;
}

const COMPONENT_DECL_RE = /(?:^|\n)[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function[ \t]+([A-Z][\w$]*)[ \t]*(?:<[^>\n]*>)?\(|(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let)[ \t]+([A-Z][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:(?:React\.)?(?:memo|forwardRef)[ \t]*(?:<[^>\n]*>)?\([ \t]*)?(?:async[ \t]*)?(?:\([^)]*\)|[\w$]+)[ \t]*(?::[^=\n]+)?=>/g;
const COMPONENT_EXTS = new Set(['.jsx', '.tsx', '.js', '.mjs']);
const HTML_TAG_RE = /^(?:a|abbr|address|article|aside|audio|b|blockquote|body|button|canvas|caption|cite|code|col|colgroup|data|dd|del|details|dfn|dialog|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|i|iframe|img|input|ins|kbd|label|legend|li|main|mark|menu|meter|nav|ol|optgroup|option|output|p|picture|pre|progress|q|s|samp|search|section|select|slot|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|time|tr|u|ul|var|video|circle|ellipse|g|line|path|polygon|polyline|rect|text|tspan|use)$/;

function componentRoots(text, file) {
  const decls = [];
  for (const m of text.matchAll(COMPONENT_DECL_RE)) {
    const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
    decls.push({ name: m[1] || m[2], at, exported: /^\s*export\b/.test(m[0]), isDefault: /^\s*export\s+default\b/.test(m[0]) });
  }
  return decls.map((d, i) => {
    const end = i + 1 < decls.length ? decls[i + 1].at : text.length;
    const startLine = lineAtOffset(text, d.at);
    const first = visualTargets(text.slice(d.at, end), jsxName(file), startLine, { limit: 1 })[0];
    return { ...d, startLine, endLine: lineAtOffset(text, end), root: first ? first.hint : null };
  });
}

function primaryComponent(comps, file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return comps.find((c) => c.name === base) || comps.find((c) => c.isDefault) || comps.find((c) => c.exported) || comps[0] || null;
}

export function anchorToComponents(events, textOf) {
  const list = Array.isArray(events) ? events : [];
  const cache = new Map();
  const taken = new Set();
  const out = [];
  let dropped = false;
  for (const ev of list) {
    if (!ev || (ev.surface && ev.surface !== 'dom') || ev.created || typeof ev.file !== 'string') { out.push(ev); continue; }
    const h = ev.hint || {};
    const textual = typeof h.text === 'string' && h.text.length >= 4 && (!h.tag || HTML_TAG_RE.test(h.tag));
    const visual = hasVisualHint(h) || textual || (ev.next && hasVisualHint(ev.next));
    if (visual || !COMPONENT_EXTS.has(path.extname(ev.file).toLowerCase())) {
      if (visual && hasVisualHint(h)) taken.add(`${fileKey(ev.file)}:${(h.classes || []).join('.')}:${h.id || ''}`);
      out.push(ev);
      continue;
    }
    if (!cache.has(ev.file)) {
      let text = null;
      try { text = textOf(ev.file); } catch { text = null; }
      cache.set(ev.file, typeof text === 'string' ? componentRoots(text, ev.file) : []);
    }
    const comps = cache.get(ev.file);
    const inside = comps.find((c) => ev.startLine >= c.startLine && ev.startLine < c.endLine);
    const comp = inside || primaryComponent(comps, ev.file);
    if (!comp || !comp.root) { dropped = true; continue; }
    const key = `${fileKey(ev.file)}:${(comp.root.classes || []).join('.')}:${comp.root.id || ''}`;
    if (taken.has(key)) { dropped = true; continue; }
    taken.add(key);
    out.push({ ...ev, kind: ev.kind === 'remove' || ev.kind === 'add' ? 'edit' : ev.kind, hint: { ...comp.root, classes: [...(comp.root.classes || [])] }, anchor: 'component' });
  }
  if (dropped || list.handled) out.handled = true;
  return out;
}

export function shellCommandOf(ti) {
  if (!ti || typeof ti !== 'object') return '';
  const c = ti.command ?? ti.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    if (c.length >= 3 && /^-l?c$/.test(c[c.length - 2])) return c[c.length - 1];
    return c.join(' ');
  }
  return '';
}

const SNAP_DIR = path.join(os.tmpdir(), 'agent-cursors', 'shell');
const SNAP_TTL_MS = 30 * 60 * 1000;
const SNAP_MAX_FILE = 512 * 1024;
const SNAP_MAX_TOTAL = 8 * 1024 * 1024;
const SNAP_GIT_TIMEOUT_MS = 1200;

const READ_ONLY_CMDS = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'echo', 'printf', 'pwd',
  'cd', 'pushd', 'popd', 'sed', 'awk', 'which', 'where', 'type', 'file', 'stat', 'du', 'df', 'date', 'sort', 'uniq', 'cut', 'tr',
  'tree', 'less', 'more', 'nl', 'diff', 'cmp', 'jq', 'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath',
  'readlink', 'printenv', 'whoami', 'hostname', 'uname', 'sleep', 'curl', 'column', 'xxd', 'od', 'sha256sum', 'md5sum',
  'get-content', 'get-childitem', 'select-string', 'test-path', 'get-item', 'get-location', 'write-output', 'write-host',
  'measure-object', 'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'out-string',
  'gci', 'gc', 'sls', 'set-location', 'resolve-path', 'get-command', 'get-process', 'foreach-object', '%', '?',
]);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'branch', 'blame', 'grep',
  'describe', 'remote', 'shortlog', 'cat-file', 'ls-tree', 'reflog', 'fetch', 'check-ignore', 'config', 'tag']);

export function isReadOnlyCommand(command) {
  const c = String(command || '');
  if (!c.trim() || /<</.test(c)) return false;
  const stripped = c.replace(/\d?>&\d|&?\d?>\s*(?:\/dev\/null|\$null|nul)\b|\|\s*Out-Null\b/gi, '');
  if (/>/.test(stripped.replace(/'[^']*'|"[^"]*"/g, ''))) return false;
  for (const seg of stripped.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().replace(/^\(+/, '').split(/\s+/).filter((w) => !/^[A-Za-z_]\w*=/.test(w));
    if (!words.length || !words[0]) continue;
    const name = path.basename(words[0].replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.exe$/, '');
    if (name === 'git') {
      const sub = words.slice(1).find((w) => !w.startsWith('-') && !/^[A-Za-z]:|\//.test(w));
      if (!sub || !GIT_READ_ONLY.has(sub.toLowerCase())) return false;
      continue;
    }
    if (name === 'sed' && /\s-[A-Za-z]*i/.test(seg)) return false;
    if (name === 'find' && /\s-(?:delete|exec|execdir|ok|fprint)/.test(seg)) return false;
    if (name === 'curl' && /\s-(?:o|O|-output)\b/.test(seg)) return false;
    if (!READ_ONLY_CMDS.has(name)) return false;
  }
  return true;
}

function gitRun(root, args, timeout = SNAP_GIT_TIMEOUT_MS) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key];
  try {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout ?? '');
  } catch {
    return null;
  }
}

export function gitDirtyVisual(root) {
  const out = gitRun(root, ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (out === null) return null;
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const rel = entry.slice(3);
    if (isVisualSourceFile(rel)) map.set(rel, xy);
  }
  return map;
}

function shellRoots(command, cwd) {
  const dirs = [cwd];
  for (const m of String(command || '').matchAll(/(?:^|[\s;&|(])(?:cd|Set-Location|pushd)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/gi)) {
    dirs.push(pathIn(m[1] || m[2] || m[3], cwd));
  }
  const roots = [];
  for (const dir of dirs.slice(0, 6)) {
    const anchor = projectAnchorOf(path.join(dir, '.agent-cursors-probe'));
    if (anchor && anchor.kind === 'git' && !roots.some((r) => fileKey(r) === fileKey(anchor.root))) roots.push(anchor.root);
  }
  return roots.slice(0, 3);
}

const snapFile = (input) => path.join(SNAP_DIR, `${crypto.createHash('sha256').update(groupOf(input)).digest('hex').slice(0, 32)}.json`);

function cleanSnapshots() {
  try {
    const t = Date.now();
    for (const name of fs.readdirSync(SNAP_DIR)) {
      const p = path.join(SNAP_DIR, name);
      try { if (t - fs.statSync(p).mtimeMs > SNAP_TTL_MS) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

export function snapshotShell(input, shown = [], { dir = SNAP_DIR } = {}) {
  if (!input || !SHELL_TOOLS.has(input.tool_name)) return false;
  const command = shellCommandOf(input.tool_input);
  if (!command || isReadOnlyCommand(command)) return false;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const roots = shellRoots(command, cwd);
  if (!roots.length) return false;
  const snap = { at: Date.now(), roots: {}, shown: [...new Set(shown.filter((f) => typeof f === 'string' && f).map(fileKey))] };
  let total = 0;
  for (const root of roots) {
    const dirty = gitDirtyVisual(root);
    if (!dirty) continue;
    const files = {};
    for (const [rel, xy] of dirty) {
      const abs = path.join(root, ...rel.split('/'));
      let st;
      try { st = fs.statSync(abs); } catch { files[rel] = { xy, missing: true }; continue; }
      const item = { xy, m: st.mtimeMs, s: st.size };
      if (st.size <= SNAP_MAX_FILE && total + st.size <= SNAP_MAX_TOTAL) {
        const text = safeRead(defaultReadText, abs);
        if (text !== null) { item.t = text; total += st.size; }
      }
      files[rel] = item;
    }
    snap.roots[root] = files;
  }
  if (!Object.keys(snap.roots).length) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (Math.random() < 0.05) cleanSnapshots();
    fs.writeFileSync(dir === SNAP_DIR ? snapFile(input) : path.join(dir, path.basename(snapFile(input))), JSON.stringify(snap));
    return true;
  } catch {
    return false;
  }
}

const SHOWN_FILE = path.join(os.tmpdir(), 'agent-cursors', 'shown.json');
const SHOWN_TTL_MS = 30 * 60 * 1000;

function readShown(file = SHOWN_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((x) => x && typeof x.f === 'string' && Number.isFinite(x.at)) : [];
  } catch {
    return [];
  }
}

export function noteShown(files, { file = SHOWN_FILE, at = Date.now() } = {}) {
  const keys = [...new Set((files || []).filter((f) => typeof f === 'string' && f).map(fileKey))];
  if (!keys.length) return;
  const list = readShown(file).filter((x) => at - x.at < SHOWN_TTL_MS && !keys.includes(x.f));
  for (const f of keys) list.push({ f, at });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list.slice(-300)));
  } catch {}
}

const lf = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s);

function hintSurvives(hint, text) {
  if (!hint || typeof text !== 'string') return false;
  const word = (w) => new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`).test(text);
  if (hint.id) return word(hint.id);
  const cls = Array.isArray(hint.classes) ? hint.classes : [];
  return cls.length > 0 && cls.every(word);
}

function lineStats(before, after) {
  if (typeof before !== 'string') return { added: actionLineCount(after), removed: 0 };
  let added = 0, removed = 0;
  for (const h of lineHunks(before, after)) { added += h.newLines.length; removed += h.aEnd - h.aStart; }
  return { added, removed };
}

export function shellChangeEvents(input, readText = defaultReadText, { dir = SNAP_DIR, shownFile = SHOWN_FILE } = {}) {
  const empty = { events: [], actions: [] };
  if (!input || !SHELL_TOOLS.has(input.tool_name)) return empty;
  const file = dir === SNAP_DIR ? snapFile(input) : path.join(dir, path.basename(snapFile(input)));
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return empty; }
  try { fs.unlinkSync(file); } catch {}
  if (!snap || typeof snap !== 'object' || !snap.roots) return empty;
  const shown = new Set(Array.isArray(snap.shown) ? snap.shown : []);
  for (const item of readShown(shownFile)) if (item.at >= snap.at - 500) shown.add(item.f);
  const changes = [];
  for (const [root, before] of Object.entries(snap.roots)) {
    const now = gitDirtyVisual(root);
    if (!now) continue;
    for (const [rel, xy] of now) {
      if (xy.includes('D')) continue;
      const abs = path.join(root, ...rel.split('/'));
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const prev = before && before[rel];
      if (prev && !prev.missing && prev.m === st.mtimeMs && prev.s === st.size) continue;
      if (!prev && st.mtimeMs < snap.at - 2000) continue;
      const after = safeRead(readText, abs);
      if (after === null) continue;
      let base;
      if (prev && typeof prev.t === 'string') base = prev.t;
      else if (prev && prev.missing) base = null;
      else if (prev) continue;
      else if (xy === '??') base = null;
      else {
        base = gitRun(root, ['show', `:${rel}`]);
        if (base === null) base = gitRun(root, ['show', `HEAD:${rel}`]);
        if (base === null) continue;
      }
      if (lf(base) === lf(after)) continue;
      changes.push({ file: abs, before: base === null ? null : lf(base), after: lf(after) });
      if (changes.length >= 16) break;
    }
  }
  const events = [];
  const actions = [];
  for (const ch of changes) {
    const { added, removed } = lineStats(ch.before, ch.after);
    const action = ch.before === null ? 'add' : 'edit';
    actions.push(makeAction({
      surface: 'file', action, file: ch.file, meta: { added, removed, via: 'shell' },
      text: `${labelFor(action)} ${path.basename(ch.file)} (+${added}/−${removed})`,
    }));
    if (shown.has(fileKey(ch.file)) || events.length >= MAX_CODEX_EVENTS) continue;
    let evs = [];
    try {
      if (ch.before === null) evs = creationEvents(ch.file, ch.after, readText, 'post');
      else {
        evs = eventsFromHunks(ch.file, ch.before, ch.after);
        try { enrichComponentNext(evs, ch, readText); } catch {}
        for (const ev of evs) {
          if ((ev.kind === 'add' && ev.next) || hintSurvives(ev.hint, ch.after)) continue;
          const now = extractHint(ch.after, ev.startLine, ev.endLine, { file: ch.file });
          if (hasVisualHint(now)) ev.hint = now;
        }
      }
    } catch { evs = []; }
    for (const ev of anchorToComponents(evs, () => ch.after)) { ev.phase = 'post'; events.push(ev); }
  }
  const out = dropNonVisualScripts(events.slice(0, MAX_CODEX_EVENTS), {}, readText);
  return { events: out, actions };
}

const OWNER_DEF_RES = [
  /\bexport\s+default\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g,
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Z][\w$]*)\s*[(<]/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=\n]{0,120})?=\s*(?:React\.)?(?:memo|forwardRef|observer)\s*[(<]/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=\n]{0,120})?=\s*(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,120})?=>/g,
  /\bclass\s+([A-Z][\w$]*)\s+extends\b/g,
];
export function ownerOf(source, file, line = 0) {
  const base = path.basename(String(file || ''));
  if (!base || base.length > 80) return null;
  const ext = path.extname(base).toLowerCase();
  if (ext === '.vue' || ext === '.svelte') return { names: [base.slice(0, -ext.length)].filter((n) => /^[A-Za-z_$][\w$]{0,60}$/.test(n)), file: base };
  if (!['.jsx', '.tsx', '.js', '.ts', '.mjs', '.mts'].includes(ext) || typeof source !== 'string') return null;
  const defs = new Map();
  for (const re of OWNER_DEF_RES) {
    for (const m of source.matchAll(re)) {
      if (!defs.has(m[1])) defs.set(m[1], source.slice(0, m.index || 0).split('\n').length);
    }
  }
  if (!defs.size) return null;
  const names = [...defs.entries()]
    .sort((a, b) => {
      const ai = a[1] <= line ? line - a[1] : 1e6 + a[1];
      const bi = b[1] <= line ? line - b[1] : 1e6 + b[1];
      return ai - bi;
    })
    .map(([n]) => n)
    .filter((n) => n.length <= 61)
    .slice(0, 4);
  return { names, file: base };
}
function withOwners(events, textOf) {
  const cache = new Map();
  for (const ev of events) {
    if (!ev || !ev.file || ev.created || (ev.surface && ev.surface !== 'dom')) continue;
    if (!cache.has(ev.file)) { let t = null; try { t = textOf(ev.file); } catch { t = null; } cache.set(ev.file, t); }
    const owner = ownerOf(cache.get(ev.file), ev.file, ev.startLine || 0);
    if (!owner || !owner.names.length) continue;
    if (ev.hint && hasHint(ev.hint)) ev.hint = { ...ev.hint, owner };
    if (ev.next && hasHint(ev.next)) ev.next = { ...ev.next, owner };
  }
  return events;
}

export function planPreEvents(input, readText = defaultReadText) {
  const tool = input.tool_name;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  let changes = [];

  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
    if (typeof ti.file_path !== 'string' || !ti.file_path) return null;
    const file = pathIn(ti.file_path, cwd);
    if (!isVisualSourceFile(file)) return [];
    const before = safeRead(readText, file);
    if (tool === 'Write') {
      if (typeof ti.content !== 'string') return null;
      changes.push({ file, before, after: ti.content, fullWrite: true });
    } else {
      if (before === null) return null;
      const edits = tool === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
      let current = before;
      for (const edit of edits.slice(0, MAX_EVENTS)) {
        if (!edit || typeof edit !== 'object') continue;
        const next = applyReplace(current, edit.old_string, edit.new_string, edit.replace_all === true);
        if (next === null) return null;
        changes.push({ file, before: current, after: next });
        current = next;
      }
    }
  } else if (tool === 'apply_patch' || (typeof ti.command === 'string' && /\*\*\* Begin Patch/.test(ti.command))) {
    const command = typeof ti.command === 'string' ? ti.command : typeof ti.input === 'string' ? ti.input : '';
    changes = changesFromCodexPatch(command, cwd, readText);
    if (!changes.length) return null;
  } else if (SHELL_TOOLS.has(tool) && shellCommandOf(ti) && (/\bsed\b|<</.test(shellCommandOf(ti)) || SCRIPT_CMD_RE.test(shellCommandOf(ti)))) {
    const command = shellCommandOf(ti);
    const dir = leadingDir(command, cwd);
    const bash = tool !== 'PowerShell';
    changes = [
      ...(bash && /\bsed\b/.test(command) ? changesFromSed(command, dir, readText) : []),
      ...(bash && /<</.test(command) ? changesFromHeredoc(command, dir, readText) : []),
      ...(SCRIPT_CMD_RE.test(command) ? changesFromScripts(command, cwd, readText) : []),
    ];
    if (!changes.length) return null;
  } else return null;

  const events = [];
  for (const ch of changes) {
    if (ch.removed) {
      const hint = ch.before ? extractHint(ch.before, 1, Math.min(8, countLines(ch.before)), { file: ch.file }) : emptyHint();
      events.push(makeEvent(ch.file, 1, 1, 'remove', hint, { phase: 'pre' }));
    } else if (ch.before === null) {
      let created = [];
      try { created = creationEvents(ch.file, ch.after, readText); } catch { created = []; }
      events.push(...created);
    } else if (ch.fullWrite) {
      const targets = visualTargets(ch.after, ch.file, 1);
      if (targets.length) {
        for (const target of targets) {
          events.push(makeEvent(ch.file, target.line, target.line, 'edit', target.hint, { phase: 'pre' }));
          if (events.length >= MAX_CODEX_EVENTS) break;
        }
      } else events.push(...eventsFromChange(ch.file, ch.before, ch.after));
    } else {
      const evs = eventsFromHunks(ch.file, ch.before, ch.after);
      try { enrichComponentNext(evs, ch, readText); } catch {}
      events.push(...evs);
    }
    if (events.length >= MAX_CODEX_EVENTS) break;
  }
  const lastText = new Map();
  for (const ch of changes) if (typeof ch.after === 'string') lastText.set(ch.file, ch.after);
  const anchored = anchorToComponents(events, (file) => (lastText.has(file) ? lastText.get(file) : safeRead(readText, file)));
  try { withOwners(anchored, (file) => (lastText.has(file) ? lastText.get(file) : safeRead(readText, file))); } catch {}
  const out = applyRouteHints(anchored.slice(0, MAX_CODEX_EVENTS), cwd);
  if (anchored.handled || (!out.length && changes.length && changes.every((ch) => ch.before === null))) out.handled = true;
  return out;
}

const CODEX_TOOLS = new Set(['apply_patch', 'shell', 'exec', 'local_shell', 'update_plan']);

export function agentOf(input) {
  const tp = input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (/[\\/]\.codex[\\/]/i.test(tp)) return 'codex';
  if (/[\\/]\.claude[\\/]/i.test(tp)) return 'claude';
  if (input && typeof input.turn_id === 'string' && input.turn_id) return 'codex';
  if (input && CODEX_TOOLS.has(input.tool_name)) return 'codex';
  return 'claude';
}

export function sessionOf(input) {
  const id = input && (input.session_id || input.transcript_path);
  if (typeof id !== 'string' || !id) return '';
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
}

function stampIdentity(list, input) {
  const agent = agentOf(input);
  const session = sessionOf(input);
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    ev.agent = agent;
    if (session) ev.session = session;
  }
  return list;
}

const READ_EXTS = new Set(['.jsx', '.tsx', '.js', '.mjs', '.vue', '.svelte', '.astro', '.html', '.htm']);
const READ_CMDS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'sed', 'get-content', 'gc', 'type']);
const READ_MAX_BYTES = 512 * 1024;

export function readFilesOf(input) {
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'PostToolUse') return [];
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (input.tool_name === 'Read') {
    if (typeof ti.file_path !== 'string' || !ti.file_path) return [];
    const off = Math.floor(Number(ti.offset));
    return [{ file: pathIn(ti.file_path, cwd), line: Number.isFinite(off) && off > 0 ? off : 0 }];
  }
  if (!SHELL_TOOLS.has(input.tool_name)) return [];
  const command = shellCommandOf(ti);
  if (!command || command.length > 500 || /<<|\$\(|`/.test(command) || !isReadOnlyCommand(command)) return [];
  const dir = leadingDir(command, cwd);
  const out = [];
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const words = [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const name = path.basename(String(words[0] || '')).toLowerCase().replace(/\.exe$/, '');
    if (!READ_CMDS.has(name) || (name === 'sed' && !/\s-n\b/.test(seg))) continue;
    let line = 0;
    for (const w of words.slice(1)) {
      const range = /^(\d+)(?:,\d+)?p$/.exec(w);
      if (range) { line = Number(range[1]); continue; }
      if (!w || w.startsWith('-') || !/\.[A-Za-z]{2,6}$/.test(w)) continue;
      out.push({ file: pathIn(w, dir), line });
    }
  }
  return out.slice(0, 2);
}

export function readEvents(input, readText = defaultReadText) {
  const out = [];
  for (const { file, line } of readFilesOf(input)) {
    const ext = path.extname(file).toLowerCase();
    if (!READ_EXTS.has(ext) || isTestFile(file)) continue;
    const text = safeRead(readText, file);
    if (typeof text !== 'string' || !text || text.length > READ_MAX_BYTES) continue;
    let hint = null;
    let start = 1;
    let end = 1;
    if (COMPONENT_EXTS.has(ext)) {
      const comps = componentRoots(text, file);
      const comp = (line && comps.find((c) => line >= c.startLine && line < c.endLine)) || primaryComponent(comps, file);
      if (comp && comp.root) {
        hint = comp.root;
        start = comp.startLine;
        end = Math.max(comp.startLine, comp.endLine - 1);
      }
    }
    if (!hint) {
      const first = visualTargets(text, jsxName(file), 1, { limit: 1 })[0];
      if (first) { hint = first.hint; start = first.line; end = first.line; }
    }
    if (!hint || !hasVisualHint(hint)) continue;
    out.push(makeEvent(file, start, end, 'read', { ...hint, classes: [...(hint.classes || [])] }, { phase: 'post', anchor: 'component' }));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson(pathname, obj, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const timer = setTimeout(() => {
      try { if (req) req.destroy(); } catch {}
      fin({ ok: false, timeout: true });
    }, timeoutMs);
    function fin(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    }
    const body = JSON.stringify(obj);
    req = http.request(
      {
        host: HOST,
        port,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(buf); } catch {}
          fin({ ok: res.statusCode === 200, status: res.statusCode, json: j });
        });
        res.on('error', () => fin({ ok: false }));
      },
    );
    req.on('error', () => fin({ ok: false, conn: true }));
    req.end(body);
  });
}

function spawnDaemon(port) {
  try {
    const child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: __dirname,
      env: { ...process.env, AGENT_CURSORS_PORT: String(port) },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
  }
}

async function deliver(payload, port, timeoutMs) {
  let r = await postJson('/batch', payload, port, timeoutMs);
  if (!r.ok && r.conn) {
    spawnDaemon(port);
    for (let i = 0; i < RESTART_TRIES && !r.ok && r.conn; i++) {
      await sleep(RESTART_WAIT_MS);
      r = await postJson('/batch', payload, port, timeoutMs);
    }
  }
  if (r.status === 404) {
    let ok = false;
    for (const ev of payload.events) ok = (await postJson('/event', { ...ev, group: payload.group, phase: payload.phase }, port, POST_TIMEOUT_MS)).ok || ok;
    return { ok, legacy: true };
  }
  return r;
}

export function groupOf(input) {
  if (typeof input.tool_use_id === 'string' && input.tool_use_id) return input.tool_use_id;
  const fp = crypto.createHash('sha256').update(JSON.stringify([input.tool_name, input.tool_input])).digest('hex').slice(0, 24);
  return `${input.session_id || input.turn_id || 'x'}:${fp}`;
}

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, ms);
    if (process.stdin.isTTY) return done();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function debugHookInput(raw, input, events, parseError = '', actions = []) {
  if (process.env.AGENT_CURSORS_DEBUG !== '1') return;
  const record = {
    at: new Date().toISOString(),
    rawLen: raw.length,
    raw: raw.slice(0, 4000),
    ...(parseError ? { parseError } : {}),
    eventName: input?.hook_event_name,
    tool: input?.tool_name,
    toolUseId: input?.tool_use_id,
    turnId: input?.turn_id,
    events: events?.length ?? 0,
    eventSummary: (events || []).map((event) => ({
      kind: event.kind,
      file: event.file,
      hint: event.hint?.id || event.hint?.classes?.[0] || '',
    })),
    actions: actions?.length ?? 0,
    actionSummary: (actions || []).map((action) => ({
      surface: action.surface,
      action: action.action,
      file: action.file,
    })),
  };
  try {
    fs.appendFileSync(path.join(__dirname, 'debug.log'), JSON.stringify(record) + '\n');
  } catch {
  }
}

function debugDelivery({ port, pre, hold, paintAck, result }) {
  if (process.env.AGENT_CURSORS_DEBUG !== '1') return;
  const record = {
    at: new Date().toISOString(),
    type: 'delivery',
    port,
    pre,
    hold,
    paintAck,
    status: result?.status ?? (result?.legacy ? 404 : undefined),
    ok: result?.ok,
    conn: result?.conn,
    legacy: result?.legacy,
    acked: result?.json?.acked,
    held: result?.json?.held,
    clients: result?.json?.clients,
    waited: result?.json?.waited,
  };
  try {
    fs.appendFileSync(path.join(__dirname, 'debug.log'), JSON.stringify(record) + '\n');
  } catch {
  }
}

async function sendReads(reads, input, port) {
  const group = `${groupOf(input)}:read`;
  stampIdentity(reads, input);
  reads.forEach((event, index) => {
    event.id = crypto.createHash('sha256').update(`${group}:${index}:${event.file}`).digest('hex').slice(0, 32);
  });
  const result = await deliver({ group, phase: 'post', hold: false, events: reads }, port, POST_TIMEOUT_MS);
  debugDelivery({ port, pre: false, hold: false, paintAck: false, result });
}

async function main() {
  const raw = await readStdin(STDIN_TIMEOUT_MS);
  if (!raw.trim()) {
    debugHookInput(raw, null, []);
    return;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    debugHookInput(raw, null, [], 'invalid JSON');
    return;
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const pre = input.hook_event_name === 'PreToolUse';
  const shell = SHELL_TOOLS.has(input.tool_name);
  const port = Number(process.env.AGENT_CURSORS_PORT) || DEFAULT_PORT;
  if (input.tool_name === 'Read') {
    if (pre) return;
    let reads = [];
    try { reads = keepProjectFiles(readEvents(input), [], cwd).domEvents; } catch { reads = []; }
    debugHookInput(raw, input, reads);
    if (reads.length) await sendReads(reads, input, port);
    return;
  }
  let builtActions = buildActions(input);
  let fsEvents = [];
  if (shell && input.hook_event_name === 'PostToolUse') {
    try {
      const r = shellChangeEvents(input);
      fsEvents = r.events;
      builtActions = [...builtActions, ...r.actions];
    } catch { fsEvents = []; }
  }
  let { domEvents, actions } = keepProjectFiles(buildEvents(input), builtActions, cwd);
  domEvents = applyRouteHints(domEvents, cwd);
  try { domEvents = applyFileRoutes(domEvents); } catch {}
  if (fsEvents.length) {
    fsEvents = applyRouteHints(keepProjectFiles(fsEvents, [], cwd).domEvents, cwd);
    try { fsEvents = applyFileRoutes(fsEvents); } catch {}
  }
  if (shell && pre) { try { snapshotShell(input, domEvents.map((event) => event && event.file)); } catch {} }
  if (pre && domEvents.length) { try { noteShown(domEvents.map((event) => event && event.file)); } catch {} }
  let reads = [];
  if (shell && !pre && !domEvents.length && !fsEvents.length) {
    try { reads = keepProjectFiles(readEvents(input), [], cwd).domEvents; } catch { reads = []; }
  }
  debugHookInput(raw, input, [...domEvents, ...fsEvents, ...reads], '', actions);
  if (!domEvents.length && !actions.length && !fsEvents.length && !reads.length) return;
  const group = groupOf(input);
  stampIdentity(domEvents, input);
  stampIdentity(fsEvents, input);
  stampIdentity(actions, input);
  if (reads.length) await sendReads(reads, input, port);

  if (domEvents.length) {
    domEvents.forEach((event, index) => {
      event.id = crypto.createHash('sha256').update(`${group}:${index}:${event.file}`).digest('hex').slice(0, 32);
    });
    const hold = pre && HOLD_MS > 0;
    const paintAck = pre;
    const payload = { group, phase: pre ? 'pre' : 'post', hold, holdMs: HOLD_MS, paintAck, events: domEvents };
    const result = await deliver(payload, port, hold ? HOLD_MS + 500 : POST_TIMEOUT_MS);
    debugDelivery({ port, pre, hold, paintAck, result });
  }

  if (fsEvents.length) {
    const fsGroup = `${group}:fs`;
    fsEvents.forEach((event, index) => {
      event.id = crypto.createHash('sha256').update(`${fsGroup}:${index}:${event.file}`).digest('hex').slice(0, 32);
    });
    const result = await deliver({ group: fsGroup, phase: 'post', hold: false, events: fsEvents }, port, POST_TIMEOUT_MS);
    debugDelivery({ port, pre: false, hold: false, paintAck: false, result });
  }

  if (actions.length) {
    const actGroup = `${group}:act`;
    actions.forEach((event, index) => {
      event.id = crypto.createHash('sha256').update(`${actGroup}:${index}:${event.action}:${event.file}`).digest('hex').slice(0, 32);
    });
    const result = await deliver({ group: actGroup, phase: 'post', hold: false, events: actions }, port, POST_TIMEOUT_MS);
    debugDelivery({ port, pre: false, hold: false, paintAck: false, result });
  }
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const guard = setTimeout(() => process.exit(0), HOLD_MS + 2000);
  guard.unref();
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}

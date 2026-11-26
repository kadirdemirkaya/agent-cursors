(function () {
  'use strict';

  var W = window;
  var D = document;

  if (W.__agentCursors) {
    try {
      if (typeof W.__agentCursors.ensure === 'function') W.__agentCursors.ensure();
    } catch (e) {}
    return;
  }
  if (!D.documentElement || typeof D.documentElement.attachShadow !== 'function') return;

  if (D.getElementById('__agent-cursors-host')) return;

  var api = { version: '2.0.0' };
  W.__agentCursors = api;

  var BASE = 'http://127.0.0.1:7373';
  var autoScroll = true;
  try {
    var cs = D.currentScript;
    if (cs) {
      if (cs.src) BASE = new URL(cs.src).origin;
      if (cs.hasAttribute('data-no-scroll')) autoScroll = false;
    }
  } catch (e) {}

  var CID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  function post(pathname, obj) {
    try {
      W.fetch(BASE + pathname, {
        method: 'POST', mode: 'cors', keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(obj)
      }).catch(function () {});
    } catch (e) {}
  }

  function release(ev) {
    if (ev && ev.gate && !ev.sent) { ev.sent = true; lastAckAt = Date.now(); post('/ack', { id: ev.id, cid: CID }); }
  }

  var MAX_CURSORS = 96;
  var TRAVEL = 900;
  var IDLE = 1500;
  var OUT = 450;
  var EVICT = 300;
  var ACT = { resize: 1900, text: 1700, style: 1500, add: 1900, remove: 1900, edit: 1300, read: 1400 };
  var NOT_APPLIED_MS = 3000;
  var WATCH_MAX = 9000;
  var GRAY_HOLD = 6000;
  var ERROR_MAX = 60000;
  var ARRIVE_HOLD = 1900;
  var APPLIED_QUIET = 2500;
  var READ_IDLE = 2600;
  var RM = false;
  (function () {
    try {
      var mq = W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)');
      if (!mq) return;
      RM = !!mq.matches;
      var on = function (e) { RM = !!e.matches; };
      if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
    } catch (e) {}
  })();
  function travelDur() { return RM ? 280 : TRAVEL; }
  function actDur(kind) { var a = ACT[kind] || ACT.edit; return RM ? Math.round(a * 0.55) : a; }
  var TRAIL = 10;
  var HIST = 28;
  var HOST_ID = '__agent-cursors-host';
  var GENERIC = { div: 1, span: 1, html: 1, body: 1, head: 1, script: 1, style: 1, link: 1, meta: 1, title: 1, br: 1, noscript: 1, template: 1 };
  var SKIP_TEXT = { script: 1, style: 1, noscript: 1, template: 1 };

  function makePal(h, s, l, id) {
    function one(L, a, k, sh, tag) {
      var L2 = Math.max(50, L);
      return {
        id: id + tag, c: 'hsl(' + h + ',' + s + '%,' + L + '%)',
        s: 'hsla(' + h + ',' + s + '%,' + L2 + '%,' + a[0] + ')',
        s2: 'hsla(' + h + ',' + s + '%,' + L2 + '%,' + a[1] + ')',
        s3: 'hsla(' + h + ',' + s + '%,' + L2 + '%,' + a[2] + ')',
        k: k, sh: sh
      };
    }
    var p = one(l, [0.08, 0.20, 0.32], 'rgba(15,23,42,.16)', 'hsla(' + h + ',' + s + '%,62%,.38)', '');
    p.dark = one(Math.max(l, 62), [0.14, 0.26, 0.38], 'rgba(255,255,255,.5)', 'rgba(255,255,255,.42)', 'd');
    p.dark.dark = p.dark;
    return p;
  }
  var PALETTE = [];
  for (var pIdx = 0; pIdx < MAX_CURSORS; pIdx++) PALETTE.push(makePal(Math.round(((pIdx * 137.5) % 360) * 10) / 10, 72, 44, 'p' + pIdx));
  var GRAY_PAL = makePal(215, 12, 56, 'gray');
  var RED_PAL = makePal(0, 78, 50, 'red');
  var sessions = [], sessCount = {}, sessHue = {};
  function sessionHue(session) {
    if (sessHue[session] !== undefined) return sessHue[session];
    sessions.push(session);
    return (sessHue[session] = Math.round((210 + (sessions.length - 1) * 137.5) % 360));
  }
  var CURSOR_COLORS = [
    [215, 85, 50], [0, 80, 52], [42, 95, 44], [270, 68, 56], [145, 65, 38],
    [325, 78, 54], [22, 92, 50], [180, 80, 36], [250, 75, 60], [90, 60, 38]
  ];
  function sessionPal(session) {
    var h0 = sessionHue(session), k = sessCount[session] = (sessCount[session] || 0) + 1;
    var col = CURSOR_COLORS[((sessions.indexOf(session) * 3) + k - 1) % CURSOR_COLORS.length];
    return makePal(col[0], col[1], col[2], 's' + h0 + ':' + k);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function seg(p, a, b) { return clamp01((p - a) / (b - a)); }
  function ease(t) { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 200) : ''; }
  function toInt(v, d) { var n = Math.floor(Number(v)); return isFinite(n) && n >= 1 ? n : d; }
  function norm(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function now() { return W.performance && performance.now ? performance.now() : Date.now(); }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.cv{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;display:none}',
     '.hud{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:7px;width:min(360px,calc(100vw - 32px));pointer-events:none;font:12px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
     '.hud-pill{position:relative;display:flex;align-items:center;gap:8px;min-height:37px;padding:8px 10px;border:1px solid rgba(148,163,184,.34);border-radius:10px;background:rgba(15,23,42,.94);box-shadow:0 8px 24px rgba(0,0,0,.24);color:#e5edf8;backdrop-filter:blur(10px);overflow:hidden}',
     '.hud-pill.hud-enter{animation:hudIn 180ms ease-out both}',
     '.hud-pill.hud-leave{opacity:0;transform:translateY(5px);transition:opacity 180ms ease,transform 180ms ease}',
     '.hud-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--hud-color);box-shadow:0 0 10px var(--hud-color)}',
     '.hud-copy{min-width:0;display:flex;flex:1;align-items:baseline;gap:7px}',
     '.hud-tag{flex:0 0 auto;color:var(--hud-color);font:700 9px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em}',
     '.hud-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8eef8}',
     '.hud-file{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;font:10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
     '.hud-cursor{position:absolute;left:0;top:0;width:6px;height:6px;border-radius:50%;background:#f8fafc;box-shadow:0 0 0 3px rgba(248,250,252,.24),0 0 12px rgba(248,250,252,.9);opacity:0;pointer-events:none;will-change:transform,opacity}',
     '.hud-pill.hud-click{pointer-events:auto;cursor:pointer}',
     '.hud-pill.hud-click:hover{border-color:var(--hud-color);background:rgba(30,41,59,.97)}',
     '.hud-pill.hud-click .hud-file::after{content:" \\21BB";color:var(--hud-color)}',
     '@keyframes hudIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
     '@media (prefers-reduced-motion:reduce){.hud-pill.hud-enter{animation:none}.hud-pill.hud-leave{transition:none}.hud-cursor{transition:none!important}}'
  ].join('');

  var ARROW_D = 'M1.5 1.5 L1.5 18.5 L6 14.6 L9.3 22 L12.2 20.7 L8.9 13.5 L14.8 13.5 Z';
  var IBEAM_D = 'M-4 -9H4M0 -9V9M-4 9H4';
  var LABEL_FONT = '600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

  var host = D.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;' +
    'pointer-events:none;z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'closed' });
  var styleEl = D.createElement('style');
  styleEl.textContent = CSS;
  shadow.appendChild(styleEl);
  var cv = D.createElement('canvas');
  cv.className = 'cv';
  shadow.appendChild(cv);
  var g = null;
  try { g = cv.getContext('2d', { alpha: true, desynchronized: true }) || cv.getContext('2d'); } catch (e) { g = null; }
   var hudRoot = D.createElement('div');
   hudRoot.className = 'hud';
   shadow.appendChild(hudRoot);

  function attach() {
    var old = D.getElementById(HOST_ID);
    if (old && old !== host && old.parentNode) old.parentNode.removeChild(old);
    if (!host.isConnected && D.documentElement) D.documentElement.appendChild(host);
  }
  attach();

  var HUD_FE_FILE = /\.(?:html?|xhtml|[jt]sx|[mc]?js|m?ts|vue|svelte|astro|css|scss|sass|less|styl|svg|php|erb|ejs|hbs|njk|liquid|twig|pug|cshtml|razor)$/i;

  function hudMode(value) {
    if (value === false || value === 0 || value === '0' || value === 'off') return 'off';
    if (value === 'all') return 'all';
    if (value === true || value === 1 || value === '1' || value === 'fe') return 'fe';
    return '';
  }

  function hudModeFromConfig() {
    var match = W.location && /(?:[?&])hud=([a-z01]+)(?:&|$)/.exec(W.location.search || '');
    if (match && hudMode(match[1])) return hudMode(match[1]);
    try {
      var stored = hudMode(W.localStorage.getItem('agentCursorsHud'));
      if (stored) return stored;
    } catch (e) {}
    return 'fe';
  }

  function hudColor(surface) {
    if (surface === 'shell') return '#60a5fa';
    if (surface === 'git') return '#f59e0b';
    if (surface === 'test') return '#34d399';
    if (surface === 'plan') return '#c084fc';
    return '#38bdf8';
  }

  function hudTag(ev) {
    var value = ev && (ev.action || ev.surface) || 'action';
    return String(value).slice(0, 12).toUpperCase();
  }

  function hudText(ev) {
    var value = ev && typeof ev.text === 'string' ? ev.text : '';
    if (!value && ev && ev.file) value = String(ev.file).split(/[\\/]/).pop() || ev.file;
    return value.slice(0, 70) || hudTag(ev);
  }

  function ActivityHUD(root) {
    this.root = root;
    this.mode = hudModeFromConfig();
    this.enabled = this.mode !== 'off';
    this.recentIds = [];
    this.entries = [];
    this.lastPoint = null;
    this.cursorTimer = 0;
    this.cursor = D.createElement('div');
    this.cursor.className = 'hud-cursor';
    root.appendChild(this.cursor);
    this.applyEnabled();
  }

  ActivityHUD.prototype.applyEnabled = function () {
    this.root.style.display = this.enabled ? 'flex' : 'none';
  };

  ActivityHUD.prototype.accepts = function (ev) {
    if (this.mode === 'all') return true;
    if (this.mode !== 'fe' || !ev || ev.surface !== 'file') return false;
    if (ev.meta && ev.meta.outside) return false;
    return HUD_FE_FILE.test(String(ev.file || ''));
  };

  ActivityHUD.prototype.setEnabled = function (value) {
    this.mode = hudMode(value) || 'fe';
    this.enabled = this.mode !== 'off';
    this.applyEnabled();
    try { W.localStorage.setItem('agentCursorsHud', this.mode); } catch (e) {}
    for (var i = this.entries.length - 1; i >= 0; i--) {
      if (!this.accepts(this.entries[i].ev)) this.remove(this.entries[i], false);
    }
    if (this.enabled && !D.hidden) this.renderPending();
  };

  ActivityHUD.prototype.isDup = function (id) {
    if (!id) return false;
    if (this.recentIds.indexOf(id) !== -1) return true;
    this.recentIds.push(id);
    if (this.recentIds.length > 200) this.recentIds.shift();
    return false;
  };

  ActivityHUD.prototype.remove = function (entry, animate) {
    var idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.node) return;
    var node = entry.node;
    entry.node = null;
    if (!animate) { if (node.parentNode) node.parentNode.removeChild(node); return; }
    node.classList.add('hud-leave');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 190);
  };

  ActivityHUD.prototype.fly = function (node) {
    if (D.hidden || W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var x = node.offsetLeft + 7;
    var y = node.offsetTop + node.offsetHeight / 2;
    var from = this.lastPoint || { x: x - 18, y: y + 9 };
    this.lastPoint = { x: x, y: y };
    clearTimeout(this.cursorTimer);
    this.cursor.style.transition = 'none';
    this.cursor.style.transform = 'translate3d(' + from.x + 'px,' + from.y + 'px,0)';
    this.cursor.style.opacity = '1';
    var cursor = this.cursor;
    W.requestAnimationFrame(function () {
      cursor.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1),opacity 160ms ease';
      cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    });
    this.cursorTimer = setTimeout(function () { cursor.style.opacity = '0'; }, 300);
  };

  ActivityHUD.prototype.render = function (entry, animate) {
    if (!entry || entry.node || !this.enabled || D.hidden) return false;
    var ev = entry.ev || {};
    var pill = D.createElement('div');
    pill.className = 'hud-pill' + (animate && !(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches) ? ' hud-enter' : '');
    pill.style.setProperty('--hud-color', hudColor(ev.surface));
    var dot = D.createElement('span');
    dot.className = 'hud-dot';
    var copy = D.createElement('div');
    copy.className = 'hud-copy';
    var tag = D.createElement('span');
    tag.className = 'hud-tag';
    tag.textContent = hudTag(ev);
    var text = D.createElement('span');
    text.className = 'hud-text';
    text.textContent = hudText(ev);
    copy.appendChild(tag);
    copy.appendChild(text);
    pill.appendChild(dot);
    pill.appendChild(copy);
    if (ev.file) {
      var file = D.createElement('span');
      file.className = 'hud-file';
      file.textContent = String(ev.file).split(/[\\/]/).pop() || ev.file;
      pill.appendChild(file);
    }
    this.root.insertBefore(pill, this.root.firstChild);
    entry.node = pill;
    if (animate) this.fly(pill);
    var self = this;
    if (ev.surface === 'file' && ev.file && replayable(ev.file)) {
      pill.className += ' hud-click';
      pill.title = 'Tekrar oynat';
      pill.addEventListener('click', function (e) { e.stopPropagation(); replayFile(ev.file); });
      pill.addEventListener('mouseenter', function () { clearTimeout(entry.timer); entry.timer = 0; });
      pill.addEventListener('mouseleave', function () {
        if (!entry.timer && entry.node) entry.timer = setTimeout(function () { self.remove(entry, true); }, 2500);
      });
    }
    entry.timer = setTimeout(function () { self.remove(entry, true); }, 6000);
    return true;
  };

  ActivityHUD.prototype.note = function (text, color) {
    if (!this.enabled || D.hidden) return;
    var pill = D.createElement('div');
    pill.className = 'hud-pill' + (W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches ? '' : ' hud-enter');
    pill.style.setProperty('--hud-color', color || '#38bdf8');
    var dot = D.createElement('span');
    dot.className = 'hud-dot';
    var copy = D.createElement('div');
    copy.className = 'hud-copy';
    var txt = D.createElement('span');
    txt.className = 'hud-text';
    txt.textContent = String(text).slice(0, 80);
    copy.appendChild(txt);
    pill.appendChild(dot);
    pill.appendChild(copy);
    this.root.insertBefore(pill, this.root.firstChild);
    setTimeout(function () {
      pill.classList.add('hud-leave');
      setTimeout(function () { if (pill.parentNode) pill.parentNode.removeChild(pill); }, 190);
    }, 2200);
  };

  ActivityHUD.prototype.renderPending = function () {
    if (!this.enabled || D.hidden) return;
    for (var i = this.entries.length - 1; i >= 0; i--) this.render(this.entries[i], false);
  };

  ActivityHUD.prototype.push = function (ev) {
    if (!this.accepts(ev)) return false;
    if (this.isDup(ev && ev.id)) return false;
    var entry = { ev: ev || {}, node: null, timer: 0 };
    this.entries.unshift(entry);
    while (this.entries.length > 8) this.remove(this.entries[this.entries.length - 1], false);
    this.render(entry, true);
    return true;
  };

  ActivityHUD.prototype.destroy = function () {
    clearTimeout(this.cursorTimer);
    while (this.entries.length) this.remove(this.entries[0], false);
  };

  var hud = new ActivityHUD(hudRoot);
  try {
    Object.defineProperty(W, '__agentCursorsHud', {
      configurable: true,
      get: function () { return hud.enabled; },
      set: function (value) { hud.setEnabled(value); }
    });
  } catch (e) { W.__agentCursorsHud = hud.enabled; }

  var FIXED = { handle: [9, 9], ring: [120, 120], badge: [28, 28], xmark: [34, 34], caret: [2, 18], dot: [8, 8], check: [22, 22], warn: [24, 22] };
  function vnode(cls) {
    var f = FIXED[cls];
    return { cls: cls, x: 0, y: 0, sx: 1, sy: 1, o: 0, w: f ? f[0] : 1, h: f ? f[1] : 1, mid: !!f };
  }
  function tf(e, x, y, sx, sy, o) { e.x = x; e.y = y; e.sx = sx; e.sy = sy; e.o = clamp01(o); }
  function hide(e) { e.o = 0; }
  function size(e, w, h) { e.w = Math.max(1, w || 1); e.h = Math.max(1, h || 1); }
  function tfc(c, e, x, y, sx, sy, o) { tf(e, x, y, sx, sy, o * c.ga); }

  var MODES = { group: { max: 64, idle: 1500 }, file: { max: 64, idle: 2600 }, change: { max: 64, idle: 5000 } };
  var mode = 'change';
  var maxCursors = MODES.change.max;
  var cursors = [];
  var byKey = {};

  function sessKey(ev) { return ev.session || ev.agent || '_'; }
  function keyOf(ev) {
    if (ev.kind === 'read') return 'r:' + sessKey(ev);
    if (ev.gate) return 'g:' + (ev.id || (++slotCounter));
    if (mode === 'change') return 'e:' + (ev.id || (++slotCounter));
    if (mode === 'group') {
      var h = ev.hint || {};
      var tok = h.id || (h.classes && h.classes[0]) || '';
      if (tok) return 'k:' + tok;
    }
    return 'f:' + ev.file;
  }

  function applyMode(m) {
    if (!MODES[m] || m === mode) return;
    mode = m;
    maxCursors = MODES[m].max;
    IDLE = MODES[m].idle;
    byKey = {};
  }
  var slotCounter = 0;
  var raf = 0;
  var allDirty = false;

  function baseName(f) { return String(f).split(/[\\/]/).pop() || String(f); }
  var KIND_WORD = { text: 'metin', resize: 'boyut', add: 'ekleme', remove: 'silme', edit: 'düzenleme', read: 'okuyor', style: 'stil' };
  function labelOf(ev, word) {
    var d = ev.delta || {}, kind = ev.kind, main;
    if (kind === 'add' && d.el) main = '+ ' + d.el;
    else if (kind === 'remove' && d.el) main = '− ' + d.el;
    else main = baseName(ev.file) + ' · ' + (word || (kind === 'edit' && ev.anchor === 'component' ? 'mantık' : KIND_WORD[kind] || 'düzenleme'));
    if (hud.mode === 'all') main += '  :' + ev.startLine + (ev.endLine > ev.startLine ? '-' + ev.endLine : '');
    return main;
  }
  function agentTagOf(ev) { return ev.agent === 'codex' ? 'Codex' : ev.agent === 'claude' ? 'Claude' : ''; }

  function pickSlot() {
    var used = {};
    for (var i = 0; i < cursors.length; i++) if (!cursors[i].evict) used[cursors[i].slot] = 1;
    var start = slotCounter++ % MAX_CURSORS;
    for (var k = 0; k < MAX_CURSORS; k++) {
      var s = (start + k) % MAX_CURSORS;
      if (!used[s]) return s;
    }
    return start;
  }

  function spawnPoint(slot) {
    var vw = W.innerWidth, vh = W.innerHeight;
    var a = (slot * 137.5 + 20) * Math.PI / 180;
    return {
      x: clamp(vw / 2 + Math.cos(a) * vw * 0.7, -20, vw + 20),
      y: clamp(vh / 2 + Math.sin(a) * vh * 0.7, -20, vh + 20)
    };
  }

  function createCursor(ev, t, key) {
    var i, guard = 0;
    while (guard++ < MAX_CURSORS) {
      var live = 0, oldest = null;
      for (i = 0; i < cursors.length; i++) {
        if (cursors[i].evict) continue;
        live++;
        if (!oldest || cursors[i].born < oldest.born) oldest = cursors[i];
      }
      if (live < maxCursors || !oldest) break;
      oldest.evict = t;
      if (byKey[oldest.key] === oldest) delete byKey[oldest.key];
    }

    var slot = pickSlot();
    var pal = ev.session ? sessionPal(ev.session) : PALETTE[slot];
    var sk = sessKey(ev);
    var sp = spawnPoint(slot);
    var rc = byKey['r:' + sk];
    if (ev.kind !== 'read' && rc && !rc.dead && !rc.evict) {
      sp = { x: rc.x, y: rc.y };
      rc.evict = t;
      delete byKey[rc.key];
    } else {
      var lp = lastPos[sk];
      if (lp && t - lp.t < 20000) sp = { x: lp.x + ((slot * 37) % 17) - 8, y: lp.y + ((slot * 53) % 17) - 8 };
    }
    var c = {
      key: key, slot: slot, born: t, pal: pal, dpal: pal, sess: sk, dark: false,
      x: sp.x, y: sp.y, ga: 1, gaBase: 1, fresh: true, evict: 0, dead: false, off: '', offA: 0,
      parts: {}, hist: [], dots: [], trailA: 0, job: null, queue: [], shape: 'a', labelText: '', baseLabel: '', agentTag: '', flip: '0',
      root: vnode('cur'), spr: null
    };
    for (i = 0; i < TRAIL; i++) c.dots.push(vnode('dot'));
    cursors.push(c);
    byKey[key] = c;
    return c;
  }
  var lastPos = {};

  function removeCursor(idx) {
    var c = cursors[idx];
    if (c.job) { release(c.job.ev); endBuild(c.job); }
    while (c.queue.length) release(c.queue.shift());
    cursors.splice(idx, 1);
    if (byKey[c.key] === c) delete byKey[c.key];
    if (c.spr) { c.spr.cv.width = 0; c.spr = null; }
    if (c.job && c.job.bub) { c.job.bub.cv.width = 0; c.job.bub = null; }
  }

  function part(c, name, cls) {
    var e = c.parts[name];
    if (e) return e;
    e = vnode(cls);
    c.parts[name] = e;
    return e;
  }

  function hideAll(c) { for (var k in c.parts) hide(c.parts[k]); }

  function setShape(c, s) {
    c.shape = s;
  }

  function matchSet(h) {
    var set = new Set(), i, k, list;
    if (!h) return set;
    if (h.id) { var e = D.getElementById(h.id); if (e) set.add(e); }
    for (i = 0; i < (h.classes || []).length; i++) {
      if (!h.classes[i] || /\s/.test(h.classes[i])) continue;
      list = D.getElementsByClassName(h.classes[i]);
      for (k = 0; k < Math.min(list.length, 500); k++) set.add(list[k]);
    }
    return set;
  }

  var domVer = 0, domObs = null, domRoot = null;
  var candMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
  var normMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
  function domVersion() {
    if (!candMemo) return -1;
    var root = D.documentElement;
    if (!root) return -1;
    if (!domObs) {
      if (typeof W.MutationObserver !== 'function') return -1;
      try { domObs = new W.MutationObserver(function () { domVer++; }); } catch (e) { domObs = null; return -1; }
    }
    if (domRoot !== root) {
      try {
        domObs.disconnect();
        domObs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id', 'class'] });
      } catch (e) { domRoot = null; return -1; }
      domRoot = root;
      domVer++;
    }
    if (domObs.takeRecords().length) domVer++;
    return domVer;
  }
  function normText(nd, v) {
    if (!normMemo) return norm(v);
    var m = normMemo.get(nd);
    if (m && m.v === v) return m.n;
    var n = norm(v);
    normMemo.set(nd, { v: v, n: n });
    return n;
  }

  function collectCands(h, exclude) {
    var ver = typeof h === 'object' ? domVersion() : -1, ex = exclude || null;
    var memo = ver >= 0 ? candMemo.get(h) : null;
    if (memo && memo.ver === ver && memo.ex === ex) return memo;
    var cands = new Map();

    function add(el, score, extra) {
      if (!el || el === host || el.nodeType !== 1) return;
      if (exclude && exclude.has(el)) return;
      var c = cands.get(el);
      if (!c) { c = { el: el, score: 0 }; cands.set(el, c); }
      c.score += score;
      if (extra && !c.node) { c.node = extra.node; c.s = extra.s; c.e = extra.e; }
    }

    var i, k, list, n;
    if (h.id) add(D.getElementById(h.id), 1000);

    var cls = [];
    for (i = 0; i < (h.classes || []).length; i++) {
      if (typeof h.classes[i] === 'string' && h.classes[i] && !/\s/.test(h.classes[i])) cls.push(h.classes[i]);
    }
    if (cls.length) {
      var per = 400 / cls.length;
      for (i = 0; i < cls.length; i++) {
        list = D.getElementsByClassName(cls[i]);
        n = Math.min(list.length, 300);
        for (k = 0; k < n; k++) add(list[k], per);
      }
    }

    if (h.ipath && D.body) {
      var ipEl = D.body;
      for (i = 0; i < h.ipath.length && ipEl; i++) ipEl = ipEl.children[h.ipath[i]] || null;
      if (ipEl && ipEl !== host && (!h.tag || ipEl.localName === h.tag)) {
        var ipOk = !cls.length;
        for (i = 0; i < cls.length && !ipOk; i++) if (ipEl.classList.contains(cls[i])) ipOk = true;
        if (ipOk) { add(ipEl, 700); cands.get(ipEl).ip = true; }
      }
    }

    if (h.selector) {
      try {
        list = D.querySelectorAll(h.selector);
        n = Math.min(list.length, 60);
        for (k = 0; k < n; k++) add(list[k], 450);
      } catch (e) {}
    }

    if (h.text && h.text.length >= 2) {
      var needle = norm(h.text);
      var root = D.body || D.documentElement;
      var tw = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var nd, seen = 0, hits = 0;
      while ((nd = tw.nextNode()) && seen < 30000 && hits < 25) {
        seen++;
        var v = nd.nodeValue;
        if (!v || v.length < 2) continue;
        var pe = nd.parentElement;
        if (!pe || pe === host || SKIP_TEXT[pe.localName]) continue;
        var nv = normText(nd, v);
        if (nv.indexOf(needle) !== -1) {
          hits++;
          add(pe, 200 + (nv.length - needle.length < 12 ? 20 : 0), { node: nd, s: 0, e: v.length });
        }
      }
    }

    var tag = (h.tag || '').toLowerCase();
    if (tag && /^[a-z][a-z0-9-]*$/.test(tag)) {
      cands.forEach(function (c) { if (c.el.localName === tag) c.score += 50; });
      if (!cands.size && !GENERIC[tag]) {
        list = D.getElementsByTagName(tag);
        n = Math.min(list.length, 100);
        for (k = 0; k < n; k++) add(list[k], 50);
      }
    }
    var out = { ver: ver, ex: ex, cls: cls, list: [] };
    cands.forEach(function (c) { out.list.push(c); });
    if (ver >= 0) candMemo.set(h, out);
    return out;
  }

  function resolveTarget(h, exclude) {
    if (!h) return null;
    var vw = W.innerWidth, vh = W.innerHeight;
    var col = collectCands(h, exclude), cls = col.cls;
    if (!col.list.length) return null;

    var ranked = [];
    col.list.forEach(function (c) {
      var r = c.el.getBoundingClientRect();
      var s = c.score;
      if (r.width <= 0 && r.height <= 0) s *= 0.05;
      else if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) s += 8;
      ranked.push({ el: c.el, score: s, node: c.node, s: c.s, e: c.e, ip: !!c.ip });
    });
    var byScore = function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & 2 ? 1 : -1);
    };
    ranked.sort(byScore);
    if (!ranked.length || ranked[0].score < 40) return null;
    if (h.path && h.path.length && !h.repeat && ranked.length > 1 &&
        (ranked[0].score === ranked[1].score || !isStrongMatch(h, ranked[0]))) {
      for (var pi = 0; pi < ranked.length && pi < 20; pi++) ranked[pi].score += pathScore(ranked[pi].el, h.path);
      ranked.sort(byScore);
    }
    if (h.owner && !h.repeat && ranked.length > 1 &&
        (ranked[0].score === ranked[1].score || !isStrongMatch(h, ranked[0]))) {
      var top = ranked.slice(0, 20), owners = ownersOf(top.map(function (c) { return c.el; })), bonus = false;
      for (var oi = 0; oi < top.length; oi++) { var ob = ownerBonus(owners[oi], h.owner); if (ob) { top[oi].score += ob; bonus = true; } }
      if (bonus) ranked.sort(byScore);
    }

    var topScore = ranked[0].score;
    var tied = ranked.filter(function (c) { return c.score === topScore; });
    if (h.repeat) {
      var classesForRepeat = cls.slice();
      var repeated = classesForRepeat.length
        ? ranked.filter(function (c) { return classesForRepeat.every(function (name) { return c.el.classList && c.el.classList.contains(name); }); })
        : tied;
      if (repeated.length) {
        repeated.sort(function (a, b) { return a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & 2 ? 1 : -1); });
        var head = repeated[0];
        head.all = repeated.slice(0, maxCursors);
        return head;
      }
    }
    var nth = Math.floor(Number(h.nth));
    if (isFinite(nth) && nth >= 0 && tied[nth]) return tied[nth];
    return ranked[0];
  }

  function hasHint(h) {
    return !!(h && (h.id || h.tag || h.text || h.selector || h.ipath || (h.classes && h.classes.length)));
  }

  /* owner-read:start */
  function ownerRead(el) {
    var names = [], file = '', i, k, f, d;
    var base = function (p) { return typeof p === 'string' ? (p.split(/[\\/]/).pop() || '').split('?')[0] : ''; };
    var addName = function (n) { if (typeof n === 'string' && /^[A-Za-z_$][\w$]{0,60}$/.test(n) && names.indexOf(n) < 0 && names.length < 3) names.push(n); };
    try {
      var key = '';
      for (k in el) { if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) { key = k; break; } }
      if (key) {
        for (f = el[key], d = 0; f && d < 80 && names.length < 3; f = f['return'], d++) {
          if (!file && f._debugSource && f._debugSource.fileName) file = base(f._debugSource.fileName);
          var t = f.type;
          if (!t || typeof t === 'string') continue;
          var fn = typeof t === 'function' ? t : t.render || (t.type && (typeof t.type === 'function' ? t.type : t.type.render)) || null;
          addName(t.displayName || (fn && (fn.displayName || fn.name)) || '');
        }
      }
      if (!names.length && el.__vueParentComponent) {
        for (var ins = el.__vueParentComponent, n3 = 0; ins && n3 < 6 && names.length < 3; ins = ins.parent, n3++) {
          var ty = ins.type || {};
          if (!file && ty.__file) file = base(ty.__file);
          addName(ty.name || ty.__name || (ty.__file ? base(ty.__file).replace(/\.\w+$/, '') : ''));
        }
      }
      if (!names.length) {
        for (var nd = el, n2 = 0; nd && n2 < 30; nd = nd.parentElement, n2++) {
          if (!nd.__vue__) continue;
          var op = nd.__vue__.$options || {};
          if (op.__file) file = base(op.__file);
          addName(op.name || (op.__file ? base(op.__file).replace(/\.\w+$/, '') : ''));
          break;
        }
      }
      if (!file) {
        for (var sv = el, n4 = 0; sv && n4 < 4 && !file; sv = sv.parentElement, n4++) {
          var meta = sv.__svelte_meta;
          if (meta && meta.loc && meta.loc.file) { file = base(meta.loc.file); addName(file.replace(/\.\w+$/, '')); }
        }
      }
      if (!names.length && window.ng && typeof window.ng.getOwningComponent === 'function') {
        var cmp = window.ng.getOwningComponent(el);
        if (cmp && cmp.constructor) addName(cmp.constructor.name);
      }
    } catch (e) {}
    if (!names.length && !file) return null;
    for (i = 0; i < names.length; i++) names[i] = String(names[i]);
    return { names: names, file: file.length <= 80 ? file : '' };
  }
  /* owner-read:end */
  function cleanOwner(o) {
    if (!o || typeof o !== 'object') return null;
    var names = [];
    if (Array.isArray(o.names)) for (var i = 0; i < o.names.length && names.length < 4; i++) if (typeof o.names[i] === 'string' && /^[A-Za-z_$][\w$]{0,60}$/.test(o.names[i])) names.push(o.names[i]);
    var file = typeof o.file === 'string' && /^[^\\/\u0000-\u001f\u007f<>"'`]{1,80}$/.test(o.file) ? o.file : '';
    return names.length || file ? { names: names, file: file } : null;
  }
  function ownersOf(els) {
    var out = [], i, any = false, res = null;
    for (i = 0; i < els.length; i++) { out.push(ownerRead(els[i])); if (out[i]) any = true; }
    if (any || typeof W.CustomEvent !== 'function') return out;
    var q = [];
    for (i = 0; i < els.length; i++) { try { els[i].setAttribute('data-ac-q', String(i)); q.push(i); } catch (e) {} }
    var onRes = function (e) { try { res = JSON.parse(typeof e.detail === 'string' ? e.detail : ''); } catch (x) { res = null; } };
    D.addEventListener('ac:owner:res', onRes);
    try { D.dispatchEvent(new W.CustomEvent('ac:owner', { detail: JSON.stringify({ q: q }) })); } catch (e) {}
    D.removeEventListener('ac:owner:res', onRes);
    for (i = 0; i < els.length; i++) { try { els[i].removeAttribute('data-ac-q'); } catch (e) {} }
    if (res && res.r && typeof res.r === 'object') for (i = 0; i < els.length; i++) out[i] = cleanOwner(res.r[i]);
    return out;
  }
  function ownerBonus(o, want) {
    if (!o || !want) return 0;
    var s = 0, i;
    for (i = 0; i < (want.names || []).length; i++) if (o.names.indexOf(want.names[i]) >= 0) { s += 250; break; }
    if (want.file && o.file && o.file.toLowerCase() === want.file.toLowerCase()) s += 350;
    return s;
  }

  function pathItemMatches(el, it) {
    if (it.tag && el.localName !== it.tag) return false;
    if (it.id && el.id !== it.id) return false;
    var cls = it.classes || [];
    for (var i = 0; i < cls.length; i++) if (!el.classList || !el.classList.contains(cls[i])) return false;
    return true;
  }
  function pathScore(el, path) {
    if (!el || !path || !path.length) return 0;
    var k = path.length - 1, s = 0, n = 0;
    for (var x = el.parentElement, d = 0; x && d < 8 && k >= 0; x = x.parentElement, d++) {
      if (pathItemMatches(x, path[k])) { s += path[k].id ? 150 : 60; n++; k--; }
    }
    return s + (n === path.length ? 100 : 0);
  }

  function hintRect(ev, vw, vh) {
    var hs = hashStr(ev.file + ':' + ev.startLine);
    var fx = (hs & 1023) / 1023, fy = ((hs >>> 10) & 1023) / 1023;
    var w = Math.max(120, Math.min(300, vw * 0.5));
    var hh = Math.max(70, Math.min(120, vh * 0.28));
    return {
      l: vw * 0.1 + fx * Math.max(0, vw * 0.8 - w),
      t: vh * 0.16 + fy * Math.max(0, vh * 0.6 - hh),
      w: w, h: hh
    };
  }

  function fakeLines(R) {
    var lh = Math.min(18, Math.max(10, R.h * 0.2));
    var top = R.t + R.h * 0.28;
    return [
      { l: R.l + 12, t: top, w: Math.max(20, R.w - 24), h: lh },
      { l: R.l + 12, t: top + lh + 6, w: Math.max(20, (R.w - 24) * 0.55), h: lh }
    ];
  }

  function readLines(t, R) {
    var out = [];
    try {
      var rg = D.createRange();
      var ok = true;
      if (t.node && t.node.isConnected) { rg.setStart(t.node, 0); rg.setEnd(t.node, t.node.nodeValue.length); }
      else if (t.el && t.el.isConnected) rg.selectNodeContents(t.el);
      else ok = false;
      if (ok && typeof rg.getClientRects === 'function') {
        var rs = rg.getClientRects(), rows = {}, i;
        for (i = 0; i < rs.length; i++) {
          var r = rs[i];
          if (r.width < 2 || r.height < 2) continue;
          var key = Math.round(r.top / 4), row = rows[key];
          if (!row) rows[key] = { l: r.left, t: r.top, r: r.right, b: r.bottom };
          else {
            row.l = Math.min(row.l, r.left); row.r = Math.max(row.r, r.right);
            row.t = Math.min(row.t, r.top); row.b = Math.max(row.b, r.bottom);
          }
        }
        var keys = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
        for (i = 0; i < keys.length && out.length < 6; i++) {
          var w = rows[keys[i]];
          out.push({ l: w.l, t: w.t, w: w.r - w.l, h: w.b - w.t });
        }
      }
    } catch (e) { out = []; }
    if (!out.length) {
      if (t.mode === 'el') out.push({ l: R.l, t: R.t, w: R.w, h: Math.min(R.h, 24) });
      else out = fakeLines(R);
    }
    return out;
  }

  function readTarget(c, j, t0, snap) {
    var t = j.target, vw = W.innerWidth, vh = W.innerHeight;
    var canRetry = t.mode === 'hint' && hasHint(j.ev.hint) && t0 >= j.retryAt && t0 - j.t0 < 3200;
    if (j.needResolve || canRetry) {
      j.needResolve = false;
      j.retryAt = t0 + 350;
      var found = resolveTarget(j.ev.hint);
      if (found) {
        t.mode = 'el'; t.el = found.el; t.node = found.node || null; t.s = found.s || 0; t.e = found.e || 0;
      }
    }
    if (j.ev.next && j.kind === 'add' && !j.nextDone && t0 >= j.nextAt) {
      j.nextAt = t0 + 120;
      var nf = resolveTarget(j.ev.next, j.exclude);
      if (nf && nf.el !== t.el) {
        t.mode = 'el'; t.el = nf.el; t.node = nf.node || null; t.s = 0; t.e = 0;
        j.nextDone = true; j.scrolled = false;
      }
    }
    var r = null;
    if (t.el && t.el.isConnected) {
      var b = t.el.getBoundingClientRect();
      if (b.width > 0 || b.height > 0) r = { l: b.left, t: b.top, w: Math.max(b.width, 1), h: Math.max(b.height, 1) };
    }
    if (r) {
      t.goal = r;
      if (!t.rect || snap || RM) t.rect = { l: r.l, t: r.t, w: r.w, h: r.h };
      if (t.el !== t.bgEl) {
        t.bgEl = t.el;
        var bg = bgOf(t.el);
        c.dark = !!bg && !bg.img && lum(bg) < 0.4;
      }
    } else if (!t.rect) t.rect = hintRect(j.ev, vw, vh);

    if (autoScroll && t.mode === 'el' && !j.scrolled && r) {
      j.scrolled = true;
      if (r.t + r.h < 0 || r.t > vh || r.l + r.w < 0 || r.l > vw) {
        try { t.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) {}
      }
    }
    if (j.kind === 'text') t.lines = readLines(t, t.rect);
    if (j.build && !j.build.done) {
      for (var bi = 0; bi < j.build.pieces.length; bi++) {
        var bpc = j.build.pieces[bi];
        if (!bpc.el.isConnected) continue;
        var bb = bpc.el.getBoundingClientRect();
        if (bb.width >= 1 || bb.height >= 1) bpc.r = { l: bb.left, t: bb.top, w: Math.max(bb.width, 1), h: Math.max(bb.height, 1) };
      }
    }
    if (j.kind === 'style' && t.el && t.el.isConnected && r) {
      if (!j.sty && j.ev.delta) {
        j.sty = styleInfo(j, t.el);
        if (j.sty.word) { c.baseLabel = labelOf(j.ev, j.sty.word); if (!j.watch || j.watch.state === 'wait') c.labelText = c.baseLabel; }
      }
      if (j.sty && (j.sty.space || j.sty.radius)) readGuides(j, t.el, r);
    }
  }

  var colorCv = null, colorCache = {}, colorCacheN = 0;
  function rgbaOf(css) {
    if (!css || typeof css !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(colorCache, css)) return colorCache[css];
    var out = null;
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css.trim());
    if (m) out = { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : +m[4] };
    else {
      try {
        if (!colorCv) { colorCv = D.createElement('canvas'); colorCv.width = 1; colorCv.height = 1; }
        var x = colorCv.getContext('2d', { willReadFrequently: true });
        x.fillStyle = '#010203';
        x.fillStyle = css;
        if (String(x.fillStyle) !== '#010203' || /^#010203$/i.test(css)) {
          x.clearRect(0, 0, 1, 1); x.fillRect(0, 0, 1, 1);
          var p = x.getImageData(0, 0, 1, 1).data;
          out = { r: p[0], g: p[1], b: p[2], a: p[3] / 255 };
        }
      } catch (e) { out = null; }
    }
    if (++colorCacheN > 400) { colorCache = {}; colorCacheN = 0; }
    colorCache[css] = out;
    return out;
  }
  function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
  function bgOf(el) {
    try {
      for (var n = el, d = 0; n && n.nodeType === 1 && d < 25; n = n.parentElement, d++) {
        var cs = W.getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return { img: true, r: 128, g: 128, b: 128 };
        var c = rgbaOf(cs.backgroundColor);
        if (c && c.a > 0.95) return { r: c.r, g: c.g, b: c.b, css: cs.backgroundColor };
      }
      var dark = W.matchMedia && W.matchMedia('(prefers-color-scheme: dark)').matches &&
        /dark/.test(W.getComputedStyle(D.documentElement).colorScheme || '');
      return dark ? { r: 18, g: 18, b: 18, css: 'rgb(18, 18, 18)' } : { r: 255, g: 255, b: 255, css: 'rgb(255, 255, 255)' };
    } catch (e) { return null; }
  }
  function pxOf(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  var COLOR_FAM = {
    bg: 'background-color', text: 'color', border: 'border-top-color', 'border-t': 'border-top-color',
    'border-r': 'border-right-color', 'border-b': 'border-bottom-color', 'border-l': 'border-left-color',
    'border-x': 'border-left-color', 'border-y': 'border-top-color', outline: 'outline-color', fill: 'fill',
    stroke: 'stroke', decoration: 'text-decoration-color', accent: 'accent-color', caret: 'caret-color', ring: '--tw-ring-color'
  };
  var NOT_COLOR_RE = /^(?:\d.*|\[\d.*|\[length:.*|px|none|solid|dashed|dotted|double|hidden|collapse|separate|cover|contain|fixed|local|scroll|center|no-repeat|repeat.*|clip.*|origin.*|auto|top|bottom|left|right|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|xs|sm|base|lg|xl|\dxl|inset|offset.*|opacity.*|spacing.*|x|y|t|b|l|r|s|e|blend.*|gradient.*|linear.*|radial.*|conic.*|underline|overline|line-through|thin|thick|wavy|from-font|clip)$/;
  var CSS_COLOR_PROP = { color: 'color', background: 'background-color', 'background-color': 'background-color', border: 'border-top-color', 'border-color': 'border-top-color', 'border-top': 'border-top-color', 'border-top-color': 'border-top-color', 'border-bottom': 'border-bottom-color', 'border-bottom-color': 'border-bottom-color', 'border-left': 'border-left-color', 'border-left-color': 'border-left-color', 'border-right': 'border-right-color', 'border-right-color': 'border-right-color', outline: 'outline-color', 'outline-color': 'outline-color', fill: 'fill', stroke: 'stroke', 'text-decoration-color': 'text-decoration-color', 'accent-color': 'accent-color', 'caret-color': 'caret-color' };
  var SIDE_OF = { '': [1, 1, 1, 1], x: [0, 1, 0, 1], y: [1, 0, 1, 0], t: [1, 0, 0, 0], r: [0, 1, 0, 0], b: [0, 0, 1, 0], l: [0, 0, 0, 1], s: [0, 0, 0, 1], e: [0, 1, 0, 0] };
  function parseTok(tok) {
    var m = /^([a-z-]+):\s(.+)$/.exec(tok);
    if (m) {
      var prop = m[1], sp = /^(padding|margin)(?:-(top|right|bottom|left|inline|block))?$/.exec(prop);
      var out = { raw: tok, css: true, prop: prop, value: m[2], variant: '', fam: prop };
      if (CSS_COLOR_PROP[prop]) out.color = CSS_COLOR_PROP[prop];
      if (sp) {
        out.space = sp[1] === 'padding' ? 'p' : 'm';
        out.sides = SIDE_OF[{ top: 't', right: 'r', bottom: 'b', left: 'l', inline: 'x', block: 'y' }[sp[2]] || ''];
      } else if (/^(?:row-|column-)?gap$/.test(prop)) { out.space = 'gap'; out.sides = SIDE_OF['']; }
      if (/radius$/.test(prop)) out.radius = true;
      return out;
    }
    var parts = tok.replace(/^!/, '').split(':'), base = parts.pop(), variant = parts.join(':');
    if (base.charAt(0) === '-') base = base.slice(1);
    var o = { raw: tok, variant: variant, fam: base, value: '' };
    var s = /^(p|m)([xytrblse]?)-(.+)$/.exec(base);
    if (s) { o.fam = s[1] + s[2]; o.value = s[3]; o.space = s[1]; o.sides = SIDE_OF[s[2]]; return o; }
    s = /^(gap(?:-[xy])?|space-[xy])-(.+)$/.exec(base);
    if (s) { o.fam = s[1]; o.value = s[2]; o.space = 'gap'; o.sides = SIDE_OF['']; return o; }
    s = /^rounded(?:-(t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?(?:-(.+))?$/.exec(base);
    if (s) { o.fam = 'rounded' + (s[1] ? '-' + s[1] : ''); o.value = s[2] || ''; o.radius = true; return o; }
    s = /^(bg|text|border(?:-[trblxy])?|outline|fill|stroke|decoration|accent|caret|ring)-(.+)$/.exec(base);
    if (s) { o.fam = s[1]; o.value = s[2]; if (!NOT_COLOR_RE.test(s[2])) o.color = COLOR_FAM[s[1]]; }
    return o;
  }
  function probeColors(list) {
    var out = [], body = D.body;
    if (!body || !list.length) return out;
    try {
      var p = D.createElement('span');
      p.setAttribute('aria-hidden', 'true');
      body.appendChild(p);
      for (var i = 0; i < list.length; i++) {
        var tk = list[i];
        p.removeAttribute('class');
        p.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;border-style:solid;outline-style:solid';
        var base = W.getComputedStyle(p).getPropertyValue(tk.color).trim();
        if (tk.css) p.style.setProperty(tk.prop, tk.value); else p.className = tk.raw;
        var v = W.getComputedStyle(p).getPropertyValue(tk.color).trim();
        out.push(v && (tk.css || v !== base) && rgbaOf(v) ? v : '');
      }
      body.removeChild(p);
    } catch (e) {}
    return out;
  }
  function styleInfo(j, el) {
    var d = j.ev.delta || {}, rem = (d.removed || []).map(parseTok), add = (d.added || []).map(parseTok), i, k;
    var out = { word: '', swatches: [], space: null, radius: false, gd: null };
    var cs = null;
    try { cs = W.getComputedStyle(el); } catch (e) { cs = null; }
    var cands = [];
    for (i = 0; i < add.length; i++) {
      var a = add[i];
      if (!a.color || (a.variant && a.variant !== 'dark')) continue;
      var had = false;
      for (k = 0; k < rem.length; k++) if (rem[k].fam === a.fam && rem[k].variant === a.variant) had = true;
      cands.push({ tok: a, had: had });
    }
    var probed = probeColors(cands.map(function (x) { return x.tok; }));
    for (i = 0; i < cands.length && out.swatches.length < 2; i++) {
      var to = probed[i] || '', from = cs ? cs.getPropertyValue(cands[i].tok.color).trim() : '';
      if (!rgbaOf(from)) continue;
      if (!to && !cands[i].had) continue;
      out.swatches.push({ prop: cands[i].tok.color, from: from, to: to });
    }
    var all = add.concat(rem);
    for (i = 0; i < all.length; i++) {
      if (all[i].variant) continue;
      if (all[i].space && !out.space) out.space = { kind: all[i].space, sides: all[i].sides || SIDE_OF[''] };
      if (all[i].radius) out.radius = true;
    }
    out.word = out.swatches.length ? 'renk' : out.space ? 'boşluk' : out.radius ? 'köşe' : '';
    return out;
  }
  function refreshSwatches(j, el) {
    if (!j.sty || !j.sty.swatches.length || !el || !el.isConnected) return;
    try {
      var cs = W.getComputedStyle(el);
      for (var i = 0; i < j.sty.swatches.length; i++) {
        var v = cs.getPropertyValue(j.sty.swatches[i].prop).trim();
        if (rgbaOf(v)) j.sty.swatches[i].to = v;
      }
    } catch (e) {}
  }
  function childGaps(el) {
    var out = [], prev = null, kids = el.children;
    for (var i = 0; i < kids.length && i < 40 && out.length < 24; i++) {
      var b = kids[i].getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) continue;
      if (prev) {
        var top = Math.max(prev.top, b.top), bot = Math.min(prev.bottom, b.bottom);
        if (bot - top > 2 && b.left - prev.right >= 1) out.push({ l: prev.right, t: top, w: b.left - prev.right, h: bot - top });
        else {
          var lft = Math.max(prev.left, b.left), rgt = Math.min(prev.right, b.right);
          if (rgt - lft > 2 && b.top - prev.bottom >= 1) out.push({ l: lft, t: prev.bottom, w: rgt - lft, h: b.top - prev.bottom });
        }
      }
      prev = b;
    }
    return out;
  }
  function readGuides(j, el, r) {
    var s = j.sty, cs;
    try { cs = W.getComputedStyle(el); } catch (e) { return; }
    var rad = cs.borderTopLeftRadius || '0';
    var goal = {
      p: [pxOf(cs.paddingTop), pxOf(cs.paddingRight), pxOf(cs.paddingBottom), pxOf(cs.paddingLeft)],
      m: [pxOf(cs.marginTop), pxOf(cs.marginRight), pxOf(cs.marginBottom), pxOf(cs.marginLeft)],
      r: /%$/.test(rad) ? pxOf(rad) / 100 * Math.min(r.w, r.h) : Math.min(pxOf(rad), Math.min(r.w, r.h) / 2),
      gaps: s.space && s.space.kind === 'gap' ? childGaps(el) : null
    };
    if (!s.gd) s.gd = { cur: { p: goal.p.slice(), m: goal.m.slice(), r: goal.r }, goal: goal };
    else s.gd.goal = goal;
  }
  function smoothGuides(j, dt) {
    var gd = j.sty && j.sty.gd;
    if (!gd) return;
    var k = RM ? 1 : 1 - Math.exp(-dt / 90), cur = gd.cur, goal = gd.goal;
    for (var i = 0; i < 4; i++) { cur.p[i] += (goal.p[i] - cur.p[i]) * k; cur.m[i] += (goal.m[i] - cur.m[i]) * k; }
    cur.r += (goal.r - cur.r) * k;
  }

  function startJob(c, ev, t, directTarget) {
    var kind = ACT[ev.kind] ? ev.kind : 'edit';
    if (c.job) { release(c.job.ev); endBuild(c.job); }
    if (c.job && c.job.bub) { c.job.bub.cv.width = 0; c.job.bub = null; }
    var tr = travelDur();
    c.job = {
      ev: ev, kind: kind, t0: t, p0: { x: c.x, y: c.y }, tr: tr, ad: actDur(kind),
      target: directTarget
        ? { mode: 'el', el: directTarget.el, node: directTarget.node || null, s: directTarget.s || 0, e: directTarget.e || 0, rect: null, goal: null, lines: null }
        : { mode: 'hint', el: null, node: null, s: 0, e: 0, rect: null, goal: null, lines: null },
      paintReadyAt: null,
      needResolve: !directTarget, retryAt: t + 350, nextRead: 0, scrolled: false,
      dir: c.slot % 2 ? 1 : -1,
      nextAt: t + tr * 0.5, nextDone: false, exclude: ev.next && kind === 'add' ? matchSet(ev.next) : null,
      watch: null, arr: 0, arrFull: false, applied: 0, sty: null, bub: null, bubA: 0, guideA: 0, typeDur: 0, cover: '', now: t,
      rec: ev.gate ? { noisy: new Set(), hits: [], last: 0, evalAt: 0, over: false } : null, cssSnap: null, truth: null, retarget: false,
      buildRoots: Array.isArray(ev.__acBuild) ? ev.__acBuild.slice() : [], build: null, buildDur: 0
    };
    c.baseLabel = labelOf(ev);
    c.labelText = c.baseLabel;
    c.agentTag = agentTagOf(ev);
    setShape(c, kind === 'text' ? 'i' : 'a');
    hideAll(c);
  }

  function cleanDelta(d) {
    if (!d || typeof d !== 'object') return null;
    var clip = function (v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) : ''; };
    var list = function (v) {
      var out = [];
      if (Array.isArray(v)) for (var i = 0; i < v.length && out.length < 6; i++) { var s = clip(v[i]); if (s && out.indexOf(s) < 0) out.push(s); }
      return out;
    };
    var o = {}, from = clip(d.from), to = clip(d.to), el = clip(d.el);
    if (from && to) { o.from = from; o.to = to; }
    var rem = list(d.removed), add = list(d.added);
    if (rem.length) o.removed = rem;
    if (add.length) o.added = add;
    if (el && /^[A-Za-z][\w.:-]*$/.test(el)) o.el = el;
    if (d.size && typeof d.size === 'object') {
      var w = d.size.w === 1 || d.size.w === -1 ? d.size.w : 0, h = d.size.h === 1 || d.size.h === -1 ? d.size.h : 0;
      if (w || h) o.size = { w: w, h: h };
    }
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return o;
    return null;
  }

  var PSEUDO_DROP_RE = /::?(?:hover|focus-visible|focus-within|focus|active|visited|target|checked|before|after|placeholder|selection|marker|first-line|first-letter|backdrop|-(?:webkit|moz|ms)-[\w-]+)(?![\w-])(?:\([^)]*\))?/g;
  function splitSelectorList(s) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function cleanSelector(raw) {
    var s = str(raw, 200);
    if (!s || /[{}<;`&\u0000-\u001f\u007f]/.test(s)) return null;
    var state = '', parts = splitSelectorList(s), keep = [];
    for (var i = 0; i < parts.length && i < 8; i++) {
      var q = parts[i].replace(PSEUDO_DROP_RE, function (m) {
        var st = /hover|focus|active|visited|target|checked/.exec(m);
        if (st && !state) state = st[0];
        return '';
      }).replace(/\s+/g, ' ').trim();
      if (!q || /[>+~]$/.test(q) || /^(?:html|body|\*|:root)$/i.test(q)) continue;
      keep.push(q);
    }
    if (!keep.length) return null;
    var sel = keep.join(', ');
    try { D.querySelector(sel); } catch (e) { return null; }
    return { sel: sel, state: state };
  }

  function okName(s, max) { return typeof s === 'string' && s.length > 0 && s.length <= max && !/[\s{}$`'"<>]/.test(s); }
  function cleanPath(v) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length && i < 8; i++) {
      var it = v[i];
      if (!it || typeof it !== 'object') continue;
      var o = {}, cls = [];
      if (typeof it.tag === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(it.tag)) o.tag = it.tag;
      if (okName(it.id, 200)) o.id = it.id;
      if (Array.isArray(it.classes)) for (var k = 0; k < it.classes.length && cls.length < 4; k++) if (okName(it.classes[k], 80) && cls.indexOf(it.classes[k]) < 0) cls.push(it.classes[k]);
      if (cls.length) o.classes = cls;
      if (o.tag || o.id || cls.length) out.push(o);
    }
    return out.slice(-4);
  }

  function sanitize(ev) {
    var h = ev.hint && typeof ev.hint === 'object' ? ev.hint : {};
    var startLine = toInt(ev.startLine, 1);
    var classes = [];
    if (Array.isArray(h.classes)) {
      for (var i = 0; i < h.classes.length && classes.length < 12; i++) {
        if (typeof h.classes[i] === 'string' && h.classes[i] && !/\s/.test(h.classes[i])) classes.push(h.classes[i]);
      }
    }
    var nx = null;
    if (ev.next && typeof ev.next === 'object') {
      var ncls = [];
      if (Array.isArray(ev.next.classes)) {
        for (var q = 0; q < ev.next.classes.length && ncls.length < 12; q++) {
          if (typeof ev.next.classes[q] === 'string' && ev.next.classes[q] && !/\s/.test(ev.next.classes[q])) ncls.push(ev.next.classes[q]);
        }
      }
      nx = { id: str(ev.next.id), classes: ncls, tag: str(ev.next.tag, 40).toLowerCase(), text: str(ev.next.text, 120) };
      var nextNth = Math.floor(Number(ev.next.nth));
      if (isFinite(nextNth) && nextNth >= 0) nx.nth = nextNth;
      if (typeof ev.next.repeat === 'boolean') nx.repeat = ev.next.repeat;
      if (str(ev.next.view, 60)) nx.view = str(ev.next.view, 60);
      var npath = cleanPath(ev.next.path);
      if (npath.length) nx.path = npath;
      var nown = cleanOwner(ev.next.owner);
      if (nown) nx.owner = nown;
      if (!hasHint(nx)) nx = null;
    }
    var hint = { id: str(h.id), classes: classes, tag: str(h.tag, 40).toLowerCase(), text: str(h.text, 120) };
    var cs = cleanSelector(h.selector);
    if (cs) { hint.selector = cs.sel; if (cs.state) hint.selState = cs.state; }
    var hpath = cleanPath(h.path);
    if (hpath.length) hint.path = hpath;
    var hown = cleanOwner(h.owner);
    if (hown) hint.owner = hown;
    if (Array.isArray(h.ipath) && h.ipath.length && h.ipath.length <= 24) {
      var ip = [];
      for (var ii = 0; ii < h.ipath.length; ii++) { var iv = h.ipath[ii]; if (typeof iv === 'number' && iv % 1 === 0 && iv >= 0 && iv <= 9999) ip.push(iv); else { ip = null; break; } }
      if (ip) hint.ipath = ip;
    }
    var cssProps = [];
    if (Array.isArray(ev.cssProps)) {
      for (var p = 0; p < ev.cssProps.length && cssProps.length < 8; p++) {
        var pn = ev.cssProps[p];
        if (typeof pn === 'string' && pn.length <= 40 && /^-{0,2}[a-z][a-z0-9-]*$/.test(pn) && cssProps.indexOf(pn) < 0) cssProps.push(pn);
      }
    }
    var nth = Math.floor(Number(h.nth));
    if (isFinite(nth) && nth >= 0) hint.nth = nth;
    if (typeof h.repeat === 'boolean') hint.repeat = h.repeat;
    if (str(h.view, 60)) hint.view = str(h.view, 60);
    if (str(h.url, 300)) hint.url = str(h.url, 300);
    var urls = [];
    if (Array.isArray(ev.urls)) {
      for (var u = 0; u < ev.urls.length && urls.length < 8; u++) {
        var us = str(ev.urls[u], 300);
        if (us && us.charAt(0) === '/') urls.push(us);
      }
    }
    return {
      gate: ev.gate === true,
      paintAck: ev.paintAck === true,
      created: ev.created === true,
      urls: urls,
      next: nx,
      id: typeof ev.id === 'string' ? ev.id : '',
      file: String(ev.file),
      startLine: startLine,
      endLine: Math.max(startLine, toInt(ev.endLine, startLine)),
      kind: Object.prototype.hasOwnProperty.call(ACT, ev.kind) ? ev.kind : 'edit',
      hint: hint,
      url: str(ev.url || hint.url, 300),
      at: Number(ev.at) || 0,
      delta: cleanDelta(ev.delta),
      cssProps: cssProps,
      anchor: ev.anchor === 'component' ? 'component' : '',
      lead: ev.lead === true,
      agent: ev.agent === 'claude' || ev.agent === 'codex' ? ev.agent : '',
      session: typeof ev.session === 'string' && /^[a-f0-9]{4,16}$/.test(ev.session) ? ev.session : ''
    };
  }

  var followMode = true, followBusy = false, lastUserInput = 0;
  (function () {
    var q = '';
    try { q = new URL(W.location.href).searchParams.get('follow') || ''; } catch (e) {}
    if (q === '0') followMode = false;
    else if (q === 'search') followMode = 'search';
    else if (q === '1') followMode = true;
    else {
      try {
        var saved = W.localStorage.getItem('agent-cursors-follow');
        if (saved === '0') followMode = false;
        else if (saved === 'search') followMode = 'search';
      } catch (e) {}
    }
    W.__agentCursorsFollow = followMode;
  })();

  function isFollowEnabled() {
    var value = W.__agentCursorsFollow;
    if (value === 'search') return 'search';
    if (value === false || value === 0 || value === '0') return false;
    return value === true ? true : followMode;
  }
  function noteUserInput(e) { if (!e || e.isTrusted !== false) lastUserInput = Date.now(); }
  function navItems() {
    var list = D.querySelectorAll('nav button, nav a, nav [role="tab"], aside button, aside a, aside [role="tab"], header button, header a, header [role="tab"]');
    return Array.prototype.filter.call(list, function (el) { return el && el !== host && !el.disabled; });
  }
  function isStrongMatch(h, found) {
    if (!h || !found || !found.el) return false;
    var el = found.el;
    if (h.id && el.id === h.id) return true;
    if (h.selector && el.matches) { try { if (el.matches(h.selector)) return true; } catch (e) {} }
    if (found.ip) return true;
    var cls = h.classes || [], i;
    for (i = 0; i < cls.length; i++) {
      if (el.classList && el.classList.contains(cls[i])) return true;
    }
    if (h.id || cls.length) return false;
    return !!(h.text && h.text.length >= 4 && found.node);
  }
  function isActiveNav(el) {
    if (!el || !el.getAttribute) return false;
    var cur = el.getAttribute('aria-current');
    return (!!cur && cur !== 'false') || el.getAttribute('aria-selected') === 'true' ||
      /(?:^|\s)(?:active|selected|current|is-active)(?:\s|$)/.test(typeof el.className === 'string' ? el.className : '');
  }
  function targetAfterFollow(ev, done) {
    var h = hasHint(ev.hint) ? ev.hint : null;
    var until = Date.now() + (h ? 1500 : 350);
    var timer = setInterval(function () {
      var found = h ? resolveTarget(h) : null;
      var ok = !!found && isStrongMatch(h, found);
      if (ok || Date.now() >= until) {
        clearInterval(timer);
        followBusy = false;
        done(ok ? found : null);
      }
    }, 50);
  }
  function navMatch(view) {
    var items = navItems(), wanted = norm(view || ''), i;
    if (!wanted) return null;
    for (i = 0; i < items.length; i++) {
      var label = norm(items[i].getAttribute('aria-label') || items[i].textContent || '');
      if (label && (label === wanted || label.indexOf(wanted) !== -1 || wanted.indexOf(label) !== -1)) return items[i];
    }
    return null;
  }
  function viewInactive(view) { var m = navMatch(view); return !!m && !isActiveNav(m); }

  var ROUTE_WAIT_MS = 9000;
  var ARRIVE_WAIT_MS = 4000;
  var NAV_LOOP_MAX = 6;
  var leaving = false;
  var routeNav = null;
  function samePlace(next) {
    return next.pathname.replace(/\/+$/, '') === W.location.pathname.replace(/\/+$/, '') && next.search === W.location.search;
  }
  function navLoop() {
    try {
      var key = 'agent-cursors-follow-navs', t = Date.now();
      var list = (W.sessionStorage.getItem(key) || '').split(',').map(Number).filter(function (x) { return x && t - x < 20000; });
      if (list.length >= NAV_LOOP_MAX) return true;
      list.push(t);
      W.sessionStorage.setItem(key, list.join(','));
    } catch (e) {}
    return false;
  }
  function linkTo(next) {
    var list = D.querySelectorAll('a[href]'), fallback = null;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if ((a.target && a.target !== '_self') || a.hasAttribute('download') || host.contains(a)) continue;
      var u;
      try { u = new URL(a.href, W.location.href); } catch (e) { continue; }
      if (u.origin !== next.origin || u.pathname.replace(/\/+$/, '') !== next.pathname.replace(/\/+$/, '') || u.search !== next.search) continue;
      if (isVisible(a)) return a;
      if (!fallback) fallback = a;
    }
    return fallback;
  }
  function busyFor() {
    var t = now(), wait = 0;
    for (var i = 0; i < cursors.length; i++) {
      var j = cursors[i].job;
      if (!j || cursors[i].dead || j.kind === 'read') continue;
      wait = Math.max(wait, j.t0 + j.tr + j.ad - t);
    }
    return Math.max(0, Math.min(2500, wait));
  }
  function hardNavigate(next) {
    leaving = true;
    try { W.location.assign(next.href); } catch (e) { leaving = false; }
  }
  function arriveRoute(ev, done) {
    var nav = routeNav;
    routeNav = null;
    followBusy = false;
    var queued = nav ? nav.queue : [];
    var h = ev && hasHint(ev.hint) ? ev.hint : null;
    var until = Date.now() + (h ? ARRIVE_WAIT_MS : 300);
    var timer = setInterval(function () {
      var found = h ? resolveTarget(h) : null;
      var ok = !!found && isStrongMatch(h, found);
      if (ok || Date.now() >= until) {
        clearInterval(timer);
        if (done) done(ok ? found : null);
        for (var i = 0; i < queued.length; i++) (function (raw, index) {
          setTimeout(function () { if (!closed) onEvent(raw); }, 90 * (index + 1));
        })(queued[i], i);
      }
    }, 60);
  }
  function followUrl(url, ev, done) {
    if (!url) return false;
    var next;
    try { next = new URL(url, W.location.href); } catch (e) { return false; }
    if (samePlace(next)) return false;
    if (leaving) return true;
    if (navLoop()) return false;
    followBusy = true;
    routeNav = { path: next.pathname.replace(/\/+$/, ''), search: next.search, queue: [] };
    setTimeout(function () {
      if (closed) return;
      var link = linkTo(next);
      if (!link) { hardNavigate(next); return; }
      try { link.click(); } catch (e) { hardNavigate(next); return; }
      var deadline = Date.now() + ROUTE_WAIT_MS;
      var poll = setInterval(function () {
        if (closed) { clearInterval(poll); return; }
        if (samePlace(next)) { clearInterval(poll); arriveRoute(ev, done); return; }
        if (Date.now() >= deadline) { clearInterval(poll); hardNavigate(next); }
      }, 80);
    }, busyFor());
    return true;
  }
  function maybeFollow(ev, done) {
    var enabled = isFollowEnabled();
    if (!enabled || followBusy || Date.now() - lastUserInput < 5000) return false;
    if (ev.at && Date.now() - ev.at > 10000) return false;
    var view = (ev.hint && ev.hint.view) || (ev.next && ev.next.view) || '';
    if (!view && !ev.url && enabled !== 'search') return false;
    if (ev.url && followUrl(ev.url, ev, done)) return true;
    var items = navItems();
    var match = navMatch(view);
    if (match && isActiveNav(match)) return false;
    if (match) {
      followBusy = true;
      try { match.click(); } catch (e) { followBusy = false; return false; }
      targetAfterFollow(ev, done);
      return true;
    }
    if (enabled !== 'search' || !items.length || !ev.hint || !hasHint(ev.hint)) return false;
    followBusy = true;
    var original = items.find(isActiveNav);
    var pos = 0;
    var scan = function () {
      if (pos >= Math.min(6, items.length)) {
        followBusy = false;
        try { if (original) original.click(); } catch (e) {}
        done(null);
        return;
      }
      try { items[pos++].click(); } catch (e) { pos++; }
      setTimeout(function () {
        var found = resolveTarget(ev.hint);
        if (found) { followBusy = false; done(found); }
        else scan();
      }, 120);
    };
    scan();
    return true;
  }

  function pathSegs(p) { return String(p || '/').split(/[?#]/)[0].split('/').filter(Boolean); }
  function sameDecoded(a, b) { try { return decodeURIComponent(a) === decodeURIComponent(b); } catch (e) { return a === b; } }
  function fillRoute(pattern) {
    var segs = pathSegs(pattern), cur = pathSegs(W.location.pathname), out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (/^\[\[?\.\.\./.test(s)) {
        if (i < cur.length) out = out.concat(cur.slice(i));
        else if (!/^\[\[/.test(s)) return '';
        break;
      }
      if (/^\[.+\]$/.test(s)) { if (i >= cur.length) return ''; out.push(cur[i]); continue; }
      out.push(s);
    }
    return '/' + out.join('/');
  }
  function routeHere(pattern) {
    var prefix = /\/\*$/.test(pattern);
    var filled = fillRoute(prefix ? (pattern.replace(/\/\*$/, '') || '/') : pattern);
    if (!filled) return false;
    var here = '/' + pathSegs(W.location.pathname).join('/');
    if (prefix) return filled === '/' || sameDecoded(here, filled) || here.indexOf(filled + '/') === 0;
    return sameDecoded(here, filled);
  }
  var REPLAY_FRESH_MS = 45000;
  function forRoute(ev, dest, target) {
    if (dest === null) return true;
    if (dest && dest.replace(/\/+$/, '') === target) return true;
    var list = ev.urls || [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (/\/\*$/.test(u)) {
        var base = u.replace(/\/\*$/, '');
        if (!base || target === base || target.indexOf(base + '/') === 0) return true;
      } else if (u.replace(/\/+$/, '') === target) return true;
    }
    return false;
  }
  function routeTarget(ev) {
    var list = ev.urls || [];
    if (!list.length) return null;
    var i;
    for (i = 0; i < list.length; i++) if (routeHere(list[i])) return '';
    for (i = 0; i < list.length; i++) {
      var filled = fillRoute(list[i].replace(/\/\*$/, '') || '/');
      if (filled) return filled;
    }
    return '';
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function isNone(n) { try { return W.getComputedStyle(n).display === 'none'; } catch (e) { return false; } }
  function cssEsc(s) { return W.CSS && typeof W.CSS.escape === 'function' ? W.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function hiddenOwner(el) {
    for (var n = el, d = 0; n && n.nodeType === 1 && d < 60; n = n.parentElement, d++) {
      if (n.localName === 'details' && !n.open && n !== el) return { details: n };
      if (n.getAttribute && n.getAttribute('role') === 'tabpanel' && (n.hidden || isNone(n))) {
        var tab = null;
        if (n.id) { try { tab = D.querySelector('[role="tab"][aria-controls="' + cssEsc(n.id) + '"]'); } catch (e) { tab = null; } }
        if (!tab) { var lb = (n.getAttribute('aria-labelledby') || '').split(/\s+/)[0]; if (lb) tab = D.getElementById(lb); }
        if (tab && !tab.disabled) return { tab: tab };
      }
      if (n.id && (n.hidden || isNone(n)) && n.getAttribute('role') !== 'tabpanel') {
        var ctl = null, q = cssEsc(n.id);
        try { ctl = D.querySelector('[data-tab="' + q + '"],[aria-controls="' + q + '"],a[href="#' + q + '"],[data-target="#' + q + '"],[data-bs-target="#' + q + '"]'); } catch (e) { ctl = null; }
        if (ctl && !ctl.disabled && !n.contains(ctl) && isVisible(ctl)) return { tab: ctl };
      }
    }
    return null;
  }
  function revealIfHidden(el, then) {
    var owner = el && hiddenOwner(el);
    if (!owner || !isFollowEnabled() || Date.now() - lastUserInput < 5000) return false;
    try { if (owner.tab) owner.tab.click(); else owner.details.open = true; } catch (e) { return false; }
    setTimeout(function () { if (!closed) then(); }, 160);
    return true;
  }

  function findStrict(h, exclude, scope, max) {
    var out = [], i, list;
    if (!h) return out;
    if (h.id) {
      var e = D.getElementById(h.id);
      if (e && e !== host && (!exclude || !exclude.has(e)) && (!scope || scope.contains(e))) out.push(e);
      return out;
    }
    var cls = [];
    for (i = 0; i < (h.classes || []).length; i++) if (typeof h.classes[i] === 'string' && h.classes[i] && !/\s/.test(h.classes[i])) cls.push(h.classes[i]);
    if (!cls.length) return out;
    try { list = (scope || D).getElementsByClassName(cls.join(' ')); } catch (e2) { return out; }
    for (i = 0; i < list.length && out.length < (max || 1); i++) {
      if (list[i] === host || (exclude && exclude.has(list[i]))) continue;
      out.push(list[i]);
    }
    return out;
  }
  function strictSet(h) {
    var set = new Set(), list = findStrict(h, null, null, 3000);
    for (var i = 0; i < list.length; i++) set.add(list[i]);
    return set;
  }
  function elMatches(el, h) {
    if (!el || !h) return false;
    if (h.id) return el.id === h.id;
    var cls = h.classes || [];
    if (!cls.length || !el.classList) return false;
    for (var i = 0; i < cls.length; i++) if (!el.classList.contains(cls[i])) return false;
    return true;
  }
  function claimed(el) {
    for (var i = 0; i < cursors.length; i++) {
      var c = cursors[i], j = c.job;
      if (!j || c.evict || c.dead || j.kind === 'read') continue;
      if (j.target.el === el) return true;
      if (j.kind === 'add' && j.ev.next && !j.nextDone && elMatches(el, j.ev.next)) return true;
    }
    return false;
  }

  var PENDING_MS = 180000;
  var REPLAY_PENDING_MS = 60000;
  var WAIT_MS = 4000;
  var pending = [], pendObs = null, pendTimer = 0, pendDue = 0, revealAt = 0, leadAt = {}, followTimer = 0;

  function addPending(p) {
    for (var i = 0; i < pending.length; i++) if (pending[i].key === p.key) return;
    pending.push(p);
    if (pending.length > 160) pending.shift();
    if (!pendObs && typeof W.MutationObserver === 'function') {
      try {
        pendObs = new W.MutationObserver(function () { schedulePending(150); });
        pendObs.observe(D.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'id', 'style', 'open'] });
      } catch (e) { pendObs = null; }
    }
    schedulePending(0);
    if (p.reveal) recSync();
  }
  function schedulePending(ms) {
    if (closed) return;
    var due = Date.now() + (ms || 0);
    if (pendTimer && pendDue <= due) return;
    clearTimeout(pendTimer);
    pendDue = due;
    pendTimer = setTimeout(checkPending, ms || 0);
  }
  function matchPending(p) {
    var scope = null;
    if (p.scope) {
      scope = findStrict(p.scope, null, null, 1)[0] || null;
      if (!scope) return null;
    }
    var els;
    if (p.strict) els = findStrict(p.want, p.exclude, scope, p.want.repeat ? 4 : 1);
    else {
      var f = resolveTarget(p.want, p.exclude);
      els = f && isStrongMatch(p.want, f) ? [f.el] : findStrict(p.want, p.exclude, scope, 1);
    }
    if (!els.length) return null;
    if (claimed(els[0])) return true;
    if (!isVisible(els[0]) && !hiddenOwner(els[0])) return null;
    return els;
  }
  function showPending(p, els) {
    var go = function () {
      for (var k = 0; k < els.length; k++) (function (el, k) {
        if (!el.isConnected || claimed(el)) return;
        var copy = Object.assign({}, p.ev, { id: p.ev.id + ':shown:' + k, gate: false, paintAck: false, sent: false, created: false });
        if (p.reveal) { copy.hint = p.want; copy.next = null; }
        if (p.buildRoots && p.buildRoots.length) {
          copy.__acBuild = p.buildRoots.filter(function (r) { return r === el || el.contains(r) || r.contains(el); });
        }
        var wait = Math.max(0, revealAt - Date.now());
        revealAt = Date.now() + wait + 90;
        setTimeout(function () { if (!closed && el.isConnected) enqueueDom(copy, now(), { el: el }); }, wait);
      })(els[k], k);
    };
    if (!isVisible(els[0]) && revealIfHidden(els[0], go)) return;
    go();
  }
  function checkPending() {
    pendTimer = 0;
    if (closed || D.hidden) return;
    var t = Date.now();
    for (var i = pending.length - 1; i >= 0; i--) {
      var p = pending[i];
      if (t > p.until) { pending.splice(i, 1); continue; }
      var hit = matchPending(p);
      if (!hit) continue;
      pending.splice(i, 1);
      if (hit !== true) showPending(p, hit);
    }
    if (pending.length) schedulePending(1000);
    else if (pendObs) { try { pendObs.disconnect(); } catch (e) {} pendObs = null; }
    recSync();
  }
  function waitFor(ev) {
    release(ev);
    if (ev.kind === 'add' && ev.next) {
      addPending({ key: 'w:' + ev.id, ev: ev, want: ev.next, scope: null, exclude: strictSet(ev.next), strict: true, reveal: true, until: Date.now() + WAIT_MS * 2 });
      return;
    }
    var h = ev.hint;
    if (!h || !(h.id || h.selector || (h.classes && h.classes.length) || (h.text && h.text.length >= 4))) return;
    addPending({ key: 'w:' + ev.id, ev: ev, want: h, scope: null, exclude: null, strict: false, reveal: false, until: Date.now() + WAIT_MS });
  }
  function followSoon(ev) {
    clearTimeout(followTimer);
    followTimer = setTimeout(function () { followTimer = 0; if (!closed) maybeFollow(ev, function () {}); }, 900);
  }
  function onCreated(ev, raw, dest) {
    var live = !raw.__acReplay;
    if (ev.next) {
      addPending({
        key: 'c:' + ev.id, ev: ev, want: ev.next, scope: hasHint(ev.hint) ? ev.hint : null,
        exclude: live && ev.kind === 'add' ? strictSet(ev.next) : null,
        strict: true, reveal: true, until: live || !ev.at ? Date.now() + PENDING_MS : ev.at + REPLAY_PENDING_MS
      });
    }
    if (dest) {
      release(ev);
      if (live) followSoon(ev);
      return;
    }
    if (!live && !(ev.at && Date.now() - ev.at < 10000)) { release(ev); return; }
    var view = (ev.hint && ev.hint.view) || (ev.next && ev.next.view) || '';
    if (live && view && viewInactive(view) && maybeFollow(ev, function () { leadCreated(ev); })) return;
    leadCreated(ev);
  }
  function leadCreated(ev) {
    var site = null;
    if (ev.hint && hasHint(ev.hint) && !(leadAt[ev.file] && Date.now() - leadAt[ev.file] < 2500)) {
      site = findStrict(ev.hint, null, null, 1)[0] || null;
    }
    if (!site) { release(ev); return; }
    leadAt[ev.file] = Date.now();
    playResolved(Object.assign({}, ev, { next: null, created: false, lead: true }), { el: site });
  }

  var recentIds = [];
  function isDup(id) {
    if (!id) return false;
    if (recentIds.indexOf(id) !== -1) return true;
    recentIds.push(id);
    if (recentIds.length > 200) recentIds.shift();
    return false;
  }

  var hiddenEvents = [], nextPlaybackAt = 0;
  function enqueueDom(ev, t, directTarget) {
    var key = keyOf(ev);
    var c = byKey[key];
    if (c && (c.dead || c.evict)) c = null;
    if (c) {
      var j = c.job;
      if (ev.gate || ev.kind === 'read' || !j || t - j.t0 >= j.tr + j.ad) {
        if (ev.gate) { while (c.queue.length) release(c.queue.shift()); }
        startJob(c, ev, t, directTarget);
      } else c.queue.push(ev);
    } else {
      c = createCursor(ev, t, key);
      startJob(c, ev, t, directTarget);
    }
    kick();
  }
  function playResolved(ev, found, revealed) {
    if (!revealed && found && found.el && !isVisible(found.el) &&
        revealIfHidden(found.el, function () { playResolved(ev, found, true); })) return;
    var all = found && found.all && found.all.length ? found.all : null;
    if (!all || all.length < 2) { enqueueDom(ev, now(), found || null); return; }
    for (var i = 0; i < all.length && i < maxCursors; i++) (function (target, index) {
      var copy = index ? Object.assign({}, ev, { id: ev.id + ':repeat:' + index, gate: false, paintAck: false, hint: Object.assign({}, ev.hint, { repeat: false }) }) : ev;
      setTimeout(function () { if (!closed) enqueueDom(copy, now(), target); }, index * 75);
    })(all[i], i);
  }
  function onEvent(raw) {
    if (!raw || typeof raw !== 'object') return;
    if (!raw.__acReplay && raw.surface !== 'shell' && (reloadTimer || (raw.phase === 'post' && wantsStaticReload(raw)))) scheduleStaticReload();
    if (raw.surface && raw.surface !== 'dom') {
      if (raw.url) maybeFollow(raw, function () {});
      hud.push(raw);
      if (raw.gate === true) release({ gate: true, id: raw.id });
      return;
    }
    if (typeof raw.file !== 'string' || !raw.file) return;
    if (!raw.__acReplay && !raw.__acStaggered && !raw.__acQueued && isDup(raw.id)) { release({ gate: raw.gate === true, id: raw.id }); return; }
    if (raw.__acReplay && !raw.__acStaggered) isDup(raw.id);
    if (raw.__acReplay && !raw.__acQueued && raw.created !== true && Number(raw.at) && Date.now() - Number(raw.at) > REPLAY_FRESH_MS) {
      if (raw.gate === true) release({ gate: true, id: raw.id });
      return;
    }
    if (D.hidden) {
      hiddenEvents.push(raw);
      if (hiddenEvents.length > 20) hiddenEvents.shift();
      if (raw.gate === true) release({ gate: true, id: raw.id });
      return;
    }
    var ev = sanitize(raw), t = now();
    if (ev.kind === 'read') {
      if (raw.__acReplay || routeNav || leaving) return;
      var rf = resolveTarget(ev.hint);
      if (rf && isStrongMatch(ev.hint, rf) && isVisible(rf.el) && !hiddenOwner(rf.el)) enqueueDom(ev, t, rf);
      return;
    }
    if (!raw.__acHud && !raw.__acStaggered && !raw.__acQueued) rememberDom(ev);
    if (!ev.gate && !raw.__acStaggered) {
      var wall = Date.now(), delay = Math.max(0, nextPlaybackAt - wall);
      nextPlaybackAt = wall + delay + 75;
      if (delay > 0) {
        var later = Object.assign({}, raw, { __acStaggered: true });
        setTimeout(function () { if (!closed) onEvent(later); }, delay);
        return;
      }
    }
    var dest = routeTarget(ev);
    if (dest !== null) ev.url = dest;
    if (routeNav && !raw.__acQueued) {
      if (forRoute(ev, dest, routeNav.path)) {
        routeNav.queue.push(Object.assign({}, raw, { __acQueued: true }));
        if (routeNav.queue.length > 60) release(sanitize(routeNav.queue.shift()));
      } else release(ev);
      return;
    }
    if (ev.created) { onCreated(ev, raw, dest); return; }
    if (dest) {
      if (!raw.__acReplay && maybeFollow(ev, function (after) { if (after) playResolved(ev, after); else waitFor(ev); })) return;
      release(ev);
      return;
    }
    if (raw.__acReplay && !raw.__acFpDone && fpReplay(raw, ev, 0)) return;
    var found = resolveTarget(ev.hint);
    var strong = !!found && isStrongMatch(ev.hint, found);
    var nextView = ev.kind === 'add' && ev.next && ev.next.view && !ev.hint.view ? ev.next.view : '';
    if (strong && !(nextView && viewInactive(nextView))) { playResolved(ev, found); return; }
    if (maybeFollow(ev, function (after) {
      if (after) playResolved(ev, after);
      else if (strong && found.el.isConnected) playResolved(ev, found);
      else waitFor(ev);
    })) return;
    if (strong) { playResolved(ev, found); return; }
    var hidden = findStrict(ev.hint, null, null, 1)[0];
    if (hidden && hiddenOwner(hidden)) { playResolved(ev, { el: hidden }); return; }
    waitFor(ev);
  }

  function afterHint(ev) {
    var h = ev.hint || {}, d = ev.delta || {};
    if (ev.kind === 'add' && ev.next) return ev.next;
    if (ev.kind === 'text' && d.to) return { id: h.id, classes: h.classes || [], tag: h.tag, text: d.to.replace(/…$/, '') };
    if ((d.removed || d.added) && h.classes && h.classes.length) {
      var rem = d.removed || [], cls = [];
      for (var i = 0; i < h.classes.length; i++) if (rem.indexOf(h.classes[i]) < 0) cls.push(h.classes[i]);
      var add = d.added || [];
      for (i = 0; i < add.length; i++) if (!/[:\s]/.test(add[i]) && cls.indexOf(add[i]) < 0) cls.push(add[i]);
      return { id: h.id, classes: cls, tag: h.tag, text: h.text };
    }
    return h;
  }

  var domByFile = {};
  function fileKeyOf(f) { return String(f).replace(/\\/g, '/').toLowerCase(); }
  function rememberDom(ev) {
    if (ev.kind === 'read' || ev.created) return;
    var k = fileKeyOf(ev.file), t = Date.now(), cur = domByFile[k];
    if (!cur || t - cur.at > 2500) cur = domByFile[k] = { at: t, list: [] };
    cur.at = t;
    if (cur.list.length < 12) cur.list.push(ev);
  }
  function replayable(file) { var cur = domByFile[fileKeyOf(file)]; return cur ? cur.list.length : 0; }
  function replayFile(file) {
    var cur = domByFile[fileKeyOf(file)];
    if (!cur || closed) return;
    var tag = Math.random().toString(36).slice(2, 8);
    cur.list.forEach(function (ev, i) {
      var copy = Object.assign({}, ev, {
        id: 'hud-' + tag + '-' + i, gate: false, paintAck: false, sent: false, created: false,
        hint: afterHint(ev), next: null, urls: [], url: '', __acHud: true, __acStaggered: true
      });
      setTimeout(function () { if (!closed) onEvent(copy); }, i * 90);
    });
  }

  var errCache = 0, errAt = 0;
  function errLevel() {
    var t = Date.now();
    if (t - errAt < 90) return errCache;
    errAt = t;
    var n = 0;
    try {
      if (D.querySelector('vite-error-overlay')) n += 1000;
      if (D.getElementById('webpack-dev-server-client-overlay')) n += 1000;
      var ps = D.getElementsByTagName('nextjs-portal');
      for (var i = 0; i < ps.length && i < 4; i++) {
        var sr = ps[i].shadowRoot;
        if (!sr) continue;
        if (sr.querySelector('[data-nextjs-dialog]')) n += 500;
        var is = sr.querySelector('[data-issues]');
        if (is) { var m = /\d+/.exec(is.textContent || ''); n += m ? Math.min(99, Number(m[0])) : 1; }
      }
    } catch (e) {}
    errCache = n;
    return n;
  }
  var SIG_PROPS = ['color', 'background-color', 'border-top-color', 'border-top-left-radius', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'margin-top', 'margin-left', 'gap', 'font-size', 'font-weight', 'opacity', 'box-shadow', 'display'];
  function textSig(el) {
    var s = el.textContent || '';
    if (s.length > 200000) s = s.length + s.slice(0, 50000) + s.slice(-50000);
    return s.length + ':' + hashStr(s);
  }
  function sigOf(el, w) {
    if (!el || !el.isConnected) return 'gone';
    var out = (el.getAttribute('class') || '') + '|' + (el.getAttribute('style') || '') + '|' + el.childElementCount;
    try {
      var cs = W.getComputedStyle(el);
      for (var i = 0; i < SIG_PROPS.length; i++) out += '|' + cs.getPropertyValue(SIG_PROPS[i]);
    } catch (e) {}
    var b = el.getBoundingClientRect();
    out += '|' + Math.round(b.width) + 'x' + Math.round(b.height);
    var v = domVersion();
    if (v < 0 || v !== w.textVer || w.textEl !== el) { w.textVer = v; w.textEl = el; w.textHash = textSig(el); }
    return out + '|' + w.textHash;
  }
  function startWatch(c, j, t0) {
    var w = { from: t0, at: t0, state: 'wait', next: t0 + 90, err0: errLevel(), textVer: -2, textEl: null, textHash: '' };
    w.sig = sigOf(j.target.el, w);
    j.watch = w;
    takeCssSnap(j);
  }

  var recObs = null, recOn = false, REC_MAX = 500, TRUTH_MIN = 250;
  var REC_ATTRS = ['class', 'style', 'src', 'href', 'hidden', 'open', 'value', 'd'];
  var REC_SKIP = { 'vite-error-overlay': 1, 'nextjs-portal': 1 };
  function recWanted(j) {
    if (!j || !j.rec || !j.ev.gate || j.kind === 'read') return false;
    if (!j.ev.sent) return true;
    var st = j.watch ? j.watch.state : 'wait';
    return st === 'wait' || st === 'gray' || st === 'error';
  }
  function recSync() {
    var want = false, i;
    for (i = 0; i < cursors.length && !want; i++) if (!cursors[i].dead && recWanted(cursors[i].job)) want = true;
    if (!want && !RM && !closed) for (i = 0; i < pending.length && !want; i++) if (pending[i].reveal) want = true;
    if (want === recOn || typeof W.MutationObserver !== 'function') return;
    try {
      if (want) {
        if (!recObs) recObs = new W.MutationObserver(onRec);
        recObs.observe(D.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: REC_ATTRS });
      } else recObs.disconnect();
      recOn = want;
    } catch (e) { recOn = false; }
  }
  function shapeKey(el) {
    var cl = el.classList ? Array.prototype.slice.call(el.classList).sort().join('.') : '';
    return el.localName + '.' + cl;
  }
  function diffDescend(a, b, depth) {
    var ac = a.children, bc = b.children;
    if (depth > 5 || !ac || !bc || ac.length !== bc.length || !ac.length || ac.length > 40) return b;
    var at = -1;
    for (var i = 0; i < ac.length; i++) {
      if (shapeKey(ac[i]) !== shapeKey(bc[i])) return b;
      if (textSig(ac[i]) !== textSig(bc[i]) || ac[i].getAttribute('class') !== bc[i].getAttribute('class')) {
        if (at >= 0) return b;
        at = i;
      }
    }
    return at < 0 ? b : diffDescend(ac[at], bc[at], depth + 1);
  }
  function recItems(r, out) {
    var i, n;
    if (r.type === 'attributes') {
      if (r.target.nodeType === 1) out.push({ el: r.target, type: 'attr', name: r.attributeName });
      return;
    }
    if (r.type === 'characterData') {
      if (r.target.parentElement) out.push({ el: r.target.parentElement, type: 'text' });
      return;
    }
    var gone = null, removed = r.removedNodes, added = r.addedNodes, any = false;
    for (i = 0; i < removed.length && i < 60; i++) {
      n = removed[i];
      if (n.nodeType !== 1) continue;
      if (!gone) gone = [];
      gone.push({ el: n, shape: shapeKey(n), sig: textSig(n), used: false });
    }
    for (i = 0; i < added.length && i < 60; i++) {
      n = added[i];
      if (n.nodeType === 3) { if (n.nodeValue && n.nodeValue.trim()) { out.push({ el: r.target, type: 'text' }); any = true; } continue; }
      if (n.nodeType !== 1) continue;
      any = true;
      var el = n, shape = null, same = null, k;
      if (gone) {
        shape = shapeKey(n);
        var sig = textSig(n);
        for (k = 0; k < gone.length; k++) if (!gone[k].used && gone[k].shape === shape && gone[k].sig === sig && gone[k].el.getAttribute('class') === n.getAttribute('class')) { gone[k].used = true; same = true; break; }
        if (same) continue;
        for (k = 0; k < gone.length; k++) if (!gone[k].used && gone[k].shape === shape) { gone[k].used = true; el = diffDescend(gone[k].el, n, 0); break; }
      }
      out.push({ el: el, type: el === n ? 'add' : 'text' });
    }
    if (!any && gone && r.target.nodeType === 1) out.push({ el: r.target, type: 'rm' });
  }
  function recSkip(el) {
    if (!el || el.nodeType !== 1 || el === host || el === D.documentElement) return true;
    if (D.head && (el === D.head || D.head.contains(el))) return true;
    if (REC_SKIP[el.localName] || el.id === 'webpack-dev-server-client-overlay') return true;
    return false;
  }
  function onRec(recs) {
    var jobs = [], revs = [], i, k;
    for (i = 0; i < cursors.length; i++) if (!cursors[i].dead && recWanted(cursors[i].job)) jobs.push(cursors[i].job);
    if (!RM) for (i = 0; i < pending.length; i++) if (pending[i].reveal) revs.push(pending[i]);
    if (!jobs.length && !revs.length) return;
    var items = [], t = now(), urgent = false;
    for (i = 0; i < recs.length && items.length < REC_MAX * 2; i++) {
      if (recs[i].type === 'attributes' && /^data-ac-/.test(recs[i].attributeName || '')) continue;
      recItems(recs[i], items);
    }
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (recSkip(it.el)) continue;
      for (k = 0; k < jobs.length; k++) {
        var j = jobs[k], rec = j.rec;
        if (!j.ev.sent) { if (rec.noisy.size < 400) rec.noisy.add(it.el); continue; }
        var pe = it.el.parentElement;
        if (rec.noisy.has(it.el) || (pe && rec.noisy.has(pe))) continue;
        if (it.type === 'add' && j.kind === 'add' && !j.build && (!j.watch || j.watch.state === 'wait') && buildScope(j, it.el)) buildHide(it.el, j.buildRoots);
        if (rec.over) continue;
        if (rec.hits.length >= REC_MAX) { rec.over = true; continue; }
        rec.hits.push(it);
        rec.last = t;
        if (j.watch && j.watch.state === 'wait') { j.watch.next = 0; urgent = true; }
      }
      if (it.type === 'add') {
        for (k = 0; k < revs.length; k++) {
          var p = revs[k];
          if (elMatches(it.el, p.want) && !(p.exclude && p.exclude.has(it.el))) buildHide(it.el, p.buildRoots || (p.buildRoots = []));
        }
      }
    }
    if (urgent) frameNow();
  }
  function frameNow() {
    if (raf) { W.cancelAnimationFrame(raf); raf = 0; }
    frame();
  }

  var BUILD_SAFE = 3000, BUILD_MAX_EL = 150, BUILD_PIECES = 12, BUILD_LEAD = 250, BUILD_STEP = 100;
  var buildSet = typeof Map === 'function' ? new Map() : null, buildStyle = null, buildTimer = 0;
  function ensureBuildStyle() {
    if (buildStyle && buildStyle.isConnected) return;
    buildStyle = D.getElementById('__agent-cursors-build');
    if (buildStyle) return;
    buildStyle = D.createElement('style');
    buildStyle.id = '__agent-cursors-build';
    buildStyle.textContent = '[data-ac-build]{opacity:0!important;transition:none!important}' +
      '[data-ac-build="in"]{opacity:1!important;transition:opacity .22s ease!important}';
    (D.head || D.documentElement).appendChild(buildStyle);
  }
  function buildScope(j, el) {
    if (j.ev.next && elMatches(el, j.ev.next)) return true;
    var pred = j.target.el;
    if (!pred || !pred.isConnected) return false;
    var anc = pred;
    for (var i = 0; i < 3 && anc.parentElement && anc.parentElement !== D.body && anc.parentElement !== D.documentElement; i++) anc = anc.parentElement;
    return el !== anc && anc.contains(el);
  }
  function buildHide(el, owner) {
    if (RM || !buildSet || !el || el.nodeType !== 1 || !el.isConnected || buildSet.has(el)) return false;
    if (/^(?:script|style|link|template|meta|noscript)$/.test(el.localName)) return false;
    for (var x = el.parentElement, d = 0; x && d < 40; x = x.parentElement, d++) if (buildSet.has(x)) return false;
    try { if (el.getElementsByTagName('*').length > BUILD_MAX_EL) return false; } catch (e) { return false; }
    var b = el.getBoundingClientRect();
    if (b.width * b.height > W.innerWidth * W.innerHeight * 0.6) return false;
    ensureBuildStyle();
    try { el.setAttribute('data-ac-build', ''); } catch (e) { return false; }
    buildSet.set(el, Date.now());
    owner.push(el);
    if (!buildTimer) buildTimer = setTimeout(buildSafety, 500);
    return true;
  }
  function buildUnhide(el) {
    if (!buildSet || !buildSet.has(el)) return;
    buildSet.delete(el);
    try { el.removeAttribute('data-ac-build'); } catch (e) {}
  }
  function buildSafety() {
    buildTimer = 0;
    var t = Date.now();
    buildSet.forEach(function (at, el) { if (t - at > BUILD_SAFE || !el.isConnected) buildUnhide(el); });
    if (buildSet.size && !closed) buildTimer = setTimeout(buildSafety, 500);
  }
  function buildClearAll() {
    if (!buildSet) return;
    buildSet.forEach(function (at, el) { try { el.removeAttribute('data-ac-build'); } catch (e) {} });
    buildSet.clear();
    clearTimeout(buildTimer);
    buildTimer = 0;
  }
  function buildKids(el) {
    var out = [], ch = el.children;
    for (var i = 0; ch && i < ch.length && i < 60; i++) if (!/^(?:script|style|template|link)$/.test(ch[i].localName)) out.push(ch[i]);
    return out;
  }
  function startBuild(c, j, t0) {
    var roots = [], i, k, all = j.buildRoots || [];
    j.buildRoots = [];
    for (i = 0; i < all.length; i++) if (all[i].isConnected && buildSet.has(all[i])) roots.push(all[i]);
    if (!roots.length) return;
    var pieces = [], extra = [];
    var put = function (el) { if (pieces.length < BUILD_PIECES) pieces.push(el); else extra.push(el); };
    for (i = 0; i < roots.length; i++) {
      var kids = buildKids(roots[i]);
      if (!kids.length) { put(roots[i]); continue; }
      for (k = 0; k < kids.length; k++) {
        var gk = kids[k].children.length && kids[k].getElementsByTagName('*').length > 6 ? buildKids(kids[k]) : null;
        if (gk && gk.length && pieces.length + gk.length <= BUILD_PIECES) gk.forEach(put); else put(kids[k]);
      }
    }
    var P = [];
    for (i = 0; i < pieces.length; i++) {
      var b = pieces[i].getBoundingClientRect();
      if (b.width < 1 && b.height < 1) { extra.push(pieces[i]); continue; }
      P.push({ el: pieces[i], r: { l: b.left, t: b.top, w: Math.max(b.width, 1), h: Math.max(b.height, 1) }, shown: false });
    }
    P.sort(function (a, z) { return Math.abs(a.r.t - z.r.t) > 8 ? a.r.t - z.r.t : a.r.l - z.r.l; });
    var tnow = Date.now(), hideIt = function (el) {
      if (!buildSet.has(el)) { try { el.setAttribute('data-ac-build', ''); } catch (e) { return; } }
      buildSet.set(el, tnow);
    };
    for (i = 0; i < P.length; i++) hideIt(P[i].el);
    for (i = 0; i < extra.length; i++) hideIt(extra[i]);
    for (i = 0; i < roots.length; i++) {
      var isPiece = false;
      for (k = 0; k < P.length && !isPiece; k++) if (P[k].el === roots[i]) isPiece = true;
      for (k = 0; k < extra.length && !isPiece; k++) if (extra[k] === roots[i]) isPiece = true;
      if (!isPiece) buildUnhide(roots[i]);
    }
    if (!P.length) { for (i = 0; i < extra.length; i++) buildUnhide(extra[i]); return; }
    j.build = { t0: t0, pieces: P, extra: extra, shown: 0, done: false };
    j.buildDur = BUILD_LEAD + P.length * BUILD_STEP + 260;
    if (!buildTimer) buildTimer = setTimeout(buildSafety, 500);
  }
  function endBuild(j) {
    var B = j && j.build;
    if (B && !B.done) {
      B.done = true;
      for (var i = 0; i < B.pieces.length; i++) buildUnhide(B.pieces[i].el);
      for (i = 0; i < B.extra.length; i++) buildUnhide(B.extra[i]);
    }
    if (j && j.buildRoots && j.buildRoots.length) { for (var k = 0; k < j.buildRoots.length; k++) buildUnhide(j.buildRoots[k]); j.buildRoots = []; }
  }
  function buildFx(c, j, t0) {
    var B = j.build, bu = t0 - B.t0, n = B.pieces.length, i;
    var idx = bu < BUILD_LEAD ? -1 : Math.min(n - 1, Math.floor((bu - BUILD_LEAD) / BUILD_STEP));
    for (i = 0; i < n; i++) {
      var p = B.pieces[i];
      if (i <= idx && !p.shown) { p.shown = true; B.shown++; try { p.el.setAttribute('data-ac-build', 'in'); } catch (e) {} }
      var bp = part(c, 'bp' + i, 'bp');
      var fadeOut = p.shown ? 1 - clamp01((t0 - (B.t0 + BUILD_LEAD + i * BUILD_STEP)) / 260) : 1;
      size(bp, p.r.w + 4, p.r.h + 4);
      tfc(c, bp, p.r.l - 2, p.r.t - 2, 1, 1, clamp01(bu / BUILD_LEAD) * fadeOut * 0.95);
    }
    var cur = Math.max(0, idx), nx = Math.min(n - 1, cur + 1);
    var u = idx < 0 ? 0 : ease(clamp01((bu - BUILD_LEAD - cur * BUILD_STEP) / BUILD_STEP));
    var a = B.pieces[cur].r, z = B.pieces[nx].r;
    var pos = { x: lerp(a.l + 6, z.l + 6, u), y: lerp(a.t + 6, z.t + 6, u) };
    if (bu >= j.buildDur) {
      endBuild(j);
      for (i = 0; i < n; i++) hide(part(c, 'bp' + i, 'bp'));
      if (j.arr) j.arr = t0;
    }
    return pos;
  }
  function lcaOf(a, b) {
    for (var x = a, d = 0; x && d < 40; x = x.parentElement, d++) if (x.contains(b)) return x;
    return null;
  }
  function levels(child, anc) {
    for (var x = child, d = 0; x && d < 40; x = x.parentElement, d++) if (x === anc) return d;
    return 99;
  }
  function truthGroups(hits) {
    var groups = [], i, k;
    for (i = 0; i < hits.length; i++) {
      var h = hits[i], el = h.el;
      if (!el.isConnected || recSkip(el)) continue;
      var g = null;
      for (k = 0; k < groups.length; k++) {
        var gr = groups[k];
        if (gr.root === el || gr.root.contains(el) && levels(el, gr.root) <= 2) { g = gr; break; }
        var l = lcaOf(gr.root, el);
        if (l && levels(gr.root, l) <= 2 && levels(el, l) <= 2) { gr.root = l; g = gr; break; }
      }
      if (!g) {
        if (groups.length >= 40) continue;
        g = { root: el, els: [], add: false, cls: false, text: false, rm: false, added: [] };
        groups.push(g);
      }
      if (g.els.indexOf(el) < 0 && g.els.length < 60) g.els.push(el);
      if (h.type === 'add') { g.add = true; if (g.added.length < 12) g.added.push(el); }
      else if (h.type === 'attr') { if (h.name === 'class' || h.name === 'style') g.cls = true; }
      else if (h.type === 'text') g.text = true;
      else if (h.type === 'rm') g.rm = true;
    }
    return groups;
  }
  function scoreTruth(j, g, pred, vw, vh) {
    var s = 0, kind = j.kind, d = j.ev.delta || {}, i, k, root = g.root;
    if (kind === 'add' && g.add) s += 300;
    if (kind === 'text' && d.to) {
      var needle = norm(d.to.replace(/…$/, ''));
      if (needle.length >= 2 && norm(root.textContent || '').indexOf(needle) >= 0) s += 400;
    }
    if (kind !== 'text' && kind !== 'add' && g.cls) {
      s += 200;
      var adds = d.added || [], hit = false;
      for (i = 0; i < adds.length && !hit; i++) {
        if (/[:\s]/.test(adds[i])) continue;
        for (k = 0; k < g.els.length && !hit; k++) if (g.els[k].classList && g.els[k].classList.contains(adds[i])) hit = true;
      }
      if (hit) s += 300;
    }
    if (pred && pred.isConnected) {
      if (root === pred || root.contains(pred) || pred.contains(root)) s += 200;
      else { var l = lcaOf(pred, root); if (l && levels(pred, l) <= 3 && levels(root, l) <= 3) s += 100; }
    }
    var hp = kind === 'add' && j.ev.next && j.ev.next.path ? j.ev.next.path : (j.ev.hint || {}).path;
    if (hp) s += Math.min(150, pathScore(root, hp));
    var b = root.getBoundingClientRect();
    if (b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw && (b.width > 0 || b.height > 0)) s += 50;
    if (root === D.body || root.localName === 'main' || b.width * b.height > vw * vh * 0.6) s -= 300;
    g.score = s;
    g.cx = b.left + b.width / 2; g.cy = b.top + b.height / 2;
    return s;
  }
  function retargetTo(c, j, el, truth) {
    var t = j.target, b = el.getBoundingClientRect();
    t.el = el; t.node = null; t.s = 0; t.e = 0; t.mode = 'el'; t.bgEl = null;
    if (b.width > 0 || b.height > 0) t.goal = { l: b.left, t: b.top, w: Math.max(b.width, 1), h: Math.max(b.height, 1) };
    if (!t.rect && t.goal) t.rect = { l: t.goal.l, t: t.goal.t, w: t.goal.w, h: t.goal.h };
    j.truth = truth;
    j.retarget = true;
    j.scrolled = false;
    if (j.kind === 'add') j.nextDone = true;
  }
  function pickTruth(c, j, t0) {
    var rec = j.rec;
    if (!rec || rec.over || !rec.hits.length || rec.last === rec.evalAt || t0 - rec.last < 120) return false;
    rec.evalAt = rec.last;
    var vw = W.innerWidth, vh = W.innerHeight, pred = j.target.el, R = j.target.rect;
    var groups = truthGroups(rec.hits);
    if (!groups.length) return false;
    var px = R ? R.l + R.w / 2 : vw / 2, py = R ? R.t + R.h / 2 : vh / 2, i;
    for (i = 0; i < groups.length; i++) scoreTruth(j, groups[i], pred, vw, vh);
    groups.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return (Math.abs(a.cx - px) + Math.abs(a.cy - py)) - (Math.abs(b.cx - px) + Math.abs(b.cy - py));
    });
    var best = groups[0];
    if (best.score < TRUTH_MIN) return false;
    var roots = [], added = [];
    for (i = 0; i < groups.length && roots.length < 12; i++) {
      if (groups[i].score < TRUTH_MIN) break;
      roots.push(groups[i].root);
      added = added.concat(groups[i].added);
    }
    retargetTo(c, j, best.root, { roots: roots, added: added.slice(0, 24) });
    if (j.kind === 'add') {
      for (i = 1; i < groups.length && i < maxCursors; i++) {
        var gr = groups[i];
        if (gr.score < TRUTH_MIN || !gr.add) break;
        (function (el, n) {
          var copy = Object.assign({}, j.ev, { id: j.ev.id + ':truth:' + n, gate: false, paintAck: false, sent: false, next: null, __acTruth: true });
          setTimeout(function () { if (!closed && el.isConnected) enqueueDom(copy, now(), { el: el }); }, n * 75);
        })(gr.root, i);
      }
    }
    return true;
  }

  function snapVal(el, props) {
    if (!el.isConnected) return 'gone';
    var out = '';
    try {
      var cs = W.getComputedStyle(el);
      for (var i = 0; i < props.length; i++) out += cs.getPropertyValue(props[i]) + '|';
    } catch (e) {}
    var b = el.getBoundingClientRect();
    return out + Math.round(b.width) + 'x' + Math.round(b.height);
  }
  function takeCssSnap(j) {
    var ev = j.ev, h = ev.hint || {};
    if (!ev.cssProps.length && !h.selector) return;
    var els = [], i, list;
    if (h.selector) { try { list = D.querySelectorAll(h.selector); for (i = 0; i < list.length && els.length < 60; i++) els.push(list[i]); } catch (e) {} }
    else els = findStrict(h, null, null, 60);
    if (j.target.el && els.indexOf(j.target.el) < 0) els.unshift(j.target.el);
    if (!els.length) return;
    var props = SIG_PROPS.slice();
    for (i = 0; i < ev.cssProps.length; i++) if (props.indexOf(ev.cssProps[i]) < 0) props.push(ev.cssProps[i]);
    var items = [];
    for (i = 0; i < els.length; i++) items.push({ el: els[i], v: snapVal(els[i], props) });
    j.cssSnap = { props: props, items: items };
  }
  function cssSnapPick(j) {
    var snap = j.cssSnap, t = j.target, R = t.rect, vw = W.innerWidth, vh = W.innerHeight;
    var px = R ? R.l + R.w / 2 : vw / 2, py = R ? R.t + R.h / 2 : vh / 2, best = null, bestD = Infinity, changed = [];
    for (var i = 0; i < snap.items.length; i++) {
      var it = snap.items[i];
      if (!it.el.isConnected) continue;
      var v = snapVal(it.el, snap.props);
      if (v === it.v) continue;
      changed.push(it.el);
      if (it.el === t.el) return { el: it.el, changed: changed };
      var b = it.el.getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) continue;
      var vis = b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw;
      var dd = Math.abs(b.left + b.width / 2 - px) + Math.abs(b.top + b.height / 2 - py) + (vis ? 0 : 100000);
      if (dd < bestD) { bestD = dd; best = it.el; }
    }
    return best ? { el: best, changed: changed } : null;
  }
  var daemonProto = 0;
  function setWatchState(c, j, st, t0) {
    var w = j.watch;
    w.state = st;
    w.at = t0;
    if (st === 'gray') c.labelText = c.baseLabel + ' · uygulanmadı';
    else if (st === 'error') c.labelText = '⚠ derleme hatası · ' + baseName(j.ev.file);
    else c.labelText = c.baseLabel;
    kick();
  }
  function reacquire(j) {
    var t = j.target, h = j.ev.hint || {}, d = j.ev.delta || {}, found = null;
    if (j.kind === 'text' && d.to) found = resolveTarget({ id: h.id, classes: h.classes || [], tag: h.tag, text: d.to.replace(/…$/, '') });
    if (!found) {
      var ah = afterHint(j.ev);
      found = hasHint(ah) ? resolveTarget(ah) : null;
      if (found && !isStrongMatch(ah, found)) found = null;
    }
    if (!found && t.rect && D.elementFromPoint) {
      var e = D.elementFromPoint(t.rect.l + t.rect.w / 2, t.rect.t + Math.min(t.rect.h / 2, 20));
      if (e && e !== host && e !== D.body && e !== D.documentElement) found = { el: e };
    }
    if (found) { t.el = found.el; t.node = found.node || null; t.mode = 'el'; t.bgEl = null; }
  }
  function checkWatch(c, j, t0) {
    var w = j.watch;
    if (!w || w.state === 'done' || w.state === 'arrived' || t0 < w.next) return;
    w.next = t0 + 100;
    var lvl = errLevel();
    if (lvl > w.err0) { if (w.state !== 'error') setWatchState(c, j, 'error', t0); return; }
    if (w.state === 'error') { setWatchState(c, j, 'wait', t0); w.from = t0; w.err0 = lvl; }
    if (j.kind === 'add' && j.nextDone) { arrive(c, j, t0, true); return; }
    var t = j.target;
    if (j.kind === 'remove') {
      if (!t.el || !t.el.isConnected || !isVisible(t.el)) { arrive(c, j, t0, true); return; }
    } else if (t.el && !t.el.isConnected) reacquire(j);
    var sigChanged = sigOf(t.el, w) !== w.sig;
    if (sigChanged && j.kind === 'add' && !j.nextDone && j.rec && !j.rec.over && j.rec.hits.length) {
      if (pickTruth(c, j, t0)) { arrive(c, j, t0, true); return; }
      if (!w.addWait) w.addWait = t0;
      if (t0 - w.addWait < 400) return;
    }
    if (sigChanged) { arrive(c, j, t0, true); return; }
    if (j.kind !== 'remove') {
      var cp = j.cssSnap ? cssSnapPick(j) : null;
      if (cp) {
        if (cp.el !== t.el) retargetTo(c, j, cp.el, { roots: cp.changed.slice(0, 12), added: [] });
        arrive(c, j, t0, true);
        return;
      }
      if (pickTruth(c, j, t0)) { arrive(c, j, t0, true); return; }
    }
    var quiet = j.ev.anchor === 'component' || j.ev.lead;
    if (w.state === 'wait' && j.applied && t0 - Math.max(j.applied, w.from) > APPLIED_QUIET) { arrive(c, j, t0, false); return; }
    if (w.state === 'wait' && daemonProto >= 4 && !j.applied && !quiet && t0 - w.from > NOT_APPLIED_MS) setWatchState(c, j, 'gray', t0);
    else if (w.state === 'wait' && quiet && t0 - w.from > WATCH_MAX) w.state = 'done';
  }
  function arrive(c, j, t0, full) {
    var w = j.watch, t = j.target;
    if (w) {
      if (w.state === 'gray' || w.state === 'error') c.labelText = c.baseLabel;
      w.state = full ? 'arrived' : 'done';
      w.at = t0;
    }
    j.arr = t0;
    j.arrFull = !!full;
    if (!full && j.ev.hint && j.ev.hint.selState && w) c.labelText = c.baseLabel + ' · :' + j.ev.hint.selState;
    if (j.buildRoots && j.buildRoots.length && !j.build) startBuild(c, j, t0);
    if (full && t.el && t.el.isConnected) {
      var b = t.el.getBoundingClientRect();
      if (b.width > 0 || b.height > 0) t.goal = { l: b.left, t: b.top, w: Math.max(b.width, 1), h: Math.max(b.height, 1) };
      t.bgEl = null;
      if (j.kind === 'text') {
        if (t.node && !t.node.isConnected) t.node = null;
        t.lines = readLines(t, t.goal || t.rect);
        var bg = bgOf(t.el), txt = (j.ev.delta && j.ev.delta.to) || '';
        j.cover = !RM && bg && !bg.img && bg.css ? bg.css : '';
        j.typeDur = RM || !txt ? 0 : clamp(txt.length * 30, 320, 900);
      }
      if (j.sty) refreshSwatches(j, t.el);
    }
    if (j.kind !== 'read' && j.kind !== 'remove') addMark(j.ev, t.el, c.pal);
    kick();
  }
  function onApplied(d) {
    var ids = d && Array.isArray(d.ids) ? d.ids : [];
    if (!ids.length) return;
    var t0 = now(), files = {};
    for (var i = 0; i < cursors.length; i++) {
      var c = cursors[i], j = c.job;
      if (!j || ids.indexOf(String(j.ev.id).split(':')[0]) < 0) continue;
      j.applied = t0;
      if (!files[j.ev.file]) { files[j.ev.file] = 1; noHmrApply(j.ev.file); }
      if (j.watch && j.watch.state === 'gray') { setWatchState(c, j, 'wait', t0); j.watch.from = t0; }
    }
  }

  var marksOn = false, marks = [], marksTimer = 0, marksLoaded = false, markPals = {};
  function markColor(ev) {
    if (!ev.session) return '#38bdf8';
    if (!markPals[ev.session]) markPals[ev.session] = makePal(sessionHue(ev.session), 72, 48, 'm').c;
    return markPals[ev.session];
  }
  function addMark(ev, el, pal) {
    if (!ev || ev.kind === 'read' || !ev.file) return;
    var m = { ev: ev, el: el || null, col: pal ? pal.c : markColor(ev), tryAt: 0 };
    for (var i = 0; i < marks.length; i++) if (el && marks[i].el === el) { marks.splice(i, 1); break; }
    marks.push(m);
    if (marks.length > 300) marks.shift();
    if (marksOn) kick();
  }
  function markEl(m) {
    if (m.el && m.el.isConnected) return m.el;
    if (m.ev.kind === 'remove') return null;
    var t = Date.now();
    if (t - m.tryAt < 1000) return null;
    m.tryAt = t;
    var h = afterHint(m.ev), f = hasHint(h) ? resolveTarget(h) : null;
    var el = f && isStrongMatch(h, f) ? f.el : findStrict(h, null, null, 1)[0] || null;
    m.el = el;
    return el && el.isConnected ? el : null;
  }
  function loadMarks() {
    if (marksLoaded || !W.fetch) return;
    marksLoaded = true;
    W.fetch(BASE + '/history?limit=200', { mode: 'cors' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (body) {
        var list = body && Array.isArray(body.events) ? body.events : [], seen = {};
        for (var i = 0; i < marks.length; i++) seen[marks[i].ev.id] = 1;
        var older = [];
        for (i = 0; i < list.length; i++) {
          var raw = list[i] && list[i].event;
          if (!raw || (raw.surface && raw.surface !== 'dom') || typeof raw.file !== 'string' || raw.kind === 'read' || seen[raw.id]) continue;
          var ev = sanitize(raw);
          older.push({ ev: ev, el: null, col: markColor(ev), tryAt: 0 });
        }
        marks = older.concat(marks).slice(-300);
        kick();
      }).catch(function () {});
  }
  function setMarks(on, quiet) {
    marksOn = !!on;
    try { W.localStorage.setItem('agent-cursors-marks', marksOn ? '1' : '0'); } catch (e) {}
    clearInterval(marksTimer);
    marksTimer = 0;
    if (marksOn) {
      loadMarks();
      marksTimer = setInterval(function () { if (!D.hidden) kick(); }, 700);
    }
    if (!quiet) hud.note(marksOn ? 'Değişenler katmanı açık (Alt+Shift+C)' : 'Değişenler katmanı kapalı', '#38bdf8');
    kick();
    return marksOn;
  }
  function onKey(e) {
    if (!e || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code !== 'KeyC' && e.key !== 'C' && e.key !== 'c' && e.key !== 'Ç' && e.key !== 'ç') return;
    setMarks(!marksOn);
    try { e.preventDefault(); } catch (er) {}
  }
  function drawMarks(dpr) {
    var vw = W.innerWidth, vh = W.innerHeight, seen = [];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var i = marks.length - 1; i >= 0; i--) {
      var m = marks[i], el = markEl(m);
      if (!el || seen.indexOf(el) >= 0) continue;
      seen.push(el);
      var r = el.getBoundingClientRect();
      if ((r.width <= 0 && r.height <= 0) || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      g.globalAlpha = 0.9;
      g.fillStyle = m.col;
      rr(g, Math.max(1, r.left - 6), r.top, 3, Math.max(4, r.height), 1.5);
      g.fill();
      g.beginPath(); g.arc(Math.min(vw - 5, r.right), Math.max(5, r.top), 3.5, 0, TAU); g.fill();
      g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    }
    g.globalAlpha = 1;
  }

  function firstLine(t, R) {
    return (t.lines && t.lines[0]) || { l: R.l, t: R.t, w: R.w, h: Math.min(R.h, 22) };
  }
  function lastLine(t, R) {
    return (t.lines && t.lines[t.lines.length - 1]) || firstLine(t, R);
  }
  function startAnchor(kind, R, t) {
    switch (kind) {
      case 'resize': return { x: R.l + R.w, y: R.t + R.h };
      case 'text': var f = firstLine(t, R); return { x: f.l, y: f.t + f.h / 2 };
      case 'add': return { x: R.l, y: R.t };
      case 'edit': return { x: R.l + Math.min(14, R.w / 2) + 12, y: R.t + R.h / 2 + 8 };
      default: return { x: R.l + R.w / 2, y: R.t + R.h / 2 };
    }
  }
  function endAnchor(kind, R, t) {
    switch (kind) {
      case 'resize': case 'add': return { x: R.l + R.w, y: R.t + R.h };
      case 'text': var l = lastLine(t, R); return { x: l.l + l.w, y: l.t + l.h / 2 };
      default: return startAnchor(kind, R, t);
    }
  }

  var ACTS = {
    resize: function (c, j, p, R) {
      var g = part(c, 'ghost', 'ghost');
      size(g, R.w, R.h);
      var sx, sy, a, vis, sz = j.ev.delta && j.ev.delta.size;
      if (sz) {
        var tx = sz.w > 0 ? 1.16 : sz.w < 0 ? 0.8 : 1, ty = sz.h > 0 ? 1.14 : sz.h < 0 ? 0.82 : 1;
        a = ease(seg(p, 0.12, 0.78));
        sx = lerp(1, tx, a); sy = lerp(1, ty, a); vis = 1;
        if (j.arr && p >= 1) {
          var au = j.now - j.arr, k = ease(clamp01(au / 320));
          sx = lerp(tx, 1, k); sy = lerp(ty, 1, k); vis = 1 - seg(au, 420, 760);
        }
      } else {
        if (p < 0.12) { sx = 1; sy = 1; }
        else if (p < 0.5) { a = ease(seg(p, 0.12, 0.5)); sx = lerp(1, 0.78, a); sy = lerp(1, 0.84, a); }
        else if (p < 0.86) { a = ease(seg(p, 0.5, 0.86)); sx = lerp(0.78, 1.14, a); sy = lerp(0.84, 1.1, a); }
        else { a = ease(seg(p, 0.86, 1)); sx = lerp(1.14, 1, a); sy = lerp(1.1, 1, a); }
        vis = p < 0.94 ? 1 : 1 - seg(p, 0.94, 1);
      }
      tfc(c, g, R.l, R.t, sx, sy, vis);
      var cw = R.w * sx, ch = R.h * sy, pts = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (var i = 0; i < 4; i++) {
        var hd = part(c, 'h' + i, 'handle');
        tfc(c, hd, R.l + pts[i][0] * cw - 4.5, R.t + pts[i][1] * ch - 4.5, 1, 1, vis);
      }
      return { x: R.l + cw, y: R.t + ch, s: p > 0.12 && p < 0.9 ? 0.86 : 1, fm: vis > 0.5 ? 0.55 : 1 };
    },

    text: function (c, j, p, R, t) {
      var L = t.lines && t.lines.length ? t.lines : [firstLine(t, R)];
      var total = 0, i;
      for (i = 0; i < L.length; i++) total += L[i].w;
      var want = ease(seg(p, 0.1, 0.78)) * total, acc = 0;
      var cx = L[0].l, cy = L[0].t + L[0].h / 2;
      for (i = 0; i < 6; i++) {
        var sel = part(c, 's' + i, 'sel');
        if (i >= L.length) { hide(sel); continue; }
        var ln = L[i], f = clamp01((want - acc) / Math.max(ln.w, 1));
        size(sel, ln.w, ln.h);
        var blink = p > 0.8 && p < 1 ? 0.75 + 0.25 * Math.sin((p - 0.8) * 60) : 1;
        tfc(c, sel, ln.l, ln.t, Math.max(f, 0.0001), 1, f > 0 ? blink : 0);
        if (f > 0) { cx = ln.l + ln.w * f; cy = ln.t + ln.h / 2; }
        acc += ln.w;
      }
      return { x: cx, y: cy, s: 1, fm: p < 1 ? 0.6 : 1 };
    },

    style: function (c, j, p, R) {
      var sty = j.sty, extras = !!sty && (sty.swatches.length > 0 || !!sty.space || sty.radius);
      var cx = R.l + R.w / 2, cy = R.t + R.h / 2;
      var clicks = extras ? [[0.12, 0.48]] : [[0.18, 0.5], [0.55, 0.87]], press = 1, wash = 0;
      j.guideA = extras && (sty.space || sty.radius) ? seg(p, 0.3, 0.55) : 0;
      if (extras && sty.radius && !sty.space) {
        var ku = ease(seg(p, 0.35, 0.7)), rr0 = sty.gd ? sty.gd.cur.r : 0;
        cx = lerp(cx, R.l + Math.max(8, rr0 * 0.6), ku); cy = lerp(cy, R.t + Math.max(8, rr0 * 0.6), ku);
      }
      for (var i = 0; i < 2; i++) {
        var a = clicks[i] ? clicks[i][0] : 2, b = clicks[i] ? clicks[i][1] : 3, u = seg(p, a, b);
        var ring = part(c, 'r' + i, 'ring');
        if (u > 0 && u < 1) {
          var sc = lerp(0.15, 1.15, 1 - Math.pow(1 - u, 3));
          tfc(c, ring, cx - 60, cy - 60, sc, sc, (1 - u) * 0.7);
          wash = Math.max(wash, 0.22 * Math.sin(Math.PI * u));
        } else hide(ring);
        var pu = seg(p, a - 0.06, a + 0.08);
        if (pu > 0 && pu < 1) press = Math.min(press, 1 - 0.18 * Math.sin(Math.PI * pu));
      }
      var w = part(c, 'wash', 'wash');
      size(w, R.w, R.h);
      tfc(c, w, R.l, R.t, 1, 1, wash);
      return { x: cx, y: cy, s: press, fm: 1 };
    },

    add: function (c, j, p, R) {
      var d = ease(seg(p, 0.05, 0.55)), dd = Math.max(d, 0.0001);
      var g = part(c, 'ghost', 'ghost');
      size(g, R.w, R.h);
      tfc(c, g, R.l, R.t, dd, dd, p > 0.04 ? (p < 0.88 ? 1 : 1 - seg(p, 0.88, 1)) : 0);
      var w = part(c, 'wash', 'wash');
      size(w, R.w, R.h);
      tfc(c, w, R.l, R.t, 1, 1, 0.3 * Math.sin(Math.PI * seg(p, 0.55, 0.95)));
      var b = part(c, 'badge', 'badge');
      var u = seg(p, 0.55, 0.72), cx = R.l + R.w / 2, cy = R.t + R.h / 2;
      var bs = u > 0 ? 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2) : 0;
      tfc(c, b, cx - 14, cy - 14, bs, bs, u > 0 ? (p < 0.9 ? 1 : 1 - seg(p, 0.9, 1)) : 0);
      return { x: R.l + R.w * d, y: R.t + R.h * d, s: p > 0.05 && p < 0.55 ? 0.9 : 1, fm: p < 0.55 ? 0.5 : 1 };
    },

    remove: function (c, j, p, R) {
      var cx = R.l + R.w / 2, cy = R.t + R.h / 2;
      var xin = ease(seg(p, 0.05, 0.25));
      var flick = p < 0.45 ? 0.7 + 0.3 * Math.sin(p * 38) : 1;
      var xs = lerp(0.4, 1, xin);
      var xm = part(c, 'x', 'xmark');
      tfc(c, xm, cx - 17, cy - 17, xs, xs, xin * flick * (1 - seg(p, 0.82, 1)) * 0.9);
      var gh = part(c, 'ghost', 'ghost');
      size(gh, R.w, R.h);
      var gs = Math.max(1 - ease(seg(p, 0.45, 0.92)), 0.0001);
      var gv = seg(p, 0.3, 0.45) * (1 - seg(p, 0.7, 0.95)) * 0.9;
      tfc(c, gh, cx - R.w * gs / 2, cy - R.h * gs / 2, gs, gs, gv);
      var pu = seg(p, 0.3, 0.42);
      return { x: cx, y: cy, s: pu > 0 && pu < 1 ? 1 - 0.16 * Math.sin(Math.PI * pu) : 1, fm: 1 - seg(p, 0.45, 0.7) };
    },

    edit: function (c, j, p, R) {
      var cx = R.l + Math.min(14, R.w / 2), cy = R.t + R.h / 2;
      var car = part(c, 'caret', 'caret');
      tfc(c, car, cx, cy - 9, 1, 1, p >= 1 || Math.floor(p * 8) % 2 === 0 ? 1 : 0);
      var w = part(c, 'wash', 'wash');
      size(w, R.w, R.h);
      tfc(c, w, R.l, R.t, 1, 1, 0.2 * Math.sin(Math.PI * clamp01(p)));
      return { x: cx + 12 + (p < 1 ? Math.sin(p * 34) * 2.2 : 0), y: cy + 8, s: 1, fm: 1 };
    },

    read: function (c, j, p, R) {
      var u = ease(p), lx = R.l + Math.min(16, R.w * 0.1), rx = R.l + Math.max(Math.min(R.w - 16, R.w * 0.7), Math.min(16, R.w * 0.1));
      var y0 = R.t + Math.min(R.h * 0.35, 26);
      return { x: lerp(lx, rx, u), y: y0 + (RM ? 0 : Math.sin(p * Math.PI * 2) * 3), s: 1, fm: 0.6 };
    }
  };

  function arrivalFx(c, j, t0, R) {
    var au = t0 - j.arr, vw = W.innerWidth, vh = W.innerHeight;
    var ck = part(c, 'check', 'check');
    var pu = clamp01(au / 260), sc = RM ? 1 : pu < 1 ? 1 + 2.70158 * Math.pow(pu - 1, 3) + 1.70158 * Math.pow(pu - 1, 2) : 1;
    sc = Math.max(sc, 0.0001);
    tfc(c, ck, clamp(R.l + R.w - 11, 4, vw - 26), clamp(R.t - 11, 4, vh - 26), sc, sc, RM ? pu : 1);
    var sh = part(c, 'shine', 'shine');
    if (j.arrFull && !RM && au < 760) { size(sh, R.w, R.h); sh.u = au / 760; tfc(c, sh, R.l, R.t, 1, 1, 1); }
    else hide(sh);
  }

  function typeFx(c, j, t0, t, R) {
    var L = t.lines && t.lines.length ? t.lines : [firstLine(t, R)], total = 0, i;
    for (i = 0; i < L.length; i++) total += L[i].w;
    var tu = clamp01((t0 - j.arr) / j.typeDur), want = tu * total, acc = 0;
    var cx = L[0].l, cy = L[0].t + L[0].h / 2;
    for (i = 0; i < 6; i++) {
      hide(part(c, 's' + i, 'sel'));
      var cov = part(c, 'v' + i, 'cover');
      if (i >= L.length) { hide(cov); continue; }
      var ln = L[i], f = clamp01((want - acc) / Math.max(ln.w, 1));
      if (j.cover && f < 1) {
        cov.col = j.cover;
        size(cov, ln.w * (1 - f) + 2, ln.h + 2);
        tfc(c, cov, ln.l + ln.w * f, ln.t - 1, 1, 1, 1);
      } else hide(cov);
      if (want > acc || i === 0) { cx = ln.l + ln.w * f; cy = ln.t + ln.h / 2; }
      acc += ln.w;
    }
    var car = part(c, 'caret', 'caret');
    tfc(c, car, cx, cy - 9, 1, 1, tu < 1 || Math.floor((t0 - j.arr) / 260) % 2 === 0 ? 1 : 0);
    return { x: cx, y: cy };
  }

  function writeCursor(c, t0, dt) {
    var j = c.job;
    if (!j) return;
    var t = j.target, R = t.rect;
    if (!R) return;
    if (t.goal && t.goal !== R) {
      var sk = 1 - Math.exp(-dt / 80);
      R.l += (t.goal.l - R.l) * sk; R.t += (t.goal.t - R.t) * sk;
      R.w += (t.goal.w - R.w) * sk; R.h += (t.goal.h - R.h) * sk;
    }
    smoothGuides(j, dt);
    j.now = t0;
    var vw = W.innerWidth, vh = W.innerHeight;
    var kind = j.kind, actDur = j.ad, TR = j.tr, tEnd = TR + actDur;
    var el = t0 - j.t0, q = el - tEnd, w = j.watch;

    if (!j.ev.gate && !j.arr && el >= tEnd && kind !== 'read') arrive(c, j, t0, (j.ev.__acTruth === true || j.ev.__acFp === true) && !!t.el && t.el.isConnected);

    var fadeAt = j.t0 + tEnd + (kind === 'read' ? READ_IDLE : IDLE);
    if (w) {
      if (w.state === 'wait') fadeAt = Math.max(fadeAt, Math.min(t0 + 32, w.from + WATCH_MAX));
      else if (w.state === 'error') fadeAt = Math.max(fadeAt, Math.min(t0 + 32, w.at + ERROR_MAX));
      else if (w.state === 'gray') fadeAt = w.at + GRAY_HOLD;
    }
    if (j.arr) fadeAt = Math.max(fadeAt, j.arr + ARRIVE_HOLD + j.typeDur);
    if (!j.ev.gate && !j.build && j.buildRoots.length && el >= TR) startBuild(c, j, t0);
    var building = !!(j.build && !j.build.done);
    if (building) fadeAt = Math.max(fadeAt, t0 + 32);
    var ga = 1;
    if (c.evict) ga = 1 - (t0 - c.evict) / EVICT;
    if (t0 > fadeAt) ga *= 1 - (t0 - fadeAt) / OUT;
    if (ga <= 0.001) { c.dead = true; return; }

    var off = R.t + R.h < 0 ? 'top' : R.t > vh ? 'bottom' : R.l + R.w < 0 ? 'left' : R.l > vw ? 'right' : '';
    var offGoal = off && el > TR * 0.6 ? 1 : 0;
    c.offA += (offGoal - c.offA) * (RM ? 1 : Math.min(1, dt / 140));
    if (!offGoal && c.offA < 0.01) c.offA = 0;
    if (off) c.off = off; else if (!c.offA) c.off = '';
    c.gaBase = ga;
    ga *= 1 - c.offA;
    c.ga = ga;

    var st = w ? w.state : '';
    var basePal = st === 'gray' ? GRAY_PAL : st === 'error' ? RED_PAL : c.pal;
    c.dpal = c.dark ? basePal.dark : basePal;

    var x, y, s = 1, fop = 0, res, op = 1, hm = t.mode === 'hint' ? 0.7 : 1;
    if (kind === 'read') { op = 0.55; hm *= 0.45; }
    if (st === 'gray') op *= 0.75;

    if (el < TR) {
      var u = RM ? clamp01(el / TR) : ease(el / TR);
      var a = startAnchor(kind, R, t);
      var P0 = j.p0, P2 = { x: clamp(a.x, 6, vw - 6), y: clamp(a.y, 6, vh - 6) };
      if (RM) { x = lerp(P0.x, P2.x, u); y = lerp(P0.y, P2.y, u); }
      else {
        var dx = P2.x - P0.x, dy = P2.y - P0.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var k = Math.min(0.28 * dist, 160) * j.dir;
        var cx = (P0.x + P2.x) / 2 - dy / dist * k, cy = (P0.y + P2.y) / 2 + dx / dist * k;
        var iu = 1 - u;
        x = iu * iu * P0.x + 2 * iu * u * cx + u * u * P2.x;
        y = iu * iu * P0.y + 2 * iu * u * cy + u * u * P2.y;
      }
      if (c.fresh) op *= Math.min(1, el / 240);
      fop = seg(el / TR, 0.45, 1) * hm;
    } else if (el < tEnd) {
      res = ACTS[kind](c, j, (el - TR) / actDur, R, t);
      x = res.x; y = res.y; s = res.s;
      fop = hm * res.fm;
    } else {
      res = ACTS[kind](c, j, 1, R, t);
      var fl = RM ? 0 : Math.min(1, q / 400);
      x = res.x + Math.sin(t0 / 650 + c.slot) * 3 * fl;
      y = res.y + Math.cos(t0 / 830 + c.slot * 1.7) * 3 * fl;
      s = res.s;
      fop = 0.85 * hm * res.fm;
    }

    if (building) {
      var bfx = buildFx(c, j, t0);
      x = bfx.x; y = bfx.y; s = 1;
      hide(part(c, 'check', 'check')); hide(part(c, 'shine', 'shine'));
      fop = Math.max(fop, 0.5 * hm);
    } else if (j.arr) {
      arrivalFx(c, j, t0, R);
      var au = t0 - j.arr;
      if (kind === 'text' && j.arrFull && j.typeDur) { var tp = typeFx(c, j, t0, t, R); x = tp.x; y = tp.y; }
      if (j.arrFull && !RM) {
        var bu = clamp01(au / 340);
        y -= 6 * Math.sin(Math.PI * bu);
        s *= 1 + 0.08 * Math.sin(Math.PI * bu);
      }
      fop = Math.max(fop, 0.85 * hm * (1 + 0.15 * (1 - clamp01(au / 500))));
    } else { hide(part(c, 'check', 'check')); hide(part(c, 'shine', 'shine')); }
    var wn = part(c, 'warn', 'warn');
    if (st === 'error') tfc(c, wn, clamp(R.l + R.w - 12, 4, vw - 28), clamp(R.t - 11, 4, vh - 26), 1, 1, 1);
    else hide(wn);
    var bubA = el < TR ? 0 : seg(el, TR + actDur * 0.05, TR + actDur * 0.2);
    if (kind === 'text' && j.arr) bubA *= 1 - seg(t0, j.arr + j.typeDur + 900, j.arr + j.typeDur + 1300);
    j.bubA = bubA;

    if (c.fresh && el > 240) c.fresh = false;
    x = clamp(x, 6, vw - 6);
    y = clamp(y, 6, vh - 6);

    var fr = part(c, 'frame', 'frame');
    if (fop > 0.01) {
      size(fr, R.w + 6, R.h + 6);
      tfc(c, fr, R.l - 3, R.t - 3, 1, 1, Math.min(1, fop));
    } else hide(fr);

    var mx = x - c.x, my = y - c.y;
    if (!RM && mx * mx + my * my > 0.09) {
      c.hist.unshift({ x: x, y: y });
      if (c.hist.length > HIST) c.hist.pop();
      c.trailA = Math.min(1, c.trailA + 0.2);
    } else c.trailA = RM ? 0 : Math.max(0, c.trailA - 0.05);
    c.x = x; c.y = y;

    for (var i = 0; i < TRAIL; i++) {
      var d = c.dots[i], hp = c.hist[i * 2 + 1];
      if (!hp || c.trailA <= 0.01) { hide(d); continue; }
      var f = 1 - i / TRAIL;
      tf(d, hp.x - 4, hp.y - 4, f, f, 0.5 * f * c.trailA * ga);
    }
    var flip = x > vw - 200 ? '1' : '0';
    c.flip = flip;
    tf(c.root, x, y, s, s, op * ga);
    if (!c.evict && c.offA < 0.5 && op * ga > 0.3) lastPos[c.sess] = { x: x, y: y, t: t0 };
  }

  var TAU = Math.PI * 2, DASH = [6, 4], BP_DASH = [4, 3], NODASH = [];
  var cvW = 0, cvH = 0, cvDpr = 0, cvOn = false;
  var ARROW_P = null, IBEAM_P = null, XMARK_P = null;

  function paths() {
    if (!ARROW_P && typeof W.Path2D === 'function') {
      ARROW_P = new W.Path2D(ARROW_D);
      IBEAM_P = new W.Path2D(IBEAM_D);
      XMARK_P = new W.Path2D('M7 7L27 27M27 7L7 27');
    }
    return !!ARROW_P;
  }

  function fitCanvas() {
    var dpr = Math.min(W.devicePixelRatio || 1, 2), w = W.innerWidth, h = W.innerHeight;
    if (cvOn && w === cvW && h === cvH && dpr === cvDpr) return;
    cvW = w; cvH = h; cvDpr = dpr; cvOn = true;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.style.display = 'block';
  }

  function sleepCanvas() {
    if (!cvOn) return;
    cvOn = false;
    cv.width = 0; cv.height = 0;
    cv.style.display = 'none';
  }

  function rr(x2, x, y, w, h, r) {
    w = Math.max(0, w); h = Math.max(0, h);
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    x2.beginPath();
    x2.moveTo(x + r, y);
    x2.arcTo(x + w, y, x + w, y + h, r);
    x2.arcTo(x + w, y + h, x, y + h, r);
    x2.arcTo(x, y + h, x, y, r);
    x2.arcTo(x, y, x + w, y, r);
    x2.closePath();
  }

  function place(e, dpr) {
    var x = e.x, y = e.y;
    if (e.mid) { x += e.w / 2 * (1 - e.sx); y += e.h / 2 * (1 - e.sy); }
    g.setTransform(dpr * e.sx, 0, 0, dpr * e.sy, dpr * x, dpr * y);
  }

  function drawPart(e, pal, dpr) {
    if (!(e.o > 0.004)) return;
    var w = e.w, h = e.h;
    place(e, dpr);
    g.globalAlpha = e.o;
    switch (e.cls) {
      case 'frame':
        rr(g, 1, 1, w - 2, h - 2, 4);
        g.fillStyle = pal.s; g.fill();
        g.lineWidth = 4; g.strokeStyle = pal.k; g.stroke();
        g.setLineDash(DASH); g.lineWidth = 2; g.strokeStyle = pal.c; g.stroke(); g.setLineDash(NODASH);
        break;
      case 'check':
        g.beginPath(); g.arc(11, 11, 10, 0, TAU); g.fillStyle = pal.c; g.fill();
        g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
        g.beginPath(); g.moveTo(6.5, 11.4); g.lineTo(9.7, 14.5); g.lineTo(15.6, 8.2);
        g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); g.lineCap = 'butt'; g.lineJoin = 'miter';
        break;
      case 'warn':
        g.beginPath(); g.moveTo(12, 1.5); g.lineTo(23, 20.5); g.lineTo(1, 20.5); g.closePath();
        g.fillStyle = pal.c; g.fill(); g.lineWidth = 1.6; g.lineJoin = 'round'; g.strokeStyle = '#fff'; g.stroke(); g.lineJoin = 'miter';
        g.fillStyle = '#fff'; g.fillRect(11, 7.5, 2, 7); g.fillRect(11, 16, 2, 2);
        break;
      case 'shine':
        var bw = 60, s0 = -bw + (e.u || 0) * (w + h + 2 * bw);
        var gr = g.createLinearGradient((s0 - bw) / 2, (s0 - bw) / 2, (s0 + bw) / 2, (s0 + bw) / 2);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, pal.sh); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.save(); rr(g, 0, 0, w, h, 5); g.clip(); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.restore();
        break;
      case 'cover':
        g.fillStyle = e.col || '#fff'; g.fillRect(0, 0, w, h);
        break;
      case 'bp':
        rr(g, 1, 1, w - 2, h - 2, 4);
        g.fillStyle = pal.s2; g.globalAlpha = e.o * 0.35; g.fill(); g.globalAlpha = e.o;
        g.setLineDash(BP_DASH); g.lineWidth = 1.5; g.strokeStyle = pal.c; g.stroke(); g.setLineDash(NODASH);
        break;
      case 'ghost':
        rr(g, 1, 1, w - 2, h - 2, 4);
        g.fillStyle = pal.s2; g.fill();
        g.lineWidth = 2; g.strokeStyle = pal.c; g.stroke();
        break;
      case 'wash':
        rr(g, 0, 0, w, h, 5); g.fillStyle = pal.c; g.fill();
        break;
      case 'sel':
        rr(g, 0, 0, w, h, 3); g.fillStyle = pal.s3; g.fill();
        break;
      case 'handle':
        rr(g, 1, 1, 7, 7, 1);
        g.fillStyle = '#fff'; g.fill();
        g.lineWidth = 2; g.strokeStyle = pal.c; g.stroke();
        break;
      case 'ring':
        g.beginPath(); g.arc(60, 60, 58.5, 0, TAU);
        g.lineWidth = 3; g.strokeStyle = pal.c; g.stroke();
        break;
      case 'badge':
        g.beginPath(); g.arc(14, 14, 14, 0, TAU); g.fillStyle = pal.c; g.fill();
        g.beginPath(); g.moveTo(14, 8.5); g.lineTo(14, 19.5); g.moveTo(8.5, 14); g.lineTo(19.5, 14);
        g.lineWidth = 3; g.lineCap = 'round'; g.strokeStyle = '#fff'; g.stroke(); g.lineCap = 'butt';
        break;
      case 'xmark':
        g.lineWidth = 4; g.lineCap = 'round'; g.strokeStyle = pal.c; g.stroke(XMARK_P); g.lineCap = 'butt';
        break;
      case 'caret':
        g.fillStyle = pal.c; g.fillRect(0, 0, 2, 18);
        break;
    }
  }

  var TAG_FONT = '700 9px system-ui,-apple-system,"Segoe UI",sans-serif';
  var BUB_FONT = '600 11px system-ui,-apple-system,"Segoe UI",sans-serif';
  function spriteOf(c, dpr) {
    var pal = c.dpal || c.pal;
    var key = c.shape + c.flip + dpr + '|' + c.labelText + '|' + pal.id + '|' + c.agentTag;
    if (c.spr && c.spr.key === key) return c.spr;
    var sp = c.spr || { cv: D.createElement('canvas') };
    var x2 = sp.cv.getContext('2d');
    if (!x2) return null;
    var tag = c.agentTag, tagW = 0;
    if (tag) { x2.font = TAG_FONT; tagW = Math.ceil(x2.measureText(tag).width) + 10; }
    x2.font = LABEL_FONT;
    var text = c.labelText, maxT = 246 - (tagW ? tagW + 4 : 0), tw = text ? x2.measureText(text).width : 0;
    if (tw > maxT) {
      while (text.length > 1 && x2.measureText(text + '…').width > maxT) text = text.slice(0, -1);
      text += '…';
      tw = x2.measureText(text).width;
    }
    var lw = text ? Math.ceil(tw) + 14 + (tagW ? tagW + 4 : 0) : 0, lh = 19;
    var lx = c.flip === '1' ? -13 - lw : 13, ly = 19;
    var minX = Math.min(-12, lx - 6), maxX = Math.max(26, lx + lw + 6), minY = -14, maxY = Math.max(28, ly + lh + 7);
    sp.cv.width = Math.ceil((maxX - minX) * dpr);
    sp.cv.height = Math.ceil((maxY - minY) * dpr);
    x2 = sp.cv.getContext('2d');
    x2.setTransform(dpr, 0, 0, dpr, -minX * dpr, -minY * dpr);
    x2.lineJoin = 'round'; x2.lineCap = 'round';
    if (c.shape === 'i') {
      x2.strokeStyle = '#fff'; x2.lineWidth = 5; x2.stroke(IBEAM_P);
      x2.strokeStyle = pal.c; x2.lineWidth = 2.4; x2.stroke(IBEAM_P);
    } else {
      x2.fillStyle = pal.c; x2.fill(ARROW_P);
      x2.strokeStyle = '#fff'; x2.lineWidth = 1.6; x2.stroke(ARROW_P);
    }
    if (lw) {
      x2.save();
      x2.shadowColor = 'rgba(0,0,0,.35)'; x2.shadowBlur = 4 * dpr; x2.shadowOffsetY = dpr;
      x2.fillStyle = pal.c; rr(x2, lx, ly, lw, lh, 7); x2.fill();
      x2.restore();
      var tx = lx + 7;
      if (tagW) {
        x2.fillStyle = 'rgba(255,255,255,.24)'; rr(x2, lx + 4, ly + 3, tagW, lh - 6, 5); x2.fill();
        x2.fillStyle = '#fff'; x2.font = TAG_FONT; x2.textBaseline = 'middle';
        x2.fillText(tag, lx + 9, ly + lh / 2 + 0.5);
        tx = lx + 4 + tagW + 6;
      }
      x2.fillStyle = '#fff'; x2.font = LABEL_FONT; x2.textBaseline = 'middle';
      x2.fillText(text, tx, ly + lh / 2 + 0.5);
    }
    sp.key = key; sp.ox = minX; sp.oy = minY; sp.w = maxX - minX; sp.h = maxY - minY;
    c.spr = sp;
    return sp;
  }

  function fitText(x2, s, max) {
    if (x2.measureText(s).width <= max) return s;
    while (s.length > 1 && x2.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }
  function bubbleOf(c, j, dpr) {
    var d = j.ev.delta || {}, sw = j.sty && j.sty.swatches.length ? j.sty.swatches : null, key;
    if (j.kind === 'text' && d.from && d.to) key = 't|' + d.from + '|' + d.to;
    else if (sw) { key = 'c'; for (var q = 0; q < sw.length; q++) key += '|' + sw[q].from + '>' + sw[q].to; }
    else return null;
    key += '|' + dpr;
    if (j.bub && j.bub.key === key) return j.bub;
    var sp = j.bub || { cv: D.createElement('canvas') }, x2 = sp.cv.getContext('2d');
    if (!x2) return null;
    var H = 24, pad = 8, i, items = [], W2 = pad;
    x2.font = BUB_FONT;
    if (key.charAt(0) === 't') {
      var a = fitText(x2, '“' + d.from + '”', 110), b = fitText(x2, '“' + d.to + '”', 130);
      items.push({ t: a, w: x2.measureText(a).width, old: true }, { arrow: true, w: 14 }, { t: b, w: x2.measureText(b).width });
    } else {
      for (i = 0; i < sw.length; i++) {
        if (i) items.push({ gap: true, w: 8 });
        items.push({ sw: sw[i].from, w: 14 }, { arrow: true, w: 14 }, { sw: sw[i].to, w: 14 });
      }
    }
    for (i = 0; i < items.length; i++) W2 += items[i].w + (i ? 5 : 0);
    W2 += pad;
    sp.cv.width = Math.ceil(W2 * dpr); sp.cv.height = Math.ceil(H * dpr);
    x2 = sp.cv.getContext('2d');
    x2.setTransform(dpr, 0, 0, dpr, 0, 0);
    x2.fillStyle = 'rgba(15,23,42,.94)'; rr(x2, 0, 0, W2, H, 8); x2.fill();
    x2.lineWidth = 1; x2.strokeStyle = 'rgba(148,163,184,.4)'; x2.stroke();
    x2.font = BUB_FONT; x2.textBaseline = 'middle';
    var x = pad;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (i) x += 5;
      if (it.arrow) {
        x2.strokeStyle = '#94a3b8'; x2.lineWidth = 1.5; x2.lineCap = 'round';
        x2.beginPath(); x2.moveTo(x + 1, H / 2); x2.lineTo(x + 12, H / 2); x2.moveTo(x + 8, H / 2 - 3.5); x2.lineTo(x + 12, H / 2); x2.lineTo(x + 8, H / 2 + 3.5); x2.stroke();
        x2.lineCap = 'butt';
      } else if (it.t !== undefined) {
        x2.fillStyle = it.old ? '#94a3b8' : '#f8fafc';
        x2.fillText(it.t, x, H / 2 + 0.5);
        if (it.old) { x2.fillRect(x, H / 2, it.w, 1); }
      } else if (it.sw !== undefined) {
        var y0 = (H - 14) / 2, rgba = rgbaOf(it.sw);
        if (!it.sw || !rgba) {
          x2.setLineDash([2, 2]); x2.strokeStyle = '#94a3b8'; rr(x2, x + 0.5, y0 + 0.5, 13, 13, 3); x2.stroke(); x2.setLineDash([]);
          x2.fillStyle = '#94a3b8'; x2.font = '700 10px system-ui,sans-serif'; x2.fillText('?', x + 4, H / 2 + 0.5); x2.font = BUB_FONT;
        } else {
          if (rgba.a < 0.99) {
            x2.fillStyle = '#e2e8f0'; x2.fillRect(x, y0, 14, 14);
            x2.fillStyle = '#94a3b8'; x2.fillRect(x, y0, 7, 7); x2.fillRect(x + 7, y0 + 7, 7, 7);
          }
          x2.fillStyle = it.sw; rr(x2, x, y0, 14, 14, 3); x2.fill();
          x2.lineWidth = 1.5; x2.strokeStyle = '#fff'; x2.stroke();
        }
      }
      x += it.w;
    }
    sp.key = key; sp.w = W2; sp.h = H;
    j.bub = sp;
    return sp;
  }

  function guideLabel(x, y, v, pal) {
    var s = String(Math.round(v));
    g.font = '600 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    var w = g.measureText(s).width + 8;
    g.fillStyle = pal.c; rr(g, x - w / 2, y - 7, w, 14, 4); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(s, x - w / 2 + 4, y + 0.5);
  }
  function drawGuides(c, j, dpr) {
    var s = j.sty, gd = s && s.gd, a = j.guideA * c.ga;
    if (!gd || !(a > 0.01)) return;
    var R = j.target.rect, v = gd.cur, pal = c.dpal || c.pal, bands = [], i;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = a;
    if (s.space) {
      var sd = s.space.sides;
      if (s.space.kind === 'p') {
        if (sd[0]) bands.push({ l: R.l, t: R.t, w: R.w, h: v.p[0], val: v.p[0], ax: 'h' });
        if (sd[1]) bands.push({ l: R.l + R.w - v.p[1], t: R.t, w: v.p[1], h: R.h, val: v.p[1], ax: 'w' });
        if (sd[2]) bands.push({ l: R.l, t: R.t + R.h - v.p[2], w: R.w, h: v.p[2], val: v.p[2], ax: 'h' });
        if (sd[3]) bands.push({ l: R.l, t: R.t, w: v.p[3], h: R.h, val: v.p[3], ax: 'w' });
      } else if (s.space.kind === 'm') {
        if (sd[0]) bands.push({ l: R.l, t: R.t - v.m[0], w: R.w, h: v.m[0], val: v.m[0], ax: 'h' });
        if (sd[1]) bands.push({ l: R.l + R.w, t: R.t, w: v.m[1], h: R.h, val: v.m[1], ax: 'w' });
        if (sd[2]) bands.push({ l: R.l, t: R.t + R.h, w: R.w, h: v.m[2], val: v.m[2], ax: 'h' });
        if (sd[3]) bands.push({ l: R.l - v.m[3], t: R.t, w: v.m[3], h: R.h, val: v.m[3], ax: 'w' });
      } else if (gd.goal.gaps) {
        for (i = 0; i < gd.goal.gaps.length; i++) {
          var gp = gd.goal.gaps[i];
          bands.push({ l: gp.l, t: gp.t, w: gp.w, h: gp.h, val: Math.min(gp.w, gp.h) });
        }
      }
      for (i = 0; i < bands.length; i++) {
        var b = bands[i];
        if (b.w < 0.5 || b.h < 0.5) continue;
        g.fillStyle = pal.s3; g.fillRect(b.l, b.t, b.w, b.h);
        g.strokeStyle = pal.c; g.lineWidth = 1; g.setLineDash([3, 3]); g.strokeRect(b.l + 0.5, b.t + 0.5, b.w - 1, b.h - 1); g.setLineDash(NODASH);
      }
      for (i = 0; i < bands.length && i < 8; i++) {
        var bb = bands[i];
        if (bb.val >= 1) guideLabel(bb.l + bb.w / 2, bb.t + bb.h / 2, bb.val, pal);
      }
    }
    if (s.radius) {
      var r = Math.max(4, v.r), x0 = R.l, y0 = R.t;
      g.beginPath(); g.arc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5);
      g.lineWidth = 4; g.strokeStyle = pal.k; g.stroke();
      g.lineWidth = 2.5; g.strokeStyle = pal.c; g.stroke();
      if (y0 > 22) guideLabel(x0 + r, y0 - 12, v.r, pal);
      else guideLabel(x0 + R.w + 16, y0 + 9, v.r, pal);
    }
    g.globalAlpha = 1;
  }

  function drawEdges(dpr) {
    var vw = W.innerWidth, vh = W.innerHeight, groups = { top: [], bottom: [], left: [], right: [] }, i, k, any = false;
    for (i = 0; i < cursors.length; i++) {
      var c = cursors[i], j = c.job;
      if (c.dead || !c.off || !(c.offA > 0.01) || !j || !j.target.rect) continue;
      var R = j.target.rect, horiz = c.off === 'top' || c.off === 'bottom';
      groups[c.off].push({ pos: horiz ? clamp(R.l + R.w / 2, 40, vw - 40) : clamp(R.t + R.h / 2, 40, vh - 40), a: c.offA * c.gaBase, col: (c.dpal || c.pal).c });
      any = true;
    }
    if (!any) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = '700 11px system-ui,-apple-system,"Segoe UI",sans-serif';
    g.textBaseline = 'middle';
    for (var edge in groups) {
      var list = groups[edge].sort(function (a, b) { return a.pos - b.pos; }), merged = [];
      for (i = 0; i < list.length; i++) {
        var last = merged[merged.length - 1];
        if (last && list[i].pos - last.pos1 < 60) { last.n++; last.pos1 = list[i].pos; last.sum += list[i].pos; last.a = Math.max(last.a, list[i].a); }
        else merged.push({ n: 1, pos1: list[i].pos, sum: list[i].pos, a: list[i].a, col: list[i].col });
      }
      for (k = 0; k < merged.length; k++) {
        var m = merged[k], p = m.sum / m.n, label = m.n > 1 ? String(m.n) : '';
        var w = 26 + (label ? g.measureText(label).width + 4 : 0), h = 24, x, y;
        if (edge === 'top') { x = p - w / 2; y = 10; } else if (edge === 'bottom') { x = p - w / 2; y = vh - 10 - h; }
        else if (edge === 'left') { x = 10; y = p - h / 2; } else { x = vw - 10 - w; y = p - h / 2; }
        g.globalAlpha = m.a;
        g.save(); g.shadowColor = 'rgba(0,0,0,.3)'; g.shadowBlur = 6 * dpr; g.fillStyle = m.col; rr(g, x, y, w, h, 12); g.fill(); g.restore();
        g.lineWidth = 1.5; g.strokeStyle = '#fff'; rr(g, x, y, w, h, 12); g.stroke();
        var ax = x + 13, ay = y + h / 2;
        g.beginPath();
        if (edge === 'top') { g.moveTo(ax - 5, ay + 3); g.lineTo(ax, ay - 4); g.lineTo(ax + 5, ay + 3); }
        else if (edge === 'bottom') { g.moveTo(ax - 5, ay - 3); g.lineTo(ax, ay + 4); g.lineTo(ax + 5, ay - 3); }
        else if (edge === 'left') { g.moveTo(ax + 3, ay - 5); g.lineTo(ax - 4, ay); g.lineTo(ax + 3, ay + 5); }
        else { g.moveTo(ax - 3, ay - 5); g.lineTo(ax + 4, ay); g.lineTo(ax - 3, ay + 5); }
        g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); g.lineCap = 'butt'; g.lineJoin = 'miter';
        if (label) { g.fillStyle = '#fff'; g.fillText(label, x + 22, ay + 0.5); }
      }
    }
    g.globalAlpha = 1;
  }

  function paint() {
    if (!g || !paths()) return;
    if (!cursors.length && !marksOn) { sleepCanvas(); return; }
    fitCanvas();
    var dpr = cvDpr, i, k, c, e, sp, j;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, cv.width, cv.height);
    if (marksOn) drawMarks(dpr);
    for (i = 0; i < cursors.length; i++) {
      c = cursors[i];
      if (c.dead) continue;
      var pal = c.dpal || c.pal;
      if (c.job && c.job.sty) drawGuides(c, c.job, dpr);
      g.fillStyle = pal.c;
      for (k = 0; k < c.dots.length; k++) {
        e = c.dots[k];
        if (!(e.o > 0.004)) continue;
        place(e, dpr);
        g.globalAlpha = e.o;
        g.beginPath(); g.arc(4, 4, 4, 0, TAU); g.fill();
      }
      for (k in c.parts) drawPart(c.parts[k], pal, dpr);
    }
    for (i = 0; i < cursors.length; i++) {
      c = cursors[i]; e = c.root;
      if (c.dead || !(e.o > 0.004)) continue;
      sp = spriteOf(c, dpr);
      if (!sp || !sp.cv.width) continue;
      g.setTransform(dpr * e.sx, 0, 0, dpr * e.sy, dpr * e.x, dpr * e.y);
      g.globalAlpha = e.o;
      g.drawImage(sp.cv, sp.ox, sp.oy, sp.w, sp.h);
      j = c.job;
      if (j && j.bubA > 0.01) {
        var bs = bubbleOf(c, j, dpr);
        if (bs && bs.cv.width) {
          g.setTransform(dpr, 0, 0, dpr, dpr * e.x, dpr * e.y);
          g.globalAlpha = e.o * j.bubA;
          g.drawImage(bs.cv, c.flip === '1' ? -13 - bs.w : 13, 42, bs.w, bs.h);
        }
      }
    }
    drawEdges(dpr);
    g.globalAlpha = 1;
  }

  var lastFrameT = 0;
  function frame() {
    raf = 0;
    var t0 = now(), i, c, j;
    var dt = lastFrameT ? clamp(t0 - lastFrameT, 0, 64) : 16;
    lastFrameT = t0;

    for (i = 0; i < cursors.length; i++) {
      c = cursors[i]; j = c.job;
      if (j && c.queue.length && !c.evict && t0 - j.t0 >= j.tr + j.ad) startJob(c, c.queue.shift(), t0);
    }
    for (i = 0; i < cursors.length; i++) {
      c = cursors[i]; j = c.job;
      if (j && j.ev.gate && !j.ev.sent && t0 - j.t0 >= j.tr + j.ad) {
        if (!j.ev.paintAck) release(j.ev);
        else if (j.paintReadyAt === null) j.paintReadyAt = t0;
        else if (t0 > j.paintReadyAt) release(j.ev);
      }
      if (j && j.ev.gate && j.ev.sent && !j.watch && j.target.el) startWatch(c, j, t0);
    }
    recSync();
    for (i = 0; i < cursors.length; i++) {
      c = cursors[i]; j = c.job;
      if (!j) continue;
      if (allDirty || j.needResolve || t0 >= j.nextRead) {
        readTarget(c, j, t0, allDirty);
        j.nextRead = t0 + (j.watch && j.watch.state !== 'done' ? 100 : 250);
      }
      if (j.watch) checkWatch(c, j, t0);
    }
    allDirty = false;
    for (i = 0; i < cursors.length; i++) writeCursor(cursors[i], t0, dt);
    for (i = cursors.length - 1; i >= 0; i--) if (cursors[i].dead) removeCursor(i);
    paint();

    if (cursors.length) raf = W.requestAnimationFrame(frame);
    else { lastFrameT = 0; recSync(); }
  }

  function kick() { if (!raf) raf = W.requestAnimationFrame(frame); }
  function markDirty() { allDirty = true; if (cursors.length || marksOn) kick(); }

  var es = null, backoff = 1000, lastMsg = 0, lastId = '', retryTimer = 0, closed = false, historyLoaded = false;

  function replayHistory() {
    if (historyLoaded || lastId || !W.fetch) return;
    historyLoaded = true;
    try {
      W.fetch(BASE + '/history?limit=20', { mode: 'cors' })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (body) {
          var events = body && Array.isArray(body.events) ? body.events : [];
          var played = loadPlayed(true);
          for (var i = 0; i < events.length; i++) (function (item, index) {
            var ev = item && item.event ? item.event : item;
            if (!ev || typeof ev !== 'object') return;
            var base = String(ev.id || '').split(':')[0];
            if (base && played.indexOf(base) >= 0) { replayedIds.push(base); return; }
            if (base) replayedIds.push(base);
            var copy = Object.assign({}, ev, { __acReplay: true, at: Number(item && item.at) || Number(ev.at) || 0 });
            setTimeout(function () { if (!closed) onEvent(copy); }, index * 70);
          })(events[i], i);
        }).catch(function () {});
    } catch (e) {}
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(Math.round(backoff * 1.6), 8000);
  }

  function connect() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = 0;
    try { if (es) es.close(); } catch (e) {}
    var url = BASE + '/events?cid=' + CID + '&v=' + (D.hidden ? 0 : 1) + (lastId ? '&last=' + encodeURIComponent(lastId) : '');
    var mine;
    try { mine = es = new EventSource(url); } catch (e) { scheduleReconnect(); return; }
    mine.onopen = function () { backoff = 1000; lastMsg = Date.now(); replayHistory(); };
    mine.onmessage = function (m) {
      lastMsg = Date.now();
      if (m.lastEventId) lastId = m.lastEventId;
      try { onEvent(JSON.parse(m.data)); } catch (e) {}
    };
    mine.addEventListener('ping', function () { lastMsg = Date.now(); });
    mine.addEventListener('hello', function (m) {
      lastMsg = Date.now();
      try { daemonProto = Number(JSON.parse(m.data).protocol) || 0; } catch (e) { daemonProto = 0; }
    });
    mine.addEventListener('applied', function (m) {
      lastMsg = Date.now();
      try { onApplied(JSON.parse(m.data)); } catch (e) {}
    });
    mine.onerror = function () {
      if (mine !== es) return;
      try { mine.close(); } catch (e) {}
      scheduleReconnect();
    };
  }

  var watchdog = setInterval(function () {
    if (closed) return;
    if (!es || es.readyState === 2) { if (!retryTimer) connect(); }
    else if (es.readyState === 1 && Date.now() - lastMsg > 35000) connect();
  }, 10000);

  var scrollOpts = { capture: true, passive: true };
  function releaseAll() {
    for (var i = 0; i < cursors.length; i++) {
      release(cursors[i].job && cursors[i].job.ev);
      for (var k = 0; k < cursors[i].queue.length; k++) release(cursors[i].queue[k]);
    }
  }
  function flushHidden() {
    var queued = hiddenEvents.splice(0, hiddenEvents.length);
    for (var i = 0; i < queued.length; i++) (function (raw, index) {
      var copy = Object.assign({}, raw, { __acReplay: true });
      setTimeout(function () { if (!closed && !D.hidden) onEvent(copy); }, index * 70);
    })(queued[i], i);
  }
  function onVisibility() {
    post('/vis', { cid: CID, v: !D.hidden });
    if (D.hidden) { releaseAll(); buildClearAll(); }
    else { hud.renderPending(); flushHidden(); api.ensure(); schedulePending(0); }
  }
  var FP_KEY = 'ac-fp', FP_FRESH = 15000, fpPrev = null, lastAckAt = 0;
  function fpKey(el) {
    var cl = el.classList && el.classList.length ? Array.prototype.slice.call(el.classList, 0, 4).sort().join('.') : '';
    return el.localName + '.' + cl + '#' + (el.id || '');
  }
  function fpText(el) {
    var s = el.textContent || '';
    return s.length + ':' + hashStr(s.slice(0, 2000));
  }
  function fpCollect(extraRoots) {
    var out = [], vw = W.innerWidth, vh = W.innerHeight, seen = new Set(), i;
    var push = function (n, any) {
      if (seen.has(n) || n === host || SKIP_TEXT[n.localName] || n.localName === 'br') return;
      var b = n.getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) return;
      if (!any && (b.bottom < 0 || b.top > vh || b.right < 0 || b.left > vw)) return;
      seen.add(n);
      out.push({ el: n, k: fpKey(n), t: fpText(n), r: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] });
    };
    for (i = 0; i < (extraRoots || []).length && out.length < 120; i++) {
      var root = extraRoots[i];
      if (!root || !root.isConnected) continue;
      push(root, true);
      var list = root.getElementsByTagName('*');
      for (var k = 0; k < list.length && k < 120; k++) push(list[k], true);
    }
    if (!D.body) return out;
    var tw = D.createTreeWalker(D.body, NodeFilter.SHOW_ELEMENT, null), n, scanned = 0;
    while ((n = tw.nextNode()) && scanned < 5000 && out.length < 400) { scanned++; push(n, false); }
    return out;
  }
  function saveFingerprint() {
    var ids = [], roots = [], tgt = null;
    for (var i = 0; i < cursors.length; i++) {
      var j = cursors[i].job;
      if (!j || !j.ev.gate || !j.ev.sent) continue;
      var watching = j.watch && (j.watch.state === 'wait' || j.watch.state === 'gray');
      if (!watching && Date.now() - lastAckAt > 10000) continue;
      ids.push(String(j.ev.id).split(':')[0]);
      if (j.target.el) { roots.push(j.target.el); if (!tgt && j.target.rect) tgt = j.target.rect; }
    }
    if (!ids.length) return;
    try {
      var items = fpCollect(roots).map(function (it) { return { k: it.k, t: it.t, r: it.r }; });
      W.sessionStorage.setItem(FP_KEY, JSON.stringify({
        at: Date.now(), url: W.location.pathname, ids: ids.slice(0, 20), items: items,
        tgt: tgt ? [Math.round(tgt.l), Math.round(tgt.t), Math.round(tgt.w), Math.round(tgt.h)] : null
      }));
    } catch (e) {}
  }
  (function loadFingerprint() {
    try {
      var raw = W.sessionStorage.getItem(FP_KEY);
      if (!raw) return;
      W.sessionStorage.removeItem(FP_KEY);
      var fp = JSON.parse(raw);
      if (fp && Array.isArray(fp.items) && Array.isArray(fp.ids) && Date.now() - fp.at < FP_FRESH && fp.url === W.location.pathname) {
        fpPrev = fp;
        setTimeout(function () { fpPrev = null; }, FP_FRESH);
      }
    } catch (e) { fpPrev = null; }
  })();
  function fpTruth(ev) {
    if (!fpPrev) return null;
    var old = {}, oldKeys = {}, i;
    for (i = 0; i < fpPrev.items.length; i++) {
      var o = fpPrev.items[i], key = o.k + '|' + o.t;
      old[key] = (old[key] || 0) + 1;
      oldKeys[o.k] = 1;
    }
    var now0 = fpCollect([]), cands = [];
    for (i = 0; i < now0.length; i++) {
      var it = now0[i], kk = it.k + '|' + it.t;
      if (old[kk]) { old[kk]--; continue; }
      cands.push({ el: it.el, isNew: !oldKeys[it.k], r: it.r });
    }
    var deep = cands.filter(function (c) {
      for (var q = 0; q < cands.length; q++) if (cands[q] !== c && c.el.contains(cands[q].el)) return false;
      return true;
    });
    if (!deep.length || deep.length > 30) return null;
    var vw = W.innerWidth, vh = W.innerHeight, d = ev.delta || {}, T = fpPrev.tgt, best = null;
    for (i = 0; i < deep.length; i++) {
      var c = deep[i], s = c.isNew ? 300 : 250, r = c.r;
      if (ev.kind === 'text' && d.to) {
        var needle = norm(d.to.replace(/…$/, ''));
        if (needle.length >= 2 && norm(c.el.textContent || '').indexOf(needle) >= 0) s += 400;
      }
      if (ev.kind === 'add' && ev.next && elMatches(c.el, ev.next)) s += 300;
      if (hasHint(ev.hint) && elMatches(c.el, ev.hint)) s += 150;
      if (T) { var dist = Math.abs(r[0] + r[2] / 2 - (T[0] + T[2] / 2)) + Math.abs(r[1] + r[3] / 2 - (T[1] + T[3] / 2)); s += Math.max(0, 100 - dist / 8); }
      if (c.el === D.body || c.el.localName === 'main' || r[2] * r[3] > vw * vh * 0.6) s -= 300;
      if (!best || s > best.s) best = { el: c.el, s: s };
    }
    return best && best.s >= TRUTH_MIN ? best.el : null;
  }
  function fpReplay(raw, ev, tries) {
    if (!fpPrev || fpPrev.ids.indexOf(String(ev.id).split(':')[0]) < 0) return false;
    var el = fpTruth(ev);
    if (!el) {
      if ((tries || 0) < 6) { setTimeout(function () { if (!closed && !fpReplay(raw, ev, (tries || 0) + 1)) onEvent(Object.assign({}, raw, { __acFpDone: true })); }, 250); return true; }
      return false;
    }
    playResolved(Object.assign({}, ev, { gate: false, paintAck: false, __acFp: true }), { el: el });
    return true;
  }

  function hasHmr() {
    try {
      if (D.querySelector('script[src*="/@vite/client"],script[src*="/_next/"],#__next,next-route-announcer,script[src*="webpack"],script[src*="livereload"],script[src*="/browser-sync/"]')) return true;
      var ss = D.getElementsByTagName('script');
      for (var i = 0; i < ss.length && i < 200; i++) if (!ss[i].src && /live-server|livereload|__vite_plugin|hot-update/i.test((ss[i].textContent || '').slice(0, 4000))) return true;
    } catch (e) {}
    return false;
  }
  function reloadCss(file) {
    var segs = String(file).replace(/\\/g, '/').split('/').filter(Boolean), tail2 = segs.slice(-2).join('/').toLowerCase(), tail1 = (segs[segs.length - 1] || '').toLowerCase();
    if (!tail1) return 0;
    var links = D.querySelectorAll('link[rel~="stylesheet"][href]'), byTail2 = [], byName = [], i, n = 0;
    for (i = 0; i < links.length; i++) {
      var href = '';
      try { href = decodeURIComponent(new URL(links[i].getAttribute('href'), W.location.href).pathname).toLowerCase(); } catch (e) { continue; }
      if (segs.length > 1 && (href === '/' + tail2 || href.slice(-tail2.length - 1) === '/' + tail2)) byTail2.push(links[i]);
      else if (href.split('/').pop() === tail1) byName.push(links[i]);
    }
    var pick = byTail2.length ? byTail2 : byName;
    for (i = 0; i < pick.length; i++) {
      var ln = pick[i], url;
      if (ln.__acReloading) continue;
      try { url = new URL(ln.getAttribute('href'), W.location.href); } catch (e) { continue; }
      url.searchParams.set('ac', String(Date.now()));
      var fresh = ln.cloneNode(false);
      fresh.href = url.href;
      ln.__acReloading = true;
      (function (oldLn, nl) {
        var done = false, drop = function () { if (done) return; done = true; if (oldLn.parentNode) oldLn.parentNode.removeChild(oldLn); };
        nl.addEventListener('load', drop);
        nl.addEventListener('error', function () { done = true; if (nl.parentNode) nl.parentNode.removeChild(nl); oldLn.__acReloading = false; });
        setTimeout(drop, 4000);
      })(ln, fresh);
      ln.parentNode.insertBefore(fresh, ln.nextSibling);
      n++;
    }
    return n;
  }
  function liveHtmlOn() {
    try { if (new URL(W.location.href).searchParams.get('ac-live') === '1') return true; } catch (e) {}
    try { return W.localStorage.getItem('agent-cursors-live') === '1'; } catch (e) { return false; }
  }
  function htmlIsThisPage(file) {
    if (!/^https?:$/.test(W.location.protocol)) return false;
    var name = String(file).replace(/\\/g, '/').split('/').pop().toLowerCase();
    var page = decodeURIComponent(W.location.pathname).split('/').pop().toLowerCase() || 'index.html';
    var stem = name.replace(/\.(?:html?|xhtml)$/, '');
    return name === page || (!!stem && stem === page) || (name === 'index.html' && /\/$/.test(W.location.pathname));
  }
  function mergeKids(oldP, newP, depth) {
    var a = [], b = [], i;
    for (i = 0; i < oldP.children.length; i++) if (oldP.children[i] !== host && oldP.children[i].id !== HOST_ID) a.push(oldP.children[i]);
    for (i = 0; i < newP.children.length; i++) b.push(newP.children[i]);
    if (a.length !== b.length) return false;
    for (i = 0; i < a.length; i++) if (fpKey(a[i]) !== fpKey(b[i])) return false;
    for (i = 0; i < a.length; i++) {
      if (a[i].localName === 'script' || a[i].outerHTML === b[i].outerHTML) continue;
      if (depth < 6 && a[i].children.length && b[i].children.length && mergeKids(a[i], b[i], depth + 1) && a[i].outerHTML === b[i].outerHTML) continue;
      a[i].replaceWith(D.importNode(b[i], true));
    }
    return true;
  }
  function liveHtml(file) {
    if (!W.fetch || !W.DOMParser) return;
    W.fetch(W.location.href, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (html) {
      if (!html || closed) return;
      var doc = new W.DOMParser().parseFromString(html, 'text/html');
      if (doc && doc.body && D.body) mergeKids(D.body, doc.body, 0);
    }).catch(function () {});
  }
  function noHmrApply(file) {
    if (hasHmr()) return;
    if (/\.css$/i.test(file)) reloadCss(file);
    else if (/\.html?$/i.test(file) && liveHtmlOn() && htmlIsThisPage(file)) liveHtml(file);
  }

  var RELOAD_QUIET_MS = 2500, RELOAD_MAX_WAIT_MS = 20000, PLAYED_KEY = 'ac-played', PLAYED_FRESH = 60000;
  var reloadTimer = 0, reloadSince = 0, replayedIds = [];
  function staticReloadOn() {
    try { if (new URL(W.location.href).searchParams.get('ac-reload') === '0') return false; } catch (e) {}
    try { return W.localStorage.getItem('agent-cursors-reload') !== '0'; } catch (e) { return true; }
  }
  function scriptIsOnPage(file) {
    var segs = String(file).replace(/\\/g, '/').split('/').filter(Boolean), tail1 = (segs[segs.length - 1] || '').toLowerCase();
    var tail2 = segs.slice(-2).join('/').toLowerCase(), list = D.querySelectorAll('script[src]'), byName = false;
    if (!tail1) return false;
    for (var i = 0; i < list.length; i++) {
      var href = '';
      try { href = decodeURIComponent(new URL(list[i].getAttribute('src'), W.location.href).pathname).toLowerCase(); } catch (e) { continue; }
      if (segs.length > 1 && (href === '/' + tail2 || href.slice(-tail2.length - 1) === '/' + tail2)) return true;
      if (href.split('/').pop() === tail1) byName = true;
    }
    return byName;
  }
  function wantsStaticReload(raw) {
    if (!raw || raw.__acReplay || typeof raw.file !== 'string') return false;
    if (raw.meta && raw.meta.outside) return false;
    if (!/^https?:$/.test(W.location.protocol)) return false;
    var mine = /\.html?$/i.test(raw.file) ? htmlIsThisPage(raw.file) : /\.m?js$/i.test(raw.file) && scriptIsOnPage(raw.file);
    return !!mine && staticReloadOn() && !liveHtmlOn() && !hasHmr();
  }
  function typingNow() {
    var a = D.activeElement;
    if (!a || a === D.body) return false;
    return a.isContentEditable || a.localName === 'textarea' ||
      (a.localName === 'input' && !/^(?:button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(a.type || ''));
  }
  function gateBusy() {
    var t = now();
    for (var i = 0; i < cursors.length; i++) {
      var c = cursors[i], j = c.job;
      if (!j || c.dead || c.evict || j.kind === 'read') continue;
      if (j.ev.gate && !j.applied) return true;
      if (t - j.t0 < (j.tr || 0) + (j.ad || 0)) return true;
      if (c.queue && c.queue.length) return true;
    }
    return false;
  }
  function scheduleStaticReload() {
    if (closed || leaving) return;
    if (!reloadSince) reloadSince = Date.now();
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(runStaticReload, RELOAD_QUIET_MS);
  }
  function runStaticReload() {
    reloadTimer = 0;
    if (closed || leaving) return;
    var waiting = Date.now() - reloadSince < RELOAD_MAX_WAIT_MS;
    if (waiting && (gateBusy() || typingNow() || Date.now() - lastUserInput < 1500)) { reloadTimer = setTimeout(runStaticReload, 400); return; }
    reloadSince = 0;
    if (typingNow()) return;
    if (navLoop()) return;
    try {
      var keep = loadPlayed(false).concat(replayedIds).slice(-300);
      W.sessionStorage.setItem(PLAYED_KEY, JSON.stringify({ at: Date.now(), ids: keep }));
    } catch (e) {}
    leaving = true;
    try { W.location.reload(); } catch (e) { leaving = false; }
  }
  function loadPlayed(take) {
    try {
      var raw = W.sessionStorage.getItem(PLAYED_KEY);
      if (take) W.sessionStorage.removeItem(PLAYED_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return o && Array.isArray(o.ids) && Date.now() - Number(o.at) < PLAYED_FRESH ? o.ids.map(String) : [];
    } catch (e) { return []; }
  }

  function onPageHide() {
    saveFingerprint();
    post('/vis', { cid: CID, v: false });
    releaseAll();
    buildClearAll();
    try { if (es) es.close(); } catch (e) {}
  }
  function onPageShow() { if (!closed) { post('/vis', { cid: CID, v: !D.hidden }); if (!D.hidden) { hud.renderPending(); flushHidden(); } api.ensure(); } }

  W.addEventListener('scroll', markDirty, scrollOpts);
  W.addEventListener('resize', markDirty);
  D.addEventListener('click', noteUserInput, true);
  D.addEventListener('keydown', noteUserInput, true);
  D.addEventListener('keydown', onKey, true);
  D.addEventListener('visibilitychange', onVisibility);
  W.addEventListener('pagehide', onPageHide);
  W.addEventListener('pageshow', onPageShow);

  api.ensure = function () {
    if (closed) return;
    attach();
    if (!es || es.readyState === 2) { if (!retryTimer) connect(); }
  };
  api.play = function (ev) {
    if (!ev || typeof ev !== 'object') return;
    var copy = {};
    for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) copy[k] = ev[k];
    if (!copy.id) copy.id = 'play-' + Math.random().toString(36).slice(2);
    onEvent(copy);
  };
  api.destroy = function () {
    closed = true;
    releaseAll();
    hud.destroy();
    clearInterval(watchdog);
    clearTimeout(retryTimer);
    clearTimeout(pendTimer);
    clearTimeout(followTimer);
    clearInterval(marksTimer);
    marksOn = false;
    marks.length = 0;
    pending.length = 0;
    try { if (pendObs) pendObs.disconnect(); } catch (e) {}
    try { if (es) es.close(); } catch (e) {}
    try { if (domObs) domObs.disconnect(); } catch (e) {}
    try { if (recObs) recObs.disconnect(); } catch (e) {}
    recOn = false;
    buildClearAll();
    try { if (buildStyle && buildStyle.parentNode) buildStyle.parentNode.removeChild(buildStyle); } catch (e) {}
    if (raf) W.cancelAnimationFrame(raf);
    raf = 0;
    while (cursors.length) removeCursor(cursors.length - 1);
    paint();
    W.removeEventListener('scroll', markDirty, scrollOpts);
    W.removeEventListener('resize', markDirty);
    D.removeEventListener('click', noteUserInput, true);
    D.removeEventListener('keydown', noteUserInput, true);
    D.removeEventListener('keydown', onKey, true);
    D.removeEventListener('visibilitychange', onVisibility);
    W.removeEventListener('pagehide', onPageHide);
    W.removeEventListener('pageshow', onPageShow);
    if (host.parentNode) host.parentNode.removeChild(host);
    try { delete W.__agentCursorsHud; } catch (e) {}
    if (W.__agentCursors === api) delete W.__agentCursors;
  };
  api.state = function () {
    var t0 = now();
    return cursors.map(function (c) {
      var j = c.job, R = j && j.target.mode === 'el' && j.target.rect ? j.target.rect : null;
      return {
        x: Math.round(c.x), y: Math.round(c.y), label: c.labelText, agent: c.agentTag,
        kind: j ? j.kind : '', age: j ? Math.round(t0 - j.t0) : -1,
        phase: !j ? 'none' : t0 - j.t0 < j.tr ? 'travel' : t0 - j.t0 < j.tr + j.ad ? 'act' : 'idle',
        target: R ? { l: Math.round(R.l), t: Math.round(R.t), w: Math.round(R.w), h: Math.round(R.h) } : null,
        watch: j && j.watch ? j.watch.state : '', arrived: !!(j && j.arr), full: !!(j && j.arrFull),
        pal: (c.dpal || c.pal).id, dark: c.dark, off: c.off, offA: Math.round(c.offA * 100) / 100,
        bubble: !!(j && j.bub && j.bubA > 0.01), swatches: j && j.sty ? j.sty.swatches.slice() : null,
        guides: j ? Math.round(j.guideA * 100) / 100 : 0, opacity: Math.round(c.root.o * 100) / 100,
        truth: j && j.truth ? j.truth.roots.length : 0, retarget: !!(j && j.retarget),
        build: j && j.build ? { pieces: j.build.pieces.length, shown: j.build.shown, done: j.build.done } : null,
        el: j && j.target.el && j.target.el.isConnected ? descEl(j.target.el) : ''
      };
    });
  };
  function descEl(el) {
    var s = el.localName + (el.id ? '#' + el.id : '');
    if (el.classList && el.classList.length) s += '.' + Array.prototype.slice.call(el.classList, 0, 3).join('.');
    return s;
  }
  api.recording = function () { return recOn; };
  api.setMarks = function (on) { return setMarks(on, true); };
  api.getMarks = function () { return marksOn; };
  api.marks = function () {
    var n = 0;
    for (var i = 0; i < marks.length; i++) if (markEl(marks[i])) n++;
    return { total: marks.length, shown: n };
  };
  api.setMode = function (m) {
    applyMode(m);
    try { W.localStorage.setItem('agent-cursors-mode', mode); } catch (e) {}
    return mode;
  };
  api.getMode = function () { return mode; };
  api.setFollow = function (value) {
    followMode = value === 'search' ? 'search' : !(value === false || value === 0 || value === '0');
    W.__agentCursorsFollow = followMode;
    try { W.localStorage.setItem('agent-cursors-follow', followMode === 'search' ? 'search' : followMode ? '1' : '0'); } catch (e) {}
    return followMode;
  };
  api.getFollow = function () { return isFollowEnabled(); };
  api.setHud = function (value) { W.__agentCursorsHud = value; return hud.enabled; };
  api.getHud = function () { return hud.enabled; };
  api.getHudMode = function () { return hud.mode; };
  Object.defineProperty(api, 'count', { get: function () { return cursors.length; } });
  api.pending = function () { return pending.length; };

  (function () {
    var initial = null;
    try { if (cs && cs.getAttribute('data-mode')) initial = cs.getAttribute('data-mode'); } catch (e) {}
    try { initial = W.localStorage.getItem('agent-cursors-mode') || initial; } catch (e) {}
    try { initial = new URL(W.location.href).searchParams.get('mode') || initial; } catch (e) {}
    if (initial) applyMode(initial);
    try {
      var cst = W.chrome && W.chrome.storage && W.chrome.storage.sync;
      if (cst) {
        cst.get({ mode: null }, function (r) { if (r && r.mode) applyMode(r.mode); });
        W.chrome.storage.onChanged.addListener(function (ch, area) {
          if (area === 'sync' && ch.mode && ch.mode.newValue) applyMode(ch.mode.newValue);
        });
      }
    } catch (e) {}
  })();

  try { if (W.localStorage.getItem('agent-cursors-marks') === '1') setMarks(true, true); } catch (e) {}

  connect();
})();

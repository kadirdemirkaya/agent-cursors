(function () {
  'use strict';
  if (window.__agentCursorsBridge) return;
  window.__agentCursorsBridge = 1;

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

  document.addEventListener('ac:owner', function (e) {
    var req = null;
    try { req = JSON.parse(typeof e.detail === 'string' ? e.detail : ''); } catch (x) { return; }
    var q = req && Array.isArray(req.q) ? req.q.slice(0, 20) : [], r = {};
    for (var i = 0; i < q.length; i++) {
      var n = Math.floor(Number(q[i]));
      if (!(n >= 0 && n < 100)) continue;
      var el = document.querySelector('[data-ac-q="' + n + '"]');
      if (el) r[n] = ownerRead(el);
    }
    document.dispatchEvent(new CustomEvent('ac:owner:res', { detail: JSON.stringify({ r: r }) }));
  });
})();

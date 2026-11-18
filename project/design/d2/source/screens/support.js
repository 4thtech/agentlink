/*
 * AgentLink screens — local preview runtime.
 * Renders the .dc.html screen files exported from the design canvas in a plain browser,
 * so they can be opened without the design tool. Serve this folder over HTTP
 * (for example `python3 -m http.server` here) and open any *.dc.html file.
 *
 * Supports exactly what the screens use: {{holes}} from renderVals(), <sc-if>, <sc-for>,
 * <dc-import name="…">, <helmet>, and <x-import component-from-global-scope="AgentLink.X">,
 * which mounts the real React components from ds/agentlink/components/bundle.js.
 * This is a preview tool, not production code.
 */
(function () {
  var here = (document.currentScript && document.currentScript.src) || location.href;
  var base = here.replace(/[^\/]*$/, '');
  if (!window.React) {
    document.write('<script src="' + base + 'lib/react.production.min.js"><\/script>' +
                   '<script src="' + base + 'lib/react-dom.production.min.js"><\/script>');
  }

  window.DCLogic = function DCLogic(props) { this.props = props || {}; this.state = {}; };
  window.DCLogic.prototype.setState = function (s) {
    Object.assign(this.state, typeof s === 'function' ? s(this.state, this.props) : s);
  };
  window.DCLogic.prototype.forceUpdate = function () {};

  var raw = new WeakMap();
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(path, scope) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^'.*'$|^".*"$/.test(path)) return path.slice(1, -1);
    var parts = path.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) { if (v == null) return undefined; v = v[parts[i]]; }
    return v;
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
  function attrValue(el, name, scope) {
    var map = raw.get(el);
    if (map && name in map) return map[name];
    var t = el.getAttribute(name);
    if (t == null) return undefined;
    var m = WHOLE.exec(t);
    return m ? lookup(m[1], scope) : t;
  }

  function loadClass(scriptEl) {
    if (!scriptEl) return function () { this.props = {}; this.renderVals = function () { return {}; }; };
    /* eslint-disable no-new-func */
    return new Function('DCLogic', scriptEl.textContent + '\n;return Component;')(window.DCLogic);
  }
  function valsFor(Cls, props) {
    var inst = new Cls(props || {});
    inst.props = props || {};
    return inst.renderVals ? (inst.renderVals() || {}) : {};
  }

  function process(node, scope) {
    if (node.nodeType === 3) {
      if (node.nodeValue.indexOf('{{') >= 0) {
        node.nodeValue = node.nodeValue.replace(HOLE, function (_, p) { var v = lookup(p, scope); return v == null ? '' : String(v); });
      }
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.localName;
    if (tag === 'helmet') {
      Array.prototype.slice.call(node.querySelectorAll('style')).forEach(function (s) { document.head.appendChild(s); });
      node.remove();
      return;
    }
    if (tag === 'sc-if') {
      var ok = attrValue(node, 'value', scope);
      if (ok) { kids(node).forEach(function (c) { process(c, scope); }); unwrap(node); } else node.remove();
      return;
    }
    if (tag === 'sc-for') {
      var list = attrValue(node, 'list', scope) || [], as = node.getAttribute('as') || 'item';
      var parent = node.parentNode;
      list.forEach(function (item, i) {
        var s = Object.create(scope); s[as] = item; s.$index = i;
        kids(node).forEach(function (c) { var cl = c.cloneNode(true); parent.insertBefore(cl, node); process(cl, s); });
      });
      node.remove();
      return;
    }
    if (tag === 'dc-import') {
      var props = {};
      Array.prototype.slice.call(node.attributes).forEach(function (a) {
        if (a.name === 'name' || a.name.indexOf('hint-') === 0) return;
        props[camel(a.name)] = attrValue(node, a.name, scope);
      });
      var frag = renderFile(node.getAttribute('name') + '.dc.html', props);
      node.parentNode.replaceChild(frag, node);
      return;
    }
    Array.prototype.slice.call(node.attributes).forEach(function (a) {
      if (a.value.indexOf('{{') < 0) return;
      var m = WHOLE.exec(a.value);
      if (m) {
        var v = lookup(m[1], scope);
        var map = raw.get(node) || {}; map[a.name] = v; raw.set(node, map);
        node.setAttribute(a.name, (v == null || typeof v === 'object' || typeof v === 'function') ? '' : String(v));
      } else {
        node.setAttribute(a.name, a.value.replace(HOLE, function (_, p) { var v = lookup(p, scope); return v == null ? '' : String(v); }));
      }
    });
    kids(node).forEach(function (c) { process(c, scope); });
  }
  function kids(n) { return Array.prototype.slice.call(n.childNodes); }
  function unwrap(n) { var p = n.parentNode; while (n.firstChild) p.insertBefore(n.firstChild, n); p.removeChild(n); }

  function renderTemplate(xdc, Cls, props) {
    var scope = valsFor(Cls, props);
    var frag = document.createDocumentFragment();
    var holder = document.createElement('div');
    kids(xdc).forEach(function (c) { holder.appendChild(c.cloneNode(true)); });
    kids(holder).forEach(function (c) { process(c, scope); });
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    return frag;
  }
  function renderFile(url, props) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', new URL(url, location.href).href, false);
    xhr.send();
    var doc = new DOMParser().parseFromString(xhr.responseText, 'text/html');
    return renderTemplate(doc.querySelector('x-dc'), loadClass(doc.querySelector('script[data-dc-script]')), props);
  }

  /* ---- x-import → React ---- */
  var ATTR = { 'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex', 'colspan': 'colSpan', 'rowspan': 'rowSpan',
    'inputmode': 'inputMode', 'autocomplete': 'autoComplete', 'readonly': 'readOnly', 'maxlength': 'maxLength' };
  function styleObj(s) {
    var o = {};
    (s || '').split(';').forEach(function (d) {
      var i = d.indexOf(':'); if (i < 0) return;
      var k = d.slice(0, i).trim(), v = d.slice(i + 1).trim();
      if (!k) return;
      o[k.indexOf('--') === 0 ? k : camel(k)] = v;
    });
    return o;
  }
  function resolve(path) { return path.split('.').reduce(function (o, k) { return o && o[k]; }, window); }
  function childrenOf(el) {
    var out = [];
    kids(el).forEach(function (c) {
      if (c.nodeType === 3) { if (/\S/.test(c.nodeValue)) out.push(c.nodeValue.replace(/^\n+|\n+\s*$/g, '')); }
      else if (c.nodeType === 1) out.push(toReact(c, out.length));
    });
    return out;
  }
  function toReact(el, key) {
    var h = React.createElement, props = { key: key };
    var map = raw.get(el) || {};
    if (el.localName === 'x-import') {
      var Comp = resolve(el.getAttribute('component-from-global-scope'));
      Array.prototype.slice.call(el.attributes).forEach(function (a) {
        if (a.name === 'component-from-global-scope' || a.name === 'style' || a.name.indexOf('hint-') === 0) return;
        props[camel(a.name)] = a.name in map ? map[a.name] : a.value;
      });
      var ch = childrenOf(el);
      if (ch.length === 1) props.children = ch[0]; else if (ch.length) props.children = ch;
      if (!Comp) return h('span', props, '[missing ' + el.getAttribute('component-from-global-scope') + ']');
      return h(Comp, props);
    }
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var n = a.name;
      if (n === 'style') props.style = styleObj(a.value);
      else if (el.localName === 'input' && n === 'checked') props.defaultChecked = true;
      else if (el.localName === 'input' && n === 'value') props.defaultValue = a.value;
      else props[ATTR[n] || (n.indexOf('aria-') === 0 || n.indexOf('data-') === 0 ? n : camel(n))] = n in map ? map[n] : a.value;
    });
    var c = childrenOf(el);
    return h.apply(null, [el.localName, props].concat(c));
  }
  function mountImports(root) {
    Array.prototype.slice.call(root.querySelectorAll('x-import')).forEach(function (el) {
      if (el.parentElement && el.parentElement.closest('x-import')) return;
      var wrap = document.createElement('div');
      var st = el.getAttribute('style');
      wrap.setAttribute('style', st ? st : 'display: contents');
      el.parentNode.replaceChild(wrap, el);
      ReactDOM.createRoot(wrap).render(toReact(el, 'root'));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var xdc = document.querySelector('x-dc');
    if (!xdc) return;
    var frag = renderTemplate(xdc, loadClass(document.querySelector('script[data-dc-script]')), {});
    xdc.parentNode.replaceChild(frag, xdc);
    mountImports(document.body);
    document.documentElement.setAttribute('data-rendered', 'true');
  });
})();

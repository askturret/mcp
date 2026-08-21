// SPDX-License-Identifier: Apache-2.0
/**
 * Renders the Explorer single-page app.
 *
 * Deliberately a hand-written static page with inline CSS/JS and no framework
 * or build step: the whole document is a few KB, far inside the <100 KB gz
 * budget, and it adds no dependency to a package that ships to adopters.
 *
 * The page is fully rendered from an embedded view model, and the only network
 * call it ever makes is `tools/call` against the MCP transport at basePath —
 * there is no Explorer-private endpoint.
 */

import type { ExplorerViewModel } from './types.js';

/**
 * Render the complete Explorer HTML document.
 */
export function renderExplorerHtml(model: ExplorerViewModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MCP Explorer (dev)</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>AskTurret MCP Explorer</h1>
    <span class="dev-tag" title="Explorer is disabled by default when NODE_ENV=production">dev only</span>
  </div>
  <dl class="registry-meta">
    <div><dt>Registry hash</dt><dd id="meta-hash" class="mono"></dd></div>
    <div><dt>Version</dt><dd id="meta-version" class="mono"></dd></div>
    <div><dt>Created</dt><dd id="meta-created" class="mono"></dd></div>
    <div><dt>Tools</dt><dd id="meta-count" class="mono"></dd></div>
  </dl>
</header>
<main>
  <nav aria-label="Tools">
    <input id="filter" type="search" placeholder="Filter tools…" autocomplete="off" aria-label="Filter tools">
    <div id="tool-list"></div>
  </nav>
  <section id="detail" aria-live="polite"></section>
</main>
<script>window.__EXPLORER__=${embedJson(model)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Embed a value as JSON inside a <script> block.
 *
 * `</script` inside a string would close the block early, and U+2028/U+2029 are
 * literal line terminators in JS source but legal inside a JSON string, so both
 * must be escaped. Tool names, descriptions and schemas come from adopter specs
 * — untrusted enough to warrant this.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const STYLES = `
:root{--bg:#fff;--fg:#1a1d21;--muted:#666e78;--line:#e3e6ea;--accent:#2b6cb0;--code:#f5f6f8;--ro:#1a7f5a;--mut:#a8500a}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
header{border-bottom:1px solid var(--line);padding:12px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px}
h1{font-size:16px;margin:0}
.dev-tag{font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:#fdf1dc;color:var(--mut);border:1px solid #f0dcb8;border-radius:3px;padding:2px 6px}
.registry-meta{display:flex;flex-wrap:wrap;gap:18px;margin:0}
.registry-meta div{display:flex;flex-direction:column}
.registry-meta dt{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.registry-meta dd{margin:0;font-size:12px;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{display:grid;grid-template-columns:minmax(220px,300px) 1fr;align-items:start;min-height:calc(100vh - 62px)}
nav{border-right:1px solid var(--line);padding:12px;position:sticky;top:0}
#filter{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;font:inherit;margin-bottom:10px}
.tool-item{display:block;width:100%;text-align:left;background:none;border:0;border-radius:4px;padding:8px;cursor:pointer;font:inherit;border-left:3px solid transparent}
.tool-item:hover{background:var(--code)}
.tool-item.active{background:#eaf2fb;border-left-color:var(--accent)}
.tool-name{font-weight:600}
.tool-desc{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10px;border-radius:3px;padding:1px 5px;margin-left:6px;vertical-align:middle}
.badge-ro{background:#e6f5ee;color:var(--ro)}
.badge-mut{background:#fdf1dc;color:var(--mut)}
.badge-flag{background:var(--code);color:var(--muted);margin:0 6px 0 0}
section#detail{padding:20px;min-width:0}
.empty{color:var(--muted);padding:20px}
h2{margin:0 0 4px;font-size:20px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.desc{color:var(--fg);margin:0 0 12px}
.meta-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
ul.schema{list-style:none;margin:0;padding-left:14px;border-left:1px dotted var(--line)}
ul.schema>li{padding:3px 0}
.f-name{font-family:ui-monospace,Menlo,monospace;font-weight:600}
.f-type{color:var(--accent);font-size:12px;margin-left:6px}
.f-req{color:#b32d2d;font-size:11px;margin-left:6px}
.f-desc{color:var(--muted);font-size:12px}
form.invoke{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:12px}
.field{margin-bottom:10px;display:flex;flex-direction:column;gap:3px}
.field label{font-size:12px;font-weight:600}
.field input,.field textarea,.field select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:#fff}
.field textarea{font-family:ui-monospace,Menlo,monospace;min-height:70px}
.field .hint{font-size:11px;color:var(--muted)}
button.run{background:var(--accent);color:#fff;border:0;border-radius:4px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
button.run:disabled{opacity:.6;cursor:progress}
pre.out{background:#1c2027;color:#e6e9ee;padding:12px;border-radius:6px;overflow:auto;max-height:420px;font-size:12px;margin:0}
.status{font-size:12px;margin:8px 0;font-weight:600}
.status.ok{color:var(--ro)}
.status.err{color:#b32d2d}
.note{color:var(--muted);font-size:12px;margin-top:6px}
`;

/**
 * Client script.
 *
 * Written without template literals so it can live inside this module's
 * template literal without escaping, and it builds DOM via createElement /
 * textContent rather than innerHTML — tool names, descriptions and schemas come
 * from adopter specs and are never treated as markup.
 */
const CLIENT_JS = `
(function () {
  var MODEL = window.__EXPLORER__;
  var tools = MODEL.tools || [];
  var listEl = document.getElementById('tool-list');
  var detailEl = document.getElementById('detail');
  var filterEl = document.getElementById('filter');
  var current = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }

  function typeOf(schema) {
    if (!schema) { return 'any'; }
    if (Array.isArray(schema.type)) { return schema.type.join(' | '); }
    if (schema.type) { return schema.type; }
    if (schema.enum) { return 'enum'; }
    return 'any';
  }

  // ---- header -------------------------------------------------------------
  var h = MODEL.header || {};
  document.getElementById('meta-hash').textContent = h.registryHash || '(none)';
  document.getElementById('meta-hash').title = h.registryHash || '(none)';
  document.getElementById('meta-version').textContent = h.version;
  document.getElementById('meta-created').textContent = h.createdAt;
  document.getElementById('meta-created').title = h.createdAt;
  document.getElementById('meta-count').textContent = h.toolCount;

  // ---- tool list ----------------------------------------------------------
  function renderList() {
    var q = filterEl.value.trim().toLowerCase();
    listEl.textContent = '';
    var shown = tools.filter(function (t) {
      if (!q) { return true; }
      return t.name.toLowerCase().indexOf(q) >= 0 ||
             String(t.description || '').toLowerCase().indexOf(q) >= 0;
    });
    if (!shown.length) {
      listEl.appendChild(el('div', 'empty', tools.length ? 'No tools match that filter.' : 'This registry exposes no tools.'));
      return;
    }
    shown.forEach(function (t) {
      var item = el('button', 'tool-item');
      item.type = 'button';
      var head = el('div');
      head.appendChild(el('span', 'tool-name', t.name));
      head.appendChild(el('span', t.effects.readOnly ? 'badge badge-ro' : 'badge badge-mut',
        t.effects.readOnly ? 'read-only' : 'mutating'));
      item.appendChild(head);
      item.appendChild(el('div', 'tool-desc', t.description || '—'));
      if (current === t.name) { item.classList.add('active'); }
      item.addEventListener('click', function () {
        location.hash = '#' + encodeURIComponent(t.name);
      });
      listEl.appendChild(item);
    });
  }

  // ---- schema tree --------------------------------------------------------
  function schemaTree(schema, depth) {
    depth = depth || 0;
    var ul = el('ul', 'schema');
    if (!schema || typeof schema !== 'object') {
      ul.appendChild(el('li', 'f-desc', 'No schema declared.'));
      return ul;
    }
    if (schema.type === 'array' && schema.items) {
      var li = el('li');
      li.appendChild(el('span', 'f-name', 'items'));
      li.appendChild(el('span', 'f-type', typeOf(schema.items)));
      if (depth < 6) { li.appendChild(schemaTree(schema.items, depth + 1)); }
      ul.appendChild(li);
      return ul;
    }
    var props = schema.properties;
    if (!props || !Object.keys(props).length) {
      ul.appendChild(el('li', 'f-desc', schema.type ? 'Type: ' + typeOf(schema) : 'No properties declared.'));
      return ul;
    }
    var required = schema.required || [];
    Object.keys(props).forEach(function (key) {
      var field = props[key] || {};
      var li = el('li');
      li.appendChild(el('span', 'f-name', key));
      li.appendChild(el('span', 'f-type', typeOf(field)));
      if (required.indexOf(key) >= 0) { li.appendChild(el('span', 'f-req', 'required')); }
      if (field.description) { li.appendChild(el('div', 'f-desc', field.description)); }
      if (field.enum) { li.appendChild(el('div', 'f-desc', 'One of: ' + field.enum.join(', '))); }
      var nested = field.type === 'array' ? field.items : field;
      if (nested && nested.properties && depth < 6) {
        li.appendChild(schemaTree(nested, depth + 1));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  // ---- invoke form --------------------------------------------------------
  function buildForm(tool) {
    var form = el('form', 'invoke');
    var schema = tool.inputSchema || {};
    var props = schema.properties || {};
    var required = schema.required || [];
    var keys = Object.keys(props);
    var controls = [];

    if (!keys.length) {
      form.appendChild(el('div', 'hint', 'This tool takes no declared arguments.'));
    }

    keys.forEach(function (key) {
      var field = props[key] || {};
      var type = typeOf(field);
      var wrap = el('div', 'field');
      var label = el('label', null, key + (required.indexOf(key) >= 0 ? ' *' : ''));
      var id = 'arg-' + key;
      label.setAttribute('for', id);
      wrap.appendChild(label);

      var input;
      var kind = 'scalar';
      if (field.enum) {
        input = el('select');
        if (required.indexOf(key) < 0) { input.appendChild(el('option', null, '')); }
        field.enum.forEach(function (v) {
          var o = el('option', null, String(v));
          o.value = String(v);
          input.appendChild(o);
        });
      } else if (type === 'boolean') {
        input = el('select');
        ['', 'true', 'false'].forEach(function (v) {
          var o = el('option', null, v === '' ? '(unset)' : v);
          o.value = v;
          input.appendChild(o);
        });
        kind = 'boolean';
      } else if (type === 'object' || type === 'array') {
        input = el('textarea');
        input.placeholder = type === 'array' ? '[]' : '{}';
        kind = 'json';
      } else {
        input = el('input');
        input.type = (type === 'number' || type === 'integer') ? 'number' : 'text';
        if (type === 'integer') { input.step = '1'; }
        kind = (type === 'number' || type === 'integer') ? 'number' : 'string';
      }
      input.id = id;
      wrap.appendChild(input);
      if (field.description) { wrap.appendChild(el('div', 'hint', field.description)); }
      form.appendChild(wrap);
      controls.push({ key: key, input: input, kind: kind, required: required.indexOf(key) >= 0 });
    });

    var runBtn = el('button', 'run', 'Run tools/call');
    runBtn.type = 'submit';
    form.appendChild(runBtn);
    form.appendChild(el('div', 'note', 'Sent as JSON-RPC tools/call to ' + MODEL.basePath + ' — the same endpoint any MCP client uses.'));

    var status = el('div', 'status');
    var out = el('pre', 'out');
    out.textContent = '(no response yet)';

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var args = {};
      for (var i = 0; i < controls.length; i++) {
        var c = controls[i];
        var raw = c.input.value;
        if (raw === '' || raw === null) {
          if (c.required) {
            status.className = 'status err';
            status.textContent = 'Missing required argument: ' + c.key;
            return;
          }
          continue;
        }
        if (c.kind === 'number') {
          var n = Number(raw);
          if (isNaN(n)) {
            status.className = 'status err';
            status.textContent = 'Argument ' + c.key + ' must be a number.';
            return;
          }
          args[c.key] = n;
        } else if (c.kind === 'boolean') {
          args[c.key] = raw === 'true';
        } else if (c.kind === 'json') {
          try {
            args[c.key] = JSON.parse(raw);
          } catch (e) {
            status.className = 'status err';
            status.textContent = 'Argument ' + c.key + ' is not valid JSON: ' + e.message;
            return;
          }
        } else {
          args[c.key] = raw;
        }
      }
      send(tool, args, status, out, runBtn);
    });

    var panel = document.createDocumentFragment();
    panel.appendChild(form);
    panel.appendChild(el('h3', null, 'Response'));
    panel.appendChild(status);
    panel.appendChild(out);
    return panel;
  }

  function send(tool, args, status, out, runBtn) {
    runBtn.disabled = true;
    status.className = 'status';
    status.textContent = 'Calling ' + tool.name + '…';
    out.textContent = '';
    var started = Date.now();

    fetch(MODEL.basePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: String(Date.now()),
        method: 'tools/call',
        params: { name: tool.name, arguments: args }
      })
    }).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) { body = text; }
        return { status: res.status, body: body };
      });
    }).then(function (r) {
      var ms = Date.now() - started;
      var isErr = r.body && r.body.error;
      status.className = 'status ' + (isErr ? 'err' : 'ok');
      status.textContent = (isErr ? 'Error' : 'OK') + ' · HTTP ' + r.status + ' · ' + ms + 'ms';
      out.textContent = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
    }).catch(function (e) {
      status.className = 'status err';
      status.textContent = 'Request failed: ' + e.message;
      out.textContent = String(e);
    }).then(function () {
      runBtn.disabled = false;
    });
  }

  // ---- detail -------------------------------------------------------------
  function renderDetail(name) {
    detailEl.textContent = '';
    if (!name) {
      detailEl.appendChild(el('div', 'empty', tools.length
        ? 'Select a tool to see its schema and try a call.'
        : 'This registry exposes no tools.'));
      return;
    }
    var tool = null;
    for (var i = 0; i < tools.length; i++) {
      if (tools[i].name === name) { tool = tools[i]; break; }
    }
    if (!tool) {
      detailEl.appendChild(el('div', 'empty', 'No tool named "' + name + '" in this registry.'));
      return;
    }

    detailEl.appendChild(el('h2', null, tool.name));
    detailEl.appendChild(el('p', 'desc', tool.description || 'No description provided.'));

    var meta = el('div', 'meta-row');
    meta.appendChild(el('span', tool.effects.readOnly ? 'badge badge-ro' : 'badge badge-mut',
      tool.effects.readOnly ? 'read-only' : 'mutating'));
    if (tool.effects.idempotent) { meta.appendChild(el('span', 'badge badge-flag', 'idempotent')); }
    if (tool.effects.retryable) { meta.appendChild(el('span', 'badge badge-flag', 'retryable')); }
    if (tool.effects.idempotencyKeyRequired) { meta.appendChild(el('span', 'badge badge-flag', 'idempotency-key required')); }
    (tool.effects.classifications || []).forEach(function (c) {
      meta.appendChild(el('span', 'badge badge-flag', c));
    });
    meta.appendChild(el('span', 'badge badge-flag', 'executor: ' + tool.executorType));
    meta.appendChild(el('span', 'badge badge-flag', 'id: ' + tool.id));
    detailEl.appendChild(meta);

    detailEl.appendChild(el('h3', null, 'Input schema'));
    detailEl.appendChild(schemaTree(tool.inputSchema, 0));
    detailEl.appendChild(el('h3', null, 'Output schema'));
    detailEl.appendChild(schemaTree(tool.outputSchema, 0));
    detailEl.appendChild(el('h3', null, 'Try it'));
    detailEl.appendChild(buildForm(tool));
  }

  // ---- routing ------------------------------------------------------------
  function route() {
    var raw = location.hash.replace(/^#/, '');
    current = raw ? decodeURIComponent(raw) : null;
    renderList();
    renderDetail(current);
  }

  filterEl.addEventListener('input', renderList);
  window.addEventListener('hashchange', route);
  route();
})();
`;

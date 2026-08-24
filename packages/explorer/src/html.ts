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
 *
 * ## The six panels (§56) render from data the server already decided to hand over
 *
 * The page NEVER derives a diagnostic itself. Provenance labels, the policy
 * effect, breaker states and the diff classification are all computed by the
 * builders in `panels.ts` (and, for provenance, per tool in the view model) and
 * arrive here as finished, redacted models. That is what keeps the browser
 * incapable of showing anything the server was not already willing to expose,
 * and it is why re-deriving any of it in `CLIENT_JS` would be a bug rather than
 * an optimisation — a second implementation of a precedence chain or a severity
 * rule is a second thing that can disagree with the CLI.
 *
 * The absence of an Explorer-private endpoint has one visible consequence, and
 * the page states it rather than hiding it: a control that would need fresh
 * server-side computation (picking a different snapshot pair to diff, choosing
 * a different principal) reports what the host supplied and says plainly that
 * changing it is the host's call. A dead control that looked live would be
 * worse than an honest one.
 */

import { redactExplorerModel } from '@askturret/mcp-core';
import type { ExplorerPanels, ExplorerViewModel } from './types.js';

/**
 * Render the complete Explorer HTML document.
 *
 * @param model - The view model for this registry snapshot.
 * @param panels - Optional host-supplied diagnostic panels (§56). Omitted, the
 *   page still renders every panel — in its "not supplied by the host" state,
 *   which is deliberately distinct from "supplied and empty". Panel 1
 *   (provenance) never depends on this: it travels per tool on the model.
 */
export function renderExplorerHtml(model: ExplorerViewModel, panels?: ExplorerPanels): string {
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
    <button id="diagnostics-link" class="tool-item diag-link" type="button">
      <span class="tool-name">Diagnostics</span>
      <span class="tool-desc">Principal surface · traces · breakers · version diff</span>
    </button>
    <input id="filter" type="search" placeholder="Filter tools…" autocomplete="off" aria-label="Filter tools">
    <div id="tool-list"></div>
  </nav>
  <section id="detail" aria-live="polite"></section>
</main>
<script>window.__EXPLORER__=${embedJson(model)};</script>
<script>window.__EXPLORER_PANELS__=${embedJson(panels ?? null)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Embed a value as JSON inside a <script> block.
 *
 * ## Redacted HERE, not only upstream
 *
 * §9.4 names Surface 5 as "the Explorer view model, before serialization to the
 * client", and this function IS that moment — so it redacts rather than trusting
 * that someone else did. `buildExplorerViewModel` and the panel builders each
 * redact their own output, and that is where the intent lives; this pass is what
 * survives a caller who assembled an `ExplorerPanels` by hand and handed it
 * straight to the renderer. The type permits that, and before #56 nothing on the
 * rendered path stopped it: redaction lived only in the builders, which a
 * hand-built panel set never visits. Redaction is idempotent — `[REDACTED]`
 * redacts to itself — so the extra pass costs nothing and removes the question.
 *
 * ## Escaping
 *
 * `</script` inside a string would close the block early, and U+2028/U+2029 are
 * literal line terminators in JS source but legal inside a JSON string, so both
 * must be escaped. Tool names, descriptions and schemas come from adopter specs
 * — untrusted enough to warrant this.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(redactExplorerModel(value))
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
.diag-link{border:1px solid var(--line);margin-bottom:10px;border-left:3px solid transparent}
.diag-link.active{background:#eaf2fb;border-left-color:var(--accent)}
.panel-empty{color:var(--muted);font-size:12px;background:var(--code);border:1px dashed var(--line);border-radius:6px;padding:10px 12px}
table.panel-table{border-collapse:collapse;width:100%;font-size:12px}
table.panel-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--line);padding:4px 8px 4px 0;font-weight:600}
table.panel-table td{padding:5px 8px 5px 0;border-bottom:1px solid var(--line);vertical-align:top}
table.panel-table tr.overlay-row{background:#fdf7ec}
table.panel-table tr.overlay-row td:first-child{box-shadow:inset 3px 0 0 var(--mut)}
.badge-overlay{background:#fdf1dc;color:var(--mut);border:1px solid #f0dcb8}
.badge-allow{background:#e6f5ee;color:var(--ro)}
.badge-deny{background:#fbeaea;color:#b32d2d}
.sev-breaking{background:#fbeaea;color:#b32d2d}
.sev-double-check,.sev-ambiguous{background:#fdf1dc;color:var(--mut)}
.sev-non-breaking{background:#e6f5ee;color:var(--ro)}
.kv{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 10px}
.kv div{display:flex;flex-direction:column}
.kv dt{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.kv dd{margin:0;font-size:13px}
.meter{display:block;width:120px;height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.meter>span{display:block;height:100%;background:var(--accent)}
.meter.full>span{background:#b32d2d}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.diff-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:10px}
.diff-controls select{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:#fff;max-width:34ch}
.panel-warn{color:var(--mut);font-size:12px;background:#fdf7ec;border:1px solid #f0dcb8;border-radius:6px;padding:8px 10px;margin-top:8px}
.refresh-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:8px}
.refresh-reason{color:var(--mut);background:#fdf1dc;border:1px solid #f0dcb8;border-radius:3px;padding:2px 6px}
pre.attrs{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin:4px 0 0;font-size:11px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word}
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
  var PANELS = window.__EXPLORER_PANELS__ || null;
  var DIAGNOSTICS_ROUTE = '!diagnostics';
  var tools = MODEL.tools || [];
  var listEl = document.getElementById('tool-list');
  var detailEl = document.getElementById('detail');
  var filterEl = document.getElementById('filter');
  var diagLinkEl = document.getElementById('diagnostics-link');
  var current = null;
  var refreshTimer = null;
  // Panel 6 shares a route with panel 5's poll and has to be able to disarm it,
  // so the toggle and its reason line are held here rather than staying closed
  // over by renderRuntime. Cleared by route(), which is the one teardown point.
  var refreshControls = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }

  // A panel that has nothing to show says WHY. "Not wired" and "wired, nothing
  // recorded" look identical otherwise, and sending an operator hunting for
  // requests that were never recorded is the failure this exists to prevent.
  function notSupplied(text) {
    return el('div', 'panel-empty', text);
  }

  function badge(cls, text) {
    return el('span', 'badge ' + cls, text);
  }

  function table(headers) {
    var t = el('table', 'panel-table');
    var head = el('thead');
    var hr = el('tr');
    headers.forEach(function (h) { hr.appendChild(el('th', null, h)); });
    head.appendChild(hr);
    t.appendChild(head);
    // Rows go in an explicit tbody: createElement does not get the one the
    // HTML parser would have inserted, and a <tr> parented by <table> is not
    // something every engine lays out.
    var body = el('tbody');
    t.appendChild(body);
    t.body = body;
    return t;
  }

  function kv(pairs) {
    var dl = el('dl', 'kv');
    pairs.forEach(function (p) {
      var wrap = el('div');
      wrap.appendChild(el('dt', null, p[0]));
      wrap.appendChild(el('dd', null, p[1]));
      dl.appendChild(wrap);
    });
    return dl;
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

  // ---- panel 1: provenance / precedence -----------------------------------
  //
  // Every label here is read off the model. The page never ranks anything: the
  // precedence string was resolved by the compiler and mirrored by
  // buildProvenanceView, and re-deriving it in the browser would be a second
  // implementation of §5.3 free to disagree with the one that actually ran.
  function renderProvenance(tool) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Provenance'));
    var p = tool.provenance;
    if (!p || !p.available) {
      frag.appendChild(notSupplied('This operation records no provenance. That is not the same as ' +
        '"every field came from the source" \\u2014 nothing tracked where these fields came from, so ' +
        'there is nothing to explain.'));
      return frag;
    }

    var row = el('div', 'meta-row');
    row.appendChild(badge('badge-flag', p.fields.length + (p.fields.length === 1 ? ' field' : ' fields')));
    row.appendChild(badge(p.overlayModifiedCount > 0 ? 'badge-overlay' : 'badge-flag',
      p.overlayModifiedCount + ' overlay-modified'));
    frag.appendChild(row);

    var t = table(['Field', 'Precedence applied', 'Source', 'Location']);
    p.fields.forEach(function (f) {
      var tr = el('tr', f.overlayModified ? 'overlay-row' : null);
      // §56 asks for hover to show the precedence chain applied to the field.
      tr.title = f.field + ' \\u2190 ' + f.precedence + (f.location ? ' (' + f.location + ')' : '');
      var nameCell = el('td', 'f-name', f.field);
      // The overlay highlight is driven by the model's own flag, so what is
      // highlighted and what is explained cannot drift apart.
      if (f.overlayModified) { nameCell.appendChild(badge('badge-overlay', 'overlay')); }
      tr.appendChild(nameCell);
      tr.appendChild(el('td', null, f.precedence));
      tr.appendChild(el('td', 'mono', f.kind));
      tr.appendChild(el('td', 'mono f-desc', f.location || '\\u2014'));
      t.body.appendChild(tr);
    });
    frag.appendChild(t);
    return frag;
  }

  // ---- panel 2: policy explanation ----------------------------------------
  function renderPolicy(tool) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Policy explanation'));
    var p = PANELS && PANELS.policy;
    if (!p) {
      frag.appendChild(notSupplied('No policy explanation supplied by the host. The effective policy ' +
        'tree is evaluated against a principal by the server\\u2019s policy engine \\u2014 the Explorer ' +
        'never evaluates policy itself, so it can only show a decision the server already made.'));
      return frag;
    }
    if (p.operationId !== tool.id) {
      frag.appendChild(notSupplied('The supplied policy explanation is for "' + p.operationId +
        '", not this tool.'));
      return frag;
    }

    var row = el('div', 'meta-row');
    row.appendChild(badge(p.denied ? 'badge-deny' : 'badge-allow', p.effect));
    row.appendChild(badge('badge-flag', 'policy: ' + p.policy));
    if (p.code) { row.appendChild(badge('badge-flag', p.code)); }
    frag.appendChild(row);
    if (p.reason) { frag.appendChild(el('p', 'desc', p.reason)); }

    if (!p.evidence.length) {
      frag.appendChild(notSupplied('The decision carries no evidence entries.'));
      return frag;
    }
    var t = table(['Policy', 'Claim', 'Detail']);
    p.evidence.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', e.policyId));
      tr.appendChild(el('td', null, e.claim));
      tr.appendChild(el('td', 'f-desc', e.detail || '\\u2014'));
      t.body.appendChild(tr);
    });
    frag.appendChild(t);
    return frag;
  }

  // ---- panel 3: principal-aware effective surface -------------------------
  function renderPrincipalSurface() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Principal-aware effective surface'));
    var p = PANELS && PANELS.principalSurface;
    if (!p) {
      frag.appendChild(notSupplied('No principal surface supplied by the host. Re-running ' +
        'visibleOperations() for a chosen principal needs the policy engine, which lives on the ' +
        'server \\u2014 supply this panel to answer "why can\\u2019t customer X see this tool?".'));
      return frag;
    }

    frag.appendChild(kv([
      ['Principal', p.principal.anonymous ? 'anonymous' : (p.principal.type || 'unknown type')],
      ['Visible', p.visible.length + ' of ' + p.totalCount],
      ['Hidden', String(p.hidden.length)],
    ]));

    var perms = el('div', 'meta-row');
    if (!p.principal.permissions.length) {
      perms.appendChild(badge('badge-flag', 'no permissions'));
    } else {
      p.principal.permissions.forEach(function (name) { perms.appendChild(badge('badge-flag', name)); });
    }
    frag.appendChild(perms);
    // Stated on the page, not just in the type: an operator who cannot see an
    // identifier here should know that is a choice rather than missing data.
    frag.appendChild(el('div', 'note', 'Permission names and principal type only \\u2014 the principal ' +
      'id is deliberately never rendered.'));

    var cols = el('div', 'two-col');
    [['Visible', p.visible], ['Hidden', p.hidden]].forEach(function (pair) {
      var col = el('div');
      col.appendChild(el('h3', null, pair[0]));
      if (!pair[1].length) {
        col.appendChild(notSupplied('None.'));
      } else {
        var t = table(['Tool', 'Operation id']);
        pair[1].forEach(function (item) {
          var tr = el('tr');
          tr.appendChild(el('td', 'f-name', item.name));
          tr.appendChild(el('td', 'mono f-desc', item.id));
          t.body.appendChild(tr);
        });
        col.appendChild(t);
      }
      cols.appendChild(col);
    });
    frag.appendChild(cols);
    return frag;
  }

  // ---- panel 4: traces ----------------------------------------------------
  function renderTraces() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Recent requests'));
    var p = PANELS && PANELS.traces;
    if (!p) {
      frag.appendChild(notSupplied('No trace panel supplied by the host.'));
      return frag;
    }
    if (!p.available) {
      frag.appendChild(notSupplied(p.reason || 'No span buffer is configured.'));
      return frag;
    }
    if (!p.spans.length) {
      // Reachable only when a buffer IS wired — which is why it can say this.
      frag.appendChild(notSupplied('The span buffer is wired and holds no spans yet.'));
      return frag;
    }

    var t = table(['Span', 'Outcome', 'Started', 'Duration', 'Attributes']);
    p.spans.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', 'f-name', s.name));
      tr.appendChild(el('td', null, s.outcome || '\\u2014'));
      tr.appendChild(el('td', 'mono f-desc', s.startedAt));
      tr.appendChild(el('td', 'mono', s.durationMs === undefined ? '\\u2014' : s.durationMs + 'ms'));
      var attrs = el('td');
      attrs.appendChild(el('pre', 'attrs', JSON.stringify(s.attributes, null, 2)));
      tr.appendChild(attrs);
      t.body.appendChild(tr);
    });
    frag.appendChild(t);
    return frag;
  }

  // ---- panel 5: breaker / bulkhead state ----------------------------------
  function renderRuntime() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Breakers and bulkheads'));
    var p = PANELS && PANELS.runtime;
    if (!p) {
      frag.appendChild(notSupplied('No runtime panel supplied by the host.'));
      return frag;
    }

    // The refresh strategy is read off the model rather than hardcoded here,
    // so the page cannot claim one thing while the docs claim another.
    var refresh = el('div', 'refresh-row');
    var toggle = el('input');
    toggle.type = 'checkbox';
    toggle.id = 'auto-refresh';
    toggle.checked = true;
    var label = el('label', null, 'Auto-refresh every ' + p.pollIntervalMs + 'ms (' +
      p.refreshStrategy + ')');
    label.setAttribute('for', 'auto-refresh');
    var reason = el('span', 'refresh-reason');
    reason.id = 'auto-refresh-reason';
    reason.style.display = 'none';
    refresh.appendChild(toggle);
    refresh.appendChild(label);
    refresh.appendChild(reason);
    frag.appendChild(refresh);
    refreshControls = { toggle: toggle, reason: reason };
    toggle.addEventListener('change', function () {
      // Whatever the reason said, the operator has now overridden it by hand.
      clearRefreshReason();
      if (toggle.checked) { startRefresh(p.pollIntervalMs); } else { stopRefresh(); }
    });
    startRefresh(p.pollIntervalMs);

    if (!p.breakersConfigured) {
      // NOT "all closed". A row of green for a server with no breakers at all
      // is the reassuring lie this distinction exists to prevent.
      frag.appendChild(notSupplied('No circuit breakers are configured. Breakers are opt-in \\u2014 ' +
        'this is not the same as every breaker being closed.'));
    } else {
      var bt = table(['Breaker', 'State', 'Failures']);
      p.breakers.forEach(function (b) {
        var tr = el('tr');
        tr.appendChild(el('td', 'f-name', b.name));
        var state = el('td');
        state.appendChild(badge(b.state === 'closed' ? 'badge-allow' : 'badge-deny', b.state));
        tr.appendChild(state);
        tr.appendChild(el('td', 'mono', b.failures === undefined ? '\\u2014' : b.failures));
        bt.body.appendChild(tr);
      });
      frag.appendChild(bt);
    }

    frag.appendChild(el('h3', null, 'Bulkheads'));
    if (!p.bulkheadsConfigured) {
      frag.appendChild(notSupplied('No bulkheads are configured.'));
      return frag;
    }
    var kt = table(['Bulkhead', 'In flight', 'Queued', 'Saturation']);
    p.bulkheads.forEach(function (b) {
      var tr = el('tr');
      tr.appendChild(el('td', 'f-name', b.name));
      tr.appendChild(el('td', 'mono', (b.inFlight === undefined ? '\\u2014' : b.inFlight) +
        (b.concurrency === undefined ? '' : ' / ' + b.concurrency)));
      tr.appendChild(el('td', 'mono', (b.queued === undefined ? '\\u2014' : b.queued) +
        (b.queueSize === undefined ? '' : ' / ' + b.queueSize)));
      var gauge = el('td');
      if (b.inFlight !== undefined && b.concurrency) {
        var ratio = Math.min(1, b.inFlight / b.concurrency);
        var meter = el('span', ratio >= 1 ? 'meter full' : 'meter');
        var fill = el('span');
        fill.style.width = Math.round(ratio * 100) + '%';
        meter.appendChild(fill);
        meter.title = b.inFlight + ' of ' + b.concurrency + ' slots in use';
        gauge.appendChild(meter);
      } else {
        gauge.textContent = '\\u2014';
      }
      tr.appendChild(gauge);
      kt.body.appendChild(tr);
    });
    frag.appendChild(kt);
    return frag;
  }

  // Polling, not SSE — an open connection per open tab, on the server whose
  // bulkheads this panel exists to watch, is a diagnostic that consumes the
  // resource it measures. Reloading the document is the only poll available:
  // the Explorer has no private endpoint, by design. It runs ONLY while the
  // diagnostics view is open, so it can never interrupt a half-typed invoke
  // form on a tool page.
  function startRefresh(intervalMs) {
    stopRefresh();
    refreshTimer = window.setTimeout(function () { location.reload(); }, intervalMs);
  }

  function stopRefresh() {
    if (refreshTimer !== null) { window.clearTimeout(refreshTimer); refreshTimer = null; }
  }

  function clearRefreshReason() {
    if (!refreshControls) { return; }
    refreshControls.reason.textContent = '';
    refreshControls.reason.style.display = 'none';
  }

  // An operator's in-progress work outranks a background refresh. route()
  // already applies that rule when they navigate AWAY; this applies it when
  // they start using the route the poll is already on. The mechanism above is
  // location.reload(), so the poll does not merely refetch — it destroys every
  // piece of client state on the route, a snapshot selection included.
  //
  // Unticking the box is part of the fix, not decoration: a control reading
  // "Auto-refresh every 2000ms" while nothing refreshes is the page asserting
  // something untrue about itself, which is the failure this file already
  // argues against twice. The reason line makes the pause discoverable, since
  // an unexplained stop is a smaller version of the unexplained revert.
  function pauseRefresh(text) {
    // Only claim to have paused something that was actually running. If the
    // operator had already unticked the box, the selector change is not what
    // stopped the poll and saying so would be its own small lie.
    var wasArmed = refreshTimer !== null;
    stopRefresh();
    if (!refreshControls || !wasArmed) { return; }
    refreshControls.toggle.checked = false;
    refreshControls.reason.textContent = text;
    refreshControls.reason.style.display = '';
  }

  // ---- panel 6: version diff ----------------------------------------------
  function renderDiff() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Version diff'));
    var p = PANELS && PANELS.diff;
    if (!p) {
      frag.appendChild(notSupplied('No diff panel supplied by the host.'));
      return frag;
    }
    if (!p.available) {
      frag.appendChild(notSupplied(p.reason || 'Not enough retained snapshots to diff.'));
      if (p.snapshots.length) { frag.appendChild(snapshotTable(p.snapshots)); }
      return frag;
    }

    var controls = el('div', 'diff-controls');
    var selects = {};
    [['before', 'Before'], ['after', 'After']].forEach(function (pair) {
      var wrap = el('div', 'field');
      var sel = el('select');
      sel.id = 'diff-' + pair[0];
      var lab = el('label', null, pair[1]);
      lab.setAttribute('for', sel.id);
      p.snapshots.forEach(function (s) {
        var o = el('option', null, 'v' + s.version + ' \\u00b7 ' + s.hash);
        o.value = s.hash;
        sel.appendChild(o);
      });
      if (p.comparing) { sel.value = p.comparing[pair[0]].hash; }
      wrap.appendChild(lab);
      wrap.appendChild(sel);
      controls.appendChild(wrap);
      selects[pair[0]] = sel;
    });
    frag.appendChild(controls);

    // The selector is honest rather than live. Reclassifying another pair is
    // work the server does with the same diffSnapshots the CLI calls; the page
    // never recomputes a classification, so it says when the selection is not
    // the diff on screen instead of silently relabelling this one.
    var warn = el('div', 'panel-warn');
    frag.appendChild(warn);
    function syncWarning() {
      if (!p.comparing) { warn.style.display = 'none'; return; }
      var matches = selects.before.value === p.comparing.before.hash &&
                    selects.after.value === p.comparing.after.hash;
      warn.style.display = matches ? 'none' : '';
      warn.textContent = 'Showing the host-supplied diff v' + p.comparing.before.version + ' \\u2192 v' +
        p.comparing.after.version + '. The changes below are NOT for the pair you selected \\u2014 the ' +
        'Explorer has no private endpoint and never reclassifies a diff itself; ask the host to supply ' +
        'that pair.';
    }
    // Touching either selector is the operator starting work on this route, so
    // it disarms panel 5's poll. Without this, the selection and the warning
    // above are both wiped by a reload about pollIntervalMs later, leaving the
    // page showing one pair while the operator believes they chose another.
    function onSelectionChange() {
      syncWarning();
      pauseRefresh('paused: you changed the snapshot selection');
    }
    selects.before.addEventListener('change', onSelectionChange);
    selects.after.addEventListener('change', onSelectionChange);
    syncWarning();

    if (p.summary) {
      frag.appendChild(kv([
        ['Breaking', String(p.summary.breaking)],
        ['Non-breaking', String(p.summary.nonBreaking)],
        ['Double-check', String(p.summary.doubleCheck)],
        ['Ambiguous', String(p.summary.ambiguous)],
      ]));
    }

    if (!p.changes.length) {
      frag.appendChild(notSupplied('No changes between these snapshots.'));
    } else {
      var t = table(['Severity', 'Code', 'Operation', 'Detail']);
      p.changes.forEach(function (c) {
        var tr = el('tr');
        var sev = el('td');
        // The severity class comes from the classification the CLI produced.
        sev.appendChild(badge('sev-' + c.severity, c.severity));
        tr.appendChild(sev);
        tr.appendChild(el('td', 'mono', c.code));
        tr.appendChild(el('td', 'mono f-desc', c.operationId || '\\u2014'));
        tr.appendChild(el('td', null, c.detail || '\\u2014'));
        t.body.appendChild(tr);
      });
      frag.appendChild(t);
    }
    frag.appendChild(snapshotTable(p.snapshots));
    return frag;
  }

  function snapshotTable(snapshots) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('h3', null, 'Retained snapshots'));
    var t = table(['Version', 'Hash', 'Created', 'Tools']);
    snapshots.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', 'v' + s.version));
      tr.appendChild(el('td', 'mono f-desc', s.hash));
      tr.appendChild(el('td', 'mono f-desc', s.createdAt));
      tr.appendChild(el('td', 'mono', s.toolCount));
      t.body.appendChild(tr);
    });
    frag.appendChild(t);
    return frag;
  }

  // ---- diagnostics view ---------------------------------------------------
  function renderDiagnostics() {
    detailEl.appendChild(el('h2', null, 'Diagnostics'));
    detailEl.appendChild(el('p', 'desc', 'The operator diagnostic surface \\u2014 the same data the ' +
      'diagnostics bundle carries offline. Every panel below is computed on the server and redacted ' +
      'before it reaches this page.'));
    if (!PANELS) {
      detailEl.appendChild(notSupplied('This server rendered the Explorer without diagnostic panels. ' +
        'Pass them to renderExplorerHtml() to populate the principal surface, traces, breaker state ' +
        'and version diff. Per-tool provenance is on the tool pages and needs nothing extra.'));
      return;
    }
    detailEl.appendChild(renderPrincipalSurface());
    detailEl.appendChild(renderTraces());
    detailEl.appendChild(renderRuntime());
    detailEl.appendChild(renderDiff());
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
    // Panels 1 and 2 are per-tool, so they belong on the tool page rather than
    // in Diagnostics — the question they answer is "where did THIS field come
    // from" and "why is THIS tool denied".
    detailEl.appendChild(renderProvenance(tool));
    detailEl.appendChild(renderPolicy(tool));
    detailEl.appendChild(el('h3', null, 'Try it'));
    detailEl.appendChild(buildForm(tool));
  }

  // ---- routing ------------------------------------------------------------
  function route() {
    // Any navigation cancels the diagnostics poll; renderRuntime re-arms it if
    // diagnostics is where we landed. A timer that outlived its view would
    // reload the page out from under an operator filling in an invoke form.
    stopRefresh();
    // The controls belong to the view being torn down. Dropping the reference
    // here keeps a later pauseRefresh() from writing into a detached element
    // when the next view has no panel 5 to re-register one.
    refreshControls = null;
    var raw = location.hash.replace(/^#/, '');
    current = raw ? decodeURIComponent(raw) : null;
    renderList();
    detailEl.textContent = '';
    if (current === DIAGNOSTICS_ROUTE) {
      diagLinkEl.classList.add('active');
      renderDiagnostics();
      return;
    }
    diagLinkEl.classList.remove('active');
    renderDetail(current);
  }

  filterEl.addEventListener('input', renderList);
  diagLinkEl.addEventListener('click', function () {
    location.hash = '#' + DIAGNOSTICS_ROUTE;
  });
  window.addEventListener('hashchange', route);
  route();
})();
`;

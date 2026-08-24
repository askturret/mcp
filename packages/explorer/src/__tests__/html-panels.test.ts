// SPDX-License-Identifier: Apache-2.0
/**
 * Rendered-panel tests (#56).
 *
 * ## These tests RUN the page, they do not grep it
 *
 * The Explorer renders client-side, so asserting that the served HTML string
 * "contains Provenance" would pass just as happily against a template that
 * reads the wrong field, drops a panel, or throws on the first tool click. That
 * is a decorative guard: it watches the shipping label, not the parcel.
 *
 * So the document's scripts are executed in a `vm` context against the small
 * DOM below, and the assertions read the resulting element tree. The stub is
 * deliberately dumb — `createElement`, `appendChild`, `textContent`,
 * `classList` — and knows nothing about provenance, policy or breakers, so it
 * cannot quietly agree with a renderer that is wrong.
 *
 * ## Why a hand-written stub rather than jsdom
 *
 * No DOM implementation is present in this workspace, and adding one is not a
 * free call: it is a large dependency tree arriving in a repo that runs an SBOM
 * and license review (#24) and a NOTICE check. Pulling that in as a side effect
 * of a UI change is a decision for its own PR, not a footnote in this one. The
 * stub covers exactly the surface `CLIENT_JS` touches and nothing more.
 *
 * What this does NOT cover, stated rather than implied: real layout, CSS, and
 * genuine browser event dispatch. A panel that renders the right text into an
 * invisible element would pass here. That gap is the smoke test's, not this
 * file's.
 */

import { describe, it, expect } from '@jest/globals';
import { createContext, runInContext } from 'node:vm';
import type {
  EffectMetadata,
  OperationDefinition,
  RegistrySnapshot,
} from '@askturret/mcp-core';

import { buildExplorerViewModel } from '../view-model.js';
import { renderExplorerHtml } from '../html.js';
import type { ExplorerPanels } from '../types.js';

// ===========================================================================
// A DOM small enough to read in one sitting
// ===========================================================================

interface Listener {
  (event?: unknown): void;
}

class StubElement {
  public className = '';
  public title = '';
  public type = '';
  public value = '';
  public placeholder = '';
  public step = '';
  public checked = false;
  public disabled = false;
  public href = '';
  public style: Record<string, string> = {};
  public children: StubElement[] = [];
  public attributes: Record<string, string> = {};
  private listeners = new Map<string, Listener[]>();
  private ownText = '';
  private idValue = '';

  public constructor(
    public readonly tagName: string,
    private readonly ids: Map<string, StubElement>,
  ) {}

  public get id(): string {
    return this.idValue;
  }

  public set id(value: string) {
    this.idValue = value;
    this.ids.set(value, this);
  }

  /** Aggregates descendants, exactly as the real accessor does. */
  public get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  public set textContent(value: string) {
    this.children = [];
    this.ownText = value;
  }

  public appendChild(child: StubElement): StubElement {
    if (child.tagName === '#fragment') {
      // A fragment empties into its new parent rather than nesting.
      for (const grandchild of child.children) {
        this.children.push(grandchild);
      }
      child.children = [];
      return child;
    }
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public addEventListener(type: string, fn: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  public dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ preventDefault: () => undefined });
    }
  }

  public get classList(): {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  } {
    return {
      add: (name: string) => {
        if (!this.classList.contains(name)) {
          this.className = this.className ? `${this.className} ${name}` : name;
        }
      },
      remove: (name: string) => {
        this.className = this.className
          .split(/\s+/)
          .filter((part) => part !== name && part !== '')
          .join(' ');
      },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
  }

  /** Every element in this subtree, self first. */
  public flatten(): StubElement[] {
    return this.children.reduce<StubElement[]>(
      (all, child) => all.concat(child.flatten()),
      [this as StubElement],
    );
  }
}

interface Page {
  detail: StubElement;
  nav: StubElement;
  diagnosticsLink: StubElement;
  /** Navigate as the page's own hashchange listener would see it. */
  go: (hash: string) => void;
  pendingTimers: () => number;
  /** Run every recorded timer exactly once; returns how many ran. */
  fireTimers: () => number;
  reloads: () => number;
  detailText: () => string;
  find: (predicate: (el: StubElement) => boolean) => StubElement | undefined;
}

/**
 * Execute the document's scripts and hand back the resulting page.
 *
 * Every `<script>` body is run in ONE context, in document order, so the client
 * script sees the embedded models exactly as a browser would — including the
 * escaping `embedJson` applied on the way in.
 */
function mount(html: string): Page {
  const ids = new Map<string, StubElement>();
  const make = (tag: string): StubElement => new StubElement(tag, ids);

  // The static markup the client script reaches for by id.
  for (const id of [
    'meta-hash',
    'meta-version',
    'meta-created',
    'meta-count',
    'filter',
    'tool-list',
    'detail',
    'diagnostics-link',
  ]) {
    make('div').id = id;
  }

  const windowListeners = new Map<string, Listener[]>();
  let timerSeq = 0;
  const timers = new Map<number, Listener>();
  let reloads = 0;

  const location = {
    _hash: '',
    get hash(): string {
      return this._hash;
    },
    set hash(value: string) {
      this._hash = value;
      for (const fn of windowListeners.get('hashchange') ?? []) fn();
    },
    reload: () => {
      reloads += 1;
    },
  };

  const windowStub = {
    addEventListener: (type: string, fn: Listener) => {
      const existing = windowListeners.get(type) ?? [];
      existing.push(fn);
      windowListeners.set(type, existing);
    },
    // Timers are RECORDED rather than run on a schedule: the refresh poll
    // reloads the document and re-arms itself, so firing it REPEATEDLY would
    // be an infinite loop rather than a signal.
    //
    // Firing once is not that hazard, and `fireTimers()` below does exactly
    // that. The consequences of the poll — that it reloads, and whether it is
    // still armed to — are only observable by running it, so "never fired"
    // would leave the thing worth asserting untestable.
    setTimeout: (fn: Listener) => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimeout: (handle: number) => {
      timers.delete(handle);
    },
  };

  const documentStub = {
    createElement: (tag: string) => make(tag),
    createDocumentFragment: () => make('#fragment'),
    getElementById: (id: string) => ids.get(id) ?? null,
  };

  const context = createContext({
    window: windowStub,
    document: documentStub,
    location,
    fetch: () => Promise.reject(new Error('not exercised')),
    console,
  });

  // Non-greedy: the client script contains no `</script`, and `embedJson`
  // escapes `<`/`>` out of the embedded models, so this cannot split early.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  expect(scripts).toHaveLength(3);
  for (const script of scripts) {
    runInContext(script, context);
  }

  const detail = ids.get('detail') as StubElement;
  return {
    detail,
    nav: ids.get('tool-list') as StubElement,
    diagnosticsLink: ids.get('diagnostics-link') as StubElement,
    go: (hash: string) => {
      location.hash = hash;
    },
    pendingTimers: () => timers.size,
    // Drained before running, so a callback that re-arms the poll records a
    // NEW timer rather than being re-fired inside this pass.
    fireTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
      return due.length;
    },
    reloads: () => reloads,
    detailText: () => detail.textContent,
    find: (predicate) => detail.flatten().find(predicate),
  };
}

// ===========================================================================
// Fixtures
// ===========================================================================

const EFFECTS: EffectMetadata = {
  readOnly: true,
  idempotent: true,
  retryable: true,
  idempotencyKeyRequired: false,
  classifications: [],
};

function op(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'listPets',
    name: 'listPets',
    description: 'List all pets',
    input: { type: 'object', properties: { limit: { type: 'integer' } } },
    output: { type: 'object', properties: {} },
    effects: EFFECTS,
    executor: { type: 'http', config: {} },
    provenance: [
      { field: 'description', kind: 'overlay', location: 'overlay.yaml#/listPets' },
      { field: 'effects.readOnly', kind: 'inference' },
    ],
    ...overrides,
  } as OperationDefinition;
}

function snapshot(ops: OperationDefinition[]): RegistrySnapshot {
  return {
    hash: 'sha256:abc123',
    version: 7,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    operations: new Map(ops.map((o) => [o.id, o])),
  };
}

function panels(overrides: Partial<ExplorerPanels> = {}): ExplorerPanels {
  return {
    principalSurface: {
      principal: { anonymous: false, type: 'service', permissions: ['pets:read'] },
      visible: [{ id: 'listPets', name: 'listPets' }],
      hidden: [{ id: 'deletePet', name: 'deletePet' }],
      totalCount: 2,
    },
    traces: {
      available: true,
      spans: [
        {
          name: 'mcp.tools.call',
          attributes: { 'mcp.tool.name': 'listPets' },
          outcome: 'ok',
          startedAt: '2026-01-02T03:04:05.000Z',
          durationMs: 12,
        },
      ],
    },
    runtime: {
      breakersConfigured: true,
      bulkheadsConfigured: true,
      breakers: [{ name: 'upstream', state: 'open', failures: 5 }],
      bulkheads: [{ name: 'upstream', inFlight: 2, concurrency: 4, queued: 0, queueSize: 8 }],
      pollIntervalMs: 2000,
      refreshStrategy: 'polling',
    },
    diff: {
      available: true,
      comparing: {
        before: { version: 6, hash: 'sha256:before' },
        after: { version: 7, hash: 'sha256:after' },
      },
      snapshots: [
        { hash: 'sha256:before', version: 6, createdAt: '2026-01-01T00:00:00.000Z', toolCount: 2 },
        { hash: 'sha256:after', version: 7, createdAt: '2026-01-02T00:00:00.000Z', toolCount: 1 },
        { hash: 'sha256:older', version: 5, createdAt: '2025-12-31T00:00:00.000Z', toolCount: 3 },
      ],
      changes: [
        {
          code: 'operation-removed',
          severity: 'breaking',
          operationId: 'deletePet',
          detail: 'deletePet was removed',
        },
      ],
      summary: { breaking: 1, nonBreaking: 0, doubleCheck: 0, ambiguous: 0 },
    },
    ...overrides,
  };
}

/**
 * `null` means "the host supplied nothing", NOT "use the default".
 *
 * A default parameter cannot express that: passing `undefined` selects the
 * default, so `page(ops, undefined)` would have quietly rendered the full panel
 * set while claiming to test the empty one. It did, until this was fixed.
 */
function page(ops: OperationDefinition[] = [op()], supplied: ExplorerPanels | null = panels()): Page {
  const model = buildExplorerViewModel(snapshot(ops), '/mcp');
  return mount(
    supplied === null ? renderExplorerHtml(model) : renderExplorerHtml(model, supplied),
  );
}

// ===========================================================================
// Panel 1 — provenance
// ===========================================================================

describe('panel 1 — provenance', () => {
  it('renders one row per recorded field with the precedence the compiler applied', () => {
    const p = page();
    p.go('#listPets');

    const text = p.detailText();
    expect(text).toContain('Provenance');
    expect(text).toContain('description');
    expect(text).toContain('2 · MCP overlay');
    expect(text).toContain('5 · conservative inference');
    expect(text).toContain('overlay.yaml#/listPets');
  });

  it('highlights the overlay-modified field and leaves the source-derived one alone', () => {
    const p = page();
    p.go('#listPets');

    const rows = p.detail.flatten().filter((el) => el.tagName === 'tr');
    const overlayRows = rows.filter((r) => r.className.includes('overlay-row'));
    expect(overlayRows).toHaveLength(1);
    expect(overlayRows[0]?.textContent).toContain('description');
    // The inferred field must NOT be highlighted — a UI that flagged everything
    // would answer "what deviates from the source?" with "everything".
    expect(rows.some((r) => r.textContent.includes('effects.readOnly'))).toBe(true);
    expect(overlayRows[0]?.textContent).not.toContain('effects.readOnly');
  });

  it('puts the precedence chain on hover, as §56 asks', () => {
    const p = page();
    p.go('#listPets');

    const hovered = p.find((el) => el.title.startsWith('description'));
    expect(hovered?.title).toBe('description ← 2 · MCP overlay (overlay.yaml#/listPets)');
  });

  it('says an operation records NO provenance rather than showing an empty table', () => {
    const p = page([op({ provenance: [] } as Partial<OperationDefinition>)]);
    p.go('#listPets');

    const text = p.detailText();
    expect(text).toContain('records no provenance');
    // The distinction is the point: absent tracking is not "all from source".
    expect(text).toContain('every field came from the source');
  });

  it('renders with NO host panels at all — panel 1 never depends on the host', () => {
    const p = page([op()], null);
    p.go('#listPets');

    expect(p.detailText()).toContain('2 · MCP overlay');
  });
});

// ===========================================================================
// Panel 2 — policy explanation
// ===========================================================================

describe('panel 2 — policy explanation', () => {
  it('renders the effect, the deciding policy and every evidence entry', () => {
    const p = page([op()], panels({
      policy: {
        operationId: 'listPets',
        policy: 'tenant-scope',
        effect: 'deny',
        code: 'POLICY_DENIED',
        reason: 'principal lacks pets:read',
        evidence: [{ policyId: 'tenant-scope', claim: 'permission-missing', detail: 'pets:read' }],
        denied: true,
      },
    }));
    p.go('#listPets');

    const text = p.detailText();
    expect(text).toContain('deny');
    expect(text).toContain('tenant-scope');
    expect(text).toContain('POLICY_DENIED');
    expect(text).toContain('permission-missing');
    expect(text).toContain('pets:read');
  });

  it('says the host supplied nothing rather than rendering an implicit allow', () => {
    const p = page();
    p.go('#listPets');

    const text = p.detailText();
    expect(text).toContain('No policy explanation supplied');
    // Silence on a policy panel reads as "nothing is blocked". It must not.
    expect(text).not.toContain('allow');
  });

  it('refuses to show another operation’s decision under this tool', () => {
    const p = page([op()], panels({
      policy: {
        operationId: 'deletePet',
        policy: 'tenant-scope',
        effect: 'deny',
        evidence: [],
        denied: true,
      },
    }));
    p.go('#listPets');

    expect(p.detailText()).toContain('is for "deletePet", not this tool');
  });
});

// ===========================================================================
// Panels 3–6 — the diagnostics view
// ===========================================================================

describe('diagnostics view', () => {
  it('renders principal surface, traces, breakers and diff together', () => {
    const p = page();
    p.go('#!diagnostics');

    const text = p.detailText();
    expect(text).toContain('Principal-aware effective surface');
    expect(text).toContain('pets:read');
    expect(text).toContain('deletePet'); // hidden side answers "why can't X see it?"
    expect(text).toContain('mcp.tools.call');
    expect(text).toContain('Breakers and bulkheads');
    expect(text).toContain('open');
    expect(text).toContain('deletePet was removed');
    expect(text).toContain('breaking');
  });

  it('never renders a principal id', () => {
    const p = page([op()], panels({
      principalSurface: {
        principal: { anonymous: false, type: 'user', permissions: ['pets:read'] },
        visible: [],
        hidden: [],
        totalCount: 0,
      },
    }));
    p.go('#!diagnostics');

    expect(p.detailText()).toContain('principal id is deliberately never rendered');
  });

  it('distinguishes "no span buffer wired" from "wired and empty"', () => {
    const unwired = page([op()], panels({
      traces: { available: false, reason: 'No span buffer is configured.', spans: [] },
    }));
    unwired.go('#!diagnostics');
    expect(unwired.detailText()).toContain('No span buffer is configured');
    expect(unwired.detailText()).not.toContain('holds no spans yet');

    const wired = page([op()], panels({ traces: { available: true, spans: [] } }));
    wired.go('#!diagnostics');
    expect(wired.detailText()).toContain('holds no spans yet');
  });

  it('distinguishes "no breakers configured" from "all breakers closed"', () => {
    const p = page([op()], panels({
      runtime: {
        breakersConfigured: false,
        bulkheadsConfigured: false,
        breakers: [],
        bulkheads: [],
        pollIntervalMs: 2000,
        refreshStrategy: 'polling',
      },
    }));
    p.go('#!diagnostics');

    const text = p.detailText();
    expect(text).toContain('No circuit breakers are configured');
    expect(text).toContain('not the same as every breaker being closed');
  });

  it('states the refresh strategy from the model rather than a hardcoded string', () => {
    const p = page([op()], panels({
      runtime: {
        breakersConfigured: false,
        bulkheadsConfigured: false,
        breakers: [],
        bulkheads: [],
        pollIntervalMs: 7500,
        refreshStrategy: 'polling',
      },
    }));
    p.go('#!diagnostics');

    expect(p.detailText()).toContain('Auto-refresh every 7500ms (polling)');
  });

  it('says the host supplied no panels rather than showing six empty ones', () => {
    const p = page([op()], null);
    p.go('#!diagnostics');

    expect(p.detailText()).toContain('rendered the Explorer without diagnostic panels');
  });
});

// ===========================================================================
// Panel 6's selector — honest, not live
// ===========================================================================

describe('panel 6 — version diff selector', () => {
  it('is quiet while the selection matches the diff on screen', () => {
    const p = page();
    p.go('#!diagnostics');

    const warn = p.find((el) => el.className === 'panel-warn');
    expect(warn?.style['display']).toBe('none');
  });

  it('warns — instead of relabelling — when a different pair is selected', () => {
    const p = page();
    p.go('#!diagnostics');

    const before = p.find((el) => el.id === 'diff-before');
    expect(before).toBeDefined();
    before!.value = 'sha256:older';
    before!.dispatch('change');

    const warn = p.find((el) => el.className === 'panel-warn');
    expect(warn?.style['display']).toBe('');
    expect(warn?.textContent).toContain('NOT for the pair you selected');
    expect(warn?.textContent).toContain('v6 → v7');
  });
});

// ===========================================================================
// The refresh poll stays inside the view that owns it
// ===========================================================================

describe('auto-refresh', () => {
  it('arms only on the diagnostics view', () => {
    const p = page();
    expect(p.pendingTimers()).toBe(0);

    p.go('#!diagnostics');
    expect(p.pendingTimers()).toBe(1);
  });

  it('disarms on navigation, so it cannot reload a half-filled invoke form', () => {
    const p = page();
    p.go('#!diagnostics');
    expect(p.pendingTimers()).toBe(1);

    p.go('#listPets');
    expect(p.pendingTimers()).toBe(0);
    expect(p.reloads()).toBe(0);
  });

  it('disarms when the operator unticks it', () => {
    const p = page();
    p.go('#!diagnostics');

    const toggle = p.find((el) => el.id === 'auto-refresh');
    toggle!.checked = false;
    toggle!.dispatch('change');

    expect(p.pendingTimers()).toBe(0);
  });
});

// ===========================================================================
// The poll does not destroy panel 6's selection (#178)
// ===========================================================================

describe('auto-refresh yields to the snapshot selector', () => {
  const toggleOf = (p: Page) => p.find((el) => el.id === 'auto-refresh');
  const reasonOf = (p: Page) => p.find((el) => el.id === 'auto-refresh-reason');

  // The control for every assertion below. Without it, "no reload happened"
  // would also be satisfied by a harness that cannot reload at all, and every
  // test in this block would pass against an unfixed page.
  it('an armed poll really does reload the document when it fires', () => {
    const p = page();
    p.go('#!diagnostics');
    expect(p.pendingTimers()).toBe(1);

    expect(p.fireTimers()).toBe(1);
    expect(p.reloads()).toBe(1);
  });

  it('a selector change disarms the poll, so the selection is not reloaded away', () => {
    const p = page();
    p.go('#!diagnostics');

    p.find((el) => el.id === 'diff-before')!.value = 'sha256:older';
    p.find((el) => el.id === 'diff-before')!.dispatch('change');

    expect(p.pendingTimers()).toBe(0);
    // Fire whatever is left: the poll must not have re-armed itself.
    expect(p.fireTimers()).toBe(0);
    expect(p.reloads()).toBe(0);
  });

  it('disarms on the after selector too, not just the before one', () => {
    const p = page();
    p.go('#!diagnostics');

    p.find((el) => el.id === 'diff-after')!.value = 'sha256:newer';
    p.find((el) => el.id === 'diff-after')!.dispatch('change');

    expect(p.pendingTimers()).toBe(0);
    expect(p.reloads()).toBe(0);
  });

  it('unticks the box rather than leaving it claiming a refresh that stopped', () => {
    const p = page();
    p.go('#!diagnostics');
    expect(toggleOf(p)!.checked).toBe(true);

    p.find((el) => el.id === 'diff-before')!.dispatch('change');

    expect(toggleOf(p)!.checked).toBe(false);
  });

  it('says why it paused, so the stop is not left unexplained', () => {
    const p = page();
    p.go('#!diagnostics');
    expect(reasonOf(p)!.style['display']).toBe('none');

    p.find((el) => el.id === 'diff-before')!.dispatch('change');

    expect(reasonOf(p)!.style['display']).toBe('');
    expect(reasonOf(p)!.textContent).toContain('you changed the snapshot selection');
  });

  it('re-ticking re-arms the poll and drops the reason', () => {
    const p = page();
    p.go('#!diagnostics');
    p.find((el) => el.id === 'diff-before')!.dispatch('change');
    expect(p.pendingTimers()).toBe(0);

    toggleOf(p)!.checked = true;
    toggleOf(p)!.dispatch('change');

    expect(p.pendingTimers()).toBe(1);
    expect(reasonOf(p)!.style['display']).toBe('none');
    expect(reasonOf(p)!.textContent).toBe('');
  });

  it('does not blame the selector for a poll the operator had already stopped', () => {
    const p = page();
    p.go('#!diagnostics');
    toggleOf(p)!.checked = false;
    toggleOf(p)!.dispatch('change');

    p.find((el) => el.id === 'diff-before')!.dispatch('change');

    // Nothing was running, so the selector did not pause anything and the row
    // must not claim it did.
    expect(reasonOf(p)!.style['display']).toBe('none');
    expect(toggleOf(p)!.checked).toBe(false);
  });

  it('still warns about the mismatched pair — disarming did not replace that', () => {
    const p = page();
    p.go('#!diagnostics');

    p.find((el) => el.id === 'diff-before')!.value = 'sha256:older';
    p.find((el) => el.id === 'diff-before')!.dispatch('change');

    const warn = p.find((el) => el.className === 'panel-warn');
    expect(warn?.style['display']).toBe('');
    expect(warn?.textContent).toContain('NOT for the pair you selected');
  });
});

// ===========================================================================
// The acceptance criterion: no panel bypasses redaction — INCLUDING rendered
// ===========================================================================

describe('redaction reaches the rendered page', () => {
  it('redacts a key-named secret carried in panel data', () => {
    const html = renderExplorerHtml(
      buildExplorerViewModel(snapshot([op()]), '/mcp'),
      panels({
        policy: {
          operationId: 'listPets',
          policy: 'tenant-scope',
          effect: 'deny',
          evidence: [{ policyId: 'p', claim: 'c', detail: 'x' }],
          denied: true,
          // A policy author's own field name. It reaches the browser through
          // the panel blob, which is why the blob is redacted on the way out.
          ...({ apiKey: 'super-secret-value' } as Record<string, string>),
        },
      }),
    );

    expect(html).not.toContain('super-secret-value');
    expect(html).toContain('[REDACTED]');
  });

  it('escapes markup in panel data so it cannot close the script block', () => {
    const html = renderExplorerHtml(
      buildExplorerViewModel(snapshot([op()]), '/mcp'),
      panels({
        traces: {
          available: true,
          spans: [
            {
              name: '</script><img src=x onerror=alert(1)>',
              attributes: {},
              startedAt: '2026-01-02T03:04:05.000Z',
            },
          ],
        },
      }),
    );

    // One `</script>` per script block and no more — the payload's own is gone.
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('emits an explicit null when no panels are supplied', () => {
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([op()]), '/mcp'));
    expect(html).toContain('window.__EXPLORER_PANELS__=null;');
  });
});

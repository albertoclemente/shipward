// Shipward board. Vanilla DOM, no build step.
// The tracker file is the state; this is a view over it that can also write.
import {
  COLUMNS, fmtDate, relTime, nextId, moveMsg, applyTransition,
  feedAdd, cardsOf, deriveColumns, deriveStats, latestFeed,
  archiveRows, archiveLede, rawJson, addMsg, editMsg, deleteMsg,
} from './lib.js';

const POLL_MS = 3000;
const root = document.getElementById('app');

const state = {
  doc: null,        // last document we know the server has
  view: 'board',
  editing: null,    // card id | 'new' | null
  dragOver: null,
  dragging: null,
  copied: false,    // raw view: the Copy JSON label flips for 2s
  copyFailed: false,
  etag: null,      // from the last GET; PUT must match it
  offline: false,
  error: null,      // server said no, as opposed to server is gone
};

let dialogKey = Symbol('none'); // rebuild the dialog only when the target changes

/* ── dom helpers ─────────────────────────────────────────── */
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

const ICON = {
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-700)" stroke-width="2.2" style="flex:none"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
  branch: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  archive: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="5"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
};
const icon = (name, cls) => el('span', { class: cls, html: ICON[name] });

/* ── server ──────────────────────────────────────────────── */
async function load() {
  const res = await fetch('/api/tracker', { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return { doc: await res.json(), etag: res.headers.get('etag') };
}

// Whole-file write, guarded by the etag we last read. The server compares it
// inside the lock and refuses rather than clobbering a newer document.
async function persist(doc, etag) {
  const res = await fetch('/api/tracker', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': etag ?? '' },
    body: JSON.stringify(doc),
  });
  if (res.status === 409) {
    const { tracker } = await res.json().catch(() => ({}));
    const conflict = new Error('tracker changed underneath');
    conflict.name = 'ConflictError';
    conflict.current = { doc: tracker, etag: res.headers.get('etag') };
    throw conflict;
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || `PUT ${res.status}`);
  }
  return { doc: await res.json(), etag: res.headers.get('etag') };
}

// Apply a pure mutation to the current doc, render optimistically, then persist.
// On failure we fall back to whatever the server actually holds.
let writesInFlight = 0;

async function commit(mutate) {
  const base = structuredClone(state.doc);
  const next = mutate(structuredClone(state.doc));
  if (!next) { render(); return false; }   // no-op still repaints (clears drag highlight)
  state.doc = next;
  state.error = null;
  render();
  writesInFlight++;
  try {
    let out;
    try {
      out = await persist(next, state.etag);
    } catch (err) {
      if (err.name !== 'ConflictError') throw err;
      // Something else wrote while we were composing. Re-apply the same intent
      // to the document that actually won — commit() takes a mutation, not a
      // snapshot, precisely so this is possible — and try once more.
      const retried = mutate(structuredClone(err.current.doc));
      if (!retried) { state.doc = err.current.doc; state.etag = err.current.etag; return false; }
      out = await persist(retried, err.current.etag);
    }
    state.doc = out.doc;
    state.etag = out.etag;
    state.offline = false;
    return true;
  } catch (err) {
    // Distinguish "the server said no" from "the server is gone" — both used to
    // render the same chip, so a rejected write looked like a lost one.
    state.doc = base;
    if (err.name === 'ConflictError') {
      // Lost the retry too — adopt the winner rather than insisting.
      state.doc = err.current.doc; state.etag = err.current.etag;
      state.offline = false; state.error = 'someone else changed that card — reloaded';
      return false;
    }
    if (err.name === 'TypeError') { state.offline = true; state.error = null; }
    else { state.offline = false; state.error = err.message; }
    return false;
  } finally {
    writesInFlight--;
    render();
  }
}

/* ── mutations ───────────────────────────────────────────── */
const now = () => new Date().toISOString();

function moveCard(id, to) {
  commit((doc) => {
    const i = doc.cards.findIndex((c) => c.id === id);
    if (i === -1) return null;                       // unknown id — ignore
    const updated = applyTransition(doc.cards[i], to, now());
    if (!updated) return null;                       // already there — no-op
    doc.cards[i] = updated;
    doc.feed = feedAdd(doc.feed, updated.p, moveMsg(id, to), now());
    return doc;
  });
}

async function saveCard(values, opened) {
  const ok = await commit((doc) => {
    if (state.editing !== 'new') {
      const i = doc.cards.findIndex((c) => c.id === state.editing);
      if (i === -1) return null;
      // Merge only what the human actually changed. The dialog holds a snapshot
      // from when it opened; Claude Code may have appended to `note` on disk
      // since, and that context is the memory this product exists to keep.
      const touched = {};
      for (const [k, v] of Object.entries(values)) {
        if (opened && v === opened[k]) continue;
        touched[k] = v;
      }
      if (!Object.keys(touched).length) return null;
      doc.cards[i] = { ...doc.cards[i], ...touched };
      const fields = Object.keys(touched).sort().join(', ');
      doc.feed = feedAdd(doc.feed, doc.cards[i].p, editMsg(doc.cards[i].id, fields), now());
      return doc;
    }
    const project = activeProject(doc);
    const id = nextId(doc.cards, project.prefix);
    doc.cards.unshift({
      id, p: project.id, status: 'backlog', claude: null, commit: null,
      created: now(), pushed: null, shipped: null, ...values,
    });
    doc.feed = feedAdd(doc.feed, project.id, addMsg(id), now());
    return doc;
  });
  if (ok) closeDialog();   // a rejected write keeps the dialog and its text
}

// Human-only. CLAUDE.md forbids Claude Code from deleting; the id stays burned
// because nextId scans the max suffix, never the count.
async function deleteCard(id) {
  const ok = await commit((doc) => {
    const card = doc.cards.find((c) => c.id === id);
    if (!card) return null;
    doc.cards = doc.cards.filter((c) => c.id !== id);
    doc.feed = feedAdd(doc.feed, card.p, deleteMsg(id), now());
    return doc;
  });
  if (ok) closeDialog();
}

const switchProject = (id) => commit((doc) => ({ ...doc, activeProject: id }));

const activeProject = (doc) =>
  doc.projects.find((p) => p.id === doc.activeProject) || doc.projects[0] || { id: '', name: '', prefix: 'SW' };

const openDialog = (target) => { state.editing = target; render(); };
const closeDialog = () => { state.editing = null; render(); };

/* ── render ──────────────────────────────────────────────── */
function render() {
  if (!state.doc) return;
  const doc = state.doc;
  const project = activeProject(doc);
  const feed = latestFeed(doc.feed, project.id);
  const stats = deriveStats(doc.cards, project.id);

  const view = state.view === 'archive' ? renderArchive(doc, project)
    : state.view === 'raw' ? renderRaw(doc, project)
    : renderBoard(doc, project);

  root.replaceChildren(
    renderHeader(doc, project),
    renderActivity(feed, stats, project),
    renderTabs(doc, project),
    view,
  );
  renderDialog(doc, project);
}

function renderHeader(doc, project) {
  return el('header', { class: 'nav' },
    el('div', { class: 'brand-group' },
      el('div', { class: 'brand-mark' }),
      el('div', { class: 'nav-brand', text: 'SHIPWARD' }),
      el('div', { class: 'text-muted brand-tag', text: 'the solo shipping desk' }),
    ),
    el('div', { class: 'seg' }, doc.projects.map((p) =>
      el('label', { class: 'seg-opt', style: 'font-family:var(--font-heading);font-weight:600' },
        el('input', {
          type: 'radio', name: 'sw-project', checked: p.id === project.id,
          onchange: () => switchProject(p.id),
        }),
        p.name,
      ))),
    el('div', { class: 'tag tag-outline mcp-tag' },
      el('span', { class: 'mcp-dot' }),
      'MCP CONNECTED',
    ),
    el('button', { class: 'btn btn-primary', onclick: () => openDialog('new') },
      icon('plus'), 'New card'),
  );
}

function renderActivity(feed, stats, project) {
  return el('div', { class: 'activity' },
    icon('terminal'),
    // Attribute honestly — the strip used to label your own drags "Claude Code".
    el('span', { class: 'activity-who', text: feed?.by === 'user' ? 'You' : 'Claude Code' }),
    el('span', {
      class: 'activity-msg',
      text: feed ? feed.msg : `connected — no activity yet for ${project.name}`,
    }),
    el('span', { class: 'text-muted activity-ago', text: feed ? relTime(feed.t) : '' }),
    state.offline ? el('span', { class: 'offline-note', text: 'server unreachable' }) : null,
    state.error ? el('span', { class: 'offline-note', text: `write rejected — ${state.error}` }) : null,
    el('span', { class: 'activity-stats', text: stats.line }),
  );
}

function renderTabs(doc, project) {
  const archived = cardsOf(doc.cards, project.id).filter((c) => c.status === 'shipped').length;
  const tabs = [
    ['board', 'Board'],
    ['archive', `Archive · ${archived}`],
    ['raw', 'Raw data'],
  ];
  return el('div', { class: 'tabs' }, tabs.map(([key, label]) =>
    el('button', {
      class: `tab${state.view === key ? ' is-active' : ''}`,
      text: label,
      'aria-current': state.view === key ? 'page' : null,
      onclick: () => { if (state.view !== key) { state.view = key; render(); } },
    })));
}

function renderArchive(doc, project) {
  const rows = archiveRows(doc.cards, project.id);
  return el('main', { class: 'view-wrap' },
    el('div', { class: 'view-body' },
      el('h3', { class: 'view-title', text: 'Shipped & archived' }),
      el('p', { class: 'text-muted view-lede', text: archiveLede(project.name, rows.length) }),
      rows.length
        ? el('table', { class: 'table archive-table' },
            el('thead', {},
              el('tr', {},
                el('th', { class: 'w-date', text: 'Shipped' }),
                el('th', { class: 'w-id', text: 'ID' }),
                el('th', { text: 'What went out' }),
                el('th', { class: 'w-type', text: 'Type' }),
                el('th', { class: 'w-effort', text: 'Effort' }),
                el('th', { class: 'w-commit', text: 'Commit' }),
              )),
            el('tbody', {}, rows.map((r) =>
              el('tr', {},
                el('td', { class: 'cell-date', text: r.date }),
                el('td', { class: 'cell-mono', text: r.id }),
                el('td', { class: 'cell-what', text: r.title }),
                el('td', { text: r.type }),
                el('td', { text: r.effort }),
                el('td', { class: 'cell-mono', text: r.commit }),
              ))),
          )
        : el('div', { class: 'text-muted view-empty',
            text: 'Nothing archived yet. Push something, then file it here.' }),
    ),
  );
}

// The 2s label flip is a timer, and the 3s poll re-renders underneath it, so
// the flag lives in state rather than on the button element.
let copyTimer = null;

async function copyRaw(text) {
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(text);
    state.copied = true;
    state.copyFailed = false;
  } catch {
    // Denied permission, or an insecure origin. Say so — a button that claims
    // it copied when it did not is worse than one that admits it failed.
    state.copied = false;
    state.copyFailed = true;
  }
  render();
  copyTimer = setTimeout(() => {
    state.copied = false;
    state.copyFailed = false;
    render();
  }, 2000);
}

function renderRaw(doc, project) {
  const json = rawJson(doc.cards, project.id);
  const label = state.copyFailed ? 'Could not copy — select it instead'
    : state.copied ? 'Copied — feed it to a machine'
    : 'Copy JSON';
  return el('main', { class: 'view-wrap' },
    el('div', { class: 'view-body view-body-raw' },
      el('h3', { class: 'view-title', text: 'Raw board data' }),
      el('p', { class: 'text-muted view-lede view-lede-raw',
        text: 'The exact schema Claude Code reads and writes over MCP — stable ids, four statuses, ISO timestamps. What you see on the board is only ever a view of this.' }),
      el('button', {
        class: 'btn btn-secondary', onclick: () => copyRaw(json),
        'aria-live': 'polite',
      }, icon('copy'), label),
      el('pre', { class: 'raw-pre', text: json }),
    ),
  );
}

function renderBoard(doc, project) {
  const columns = deriveColumns(doc.cards, project.id);
  return el('main', { class: 'board-wrap' },
    el('div', { class: 'board' }, columns.map(renderColumn)),
    el('div', { class: 'text-muted board-caption',
      text: 'Drag a card between columns — Shipward writes the status change straight back to the shared schema Claude Code reads.' }),
  );
}

function renderColumn(col) {
  const section = el('section', {
    class: `col${state.dragOver === col.key ? ' is-over' : ''}`,
    ondragover: (e) => {
      e.preventDefault();
      if (state.dragOver !== col.key) { state.dragOver = col.key; render(); }
    },
    ondragleave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      if (state.dragOver === col.key) { state.dragOver = null; render(); }
    },
    ondrop: (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      state.dragOver = null;
      state.dragging = null;
      if (id) moveCard(id, col.key); else render();
    },
  },
    el('div', { class: 'col-head' },
      el('span', { class: 'col-count', text: String(col.count) }),
      el('h6', { class: 'col-label', text: col.label }),
      el('span', { class: 'text-muted col-hint', text: col.hint }),
    ),
    el('div', { class: 'col-body' },
      col.isEmpty ? el('div', { class: 'text-muted col-empty', text: col.empty }) : null,
      col.cards.map(renderCard),
      col.key === 'backlog'
        ? el('button', { class: 'btn btn-secondary btn-block col-add', text: '+ Add a card',
            onclick: () => openDialog('new') })
        : null,
    ),
  );
  return section;
}

function renderCard(c) {
  const claudeLine = c.status === 'claude'
    ? (c.claude === 'working' ? 'Claude is on it' : 'Queued for Claude')
    : null;

  return el('article', {
    class: `swcard${state.dragging === c.id ? ' is-dragging' : ''}`,
    draggable: 'true',
    tabindex: '0',
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', c.id);
      e.dataTransfer.effectAllowed = 'move';
      state.dragging = c.id;
    },
    ondragend: () => { state.dragging = null; state.dragOver = null; render(); },
    onclick: () => openDialog(c.id),
    onkeydown: (e) => { if (e.key === 'Enter') openDialog(c.id); },
  },
    el('div', { class: 'swcard-top' },
      el('span', { class: 'swcard-id', text: c.id }),
      el('span', { class: `swcard-pri pri-${c.pri}`, text: c.pri }),
    ),
    el('div', { class: 'swcard-title', text: c.title }),
    el('div', { class: 'swcard-meta' },
      el('span', { class: `swcard-type${c.type === 'bug' ? ' is-bug' : ''}`, text: c.type }),
      el('span', { text: `· ${c.effort}` }),
      el('span', { class: 'swcard-date',
        text: c.status === 'pushed' ? `pushed ${fmtDate(c.pushed)}` : fmtDate(c.created) }),
    ),
    c.branch
      ? el('div', { class: 'swcard-branch' },
          icon('branch'),
          el('span', { class: 'swcard-branch-name', text: c.branch }),
          el('span', { class: 'swcard-sha', text: c.commit || '' }),
        )
      : null,
    claudeLine
      ? el('div', { class: 'swcard-claude' },
          el('span', { class: `claude-dot${c.claude === 'working' ? ' is-working' : ''}` }),
          claudeLine,
        )
      : null,
    c.status === 'pushed'
      ? el('button', { class: 'btn btn-ghost swcard-archive',
          onclick: (e) => { e.stopPropagation(); moveCard(c.id, 'shipped'); } },
          icon('archive'), 'File to archive')
      : null,
  );
}

/* ── dialog ──────────────────────────────────────────────── */
// Rebuilt only when the target changes, so a background poll cannot wipe
// what is being typed.
function renderDialog(doc, project) {
  const key = state.editing ?? null;
  const existing = document.querySelector('.dialog-backdrop');
  if (key === dialogKey) return;
  dialogKey = key;
  existing?.remove();
  if (key === null) return;

  const card = key === 'new' ? null : doc.cards.find((c) => c.id === key);
  if (key !== 'new' && !card) { state.editing = null; dialogKey = null; return; }
  const c = card || {};

  const segGroup = (label, name, opts, current, fallback) =>
    el('div', { class: 'field' },
      el('label', { text: label }),
      el('div', { class: 'seg' }, opts.map((v) =>
        el('label', { class: 'seg-opt' },
          el('input', { type: 'radio', name, value: v, checked: (current || fallback) === v }),
          v,
        ))),
    );

  // Snapshot of the card as it stood when the dialog opened, so save can tell
  // what the human edited from what merely drifted on disk underneath.
  const opened = card
    ? { title: c.title || '', type: c.type, pri: c.pri, effort: c.effort, branch: c.branch || null, note: c.note || '' }
    : null;

  const form = el('form', { class: 'dialog', onclick: (e) => e.stopPropagation(),
    onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;                              // required — dialog stays open
      saveCard({
        title,
        type: fd.get('type') || 'feature',
        pri: fd.get('pri') || 'P2',
        effort: fd.get('effort') || 'M',
        branch: String(fd.get('branch') || '').trim() || null,
        note: String(fd.get('note') || ''),
      }, opened);
    } },
    el('div', { style: 'display:flex;align-items:baseline;gap:10px' },
      el('div', { class: 'dialog-title', text: card ? 'Edit card' : 'New card' }),
      el('span', { class: 'text-muted', style: 'font-size:12px;margin-left:auto',
        text: card
          ? `${c.id} · created ${fmtDate(c.created)}`
          : `lands in Backlog as ${nextId(doc.cards, project.prefix)}` }),
    ),
    el('div', { class: 'field' },
      el('label', { text: 'What are you building?' }),
      el('input', { class: 'input', name: 'title', required: true, value: c.title || '',
        placeholder: 'e.g. Brew timer with bloom alerts' }),
    ),
    el('div', { style: 'display:flex;gap:var(--space-4);flex-wrap:wrap' },
      segGroup('Type', 'type', ['feature', 'bug', 'chore'], c.type, 'feature'),
      segGroup('Priority', 'pri', ['P1', 'P2', 'P3'], c.pri, 'P2'),
      segGroup('Effort', 'effort', ['S', 'M', 'L'], c.effort, 'M'),
    ),
    el('div', { class: 'field' },
      el('label', { text: "Branch — optional, Claude names one if you don't" }),
      el('input', { class: 'input', name: 'branch', value: c.branch || '', placeholder: 'feat/…',
        style: 'font-family:var(--font-mono);font-size:13px' }),
    ),
    el('div', { class: 'field' },
      el('label', { text: 'Notes for Claude — optional' }),
      el('textarea', { class: 'input', name: 'note', style: 'min-height:64px',
        placeholder: 'Context Claude Code sees when it picks this up over MCP' }, c.note || ''),
    ),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'submit', class: 'btn btn-primary', text: card ? 'Save changes' : 'Add to Backlog' }),
      el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: closeDialog }),
      card
        ? el('button', { type: 'button', class: 'btn btn-ghost', text: 'Delete card',
            style: 'margin-left:auto', onclick: () => deleteCard(c.id) })
        : null,
    ),
  );

  document.body.append(el('div', { class: 'dialog-backdrop', onclick: closeDialog }, form));
  form.querySelector('input[name="title"]')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.editing !== null) closeDialog();
});

/* ── poll ────────────────────────────────────────────────── */
// Claude Code edits tracker.json directly, so the file is the source of truth
// and this is how its work shows up on the board.
let lastPaint = 0;

async function poll() {
  // Never let a GET that was already in flight when a write started clobber the
  // freshly persisted document — that silently reinstated the pre-write state
  // and the next edit then wrote it back.
  if (writesInFlight > 0) return;
  try {
    const { doc: fresh, etag } = await load();
    if (writesInFlight > 0) return;               // a write started while we waited
    const recovered = state.offline;              // clearing the banner is itself a change
    state.offline = false;
    const changed = JSON.stringify(fresh) !== JSON.stringify(state.doc);
    // Repaint periodically even without a change, so the activity strip's
    // relative time ages instead of reading "just now" for an hour.
    const stale = Date.now() - lastPaint > 30000;
    state.etag = etag;
    if (recovered || changed || stale) {
      state.doc = fresh;
      lastPaint = Date.now();
      render();
    }
  } catch {
    if (!state.offline) {            // keep the last known board on screen
      state.offline = true;
      if (state.doc) render();
      else root.replaceChildren(el('div', { class: 'board-wrap text-muted',
        text: 'Cannot reach the Shipward server. Start it with: node shipward/serve.mjs' }));
    }
  }
}

// Sequential, not setInterval: a GET slower than the interval used to overlap
// with the next one and let an older document land after a newer one.
(async function loop() {
  await poll();
  lastPaint = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    await poll();
  }
})();

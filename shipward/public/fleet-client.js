// The fleet page's browser half. SW-047.
//
// This was sixty lines inside a template literal in fleet.mjs. It is a real
// module now, so node --test can import the decisions beside it, `node --check`
// can parse it, and the escaping hazard that killed SW-036's script cannot
// exist — there is no outer literal left to escape for.
//
// What stays here is only the DOM and the network. Every decision about what a
// row SAYS lives in fleet-view.js, where it is tested.
import { rowView, fleetLede, onboardPrompt } from './fleet-view.js';
import { digest, digestLede, digestSections } from './fleet-digest.js';

const POLL_MS = 5000;

// Built with DOM nodes, never innerHTML — the same rule the desk follows
// (SW-025): a project name or feed message is tracker data, and tracker data
// can arrive from anywhere. textContent cannot be mis-escaped.
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function candidateNode(v, refresh) {
  const row = el('div', 'row cand');
  row.append(el('span', 'name dead', v.name));
  row.append(el('span', 'tagline', v.tagline));
  const btn = el('button', 'onboard', 'Onboard');
  btn.onclick = async () => {
    if (!confirm(onboardPrompt(v.name))) return;
    btn.disabled = true;
    btn.textContent = 'Wiring…';
    const fail = (msg) => {
      alert(`Onboarding failed:\n${msg}`);
      btn.disabled = false;
      btn.textContent = 'Onboard';
    };
    try {
      const out = await (await fetch('/api/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: v.repo }),
      })).json();
      if (!out.ok) return fail(out.error || out.output);
    } catch (e) {
      return fail(String(e));
    }
    refresh();   // the row comes back as a live board with its own desk
  };
  row.append(btn);
  return row;
}

function boardNode(v) {
  const row = el('div', v.rowClass);
  if (v.href) {
    const a = el('a', v.nameClass, v.name);
    a.href = v.href;
    row.append(a);
  } else {
    row.append(el('span', v.nameClass, v.name));
  }
  if (!v.ok) { row.append(el('span', 'down', v.error)); return row; }
  row.append(el('span', 'prefix', v.prefix));
  const stats = el('span', 'stats');
  stats.append(
    el('b', null, v.stats.working), ' working · ',
    el('b', null, v.stats.review), ' review · ',
    v.stats.tail,
  );
  row.append(stats);
  if (v.deskError) row.append(el('span', 'down', v.deskError));
  if (v.last) {
    const last = el('span', 'last');
    last.append(el('span', 'who', v.last.by), ` ${v.last.text}`);
    row.append(last);
  }
  return row;
}

const node = (v, refresh) => (v.kind === 'candidate' ? candidateNode(v, refresh) : boardNode(v));

// SW-046. One standup across every board, above the list of boards. The
// answers are decided in fleet-digest.js; this only builds the elements.
function digestNode(d) {
  const wrap = el('section', 'digest');
  wrap.append(el('p', 'digest-lede', digestLede(d)));
  for (const s of digestSections(d)) {
    const sec = el('div', `digest-group ${s.key}`);
    sec.append(el('h6', 'digest-heading', s.heading));
    for (const item of s.items) {
      const line = el('div', 'digest-item');
      if (item.href) {
        const a = el('a', 'digest-board', item.board);
        a.href = item.href;
        line.append(a);
      } else {
        line.append(el('span', 'digest-board', item.board));
      }
      line.append(el('span', 'digest-text', item.text));
      sec.append(line);
    }
    wrap.append(sec);
  }
  return wrap;
}

export async function refresh() {
  try {
    // { found, rows } since SW-046 — `found` is what the walk saw, which can
    // exceed what the fleet shows.
    const payload = await (await fetch('/api/fleet')).json();
    const rows = payload.rows;
    document.getElementById('lede').textContent = fleetLede(rows);
    document.getElementById('digest')
      .replaceChildren(digestNode(digest(rows, { found: payload.found })));
    const box = document.getElementById('rows');
    box.replaceChildren(...(rows.length
      ? rows.map((r) => node(rowView(r), refresh))
      : [el('p', 'lede', 'No .shipward/tracker.json under this root. Onboard a repo with shipward/setup.mjs.')]));
  } catch { /* the poll rides out a hiccup */ }
}

// Starting is a side effect, so it only happens where there is a page to start
// on. Importing this module in a test used to begin polling and hold the event
// loop open forever — node --test ran until it was killed, which is a worse
// failure than the one the test existed to catch, because it looks like a hang
// rather than a bug. A browser has `document`; node --test does not.
export function start() {
  refresh();
  return setInterval(refresh, POLL_MS);
}

if (typeof document !== 'undefined') start();

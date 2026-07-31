// What a fleet row says, decided without a browser.
//
// SW-047. This logic used to live inside fleet.mjs's PAGE template — sixty
// lines of browser JavaScript stored as a string. A string cannot be imported,
// cannot be syntax-checked, and cannot be tested, and it broke silently twice:
//
//   SW-036  an unescaped \n inside the template became a real newline in the
//           served source, snapped a string literal across two lines, and killed
//           the ENTIRE script with a syntax error. The page rendered its shell
//           and nothing else. No error reached any log.
//   SW-038  the origin validator was written as a snapshot of the href shape of
//           the day; the producer grew a ?fleet= parameter, the consumer's regex
//           did not, and every board silently lost its link. Ten rows, zero
//           anchors, no error anywhere.
//
// Both are producer/consumer drift, and both are exactly what a pure function
// pins. Nothing here touches the DOM: it takes the row data the fleet API
// returns and decides what the row SAYS. fleet-client.js does the elements.

// Whether a desk href may be rendered as a link, and the href if so.
//
// Parsed, never pattern-matched. A validator written as a regex over today's
// URL shape is a regression waiting for the first parameter anyone appends —
// that is precisely how SW-038 unlinked the fleet. This checks the properties
// that actually matter: a local http origin, addressing the desk root.
export function deskHref(desk) {
  if (typeof desk !== 'string' || !desk) return null;
  try {
    const u = new URL(desk);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'http:' || !local || u.pathname !== '/') return null;
    return desk;
  } catch {
    return null;
  }
}

// A repo the walk found that is not on Shipward yet.
export const candidateView = (r) => ({
  kind: 'candidate',
  name: r.name,
  tagline: `${r.folder} — a git repo, not on Shipward yet`,
  repo: r.repo,
});

// The confirm() text for the Onboard button. It lives here, with REAL newlines,
// because in the template it had to be written `\\n` — escaped once for the
// outer literal — and getting that wrong is what killed SW-036's script.
export const onboardPrompt = (name) =>
  `Wire ${name} to Shipward?\n\nAdds .shipward/, hooks, MCP registration and the CLAUDE.md protocol to that repo. `
  + 'Additive and reversible; nothing existing is overwritten.';

export function boardView(r) {
  const href = r.ok ? deskHref(r.desk) : null;
  return {
    kind: 'board',
    ok: !!r.ok,
    rowClass: r.ok ? 'row' : 'row dead',
    name: r.name,
    href,
    // A live board with no reachable desk is dimmed; a board that could not be
    // read at all keeps the plain class and carries its error instead.
    nameClass: href ? 'name' : (r.ok ? 'name dead' : 'name'),
    error: r.ok ? null : r.error,
    prefix: r.ok ? `${r.prefix}-… · ${r.folder}` : null,
    // Split rather than pre-joined: the two counts are emphasised and the tail
    // is not, and a single string would force the renderer to re-split it.
    stats: r.ok ? {
      working: String(r.working),
      review: String(r.review),
      tail: `${r.backlog} backlog · ${r.pushed} pushed`,
    } : null,
    deskError: r.ok ? (r.deskError || null) : null,
    last: r.ok && r.last ? { by: r.last.by, text: `${r.last.msg} · ${r.last.ago}` } : null,
  };
}

export const rowView = (r) => (r?.kind === 'candidate' ? candidateView(r) : boardView(r));

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The line above the list. Counts boards and candidates separately because they
// are different invitations: one is "here is your work", the other is "here is
// something you could add".
export function fleetLede(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const boards = all.filter((r) => r.kind === 'board');
  if (!all.length) {
    return 'No .shipward/tracker.json under this root. Onboard a repo with shipward/setup.mjs.';
  }
  const active = boards.filter((r) => r.ok && (r.working + r.review) > 0).length;
  const cands = all.length - boards.length;
  return `${plural(boards.length, 'board')} — ${active} with something in flight`
    + (cands ? ` · ${plural(cands, 'repo')} not onboarded yet` : '')
    + '. Click a name to open its desk.';
}

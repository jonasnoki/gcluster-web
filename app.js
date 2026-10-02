/* gcluster companion web app. Plain JS, no build step. Data: Supabase via backend.js. */
'use strict';

// ------------------------------------------------------------------ utilities

const DEFAULT_SETTINGS = { abortives: ['Sumatriptan injection', 'Nasal triptan', 'Oxygen'], tags: [] };
const EFFECTS = [
  { v: null, label: '–' },
  { v: 0, label: 'Did not work' },
  { v: 1, label: 'Partly' },
  { v: 2, label: 'Worked' },
];
const EFFECT_TEXT = { 0: 'did not work', 1: 'partly', 2: 'worked' };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};

/** Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', child). Never uses innerHTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendAll(el, children);
  return el;
}
function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  appendAll(el, children);
  return el;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
function toLocalInput(sec) {
  if (sec == null) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(str) {
  if (!str) return null;
  const t = new Date(str).getTime(); // datetime-local strings parse as local time
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (sec) => new Date(sec * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtMonth = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
function fmtDur(min) {
  if (min == null) return '';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad(min % 60)} min`;
}
const durMin = (a) => (a.end != null && a.start != null ? Math.max(0, Math.round((a.end - a.start) / 60)) : null);
const peakClass = (p) => (p == null ? '' : p >= 6 ? 'high' : 'mid');
function dayKey(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ------------------------------------------------------------------ state + API

const S = {
  attacks: store.get('gc.cache.attacks', []), // includes tombstones
  settings: store.get('gc.cache.settings', DEFAULT_SETTINGS),
  online: true,
  loaded: false,
  lastSync: store.get('gc.cache.time', null),
};

function setOnline(on) {
  S.online = on;
  const b = document.getElementById('banner');
  if (on) { b.hidden = true; return; }
  b.replaceChildren(
    'Offline: showing saved data, read-only' + (S.lastSync ? ` (from ${fmtDate(S.lastSync)} ${fmtTime(S.lastSync)})` : ''),
    h('button', { type: 'button', onclick: () => refresh().then(render) }, 'Retry'),
  );
  b.hidden = false;
}

async function refresh() {
  if (!Backend.signedIn()) return;
  try {
    const [list, settings] = await Promise.all([Backend.listAttacks(), Backend.getSettings()]);
    S.attacks = list || [];
    S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    S.lastSync = nowSec();
    store.set('gc.cache.attacks', S.attacks);
    store.set('gc.cache.settings', S.settings);
    store.set('gc.cache.time', S.lastSync);
    setOnline(true);
  } catch (e) {
    if (e.status === 401) {
      toast('Signed out. Please sign in again.');
      setOnline(true);
    } else {
      setOnline(false);
    }
  } finally {
    S.loaded = true;
  }
}

function upsertLocal(a) {
  const i = S.attacks.findIndex((x) => x.id === a.id);
  if (i >= 0) S.attacks[i] = a; else S.attacks.push(a);
  store.set('gc.cache.attacks', S.attacks);
}

const visibleAttacks = () => S.attacks.filter((a) => !a.deleted).sort((a, b) => (b.start - a.start) || (b.id - a.id));

// ------------------------------------------------------------------ router

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || 'attacks', arg: parts[1] };
}

let dirty = false; // unsaved edit form
function render() {
  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs');
  const r = route();
  window.scrollTo(0, 0);
  dirty = false;
  if (!Backend.signedIn() || r.name === 'setup') {
    tabs.hidden = true;
    view.replaceChildren(viewSetup());
    return;
  }
  tabs.hidden = false;
  const tab = r.name === 'attack' || r.name === 'new' ? 'attacks' : r.name;
  for (const a of tabs.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  let content;
  switch (r.name) {
    case 'attack': content = viewEdit(Number(r.arg)); break;
    case 'new': content = viewEdit(null); break;
    case 'stats': content = viewStats(); break;
    case 'settings': content = viewSettings(); break;
    default: content = viewList();
  }
  view.replaceChildren(content);
}

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

// ------------------------------------------------------------------ sign in

/** Email code sign-in: a code (not a link), so it works inside the installed app. */
function viewSetup() {
  const email = h('input', { type: 'email', id: 'se', placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', value: store.get('gc.email', '') });
  const code = h('input', { type: 'text', id: 'sc', placeholder: '123456', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '10' });
  const codeField = h('div', { class: 'field', hidden: true }, h('label', { for: 'sc' }, 'Code from the email'), code);
  const err = h('div', { class: 'error', role: 'alert' });
  const status = h('div', { class: 'hint' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Send code');
  let sent = false;

  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    const addr = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) { err.textContent = 'Enter your email address.'; return; }
    btn.disabled = true;
    try {
      if (!sent) {
        status.textContent = 'Sending…';
        await Backend.sendCode(addr);
        store.set('gc.email', addr);
        sent = true;
        codeField.hidden = false;
        btn.textContent = 'Sign in';
        status.textContent = `We sent a code to ${addr}.`;
        code.focus();
      } else {
        const c = code.value.replace(/\s/g, '');
        if (!c) { err.textContent = 'Enter the code from the email.'; return; }
        status.textContent = 'Checking…';
        await Backend.verifyCode(addr, c);
        status.textContent = '';
        await refresh();
        location.hash = '#/attacks';
        render();
      }
    } catch (ex) {
      status.textContent = '';
      err.textContent = ex.status ? (sent ? 'That code did not work. Check it, or send a new one.' : ex.message)
        : 'No connection. Try again when you are online.';
    } finally {
      btn.disabled = false;
    }
  }

  return h('div', {},
    h('h1', {}, 'gcluster'),
    h('p', { class: 'muted' }, 'Sign in with your email. You get a code, no password needed.'),
    h('form', { onsubmit: submit, autocomplete: 'on' },
      h('div', { class: 'field' }, h('label', { for: 'se' }, 'Email'), email),
      codeField, btn, err, status,
    ),
  );
}

// ------------------------------------------------------------------ list

function peakPill(p) {
  return h('span', { class: 'pill ' + peakClass(p), title: p == null ? 'No pain level' : `Peak pain ${p}/10` }, p == null ? '–' : p);
}

function viewList() {
  const items = visibleAttacks();
  const list = h('div', { class: 'list' });
  let month = null;
  for (const a of items) {
    const m = fmtMonth(a.start);
    if (m !== month) { list.append(h('div', { class: 'month' }, m)); month = m; }
    const d = durMin(a);
    list.append(h('a', { class: 'card', href: `#/attack/${a.id}` },
      h('div', { class: 'row spread' },
        h('div', { class: 'grow' },
          h('div', { class: 'date' }, fmtDate(a.start)),
          h('div', { class: 'time' },
            fmtTime(a.start), ' – ', a.end != null ? fmtTime(a.end) : 'ongoing',
            d != null ? ` · ${fmtDur(d)}` : '',
            a.endGuess ? ' (end guessed)' : '')),
        peakPill(a.peak)),
      (a.abortive || (a.tags && a.tags.length) || a.status === 'unconfirmed' || a.source === 'auto')
        ? h('div', { class: 'meta' },
          a.status === 'unconfirmed' ? h('span', { class: 'badge' }, 'unconfirmed') : null,
          a.source === 'auto' ? h('span', { class: 'muted' }, 'auto') : null,
          a.abortive ? h('span', {}, a.abortive, a.effect != null ? ` (${EFFECT_TEXT[a.effect]})` : '') : null,
          (a.tags || []).map((t) => h('span', { class: 'tag' }, t)))
        : null,
    ));
  }
  return h('div', {},
    h('h1', {}, 'Attacks'),
    items.length ? list : h('div', { class: 'empty' }, S.loaded ? 'No attacks yet. Tap + to add one.' : 'Loading…'),
    S.online ? h('a', { class: 'fab', href: '#/new', 'aria-label': 'Add attack' }, '+') : null,
  );
}

// ------------------------------------------------------------------ edit

function newAttack() {
  const t = nowSec();
  return {
    id: null, start: t, end: null, source: 'manual', status: 'confirmed', peak: null, painLast: null,
    abortive: null, abortiveAt: null, effect: null, reliefMin: null, tags: [], notes: null,
    hrRise: null, endGuess: false, deleted: false,
  };
}

function segmented(cls, options, get, set, disabled) {
  const wrap = h('div', { class: 'seg ' + cls, role: 'group' });
  const buttons = options.map((o) => h('button', {
    type: 'button', class: o.cls || '', 'aria-pressed': String(get() === o.v), disabled,
    onclick: () => { set(get() === o.v && o.v != null ? null : o.v); sync(); },
  }, o.label));
  function sync() { buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(get() === options[i].v))); }
  wrap.append(...buttons);
  return wrap;
}

function viewEdit(id) {
  const orig = id == null ? null : S.attacks.find((a) => a.id === id && !a.deleted);
  if (id != null && !orig) {
    return h('div', {}, h('p', { class: 'empty' }, 'Attack not found.'), h('a', { class: 'btn block', href: '#/attacks' }, 'Back'));
  }
  const d = orig ? JSON.parse(JSON.stringify(orig)) : newAttack();
  const ro = !S.online;
  const markDirty = () => { dirty = true; };

  // start / end
  const startIn = h('input', { type: 'datetime-local', id: 'fs', value: toLocalInput(d.start), disabled: ro, required: true, oninput: markDirty });
  const endIn = h('input', { type: 'datetime-local', id: 'fe', value: toLocalInput(d.end), disabled: ro, oninput: markDirty });
  const origStartStr = startIn.value; const origEndStr = endIn.value;
  const timeErr = h('div', { class: 'error', role: 'alert' });

  // abortive
  const list = [...(S.settings.abortives || [])];
  if (d.abortive && !list.includes(d.abortive)) list.push(d.abortive);
  const OTHER = '\u0000other';
  const absel = h('select', { id: 'fa', disabled: ro, onchange: () => { markDirty(); abUpdate(); } },
    h('option', { value: '' }, 'None'),
    list.map((n) => h('option', { value: n, selected: d.abortive === n }, n)),
    h('option', { value: OTHER }, 'Other…'));
  const abOther = h('input', { type: 'text', placeholder: 'Abortive name', disabled: ro, oninput: markDirty, hidden: true });
  const abAtIn = h('input', { type: 'datetime-local', id: 'fat', value: toLocalInput(d.abortiveAt), disabled: ro, oninput: markDirty });
  const origAbAtStr = abAtIn.value;
  const reliefIn = h('input', { type: 'number', id: 'fr', min: '0', max: '1440', inputmode: 'numeric', value: d.reliefMin ?? '', disabled: ro, oninput: markDirty });
  const abDetails = h('div', {},
    h('div', { class: 'field' },
      h('label', { for: 'fat' }, 'Taken at'),
      abAtIn,
      h('div', { class: 'row wrap', style: 'margin-top:8px' },
        h('button', { type: 'button', class: 'btn small', disabled: ro, onclick: () => { abAtIn.value = startIn.value; markDirty(); } }, 'At onset'),
        h('button', { type: 'button', class: 'btn small', disabled: ro, onclick: () => { abAtIn.value = toLocalInput(nowSec()); markDirty(); } }, 'Now'))),
    h('div', { class: 'field' },
      h('div', { class: 'label' }, 'Effect'),
      segmented('effect', EFFECTS, () => d.effect, (v) => { d.effect = v; markDirty(); }, ro)),
    h('div', { class: 'field' }, h('label', { for: 'fr' }, 'Minutes to relief'), reliefIn));
  function abUpdate() {
    abOther.hidden = absel.value !== OTHER;
    abDetails.hidden = absel.value === '';
    if (absel.value === OTHER) abOther.focus();
  }

  // tags
  const tagNames = [...(S.settings.tags || [])];
  for (const t of d.tags || []) if (!tagNames.includes(t)) tagNames.push(t);
  const chips = h('div', { class: 'chips' }, tagNames.map((t) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String((d.tags || []).includes(t)), disabled: ro,
    onclick: (e) => {
      const on = !(d.tags || []).includes(t);
      d.tags = on ? [...(d.tags || []), t] : d.tags.filter((x) => x !== t);
      e.currentTarget.setAttribute('aria-pressed', String(on));
      markDirty();
    },
  }, t)));

  const notesIn = h('textarea', { id: 'fn', disabled: ro, oninput: markDirty, placeholder: 'Anything worth remembering' });
  notesIn.value = d.notes || '';

  function collect() {
    const out = { ...d };
    timeErr.textContent = '';
    // keep the original seconds when the minute-precision input was not touched
    const start = startIn.value === origStartStr && orig ? orig.start : fromLocalInput(startIn.value);
    const end = endIn.value === origEndStr && orig ? orig.end : fromLocalInput(endIn.value);
    if (start == null) { timeErr.textContent = 'Start is required.'; return null; }
    if (end != null && end <= start) { timeErr.textContent = 'End must be after start.'; return null; }
    out.start = start;
    out.end = end;
    if (endIn.value !== origEndStr) out.endGuess = false; // user set the end
    const ab = absel.value === OTHER ? abOther.value.trim() : absel.value;
    out.abortive = ab || null;
    if (out.abortive) {
      out.abortiveAt = abAtIn.value === origAbAtStr && orig ? orig.abortiveAt : fromLocalInput(abAtIn.value);
      const r = reliefIn.value === '' ? null : Math.round(Number(reliefIn.value));
      out.reliefMin = Number.isFinite(r) && r >= 0 ? r : null;
    } else {
      out.abortiveAt = null; out.effect = null; out.reliefMin = null;
    }
    out.notes = notesIn.value.trim() || null;
    if (out.id == null) {
      let nid = start;
      while (S.attacks.some((a) => a.id === nid)) nid += 1;
      out.id = nid;
    }
    out.updatedAt = nowSec();
    return out;
  }

  const saveBtn = h('button', { class: 'btn primary', type: 'submit', disabled: ro }, 'Save');
  async function save(extra) {
    const a = collect();
    if (!a) return;
    Object.assign(a, extra || {});
    saveBtn.disabled = true;
    try {
      const saved = await Backend.putAttack(a);
      upsertLocal(saved);
      dirty = false;
      toast('Saved');
      location.hash = '#/attacks';
    } catch (e) {
      if (!e.status) setOnline(false);
      toast(e.status ? e.message : 'Could not save: server not reachable');
    } finally {
      saveBtn.disabled = ro;
    }
  }

  async function del() {
    if (!confirm('Delete this attack? This syncs to the watch.')) return;
    try {
      const saved = await Backend.deleteAttack(orig || d);
      upsertLocal(saved);
      dirty = false;
      toast('Deleted');
      location.hash = '#/attacks';
    } catch (e) {
      toast(e.status ? e.message : 'Could not delete: server not reachable');
    }
  }

  const statusPanel = orig && (orig.source === 'auto' || orig.status === 'unconfirmed')
    ? h('div', { class: 'panel' + (d.status === 'unconfirmed' ? ' warn' : '') },
      h('div', {}, d.source === 'auto' ? 'Detected automatically at night' : 'Logged', d.hrRise != null ? ` (heart rate +${d.hrRise} bpm)` : '', '.'),
      h('div', { class: 'muted small' }, d.status === 'unconfirmed' ? 'Not confirmed yet.' : 'Confirmed.'),
      h('div', { class: 'row', style: 'margin-top:10px' },
        d.status === 'unconfirmed'
          ? h('button', { type: 'button', class: 'btn primary grow', disabled: ro, onclick: () => save({ status: 'confirmed' }) }, 'Confirm attack')
          : h('button', { type: 'button', class: 'btn grow', disabled: ro, onclick: () => save({ status: 'unconfirmed' }) }, 'Mark unconfirmed')))
    : null;

  const form = h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
    statusPanel,
    h('div', { class: 'field' }, h('label', { for: 'fs' }, 'Start'), startIn,
      h('div', { class: 'row wrap', style: 'margin-top:8px' },
        h('button', { type: 'button', class: 'btn small', disabled: ro, onclick: () => { startIn.value = toLocalInput(nowSec()); markDirty(); } }, 'Now'))),
    h('div', { class: 'field' }, h('label', { for: 'fe' }, 'End'), endIn,
      h('div', { class: 'row wrap', style: 'margin-top:8px' },
        h('button', { type: 'button', class: 'btn small', disabled: ro, onclick: () => { endIn.value = toLocalInput(nowSec()); markDirty(); } }, 'Now'),
        h('button', { type: 'button', class: 'btn small ghost', disabled: ro, onclick: () => { endIn.value = ''; markDirty(); } }, 'Clear (ongoing)')),
      d.endGuess ? h('div', { class: 'hint' }, 'End was guessed from heart rate. Change it to confirm.') : null,
      timeErr),
    h('div', { class: 'field' },
      h('div', { class: 'label' }, 'Peak pain'),
      segmented('pain', Array.from({ length: 10 }, (_, i) => ({ v: i + 1, label: String(i + 1), cls: i < 5 ? 'mid' : '' })),
        () => d.peak, (v) => { d.peak = v; markDirty(); }, ro),
      h('div', { class: 'hint' }, 'Tap the selected level again to clear it.')),
    h('div', { class: 'field' }, h('label', { for: 'fa' }, 'Abortive'), absel, h('div', { style: 'margin-top:8px' }, abOther)),
    abDetails,
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Triggers'),
      tagNames.length ? chips : h('div', { class: 'hint' }, 'No tags yet. Add some in Settings.')),
    h('div', { class: 'field' }, h('label', { for: 'fn' }, 'Notes'), notesIn),
    h('div', { class: 'actions' },
      h('a', { class: 'btn ghost', href: '#/attacks' }, 'Cancel'),
      saveBtn),
    orig ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', disabled: ro, onclick: del }, 'Delete attack')) : null,
  );
  abUpdate();

  return h('div', {},
    h('div', { class: 'topbar' },
      h('a', { class: 'back', href: '#/attacks', 'aria-label': 'Back' }, '‹'),
      h('h1', {}, orig ? fmtDate(orig.start) : 'New attack')),
    form);
}

// ------------------------------------------------------------------ stats

/** Single-series vertical bar chart as inline SVG. values: numbers; label(i) -> axis text or null; tip(i) -> caption. */
function barChart(values, label, tip, { height = 150 } = {}) {
  const W = 340, H = height, L = 24, R = 10, T = 8, B = 20;
  const max = Math.max(1, ...values);
  const step = max <= 4 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const pw = W - L - R, ph = H - T - B;
  const bw = pw / values.length;
  const gap = Math.min(2, bw * 0.25);
  const y = (v) => T + ph - (v / top) * ph;
  const cap = h('div', { class: 'cap' }, ' ');
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: L - 5, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  let active = null;
  values.forEach((v, i) => {
    const x = L + i * bw + gap / 2, w = Math.max(1, bw - gap);
    if (v > 0) {
      const yt = y(v), r = Math.min(4, w / 2, (T + ph - yt));
      const yb = T + ph;
      svg.append(s('path', {
        class: 'bar', 'data-i': i,
        d: `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yb}Z`,
      }));
    }
    const lab = label(i);
    if (lab != null) svg.append(s('text', { x: x + w / 2, y: H - 5, 'text-anchor': 'middle' }, lab));
    const hit = s('rect', { class: 'hit', x: L + i * bw, y: T, width: bw, height: ph });
    const show = () => {
      if (active) active.classList.remove('on');
      active = svg.querySelector(`.bar[data-i="${i}"]`);
      if (active) active.classList.add('on');
      cap.textContent = tip(i);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    svg.append(hit);
  });
  svg.setAttribute('aria-label', values.map((v, i) => tip(i)).join('; '));
  return h('div', { class: 'chart' }, svg, cap);
}

function viewStats() {
  const includeUnconf = store.get('gc.stats.unconfirmed', false);
  const all = visibleAttacks().filter((a) => includeUnconf || a.status !== 'unconfirmed');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function perDay(days) {
    const counts = new Map();
    for (const a of all) counts.set(dayKey(a.start), (counts.get(dayKey(a.start)) || 0) + 1);
    const out = [];
    const today = new Date(); today.setHours(12, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(today.getDate() - i);
      const sec = Math.floor(d.getTime() / 1000);
      out.push({ sec, n: counts.get(dayKey(sec)) || 0, d });
    }
    return out;
  }
  const d14 = perDay(14), d60 = perDay(60);
  const hours = Array(24).fill(0);
  for (const a of all) hours[new Date(a.start * 1000).getHours()] += 1;
  const peaks = all.map((a) => a.peak).filter((p) => p != null);
  const durs = all.map(durMin).filter((m) => m != null);
  const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const avgPeak = avg(peaks), avgDur = avg(durs);
  const sum = (xs) => xs.reduce((x, y) => x + y.n, 0);

  // abortive effectiveness
  const ab = new Map();
  for (const a of all) {
    if (!a.abortive) continue;
    const e = ab.get(a.abortive) || { n: 0, 0: 0, 1: 0, 2: 0, none: 0, relief: [] };
    e.n += 1;
    if (a.effect === 0 || a.effect === 1 || a.effect === 2) e[a.effect] += 1; else e.none += 1;
    if (a.reliefMin != null) e.relief.push(a.reliefMin);
    ab.set(a.abortive, e);
  }
  const abRows = [...ab.entries()].sort((x, y) => y[1].n - x[1].n);

  const tile = (v, k) => h('div', { class: 'tile' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  const dayTip = (arr) => (i) => `${arr[i].d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${plural(arr[i].n, 'attack')}`;

  return h('div', {},
    h('h1', {}, 'Stats'),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: includeUnconf, onchange: (e) => { store.set('gc.stats.unconfirmed', e.target.checked); render(); } }),
      'Include unconfirmed detections'),
    h('div', { class: 'tiles' },
      tile(sum(d14.slice(-7)), 'last 7 days'),
      tile(sum(d14), 'last 14 days'),
      tile(sum(d60), 'last 60 days'),
      tile(avgPeak == null ? '–' : avgPeak.toFixed(1), `avg peak (${peaks.length} rated)`),
      tile(avgDur == null ? '–' : fmtDur(Math.round(avgDur)), `avg duration (${durs.length} ended)`),
      tile(all.length, 'attacks in total')),
    h('h2', {}, 'Attacks per day, last 14 days'),
    barChart(d14.map((x) => x.n), (i) => (i % 2 === 1 ? String(d14[i].d.getDate()) : null), dayTip(d14)),
    h('h2', {}, 'Attacks per day, last 60 days'),
    barChart(d60.map((x) => x.n), (i) => (d60[i].d.getDay() === 1 ? String(d60[i].d.getDate()) + '.' : null), dayTip(d60), { height: 130 }),
    h('div', { class: 'hint' }, 'Labels mark Mondays.'),
    h('h2', {}, 'Attacks by hour of day (onset)'),
    barChart(hours, (i) => (i % 3 === 0 ? String(i) : null), (i) => `${pad(i)}:00–${pad(i)}:59: ${plural(hours[i], 'attack')}`),
    h('h2', {}, 'Abortive effectiveness'),
    abRows.length
      ? h('div', { class: 'panel' },
        h('div', { class: 'legend' },
          h('span', {}, h('i', { style: 'background:var(--good)' }), 'worked'),
          h('span', {}, h('i', { style: 'background:var(--warn)' }), 'partly'),
          h('span', {}, h('i', { style: 'background:var(--bad)' }), 'did not work'),
          h('span', {}, h('i', { style: 'background:var(--unknown)' }), 'not rated')),
        h('div', { class: 'eff', style: 'margin-top:12px' }, abRows.map(([name, e]) => {
          const rated = e[0] + e[1] + e[2];
          const r = avg(e.relief);
          return h('div', {},
            h('div', { class: 'row spread' }, h('span', { class: 'name' }, name), h('span', { class: 'muted small' }, plural(e.n, 'use'))),
            h('div', { class: 'stack', role: 'img', 'aria-label': `${name}: worked ${e[2]}, partly ${e[1]}, did not work ${e[0]}, not rated ${e.none}` },
              [['s2', e[2]], ['s1', e[1]], ['s0', e[0]], ['sn', e.none]].filter(([, n]) => n > 0)
                .map(([c, n]) => h('i', { class: c, style: `flex:${n}` }))),
            h('div', { class: 'muted small' },
              rated ? `worked ${Math.round((e[2] / rated) * 100)}% · partly ${Math.round((e[1] / rated) * 100)}% · did not work ${Math.round((e[0] / rated) * 100)}%` : 'no ratings yet',
              r != null ? ` · relief after ${Math.round(r)} min on average` : ''));
        })))
      : h('div', { class: 'hint' }, 'No abortives recorded yet.'),
    h('details', {},
      h('summary', {}, 'Show attacks by hour as a table'),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Hour'), h('th', {}, 'Attacks'))),
        h('tbody', {}, hours.map((n, i) => h('tr', {}, h('td', {}, `${pad(i)}:00`), h('td', {}, n)))))),
  );
}

// ------------------------------------------------------------------ settings

function editableList(title, key, draft, ro) {
  const ul = h('ul', { class: 'editlist' });
  const input = h('input', { type: 'text', placeholder: `Add ${title.toLowerCase().replace(/s$/, '')}`, disabled: ro });
  function draw() {
    ul.replaceChildren(...draft[key].map((name, i) => h('li', {},
      h('span', {}, name),
      h('button', { type: 'button', 'aria-label': `Remove ${name}`, disabled: ro, onclick: () => { draft[key].splice(i, 1); draw(); } }, '×'))));
    if (!draft[key].length) ul.append(h('li', {}, h('span', { class: 'muted' }, 'None')));
  }
  function add() {
    const v = input.value.trim();
    if (v && !draft[key].includes(v)) draft[key].push(v);
    input.value = '';
    draw();
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
  return h('div', {},
    h('h2', {}, title), ul,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, input),
      h('button', { type: 'button', class: 'btn', disabled: ro, onclick: add }, 'Add')));
}

const CSV_COLUMNS = ['id', 'start_local', 'end_local', 'duration_min', 'status', 'source', 'peak', 'abortive',
  'abortive_local', 'abortive_after_onset_min', 'effect', 'relief_min', 'tags', 'notes'];
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const localStamp = (sec) => (sec == null ? '' : toLocalInput(sec).replace('T', ' '));

/** CSV of all attacks, made in the browser from the loaded data. */
function exportCsv() {
  const rows = visibleAttacks().slice().reverse().map((a) => [
    a.id, localStamp(a.start), localStamp(a.end), durMin(a), a.status, a.source, a.peak, a.abortive,
    localStamp(a.abortiveAt), a.abortiveAt != null && a.start != null ? Math.round((a.abortiveAt - a.start) / 60) : '',
    a.effect != null ? EFFECT_TEXT[a.effect] : '', a.reliefMin, (a.tags || []).join('; '), a.notes,
  ]);
  const text = [CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = h('a', { href: url, download: `gcluster-${dayKey(nowSec())}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Connect a watch: the code is shown once; only its hash is stored. */
function devicesPanel(ro) {
  const list = h('ul', { class: 'editlist' }, h('li', {}, h('span', { class: 'muted' }, 'Loading…')));
  const out = h('div');
  async function load() {
    try {
      const devices = await Backend.listDevices();
      list.replaceChildren(...devices.map((d) => h('li', {},
        h('span', {}, d.label, h('span', { class: 'muted small' }, d.last_seen ? ` · synced ${fmtDate(Date.parse(d.last_seen) / 1000)}` : ' · not synced yet')),
        h('button', { type: 'button', 'aria-label': `Remove ${d.label}`, disabled: ro, onclick: async () => {
          if (!confirm(`Remove ${d.label}? It can no longer sync until you connect it again.`)) return;
          await Backend.deleteDevice(d.id);
          load();
        } }, '×'))));
      if (!devices.length) list.replaceChildren(h('li', {}, h('span', { class: 'muted' }, 'No watch connected')));
    } catch (e) {
      list.replaceChildren(h('li', {}, h('span', { class: 'muted' }, 'Could not load devices')));
    }
  }
  const btn = h('button', { type: 'button', class: 'btn block', disabled: ro, onclick: async () => {
    btn.disabled = true;
    try {
      const code = await Backend.createDeviceCode('Watch');
      const copy = h('button', { type: 'button', class: 'btn small', onclick: () => {
        navigator.clipboard.writeText(code).then(() => toast('Copied'), () => toast('Select the code and copy it'));
      } }, 'Copy');
      out.replaceChildren(h('div', { class: 'panel' },
        h('div', { class: 'small muted' }, 'Device code (shown only now)'),
        h('div', { class: 'code', style: 'word-break:break-all;font-family:ui-monospace,monospace;user-select:all' }, code),
        h('div', { class: 'row', style: 'margin-top:8px' }, copy),
        h('p', { class: 'small muted' }, 'Garmin Connect app → your watch → Connect IQ apps → GCluster → Settings → Device code. Paste it there.')));
      load();
    } catch (e) {
      toast(e.status ? e.message : 'Needs a connection');
    } finally {
      btn.disabled = ro;
    }
  } }, 'Connect a watch');
  load();
  return h('div', {}, list, h('div', { style: 'margin-top:8px' }, btn), out);
}

function viewSettings() {
  const ro = !S.online;
  const draft = {
    ...S.settings,
    abortives: [...(S.settings.abortives || [])],
    tags: [...(S.settings.tags || [])],
  };
  const saveBtn = h('button', { type: 'button', class: 'btn primary block', disabled: ro, onclick: async () => {
    saveBtn.disabled = true;
    try {
      S.settings = { ...DEFAULT_SETTINGS, ...(await Backend.putSettings(draft)) };
      store.set('gc.cache.settings', S.settings);
      toast('Lists saved');
      render();
    } catch (e) {
      toast(e.status ? e.message : 'Could not save: server not reachable');
      saveBtn.disabled = false;
    }
  } }, 'Save lists');
  const exportBtn = h('button', { type: 'button', class: 'btn block', onclick: exportCsv }, 'Export CSV');

  return h('div', {},
    h('h1', {}, 'Settings'),
    h('p', { class: 'muted small' }, 'These lists are the choices in the attack form. The watch keeps its own lists in the Garmin Connect app.'),
    editableList('Abortives', 'abortives', draft, ro),
    editableList('Trigger tags', 'tags', draft, ro),
    h('div', { style: 'margin-top:16px' }, saveBtn),
    h('h2', {}, 'Data'),
    exportBtn,
    h('div', { class: 'hint' }, S.lastSync ? `Last loaded ${fmtDate(S.lastSync)} ${fmtTime(S.lastSync)}.` : ''),
    h('h2', {}, 'Watch'),
    devicesPanel(ro),
    h('h2', {}, 'Account'),
    h('div', { class: 'panel' }, h('div', { class: 'small muted' }, 'Signed in as'), h('div', {}, Backend.email() || '')),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!confirm('Sign out and remove the saved data from this device? Your data stays in your account.')) return;
        await Backend.signOut();
        for (const k of ['gc.cache.attacks', 'gc.cache.settings', 'gc.cache.time']) store.del(k);
        S.attacks = []; S.settings = DEFAULT_SETTINGS; S.lastSync = null;
        setOnline(true);
        location.hash = '#/setup';
        render();
      } }, 'Sign out')),
  );
}

// ------------------------------------------------------------------ boot

async function boot() {
  Backend.takeSessionFromUrl();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* e.g. file:// or private mode */ });
  }
  render();
  if (Backend.signedIn()) {
    await refresh();
    const r = route().name;
    // don't wipe a form the user already started typing into
    if (!(dirty && (r === 'attack' || r === 'new'))) render();
  }
}

window.addEventListener('online', () => { if (Backend.signedIn()) refresh().then(() => { if (!dirty) render(); }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Backend.signedIn() && !dirty) refresh().then(() => { if (!dirty) render(); });
});

boot();

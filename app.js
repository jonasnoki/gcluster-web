/* gcluster companion web app. Plain JS, no build step. Data: Supabase via backend.js.
 * An ES module (for schedule.js); config.js and backend.js are classic scripts before it. */
import * as Sched from './schedule.js';

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
const peakClass = (p) => (p == null ? '' : p <= 5 ? 'low' : p <= 7 ? 'mid' : 'high');
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
  meds: store.get('gc.cache.meds', []),
  doses: store.get('gc.cache.doses', []), // the last DOSE_DAYS days, tombstones included
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
    const [list, settings, meds, doses] = await Promise.all([Backend.listAttacks(), Backend.getSettings(),
      Backend.listMeds(), Backend.listDoses(Sched.addDays(todayStr(), -(DOSE_DAYS - 1)))]);
    S.attacks = list || [];
    S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    S.meds = meds || [];
    S.doses = doses || [];
    store.set('gc.cache.meds', S.meds);
    store.set('gc.cache.doses', S.doses);
    // The phone reminders are sent by the server; it needs the local time zone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && S.settings.tz !== tz) {
      S.settings = { ...DEFAULT_SETTINGS, ...(await Backend.putSettings({ ...S.settings, tz })) };
    }
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
/** keepScroll: a redraw for new data, not a new page; stays where it was. */
function render({ keepScroll = false } = {}) {
  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs');
  const r = route();
  const y = window.scrollY;
  if (!keepScroll) window.scrollTo(0, 0);
  dirty = false;
  if (!Backend.signedIn() || r.name === 'setup') {
    tabs.hidden = true;
    view.replaceChildren(viewSetup());
    return;
  }
  tabs.hidden = false;
  const tab = r.name === 'attack' || r.name === 'new' ? 'attacks' : r.name === 'med' ? 'meds' : r.name;
  for (const a of tabs.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  let content;
  const listRoute = !['stats', 'settings', 'meds', 'med'].includes(r.name);
  if (WIDE.matches && listRoute) {
    // Desktop: list and the selected attack side by side.
    const id = r.name === 'attack' ? Number(r.arg) : null;
    const detail = r.name === 'attack' ? viewEdit(id) : r.name === 'new' ? viewEdit(null)
      : h('div', { class: 'empty' }, 'Select an attack, or add one with +.');
    content = h('div', { class: 'split' }, viewList(id), h('div', { class: 'pane-detail' }, detail));
  } else {
    switch (r.name) {
      case 'attack': content = viewEdit(Number(r.arg)); break;
      case 'new': content = viewEdit(null); break;
      case 'meds': content = viewMeds(r.arg); break;
      case 'med': content = viewMedEdit(r.arg); break;
      case 'stats': content = viewStats(); break;
      case 'settings': content = viewSettings(); break;
      default: content = viewList();
    }
  }
  view.classList.toggle('wide-split', WIDE.matches && listRoute);
  if (keepScroll) {
    // Hold the old height while swapping, so the page does not shrink and
    // jump (on iOS that also misplaces the fixed tab bar).
    view.style.minHeight = `${view.offsetHeight}px`;
    view.replaceChildren(content);
    if (window.scrollY !== y) window.scrollTo(0, y);
    requestAnimationFrame(() => { view.style.minHeight = ''; });
  } else {
    view.replaceChildren(content);
  }
}

/** Desktop layout from this width on (sidebar, list and detail side by side). */
const WIDE = window.matchMedia('(min-width: 960px)');
WIDE.addEventListener('change', () => { if (!dirty) render(); });

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

// ------------------------------------------------------------------ sign in

/** Sign-in: email and password, or a code by email (first time, or a forgotten password).
 *  A code, not a link, so it works inside the installed app. */
function viewSetup() {
  let mode = store.get('gc.loginMode', 'password'); // 'password' | 'code'
  const email = h('input', { type: 'email', id: 'se', name: 'email', placeholder: 'you@example.com', autocomplete: 'username', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', value: store.get('gc.email', '') });
  const pass = h('input', { type: 'password', id: 'sp', name: 'password', autocomplete: 'current-password' });
  const passField = h('div', { class: 'field' }, h('label', { for: 'sp' }, 'Password'), pass);
  const code = h('input', { type: 'text', id: 'sc', placeholder: '123456', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '10' });
  const codeField = h('div', { class: 'field', hidden: true }, h('label', { for: 'sc' }, 'Code from the email'), code);
  const err = h('div', { class: 'error', role: 'alert' });
  const status = h('div', { class: 'hint' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' });
  const intro = h('p', { class: 'muted' });
  const switchLink = h('button', { type: 'button', class: 'linkish', onclick: () => setMode(mode === 'password' ? 'code' : 'password') });
  let sent = false;

  function setMode(m) {
    mode = m;
    store.set('gc.loginMode', m);
    sent = false;
    err.textContent = ''; status.textContent = '';
    passField.hidden = m !== 'password';
    codeField.hidden = true;
    btn.textContent = m === 'password' ? 'Sign in' : 'Send code';
    intro.textContent = m === 'password'
      ? 'Sign in with your email and password.'
      : 'We send you a code by email. Use this the first time, or if you forgot your password.';
    switchLink.textContent = m === 'password' ? 'No password yet, or forgot it? Sign in with an email code' : 'Sign in with a password';
  }

  async function signedIn() {
    status.textContent = '';
    await refresh();
    location.hash = mode === 'code' ? '#/settings' : '#/attacks';
    render();
    if (mode === 'code') toast('Signed in. You can set a password under Account.');
  }

  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    const addr = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) { err.textContent = 'Enter your email address.'; return; }
    btn.disabled = true;
    try {
      if (mode === 'password') {
        if (!pass.value) { err.textContent = 'Enter your password.'; return; }
        status.textContent = 'Checking…';
        await Backend.signInPassword(addr, pass.value);
        store.set('gc.email', addr);
        await signedIn();
      } else if (!sent) {
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
        await signedIn();
      }
    } catch (ex) {
      status.textContent = '';
      if (!ex.status) err.textContent = 'No connection. Try again when you are online.';
      else if (mode === 'password') err.textContent = ex.status === 400 ? 'Wrong email or password. No password yet? Sign in with an email code.' : ex.message;
      else if (ex.status === 429) err.textContent = 'Too many emails for now (the free email service sends only a few per hour). Try again later, or sign in with a password.';
      else err.textContent = sent ? 'That code did not work. Check it, or send a new one.' : ex.message;
    } finally {
      btn.disabled = false;
    }
  }

  setMode(mode);
  return h('div', { class: 'signin' },
    h('h1', {}, 'gcluster'),
    intro,
    h('form', { onsubmit: submit, autocomplete: 'on' },
      h('div', { class: 'field' }, h('label', { for: 'se' }, 'Email'), email),
      passField, codeField, btn, err, status,
    ),
    h('div', { style: 'margin-top:16px' }, switchLink),
  );
}

/** Set or change the password, for the email and password sign-in. */
function passwordPanel(ro) {
  const pw = h('input', { type: 'password', id: 'np', autocomplete: 'new-password', minlength: '8', disabled: ro });
  const pw2 = h('input', { type: 'password', id: 'np2', autocomplete: 'new-password', disabled: ro });
  const err = h('div', { class: 'error', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn block', disabled: ro }, 'Save password');
  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    if (pw.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (pw.value !== pw2.value) { err.textContent = 'The two passwords are not the same.'; return; }
    btn.disabled = true;
    try {
      await Backend.setPassword(pw.value);
      pw.value = ''; pw2.value = '';
      toast('Password saved');
    } catch (ex) {
      err.textContent = ex.status ? ex.message : 'Needs a connection';
    } finally {
      btn.disabled = ro;
    }
  }
  // The hidden username field lets password managers save the pair.
  return h('form', { onsubmit: submit, autocomplete: 'on' },
    h('input', { type: 'email', name: 'email', autocomplete: 'username', value: Backend.email() || '', hidden: true, readonly: true }),
    h('div', { class: 'field' }, h('label', { for: 'np' }, 'New password'), pw),
    h('div', { class: 'field' }, h('label', { for: 'np2' }, 'Repeat the password'), pw2),
    btn, err);
}

// ------------------------------------------------------------------ list

function peakPill(p) {
  return h('span', { class: 'pill ' + peakClass(p), title: p == null ? 'No pain level' : `Peak pain ${p}/10` }, p == null ? '–' : p);
}

function viewList(selected) {
  const items = visibleAttacks();
  const list = h('div', { class: 'list' });
  let month = null;
  for (const a of items) {
    const m = fmtMonth(a.start);
    if (m !== month) { list.append(h('div', { class: 'month' }, m)); month = m; }
    const d = durMin(a);
    list.append(h('a', { class: 'card' + (a.id === selected ? ' selected' : ''), href: `#/attack/${a.id}`, 'aria-current': a.id === selected ? 'true' : null },
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
  return h('div', { class: 'pane-list' },
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
      segmented('pain', Array.from({ length: 10 }, (_, i) => ({ v: i + 1, label: String(i + 1), cls: peakClass(i + 1) })),
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

// ------------------------------------------------------------------ medication

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const UNITS = ['pill', 'puff', 'piece', 'drop', 'injection', 'ml', 'mg', 'sachet'];
/** Doses loaded for this many days back (history and adherence). */
const DOSE_DAYS = 30;
const todayStr = () => Sched.dayOf(new Date());
const visibleMeds = () => S.meds.filter((m) => !m.deleted).sort((a, b) => a.name.localeCompare(b.name));
const doseMap = () => Object.fromEntries(S.doses.map((d) => [d.id, d]));
const fmtDayLong = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDayShort = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function upsertDoseLocal(d) {
  const i = S.doses.findIndex((x) => x.id === d.id);
  if (i >= 0) S.doses[i] = d; else S.doses.push(d);
  store.set('gc.cache.doses', S.doses);
}

async function saveDose(d) {
  try {
    upsertDoseLocal(await Backend.putDose(d));
    render({ keepScroll: true });
  } catch (e) {
    if (!e.status) setOnline(false);
    toast(e.status ? e.message : 'Could not save: server not reachable');
  }
}

/** A dose is open (not taken, not skipped) and its time has passed. */
function overdue(dose, rec, now) {
  if (rec && !rec.deleted) return false;
  return dose.day < now.day || (dose.day === now.day && Sched.minutesOf(dose.at) <= now.min);
}

function doseRow(d, rec, now, ro) {
  const done = rec && !rec.deleted ? rec : null;
  const mark = (status) => saveDose({
    id: d.id, medId: d.med.id, day: d.day, at: d.at, dose: d.dose, status,
    // Today: the real time. An earlier day: the scheduled time, since that is the best guess.
    takenAt: status !== 'taken' ? null : d.day === now.day ? nowSec() : Math.floor(new Date(`${d.day}T${d.at}:00`).getTime() / 1000),
    deleted: false,
  });
  let state;
  if (!done) {
    state = h('div', { class: 'dose-actions' },
      h('button', { type: 'button', class: 'btn small primary', disabled: ro, onclick: () => mark('taken') }, 'Taken'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: ro, onclick: () => mark('skipped') }, 'Skip'));
  } else {
    const takenIn = h('input', { type: 'time', class: 'taken-at', value: done.takenAt ? fmtHM(done.takenAt) : d.at, disabled: ro,
      'aria-label': 'Taken at', onchange: (e) => {
        if (!e.target.value) return;
        saveDose({ ...done, takenAt: Math.floor(new Date(`${d.day}T${e.target.value}:00`).getTime() / 1000) });
      } });
    state = h('div', { class: 'dose-actions' },
      done.status === 'taken' ? h('span', { class: 'done' }, '✓ Taken ', takenIn) : h('span', { class: 'muted' }, 'Skipped'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: ro, onclick: () => saveDose({ ...done, deleted: true }) }, 'Undo'));
  }
  return h('div', { class: 'dose' + (overdue(d, rec, now) ? ' overdue' : '') + (done ? ' is-done' : '') },
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, d.med.name),
      h('div', { class: 'muted small' }, Sched.doseText(d.dose, d.med.unit), overdue(d, rec, now) ? ' · open' : '')),
    state);
}
const fmtHM = (sec) => { const t = new Date(sec * 1000); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };

/** Last 14 days per medication: one cell per day, taken / skipped / open. */
function adherence(meds, doses, now) {
  const days = Array.from({ length: 14 }, (_, i) => Sched.addDays(now.day, i - 13));
  const rows = meds.map((m) => {
    let due = 0, taken = 0;
    const cells = days.map((day) => {
      const list = Sched.dosesOn([m], day).filter((d) => overdue(d, null, now));
      const cell = (cls, title) => h('a', { class: 'cell ' + cls, title, href: `#/meds/${day}`, 'aria-label': title });
      if (!list.length) return cell('none', `${fmtDayShort(day)}: not scheduled`);
      const t = list.filter((d) => doses[d.id] && !doses[d.id].deleted && doses[d.id].status === 'taken').length;
      const sk = list.filter((d) => doses[d.id] && !doses[d.id].deleted && doses[d.id].status === 'skipped').length;
      due += list.length; taken += t;
      const cls = t === list.length ? 'all' : t + sk === list.length ? 'skip' : t > 0 ? 'part' : 'miss';
      return cell(cls, `${fmtDayShort(day)}: ${t} of ${list.length} taken${sk ? `, ${sk} skipped` : ''}`);
    });
    return h('div', { class: 'adh-row' },
      h('span', { class: 'name' }, m.name),
      h('span', { class: 'cells' }, cells),
      h('span', { class: 'num small' }, due ? `${taken}/${due}` : '–'));
  });
  return h('div', { class: 'panel' },
    rows,
    h('div', { class: 'legend' },
      h('span', {}, h('i', { class: 'cell all' }), 'all taken'),
      h('span', {}, h('i', { class: 'cell part' }), 'some'),
      h('span', {}, h('i', { class: 'cell skip' }), 'skipped'),
      h('span', {}, h('i', { class: 'cell miss' }), 'not logged')));
}

function viewMeds(dayArg) {
  const now = Sched.localNow();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg || '') ? dayArg : now.day;
  const ro = !S.online;
  const meds = visibleMeds();
  const doses = doseMap();
  const list = Sched.dosesOn(meds, day);
  const minDay = Sched.addDays(now.day, -(DOSE_DAYS - 1));

  const groups = h('div', { class: 'doses' });
  let at = null;
  for (const d of list) {
    if (d.at !== at) { groups.append(h('div', { class: 'month' }, d.at)); at = d.at; }
    groups.append(doseRow(d, doses[d.id], now, ro));
  }
  const nav = (n) => {
    const t = Sched.addDays(day, n);
    return t > now.day || t < minDay ? null : `#/meds/${t}`;
  };
  const prev = nav(-1), next = nav(1);
  const dayView = h('div', { class: 'swipe-day' + (swipeIn ? ` in-${swipeIn}` : '') },
    h('div', { class: 'daynav' },
      prev ? h('a', { class: 'back', href: prev, 'aria-label': 'Day before' }, '‹') : h('span', { class: 'back' }),
      h('h1', {}, day === now.day ? 'Today' : day === Sched.addDays(now.day, -1) ? 'Yesterday' : fmtDayShort(day),
        h('span', { class: 'muted sub' }, fmtDayLong(day))),
      next ? h('a', { class: 'back', href: next, 'aria-label': 'Next day' }, '›') : h('span', { class: 'back' })),
    !meds.length
      ? h('div', { class: 'empty' }, S.loaded ? 'No medication yet. Add one below.' : 'Loading…')
      : list.length ? groups : h('div', { class: 'empty' }, 'Nothing scheduled on this day.'));
  swipeIn = null;
  swipeDays(dayView, prev, next);
  return h('div', { class: 'meds' },
    h('div', { class: 'eyebrow' }, 'Medication'),
    dayView,
    meds.length ? [h('h2', {}, 'Last 14 days'), adherence(meds, doses, now)] : null,
    h('h2', {}, 'Medications'),
    h('div', { class: 'list' }, meds.map((m) => h('a', { class: 'card', href: `#/med/${m.id}` },
      h('div', { class: 'row spread' },
        h('div', { class: 'grow' },
          h('div', { class: 'date' }, m.name, m.paused ? h('span', { class: 'badge', style: 'margin-left:8px' }, 'paused') : null),
          h('div', { class: 'time' }, (m.times || []).map((t) => `${t.at} ${Sched.doseText(t.dose, m.unit)}`).join(' · ')),
          h('div', { class: 'muted small' }, repeatText(m))))))),
    h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn block', href: '#/med/new', 'aria-disabled': ro ? 'true' : null }, '+ Add medication')),
  );
}

/** Direction the next day view slides in from, after a swipe. */
let swipeIn = null;

/** Swipe from the left: the day before; from the right: the next day.
 *  The day follows the finger; a mostly vertical move stays a scroll. */
function swipeDays(el, prev, next) {
  let x0 = null, y0 = 0, dx = 0, horizontal = null;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null;
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (x0 == null) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (horizontal == null && Math.abs(mx) + Math.abs(my) > 10) horizontal = Math.abs(mx) > Math.abs(my);
    if (!horizontal) return;
    e.preventDefault();
    // Resist where there is no day to go to.
    dx = (mx > 0 && !prev) || (mx < 0 && !next) ? mx / 4 : mx;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 600));
  }, { passive: false });
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    const go = dx > 70 ? prev : dx < -70 ? next : null;
    el.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
    if (!go) { el.style.transform = ''; el.style.opacity = ''; return; }
    el.style.transform = `translateX(${dx > 0 ? '100%' : '-100%'})`;
    el.style.opacity = '0';
    swipeIn = dx > 0 ? 'left' : 'right';
    setTimeout(() => { location.hash = go; }, 160);
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

function repeatText(m) {
  if (m.repeat === 'weekdays') return (m.weekdays || []).map((w) => WEEKDAYS[w - 1]).join(', ') || 'no days';
  if (m.repeat === 'interval') return `every ${m.interval || 1} days`;
  return 'every day';
}
/** A main switch for a reminder (phone and watch together; half filled when
 *  only one is on), with › to set phone and watch one by one. */
const openGroups = new Set();
function channelSwitch(id, label, cfg, ro, save, redraw) {
  const sw = (checked, onchange, aria) => h('input', { type: 'checkbox', class: 'switch', checked, disabled: ro, 'aria-label': aria, onchange });
  const on = (cfg.phone ? 1 : 0) + (cfg.watch ? 1 : 0);
  const open = openGroups.has(id);
  const head = h('div', { class: 'switch-row' },
    h('button', { type: 'button', class: 'expand' + (open ? ' open' : ''), 'aria-expanded': String(open), 'aria-label': 'Phone and watch one by one',
      onclick: () => { if (open) openGroups.delete(id); else openGroups.add(id); redraw(); } }, '›'),
    h('span', { class: 'grow' }, h('span', {}, label),
      h('span', { class: 'small muted' }, on === 2 ? 'Phone and watch' : cfg.phone ? 'Phone only' : cfg.watch ? 'Watch only' : 'Off')),
    sw(on > 0, (e) => save({ phone: e.target.checked, watch: e.target.checked }), label));
  if (on === 1) head.querySelector('.switch').classList.add('partial');
  const item = (key, text) => h('label', { class: 'switch-row sub' }, h('span', { class: 'grow' }, text),
    sw(!!cfg[key], (e) => save({ [key]: e.target.checked }), text));
  return h('div', { class: 'switch-group' }, head,
    open ? h('div', { class: 'switch-subs' }, item('phone', 'On the phone'), item('watch', 'On the watch')) : null);
}

/** The medication reminder setting (Settings), the same for all medications.
 *  The reminder function and the watch read it from each medication's
 *  `remind`, so a change is copied into every medication. */
const MED_REMINDER = { phone: true, watch: true, again: 30, count: 3 };
function medReminder() {
  const first = visibleMeds()[0];
  const r = { ...MED_REMINDER, ...((first && first.remind) || {}), ...(S.settings.medReminder || {}) };
  return { phone: !!r.phone, watch: !!r.watch, again: r.count > 1 ? r.again || 30 : 0, count: r.again > 0 ? r.count : 1 };
}

/** Saves the setting and copies it into each medication that differs. */
async function saveMedReminder(cfg) {
  S.settings = { ...DEFAULT_SETTINGS, ...(await Backend.putSettings({ ...S.settings, medReminder: cfg })) };
  store.set('gc.cache.settings', S.settings);
  for (const m of visibleMeds()) {
    const r = m.remind || {};
    if (['phone', 'watch', 'again', 'count'].every((k) => r[k] === cfg[k])) continue;
    const saved = await Backend.putMed({ ...m, remind: cfg, updatedAt: nowSec() });
    S.meds[S.meds.findIndex((x) => x.id === saved.id)] = saved;
  }
  store.set('gc.cache.meds', S.meds);
}

function medReminderPanel(ro) {
  const cfg = medReminder();
  const box = h('div', { class: 'panel' });
  async function save(patch) {
    Object.assign(cfg, patch);
    try {
      await saveMedReminder({ ...cfg });
      toast('Saved');
    } catch (e) {
      toast(e.status ? e.message : 'Could not save: server not reachable');
    }
    draw();
  }
  const select = (value, options, onchange) => h('select', { disabled: ro, onchange: (e) => onchange(Number(e.target.value)) },
    options.map(([v, t]) => h('option', { value: v, selected: value === v }, t)));
  function draw() {
    box.replaceChildren(
      channelSwitch('med', 'Medication reminders', cfg, ro, save, draw),
      h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'For all medications: at the dose time, and again while the dose is not taken or skipped.'),
      cfg.phone || cfg.watch ? h('div', { class: 'row wrap' },
        h('div', { class: 'field grow' }, h('label', {}, 'Reminders in total'),
          select(cfg.count, [[1, '1 (only at the time)'], [2, '2'], [3, '3'], [4, '4'], [5, '5']],
            (v) => save(v > 1 ? { count: v, again: cfg.again > 0 ? cfg.again : 30 } : { count: 1, again: 0 }))),
        cfg.count > 1 ? h('div', { class: 'field grow' }, h('label', {}, 'Remind again after'),
          select(cfg.again, [[10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour']], (v) => save({ again: v }))) : null) : null);
  }
  draw();
  return box;
}

function newMed() {
  return {
    id: null, name: '', unit: 'pill', times: [{ at: '08:00', dose: 1 }], repeat: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], interval: 2,
    start: todayStr(), end: null, paused: false, notes: null, deleted: false,
  };
}

function viewMedEdit(idArg) {
  const orig = idArg === 'new' ? null : S.meds.find((m) => String(m.id) === idArg && !m.deleted);
  if (idArg !== 'new' && !orig) return h('div', {}, h('p', { class: 'empty' }, 'Medication not found.'), h('a', { class: 'btn block', href: '#/meds' }, 'Back'));
  const m = orig ? JSON.parse(JSON.stringify(orig)) : newMed();
  if (!(m.weekdays || []).length) m.weekdays = [1, 2, 3, 4, 5, 6, 7];
  const ro = !S.online;
  const markDirty = () => { dirty = true; };
  const err = h('div', { class: 'error', role: 'alert' });

  const name = h('input', { type: 'text', id: 'mn', value: m.name, disabled: ro, oninput: markDirty, placeholder: 'e.g. Verapamil 120 mg' });
  const unit = h('input', { type: 'text', id: 'mu', value: m.unit || '', disabled: ro, oninput: markDirty, list: 'units' });
  const units = h('datalist', { id: 'units' }, UNITS.map((u) => h('option', { value: u })));

  const timesBox = h('div', { class: 'times' });
  function drawTimes() {
    timesBox.replaceChildren(...m.times.map((t, i) => h('div', { class: 'row' },
      h('input', { type: 'time', value: t.at, disabled: ro, 'aria-label': 'Time', onchange: (e) => { t.at = e.target.value || t.at; markDirty(); } }),
      h('input', { type: 'number', value: t.dose, min: '0', step: '0.5', inputmode: 'decimal', disabled: ro, 'aria-label': 'Dose', class: 'dose-in',
        oninput: (e) => { t.dose = Number(e.target.value) || 0; markDirty(); } }),
      h('button', { type: 'button', class: 'btn small ghost', disabled: ro || m.times.length < 2, 'aria-label': 'Remove time',
        onclick: () => { m.times.splice(i, 1); drawTimes(); markDirty(); } }, '×'))));
  }
  drawTimes();

  const weekdays = h('div', { class: 'chips' }, WEEKDAYS.map((w, i) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String((m.weekdays || []).includes(i + 1)), disabled: ro,
    onclick: (e) => {
      const on = !(m.weekdays || []).includes(i + 1);
      m.weekdays = on ? [...(m.weekdays || []), i + 1].sort() : m.weekdays.filter((x) => x !== i + 1);
      e.currentTarget.setAttribute('aria-pressed', String(on));
      markDirty();
    },
  }, w)));
  const interval = h('input', { type: 'number', min: '2', max: '90', value: m.interval || 2, disabled: ro, class: 'dose-in', 'aria-label': 'Every n days',
    oninput: (e) => { m.interval = Math.max(1, Math.round(Number(e.target.value) || 1)); markDirty(); } });
  const weekBox = h('div', { class: 'field' }, weekdays);
  const intBox = h('div', { class: 'field row' }, h('span', {}, 'Every'), interval, h('span', {}, 'days, counted from the start date'));
  const showRepeat = () => { weekBox.hidden = m.repeat !== 'weekdays'; intBox.hidden = m.repeat !== 'interval'; };
  const repeat = segmented('three', [{ v: 'daily', label: 'Every day' }, { v: 'weekdays', label: 'Weekdays' }, { v: 'interval', label: 'Every n days' }],
    () => m.repeat, (v) => { m.repeat = v || 'daily'; showRepeat(); markDirty(); }, ro);

  const start = h('input', { type: 'date', id: 'ms', value: m.start || '', disabled: ro, oninput: markDirty });
  const end = h('input', { type: 'date', id: 'me', value: m.end || '', disabled: ro, oninput: markDirty });
  const check = (label, get, set) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: get(), disabled: ro, onchange: (e) => { set(e.target.checked); markDirty(); } }), label);
  const paused = check('Paused (no doses, no reminders)', () => !!m.paused, (v) => { m.paused = v; });
  const notes = h('textarea', { disabled: ro, oninput: markDirty, placeholder: 'e.g. with food' });
  notes.value = m.notes || '';

  async function save(extra) {
    err.textContent = '';
    const out = { ...m, ...extra };
    out.name = name.value.trim();
    out.unit = unit.value.trim();
    out.start = start.value || todayStr();
    out.end = end.value || null;
    out.notes = notes.value.trim() || null;
    out.times = m.times.filter((t) => t.at).sort((a, b) => a.at.localeCompare(b.at));
    if (!out.deleted) {
      if (!out.name) { err.textContent = 'Enter a name.'; return; }
      if (new Set(out.times.map((t) => t.at)).size !== out.times.length) { err.textContent = 'Each time can be there only once.'; return; }
      if (out.repeat === 'weekdays' && !(out.weekdays || []).length) { err.textContent = 'Select at least one weekday.'; return; }
      if (out.end && out.end < out.start) { err.textContent = 'The end must be after the start.'; return; }
    }
    if (out.id == null) out.id = nowSec();
    out.remind = medReminder();
    out.updatedAt = nowSec();
    try {
      const saved = await Backend.putMed(out);
      const i = S.meds.findIndex((x) => x.id === saved.id);
      if (i >= 0) S.meds[i] = saved; else S.meds.push(saved);
      store.set('gc.cache.meds', S.meds);
      dirty = false;
      toast(out.deleted ? 'Deleted' : 'Saved');
      location.hash = '#/meds';
    } catch (e) {
      toast(e.status ? e.message : 'Could not save: server not reachable');
    }
  }

  showRepeat();
  return h('div', {},
    h('div', { class: 'topbar' },
      h('a', { class: 'back', href: '#/meds', 'aria-label': 'Back' }, '‹'),
      h('h1', {}, orig ? orig.name : 'New medication')),
    h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'mn' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'mu' }, 'Unit'), unit, units),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Times and dose'), timesBox,
        h('button', { type: 'button', class: 'btn small', style: 'margin-top:8px', disabled: ro,
          onclick: () => { m.times.push({ at: '20:00', dose: m.times[m.times.length - 1]?.dose ?? 1 }); drawTimes(); markDirty(); } }, '+ Add time')),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Days'), repeat),
      weekBox, intBox,
      h('div', { class: 'row wrap' },
        h('div', { class: 'field grow' }, h('label', { for: 'ms' }, 'Start'), start),
        h('div', { class: 'field grow' }, h('label', { for: 'me' }, 'End (optional)'), end)),
      h('p', { class: 'muted small' }, 'Reminders: one setting for all medications, in ', h('a', { href: '#/settings' }, 'Settings'), '.'),
      h('h2', {}, 'More'),
      paused,
      h('div', { class: 'field' }, h('label', {}, 'Notes'), notes),
      err,
      h('div', { class: 'actions' }, h('a', { class: 'btn ghost', href: '#/meds' }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', disabled: ro }, 'Save')),
      orig ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', disabled: ro, onclick: () => {
        if (confirm(`Delete ${orig.name}? Its logged doses stay in the history.`)) save({ deleted: true });
      } }, 'Delete medication')) : null));
}

/** Reminder for an attack timer left running; saved at once, read by the
 *  reminder function (phone) and by the watch through its sync. */
function attackReminderPanel(ro) {
  const cfg = { ...Sched.ATTACK_REMINDER, ...(S.settings.attackReminder || {}) };
  async function save(patch) {
    Object.assign(cfg, patch);
    try {
      S.settings = { ...DEFAULT_SETTINGS, ...(await Backend.putSettings({ ...S.settings, attackReminder: { ...cfg } })) };
      store.set('gc.cache.settings', S.settings);
      toast('Saved');
    } catch (e) {
      toast(e.status ? e.message : 'Could not save: server not reachable');
    }
    draw();
  }
  const box = h('div', { class: 'panel' });
  const select = (value, options, onchange) => h('select', { disabled: ro, onchange: (e) => onchange(Number(e.target.value)) },
    options.map(([v, t]) => h('option', { value: v, selected: value === v }, t)));
  function draw() {
    const on = cfg.phone || cfg.watch;
    box.replaceChildren(
      channelSwitch('attack', 'Running attack reminder', cfg, ro, save, draw),
      h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'If an attack timer is still running after some time, you get a reminder to end it.'),
      on ? h('div', { class: 'row wrap' },
        h('div', { class: 'field grow' }, h('label', {}, 'After'),
          select(cfg.after, [[30, '30 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']], (v) => save({ after: v }))),
        h('div', { class: 'field grow' }, h('label', {}, 'Reminders in total'),
          select(cfg.again > 0 ? cfg.count : 1, [[1, '1 (only once)'], [2, '2'], [3, '3'], [4, '4']],
            (v) => save(v > 1 ? { count: v, again: cfg.again > 0 ? cfg.again : 60 } : { count: 1, again: 0 }))),
        cfg.again > 0 ? h('div', { class: 'field grow' }, h('label', {}, 'Remind again after'),
          select(cfg.again, [[30, '30 min'], [60, '1 hour'], [120, '2 hours']], (v) => save({ again: v }))) : null) : null);
  }
  draw();
  return box;
}

// ------------------------------------------------------------------ phone reminders (Web Push)

const urlKey = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

function pushPanel() {
  const box = h('div', { class: 'panel' });
  // replaceChildren() would show null as text.
  const show = (...parts) => box.replaceChildren(...parts.filter(Boolean));
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.GC_CONFIG.vapidKey;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  async function draw() {
    if (!supported) {
      show(h('div', {}, 'This browser cannot show reminders.'),
        ios && !installed ? h('div', { class: 'muted small' }, 'On iPhone: tap Share → Add to Home Screen, then open gcluster from the home screen and come back here.') : null);
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      show(h('div', {}, 'Reminders are on for this device.'),
        h('div', { class: 'muted small' }, 'Each medication sets if it reminds on the phone.'),
        h('div', { class: 'row wrap', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn small', onclick: async () => {
          try {
            const r = await Backend.testPush();
            toast(r.delivered ? `Test sent to ${r.delivered} device${r.delivered === 1 ? '' : 's'}` : 'No device got the test');
          } catch (e) {
            toast(e.status ? e.message : 'Needs a connection');
          }
        } }, 'Send a test'), h('button', { type: 'button', class: 'btn small ghost', onclick: async () => {
          try { await Backend.deletePush(sub.endpoint); } catch (e) { /* removed on the server later */ }
          await sub.unsubscribe();
          toast('Reminders off on this device');
          draw();
        } }, 'Turn off on this device')));
      return;
    }
    show(
      h('div', {}, Notification.permission === 'denied' ? 'Notifications are blocked for this app. Allow them in the browser or system settings.' : 'Reminders are off on this device.'),
      ios && !installed ? h('div', { class: 'muted small' }, 'On iPhone, reminders work only when gcluster is on the home screen.') : null,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn small primary', disabled: !S.online || Notification.permission === 'denied', onclick: async () => {
        try {
          if (await Notification.requestPermission() !== 'granted') { draw(); return; }
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(window.GC_CONFIG.vapidKey) });
          await Backend.savePush(s, ios ? 'iPhone' : navigator.platform || 'Browser');
          toast('Reminders on');
        } catch (e) {
          toast(e.status ? e.message : `Could not turn on reminders: ${e.message || e}`);
        }
        draw();
      } }, 'Turn on reminders')));
  }
  draw().catch(() => show(h('div', { class: 'muted' }, 'Could not check the reminders.')));
  return box;
}

// ------------------------------------------------------------------ stats

const DAY = 86400;
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** Local noon of the day of sec, in ms; day differences are then whole numbers. */
const noonMs = (sec) => { const d = new Date(sec * 1000); d.setHours(12, 0, 0, 0); return d.getTime(); };
const daysBetween = (a, b) => Math.round((noonMs(b) - noonMs(a)) / (DAY * 1000));
function median(xs) {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const niceMax = (v) => (v <= 4 ? Math.max(1, v) : v <= 10 ? Math.ceil(v / 2) * 2 : Math.ceil(v / 5) * 5);
/** Chart width in SVG units: the real width, so text keeps its size on phones. */
const chartW = () => Math.round(Math.min(820, Math.max(320, (document.getElementById('view').clientWidth || 360) - 40)));

/** Rounded top, square base, anchored on the baseline. */
function barPath(cx, bw, y0, hh) {
  const r = Math.min(4, bw / 2, hh);
  return `M${cx - bw / 2},${y0}V${y0 - hh + r}Q${cx - bw / 2},${y0 - hh} ${cx - bw / 2 + r},${y0 - hh}H${cx + bw / 2 - r}Q${cx + bw / 2},${y0 - hh} ${cx + bw / 2},${y0 - hh + r}V${y0}Z`;
}

/** Floating tooltip in a .chart box: hover with a mouse, tap on touch screens. */
function chartTip(box, svg) {
  const tip = h('div', { class: 'tip', hidden: true });
  box.append(tip);
  return (target, vx, vy, lines) => {
    const show = () => {
      const r = svg.getBoundingClientRect(), b = box.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      tip.replaceChildren(h('b', {}, lines[0]), ...lines.slice(1).flatMap((l) => [h('br'), l]));
      tip.style.left = `${r.left - b.left + (vx * r.width) / vb.width}px`;
      tip.style.top = `${r.top - b.top + (vy * r.height) / vb.height}px`;
      tip.hidden = false;
    };
    target.addEventListener('pointerenter', show);
    target.addEventListener('pointerdown', (e) => { e.stopPropagation(); show(); });
    target.addEventListener('focus', show);
    target.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') tip.hidden = true; });
    target.addEventListener('blur', () => { tip.hidden = true; });
  };
}
document.addEventListener('pointerdown', () => { for (const t of document.querySelectorAll('.tip')) t.hidden = true; });

const painClass = (p) => (p == null ? 'p-none' : p <= 5 ? 'p-low' : p <= 7 ? 'p-mid' : 'p-high');

/** Every attack as a dot by date and peak pain; the longest breaks as bands behind. */
function timelineChart(all, gaps) {
  const box = h('div', { class: 'chart' });
  const W = chartW(), H = W < 500 ? 200 : 230, L = 30, R = 10, T = 12, B = 30;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Attacks by date and peak pain' });
  box.append(svg);
  const first = new Date(all[0].start * 1000), now = new Date();
  const t0 = new Date(first.getFullYear(), first.getMonth(), 1).getTime();
  const t1 = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const x = (ms) => L + ((ms - t0) / (t1 - t0)) * (W - L - R);
  const y = (p) => T + ((10 - p) / 10) * (H - T - B);
  for (const g of gaps.slice(0, 3)) {
    // Inset 2 px on each side, so bands that share an attack stay apart.
    const x0 = x(noonMs(g.from)) + 2, x1 = x(noonMs(g.to)) - 2;
    if (x1 - x0 < 4) continue;
    svg.append(s('rect', { class: 'band', x: x0, y: T, width: x1 - x0, height: H - T - B }));
    if (x1 - x0 > 44) svg.append(s('text', { class: 'ink mono', x: (x0 + x1) / 2, y: T + 14, 'text-anchor': 'middle' }, `${g.days} d`));
  }
  for (const v of [0, 5, 10]) {
    svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  const months = (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() + 1;
  const every = Math.max(1, Math.ceil(months / ((W - L - R) / 48)));
  for (let i = 0; i <= months; i++) {
    const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const xx = x(d.getTime());
    svg.append(s('line', { class: 'axis', x1: xx, x2: xx, y1: H - B, y2: H - B + 4 }));
    if (i < months && i % every === 0) {
      const yr = d.getMonth() === 0 || i === 0 ? ` ${String(d.getFullYear()).slice(2)}` : '';
      svg.append(s('text', { x: xx + 2, y: H - B + 17 }, MON_SHORT[d.getMonth()] + yr));
    }
  }
  svg.append(s('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }));
  const tip = chartTip(box, svg);
  for (const a of all) {
    const cx = x(noonMs(a.start)), cy = y(a.peak ?? 0);
    svg.append(s('circle', { class: 'dot ' + painClass(a.peak), cx, cy, r: 5.5 }));
    const hit = s('circle', { class: 'hit', cx, cy, r: 11, tabindex: 0 });
    hit.addEventListener('click', () => { location.hash = `#/attack/${a.id}`; });
    const d = durMin(a);
    tip(hit, cx, cy, [`${fmtDate(a.start)} · ${fmtTime(a.start)}`,
      `Pain ${a.peak ?? '?'}/10${d != null ? ` · ${fmtDur(d)}` : ''}`, ...(a.abortive ? [a.abortive] : [])]);
    svg.append(hit);
  }
  const legend = h('div', { class: 'legend' },
    [['p-low', 'Pain 1–5'], ['p-mid', '6–7'], ['p-high', '8–10'], ['p-none', 'Not rated (at 0)']]
      .map(([c, t]) => h('span', {}, h('i', { class: c }), t)),
    gaps.length ? h('span', {}, h('i', { class: 'band' }), `The ${Math.min(3, gaps.length)} longest breaks`) : null);
  return h('div', { class: 'panel' }, box, legend);
}

/** One rounded bar per slot, values labelled above, a tooltip per slot. */
function barsChart({ values, label, sublabel, tipLines, height = 170, valueLabels = false, band = null, aria }) {
  const box = h('div', { class: 'chart' });
  const W = chartW(), H = height, L = 30, R = 10, T = band ? 26 : 16, B = sublabel ? 34 : 26;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria });
  box.append(svg);
  const max = niceMax(Math.max(1, ...values));
  const slot = (W - L - R) / values.length;
  const bw = Math.max(2, Math.min(28, slot - Math.min(8, slot * 0.3)));
  const y = (v) => T + ((max - v) / max) * (H - T - B);
  if (band) {
    svg.append(s('rect', { class: 'band', x: L + slot * band.from, y: T, width: slot * (band.to - band.from), height: H - T - B, rx: 4 }));
    // The label sits above the band, so it never covers a bar.
    svg.append(s('text', { class: 'ink', x: L + slot * band.from + 6, y: T - 8 }, band.text));
  }
  for (const v of [0, max / 2, max]) {
    if (!Number.isInteger(v)) continue;
    svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  const tip = chartTip(box, svg);
  values.forEach((v, i) => {
    const cx = L + slot * i + slot / 2;
    if (v > 0) {
      svg.append(s('path', { class: 'bar', d: barPath(cx, bw, y(0), y(0) - y(v)) }));
      if (valueLabels && slot >= 14) svg.append(s('text', { class: 'ink mono', x: cx, y: y(v) - 5, 'text-anchor': 'middle' }, String(v)));
    }
    const lab = label(i);
    if (lab != null) svg.append(s('text', { x: cx, y: H - B + 16, 'text-anchor': 'middle' }, lab));
    const sub = sublabel && sublabel(i);
    if (sub != null) svg.append(s('text', { x: cx, y: H - B + 29, 'text-anchor': 'middle' }, sub));
    const hit = s('rect', { class: 'hit', x: cx - slot / 2, y: T, width: slot, height: H - T - B });
    tip(hit, cx, y(v), tipLines(i));
    svg.append(hit);
  });
  svg.append(s('line', { class: 'axis', x1: L, x2: W - R, y1: y(0), y2: y(0) }));
  return box;
}

function viewStats() {
  const all = visibleAttacks().slice().reverse(); // oldest first
  const head = h('header', { class: 'stats-head' },
    h('div', { class: 'eyebrow' }, 'Attack diary'),
    h('h1', {}, all.length ? `Course, ${fmtMonth(all[0].start)} – ${fmtMonth(all[all.length - 1].start)}` : 'Course'));
  if (!all.length) return h('div', { class: 'stats' }, head, h('div', { class: 'empty' }, S.loaded ? 'No attacks yet.' : 'Loading…'));

  const now = nowSec();
  const last = all[all.length - 1];
  const peaks = all.map((a) => a.peak).filter((p) => p != null);
  const durs = all.map(durMin).filter((m) => m != null);
  const hours = Array(24).fill(0);
  for (const a of all) hours[new Date(a.start * 1000).getHours()] += 1;
  const night = hours.slice(0, 4).reduce((x, y) => x + y, 0);
  const since = (days) => all.filter((a) => a.start >= now - days * DAY);
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    const days = daysBetween(all[i - 1].start, all[i].start);
    if (days >= 7) gaps.push({ days, from: all[i - 1].start, to: all[i].start });
  }
  gaps.sort((a, b) => b.days - a.days);
  const ab30 = new Map();
  for (const a of since(30)) if (a.abortive) ab30.set(a.abortive, (ab30.get(a.abortive) || 0) + 1);
  const ab30n = [...ab30.values()].reduce((x, y) => x + y, 0);

  // months from the first attack to now
  const first = new Date(all[0].start * 1000), today = new Date();
  const nMonths = (today.getFullYear() - first.getFullYear()) * 12 + today.getMonth() - first.getMonth() + 1;
  const months = Array.from({ length: nMonths }, (_, i) => ({ d: new Date(first.getFullYear(), first.getMonth() + i, 1), n: 0 }));
  for (const a of all) {
    const d = new Date(a.start * 1000);
    months[(d.getFullYear() - first.getFullYear()) * 12 + d.getMonth() - first.getMonth()].n += 1;
  }
  const busiest = months.reduce((m, x) => (x.n > m.n ? x : m), months[0]);
  const monthName = (d) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const fact = (k, ...v) => h('div', {}, h('dt', {}, k), h('dd', {}, ...v));
  const num = (v) => h('span', { class: 'num' }, v);
  const facts = h('dl', { class: 'facts' },
    fact('Attacks', num(all.length), ` from ${fmtDay(all[0].start)} to ${fmtDay(last.start)}`),
    fact('Last attack', `${fmtDay(last.start)}, `, num(daysBetween(last.start, now)), ' days ago'),
    fact('Recent', num(since(7).length), ' in the last 7 days, ', num(since(30).length), ' in the last 30'),
    fact('Busiest month', `${monthName(busiest.d)}: `, num(busiest.n), ' attacks'),
    fact('Longest break', gaps.length ? [num(gaps[0].days), ` days, ${fmtDay(gaps[0].from)} – ${fmtDay(gaps[0].to)}`] : 'None of 7 days or more'),
    fact('Time of day', num(night), ' of ', num(all.length), ' start between 00:00 and 04:00'),
    fact('Pain', peaks.length ? ['Median ', num(median(peaks)), '/10, range ', num(`${Math.min(...peaks)}–${Math.max(...peaks)}`)] : 'Not rated yet'),
    fact('Duration', durs.length ? ['Median ', num(fmtDur(Math.round(median(durs)))), ', range ', num(`${Math.min(...durs)}–${Math.max(...durs)}`), ' min'] : 'No ended attacks'),
    fact('Abortives, 30 days', ab30n ? [num(ab30n), ' uses: ', [...ab30.entries()].map(([n, c]) => `${c} ${n}`).join(', ')] : 'None'),
  );

  // abortive effect table
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
  const untreated = all.filter((a) => !a.abortive).length;
  const td = (v, cls = 'r num') => h('td', { class: cls || null }, v);
  const medTable = h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Abortive'), h('th', { class: 'r' }, 'Uses'), h('th', { class: 'r' }, 'Worked'),
      h('th', { class: 'r' }, 'Partly'), h('th', { class: 'r' }, 'Did not work'), h('th', { class: 'r' }, 'Not rated'), h('th', { class: 'r' }, 'Relief'))),
    h('tbody', {}, abRows.map(([name, e]) => h('tr', {}, td(name, ''), td(e.n), td(e[2]), td(e[1]), td(e[0]), td(e.none),
      td(e.relief.length ? `${Math.round(median(e.relief))} min` : '–'))))));

  // triggers
  const tags = new Map();
  for (const a of all) for (const t of a.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  const tagRows = [...tags.entries()].sort((x, y) => y[1] - x[1]);

  const pad2 = (i) => String(i).padStart(2, '0');
  return h('div', { class: 'stats' },
    head,
    h('section', {}, h('h2', {}, 'Key facts'), facts),
    h('section', {},
      h('h2', {}, 'Course'),
      h('p', { class: 'lead' }, 'Each dot is an attack, by date and peak pain. Shaded: the longest breaks without an attack.'),
      timelineChart(all, gaps),
      h('div', { class: 'panel' },
        h('div', { class: 'small muted' }, 'Attacks per month'),
        barsChart({
          values: months.map((m) => m.n), valueLabels: true, aria: 'Attacks per month',
          label: (i) => (nMonths <= 24 || i % 3 === 0 ? MON_SHORT[months[i].d.getMonth()].slice(0, nMonths > 12 ? 1 : 3) : null),
          sublabel: (i) => (months[i].d.getMonth() === 0 || i === 0 ? String(months[i].d.getFullYear()) : null),
          tipLines: (i) => [monthName(months[i].d), plural(months[i].n, 'attack')],
        })),
      gaps.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Longest breaks'), h('th', { class: 'r' }, 'Days'))),
        h('tbody', {}, gaps.slice(0, 5).map((g) => h('tr', {}, td(`${fmtDay(g.from)} – ${fmtDay(g.to)}`, ''), td(g.days)))))) : null),
    h('section', {},
      h('h2', {}, 'Time of day'),
      h('p', { class: 'lead' }, `Onset of all ${all.length} attacks by hour.`),
      h('div', { class: 'panel' }, barsChart({
        values: hours, aria: 'Attacks by hour of onset',
        band: { from: 0, to: 4, text: `00–04: ${night} of ${all.length}` },
        label: (i) => (i % 3 === 0 ? pad2(i) : null),
        tipLines: (i) => [`${pad2(i)}:00–${pad2(i)}:59`, plural(hours[i], 'attack')],
      }))),
    h('section', {},
      h('h2', {}, 'Abortives and effect'),
      h('p', { class: 'lead' }, 'Your own rating after each use. Relief: median minutes from the abortive to relief.'),
      abRows.length ? medTable : h('p', { class: 'muted' }, 'No abortives recorded yet.'),
      untreated ? h('p', { class: 'small muted' }, `Without an abortive: ${plural(untreated, 'attack')}.`) : null),
    h('section', {},
      h('h2', {}, 'Possible triggers'),
      h('p', { class: 'lead' }, 'Tags set when logging; an attack can have several, most have none.'),
      tagRows.length
        ? h('div', { class: 'bars' }, tagRows.map(([t, n]) => h('div', { class: 'bar-row' },
          h('span', {}, t), h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${(n / tagRows[0][1]) * 100}%` })), h('span', { class: 'num' }, n))))
        : h('p', { class: 'muted' }, 'No tags recorded yet.')),
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
    h('h2', {}, 'Reminders on this device'),
    h('p', { class: 'muted small' }, 'Phone reminders (medication and a running attack) need this on.'),
    pushPanel(),
    h('h2', {}, 'What reminds you'),
    medReminderPanel(ro),
    attackReminderPanel(ro),
    h('h2', {}, 'About'),
    h('div', { class: 'panel' },
      h('div', { class: 'small muted' }, 'Version'),
      h('div', { class: 'num' }, (() => {
        const v = window.GC_VERSION || {};
        return v.version || '?';
      })())),
    h('h2', {}, 'Account'),
    h('div', { class: 'panel' }, h('div', { class: 'small muted' }, 'Signed in as'), h('div', {}, Backend.email() || '')),
    h('details', { class: 'pwbox' }, h('summary', {}, 'Set or change password'), passwordPanel(ro)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!confirm('Sign out and remove the saved data from this device? Your data stays in your account.')) return;
        await Backend.signOut();
        for (const k of ['gc.cache.attacks', 'gc.cache.settings', 'gc.cache.time', 'gc.cache.meds', 'gc.cache.doses']) store.del(k);
        S.attacks = []; S.meds = []; S.doses = []; S.settings = DEFAULT_SETTINGS; S.lastSync = null;
        setOnline(true);
        location.hash = '#/setup';
        render();
      } }, 'Sign out')),
  );
}

// ------------------------------------------------------------------ updates

/** Each deploy has a new service worker (scripts/deploy-web.sh). When it
 *  takes over, reload, but not over a form with unsaved changes: then wait
 *  until it is saved or left. */
function watchUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller; // the first install needs no reload
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => { /* e.g. file:// or private mode */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    const tryReload = () => { if (dirty) setTimeout(tryReload, 2000); else location.reload(); };
    tryReload();
  });
  // iOS resumes the old page instead of starting the app again, so also
  // look for a new version on resume and every minute while open.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  setInterval(() => { if (document.visibilityState === 'visible') checkForUpdate(); }, 60000);
}

/** Compares the deployed version.js with this page's version; on a
 *  difference, the browser fetches the new service worker. */
async function checkForUpdate() {
  try {
    const text = await (await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' })).text();
    // Version and commit: a redeploy of the same version with other code counts too.
    const id = (t) => [(t.match(/version: '([^']*)'/) || [])[1], (t.match(/rev: '([^']*)'/) || [])[1]].join('/');
    const v = window.GC_VERSION || {};
    if (!(text.match(/rev: '([^']*)'/) || [])[1] || id(text) === `${v.version}/${v.rev}`) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch (e) { /* offline: try again later */ }
}

// ------------------------------------------------------------------ boot

async function boot() {
  Backend.takeSessionFromUrl();
  watchUpdates();
  render();
  if (Backend.signedIn()) {
    await refresh();
    const r = route().name;
    // don't wipe a form the user already started typing into
    if (!(dirty && (r === 'attack' || r === 'new'))) render({ keepScroll: true });
  }
}

window.addEventListener('online', () => { if (Backend.signedIn()) refresh().then(() => { if (!dirty) render({ keepScroll: true }); }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Backend.signedIn() && !dirty) refresh().then(() => { if (!dirty) render({ keepScroll: true }); });
});

boot();

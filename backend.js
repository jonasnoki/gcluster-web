/* gcluster backend client: Supabase Auth (email code) and the REST API of
 * the tables in supabase/migrations. Plain fetch, no library. */
'use strict';

const GC = window.GC_CONFIG || {};

class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const SESSION_KEY = 'gc.session';

const Backend = {
  session: (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } })(),

  configured() { return !!(GC.url && GC.key); },
  signedIn() { return !!(this.session && this.session.refresh_token); },
  userId() { return this.session && this.session.user && this.session.user.id; },
  email() { return this.session && this.session.user && this.session.user.email; },

  saveSession(s) {
    this.session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* storage blocked: session lasts for this page only */ }
  },

  async request(path, { method = 'GET', body, auth = true, headers = {}, timeout = 12000 } = {}) {
    if (auth) await this.freshToken();
    const h = { apikey: GC.key, ...headers };
    if (auth && this.session) h.Authorization = 'Bearer ' + this.session.access_token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(GC.url + path, {
        method, headers: h, signal: ctrl.signal, cache: 'no-store',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError('Server not reachable', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.msg || j.message || j.error_description || j.error || ''; } catch (e) { /* not JSON */ }
      if (res.status === 401 && auth) this.saveSession(null);
      throw new ApiError(detail || `Server error ${res.status}`, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  // ---- auth: email and password, or a 6-digit code by email (stays inside the installed PWA)

  async sendCode(email) {
    // If the email has a link instead of a code, it leads back here.
    const back = encodeURIComponent(location.origin + location.pathname);
    await this.request('/auth/v1/otp?redirect_to=' + back, { method: 'POST', auth: false, body: { email, create_user: true } });
  },

  /** Sign-in links return with the session in the URL fragment. */
  takeSessionFromUrl() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!p.get('access_token') || !p.get('refresh_token')) return false;
    const expiresIn = Number(p.get('expires_in')) || 3600;
    let user = null;
    try { user = JSON.parse(atob(p.get('access_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { /* not a JWT */ }
    this.saveSession({
      access_token: p.get('access_token'),
      refresh_token: p.get('refresh_token'),
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      user: user ? { id: user.sub, email: user.email } : null,
    });
    history.replaceState(null, '', location.pathname + '#/attacks');
    return true;
  },

  async verifyCode(email, token) {
    const s = await this.request('/auth/v1/verify', { method: 'POST', auth: false, body: { type: 'email', email, token } });
    s.expires_at = Math.floor(Date.now() / 1000) + (s.expires_in || 3600);
    this.saveSession(s);
  },

  async signInPassword(email, password) {
    const s = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
    s.expires_at = Math.floor(Date.now() / 1000) + (s.expires_in || 3600);
    this.saveSession(s);
  },

  /** Set or change the password of the signed-in user. */
  async setPassword(password) {
    await this.request('/auth/v1/user', { method: 'PUT', body: { password } });
  },

  async freshToken() {
    const s = this.session;
    if (!s) throw new ApiError('Not signed in', 401);
    if (s.expires_at - 60 > Date.now() / 1000) return;
    const n = await this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, body: { refresh_token: s.refresh_token },
    });
    n.expires_at = Math.floor(Date.now() / 1000) + (n.expires_in || 3600);
    this.saveSession(n);
  },

  async signOut() {
    try { await this.request('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* already gone */ }
    this.saveSession(null);
  },

  // ---- attacks: rows hold the full object in `data`; deletes are tombstones

  async listAttacks() {
    const rows = await this.request('/rest/v1/attacks?select=data&order=start.desc');
    return rows.map((r) => r.data);
  },

  async putAttack(a) {
    const data = { ...a, updatedAt: Math.max(a.updatedAt || 0, Math.floor(Date.now() / 1000)) };
    const rows = await this.request('/rest/v1/attacks?on_conflict=user_id,id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{ user_id: this.userId(), id: a.id, start: a.start, updated_at: data.updatedAt, data }],
    });
    return rows[0].data;
  },

  async deleteAttack(a) {
    return this.putAttack({ ...a, deleted: true });
  },

  // ---- settings (abortive and tag lists for the forms)

  async getSettings() {
    const rows = await this.request('/rest/v1/settings?select=data');
    return rows.length ? rows[0].data : null;
  },

  async putSettings(data) {
    const rows = await this.request('/rest/v1/settings?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{ user_id: this.userId(), data }],
    });
    return rows[0].data;
  },

  // ---- devices (watches): the code is shown once, only its hash is stored

  async createDeviceCode(label) {
    return this.request('/rest/v1/rpc/create_device_token', { method: 'POST', body: { p_label: label } });
  },

  async listDevices() {
    return this.request('/rest/v1/devices?select=id,label,created_at,last_seen&order=created_at.desc');
  },

  async deleteDevice(id) {
    await this.request('/rest/v1/devices?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
  },
};

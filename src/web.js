// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Local dashboard server (127.0.0.1 only). One instance per machine: the first Claude session
// that starts this MCP hosts it; other sessions see the port taken and share that dashboard.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, CLAUDE_JSON, HOME, normProject, projKey, log } from './util.js';
import { inventory, invalidateInventory, knownProjects, ackNew, getMcpConfig } from './scan.js';
import { setItemState } from './toggle.js';
import { probeServer } from './probe.js';
import { Tracker } from './tracker.js';
import { updateState } from './state.js';

const APP_ID = 'claude-token-dashboard';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const DEFAULT_PORT = Number(process.env.TOKEN_DASHBOARD_PORT) || 7377;

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.app === APP_ID ? j : null;
  } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

export class Dashboard {
  constructor({ launchProject, port = DEFAULT_PORT }) {
    this.launchProject = normProject(launchProject || process.cwd());
    this.port = port;
    this.hosting = false;
    this.clients = new Set();
    this.watchers = [];
    this.watchedProjects = new Set();
    this.savingsCache = new Map();
    this.probing = new Set();
  }

  get url() { return `http://127.0.0.1:${this.port}/`; }

  /** Host the dashboard if nobody else is. Retries quietly so a surviving session can take over. */
  async ensure() {
    if (this.hosting) return { url: this.url, hosting: true };
    const other = await ping(this.port);
    if (other) {
      this.scheduleTakeover();
      return { url: this.url, hosting: false, hostPid: other.pid };
    }
    try {
      await this.listen();
      return { url: this.url, hosting: true };
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        this.scheduleTakeover();
        return { url: this.url, hosting: false, error: `Port ${this.port} is used by another program. Set TOKEN_DASHBOARD_PORT to change it.` };
      }
      throw e;
    }
  }

  scheduleTakeover() {
    if (this.takeover) return;
    this.takeover = setInterval(async () => {
      if (this.hosting || (await ping(this.port))) return;
      try { await this.listen(); clearInterval(this.takeover); this.takeover = null; log('took over hosting the dashboard'); } catch {}
    }, 20000);
    this.takeover.unref();
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
        log('request failed:', e.stack || e.message);
        if (!res.headersSent) send(res, 500, { ok: false, message: e.message });
      }));
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.hosting = true;
        this.startBackground();
        log(`dashboard at ${this.url}`);
        resolve();
      });
    });
  }

  startBackground() {
    this.tracker = new Tracker({ savingsFor: (cwd) => this.savingsFor(cwd) });
    this.tracker.on('update', () => this.broadcastSoon('usage'));
    this.tracker.start().catch((e) => log('tracker failed:', e.message));
    this.watchProject(this.launchProject);
    const watchPath = (p, opts, filter) => {
      try {
        const w = fs.watch(p, opts, (_e, name) => { if (!filter || filter(String(name || ''))) this.onConfigChange(); });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {}
    };
    watchPath(path.join(CLAUDE_DIR, 'skills'), { recursive: true });
    watchPath(path.join(CLAUDE_DIR, 'commands'), { recursive: true });
    watchPath(path.join(CLAUDE_DIR, 'plugins'), {}, (n) => n.includes('installed_plugins'));
    watchPath(CLAUDE_DIR, {}, (n) => n === 'settings.json');
    watchPath(path.dirname(CLAUDE_JSON), {}, (n) => n === path.basename(CLAUDE_JSON));
    // Fallback rescan for anything the watchers miss.
    this.rescanTimer = setInterval(() => this.rescan(), 15000);
    this.rescanTimer.unref();
  }

  watchProject(project) {
    const k = projKey(project);
    if (this.watchedProjects.has(k) || !fs.existsSync(project) || projKey(project) === projKey(HOME)) return;
    this.watchedProjects.add(k);
    try {
      const w = fs.watch(project, {}, (_e, n) => { if (['.mcp.json', '.claude'].includes(String(n))) this.onConfigChange(); });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch {}
    const dot = path.join(project, '.claude');
    if (fs.existsSync(dot)) {
      try {
        const w = fs.watch(dot, { recursive: true }, () => this.onConfigChange());
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {}
    }
  }

  onConfigChange() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.rescan(), 700);
  }

  /** Rescan every watched project; tell open dashboards if anything changed or appeared. */
  rescan() {
    this.savingsCache.clear();
    invalidateInventory();
    let changed = false;
    const projects = new Set([this.launchProject, ...(this.activeProjects || [])]);
    for (const p of projects) {
      try {
        const inv = inventory(p, { fresh: true });
        const sig = JSON.stringify([inv.totals, inv.newItems.length, inv.mcps.length, inv.skills.length, inv.plugins.map((x) => x.state)]);
        const key = projKey(p);
        this.sigs ||= new Map();
        if (this.sigs.get(key) !== sig) { this.sigs.set(key, sig); changed = true; }
      } catch (e) { log('scan failed:', e.message); }
    }
    if (changed) this.broadcast('inventory');
  }

  savingsFor(cwd) {
    const k = projKey(cwd);
    const hit = this.savingsCache.get(k);
    if (hit && Date.now() - hit.at < 10000) return hit.v;
    let v = { saved: 0, items: [] };
    try {
      const inv = inventory(cwd, { track: false });
      v = { saved: inv.totals.savedTokens, items: inv.savingsItems.map((s) => ({ id: s.id, saved: s.saved })) };
    } catch {}
    this.savingsCache.set(k, { at: Date.now(), v });
    return v;
  }

  broadcastSoon(type) {
    if (this.bcTimer) return;
    this.bcTimer = setTimeout(() => { this.bcTimer = null; this.broadcast(type); }, 400);
  }

  broadcast(type, data = {}) {
    const msg = `event: ${type}\ndata: ${JSON.stringify({ at: Date.now(), ...data })}\n\n`;
    for (const c of this.clients) { try { c.write(msg); } catch {} }
  }

  async handle(req, res) {
    // Block DNS-rebinding and cross-site requests: only localhost pages may talk to us.
    const host = (req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { ok: false, message: 'Forbidden host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { ok: false, message: 'Forbidden origin' });

    const url = new URL(req.url, this.url);
    const project = normProject(url.searchParams.get('project') || this.launchProject);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (route === 'GET /api/ping') return send(res, 200, { app: APP_ID, pid: process.pid, launchProject: this.launchProject });

    if (route === 'GET /api/projects') {
      return send(res, 200, { launchProject: this.launchProject, projects: knownProjects(this.launchProject) });
    }

    if (route === 'GET /api/inventory') {
      this.activeProjects = new Set([...(this.activeProjects || []), project].slice(-5));
      this.watchProject(project);
      return send(res, 200, inventory(project, { fresh: url.searchParams.has('fresh') }));
    }

    if (route === 'GET /api/stats') {
      if (!this.tracker) return send(res, 200, { ready: false });
      return send(res, 200, this.tracker.snapshot(project));
    }

    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      this.clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(hb); this.clients.delete(res); });
      return;
    }

    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' });
    const body = await readBody(req).catch(() => null);
    if (!body) return send(res, 400, { ok: false, message: 'Bad JSON' });
    const bproject = normProject(body.project || project);

    if (url.pathname === '/api/toggle') {
      let r;
      try { r = setItemState({ project: bproject, id: body.id, state: body.state, scope: body.scope }); }
      catch (e) { r = { ok: false, message: e.message }; }
      this.savingsCache.clear();
      this.broadcast('inventory');
      return send(res, r.ok ? 200 : 400, r);
    }

    if (url.pathname === '/api/probe') {
      const inv = inventory(bproject, { fresh: true, track: false });
      const ids = body.all ? inv.mcps.filter((m) => !m.measured || body.remeasure).map((m) => m.id) : [body.id];
      const results = await Promise.all(ids.map(async (id) => {
        const raw = getMcpConfig(bproject, id);
        if (!raw) return { id, status: 'error', error: 'Unknown server' };
        if (this.probing.has(id)) return { id, status: 'busy' };
        this.probing.add(id);
        this.broadcast('probing', { id, on: true });
        try { return { id, ...(await probeServer(raw.name, raw.cfg)) }; }
        finally { this.probing.delete(id); this.broadcast('probing', { id, on: false }); }
      }));
      invalidateInventory();
      this.savingsCache.clear();
      this.broadcast('inventory');
      return send(res, 200, { ok: true, results: results.map(({ tools, ...r }) => r) });
    }

    if (url.pathname === '/api/ack') {
      ackNew(body.ids || 'all');
      this.broadcast('inventory');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/prefs') {
      if (body.mcpMode && ['auto', 'deferred', 'full'].includes(body.mcpMode)) {
        updateState((s) => { s.prefs.mcpMode = body.mcpMode; });
      }
      invalidateInventory();
      this.savingsCache.clear();
      this.broadcast('inventory');
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/reset-savings') {
      this.tracker?.resetSavings();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false, message: 'Not found' });
  }

  close() {
    clearInterval(this.takeover);
    clearInterval(this.rescanTimer);
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.tracker?.stop();
    for (const c of this.clients) { try { c.end(); } catch {} }
    this.server?.close();
  }
}

export function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  });
}

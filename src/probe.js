// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Measures an MCP server: connects like Claude Code does, asks for its tool list and
// server instructions, and estimates the tokens those definitions take up.
import { spawn } from 'node:child_process';
import { estTokens, expandVars, log } from './util.js';
import { updateState } from './state.js';
import { mcpConfigHash } from './scan.js';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'claude-token-dashboard', version: '1.0.0' };
const TIMEOUT_MS = 60000;

function summarise(tools, init) {
  const list = (tools || []).map((t) => {
    const def = { name: t.name, description: t.description || '', input_schema: t.inputSchema || {} };
    return { name: t.name, tokens: estTokens(JSON.stringify(def)) };
  });
  const instructions = init?.instructions || '';
  return {
    status: 'ok',
    tools: list,
    schemaTokens: list.reduce((n, t) => n + t.tokens, 0),
    instructionsTokens: instructions ? estTokens(instructions) + 10 : 0,
    serverName: init?.serverInfo?.name || '',
    serverVersion: init?.serverInfo?.version || '',
  };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function needsShell(command) {
  if (process.platform !== 'win32') return false;
  if (/[\\/]/.test(command)) return false;
  return !/^(cmd|node|python3?|powershell|pwsh|uvx?|deno|bun)(\.exe)?$/i.test(command);
}

function probeStdio(cfg, pluginRoot) {
  return new Promise((resolve) => {
    const vars = pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {};
    const command = expandVars(cfg.command, vars);
    const args = expandVars(cfg.args || [], vars);
    const env = { ...process.env, ...expandVars(cfg.env || {}, vars), TOKEN_DASHBOARD_PROBE: '1' };
    const shell = needsShell(command);
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    let child;
    try {
      child = shell
        ? spawn([command, ...args].map(quote).join(' '), { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: cfg.cwd })
        : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: cfg.cwd, detached: process.platform !== 'win32' });
    } catch (e) {
      resolve({ status: 'error', error: e.message });
      return;
    }
    let buf = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ status: 'error', error: `No answer within ${TIMEOUT_MS / 1000}s${stderr ? ': ' + stderr.trim().split('\n').pop() : ''}` }), TIMEOUT_MS);
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ jsonrpc: '2.0', id, method, params });
    });
    child.on('error', (e) => finish({ status: 'error', error: e.message }));
    child.on('exit', (code) => finish({ status: 'error', error: `Exited with code ${code}${stderr ? ': ' + stderr.trim().split('\n').slice(-2).join(' ') : ''}` }));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? p.rej(new Error(msg.error.message || 'error')) : p.res(msg.result);
        } else if (msg.id != null && msg.method) {
          // Server asked us something (roots/list, ping...). Answer minimally.
          send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} });
        }
      }
    });
    (async () => {
      try {
        const init = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const tools = [];
        let cursor;
        do {
          const r = await request('tools/list', cursor ? { cursor } : {});
          tools.push(...(r?.tools || []));
          cursor = r?.nextCursor;
        } while (cursor);
        finish(summarise(tools, init));
      } catch (e) {
        finish({ status: 'error', error: e.message });
      }
    })();
  });
}

async function probeHttp(cfg) {
  const url = expandVars(cfg.url);
  const baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...expandVars(cfg.headers || {}) };
  let session = null;
  let id = 1;
  const call = async (method, params, notify = false) => {
    const headers = { ...baseHeaders, ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': PROTOCOL };
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: id++, method, params };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(t); }
    if (res.status === 401 || res.status === 403) {
      const err = new Error('Needs sign-in (OAuth), so it can only be measured from inside Claude Code');
      err.auth = true;
      throw err;
    }
    if (!res.ok && !(notify && res.status === 202)) throw new Error(`HTTP ${res.status}`);
    session = res.headers.get('mcp-session-id') || session;
    if (notify) return null;
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    let msg = null;
    if (type.includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const m = JSON.parse(line.slice(5).trim());
          if (m.id != null) { msg = m; break; }
        } catch {}
      }
    } else {
      msg = JSON.parse(text);
    }
    if (!msg) throw new Error('Empty response');
    if (msg.error) throw new Error(msg.error.message || 'error');
    return msg.result;
  };
  try {
    const init = await call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    await call('notifications/initialized', undefined, true).catch(() => {});
    const tools = [];
    let cursor;
    do {
      const r = await call('tools/list', cursor ? { cursor } : {});
      tools.push(...(r?.tools || []));
      cursor = r?.nextCursor;
    } while (cursor);
    return summarise(tools, init);
  } catch (e) {
    return { status: e.auth ? 'needs-auth' : 'error', error: e.name === 'AbortError' ? 'Timed out' : e.message };
  }
}

/** Probe one MCP server config and cache the result (keyed by config hash). */
export async function probeServer(name, cfg) {
  const started = Date.now();
  const transport = cfg.type || (cfg.url ? 'http' : 'stdio');
  let result;
  if (transport === 'stdio') result = await probeStdio(cfg, cfg.__pluginRoot);
  else if (transport === 'http' || transport === 'sse' || transport === 'streamable-http') result = await probeHttp(cfg);
  else result = { status: 'error', error: `Unsupported transport "${transport}"` };
  result.measuredAt = new Date().toISOString();
  result.ms = Date.now() - started;
  const hash = mcpConfigHash(cfg);
  updateState((s) => { s.probes[hash] = result; });
  log(`measured ${name}: ${result.status}${result.error ? ' - ' + result.error : ` (${result.tools.length} tools)`}`);
  return result;
}

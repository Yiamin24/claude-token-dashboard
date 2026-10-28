// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Finds MCP servers, skills and plugins configured for AI coding tools other than Claude Code,
// and switches them on/off where the tool's own config file supports it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, readJsonForEdit, writeJsonAtomic, isDir, isFile, listDir, estTokens, DATA_DIR } from './util.js';

export const AGENTS = {
  claude: { name: 'Claude Code', short: 'Claude' },
  codex: { name: 'Codex', short: 'Codex' },
  gemini: { name: 'Gemini CLI', short: 'Gemini' },
  antigravity: { name: 'Antigravity', short: 'Antigravity' },
  kiro: { name: 'Kiro', short: 'Kiro' },
  copilot: { name: 'Copilot CLI', short: 'Copilot' },
  vscode: { name: 'VS Code', short: 'VS Code' },
  opencode: { name: 'OpenCode', short: 'OpenCode' },
  cursor: { name: 'Cursor', short: 'Cursor' },
  windsurf: { name: 'Windsurf', short: 'Windsurf' },
  cline: { name: 'Cline', short: 'Cline' },
  roo: { name: 'Roo Code', short: 'Roo' },
  kilo: { name: 'Kilo Code', short: 'Kilo' },
  zed: { name: 'Zed', short: 'Zed' },
  devin: { name: 'Devin', short: 'Devin' },
  desktop: { name: 'Claude Desktop', short: 'Desktop' },
  shared: { name: 'Shared skills', short: 'Shared' },
};

// ---------- small parsers ----------

/** JSON with comments and trailing commas (VS Code, Zed, OpenCode .jsonc). */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const s = text.replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      i = i < 0 ? s.length : i + 2;
    } else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Reads a config file. `strict` tells us whether we may safely write it back as plain JSON. */
function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.trim()) return { data: {}, strict: true };
  try { return { data: JSON.parse(text.replace(/^﻿/, '')), strict: true }; } catch {}
  try { return { data: parseJsonc(text), strict: false }; } catch { return null; }
}

/** Minimal TOML reader: tables, dotted/quoted keys, strings, numbers, booleans, arrays, inline tables. */
export function parseToml(text) {
  const root = {};
  let cur = root;
  let i = 0;
  const s = text.replace(/\r\n/g, '\n');
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  const wsnl = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      break;
    }
  };
  const key = () => {
    ws();
    if (s[i] === '"' || s[i] === "'") return str();
    let k = '';
    while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) k += s[i++];
    return k;
  };
  const keyPath = () => {
    const parts = [key()];
    ws();
    while (s[i] === '.') { i++; parts.push(key()); ws(); }
    return parts;
  };
  const str = () => {
    const q = s[i];
    const multi = s.slice(i, i + 3) === q.repeat(3);
    if (multi) {
      i += 3;
      if (s[i] === '\n') i++;
      const end = s.indexOf(q.repeat(3), i);
      const raw = s.slice(i, end);
      i = end + 3;
      return q === '"' ? unescape(raw) : raw;
    }
    i++;
    let raw = '';
    while (i < s.length && s[i] !== q) {
      if (q === '"' && s[i] === '\\') { raw += s[i] + s[i + 1]; i += 2; } else raw += s[i++];
    }
    i++;
    return q === '"' ? unescape(raw) : raw;
  };
  const unescape = (r) => r.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[e] ?? e;
  });
  const value = () => {
    wsnl();
    const c = s[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        wsnl();
        if (s[i] === ']') { i++; break; }
        arr.push(value());
        wsnl();
        if (s[i] === ',') i++;
      }
      return arr;
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (s[i] === '}') { i++; break; }
        const kp = keyPath();
        ws(); i++; // '='
        setPath(obj, kp, value());
        ws();
        if (s[i] === ',') i++;
      }
      return obj;
    }
    let tok = '';
    while (i < s.length && !/[,\]}\n#]/.test(s[i])) tok += s[i++];
    tok = tok.trim();
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    const n = Number(tok.replace(/_/g, ''));
    return Number.isNaN(n) ? tok : n;
  };
  const setPath = (obj, parts, v) => {
    let o = obj;
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
    o[parts[parts.length - 1]] = v;
  };
  while (i < s.length) {
    wsnl();
    if (i >= s.length) break;
    if (s[i] === '[') {
      const arrTable = s[i + 1] === '[';
      i += arrTable ? 2 : 1;
      const parts = keyPath();
      i += arrTable ? 2 : 1;
      let o = root;
      for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
      const last = parts[parts.length - 1];
      if (arrTable) { (o[last] ??= []).push({}); cur = o[last][o[last].length - 1]; } else cur = (o[last] ??= {});
      continue;
    }
    const kp = keyPath();
    ws();
    if (s[i] !== '=') { while (i < s.length && s[i] !== '\n') i++; continue; }
    i++;
    setPath(cur, kp, value());
  }
  return root;
}

/** Set `enabled = <bool>` inside [mcp_servers.<name>] of a Codex config.toml, editing only that line. */
function codexSetEnabled(file, name, enabled) {
  const text = fs.readFileSync(file, 'utf8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const headerKeys = (line) => {
    const m = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (!m) return null;
    const out = [];
    const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/gy;
    let mm;
    while ((mm = re.exec(m[1])) && mm[0]) out.push(mm[1] ?? mm[2] ?? mm[3]);
    return out;
  };
  const start = lines.findIndex((l) => { const k = headerKeys(l); return k && k.length === 2 && k[0] === 'mcp_servers' && k[1] === name; });
  if (start < 0) throw new Error(`[mcp_servers.${name}] not found in ${file}`);
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) if (/^\s*\[/.test(lines[j])) { end = j; break; }
  const idx = lines.slice(start + 1, end).findIndex((l) => /^\s*enabled\s*=/.test(l));
  if (idx >= 0) lines[start + 1 + idx] = lines[start + 1 + idx].replace(/=\s*(true|false)/, `= ${enabled}`);
  else lines.splice(start + 1, 0, `enabled = ${enabled}`);
  backup(file);
  fs.writeFileSync(file, lines.join(nl));
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(dir, `${stamp}__${file.replace(/[:\\/]+/g, '_').replace(/^_+/, '')}`));
}

// ---------- locations ----------

function appData(name) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), name);
}
const xdg = (...p) => path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), ...p);
const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'Kiro', 'VSCodium', 'Trae', 'Antigravity'];

/** Normalise the many MCP config shapes into { type, command, args, url, env, headers }. */
function normalise(raw) {
  const c = raw || {};
  let command = c.command;
  let args = c.args || [];
  if (Array.isArray(command)) { args = command.slice(1); command = command[0]; }
  const url = c.url || c.serverUrl || c.httpUrl || c.uri;
  let type = c.type || c.transport;
  if (type === 'local') type = 'stdio';
  if (type === 'remote' || type === 'streamable-http' || type === 'streamableHttp' || c.httpUrl) type = 'http';
  if (!type) type = url ? 'http' : 'stdio';
  const out = { type };
  if (command) { out.command = String(command); out.args = (Array.isArray(args) ? args : []).map(String); }
  if (url) out.url = String(url);
  const env = c.env || c.environment;
  if (env && typeof env === 'object') out.env = env;
  if (c.headers && typeof c.headers === 'object') out.headers = c.headers;
  if (c.cwd) out.cwd = c.cwd;
  return out;
}

const slugScope = (scope, project) => (scope === 'project' ? `project:${project.toLowerCase()}` : 'user');

// ---------- the scan ----------

/**
 * @param {string} project
 * @param {{ readSkill: Function, findSkillFiles: Function }} h  skill helpers from scan.js
 */
export function scanOtherAgents(project, h) {
  const mcps = [];
  const skills = [];
  const plugins = [];
  const files = new Set(); // config files that exist (for watching)
  const seen = new Map(); // agent -> Set(paths found)
  const found = (agent, file) => { files.add(file); (seen.get(agent) || seen.set(agent, new Set()).get(agent)).add(file); };

  const addMcpMap = (agent, map, { file, scope, container, toggle, labelExtra = '', plugin = null, pluginOn = true, offNames = [] }) => {
    if (!map || typeof map !== 'object') return;
    for (const [name, raw] of Object.entries(map)) {
      if (!raw || typeof raw !== 'object') continue;
      let on = pluginOn;
      if (raw.disabled === true) on = false;
      if (raw.enabled === false) on = false;
      if (offNames.includes(name)) on = false;
      mcps.push({
        id: `mcp:${agent}:${slugScope(scope, project)}:${plugin ? plugin + ':' : ''}${name}`,
        agent, name, cfg: normalise(raw), scope, file, container, toggle: plugin ? null : toggle,
        sourceLabel: `${AGENTS[agent].name} · ${scope === 'project' ? 'project' : 'global'}${labelExtra}`,
        on, plugin, pluginOn, projectScoped: scope === 'project',
      });
    }
  };

  const addSkillDir = (agent, dir, scope, { prefix = '', label = '', plugin = null, pluginOn = true, depth = 2 } = {}) => {
    if (!isDir(dir)) return;
    found(agent, dir);
    for (const f of h.findSkillFiles(dir, depth)) {
      if (path.dirname(f) === dir && depth > 0) continue;
      const s = h.readSkill(f, {
        prefix, source: agent, idBase: `${agent}:${slugScope(scope, project)}${plugin ? ':' + plugin : ''}`,
        sourceLabel: `${AGENTS[agent].name} · ${label || (scope === 'project' ? 'project' : 'global')}`,
      });
      skills.push({ ...s, agent, pluginOn, agentPlugin: plugin, projectScoped: scope === 'project' });
    }
  };

  const jsonMcp = (agent, file, scope, container = 'mcpServers', toggle = null, extra = {}) => {
    const r = readConfig(file);
    if (!r) return;
    found(agent, file);
    const map = container.split('.').reduce((o, k) => o?.[k], r.data);
    addMcpMap(agent, map, { file, scope, container, toggle: toggle && r.strict ? toggle : null, ...extra });
    return r;
  };

  const P = (...p) => path.join(project, ...p);

  // Codex: ~/.codex/config.toml and <project>/.codex/config.toml
  for (const [file, scope] of [[path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'global'], [P('.codex', 'config.toml'), 'project']]) {
    if (!isFile(file)) continue;
    found('codex', file);
    let t = {};
    try { t = parseToml(fs.readFileSync(file, 'utf8')); } catch {}
    addMcpMap('codex', t.mcp_servers, { file, scope, container: 'mcp_servers', toggle: 'codex-toml' });
  }
  addSkillDir('codex', path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills'), 'global');
  addSkillDir('codex', path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills', '.system'), 'global', { label: 'built-in' });
  addSkillDir('codex', P('.codex', 'skills'), 'project');

  // Gemini CLI: settings.json (mcp.excluded switches servers off) + extensions
  for (const [file, scope] of [[path.join(HOME, '.gemini', 'settings.json'), 'global'], [P('.gemini', 'settings.json'), 'project']]) {
    const r = readConfig(file);
    if (!r) continue;
    found('gemini', file);
    const ex = r.data?.mcp?.excluded || [];
    const allowed = r.data?.mcp?.allowed;
    const names = Object.keys(r.data?.mcpServers || {});
    const off = [...ex, ...(Array.isArray(allowed) && allowed.length ? names.filter((n) => !allowed.includes(n)) : [])];
    addMcpMap('gemini', r.data?.mcpServers, { file, scope, container: 'mcpServers', toggle: r.strict ? 'gemini-excluded' : null, offNames: off });
  }
  for (const e of listDir(path.join(HOME, '.gemini', 'extensions'))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(HOME, '.gemini', 'extensions', e.name);
    const man = readConfig(path.join(dir, 'gemini-extension.json'));
    if (!man) continue;
    found('gemini', path.join(dir, 'gemini-extension.json'));
    addMcpMap('gemini', man.data.mcpServers, { file: path.join(dir, 'gemini-extension.json'), scope: 'global', container: 'mcpServers', labelExtra: ` · ext ${e.name}`, plugin: `ext:${e.name}` });
    addSkillDir('gemini', path.join(dir, 'skills'), 'global', { label: `ext ${e.name}` });
  }
  addSkillDir('gemini', path.join(HOME, '.gemini', 'skills'), 'global');
  addSkillDir('gemini', P('.gemini', 'skills'), 'project');

  // Antigravity: ~/.gemini/config (current) and ~/.gemini/antigravity (older builds)
  const agCfgDir = path.join(HOME, '.gemini', 'config');
  jsonMcp('antigravity', path.join(agCfgDir, 'mcp_config.json'), 'global');
  jsonMcp('antigravity', path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), 'global');
  addSkillDir('antigravity', path.join(agCfgDir, 'skills'), 'global');
  addSkillDir('antigravity', path.join(HOME, '.gemini', 'antigravity', 'builtin', 'skills'), 'global', { label: 'built-in' });
  addSkillDir('antigravity', P('.agent', 'skills'), 'project');
  const agConfigFile = path.join(agCfgDir, 'config.json');
  const agConfig = readConfig(agConfigFile);
  for (const e of listDir(path.join(agCfgDir, 'plugins'))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(agCfgDir, 'plugins', e.name);
    const man = readConfig(path.join(dir, 'plugin.json'))?.data || readConfig(path.join(dir, 'gemini-extension.json'))?.data || {};
    const on = agConfig?.data?.plugins?.[e.name]?.enabled !== false;
    const before = { s: skills.length, m: mcps.length };
    for (const mf of ['mcp_config.json', 'gemini-extension.json', '.mcp.json']) {
      const r = readConfig(path.join(dir, mf));
      if (r?.data?.mcpServers) addMcpMap('antigravity', r.data.mcpServers, { file: path.join(dir, mf), scope: 'global', container: 'mcpServers', labelExtra: ` · ${e.name}`, plugin: e.name, pluginOn: on });
    }
    addSkillDir('antigravity', path.join(dir, 'skills'), 'global', { label: e.name, plugin: e.name, pluginOn: on, depth: 2 });
    // A plugin may keep one SKILL.md directly in skills/
    if (isFile(path.join(dir, 'skills', 'SKILL.md'))) {
      const s = h.readSkill(path.join(dir, 'skills', 'SKILL.md'), { source: 'antigravity', idBase: `antigravity:user:${e.name}`, sourceLabel: `Antigravity · ${e.name}` });
      skills.push({ ...s, agent: 'antigravity', pluginOn: on, agentPlugin: e.name });
    }
    found('antigravity', dir);
    plugins.push({
      id: `plugin:antigravity:${e.name}`, kind: 'plugin', agent: 'antigravity', name: man.displayName || man.name || e.name,
      displayName: man.displayName || man.name || e.name, pluginKey: e.name, description: man.description || '',
      version: man.version || '', path: dir, sourceLabel: 'Antigravity · plugin', state: on ? 'on' : 'off', stateSource: 'default',
      toggle: agConfig?.strict ? 'antigravity-plugin' : null, file: agConfigFile,
      counts: { skills: skills.length - before.s, agents: 0, mcps: mcps.length - before.m },
    });
  }
  // Antigravity keeps each connected server's tool list on disk: use it to measure without starting the server.
  const cached = new Map();
  for (const e of listDir(path.join(HOME, '.gemini', 'antigravity', 'mcp'))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(HOME, '.gemini', 'antigravity', 'mcp', e.name);
    const tools = [];
    for (const f of listDir(dir)) {
      if (!f.name.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8'));
        tools.push({ name: t.name || f.name.replace(/\.json$/, ''), tokens: estTokens(JSON.stringify({ name: t.name, description: t.description || '', input_schema: t.parameters || t.inputSchema || {} })) });
      } catch {}
    }
    let instr = '';
    try { instr = fs.readFileSync(path.join(dir, 'instructions.md'), 'utf8'); } catch {}
    if (tools.length) {
      cached.set(e.name, {
        status: 'ok', source: 'Antigravity cache', tools,
        schemaTokens: tools.reduce((n, t) => n + t.tokens, 0), instructionsTokens: instr ? estTokens(instr) + 10 : 0,
        measuredAt: (() => { try { return fs.statSync(dir).mtime.toISOString(); } catch { return null; } })(),
      });
    }
  }

  // Kiro: ~/.kiro/settings/mcp.json and <project>/.kiro/settings/mcp.json ("disabled": true)
  jsonMcp('kiro', path.join(HOME, '.kiro', 'settings', 'mcp.json'), 'global', 'mcpServers', 'json-disabled');
  jsonMcp('kiro', P('.kiro', 'settings', 'mcp.json'), 'project', 'mcpServers', 'json-disabled');
  addSkillDir('kiro', path.join(HOME, '.kiro', 'skills'), 'global');
  addSkillDir('kiro', P('.kiro', 'skills'), 'project');

  // GitHub Copilot CLI
  jsonMcp('copilot', path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'mcp-config.json'), 'global');
  addSkillDir('copilot', path.join(HOME, '.copilot', 'skills'), 'global');
  addSkillDir('copilot', P('.github', 'skills'), 'project');

  // VS Code (Copilot agent mode): user mcp.json + <project>/.vscode/mcp.json
  for (const ed of ['Code', 'Code - Insiders']) jsonMcp('vscode', path.join(appData(ed), 'User', 'mcp.json'), 'global', 'servers', null, ed === 'Code' ? {} : { labelExtra: ' · Insiders' });
  jsonMcp('vscode', P('.vscode', 'mcp.json'), 'project', 'servers');

  // OpenCode: "mcp" map with "enabled"
  for (const [file, scope] of [[xdg('opencode', 'opencode.json'), 'global'], [xdg('opencode', 'opencode.jsonc'), 'global'], [P('opencode.json'), 'project'], [P('opencode.jsonc'), 'project']]) {
    jsonMcp('opencode', file, scope, 'mcp', 'json-enabled');
  }
  for (const d of ['skill', 'skills']) { addSkillDir('opencode', xdg('opencode', d), 'global'); addSkillDir('opencode', P('.opencode', d), 'project'); }

  // Cursor
  jsonMcp('cursor', path.join(HOME, '.cursor', 'mcp.json'), 'global');
  jsonMcp('cursor', P('.cursor', 'mcp.json'), 'project');
  addSkillDir('cursor', path.join(HOME, '.cursor', 'skills'), 'global');
  addSkillDir('cursor', P('.cursor', 'skills'), 'project');

  // Windsurf ("disabled": true)
  jsonMcp('windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'global', 'mcpServers', 'json-disabled');
  addSkillDir('windsurf', path.join(HOME, '.codeium', 'windsurf', 'skills'), 'global');
  addSkillDir('windsurf', P('.windsurf', 'skills'), 'project');

  // Devin
  addSkillDir('devin', path.join(HOME, '.devin', 'skills'), 'global');
  addSkillDir('devin', P('.devin', 'skills'), 'project');

  // Cline / Roo / Kilo live inside each VS Code-style editor's globalStorage ("disabled": true)
  for (const ed of EDITORS) {
    const gs = path.join(appData(ed), 'User', 'globalStorage');
    const extra = ed === 'Code' ? {} : { labelExtra: ` · in ${ed}` };
    jsonMcp('cline', path.join(gs, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'global', 'mcpServers', 'json-disabled', extra);
    jsonMcp('roo', path.join(gs, 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), 'global', 'mcpServers', 'json-disabled', extra);
    jsonMcp('kilo', path.join(gs, 'kilocode.kilo-code', 'settings', 'mcp_settings.json'), 'global', 'mcpServers', 'json-disabled', extra);
  }
  jsonMcp('roo', P('.roo', 'mcp.json'), 'project', 'mcpServers', 'json-disabled');
  addSkillDir('cline', path.join(HOME, '.cline', 'skills'), 'global');

  // Zed ("context_servers")
  jsonMcp('zed', process.platform === 'win32' ? path.join(appData('Zed'), 'settings.json') : xdg('zed', 'settings.json'), 'global', 'context_servers');
  jsonMcp('zed', P('.zed', 'settings.json'), 'project', 'context_servers');

  // Claude Desktop
  jsonMcp('desktop', path.join(appData('Claude'), 'claude_desktop_config.json'), 'global');

  // Shared skills folder used by several tools (installed by `npx skills` and friends)
  addSkillDir('shared', path.join(HOME, '.agents', 'skills'), 'global', { label: '~/.agents' });
  addSkillDir('shared', P('.agents', 'skills'), 'project', { label: '.agents' });

  for (const s of skills) {
    s.state = s.pluginOn === false ? 'off' : 'on';
    s.stateSource = s.pluginOn === false ? 'plugin' : 'default';
    s.toggleable = false;
    s.toggleNote = `${AGENTS[s.agent].name} has no setting to hide a single skill. Remove its folder to stop it loading.`;
    s.plugin = null;
  }

  const agents = Object.entries(AGENTS).filter(([id]) => id !== 'claude').map(([id, a]) => ({
    id, name: a.name, short: a.short, detected: seen.has(id), files: [...(seen.get(id) || [])],
  }));
  return { agents, mcps, skills, plugins, cachedProbes: cached, files: [...files] };
}

// ---------- projects ----------

// Project-level config each tool reads: [tool, relative file, container key].
const PROJECT_MCP_FILES = [
  ['claude', '.mcp.json', 'mcpServers'], ['codex', '.codex/config.toml', 'mcp_servers'], ['gemini', '.gemini/settings.json', 'mcpServers'],
  ['kiro', '.kiro/settings/mcp.json', 'mcpServers'], ['vscode', '.vscode/mcp.json', 'servers'], ['opencode', 'opencode.json', 'mcp'],
  ['opencode', 'opencode.jsonc', 'mcp'], ['cursor', '.cursor/mcp.json', 'mcpServers'], ['roo', '.roo/mcp.json', 'mcpServers'],
  ['zed', '.zed/settings.json', 'context_servers'],
];
const PROJECT_SKILL_DIRS = [
  ['claude', '.claude/skills'], ['claude', '.claude/commands'], ['shared', '.agents/skills'], ['codex', '.codex/skills'], ['gemini', '.gemini/skills'],
  ['antigravity', '.agent/skills'], ['kiro', '.kiro/skills'], ['copilot', '.github/skills'], ['opencode', '.opencode/skill'],
  ['opencode', '.opencode/skills'], ['cursor', '.cursor/skills'], ['windsurf', '.windsurf/skills'], ['devin', '.devin/skills'],
];
const MARKERS = new Set(['.mcp.json', '.claude', '.agents', '.codex', '.gemini', '.agent', '.kiro', '.vscode', '.cursor', '.roo', '.zed', '.windsurf', '.devin', '.opencode', 'opencode.json', 'opencode.jsonc', '.github']);

const fileUriToPath = (u) => {
  try {
    if (!String(u).startsWith('file://')) return null;
    let p = decodeURIComponent(new URL(u).pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return path.normalize(p);
  } catch { return null; }
};

/** Projects other tools have opened, plus folders under Desktop/Documents that carry their own AI-tool setup. */
export function discoverProjects() {
  const out = new Set();
  const add = (p) => { if (p && isDir(p)) out.add(path.resolve(p)); };
  // Codex: [projects.'<path>'] in config.toml
  try { for (const p of Object.keys(parseToml(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'utf8')).projects || {})) add(p); } catch {}
  // Antigravity: ~/.gemini/config/projects/*.json
  for (const e of listDir(path.join(HOME, '.gemini', 'config', 'projects'))) {
    const d = readConfig(path.join(HOME, '.gemini', 'config', 'projects', e.name))?.data;
    for (const r of d?.projectResources?.resources || []) add(fileUriToPath(r.folderUri));
  }
  // VS Code-style editors (VS Code, Kiro, Cursor, Windsurf...): workspaceStorage/*/workspace.json
  for (const ed of EDITORS) {
    const ws = path.join(appData(ed), 'User', 'workspaceStorage');
    for (const e of listDir(ws)) {
      const d = readConfig(path.join(ws, e.name, 'workspace.json'))?.data;
      if (d?.folder) add(fileUriToPath(d.folder));
    }
  }
  // Folders with their own AI-tool setup, up to two levels under common roots.
  const roots = [path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'projects'), path.join(HOME, 'code'), path.join(HOME, 'dev'), path.join(HOME, 'src')];
  const walk = (dir, depth) => {
    const entries = listDir(dir);
    if (depth < 2 && entries.some((e) => MARKERS.has(e.name)) && projectFootprint(dir).total) add(dir);
    if (depth <= 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'out', 'vendor'].includes(e.name)) walk(path.join(dir, e.name), depth - 1);
    }
  };
  for (const r of roots) for (const e of listDir(r)) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(r, e.name), 1);
  return [...out];
}

/** Quick count of a project's own MCP servers and skills, by tool (no global config). */
export function projectFootprint(dir) {
  const tools = new Set();
  let mcps = 0;
  let skills = 0;
  for (const [agent, rel, container] of PROJECT_MCP_FILES) {
    const f = path.join(dir, rel);
    if (!isFile(f)) continue;
    let map;
    if (rel.endsWith('.toml')) { try { map = parseToml(fs.readFileSync(f, 'utf8'))[container]; } catch {} }
    else map = readConfig(f)?.data?.[container];
    const n = map && typeof map === 'object' ? Object.keys(map).length : 0;
    if (n) { mcps += n; tools.add(agent); }
  }
  for (const [agent, rel] of PROJECT_SKILL_DIRS) {
    const d = path.join(dir, rel);
    if (!isDir(d)) continue;
    const n = listDir(d).filter((e) => (e.isDirectory() && isFile(path.join(d, e.name, 'SKILL.md'))) || (rel.endsWith('commands') && e.name.endsWith('.md'))).length;
    if (n) { skills += n; tools.add(agent); }
  }
  return { mcps, skills, total: mcps + skills, tools: [...tools] };
}

// ---------- switching ----------

const TOGGLE_NOTES = {
  vscode: 'VS Code keeps MCP on/off state inside the editor (Extensions → MCP Servers).',
  cursor: 'Cursor keeps MCP on/off state inside the app (Settings → MCP).',
  copilot: 'Copilot CLI has no on/off flag in its config. Use /mcp inside Copilot CLI.',
  zed: 'Zed: switch it in Zed\'s Agent settings.',
  desktop: 'Claude Desktop: switch it in Settings → Developer.',
  antigravity: 'Antigravity: switch it in the app\'s MCP settings, or switch its plugin.',
};
export const toggleNote = (agent) => TOGGLE_NOTES[agent] || `${AGENTS[agent]?.name || agent} has no on/off setting in its config file.`;

/** Apply on/off for a non-Claude item (MCP entry or Antigravity plugin). */
export function setAgentState(item, on) {
  if (item.kind === 'plugin') {
    if (item.toggle !== 'antigravity-plugin') throw new Error(`Can't switch ${item.displayName} from here.`);
    editJson(item.file, (d) => { d.plugins = d.plugins || {}; d.plugins[item.pluginKey] = { ...(d.plugins[item.pluginKey] || {}), enabled: on }; });
    return;
  }
  const t = item.toggle;
  if (!t) throw new Error(toggleNote(item.agent));
  if (t === 'codex-toml') return codexSetEnabled(item.file, item.name, on);
  editJson(item.file, (d) => {
    if (t === 'gemini-excluded') {
      d.mcp = d.mcp || {};
      const ex = new Set(Array.isArray(d.mcp.excluded) ? d.mcp.excluded : []);
      on ? ex.delete(item.name) : ex.add(item.name);
      d.mcp.excluded = [...ex];
      if (!d.mcp.excluded.length) delete d.mcp.excluded;
      if (!Object.keys(d.mcp).length) delete d.mcp;
      return;
    }
    const map = item.container.split('.').reduce((o, k) => o?.[k], d);
    const entry = map?.[item.name];
    if (!entry) throw new Error(`${item.name} not found in ${item.file}`);
    if (t === 'json-disabled') entry.disabled = !on;
    if (t === 'json-enabled') entry.enabled = on;
  });
}

function editJson(file, fn) {
  const d = readJsonForEdit(file);
  fn(d);
  backup(file);
  writeJsonAtomic(file, d);
}

export const _test = { normalise, codexSetEnabled, osTmp: os.tmpdir };

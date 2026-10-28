// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Finds every MCP server, skill, command, agent and plugin Claude Code would load for a project,
// works out whether each is on or off, and estimates what it costs in context tokens per request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CLAUDE_DIR, CLAUDE_JSON, USER_SETTINGS, readJson, estTokens, normProject, projKey,
  isDir, isFile, listDir, parseFrontmatter,
} from './util.js';
import { loadState, updateState } from './state.js';

const SKILL_DESC_CAP = 1536; // Claude Code's default skillListingMaxDescChars
const DEFERRED_THRESHOLD = 20000; // ~10% of a 200k window: above this Claude Code defers MCP tool schemas

export const settingsPaths = (project) => ({
  user: USER_SETTINGS,
  project: path.join(project, '.claude', 'settings.json'),
  local: path.join(project, '.claude', 'settings.local.json'),
});

function settingsLayers(project) {
  const p = settingsPaths(project);
  return {
    user: readJson(p.user, {}) || {},
    project: readJson(p.project, {}) || {},
    local: readJson(p.local, {}) || {},
  };
}

/** ~/.claude.json can hold the same project under several path spellings; merge them. */
function projectEntry(claudeJson, project) {
  const key = projKey(project);
  const merged = { mcpServers: {}, disabledMcpServers: [], disabledMcpjsonServers: [], enabledMcpjsonServers: [] };
  for (const [k, v] of Object.entries(claudeJson?.projects || {})) {
    if (projKey(k) !== key || !v) continue;
    Object.assign(merged.mcpServers, v.mcpServers || {});
    for (const f of ['disabledMcpServers', 'disabledMcpjsonServers', 'enabledMcpjsonServers']) {
      if (Array.isArray(v[f])) merged[f].push(...v[f]);
    }
  }
  return merged;
}

export function knownProjects(launchProject) {
  const cj = readJson(CLAUDE_JSON, {}) || {};
  const map = new Map();
  const add = (p, extra = {}) => {
    if (!p) return;
    const k = projKey(p);
    if (!map.has(k)) map.set(k, { path: normProject(p), exists: isDir(p), ...extra });
  };
  if (launchProject) add(launchProject, { launch: true });
  for (const k of Object.keys(cj.projects || {})) add(k);
  return [...map.values()].sort((a, b) => (b.launch ? 1 : 0) - (a.launch ? 1 : 0) || a.path.localeCompare(b.path));
}

// ---------- skills / commands / agents ----------

function findSkillFiles(dir, depth = 3, out = []) {
  const f = path.join(dir, 'SKILL.md');
  if (isFile(f)) { out.push(f); return out; }
  if (depth <= 0) return out;
  for (const e of listDir(dir)) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') findSkillFiles(path.join(dir, e.name), depth - 1, out);
  }
  return out;
}

function findMarkdown(dir, base = dir, out = []) {
  for (const e of listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('.')) findMarkdown(p, base, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ file: p, rel: path.relative(base, p) });
  }
  return out;
}

function readHead(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
}

function firstBodyLine(text) {
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return (line || '').slice(0, 200);
}

function skillCost(displayName, description, modelVisible) {
  if (!modelVisible) return { tokens: 0, tokensNameOnly: 0 };
  const desc = String(description || '').replace(/\s+/g, ' ').slice(0, SKILL_DESC_CAP);
  return {
    tokens: estTokens(`- ${displayName}: ${desc}\n`),
    tokensNameOnly: estTokens(`- ${displayName}\n`),
  };
}

function readSkill(file, { prefix = '', source, sourceLabel, plugin = null, idBase }) {
  const text = readHead(file);
  const fm = parseFrontmatter(text);
  const name = fm.name || path.basename(path.dirname(file));
  const displayName = prefix ? `${prefix}:${name}` : name;
  const modelVisible = String(fm['disable-model-invocation']).toLowerCase() !== 'true';
  return {
    id: `skill:${idBase}:${displayName}`,
    kind: 'skill',
    subtype: 'skill',
    name,
    displayName,
    description: fm.description || firstBodyLine(text),
    path: file,
    source,
    sourceLabel,
    plugin,
    modelVisible,
    ...skillCost(displayName, fm.description || firstBodyLine(text), modelVisible),
  };
}

function readCommands(dir, { prefix = '', source, sourceLabel, plugin = null, idBase }) {
  return findMarkdown(dir).map(({ file, rel }) => {
    const text = readHead(file, 16384);
    const fm = parseFrontmatter(text);
    const name = rel.replace(/\.md$/i, '').split(path.sep).join(':');
    const displayName = prefix ? `${prefix}:${name}` : name;
    const description = fm.description || firstBodyLine(text);
    const modelVisible = String(fm['disable-model-invocation']).toLowerCase() !== 'true';
    return {
      id: `skill:${idBase}:cmd:${displayName}`,
      kind: 'skill', subtype: 'command', name, displayName, description, path: file,
      source, sourceLabel, plugin, modelVisible,
      ...skillCost(displayName, description, modelVisible),
    };
  });
}

function readAgents(dir, { prefix, plugin, idBase, source, sourceLabel }) {
  return findMarkdown(dir).map(({ file, rel }) => {
    const fm = parseFrontmatter(readHead(file, 16384));
    const name = fm.name || path.basename(rel, '.md');
    const displayName = prefix ? `${prefix}:${name}` : name;
    const tools = fm.tools ? ` (Tools: ${fm.tools})` : '';
    return {
      id: `agent:${idBase}:${displayName}`,
      kind: 'agent', name, displayName, description: fm.description || '', path: file,
      source, sourceLabel, plugin, modelVisible: true,
      tokens: estTokens(`- ${displayName}: ${fm.description || ''}${tools}\n`),
      tokensNameOnly: 0,
    };
  });
}

/** claude.ai-synced skills live in skills/synced/<account bucket>/<skill>; only the newest bucket is active. */
function activeSyncedBucket() {
  const root = path.join(CLAUDE_DIR, 'skills', 'synced');
  let best = null;
  for (const e of listDir(root)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const marker = path.join(root, e.name, '.last-complete-round');
    let t = 0;
    try { t = fs.statSync(marker).mtimeMs; } catch { try { t = fs.statSync(path.join(root, e.name)).mtimeMs; } catch {} }
    if (!best || t > best.t) best = { dir: path.join(root, e.name), t };
  }
  return best?.dir || null;
}

function userSkills() {
  const root = path.join(CLAUDE_DIR, 'skills');
  const out = [];
  for (const e of listDir(root)) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'synced') continue;
    for (const f of findSkillFiles(path.join(root, e.name), 2)) {
      out.push(readSkill(f, { source: 'user', sourceLabel: 'User', idBase: 'user' }));
    }
  }
  const bucket = activeSyncedBucket();
  if (bucket) {
    for (const f of findSkillFiles(bucket, 1)) {
      out.push(readSkill(f, { prefix: 'anthropic-skills', source: 'claude.ai', sourceLabel: 'claude.ai sync', idBase: 'claudeai' }));
    }
  }
  const cmdDir = path.join(CLAUDE_DIR, 'commands');
  if (isDir(cmdDir)) out.push(...readCommands(cmdDir, { source: 'user', sourceLabel: 'User', idBase: 'user' }));
  return out;
}

function projectSkills(project) {
  const pk = projKey(project);
  const out = [];
  const sdir = path.join(project, '.claude', 'skills');
  for (const f of findSkillFiles(sdir, 2)) {
    if (path.dirname(f) === sdir) continue;
    out.push({ ...readSkill(f, { source: 'project', sourceLabel: 'Project', idBase: `project:${pk}` }), projectScoped: true });
  }
  const cdir = path.join(project, '.claude', 'commands');
  if (isDir(cdir)) {
    out.push(...readCommands(cdir, { source: 'project', sourceLabel: 'Project', idBase: `project:${pk}` }).map((s) => ({ ...s, projectScoped: true })));
  }
  return out;
}

// ---------- plugins ----------

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function loadPlugins(project) {
  const reg = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), {}) || {};
  const out = [];
  for (const [id, list] of Object.entries(reg.plugins || {})) {
    const arr = asArray(list);
    const entry = arr.find((x) => x?.projectPath && projKey(x.projectPath) === projKey(project))
      || arr.find((x) => x && !x.projectPath);
    if (!entry?.installPath || !isDir(entry.installPath)) continue;
    const root = entry.installPath;
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {}) || {};
    const pname = manifest.name || id.split('@')[0];
    const base = { prefix: pname, plugin: id, idBase: `plugin:${id}`, source: 'plugin', sourceLabel: `Plugin · ${pname}` };

    const skillDirs = new Set([path.join(root, 'skills'), ...asArray(manifest.skills).map((p) => path.resolve(root, p))]);
    const skills = [];
    const seen = new Set();
    for (const d of skillDirs) {
      for (const f of findSkillFiles(d, 3)) {
        if (seen.has(f)) continue;
        seen.add(f);
        skills.push(readSkill(f, base));
      }
    }
    const cmdDirs = new Set([path.join(root, 'commands'), ...asArray(manifest.commands).map((p) => path.resolve(root, p))]);
    for (const d of cmdDirs) if (isDir(d)) skills.push(...readCommands(d, base));
    const agentDirs = new Set([path.join(root, 'agents'), ...asArray(manifest.agents).map((p) => path.resolve(root, p))]);
    const agents = [];
    for (const d of agentDirs) if (isDir(d)) agents.push(...readAgents(d, base));

    let mcpServers = {};
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object') mcpServers = manifest.mcpServers;
    else if (typeof manifest.mcpServers === 'string') mcpServers = readJson(path.resolve(root, manifest.mcpServers), {})?.mcpServers || {};
    else mcpServers = readJson(path.join(root, '.mcp.json'), {})?.mcpServers || {};

    const hooks = readJson(path.join(root, 'hooks', 'hooks.json'), {})?.hooks || manifest.hooks || {};
    out.push({
      id, name: pname, root, version: entry.version || manifest.version || '', scope: entry.scope || 'user',
      description: manifest.description || '', skills, agents, mcpServers,
      hasSessionStartHook: Boolean(hooks && typeof hooks === 'object' && hooks.SessionStart),
    });
  }
  return out;
}

// ---------- MCP ----------

export function mcpConfigHash(cfg) {
  const { type, command, args, url } = cfg || {};
  return crypto.createHash('sha1').update(JSON.stringify({ type, command, args, url })).digest('hex').slice(0, 16);
}

function wildcard(pattern) {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

function denyMatches(entry, name, cfg) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.serverName && entry.serverName === name) return true;
  if (Array.isArray(entry.serverCommand) && cfg.command) {
    const cmd = [cfg.command, ...(cfg.args || [])];
    if (cmd.length === entry.serverCommand.length && cmd.every((c, i) => c === entry.serverCommand[i])) return true;
  }
  if (entry.serverUrl && cfg.url && wildcard(entry.serverUrl).test(cfg.url)) return true;
  return false;
}

// ---------- assembly ----------

function overrideState(layers, key) {
  for (const layer of ['local', 'project', 'user']) {
    const v = layers[layer]?.skillOverrides?.[key];
    if (v) return { state: v, stateSource: layer };
  }
  return { state: 'on', stateSource: 'default' };
}

function pluginEnabled(layers, id) {
  for (const layer of ['local', 'project', 'user']) {
    const map = layers[layer]?.enabledPlugins;
    if (map && Object.prototype.hasOwnProperty.call(map, id)) {
      const v = map[id];
      return { on: v !== false && v != null, stateSource: layer };
    }
  }
  return { on: true, stateSource: 'default' };
}

function loadedTokens(item) {
  if (item.state === 'on') return item.tokens || 0;
  if (item.state === 'name-only') return item.tokensNameOnly || 0;
  return 0;
}

let cache = { key: null, at: 0, value: null };
const rawMcp = new Map(); // item id -> { name, cfg } (raw config, used for probing)

/** Raw MCP config for an inventory item id (scans the project if needed). */
export function getMcpConfig(project, id) {
  if (!rawMcp.has(id)) inventory(project, { fresh: true, track: false });
  return rawMcp.get(id) || null;
}

export function inventory(projectIn, { fresh = false, track = true } = {}) {
  const project = normProject(projectIn);
  const ck = projKey(project);
  if (!fresh && cache.key === ck && Date.now() - cache.at < 2500) return cache.value;

  const state = loadState();
  const cj = readJson(CLAUDE_JSON, {}) || {};
  const layers = settingsLayers(project);
  const pe = projectEntry(cj, project);
  const pk = projKey(project);

  // Plugins first: their state flows down to their skills, agents and MCP servers.
  const plugins = loadPlugins(project);
  const pluginItems = [];
  const skills = [...userSkills(), ...projectSkills(project)];
  const agents = [];
  const mcpRaw = [];

  for (const [name, cfg] of Object.entries(cj.mcpServers || {})) mcpRaw.push({ name, cfg, source: 'user', sourceLabel: 'User', id: `mcp:user:${name}` });
  for (const [name, cfg] of Object.entries(pe.mcpServers || {})) mcpRaw.push({ name, cfg, source: 'local', sourceLabel: 'Local (this project)', id: `mcp:local:${pk}:${name}`, projectScoped: true });
  const mcpJsonPath = path.join(project, '.mcp.json');
  for (const [name, cfg] of Object.entries(readJson(mcpJsonPath, {})?.mcpServers || {})) {
    mcpRaw.push({ name, cfg, source: 'project', sourceLabel: 'Project .mcp.json', id: `mcp:project:${pk}:${name}`, projectScoped: true });
  }

  for (const p of plugins) {
    const en = pluginEnabled(layers, p.id);
    p.enabled = en.on;
    for (const s of p.skills) skills.push({ ...s, pluginOn: en.on });
    for (const a of p.agents) agents.push({ ...a, pluginOn: en.on });
    for (const [sname, cfg] of Object.entries(p.mcpServers || {})) {
      mcpRaw.push({
        name: `plugin:${p.name}:${sname}`, cfg: { ...cfg, __pluginRoot: p.root }, source: 'plugin',
        sourceLabel: `Plugin · ${p.name}`, plugin: p.id, pluginOn: en.on, id: `mcp:plugin:${p.id}:${sname}`,
      });
    }
    pluginItems.push({
      id: `plugin:${p.id}`, kind: 'plugin', name: p.name, displayName: p.id, pluginId: p.id,
      description: p.description, path: p.root, version: p.version, source: 'plugin', sourceLabel: `Plugin (${p.scope})`,
      state: en.on ? 'on' : 'off', stateSource: en.stateSource, hasSessionStartHook: p.hasSessionStartHook,
      counts: { skills: p.skills.length, agents: p.agents.length, mcps: Object.keys(p.mcpServers || {}).length },
    });
  }

  // Skills & commands
  for (const s of skills) {
    if (s.plugin && !s.pluginOn) { s.state = 'off'; s.stateSource = 'plugin'; }
    else Object.assign(s, overrideState(layers, s.displayName));
    s.toggleable = !s.plugin || s.pluginOn;
    s.loaded = loadedTokens(s);
  }
  for (const a of agents) {
    a.state = a.pluginOn ? 'on' : 'off';
    a.stateSource = a.pluginOn ? 'default' : 'plugin';
    a.toggleable = false;
    a.toggleNote = 'Agents switch with their plugin';
    a.loaded = loadedTokens(a);
  }

  // MCP servers
  const probes = state.probes || {};
  const mcps = mcpRaw.map((m) => {
    const cfg = m.cfg || {};
    rawMcp.set(m.id, { name: m.name, cfg });
    const probe = probes[mcpConfigHash(cfg)] || null;
    let st = { state: 'on', stateSource: 'default' };
    if (m.plugin && !m.pluginOn) st = { state: 'off', stateSource: 'plugin' };
    else {
      for (const layer of ['local', 'project', 'user']) {
        if (asArray(layers[layer]?.deniedMcpServers).some((e) => denyMatches(e, m.name, cfg))) { st = { state: 'off', stateSource: layer }; break; }
      }
      if (st.state === 'on' && pe.disabledMcpServers.includes(m.name)) st = { state: 'off', stateSource: 'claude-code' };
      if (st.state === 'on' && m.source === 'project') {
        const off = [...pe.disabledMcpjsonServers, ...asArray(layers.local.disabledMcpjsonServers), ...asArray(layers.project.disabledMcpjsonServers)];
        if (off.includes(m.name)) st = { state: 'off', stateSource: 'mcpjson' };
      }
    }
    const toolNames = probe?.tools?.map((t) => t.name) || [];
    const namesTokens = toolNames.reduce((n, t) => n + estTokens(`mcp__${m.name}__${t}`) + 1, 0);
    const instr = probe?.instructionsTokens || 0;
    return {
      id: m.id, kind: 'mcp', name: m.name, displayName: m.name, source: m.source, sourceLabel: m.sourceLabel,
      plugin: m.plugin || null, projectScoped: Boolean(m.projectScoped),
      transport: cfg.type || (cfg.url ? 'http' : 'stdio'),
      target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
      description: probe?.serverName ? `${probe.serverName}${probe.serverVersion ? ' ' + probe.serverVersion : ''}` : '',
      configHash: mcpConfigHash(cfg),
      probe: probe ? { status: probe.status, error: probe.error, toolCount: toolNames.length, measuredAt: probe.measuredAt } : null,
      fullTokens: probe?.status === 'ok' ? probe.schemaTokens + instr : null,
      deferredTokens: probe?.status === 'ok' ? namesTokens + instr : null,
      toolsTop: (probe?.tools || []).slice().sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      ...st,
      toggleable: !m.plugin,
      toggleNote: m.plugin ? 'Comes from a plugin: switch the plugin instead' : st.stateSource === 'claude-code' ? 'Disabled in Claude Code /mcp' : undefined,
    };
  });

  const enabledFull = mcps.filter((m) => m.state === 'on').reduce((n, m) => n + (m.fullTokens || 0), 0);
  const pref = state.prefs.mcpMode;
  const mcpMode = pref === 'auto' ? (enabledFull > DEFERRED_THRESHOLD ? 'deferred' : 'full') : pref;
  for (const m of mcps) {
    m.tokens = m.fullTokens == null ? 0 : mcpMode === 'full' ? m.fullTokens : m.deferredTokens;
    m.measured = m.fullTokens != null;
    m.tokensNameOnly = 0;
    m.loaded = loadedTokens(m);
  }

  // Plugin totals come from their children.
  for (const p of pluginItems) {
    const kids = [...skills, ...agents, ...mcps].filter((x) => x.plugin === p.pluginId);
    p.tokens = kids.reduce((n, k) => n + (k.tokens || 0), 0);
    p.loaded = kids.reduce((n, k) => n + (k.loaded || 0), 0);
    p.unmeasured = kids.filter((k) => k.kind === 'mcp' && !k.measured).length;
    p.toggleable = true;
  }

  const countables = [...skills, ...agents, ...mcps];
  const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
  const byKind = {};
  for (const k of ['mcp', 'skill', 'agent']) {
    const arr = countables.filter((x) => x.kind === k);
    byKind[k] = { count: arr.length, active: sum(arr, (x) => x.loaded), saved: sum(arr, (x) => (x.tokens || 0) - x.loaded) };
  }
  const totals = {
    activeTokens: sum(countables, (x) => x.loaded),
    savedTokens: sum(countables, (x) => (x.tokens || 0) - x.loaded),
    // Never tried yet (servers that need sign-in are reported separately).
    unmeasuredMcps: mcps.filter((m) => !m.measured && !m.probe).length,
    unmeasurableMcps: mcps.filter((m) => !m.measured && m.probe).length,
    byKind,
  };

  const all = [...mcps, ...skills, ...agents, ...pluginItems];
  if (track) trackNew(all, project);
  const fresh_state = loadState();
  for (const it of all) {
    it.isNew = Boolean(fresh_state.newItems[it.id]);
    it.firstSeen = fresh_state.known[it.id] || null;
  }

  const value = {
    project, generatedAt: new Date().toISOString(), mcpMode, mcpModePref: pref, totals,
    mcps, skills, agents, plugins: pluginItems,
    newItems: Object.entries(fresh_state.newItems).map(([id, v]) => ({ id, ...v })),
    savingsItems: countables.filter((x) => (x.tokens || 0) - x.loaded > 0).map((x) => ({ id: x.id, saved: (x.tokens || 0) - x.loaded })),
  };
  cache = { key: ck, at: Date.now(), value };
  return value;
}

export function invalidateInventory() { cache = { key: null, at: 0, value: null }; }

/** Records ids never seen before. The very first scan (and a project's first scan) is a silent baseline. */
function trackNew(items, project) {
  const s0 = loadState();
  const pk = projKey(project);
  const unseen = items.filter((it) => !s0.known[it.id]);
  if (!unseen.length && s0.initialized && s0.seenProjects[pk]) return [];
  return updateState((s) => {
    const now = new Date().toISOString();
    const firstEver = !s.initialized;
    const firstForProject = !s.seenProjects[pk];
    const added = [];
    for (const it of items) {
      if (s.known[it.id]) continue;
      s.known[it.id] = now;
      if (firstEver || (firstForProject && it.projectScoped)) continue;
      s.newItems[it.id] = { name: it.displayName, kind: it.kind, source: it.sourceLabel, firstSeen: now };
      added.push(it.id);
    }
    s.initialized = true;
    s.seenProjects[pk] = s.seenProjects[pk] || now;
    return added;
  });
}

export function ackNew(ids) {
  updateState((s) => {
    if (!ids || ids === 'all') s.newItems = {};
    else for (const id of ids) delete s.newItems[id];
  });
  invalidateInventory();
}

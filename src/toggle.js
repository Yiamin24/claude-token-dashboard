// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Writes on/off choices into Claude Code's own settings files.
//   scope "project" -> <project>/.claude/settings.local.json (personal, not committed)
//   scope "global"  -> ~/.claude/settings.json
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonForEdit, writeJsonAtomic, normProject } from './util.js';
import { inventory, invalidateInventory, settingsPaths } from './scan.js';

const SKILL_STATES = new Set(['on', 'off', 'name-only', 'user-invocable-only']);

function backup(file) {
  if (!fs.existsSync(file)) return;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = file.replace(/[:\\/]+/g, '_').replace(/^_+/, '');
  fs.copyFileSync(file, path.join(dir, `${stamp}__${safe}`));
  // keep the newest 200 backups
  const all = fs.readdirSync(dir).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 200))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}

function edit(file, fn) {
  const data = readJsonForEdit(file);
  const before = JSON.stringify(data);
  fn(data);
  if (JSON.stringify(data) === before) return false;
  backup(file);
  writeJsonAtomic(file, data);
  return true;
}

function cleanEmpty(obj, key) {
  const v = obj[key];
  if (v && typeof v === 'object' && Object.keys(v).length === 0) delete obj[key];
  if (Array.isArray(v) && v.length === 0) delete obj[key];
}

/** Find an item by id or by (case-insensitive) name. */
export function findItems(inv, query, kind) {
  const all = [...inv.mcps, ...inv.skills, ...inv.agents, ...inv.plugins].filter((x) => !kind || x.kind === kind);
  const byId = all.filter((x) => x.id === query);
  if (byId.length) return byId;
  const q = String(query).toLowerCase();
  const exact = all.filter((x) => x.displayName.toLowerCase() === q || x.name.toLowerCase() === q);
  if (exact.length) return exact;
  return all.filter((x) => x.displayName.toLowerCase().includes(q));
}

/**
 * Switch an item on or off.
 * @returns {{ ok: boolean, message: string, file?: string, item?: object }}
 */
export function setItemState({ project, id, name, kind, state, scope = 'project' }) {
  project = normProject(project);
  if (!['project', 'global'].includes(scope)) return { ok: false, message: `Unknown scope "${scope}"` };
  const inv = inventory(project, { fresh: true, track: false });
  const matches = findItems(inv, id || name, kind);
  if (!matches.length) return { ok: false, message: `Nothing called "${id || name}" was found` };
  if (matches.length > 1) {
    return { ok: false, message: `"${id || name}" matches several items: ${matches.slice(0, 8).map((m) => `${m.displayName} (${m.kind})`).join(', ')}. Use the exact name.` };
  }
  const item = matches[0];
  const paths = settingsPaths(project);
  const file = scope === 'global' ? paths.user : paths.local;
  let note = '';

  if (item.kind === 'agent') return { ok: false, message: 'Agents switch on/off with their plugin.' };

  if (item.kind === 'plugin') {
    const on = state !== 'off';
    edit(file, (s) => {
      s.enabledPlugins = s.enabledPlugins || {};
      s.enabledPlugins[item.pluginId] = on;
    });
  } else if (item.kind === 'skill') {
    if (!SKILL_STATES.has(state)) return { ok: false, message: `Skill state must be one of: ${[...SKILL_STATES].join(', ')}` };
    if (item.plugin && item.stateSource === 'plugin') return { ok: false, message: `${item.displayName} is off because its plugin is off. Switch the plugin on first.` };
    const userVal = readJsonForEdit(paths.user).skillOverrides?.[item.displayName];
    edit(file, (s) => {
      s.skillOverrides = s.skillOverrides || {};
      // In project scope, write "on" explicitly only when something wider turned it off.
      if (state === 'on' && (scope === 'global' || !userVal || userVal === 'on')) delete s.skillOverrides[item.displayName];
      else s.skillOverrides[item.displayName] = state;
      cleanEmpty(s, 'skillOverrides');
    });
    if (scope === 'global' && state === 'on') {
      // A project override could still hide it here; clear it so "on everywhere" means what it says.
      edit(paths.local, (s) => { if (s.skillOverrides) { delete s.skillOverrides[item.displayName]; cleanEmpty(s, 'skillOverrides'); } });
    }
  } else if (item.kind === 'mcp') {
    if (item.plugin) return { ok: false, message: `${item.displayName} comes from plugin ${item.plugin}. Switch the plugin instead.` };
    if (item.stateSource === 'claude-code' && state !== 'off') {
      return { ok: false, message: `${item.displayName} was disabled from Claude Code's /mcp menu. Re-enable it there.` };
    }
    const off = state === 'off';
    const strip = (s) => {
      if (!Array.isArray(s.deniedMcpServers)) return;
      s.deniedMcpServers = s.deniedMcpServers.filter((e) => e?.serverName !== item.name);
      cleanEmpty(s, 'deniedMcpServers');
    };
    if (off) {
      edit(file, (s) => {
        s.deniedMcpServers = Array.isArray(s.deniedMcpServers) ? s.deniedMcpServers : [];
        if (!s.deniedMcpServers.some((e) => e?.serverName === item.name)) s.deniedMcpServers.push({ serverName: item.name });
      });
    } else {
      edit(file, strip);
      if (scope === 'project') {
        const userDenied = (readJsonForEdit(paths.user).deniedMcpServers || []).some((e) => e?.serverName === item.name);
        if (userDenied) note = ' It is still blocked in your global settings, so switch it on for "All projects" to use it here.';
      } else {
        edit(paths.local, strip);
      }
    }
  } else {
    return { ok: false, message: `Can't switch ${item.kind} items` };
  }

  invalidateInventory();
  const after = findItems(inventory(project, { fresh: true, track: false }), item.id)[0];
  const where = scope === 'global' ? 'all projects' : 'this project';
  return {
    ok: true,
    message: `${item.displayName} is now ${after?.state ?? state} for ${where}. New Claude Code sessions pick this up.${note}`,
    file,
    item: after,
  };
}

// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
// ~/.claude.json lives next to ~/.claude unless CLAUDE_CONFIG_DIR moves it inside.
export const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(HOME, '.claude.json');
export const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const DATA_DIR = process.env.TOKEN_DASHBOARD_DATA || path.join(CLAUDE_DIR, 'token-dashboard');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

export const log = (...a) => console.error('[token-dashboard]', ...a);

/** Read JSON, returning `fallback` when missing or unreadable. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** Read JSON for editing: missing file -> {}, broken file -> throws (never clobber it). */
export function readJsonForEdit(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, so it was left untouched (${e.message})`);
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(file, body);
  }
}

/** Rough token estimate: ~4 characters per token for English text and JSON. */
export const estTokens = (s) => Math.ceil(String(s || '').length / 4);

/** Normalised project path for display. */
export function normProject(p) {
  let r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  r = r.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
  return r;
}

/** Comparison key for project paths (case-insensitive on Windows/macOS). */
export function projKey(p) {
  const n = normProject(p);
  return process.platform === 'linux' ? n : n.toLowerCase();
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Directory entries; symlinks/junctions report what they point to (skill installers link folders). */
export function listDir(p) {
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
  return entries.map((e) => {
    if (!e.isSymbolicLink()) return e;
    let st = null;
    try { st = fs.statSync(path.join(p, e.name)); } catch {}
    return { name: e.name, isDirectory: () => Boolean(st?.isDirectory()), isFile: () => Boolean(st?.isFile()), isSymbolicLink: () => true };
  });
}

/** Minimal YAML front-matter reader: top-level scalar keys, quoted strings and | / > blocks. */
export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!km) continue;
    const key = km[1];
    let v = km[2];
    if (/^[|>][+-]?\s*$/.test(v)) {
      const fold = v[0] === '>';
      const buf = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) buf.push(lines[++i].trim());
      v = buf.join(fold ? ' ' : '\n').trim();
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1]) && !/^\s+[A-Za-z0-9_-]+:\s/.test(lines[i + 1])) {
        v += ' ' + lines[++i].trim();
      }
      v = v.trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
        try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
      } else if (v.startsWith("'") && v.endsWith("'") && v.length > 1) {
        v = v.slice(1, -1).replace(/''/g, "'");
      }
    }
    out[key] = v;
  }
  return out;
}

/** Expand ${VAR} and ${VAR:-default} the way Claude Code does in MCP configs. */
export function expandVars(value, extra = {}) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) => {
      const v = extra[name] ?? process.env[name];
      return v !== undefined && v !== '' ? v : (def ?? '');
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandVars(v, extra));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandVars(v, extra)]));
  }
  return value;
}

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

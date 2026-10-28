// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// What the dashboard learns over time: which skills and MCP servers you actually use in each
// project (from Claude Code session transcripts), the fixes you make to auto mode, and the
// AI helper's answers. Auto mode reads this to decide better each day.
import path from 'node:path';
import { DATA_DIR, readJson, writeJsonAtomic, projKey, normProject, log } from './util.js';

const FILE = path.join(DATA_DIR, 'learned.json');
const DAY = 86400000;
export const RECENT_DAYS = 30;

let data = null;
let saveTimer = null;

function blank() {
  return {
    version: 1,
    since: new Date().toISOString(),
    usage: {}, // projKey -> { key -> { count, first, last } }   key = "skill:<name>" | "mcp:<server>"
    sessions: {}, // projKey -> { count, last, path }
    projectCats: {}, // projKey -> { cats: [], at }
    corrections: [], // { project, key, at } you undid an auto decision
    ai: { items: {}, tasks: {}, projects: {} }, // cached AI answers
    aiLog: [], // recent AI calls { at, kind, what, result, tokens }
    aiTokens: { input: 0, output: 0, calls: 0 },
    marks: {}, // transcript file -> last timestamp learned from
  };
}

export function load() {
  if (data) return data;
  const d = readJson(FILE, null);
  data = d && d.version === 1 ? { ...blank(), ...d, ai: { ...blank().ai, ...(d.ai || {}) } } : blank();
  return data;
}

/** Re-read from disk (other processes only read, the dashboard host writes). */
export function reload() {
  if (saveTimer) save(true); // write pending changes first so nothing is lost
  data = null;
  return load();
}

export function save(now = false) {
  if (now) { clearTimeout(saveTimer); saveTimer = null; try { writeJsonAtomic(FILE, load()); } catch (e) { log('could not save learning:', e.message); } return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(true); }, 2000);
  saveTimer.unref?.();
}

/** Same naming Claude Code uses for MCP tool prefixes: anything but letters, digits, _ and - becomes _. */
export const mcpSegment = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

/** The usage key for a dashboard item. */
export function usageKey(item) {
  if (item.kind === 'mcp') return `mcp:${mcpSegment(item.name)}`;
  if (item.kind === 'skill') return `skill:${item.displayName}`;
  return null;
}

// ---------- recording (called by the tracker as it reads transcripts) ----------

function bump(pk, key, ts) {
  const d = load();
  const p = (d.usage[pk] ||= {});
  const u = (p[key] ||= { count: 0, first: ts, last: ts });
  u.count += 1;
  u.last = Math.max(u.last, ts);
  u.first = Math.min(u.first, ts);
}

/** Only learn each transcript line once, even though the tracker re-reads recent days on start. */
export function shouldLearn(file, ts) {
  const d = load();
  return ts > (d.marks[file] || 0);
}
export function markLearned(file, ts) {
  const d = load();
  if (ts > (d.marks[file] || 0)) d.marks[file] = ts;
  save();
}

export function recordToolUse({ cwd, ts, name, input }) {
  if (!cwd || !name) return;
  const pk = projKey(cwd);
  if (name === 'Skill' && input?.skill) bump(pk, `skill:${String(input.skill).replace(/^\//, '')}`, ts);
  else if (name.startsWith('mcp__')) {
    const seg = name.slice(5).split('__')[0];
    if (seg) bump(pk, `mcp:${seg}`, ts);
  }
}

/** A slash command you typed (/name) counts as using that skill or command. */
export function recordCommand({ cwd, ts, command }) {
  if (!cwd || !command) return;
  bump(projKey(cwd), `skill:${String(command).replace(/^\//, '')}`, ts);
}

export function recordSession({ cwd, ts }) {
  if (!cwd) return;
  const d = load();
  const pk = projKey(cwd);
  const s = (d.sessions[pk] ||= { count: 0, last: 0, path: normProject(cwd) });
  s.count += 1;
  s.last = Math.max(s.last, ts);
  d.earliest = Math.min(d.earliest || ts, ts);
}

/** You switched back on (or otherwise overrode) something auto mode had switched off. */
export function recordCorrection(project, key) {
  const d = load();
  const pk = projKey(project);
  d.corrections.push({ project: pk, key, at: Date.now() });
  if (d.corrections.length > 500) d.corrections.splice(0, d.corrections.length - 500);
  // Counts like strong usage, so the item stays on here and in similar projects.
  const p = (d.usage[pk] ||= {});
  const u = (p[key] ||= { count: 0, first: Date.now(), last: Date.now() });
  u.count += 3;
  u.last = Date.now();
  u.corrected = (u.corrected || 0) + 1;
  save();
}

export function setProjectCats(project, cats) {
  const d = load();
  const pk = projKey(project);
  const prev = d.projectCats[pk];
  if (prev && prev.cats.join() === [...cats].sort().join()) return;
  d.projectCats[pk] = { cats: [...cats].sort(), at: Date.now() };
  save();
}

// ---------- reading ----------

/** Used in this project recently? */
export function usedHere(project, key, days = RECENT_DAYS) {
  const u = load().usage[projKey(project)]?.[key];
  if (!u || u.last < Date.now() - days * DAY) return null;
  return u;
}

export function totalSessions() {
  return Object.values(load().sessions).reduce((n, s) => n + s.count, 0);
}

/** Not used in any project for `days` days, while we've watched enough sessions to say so. */
export function unusedEverywhere(key, days = RECENT_DAYS) {
  const d = load();
  // Need enough history: 20+ sessions spanning at least a week (counted from the oldest session read).
  if (totalSessions() < 20 || Date.now() - (d.earliest || Date.now()) < 7 * DAY) return false;
  for (const p of Object.values(d.usage)) if (p[key] && p[key].last >= Date.now() - days * DAY) return false;
  return true;
}

/**
 * Kinds of work an item turned out to be used for: categories shared by most projects where you
 * used it. Used across very different projects = useful anywhere.
 */
export function learnedCategories(key) {
  const d = load();
  const projects = Object.entries(d.usage).filter(([, p]) => p[key]).map(([pk]) => d.projectCats[pk]?.cats).filter(Boolean);
  if (projects.length < 2) return { cats: [], general: false, projects: projects.length };
  const counts = {};
  for (const cats of projects) for (const c of cats) counts[c] = (counts[c] || 0) + 1;
  const cats = Object.entries(counts).filter(([, n]) => n / projects.length >= 0.6).map(([c]) => c);
  const general = projects.length >= 3 && cats.length === 0;
  return { cats, general, projects: projects.length };
}

export function aiItem(key) { return load().ai.items[key] || null; }
export function aiTask(text) { return load().ai.tasks[hash(text)] || null; }
export function aiProject(project) { return load().ai.projects[projKey(project)] || null; }

export function setAiItem(key, v) { load().ai.items[key] = { ...v, at: Date.now() }; save(); }
export function setAiTask(text, v) { load().ai.tasks[hash(text)] = { ...v, text: String(text).slice(0, 200), at: Date.now() }; save(); }
export function setAiProject(project, v) { load().ai.projects[projKey(project)] = { ...v, at: Date.now() }; save(); }

export function logAi(entry, usage) {
  const d = load();
  d.aiLog.unshift({ at: Date.now(), ...entry });
  if (d.aiLog.length > 60) d.aiLog.length = 60;
  if (usage) {
    d.aiTokens.input += usage.input_tokens || usage.prompt_eval_count || 0;
    d.aiTokens.output += usage.output_tokens || usage.eval_count || 0;
  }
  d.aiTokens.calls += 1;
  save();
}

export function hash(s) {
  let h = 2166136261;
  for (const c of String(s).toLowerCase().trim()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Summary for the dashboard's Learning page. */
export function summary(project) {
  const d = load();
  const pk = project ? projKey(project) : null;
  const all = {};
  for (const [p, items] of Object.entries(d.usage)) {
    for (const [k, u] of Object.entries(items)) {
      const a = (all[k] ||= { key: k, count: 0, last: 0, projects: 0 });
      a.count += u.count;
      a.last = Math.max(a.last, u.last);
      a.projects += 1;
    }
  }
  const here = pk ? Object.entries(d.usage[pk] || {}).map(([key, u]) => ({ key, ...u })).sort((a, b) => b.count - a.count) : [];
  return {
    since: d.earliest ? new Date(d.earliest).toISOString() : d.since,
    sessions: totalSessions(),
    sessionsHere: pk ? d.sessions[pk]?.count || 0 : 0,
    projects: Object.keys(d.sessions).length,
    itemsSeen: Object.keys(all).length,
    corrections: d.corrections.length,
    correctionsHere: pk ? d.corrections.filter((c) => c.project === pk).length : 0,
    topEverywhere: Object.values(all).sort((a, b) => b.count - a.count).slice(0, 25),
    here: here.slice(0, 25),
    ai: { items: Object.keys(d.ai.items).length, tasks: Object.keys(d.ai.tasks).length, projects: Object.keys(d.ai.projects).length, tokens: d.aiTokens, log: d.aiLog.slice(0, 20) },
  };
}

export const _reset = () => { data = blank(); };

// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Auto mode: works out what a project (and optionally a task) needs, and switches Claude Code
// MCP servers and skills to match. Settings are read when a session starts, so changes are
// prepared ahead of time and apply to the next session in that project.
import fs from 'node:fs';
import path from 'node:path';
import { normProject, projKey, readJson, listDir, isFile } from './util.js';
import { loadState, updateState } from './state.js';
import { inventory, knownProjects, invalidateInventory } from './scan.js';
import { setItemState } from './toggle.js';
import * as learn from './learn.js';

// ---------- categories ----------
// `item` words classify servers/skills (and task text); `deps`/`files`/`ext` detect them in a project.
export const CATEGORIES = {
  frontend: {
    label: 'Web front end',
    item: ['frontend', 'front-end', 'front end', 'ui', 'ux', 'css', 'tailwind', 'react', 'next.js', 'nextjs', 'vue', 'svelte', 'landing page', 'website', 'web page', 'webpage', 'component', 'shadcn', 'html', 'responsive', 'animation', 'gsap', 'hero section', 'redesign'],
    deps: ['react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'astro', '@angular/core', 'solid-js', '@remix-run/react', 'vite', 'tailwindcss', 'gatsby', 'preact', 'three', 'gsap', 'framer-motion'],
    files: ['tailwind.config.js', 'tailwind.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'vite.config.ts', 'vite.config.js', 'astro.config.mjs', 'nuxt.config.ts', 'svelte.config.js'],
    ext: { '.tsx': 3, '.jsx': 3, '.vue': 1, '.svelte': 1, '.html': 3, '.css': 3, '.scss': 2 },
  },
  design: {
    label: 'Visual design',
    item: ['figma', 'design system', 'design taste', 'inspiration', 'awwwards', 'brand', 'logo', 'banner', 'typography', 'visual design', 'mockup', 'palette', 'icon design', 'slop'],
    implies: ['frontend'],
  },
  browser: {
    label: 'Browser automation & testing',
    item: ['playwright', 'puppeteer', 'browser', 'chrome', 'devtools', 'e2e', 'screenshot', 'web automation', 'cypress'],
    deps: ['playwright', '@playwright/test', 'puppeteer', 'cypress', 'selenium-webdriver'],
    files: ['playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js'],
    implies: ['frontend'],
  },
  android: {
    label: 'Android',
    item: ['android', 'adb', 'apk', 'kotlin', 'gradle', 'jetpack'],
    files: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'AndroidManifest.xml', 'gradlew'],
    ext: { '.kt': 3 },
  },
  apple: {
    label: 'iOS / macOS',
    item: ['ios', 'swift', 'swiftui', 'xcode', 'macos app', 'iphone', 'cocoapods'],
    files: ['Package.swift', 'Podfile'],
    ext: { '.swift': 2, '.xcodeproj': 1 },
  },
  flutter: { label: 'Flutter', item: ['flutter', 'dart'], files: ['pubspec.yaml'], ext: { '.dart': 2 } },
  mobile: { label: 'Mobile app', item: ['mobile app', 'react native', 'expo'], deps: ['expo', 'react-native'], implies: ['frontend'] },
  data: {
    label: 'Data & databases',
    item: ['bigquery', 'sql', 'postgres', 'postgresql', 'mysql', 'spanner', 'alloydb', 'cloud sql', 'notebook', 'jupyter', 'analytics', 'data visualization', 'visualization', 'spark', 'dataproc', 'bigtable', 'pandas', 'database', 'supabase', 'mongodb', 'dataframe', 'etl'],
    deps: ['prisma', '@prisma/client', 'pg', 'mysql2', 'mongoose', 'mongodb', 'drizzle-orm', 'sequelize', 'knex', 'typeorm', '@supabase/supabase-js', 'pandas', 'numpy', 'polars', 'sqlalchemy', 'jupyter', 'duckdb'],
    files: ['schema.prisma', 'prisma/schema.prisma', 'drizzle.config.ts', 'dbt_project.yml'],
    ext: { '.ipynb': 1, '.sql': 2, '.parquet': 1 },
  },
  cloud: {
    label: 'Google Cloud / Firebase',
    item: ['firebase', 'google cloud', 'gcp', 'google maps', 'maps platform', 'cloud run', 'firestore'],
    deps: ['firebase', 'firebase-admin', '@google-cloud/storage', '@googlemaps/js-api-loader', '@react-google-maps/api', 'google-cloud-storage'],
    files: ['firebase.json', '.firebaserc', 'app.yaml', 'cloudbuild.yaml'],
  },
  reverse: {
    label: 'Reverse engineering',
    item: ['reverse engineer*', 'decompil*', 'disassembl*', 'binary analysis', 'firmware', 'ghidra', 'hopper', 'jeb', 'mach-o', 'native binar*', 'rea'],
    ext: { '.exe': 1, '.dll': 1, '.so': 1, '.dylib': 1, '.apk': 1, '.ipa': 1, '.elf': 1, '.bin': 2, '.wasm': 1, '.jar': 1 },
  },
  docs: {
    label: 'Office documents',
    item: ['docx', 'word document', 'pptx', 'powerpoint', 'slide deck', 'slides', 'xlsx', 'spreadsheet', 'excel', 'pdf', 'presentation'],
    ext: { '.docx': 1, '.pptx': 1, '.xlsx': 1, '.pdf': 2, '.csv': 3 },
  },
  writing: {
    label: 'Writing & copy',
    item: ['prose', 'writing', 'humanize', 'copywriting', 'ai writing', 'essay', 'blog post', 'rewrite text'],
    implies: ['frontend', 'docs'],
  },
  science: {
    label: 'Science & biology',
    item: ['protein*', 'biomolecular', 'alphafold', 'genom*', 'molecul*', 'chemistry', 'bioinformatic*', 'tfbs', 'sequence alignment', 'science'],
    deps: ['biopython', 'rdkit', 'scanpy', 'pysam'],
    ext: { '.pdb': 1, '.fasta': 1, '.fa': 1, '.cif': 1, '.sdf': 1, '.vcf': 1 },
  },
  ai: {
    label: 'AI / LLM apps',
    item: ['claude api', 'anthropic sdk', 'openai', 'llm app', 'prompt caching', 'agent sdk', 'langchain', 'rag'],
    deps: ['@anthropic-ai/sdk', 'anthropic', 'openai', 'langchain', '@langchain/core', 'ai', '@ai-sdk/anthropic', 'llamaindex'],
  },
  payments: { label: 'Payments', item: ['stripe', 'payment', 'checkout', 'billing'], deps: ['stripe', '@stripe/stripe-js', 'razorpay'] },
  devops: {
    label: 'DevOps & CI',
    item: ['docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'github actions', 'deployment pipeline', 'helm'],
    files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'main.tf', '.github/workflows'],
  },
};

// Process skills that help in any project (planning, debugging, reviews...). Never switched off.
const GENERAL = ['superpowers', 'brainstorm*', 'debug*', 'test driven', 'tdd', 'code review', 'writing plans', 'implementation plan*', 'executing plans', 'git', 'worktree*', 'commit*', 'verification', 'refactor*', 'subagent*', 'skill creator', 'create skills', 'writing skills', 'claude code', 'settings json', 'keybinding*', 'statusline', 'hooks', 'memory', 'security review', 'simplify', 'knowledge graph', 'codebase', 'onboarding'];

// When a project needs one kind of work, these related kinds of tools are useful there too.
const RELATED = {
  frontend: ['design', 'browser', 'writing'],
  mobile: ['frontend', 'design'],
  android: ['mobile', 'design'],
  apple: ['mobile', 'design'],
  flutter: ['mobile', 'design'],
  docs: ['writing'],
  reverse: ['browser'],
};
const NEVER_TOUCH = new Set(['token-dashboard']);

// Lower-case, and treat - _ / . : as spaces so "writing-plans" matches "writing plans".
const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[-_/.:]+/g, ' ').replace(/\s+/g, ' ')} `;
const reCache = new Map();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
/** Whole-word matches; a trailing * allows any ending ("decompil*" matches decompile, decompiler). */
const hits = (text, words) => words.filter((w) => {
  if (!reCache.has(w)) {
    const stem = w.endsWith('*');
    const core = escapeRe(norm(stem ? w.slice(0, -1) : w).trim());
    reCache.set(w, new RegExp(`(^|[^a-z0-9])${core}${stem ? '' : '(?![a-z0-9])'}`));
  }
  return reCache.get(w).test(text);
});

/** Which categories an item belongs to. `general` = useful anywhere; empty = can't tell (left alone). */
export function classify(item) {
  const name = norm([item.name, item.displayName].join(' '));
  const body = norm([item.description, ...(item.toolsTop || []).map((t) => t.name)].join(' '));
  // Score each kind: a match in the name counts 3, in the description 1. Keep the strong ones only,
  // so "rea" (reverse engineering, which happens to mention browsers) isn't filed under browser tools.
  const scores = Object.entries(CATEGORIES)
    .map(([k, c]) => [k, hits(name, c.item).length * 3 + hits(body, c.item).length])
    .filter(([, s]) => s > 0);
  const top = Math.max(0, ...scores.map(([, s]) => s));
  const domain = scores.filter(([, s]) => s >= Math.max(2, top / 2) || (top === 1 && s === 1)).map(([k]) => k);
  const general = hits(name, GENERAL).length > 0 || hits(body, GENERAL).length > 1;
  return { domain, general };
}

/** Keyword rules, plus the AI helper's answer, plus what your own usage taught. */
export function classifyFull(item) {
  const base = classify(item);
  const key = learn.usageKey(item);
  const ai = key ? learn.aiItem(key) : null;
  const lc = key ? learn.learnedCategories(key) : { cats: [], general: false };
  const domain = [...new Set([...base.domain, ...(ai?.cats || []), ...lc.cats])];
  return { domain, general: base.general || Boolean(ai?.general) || lc.general, ai: Boolean(ai), learned: lc.cats.length > 0 || lc.general };
}

/** Categories mentioned in free text (a task description). */
export function textCategories(task) {
  const text = norm(task);
  const out = new Set();
  for (const [k, c] of Object.entries(CATEGORIES)) if (hits(text, c.item).length) out.add(k);
  return expand(out);
}

function expand(set) {
  // A design or browser task is a front-end task too, etc.
  for (const k of [...set]) for (const i of CATEGORIES[k]?.implies || []) set.add(i);
  return set;
}

// ---------- project signals ----------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'vendor', 'target', 'venv', '.venv', 'env', '__pycache__', 'coverage', '.turbo', '.cache', 'Pods', 'DerivedData', '.gradle', '.idea', '.vscode', '.claude', '.agents', '.kiro', '.cursor', '.gemini', '.codex']);

/** Looks at a project's files and dependencies and returns the categories it needs, with evidence. */
export function projectSignals(dir) {
  const evidence = {};
  const note = (cat, why) => { (evidence[cat] ||= []).length < 4 && evidence[cat].push(why); };

  const deps = new Set();
  const pkg = readJson(path.join(dir, 'package.json'), null);
  if (pkg) for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(pkg[k] || {})) deps.add(d.toLowerCase());
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'environment.yml']) {
    try {
      const t = fs.readFileSync(path.join(dir, f), 'utf8').toLowerCase();
      for (const m of t.matchAll(/^[\s"'-]*([a-z0-9_.-]+)/gm)) deps.add(m[1]);
    } catch {}
  }

  // File census (bounded so huge repos stay fast)
  const ext = {};
  const names = new Set();
  let budget = 4000;
  const walk = (d, depth) => {
    for (const e of listDir(d)) {
      if (budget-- <= 0) return;
      if (e.isDirectory()) {
        if (e.name.endsWith('.xcodeproj')) ext['.xcodeproj'] = (ext['.xcodeproj'] || 0) + 1;
        if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth - 1);
        continue;
      }
      names.add(e.name);
      const x = path.extname(e.name).toLowerCase();
      if (x) ext[x] = (ext[x] || 0) + 1;
    }
  };
  walk(dir, 4);
  const hasPath = (rel) => isFile(path.join(dir, rel)) || fs.existsSync(path.join(dir, rel));

  for (const [cat, c] of Object.entries(CATEGORIES)) {
    for (const d of c.deps || []) if (deps.has(d)) note(cat, `uses ${d}`);
    for (const f of c.files || []) if (hasPath(f) || names.has(f)) note(cat, `has ${f}`);
    for (const [x, min] of Object.entries(c.ext || {})) if ((ext[x] || 0) >= min) note(cat, `${ext[x]} ${x} file${ext[x] > 1 ? 's' : ''}`);
  }
  const cats = expand(new Set(Object.keys(evidence)));
  for (const c of cats) if (!evidence[c]) evidence[c] = ['follows from related work'];
  return { categories: [...cats], evidence, fileCount: 4000 - Math.max(0, budget) };
}

/** Short text summary of a project for the AI helper (used only when the file rules find nothing). */
export function projectClues(dir) {
  const lines = [];
  const pkg = readJson(path.join(dir, 'package.json'), null);
  if (pkg) lines.push(`package.json: ${pkg.name || ''} - ${pkg.description || ''}; deps: ${Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 40).join(', ')}`);
  const ext = {};
  let budget = 3000;
  const walk = (d, depth) => {
    for (const e of listDir(d)) {
      if (budget-- <= 0) return;
      if (e.isDirectory()) { if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth - 1); continue; }
      const x = path.extname(e.name).toLowerCase() || e.name;
      ext[x] = (ext[x] || 0) + 1;
    }
  };
  walk(dir, 3);
  lines.push('files: ' + Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([x, n]) => `${n} ${x}`).join(', '));
  for (const f of ['README.md', 'readme.md', 'README.txt']) {
    try { lines.push('readme: ' + fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1500)); break; } catch {}
  }
  return lines.join('\n');
}

// ---------- planning ----------

function prefs() {
  const p = loadState().prefs.auto || {};
  return { enabled: Boolean(p.enabled), mode: p.mode === 'strict' ? 'strict' : 'gentle', excluded: p.excluded || [] };
}

export function setAutoPrefs(patch) {
  updateState((s) => { s.prefs.auto = { ...prefs(), ...(s.prefs.auto || {}), ...patch }; });
  return prefs();
}

export function getAutoState(project) {
  const s = loadState();
  const pk = projKey(project);
  return { prefs: prefs(), applied: s.autoApplied?.[pk] || {}, task: s.autoTask?.[pk] || null, lastRun: s.autoLastRun?.[pk] || null };
}

export function setTask(project, text) {
  const pk = projKey(project);
  updateState((s) => {
    s.autoTask ||= {};
    if (!text) delete s.autoTask[pk];
    else s.autoTask[pk] = { text: String(text).slice(0, 500), categories: [...textCategories(text)], at: new Date().toISOString() };
  });
}

/**
 * Works out which Claude Code items to switch for a project.
 * Rules: never touch what it can't classify, what's useful anywhere, or what you switched yourself;
 * only switch back on what auto mode itself switched off.
 */
export function plan(projectIn, { task } = {}) {
  const project = normProject(projectIn);
  const pk = projKey(project);
  const st = loadState();
  const mode = prefs().mode;
  const applied = st.autoApplied?.[pk] || {};
  learn.reload();
  let savedTask = task === undefined ? st.autoTask?.[pk] : (task ? { text: task, categories: [...textCategories(task)] } : null);
  if (savedTask) {
    const aiCats = learn.aiTask(savedTask.text)?.cats || [];
    savedTask = { ...savedTask, categories: [...expand(new Set([...(savedTask.categories || []), ...aiCats]))], ai: aiCats.length > 0 };
  }
  const signals = projectSignals(project);
  if (!signals.categories.length) {
    const ai = learn.aiProject(project);
    if (ai?.cats?.length) {
      signals.categories = [...expand(new Set(ai.cats))];
      for (const c of signals.categories) signals.evidence[c] = ['AI helper read the project'];
    }
  }
  const needs = new Set([...signals.categories, ...(savedTask?.categories || [])]);
  if (signals.categories.length) learn.setProjectCats(project, signals.categories);
  const wanted = new Set(needs);
  for (const c of needs) for (const r of RELATED[c] || []) wanted.add(r);
  const inv = inventory(project, { fresh: true, track: false });

  const changes = [];
  const kept = [];
  const recommend = []; // other tools: we only suggest
  if (!needs.size) {
    return { project, signals, task: savedTask, needs: [], wanted: [], changes, kept, recommend, mode, reason: 'Not enough clues in this project to decide safely, so nothing changes. Describe the task to help.' };
  }

  const candidates = [...inv.mcps, ...inv.skills].filter((x) => x.agent === 'claude' && !NEVER_TOUCH.has(x.name));
  const corrected = [];
  const sessions = learn.totalSessions();
  for (const it of candidates) {
    const key = learn.usageKey(it);
    const cls = classifyFull(it);
    const auto = applied[it.id];
    const isOnNow = it.state === 'on';
    // You changed something auto mode had set: learn from it and leave it alone from now on.
    if (auto && it.state !== auto) {
      corrected.push(it.id);
      if (key && (isOnNow || (auto === 'off' && it.state === 'name-only'))) learn.recordCorrection(project, key);
      continue;
    }
    // Used here recently: keep it (or bring it back if auto switched it).
    const used = key ? learn.usedHere(project, key) : null;
    if (used) {
      const why = `you used it here ${used.count} time${used.count === 1 ? '' : 's'}${used.corrected ? ' (you switched it back on)' : ''}`;
      if (auto && !isOnNow) changes.push({ id: it.id, name: it.displayName, kind: it.kind, from: it.state, to: 'on', tokens: it.tokens || 0, why, learned: true });
      else if (isOnNow) kept.push({ id: it.id, name: it.displayName, why, learned: true });
      continue;
    }
    if (!cls.domain.length) {
      if (cls.general) { kept.push({ id: it.id, name: it.displayName, why: 'useful in any project' }); continue; }
      // Learned: not used in any project across all the sessions read so far.
      if (isOnNow && it.stateSource === 'default' && it.toggleable !== false && key && learn.unusedEverywhere(key) && (it.kind === 'skill' || mode === 'strict')) {
        const to = it.kind === 'mcp' || mode === 'strict' ? 'off' : 'name-only';
        changes.push({ id: it.id, name: it.displayName, kind: it.kind, from: 'on', to, tokens: to === 'off' ? it.tokens || 0 : (it.tokens || 0) - (it.tokensNameOnly || 0), why: `not used in any project in your last ${sessions} sessions`, learned: true });
      }
      continue;
    }
    const match = cls.domain.filter((c) => wanted.has(c));
    const cats = cls.domain.map((c) => CATEGORIES[c].label).join(', ');
    if (match.length) {
      // Needed. Bring it back only if auto mode was the one that switched it.
      if (auto && it.state === auto && !isOnNow) changes.push({ id: it.id, name: it.displayName, kind: it.kind, from: it.state, to: 'on', tokens: it.tokens || 0, why: `needed: ${match.map((c) => CATEGORIES[c].label).join(', ')}` });
      else if (isOnNow) kept.push({ id: it.id, name: it.displayName, why: `needed: ${match.map((c) => CATEGORIES[c].label).join(', ')}` });
      continue;
    }
    if (cls.general) { kept.push({ id: it.id, name: it.displayName, why: 'useful in any project' }); continue; }
    // Not needed here.
    if (!isOnNow) continue; // already off/name-only (by you or by auto)
    if (it.stateSource && !['default'].includes(it.stateSource)) continue; // you chose this state yourself
    if (it.toggleable === false) continue;
    const to = it.kind === 'mcp' || mode === 'strict' ? 'off' : 'name-only';
    const saves = to === 'off' ? it.tokens || 0 : (it.tokens || 0) - (it.tokensNameOnly || 0);
    changes.push({ id: it.id, name: it.displayName, kind: it.kind, from: 'on', to, tokens: saves, why: `not needed here (${cats})` });
  }

  if (corrected.length) {
    updateState((s) => { const rec = s.autoApplied?.[pk]; if (rec) for (const id of corrected) delete rec[id]; });
  }

  // Other tools: suggestions only (their project-level overrides aren't reliable to write).
  for (const it of inv.mcps.filter((x) => x.agent !== 'claude' && x.state === 'on')) {
    const cls = classify(it);
    if (cls.domain.length && !cls.domain.some((c) => wanted.has(c)) && !cls.general) {
      recommend.push({ id: it.id, name: it.name, agent: it.agent, tokens: it.tokens || 0, why: `not needed here (${cls.domain.map((c) => CATEGORIES[c].label).join(', ')})`, switchable: it.toggleable });
    }
  }

  const savedPerRequest = changes.reduce((n, c) => n + (c.to === 'on' ? -c.tokens : c.tokens), 0);
  return { project, signals, task: savedTask, needs: [...needs], wanted: [...wanted], changes, kept, recommend, mode, savedPerRequest };
}

/** Apply a plan's changes to the project's Claude Code settings and remember what auto mode did. */
export function apply(projectIn, opts = {}) {
  const project = normProject(projectIn);
  const pk = projKey(project);
  const p = plan(project, opts);
  const done = [];
  const failed = [];
  for (const c of p.changes) {
    const r = setItemState({ project, id: c.id, state: c.to, scope: 'project' });
    (r.ok ? done : failed).push({ ...c, message: r.message });
  }
  updateState((s) => {
    s.autoApplied ||= {};
    const rec = (s.autoApplied[pk] ||= {});
    for (const c of done) { if (c.to === 'on') delete rec[c.id]; else rec[c.id] = c.to; }
    if (!Object.keys(rec).length) delete s.autoApplied[pk];
    s.autoLastRun ||= {};
    s.autoLastRun[pk] = new Date().toISOString();
  });
  invalidateInventory();
  return { ...p, done, failed };
}

/** Put back everything auto mode switched in a project (leaves your own choices alone). */
export function undo(projectIn) {
  const project = normProject(projectIn);
  const pk = projKey(project);
  const rec = loadState().autoApplied?.[pk] || {};
  const inv = inventory(project, { fresh: true, track: false });
  const restored = [];
  for (const [id, val] of Object.entries(rec)) {
    const it = [...inv.mcps, ...inv.skills].find((x) => x.id === id);
    if (it && it.state === val) {
      const r = setItemState({ project, id, state: 'on', scope: 'project' });
      if (r.ok) restored.push(it.displayName);
    }
  }
  updateState((s) => { if (s.autoApplied) delete s.autoApplied[pk]; });
  invalidateInventory();
  return { restored };
}

/** Background run: apply to every known project (when auto mode is on). */
export function runAll(launchProject) {
  const p = prefs();
  if (!p.enabled) return [];
  const out = [];
  for (const proj of knownProjects(launchProject)) {
    if (!proj.exists || p.excluded.includes(projKey(proj.path))) continue;
    try {
      const pl = plan(proj.path);
      if (pl.changes.length) out.push({ project: proj.path, ...summary(apply(proj.path)) });
    } catch (e) { out.push({ project: proj.path, error: e.message }); }
  }
  return out;
}

const summary = (r) => ({ changed: r.done.length, failed: r.failed.length, savedPerRequest: r.savedPerRequest });

export function _projectHasConfig(dir) { return isFile(path.join(dir, '.claude', 'settings.local.json')); }

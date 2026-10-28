// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Optional AI helper for auto mode. It classifies the servers, skills, tasks and projects that the
// keyword rules can't place. Off until you pick a provider. Every answer is cached, so each item
// is asked about once.
//   - "ollama": a local model through Ollama (free, nothing leaves your computer)
//   - "anthropic": the Claude API through the official SDK (optional dependency @anthropic-ai/sdk);
//     credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile, never stored here.
import { loadState, updateState } from './state.js';
import * as learn from './learn.js';
import { log } from './util.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const OLLAMA_URL = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434';

export function aiPrefs() {
  const p = loadState().prefs.ai || {};
  return { provider: ['ollama', 'anthropic'].includes(p.provider) ? p.provider : 'off', model: p.model || '', ollamaUrl: p.ollamaUrl || OLLAMA_URL };
}

export function setAiPrefs(patch) {
  updateState((s) => { s.prefs.ai = { ...(s.prefs.ai || {}), ...patch }; });
  return aiPrefs();
}

/** What's available on this machine. */
export async function detect() {
  const out = { ollama: { available: false, models: [] }, anthropic: { sdk: false, credentials: false } };
  try {
    const r = await fetch(`${aiPrefs().ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    out.ollama = { available: true, models: (j.models || []).map((m) => m.name) };
  } catch {}
  try { await import('@anthropic-ai/sdk'); out.anthropic.sdk = true; } catch {}
  out.anthropic.credentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  return out;
}

// ---------- one structured call ----------

async function callClaude(system, user, schema, model) {
  let Anthropic;
  try { Anthropic = (await import('@anthropic-ai/sdk')).default; } catch {
    throw new Error('The Claude API option needs the @anthropic-ai/sdk package. Run "npm install" in the dashboard folder.');
  }
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: model || DEFAULT_CLAUDE_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { json: JSON.parse(text), usage: response.usage };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('No valid Claude API credentials. Set ANTHROPIC_API_KEY or run "ant auth login".');
    if (error instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit reached; will try again later.');
    if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status}: ${error.message}`);
    throw error;
  }
}

async function callOllama(system, user, schema, model) {
  const p = aiPrefs();
  let name = model;
  if (!name) {
    const d = await detect();
    name = d.ollama.models[0];
    if (!name) throw new Error('Ollama is running but has no models. Run e.g. "ollama pull llama3.2".');
  }
  const r = await fetch(`${p.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: false, format: schema, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Ollama error ${r.status}`);
  const j = await r.json();
  return { json: JSON.parse(j.message?.content || '{}'), usage: { input_tokens: j.prompt_eval_count || 0, output_tokens: j.eval_count || 0 } };
}

async function ask(system, user, schema) {
  const p = aiPrefs();
  if (p.provider === 'off') throw new Error('AI helper is off');
  return p.provider === 'anthropic' ? callClaude(system, user, schema, p.model) : callOllama(system, user, schema, p.model);
}

// ---------- classification jobs ----------

const SYSTEM = 'You sort developer tools by the kind of software work they help with. Use only the category keys given. '
  + 'Mark general=true only for tools useful in almost any coding project (planning, debugging, git, reviews, testing in general). '
  + 'If a tool fits no category and is not general, return an empty list.';

const catList = (CATEGORIES) => Object.entries(CATEGORIES).map(([k, c]) => `${k}: ${c.label}`).join('\n');

/** Classify servers/skills the rules couldn't place. items: [{ key, name, description }] */
export async function classifyItems(items, CATEGORIES) {
  const keys = Object.keys(CATEGORIES);
  const done = [];
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    const schema = {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'categories', 'general'], properties: { id: { type: 'string' }, categories: { type: 'array', items: { type: 'string', enum: keys } }, general: { type: 'boolean' } } } } },
    };
    const user = `Categories:\n${catList(CATEGORIES)}\n\nTools:\n${batch.map((x, n) => `id ${n}: ${x.name} - ${String(x.description || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}\n\nReturn one entry per tool id.`;
    const { json, usage } = await ask(SYSTEM, user, schema);
    for (const r of json.items || []) {
      const it = batch[Number(r.id)];
      if (!it) continue;
      const cats = (r.categories || []).filter((c) => keys.includes(c));
      learn.setAiItem(it.key, { cats, general: Boolean(r.general), by: aiPrefs().provider });
      done.push({ name: it.name, cats, general: Boolean(r.general) });
    }
    learn.logAi({ kind: 'items', what: `${batch.length} item(s)`, result: done.slice(-batch.length).map((d) => `${d.name}: ${d.general ? 'general' : d.cats.join(', ') || 'none'}`).join('; ') }, usage);
  }
  return done;
}

export async function classifyTask(text, CATEGORIES) {
  const keys = Object.keys(CATEGORIES);
  const schema = { type: 'object', additionalProperties: false, required: ['categories'], properties: { categories: { type: 'array', items: { type: 'string', enum: keys } } } };
  const { json, usage } = await ask(
    'You decide which kinds of developer tools a task needs. Use only the category keys given. Pick the fewest that cover the task.',
    `Categories:\n${catList(CATEGORIES)}\n\nTask: ${String(text).slice(0, 500)}`, schema,
  );
  const cats = (json.categories || []).filter((c) => keys.includes(c));
  learn.setAiTask(text, { cats, by: aiPrefs().provider });
  learn.logAi({ kind: 'task', what: String(text).slice(0, 80), result: cats.join(', ') || 'none' }, usage);
  return cats;
}

export async function classifyProject(project, clues, CATEGORIES) {
  const keys = Object.keys(CATEGORIES);
  const schema = { type: 'object', additionalProperties: false, required: ['categories'], properties: { categories: { type: 'array', items: { type: 'string', enum: keys } } } };
  const { json, usage } = await ask(
    'You decide what kind of software project this is from a short file summary. Use only the category keys given. If unclear, return an empty list.',
    `Categories:\n${catList(CATEGORIES)}\n\nProject summary:\n${clues.slice(0, 3000)}`, schema,
  );
  const cats = (json.categories || []).filter((c) => keys.includes(c));
  learn.setAiProject(project, { cats, by: aiPrefs().provider });
  learn.logAi({ kind: 'project', what: project.split(/[\\/]/).pop(), result: cats.join(', ') || 'none' }, usage);
  return cats;
}

let running = false;
/** Background pass: classify what the rules couldn't. Returns how many answers were added. */
export async function runPass({ items = [], tasks = [], projects = [], CATEGORIES }) {
  if (aiPrefs().provider === 'off' || running) return 0;
  running = true;
  let n = 0;
  try {
    if (items.length) n += (await classifyItems(items.slice(0, 60), CATEGORIES)).length;
    for (const t of tasks.slice(0, 5)) { await classifyTask(t, CATEGORIES); n++; }
    for (const p of projects.slice(0, 5)) { await classifyProject(p.path, p.clues, CATEGORIES); n++; }
  } catch (e) {
    learn.logAi({ kind: 'error', what: 'AI helper', result: e.message });
    log('AI helper:', e.message);
  } finally {
    running = false;
  }
  return n;
}

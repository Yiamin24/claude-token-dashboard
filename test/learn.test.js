// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-learn-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, 'AppData');
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
process.env.TOKEN_DASHBOARD_DATA = path.join(root, 'data');

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
const skill = (name, description) => write(path.join(root, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);

write(path.join(root, '.claude', 'settings.json'), {});
write(path.join(root, '.claude', '.claude.json'), { mcpServers: { rea: { command: 'node', args: ['rea.mjs'] } } });
skill('rev-tools', 'Reverse engineer native binaries and decompile firmware.');
skill('mystery', 'Does something nobody can classify.');
skill('docx', 'Create Word documents (.docx).');

const web = path.join(root, 'site');
write(path.join(web, 'package.json'), { dependencies: { react: '18', next: '14' } });

const { mcpConfigHash } = await import('../src/scan.js');
const { updateState } = await import('../src/state.js');
updateState((s) => { s.probes[mcpConfigHash({ command: 'node', args: ['rea.mjs'] })] = { status: 'ok', serverName: 'rea', tools: [{ name: 'decompile', tokens: 400 }], schemaTokens: 400, instructionsTokens: 0 }; });

const learn = await import('../src/learn.js');
const { Tracker } = await import('../src/tracker.js');
const { plan, apply, classifyFull, CATEGORIES } = await import('../src/auto.js');
const { setItemState } = await import('../src/toggle.js');
const ai = await import('../src/ai.js');

const now = Date.now();
const transcript = path.join(root, '.claude', 'projects', 'site', 's1.jsonl');
const L = (o) => JSON.stringify({ cwd: web, sessionId: 's1', timestamp: new Date(now + (o.dt || 0)).toISOString(), ...o }) + '\n';

test('learns which skills, MCP servers and commands you use, once per line', async () => {
  write(transcript,
    L({ type: 'user', message: { role: 'user', content: '<command-name>/docx</command-name>' } })
    + L({ type: 'assistant', dt: 1, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'rev-tools' } }] } })
    + L({ type: 'assistant', dt: 2, message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'mcp__rea__decompile', input: {} }] } })
    + L({ type: 'assistant', dt: 3, message: { id: 'm3', content: [{ type: 'tool_use', id: 't3', name: 'mcp__rea__decompile', input: {} }] } }));
  const t = new Tracker({ savingsFor: () => ({ saved: 0, items: [] }) });
  await t.start();
  t.stop();
  assert.equal(learn.usedHere(web, 'mcp:rea').count, 2);
  assert.equal(learn.usedHere(web, 'skill:rev-tools').count, 1);
  assert.equal(learn.usedHere(web, 'skill:docx').count, 1, 'slash command counts');
  assert.equal(learn.totalSessions(), 1);
  // Reading the same file again (dashboard restart) must not double count.
  const t2 = new Tracker({ savingsFor: () => ({ saved: 0, items: [] }) });
  await t2.start();
  t2.stop();
  assert.equal(learn.usedHere(web, 'mcp:rea').count, 2);
});

test('auto mode keeps what you use, even when the rules say it is not needed', () => {
  const p = plan(web);
  const names = p.changes.map((c) => c.name);
  assert.ok(!names.includes('rea'), 'rea is used here, so it stays');
  assert.ok(!names.includes('rev-tools'));
  assert.ok(p.kept.find((k) => k.name === 'rea' && k.learned && /used it here 2 times/.test(k.why)));
});

test('a fix you make is remembered as a correction', () => {
  // Pretend auto switched docx to name-only; you then switch it back on.
  const proj2 = path.join(root, 'site2');
  write(path.join(proj2, 'package.json'), { dependencies: { react: '18' } });
  const r = apply(proj2);
  assert.ok(r.done.find((c) => c.name === 'docx'), 'auto set docx to name-only');
  assert.ok(setItemState({ project: proj2, name: 'docx', state: 'on' }).ok);
  plan(proj2); // notices your change
  const u = learn.usedHere(proj2, 'skill:docx');
  assert.ok(u && u.corrected === 1, 'correction recorded');
  assert.ok(!plan(proj2).changes.find((c) => c.name === 'docx'), 'and auto leaves it alone');
});

test('learns kinds of work from where items get used', () => {
  learn.setProjectCats(path.join(root, 'a'), ['data']);
  learn.setProjectCats(path.join(root, 'b'), ['data', 'frontend']);
  learn.recordToolUse({ cwd: path.join(root, 'a'), ts: now, name: 'Skill', input: { skill: 'mystery' } });
  learn.recordToolUse({ cwd: path.join(root, 'b'), ts: now, name: 'Skill', input: { skill: 'mystery' } });
  assert.deepEqual(learn.learnedCategories('skill:mystery').cats, ['data']);
  assert.deepEqual(classifyFull({ kind: 'skill', name: 'mystery', displayName: 'mystery', description: 'Does something nobody can classify.' }).domain, ['data']);
});

test('AI helper answers are cached and used', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'tiny' }] })); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls++;
      const user = JSON.parse(body).messages[1].content;
      const content = user.includes('Tools:') ? { items: [{ id: '0', categories: ['science'], general: false }] } : { categories: ['reverse'] };
      res.end(JSON.stringify({ message: { content: JSON.stringify(content) }, prompt_eval_count: 50, eval_count: 10 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ai.setAiPrefs({ provider: 'ollama', ollamaUrl: `http://127.0.0.1:${server.address().port}`, model: 'tiny' });
  const n = await ai.runPass({ items: [{ key: 'skill:odd', name: 'odd', description: 'protein stuff?' }], tasks: ['take apart this app'], CATEGORIES });
  server.close();
  assert.equal(n, 2);
  assert.deepEqual(learn.aiItem('skill:odd').cats, ['science']);
  assert.deepEqual(learn.aiTask('take apart this app').cats, ['reverse']);
  assert.equal(learn.summary().ai.tokens.input, 100);
  assert.equal(calls, 2);
  ai.setAiPrefs({ provider: 'off' });
});

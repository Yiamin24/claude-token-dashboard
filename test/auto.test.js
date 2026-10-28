// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-auto-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, 'AppData');
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
process.env.TOKEN_DASHBOARD_DATA = path.join(root, 'data');

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
const skill = (name, description) => write(path.join(root, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);

write(path.join(root, '.claude', 'settings.json'), {});
write(path.join(root, '.claude', '.claude.json'), {
  mcpServers: {
    rea: { command: 'node', args: ['rea.mjs'] },
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
  },
});
skill('docx', 'Create and edit Word documents (.docx) and PowerPoint slide decks.');
skill('frontend-polish', 'Polish frontend UI, CSS and landing page layout.');
skill('brainstorming', 'Brainstorm before building anything.');
skill('mystery', 'Does something nobody can classify.');
skill('rev-tools', 'Reverse engineer native binaries and decompile firmware.');

// Probe results so the servers are "measured" and classified by their tools
const { mcpConfigHash } = await import('../src/scan.js');
const { updateState } = await import('../src/state.js');
updateState((s) => {
  s.probes[mcpConfigHash({ command: 'node', args: ['rea.mjs'] })] = { status: 'ok', serverName: 'rea', tools: [{ name: 'decompile_function', tokens: 500 }], schemaTokens: 500, instructionsTokens: 0 };
  s.probes[mcpConfigHash({ command: 'npx', args: ['@playwright/mcp'] })] = { status: 'ok', serverName: 'Playwright', tools: [{ name: 'browser_navigate', tokens: 300 }], schemaTokens: 300, instructionsTokens: 0 };
});

const web = path.join(root, 'site');
write(path.join(web, 'package.json'), { dependencies: { react: '18', next: '14', tailwindcss: '3' } });
write(path.join(web, 'app', 'page.tsx'), 'export default () => null');

const empty = path.join(root, 'empty');
write(path.join(empty, 'notes.txt'), 'hi');

const { classify, textCategories, projectSignals, plan, apply, undo, setTask } = await import('../src/auto.js');
const { inventory } = await import('../src/scan.js');
const { setItemState } = await import('../src/toggle.js');
const state = (name) => [...inventory(web, { fresh: true }).mcps, ...inventory(web, { fresh: true }).skills].find((x) => x.agent === 'claude' && x.name === name).state;

test('classifies items and task text', () => {
  assert.deepEqual(classify({ name: 'rea', description: 'Reverse-engineering tools for binaries and browser pages' }).domain, ['reverse']);
  assert.ok(classify({ name: 'docs', description: 'Use for exporting reports' }).domain.every((d) => d !== 'mobile'), '"export" is not "expo"');
  assert.ok(classify({ name: 'superpowers:writing-plans', description: 'Write a plan' }).general);
  assert.ok(textCategories('fix the landing page hero animation').has('frontend'));
  assert.ok(textCategories('reverse engineer this apk').has('reverse'));
});

test('reads project clues', () => {
  const s = projectSignals(web);
  assert.ok(s.categories.includes('frontend'));
  assert.match(s.evidence.frontend.join(' '), /uses react/);
  assert.equal(projectSignals(empty).categories.length, 0);
});

test('plans: keeps what the project needs, switches off the rest, leaves unknowns alone', () => {
  const p = plan(web);
  const to = Object.fromEntries(p.changes.map((c) => [c.name, c.to]));
  assert.equal(to.rea, 'off', 'reverse-engineering server off in a web project');
  assert.equal(to.docx, 'name-only', 'gentle mode keeps skills listed by name');
  assert.equal(to['rev-tools'], 'name-only');
  for (const keep of ['playwright', 'frontend-polish', 'brainstorming', 'mystery', 'token-dashboard']) assert.ok(!(keep in to), `${keep} untouched`);
  assert.equal(plan(empty).changes.length, 0, 'no clues = no changes');
});

test('applies, respects your own choices, follows the task, and undoes', () => {
  // You switched docx off yourself before auto mode ran: auto must leave it alone.
  assert.ok(setItemState({ project: web, name: 'docx', state: 'off' }).ok);
  const r = apply(web);
  assert.ok(r.done.length >= 2, 'changes applied');
  assert.equal(state('rea'), 'off');
  assert.equal(state('rev-tools'), 'name-only');
  assert.equal(state('docx'), 'off', 'your choice kept');
  const local = JSON.parse(fs.readFileSync(path.join(web, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.deniedMcpServers, [{ serverName: 'rea' }]);

  // A task that needs reverse engineering brings back what auto switched off.
  setTask(web, 'reverse engineer the competitor app binary');
  apply(web);
  assert.equal(state('rea'), 'on');
  assert.equal(state('rev-tools'), 'on');

  // Clear the task: they go off again. Then undo puts back only auto's changes.
  setTask(web, '');
  apply(web);
  assert.equal(state('rea'), 'off');
  const u = undo(web);
  assert.ok(u.restored.includes('rea'));
  assert.equal(state('rea'), 'on');
  assert.equal(state('docx'), 'off', 'undo leaves your own choice alone');
});

test('if you change something auto mode set, auto leaves it alone afterwards', () => {
  apply(web);
  assert.equal(state('rev-tools'), 'name-only');
  assert.ok(setItemState({ project: web, name: 'rev-tools', state: 'off' }).ok); // your call
  setTask(web, 'decompile the firmware');
  apply(web);
  assert.equal(state('rev-tools'), 'off', 'not switched back on, because you changed it');
  setTask(web, '');
});

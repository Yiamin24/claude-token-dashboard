// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-agents-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, 'AppData');
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
process.env.TOKEN_DASHBOARD_DATA = path.join(root, 'data');
delete process.env.CODEX_HOME;
delete process.env.COPILOT_HOME;

const proj = path.join(root, 'proj');
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
const read = (p) => fs.readFileSync(p, 'utf8');
const H = (...p) => path.join(root, ...p);

write(H('.claude', 'settings.json'), {});
write(H('.claude', '.claude.json'), { mcpServers: { rea: { command: 'node', args: ['rea.mjs', 'mcp'] } } });
write(H('.codex', 'config.toml'), [
  'model = "gpt-5"',
  '',
  '[projects.\'c:\\users\\x\']',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.rea]',
  'command = "node"',
  'args = [ "rea.mjs", "mcp" ]',
  '',
  '[mcp_servers.rea.env]',
  'TOKEN = "x"',
  '',
  '[mcp_servers."docs-server"]',
  'url = "https://example.com/mcp"',
  'enabled = false',
  '',
].join('\n'));
write(H('.codex', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Codex skill\n---\n');
write(H('.gemini', 'settings.json'), { mcpServers: { rea: { command: 'node', args: ['rea.mjs', 'mcp'] } }, mcp: { excluded: [] } });
write(H('.kiro', 'settings', 'mcp.json'), { mcpServers: { inspo: { command: 'npx', args: ['-y', 'inspo-mcp'], disabled: false } } });
write(H('.config', 'opencode', 'opencode.json'), { mcp: { rea: { type: 'local', command: ['node', 'rea.mjs', 'mcp'], enabled: true } } });
write(H('AppData', 'Code', 'User', 'mcp.json'), '{\n  // comment\n  "servers": { "rea": { "type": "stdio", "command": "node", "args": ["rea.mjs", "mcp"] }, },\n}');
write(H('.agents', 'skills', 'shared-one', 'SKILL.md'), '---\nname: shared-one\ndescription: Shared skill\n---\n');
write(H('.gemini', 'config', 'config.json'), { plugins: { science: { enabled: true } } });
write(H('.gemini', 'config', 'plugins', 'science', 'plugin.json'), { name: 'science', displayName: 'Science' });
write(H('.gemini', 'config', 'plugins', 'science', 'skills', 'fold', 'SKILL.md'), '---\nname: fold\ndescription: Protein folding\n---\n');
write(H('.gemini', 'antigravity', 'mcp', 'rea', 'xrefs.json'), { name: 'xrefs', description: 'Find refs', parameters: { type: 'object' } });
write(path.join(proj, '.kiro', 'settings', 'mcp.json'), { mcpServers: { local: { command: 'node', args: ['x.js'] } } });

const { parseToml, parseJsonc } = await import('../src/agents.js');
const { inventory } = await import('../src/scan.js');
const { setItemState } = await import('../src/toggle.js');

const inv = () => inventory(proj, { fresh: true });
const find = (agent, name, kind = 'mcp') => [...inv().mcps, ...inv().skills, ...inv().plugins].find((x) => x.agent === agent && x.name === name && x.kind === kind);

test('TOML and JSONC readers', () => {
  const t = parseToml(read(H('.codex', 'config.toml')));
  assert.equal(t.model, 'gpt-5');
  assert.deepEqual(t.mcp_servers.rea.args, ['rea.mjs', 'mcp']);
  assert.equal(t.mcp_servers.rea.env.TOKEN, 'x');
  assert.equal(t.mcp_servers['docs-server'].enabled, false);
  assert.equal(t.projects['c:\\users\\x'].trust_level, 'trusted');
  assert.deepEqual(parseJsonc('{ "a": "// not a comment", /* c */ "b": [1,], }'), { a: '// not a comment', b: [1] });
});

test('finds MCP servers and skills across tools', () => {
  const i = inv();
  const tools = Object.fromEntries(i.tools.map((t) => [t.id, t]));
  for (const id of ['claude', 'codex', 'gemini', 'kiro', 'opencode', 'vscode', 'antigravity', 'shared']) assert.ok(tools[id], `${id} detected`);
  assert.equal(find('codex', 'docs-server').state, 'off', 'codex enabled=false is read');
  assert.equal(find('codex', 'docs-server').transport, 'http');
  assert.ok(find('kiro', 'local'), 'project-level Kiro config is read');
  assert.equal(find('opencode', 'rea').target, 'node rea.mjs mcp', 'OpenCode command arrays are normalised');
  assert.ok(find('vscode', 'rea'), 'VS Code JSONC config is read');
  assert.ok(find('codex', 'mine', 'skill'));
  assert.ok(find('shared', 'shared-one', 'skill'));
  assert.ok(find('antigravity', 'fold', 'skill'));
  // One cached Antigravity measurement covers the same server in every tool.
  for (const a of ['claude', 'codex', 'gemini', 'opencode', 'vscode']) assert.ok(find(a, 'rea').measured, `${a} rea measured from cache`);
  assert.equal(i.newItems.length, 0, 'first scan is a silent baseline');
});

test('switches write each tool\'s own config', () => {
  let r = setItemState({ project: proj, name: 'rea', agent: 'codex', state: 'off' });
  assert.ok(r.ok, r.message);
  const toml = read(H('.codex', 'config.toml'));
  assert.match(toml, /\[mcp_servers\.rea\]\nenabled = false\ncommand = "node"/);
  assert.match(toml, /TOKEN = "x"/, 'rest of the file untouched');
  assert.equal(find('codex', 'rea').state, 'off');
  r = setItemState({ project: proj, name: 'docs-server', agent: 'codex', state: 'on' });
  assert.ok(r.ok, r.message);
  assert.match(read(H('.codex', 'config.toml')), /url = "https:\/\/example.com\/mcp"\nenabled = true/);

  assert.ok(setItemState({ project: proj, name: 'rea', agent: 'gemini', state: 'off' }).ok);
  assert.deepEqual(JSON.parse(read(H('.gemini', 'settings.json'))).mcp.excluded, ['rea']);
  assert.equal(find('gemini', 'rea').state, 'off');

  assert.ok(setItemState({ project: proj, name: 'inspo', agent: 'kiro', state: 'off' }).ok);
  assert.equal(JSON.parse(read(H('.kiro', 'settings', 'mcp.json'))).mcpServers.inspo.disabled, true);

  assert.ok(setItemState({ project: proj, name: 'rea', agent: 'opencode', state: 'off' }).ok);
  assert.equal(JSON.parse(read(H('.config', 'opencode', 'opencode.json'))).mcp.rea.enabled, false);

  r = setItemState({ project: proj, name: 'rea', agent: 'vscode', state: 'off' });
  assert.equal(r.ok, false, 'VS Code has no on/off flag in its file');
  assert.match(read(H('AppData', 'Code', 'User', 'mcp.json')), /\/\/ comment/, 'read-only file untouched');

  assert.ok(setItemState({ project: proj, name: 'Science', agent: 'antigravity', state: 'off' }).ok);
  assert.equal(JSON.parse(read(H('.gemini', 'config', 'config.json'))).plugins.science.enabled, false);
  assert.equal(find('antigravity', 'fold', 'skill').state, 'off', 'plugin off turns its skills off');
});

test('agent "all" switches the same server in every tool that allows it', () => {
  const r = setItemState({ project: proj, name: 'rea', agent: 'all', state: 'on' });
  assert.ok(r.ok, r.message);
  for (const a of ['claude', 'codex', 'gemini', 'opencode']) assert.equal(find(a, 'rea').state, 'on', a);
  assert.match(r.message, /Not switched/, 'reports the read-only ones');
});

test('a tool added later is reported as new', () => {
  write(H('.cursor', 'mcp.json'), { mcpServers: { brand: { command: 'npx', args: ['brand-mcp'] } } });
  const i = inv();
  assert.ok(i.newItems.find((n) => n.name === 'brand'), 'new Cursor server flagged');
});

test('finds projects opened in other tools and their own setup', async () => {
  const { knownProjects } = await import('../src/scan.js');
  // A project that only Kiro has opened (recorded in its workspace history)
  const kiroProj = H('work', 'kiro-only');
  write(path.join(kiroProj, '.kiro', 'settings', 'mcp.json'), { mcpServers: { one: { command: 'x' } } });
  write(H('AppData', 'Kiro', 'User', 'workspaceStorage', 'abc', 'workspace.json'), { folder: 'file:///' + kiroProj.split(path.sep).join('/') });
  // A Desktop folder with Devin and Cursor skills that no tool has recorded
  const desk = H('Desktop', 'homeos');
  write(path.join(desk, '.devin', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\n');
  write(path.join(desk, '.cursor', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: l\n---\n');
  const list = knownProjects(proj);
  const k = list.find((p) => p.path.toLowerCase().endsWith('work/kiro-only'));
  assert.ok(k, 'Kiro workspace found');
  assert.deepEqual([k.footprint.mcps, k.footprint.tools], [1, ['kiro']]);
  const d = list.find((p) => p.path.toLowerCase().endsWith('desktop/homeos'));
  assert.ok(d, 'Desktop project with its own skills found');
  assert.equal(d.footprint.skills, 2);
  assert.deepEqual(d.footprint.tools.sort(), ['cursor', 'devin']);
  // Selecting it shows those skills under the right tools
  const inv = inventory(desk, { fresh: true });
  assert.ok(inv.skills.find((s) => s.agent === 'devin' && s.name === 'deploy'));
  assert.ok(inv.skills.find((s) => s.agent === 'cursor' && s.name === 'lint'));
});

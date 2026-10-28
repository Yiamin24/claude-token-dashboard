// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-scan-'));
// Point the home folder at the temp dir so no real AI-tool configs are read.
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, 'AppData');
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
const cfg = path.join(root, 'cfg');
const proj = path.join(root, 'proj');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.TOKEN_DASHBOARD_DATA = path.join(root, 'data');

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
write(path.join(cfg, 'settings.json'), { model: 'x' });
write(path.join(cfg, '.claude.json'), { mcpServers: { alpha: { command: 'node', args: ['a.js'] } }, projects: {} });
write(path.join(cfg, 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: >\n  Writes things\n  very well.\n---\nBody');
write(path.join(proj, '.mcp.json'), { mcpServers: { beta: { type: 'http', url: 'http://localhost:1/mcp' } } });
const pluginRoot = path.join(cfg, 'plugins', 'cache', 'm', 'kit', '1.0.0');
write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), { name: 'kit', description: 'A kit' });
write(path.join(pluginRoot, 'skills', 'plan', 'SKILL.md'), '---\nname: plan\ndescription: "Plans work"\n---\n');
write(path.join(pluginRoot, 'agents', 'helper.md'), '---\nname: helper\ndescription: Helps\n---\n');
write(path.join(cfg, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'kit@m': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] } });

const { parseFrontmatter } = await import('../src/util.js');
const { inventory } = await import('../src/scan.js');
const { setItemState } = await import('../src/toggle.js');

test('front-matter parsing handles folded blocks and quotes', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\n---'), { name: 'a', description: 'one two' });
  assert.equal(parseFrontmatter("---\ndescription: 'it''s'\n---").description, "it's");
  assert.equal(parseFrontmatter('---\ndescription: "say \\"hi\\""\n---').description, 'say "hi"');
});

test('finds MCP servers, skills, plugin skills and agents', () => {
  const inv = inventory(proj, { fresh: true });
  assert.deepEqual(inv.mcps.map((m) => m.name).sort(), ['alpha', 'beta']);
  assert.ok(inv.skills.find((s) => s.displayName === 'writer' && s.description === 'Writes things very well.'));
  assert.ok(inv.skills.find((s) => s.displayName === 'kit:plan'));
  assert.ok(inv.agents.find((a) => a.displayName === 'kit:helper'));
  assert.equal(inv.plugins[0].counts.skills, 1);
  assert.equal(inv.newItems.length, 0, 'first scan is a silent baseline');
});

test('new items are detected after the baseline', () => {
  write(path.join(cfg, 'skills', 'fresh', 'SKILL.md'), '---\nname: fresh\ndescription: New one\n---\n');
  const inv = inventory(proj, { fresh: true });
  assert.ok(inv.newItems.find((n) => n.name === 'fresh'));
  assert.ok(inv.skills.find((s) => s.displayName === 'fresh').isNew);
});

test('switches write Claude Code settings and change the totals', () => {
  const before = inventory(proj, { fresh: true }).totals.savedTokens;
  let r = setItemState({ project: proj, name: 'writer', state: 'off', scope: 'project' });
  assert.ok(r.ok, r.message);
  const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(local.skillOverrides.writer, 'off');
  assert.ok(inventory(proj, { fresh: true }).totals.savedTokens > before);

  r = setItemState({ project: proj, name: 'beta', state: 'off', scope: 'project' });
  assert.ok(r.ok, r.message);
  assert.equal(inventory(proj, { fresh: true }).mcps.find((m) => m.name === 'beta').state, 'off');

  r = setItemState({ project: proj, name: 'kit@m', state: 'off', scope: 'global' });
  assert.ok(r.ok, r.message);
  const user = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.equal(user.enabledPlugins['kit@m'], false);
  assert.equal(user.model, 'x', 'other settings are kept');
  const inv = inventory(proj, { fresh: true });
  assert.equal(inv.skills.find((s) => s.displayName === 'kit:plan').state, 'off');

  r = setItemState({ project: proj, name: 'writer', state: 'on', scope: 'project' });
  assert.ok(r.ok);
  const local2 = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(local2.skillOverrides, undefined, 'empty override map is removed');
});

test('refuses to edit a settings file that is not valid JSON', () => {
  write(path.join(proj, '.claude', 'settings.local.json'), '{ broken');
  const r = (() => { try { return setItemState({ project: proj, name: 'writer', state: 'off', scope: 'project' }); } catch (e) { return { ok: false, message: e.message }; } })();
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'), '{ broken');
});

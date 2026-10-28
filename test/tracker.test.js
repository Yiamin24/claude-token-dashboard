// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-tracker-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'cfg');
process.env.TOKEN_DASHBOARD_DATA = path.join(root, 'data');
const projDir = path.join(root, 'cfg', 'projects', 'p1');
fs.mkdirSync(projDir, { recursive: true });
const file = path.join(projDir, 's1.jsonl');

const line = (id, ts, extra = {}) => JSON.stringify({
  type: 'assistant', cwd: '/work/app', timestamp: new Date(ts).toISOString(),
  message: { id, model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 20 } },
  ...extra,
}) + '\n';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('credits savings once per new main-thread request', async () => {
  // History from before tracking started: counted as usage, never as savings.
  fs.writeFileSync(file, line('old', Date.now() - 3600000));
  const { Tracker } = await import('../src/tracker.js');
  const t = new Tracker({ savingsFor: () => ({ saved: 100, items: [{ id: 'skill:x', saved: 100 }] }) });
  await t.start();
  assert.equal(t.ledger.savedTokens, 0);
  assert.equal(t.usage.total.requests, 1);

  const now = Date.now() + 1000;
  fs.appendFileSync(file, line('a', now) + line('a', now) + line('b', now + 10) + line('c', now + 20, { isSidechain: true }));
  await t.readFile(file);
  await wait(50);
  assert.equal(t.ledger.savedTokens, 200, 'a (deduped) + b, not the subagent request');
  assert.equal(t.ledger.byItem['skill:x'], 200);
  assert.equal(t.usage.total.requests, 4);
  assert.equal(t.usage.total.cacheRead, 4000);

  const snap = t.snapshot('/work/app');
  assert.equal(snap.savings.total, 200);
  assert.equal(snap.savings.project.savedTokens, 200);
  t.stop();
});

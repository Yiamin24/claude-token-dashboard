// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
import path from 'node:path';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.js';

const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULTS = {
  version: 1,
  prefs: { mcpMode: 'auto' }, // auto | deferred | full
  known: {}, // item id -> first-seen ISO time
  newItems: {}, // item id -> { name, kind, firstSeen } (cleared when acknowledged)
  seenProjects: {}, // projKey -> ISO time first scanned
  probes: {}, // mcp config hash -> probe result
  initialized: false,
};

// Several Claude sessions can run this server at once, so always re-read before writing.
export function loadState() {
  const s = readJson(STATE_FILE, null) || {};
  return { ...structuredClone(DEFAULTS), ...s, prefs: { ...DEFAULTS.prefs, ...(s.prefs || {}) } };
}

export function updateState(fn) {
  const s = loadState();
  const r = fn(s);
  writeJsonAtomic(STATE_FILE, s);
  return r;
}

export const STATE_PATH = STATE_FILE;

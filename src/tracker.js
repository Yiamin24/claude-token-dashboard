// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Live token tracker. Tails Claude Code session transcripts (~/.claude/projects/**/*.jsonl),
// totals real API usage, and credits the tokens that switched-off items no longer send.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, PROJECTS_DIR, readJson, writeJsonAtomic, projKey, normProject, log } from './util.js';

const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const BACKFILL_DAYS = 7;
const MINUTES_KEPT = 180;
const CHUNK = 4 * 1024 * 1024;

export function loadLedger() {
  const l = readJson(LEDGER_FILE, null);
  if (l && l.version === 1) return l;
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    savedTokens: 0,
    requests: 0,
    byProject: {}, // projKey -> { path, savedTokens, requests }
    byItem: {}, // item id -> saved tokens
    byDay: {}, // YYYY-MM-DD -> saved tokens
    marks: {}, // transcript file -> last credited timestamp (ms)
  };
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function emptyUsage() {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function addUsage(t, u) {
  t.requests += 1;
  t.input += u.input;
  t.cacheRead += u.cacheRead;
  t.cacheWrite += u.cacheWrite;
  t.output += u.output;
}

export class Tracker extends EventEmitter {
  /** @param {{ savingsFor: (cwd: string) => { saved: number, items: {id:string, saved:number}[] } }} opts */
  constructor({ savingsFor }) {
    super();
    this.savingsFor = savingsFor;
    this.ledger = loadLedger();
    this.startedAtMs = Date.parse(this.ledger.startedAt);
    this.files = new Map(); // file -> { offset, partial, ids:Set, busy, again }
    this.usage = { byProject: {}, byDay: {}, total: emptyUsage() };
    this.minutes = new Map(); // minute epoch -> { requests, input, output, saved }
    this.recent = [];
    this.ready = false;
    this.saveTimer = null;
  }

  async start() {
    const cutoff = Date.now() - BACKFILL_DAYS * 86400000;
    const files = this.listTranscripts().filter((f) => f.mtime >= cutoff).sort((a, b) => a.mtime - b.mtime);
    for (const f of files) await this.readFile(f.file, true);
    this.ready = true;
    this.emit('update');
    log(`tracker ready: ${files.length} recent transcripts read`);
    try {
      this.watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, name) => {
        if (name && String(name).endsWith('.jsonl')) this.readFile(path.join(PROJECTS_DIR, String(name)));
      });
      this.watcher.on('error', () => {});
    } catch (e) {
      log('recursive watch unavailable, polling only:', e.message);
    }
    // Polling backs up fs.watch, which can miss events on some systems.
    this.poll = setInterval(() => {
      const recent = Date.now() - 15 * 60000;
      for (const f of this.listTranscripts()) if (f.mtime >= recent) this.readFile(f.file);
    }, 3000);
  }

  stop() {
    clearInterval(this.poll);
    try { this.watcher?.close(); } catch {}
    this.flush();
  }

  listTranscripts() {
    const out = [];
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4 && e.name !== 'memory' && e.name !== 'tool-results') walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try { out.push({ file: p, mtime: fs.statSync(p).mtimeMs }); } catch {}
        }
      }
    };
    walk(PROJECTS_DIR, 0);
    return out;
  }

  async readFile(file, backfill = false) {
    let st = this.files.get(file);
    if (!st) {
      st = { offset: 0, partial: '', ids: new Set(), busy: false, again: false };
      this.files.set(file, st);
      // A file we skipped at startup (older than the backfill window) starts from its end.
      if (!backfill && this.ready) {
        try {
          const s = fs.statSync(file);
          if (s.birthtimeMs < Date.now() - 60000 && s.mtimeMs < Date.now() - BACKFILL_DAYS * 86400000) st.offset = s.size;
        } catch {}
      }
    }
    if (st.busy) { st.again = true; return; }
    st.busy = true;
    try {
      do {
        st.again = false;
        let size;
        try { size = fs.statSync(file).size; } catch { return; }
        if (size < st.offset) { st.offset = 0; st.partial = ''; }
        if (size === st.offset) continue;
        const fh = await fs.promises.open(file, 'r');
        try {
          while (st.offset < size) {
            const len = Math.min(CHUNK, size - st.offset);
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, st.offset);
            if (!bytesRead) break;
            st.offset += bytesRead;
            const text = st.partial + buf.subarray(0, bytesRead).toString('utf8');
            const lines = text.split('\n');
            st.partial = lines.pop() || '';
            if (st.partial.length > 50 * 1024 * 1024) st.partial = ''; // runaway line guard
            for (const line of lines) this.handleLine(file, st, line);
          }
        } finally {
          await fh.close();
        }
      } while (st.again);
    } finally {
      st.busy = false;
    }
  }

  handleLine(file, st, line) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (j.type !== 'assistant' || !j.message?.usage || !j.message.id) return;
    if (st.ids.has(j.message.id)) return;
    st.ids.add(j.message.id);
    if (j.message.model === '<synthetic>') return;

    const u = j.message.usage;
    const usage = {
      input: u.input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      output: u.output_tokens || 0,
    };
    const ts = Date.parse(j.timestamp) || Date.now();
    const cwd = j.cwd || '';
    const pk = cwd ? projKey(cwd) : 'unknown';

    const proj = (this.usage.byProject[pk] ||= { path: cwd ? normProject(cwd) : 'unknown', ...emptyUsage(), lastTs: 0 });
    addUsage(proj, usage);
    proj.lastTs = Math.max(proj.lastTs, ts);
    addUsage((this.usage.byDay[dayKey(ts)] ||= emptyUsage()), usage);
    addUsage(this.usage.total, usage);

    // Credit savings once per main-thread request made after tracking began.
    let saved = 0;
    const mark = this.ledger.marks[file] ?? this.startedAtMs;
    if (!j.isSidechain && cwd && ts > mark) {
      const s = this.savingsFor(cwd);
      saved = s.saved;
      this.ledger.marks[file] = ts;
      if (saved > 0) {
        this.ledger.savedTokens += saved;
        const lp = (this.ledger.byProject[pk] ||= { path: normProject(cwd), savedTokens: 0, requests: 0 });
        lp.savedTokens += saved;
        lp.requests += 1;
        for (const it of s.items) this.ledger.byItem[it.id] = (this.ledger.byItem[it.id] || 0) + it.saved;
        const dk = dayKey(ts);
        this.ledger.byDay[dk] = (this.ledger.byDay[dk] || 0) + saved;
      }
      this.ledger.requests += 1;
      this.scheduleSave();
    }

    const minute = Math.floor(ts / 60000);
    if (minute >= Math.floor(Date.now() / 60000) - MINUTES_KEPT) {
      const m = this.minutes.get(minute) || { requests: 0, input: 0, output: 0, saved: 0 };
      m.requests += 1;
      m.input += usage.input + usage.cacheRead + usage.cacheWrite;
      m.output += usage.output;
      m.saved += saved;
      this.minutes.set(minute, m);
    }

    if (this.ready || ts > Date.now() - 3600000) {
      this.recent.unshift({
        ts, project: proj.path, model: j.message.model, sidechain: Boolean(j.isSidechain),
        input: usage.input + usage.cacheRead + usage.cacheWrite, cacheRead: usage.cacheRead, output: usage.output, saved,
      });
      if (this.recent.length > 60) this.recent.length = 60;
    }
    if (this.ready) this.emit('update', { live: true, project: pk, saved });
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 1500);
  }

  flush() {
    try { writeJsonAtomic(LEDGER_FILE, this.ledger); } catch (e) { log('could not save ledger:', e.message); }
  }

  resetSavings() {
    const marks = {};
    const now = Date.now();
    for (const f of Object.keys(this.ledger.marks)) marks[f] = now;
    this.ledger = { ...loadLedgerBlank(), marks };
    this.startedAtMs = now;
    this.flush();
    this.emit('update');
  }

  snapshot(project) {
    const now = Math.floor(Date.now() / 60000);
    for (const k of this.minutes.keys()) if (k < now - MINUTES_KEPT) this.minutes.delete(k);
    const series = [];
    for (let m = now - 59; m <= now; m++) series.push({ t: m * 60000, ...(this.minutes.get(m) || { requests: 0, input: 0, output: 0, saved: 0 }) });
    const today = dayKey(Date.now());
    const pk = project ? projKey(project) : null;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const k = dayKey(Date.now() - i * 86400000);
      days.push({ day: k, ...(this.usage.byDay[k] || emptyUsage()), saved: this.ledger.byDay[k] || 0 });
    }
    return {
      ready: this.ready,
      trackingSince: new Date(this.startedAtMs).toISOString(),
      backfillDays: BACKFILL_DAYS,
      savings: {
        total: this.ledger.savedTokens,
        requests: this.ledger.requests,
        today: this.ledger.byDay[today] || 0,
        project: pk ? this.ledger.byProject[pk] || { savedTokens: 0, requests: 0 } : null,
        byItem: this.ledger.byItem,
        byProject: Object.values(this.ledger.byProject).sort((a, b) => b.savedTokens - a.savedTokens).slice(0, 20),
      },
      usage: {
        today: this.usage.byDay[today] || emptyUsage(),
        total: this.usage.total,
        project: pk ? this.usage.byProject[pk] || null : null,
        byProject: Object.values(this.usage.byProject).sort((a, b) => b.lastTs - a.lastTs).slice(0, 20),
        days,
      },
      series,
      recent: this.recent.slice(0, 40),
    };
  }
}

function loadLedgerBlank() {
  return {
    version: 1, startedAt: new Date().toISOString(), savedTokens: 0, requests: 0,
    byProject: {}, byItem: {}, byDay: {}, marks: {},
  };
}

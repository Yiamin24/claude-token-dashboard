#!/usr/bin/env node
// Copyright (c) 2026 Yiamin24. Licensed under the MIT License.
// Claude Token Dashboard: an MCP server (stdio) that also hosts a local web dashboard.
//
//   node server.js               -> MCP server over stdio (what Claude Code runs)
//   node server.js --standalone  -> just the dashboard, opens your browser
//
// Kept to three small tools on purpose: this server costs context tokens too.
import { Dashboard, openBrowser } from './src/web.js';
import { inventory } from './src/scan.js';
import { setItemState } from './src/toggle.js';
import { loadLedger } from './src/tracker.js';
import { plan as autoPlan, apply as autoApply, undo as autoUndo, setTask, CATEGORIES } from './src/auto.js';
import { fmtNum, log } from './src/util.js';

const launchProject = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const isProbe = process.env.TOKEN_DASHBOARD_PROBE === '1';
const dashboard = new Dashboard({ launchProject });

if (process.argv.includes('--standalone')) {
  const r = await dashboard.ensure();
  console.log(r.hosting ? `Dashboard running at ${r.url}` : `Dashboard already running at ${r.url}`);
  if (!process.argv.includes('--no-open')) openBrowser(r.url);
  if (!r.hosting) process.exit(0);
  process.on('SIGINT', () => { dashboard.close(); process.exit(0); });
} else {
  startMcp();
}

function startMcp() {
  const TOOLS = [
    {
      name: 'dashboard',
      description: 'Open the token dashboard: see, switch on/off and measure MCP servers, skills and plugins, with live token savings. Returns its URL.',
      inputSchema: { type: 'object', properties: { open: { type: 'boolean', description: 'Open it in the browser (default true)' } } },
    },
    {
      name: 'context_report',
      description: 'List MCP servers, skills and plugins for this project across AI tools (Claude Code, Codex, Gemini, Cursor...) with estimated token cost, savings and new items.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max rows per section (default 15)' },
          agent: { type: 'string', description: 'Tool id: claude (default), codex, gemini, antigravity, kiro, cursor, vscode, opencode... or all' },
        },
      },
    },
    {
      name: 'context_toggle',
      description: 'Switch an MCP server, skill or plugin on or off, in Claude Code (default) or another AI tool. Applies to new sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name, e.g. "playwright" or "superpowers:brainstorming"' },
          state: { type: 'string', enum: ['on', 'off', 'name-only'], description: 'name-only keeps a skill listed without its description' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Claude Code only. Default project' },
          agent: { type: 'string', description: 'Tool id (default claude), or all to switch it in every tool' },
        },
        required: ['name', 'state'],
      },
    },
    {
      name: 'context_auto',
      description: 'Work out which MCP servers and skills this project and task need, and switch the rest off (preview unless apply is true). Applies to the next session.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the user is working on, e.g. "fix the checkout page" or "reverse engineer this apk". Empty string clears it.' },
          apply: { type: 'boolean', description: 'Make the changes (default false = preview)' },
          undo: { type: 'boolean', description: 'Put back everything auto mode switched here' },
        },
      },
    },
  ];

  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  async function callTool(name, args = {}) {
    if (name === 'dashboard') {
      if (isProbe) return text('Dashboard disabled in probe mode.');
      const r = await dashboard.ensure();
      if (args.open !== false) openBrowser(r.url);
      return text(`Token dashboard: ${r.url}${r.error ? `\n${r.error}` : ''}`);
    }
    if (name === 'context_report') return text(report(Number(args.limit) || 15, args.agent || 'claude'));
    if (name === 'context_toggle') {
      const r = setItemState({ project: launchProject, name: args.name, state: args.state, scope: args.scope || 'project', agent: args.agent || 'claude' });
      return text(r.message, !r.ok);
    }
    if (name === 'context_auto') return text(autoTool(args));
    throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }

  function autoTool({ task, apply, undo }) {
    if (undo) {
      const r = autoUndo(launchProject);
      return r.restored.length ? `Put back ${r.restored.length} item(s): ${r.restored.join(', ')}. Start a new session to load them.` : 'Auto mode had not changed anything in this project.';
    }
    if (typeof task === 'string') setTask(launchProject, task);
    const r = apply ? autoApply(launchProject) : autoPlan(launchProject);
    const lines = [];
    const label = (c) => CATEGORIES[c]?.label || c;
    lines.push(`Project: ${r.project}`);
    if (r.reason) return [...lines, r.reason].join('\n');
    lines.push(`This project needs: ${r.needs.map(label).join(', ')}${r.task ? ` (task: "${r.task.text}")` : ''}.`);
    const ev = Object.entries(r.signals.evidence).slice(0, 5).map(([c, e]) => `${label(c)} (${e.join(', ')})`);
    if (ev.length) lines.push(`Clues: ${ev.join('; ')}.`);
    const list = apply ? r.done : r.changes;
    if (!list.length) lines.push('Nothing to change: what loads already fits.');
    else {
      lines.push(`${apply ? 'Changed' : 'Would change'} ${list.length} item(s), ~${fmtNum(Math.abs(r.savedPerRequest))} tokens/request ${r.savedPerRequest >= 0 ? 'saved' : 'added'}:`);
      for (const c of list) lines.push(`- ${c.name} (${c.kind}): ${c.from} -> ${c.to} · ${c.why}`);
    }
    if (apply && r.failed.length) lines.push(`Could not change: ${r.failed.map((f) => `${f.name} (${f.message})`).join('; ')}`);
    if (r.recommend.length) lines.push(`Other tools (switch there or in the dashboard): ${r.recommend.slice(0, 8).map((x) => `${x.name} in ${x.agent}`).join(', ')}.`);
    lines.push(apply ? 'Start a new Claude Code session in this project to use the new set.' : 'Call again with apply: true to make these changes.');
    return lines.join('\n');
  }

  function report(limit, agent) {
    const inv = inventory(launchProject, { fresh: true });
    const ledger = loadLedger();
    const t = inv.totals;
    const lines = [];
    const pick = (arr) => (agent === 'all' ? arr : arr.filter((x) => x.agent === agent));
    lines.push(`Project: ${inv.project}`);
    lines.push('\nAI tools found:');
    for (const a of inv.tools) {
      lines.push(`- ${a.name} (${a.id}): ${a.mcps.on}/${a.mcps.total} MCP on, ${a.skills.total} skills${a.plugins.total ? `, ${a.plugins.on}/${a.plugins.total} plugins` : ''}, ~${fmtNum(a.activeTokens)} tok/request${a.unmeasuredMcps ? ` (+${a.unmeasuredMcps} MCP not measured)` : ''}`);
    }
    lines.push(`\nShowing: ${agent === 'all' ? 'all tools' : agent}. Claude Code loads ~${fmtNum(t.activeTokens)} tokens each request; switched off: ~${fmtNum(t.savedTokens)} per request.`);
    lines.push(`Saved so far: ${fmtNum(ledger.savedTokens)} tokens over ${fmtNum(ledger.requests)} tracked requests (since ${ledger.startedAt.slice(0, 10)}).`);
    if (t.unmeasuredMcps) lines.push(`${t.unmeasuredMcps} MCP server(s) not measured yet: open the dashboard and click "Measure".`);
    lines.push(`MCP tool schemas counted as: ${inv.mcpMode}.`);
    if (inv.newItems.length) lines.push(`\nNew since last check: ${inv.newItems.map((n) => `${n.name} (${n.kind})`).join(', ')}`);
    const section = (title, items) => {
      lines.push(`\n${title}`);
      for (const it of [...items].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, limit)) {
        const cost = it.kind === 'mcp' && !it.measured ? 'not measured' : `~${fmtNum(it.tokens || 0)} tok`;
        lines.push(`- ${it.displayName} [${it.state}] ${cost} · ${it.sourceLabel}${it.toggleable === false && it.agent !== 'claude' ? ' · read-only' : ''}`);
      }
      if (items.length > limit) lines.push(`  …and ${items.length - limit} more`);
    };
    const mcps = pick(inv.mcps);
    const plugins = pick(inv.plugins);
    section(`MCP servers (${mcps.length})`, mcps);
    section(`Plugins (${plugins.length})`, plugins);
    const ownSkills = pick(inv.skills).filter((s) => !s.plugin && !s.agentPlugin);
    section(`Skills & commands outside plugins (${ownSkills.length})`, ownSkills);
    lines.push(`\nDashboard: ${dashboard.url}`);
    return lines.join('\n');
  }

  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  process.stdin.on('end', () => { dashboard.close(); process.exit(0); });

  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // notification
    try {
      let result;
      if (method === 'initialize') {
        const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
        result = {
          protocolVersion: supported.includes(params?.protocolVersion) ? params.protocolVersion : supported[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'token-dashboard', version: '1.0.0' },
        };
        // Start (or join) the dashboard in the background so it's live as soon as a session opens.
        if (!isProbe) dashboard.ensure().catch((e) => log('dashboard failed to start:', e.message));
      } else if (method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (method === 'tools/call') {
        try { result = await callTool(params?.name, params?.arguments || {}); }
        catch (e) { if (e.code) throw e; result = text(`Error: ${e.message}`, true); }
      } else if (method === 'ping') {
        result = {};
      } else if (method === 'resources/list') {
        result = { resources: [] };
      } else if (method === 'prompts/list') {
        result = { prompts: [] };
      } else {
        return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      write({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
    }
  }
}

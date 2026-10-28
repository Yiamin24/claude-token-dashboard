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
      description: 'List the MCP servers, skills and plugins loaded in this project with their estimated token cost, tokens saved so far, and newly detected items.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max rows per section (default 15)' } } },
    },
    {
      name: 'context_toggle',
      description: 'Switch an MCP server, skill or plugin on or off for this project or all projects. Applies to new Claude Code sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name, e.g. "playwright" or "superpowers:brainstorming"' },
          state: { type: 'string', enum: ['on', 'off', 'name-only'], description: 'name-only keeps a skill listed without its description' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Default project' },
        },
        required: ['name', 'state'],
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
    if (name === 'context_report') return text(report(Number(args.limit) || 15));
    if (name === 'context_toggle') {
      const r = setItemState({ project: launchProject, name: args.name, state: args.state, scope: args.scope || 'project' });
      return text(r.message, !r.ok);
    }
    throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }

  function report(limit) {
    const inv = inventory(launchProject, { fresh: true });
    const ledger = loadLedger();
    const t = inv.totals;
    const lines = [];
    lines.push(`Project: ${inv.project}`);
    lines.push(`Loaded each request: ~${fmtNum(t.activeTokens)} tokens. Switched off: ~${fmtNum(t.savedTokens)} tokens per request.`);
    lines.push(`Saved so far: ${fmtNum(ledger.savedTokens)} tokens over ${fmtNum(ledger.requests)} tracked requests (since ${ledger.startedAt.slice(0, 10)}).`);
    if (t.unmeasuredMcps) lines.push(`${t.unmeasuredMcps} MCP server(s) not measured yet: open the dashboard and click "Measure".`);
    lines.push(`MCP tool schemas counted as: ${inv.mcpMode}.`);
    if (inv.newItems.length) lines.push(`\nNew since last check: ${inv.newItems.map((n) => `${n.name} (${n.kind})`).join(', ')}`);
    const section = (title, items) => {
      lines.push(`\n${title}`);
      for (const it of [...items].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, limit)) {
        const cost = it.kind === 'mcp' && !it.measured ? 'not measured' : `~${fmtNum(it.tokens || 0)} tok`;
        lines.push(`- ${it.displayName} [${it.state}] ${cost} · ${it.sourceLabel}`);
      }
      if (items.length > limit) lines.push(`  …and ${items.length - limit} more`);
    };
    section(`MCP servers (${inv.mcps.length})`, inv.mcps);
    section(`Plugins (${inv.plugins.length})`, inv.plugins);
    const ownSkills = inv.skills.filter((s) => !s.plugin);
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

# Claude Token Dashboard

An MCP server for Claude Code that shows every MCP server, skill, command, agent and plugin on your machine, estimates how many tokens each one adds to every request, and lets you switch them off per project or for all projects. A live tracker reads your Claude Code sessions as they happen and counts the tokens your switched-off items no longer send.

No dependencies. Needs Node.js 20 or newer.

## Add it to Claude Code

### Every project (recommended)

Add it once at user scope and it loads in every project you open:

```sh
# macOS / Linux
claude mcp add --scope user token-dashboard -- npx -y github:Yiamin24/claude-token-dashboard

# Windows
claude mcp add --scope user token-dashboard -- cmd /c npx -y github:Yiamin24/claude-token-dashboard
```

### From a local copy

```sh
git clone https://github.com/Yiamin24/claude-token-dashboard.git
claude mcp add --scope user token-dashboard -- node /full/path/to/claude-token-dashboard/server.js
```

### One project only

Run this inside the project, or leave out `--scope user` from either command above:

```sh
claude mcp add token-dashboard -- npx -y github:Yiamin24/claude-token-dashboard
```

When a Claude Code session starts, the server also starts the dashboard at **http://127.0.0.1:7377/** for the project you're in. Open it yourself, or ask Claude to "open the token dashboard".

To remove it: `claude mcp remove --scope user token-dashboard`

To run only the dashboard, without Claude Code:

```sh
npm start        # node server.js --standalone
```

## What it does

| Area | Details |
|---|---|
| **Detects** | MCP servers from `~/.claude.json` (user and local scope), the project's `.mcp.json` and plugins. Skills from `~/.claude/skills`, `.claude/skills`, claude.ai-synced skills and plugins. Commands, plugin agents, and plugins from `installed_plugins.json`. |
| **New items** | Watches those folders and config files. Anything that appears after the first scan gets a NEW badge, a banner and a count on its tab, until you click "Mark as seen". |
| **Token cost** | Skills: the listing line Claude sees (name plus description, capped at 1,536 characters). Agents: their listing line. MCP servers: click **Measure**. The dashboard starts the server briefly, reads its tool list and server instructions, and counts both. |
| **Switches** | MCP servers use `deniedMcpServers`. Skills use `skillOverrides`, with `on`, `name-only` or `off`. Plugins use `enabledPlugins`. "This project" writes `<project>/.claude/settings.local.json`; "All projects" writes `~/.claude/settings.json`. A backup goes to `~/.claude/token-dashboard/backups/` before every write. |
| **Live tracker** | Tails `~/.claude/projects/**/*.jsonl`. It shows real input, cache and output tokens per minute, per day and per project, and adds the tokens of switched-off items to "saved" for each new main-thread request. |

### MCP schema counting

Claude Code loads MCP tool definitions in one of two ways:

- **full**: every tool's full schema is sent with each request.
- **deferred**: only tool names and server instructions are sent; schemas load when a tool is needed.

Claude Code switches to deferred when MCP tools would fill more than about 10% of the context window. **auto** follows the same rule; you can force either mode from the MCP tab.

## MCP tools (kept small: about 290 tokens)

- `dashboard`: opens the dashboard and returns its URL.
- `context_report`: a text summary of what's loaded, the costs, savings so far and new items.
- `context_toggle`: `{ name, state: on|off|name-only, scope: project|global }`.

## Notes

- Changes apply to **new** Claude Code sessions, not the one already running.
- Token counts are estimates at about 4 characters per token.
- Servers that need OAuth sign-in (for example remote HTTP servers) can't be measured from outside Claude Code. They show "needs sign-in to measure".
- claude.ai connectors added from your claude.ai account aren't stored locally, so they aren't listed.
- Plugin SessionStart hooks can add text to each session. They're flagged on the plugin but not counted.
- Only one dashboard runs per machine. Extra Claude sessions share it, and if the session hosting it closes, another one takes over within about 20 seconds.
- Settings: `TOKEN_DASHBOARD_PORT` (default 7377), `TOKEN_DASHBOARD_DATA` (default `~/.claude/token-dashboard`), `CLAUDE_CONFIG_DIR`.

## Files

```
server.js        MCP stdio server + --standalone entry
src/scan.js      finds items, works out on/off state and token cost, spots new items
src/toggle.js    writes switches to Claude Code settings (with backups)
src/probe.js     measures MCP servers (stdio and HTTP)
src/tracker.js   live transcript tailing and the savings ledger
src/web.js       local HTTP server, live event stream, file watchers
public/index.html  the dashboard
test/            node --test suites (npm test)
```

## License

MIT © 2026 Yiamin24. See [LICENSE](LICENSE).

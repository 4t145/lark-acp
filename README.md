# lark-acp

[![npm](https://img.shields.io/npm/v/feishu-acp)](https://www.npmjs.com/package/feishu-acp)

Use AI coding agents (Copilot, Claude, Codex, Gemini…) directly from Feishu/Lark — no server, no webhook, runs on your machine.

![alt text](image.png)

## How it works

Feishu message → WebSocket long connection → ACP agent subprocess → reply back to Feishu

No public endpoint needed. The bridge runs locally and connects out.

## Requirements

- **Node.js 20+**
- **An ACP-compatible agent** installed and authenticated (e.g. `gh copilot`, `claude`, `gemini`)
- **A Feishu account** — personal or enterprise, created automatically on first run via `lark-cli`

## Quick Start

```bash
npx feishu-acp --agent copilot
```

First run opens an interactive setup to create or connect your Feishu bot.

## Agents

| Preset | Agent |
|---|---|
| `copilot` | GitHub Copilot CLI |
| `claude` | Claude Code |
| `codex` | OpenAI Codex CLI |
| `gemini` | Gemini CLI |
| `opencode` | OpenCode |

```bash
npx lark-acp agents   # list all presets
```

Custom command also works:

```bash
npx lark-acp --agent "npx my-agent --acp"
```

## Options

| Flag | Description | Default |
|---|---|---|
| `--agent <preset\|cmd>` | Agent to run (required) | — |
| `--cwd <dir>` | Working directory for the agent | `process.cwd()` |
| `--setup` | Re-run Feishu bot setup | — |
| `--idle-timeout <min>` | Session idle timeout in minutes (`0` = unlimited) | `1440` |
| `--max-sessions <n>` | Max concurrent user sessions | `10` |
| `--hide-thoughts` | Don't forward agent reasoning to Feishu | — |

## Feishu App Setup

First run handles this automatically via `lark-cli` browser OAuth. To set up manually:

1. [Create a self-built app](https://open.feishu.cn/app) on Feishu Open Platform
2. Enable **Bot** capability
3. Add permissions: `im:message`, `im:message:send_as_bot`, `im:message.react:create`
4. Subscribe to event `im.message.receive_v1` using **long connection** mode
5. Run `npx lark-acp setup` → choose "existing app"

Credentials are saved to `~/.lark-channel/config.json` and auto-loaded on next run.

## Development

```bash
git clone https://github.com/JiaqiZhang-Dev/lark-acp.git
cd lark-acp
npm install
npm run build          # compile TypeScript → dist/
npm run dev            # watch mode
node dist/bin/lark-acp.js --agent copilot
```

## Acknowledgements

Inspired by [wechat-acp](https://github.com/formulahendry/wechat-acp) — the original project that bridges WeChat to ACP agents. lark-acp brings the same idea to Feishu/Lark.

## License

MIT

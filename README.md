# feishu-acp

Bridge Feishu/Lark to any ACP-compatible AI agent — run coding agents from your phone.

## What it does

Send a message to your Feishu bot → it forwards to a local ACP agent (Copilot, Claude, Codex, etc.) → reply comes back to Feishu.

Your agent runs **locally** or on **your own server**. No cloud required.

## Quick start

```sh
npx feishu-acp --agent copilot
```

First run will guide you through Feishu app setup interactively.

## Feishu app setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) → Create a self-built app
2. Add **Bot** capability
3. Add permissions: `im:message`, `im:message:send_as_bot`, `im:message.react:create`
4. Subscribe to event: `im.message.receive_v1` via **long connection**
5. Publish the app and add it to yourself

## Supported agents

| Preset     | Agent                |
|------------|----------------------|
| `copilot`  | GitHub Copilot CLI   |
| `claude`   | Claude Code          |
| `codex`    | OpenAI Codex CLI     |
| `gemini`   | Google Gemini CLI    |
| `opencode` | OpenCode             |

Or pass any custom ACP command:

```sh
feishu-acp --agent "opencode acp" --cwd /path/to/project
```

## Options

```
--agent <preset|command>   Agent to use (required)
--cwd <dir>                Working directory for the agent
--setup                    Re-run credential setup
--idle-timeout <minutes>   Session idle timeout (default: 1440)
--max-sessions <n>         Max concurrent users (default: 10)
--hide-thoughts            Don't forward agent thoughts to Feishu
```

## License

MIT

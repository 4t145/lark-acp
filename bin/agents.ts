/**
 * Built-in ACP agent presets, the user-config patch shape, and helpers
 * to merge them into a single registry.
 *
 * CLI-only: the library (`src/`) never consumes these — keeping them
 * under `bin/` shrinks the public API surface.
 */

export interface AgentPreset {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly description?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Where a registry entry came from. `overridden` means a built-in id
 * whose fields were tweaked via the user's config file.
 */
export type PresetSource = "built-in" | "user" | "overridden";

export interface RegistryEntry {
  readonly preset: AgentPreset;
  readonly source: PresetSource;
}

export type Registry = ReadonlyMap<string, RegistryEntry>;

export interface ResolvedAgent {
  readonly id?: string;
  readonly label?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly source: "preset" | "raw";
}

export const BUILT_IN_AGENTS: Readonly<Record<string, AgentPreset>> = {
  copilot: {
    label: "GitHub Copilot",
    command: "npx",
    args: ["-y", "@github/copilot", "--acp"],
    description: "GitHub Copilot CLI (native --acp)",
  },
  claude: {
    label: "Claude Code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    description: "Claude Code via Zed's ACP adapter (uses local `claude` CLI auth)",
  },
  "claude-agent": {
    label: "Claude Agent SDK",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    description: "Direct Anthropic API via the Claude Agent SDK (needs ANTHROPIC_API_KEY)",
  },
  codex: {
    label: "Codex CLI",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    description: "OpenAI Codex via Zed's ACP adapter",
  },
  gemini: {
    label: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--experimental-acp"],
    description: "Google Gemini CLI (experimental --acp)",
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    description: "OpenCode (assumes `opencode` is on $PATH)",
  },
  mock: {
    label: "Mock Agent",
    command: "lark-acp-mock",
    args: [],
    description:
      "Built-in scripted ACP agent (思考 / 工具调用 / 权限许可 / Markdown)，用于本地端到端调试",
  },
};

/**
 * Partial preset accepted in the user's config file. When `id` matches a
 * built-in, missing fields fall back to the built-in's values — so users
 * can e.g. just add `env` without re-declaring `command`. New ids must
 * supply `command` and `label`.
 */
export interface UserPresetPatch {
  readonly label?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly description?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Merge built-in presets with user patches.
 *
 * @throws when a non-override (new id) entry is missing `command` or `label`.
 */
export function buildRegistry(
  userPatches: Readonly<Record<string, UserPresetPatch>> = {},
): Registry {
  const out = new Map<string, RegistryEntry>();

  for (const [id, preset] of Object.entries(BUILT_IN_AGENTS)) {
    out.set(id, { preset, source: "built-in" });
  }

  for (const [id, patch] of Object.entries(userPatches)) {
    const existing = out.get(id);
    if (existing) {
      out.set(id, {
        preset: mergePatch(existing.preset, patch),
        source: "overridden",
      });
      continue;
    }
    if (!patch.command || !patch.label) {
      throw new Error(
        `agent preset "${id}" is new and must define both \`label\` and \`command\``,
      );
    }
    out.set(id, {
      preset: {
        label: patch.label,
        command: patch.command,
        args: patch.args ?? [],
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.env !== undefined ? { env: patch.env } : {}),
      },
      source: "user",
    });
  }

  return out;
}

function mergePatch(base: AgentPreset, patch: UserPresetPatch): AgentPreset {
  const description = patch.description ?? base.description;
  const env = patch.env ?? base.env;
  return {
    label: patch.label ?? base.label,
    command: patch.command ?? base.command,
    args: patch.args ?? base.args,
    ...(description !== undefined ? { description } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

/**
 * Split a raw `"command arg1 arg2"` string into its parts.
 *
 * @throws when the input has no command token after trimming.
 */
export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (!parts[0]) throw new Error("Agent command cannot be empty");
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Resolve a user-provided agent selection against a registry. Falls
 * back to parsing the input as a raw command string.
 *
 * @throws when the selection is not in the registry and parsing it as
 *         a raw command yields no command token.
 */
export function resolveAgent(agentSelection: string, registry: Registry): ResolvedAgent {
  const entry = registry.get(agentSelection);
  if (entry) {
    return {
      id: agentSelection,
      label: entry.preset.label,
      command: entry.preset.command,
      args: [...entry.preset.args],
      ...(entry.preset.env ? { env: { ...entry.preset.env } } : {}),
      source: "preset",
    };
  }
  const parsed = parseAgentCommand(agentSelection);
  return { command: parsed.command, args: parsed.args, source: "raw" };
}

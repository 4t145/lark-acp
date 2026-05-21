/**
 * Built-in ACP agent presets and lookup helpers.
 *
 * Pure data; no IO. The library itself never reads these — they exist
 * for callers (CLIs, embedding apps) that want a curated list of known
 * agents to expose in their UI.
 */

export interface AgentPreset {
  label: string;
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  copilot: {
    label: "GitHub Copilot",
    command: "npx",
    args: ["@github/copilot", "--acp", "--yolo"],
    description: "GitHub Copilot CLI",
  },
  claude: {
    label: "Claude Code",
    command: "npx",
    args: ["@agentclientprotocol/claude-agent-acp"],
    description: "Claude Code ACP adapter",
  },
  codex: {
    label: "Codex CLI",
    command: "npx",
    args: ["@zed-industries/codex-acp"],
    description: "OpenAI Codex ACP adapter",
  },
  gemini: {
    label: "Gemini CLI",
    command: "npx",
    args: ["@google/gemini-cli", "--experimental-acp"],
    description: "Google Gemini CLI",
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    description: "OpenCode",
  },
};

export interface ResolvedAgent {
  id?: string;
  label?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: "preset" | "raw";
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
 * Resolve a user-provided agent selection against the preset registry.
 * Falls back to parsing the input as a raw command string.
 *
 * @throws when the selection is not a preset and parsing it as a raw
 *         command yields no command token.
 */
export function resolveAgent(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): ResolvedAgent {
  const preset = registry[agentSelection];
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: "preset",
    };
  }
  const parsed = parseAgentCommand(agentSelection);
  return { command: parsed.command, args: parsed.args, source: "raw" };
}

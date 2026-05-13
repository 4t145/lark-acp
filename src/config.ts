/**
 * Configuration types, defaults, and persistence for feishu-acp.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AgentPreset {
  label: string;
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

export interface FeishuAcpConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  agent: {
    preset?: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    showThoughts: boolean;
  };
  session: {
    idleTimeoutMs: number;
    maxConcurrentUsers: number;
  };
  storage: {
    dir: string;
  };
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

export function defaultStorageDir(): string {
  return path.join(os.homedir(), ".feishu-acp");
}

export function defaultConfig(): FeishuAcpConfig {
  return {
    feishu: { appId: "", appSecret: "" },
    agent: {
      preset: undefined,
      command: "",
      args: [],
      cwd: process.cwd(),
      showThoughts: true,
    },
    session: {
      idleTimeoutMs: 1440 * 60_000, // 24h
      maxConcurrentUsers: 10,
    },
    storage: { dir: defaultStorageDir() },
  };
}

export function configFilePath(storageDir: string): string {
  return path.join(storageDir, "config.json");
}

export function loadSavedConfig(storageDir: string): Partial<FeishuAcpConfig> | null {
  const file = configFilePath(storageDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FeishuAcpConfig>;
  } catch {
    return null;
  }
}

export function saveConfig(storageDir: string, config: Partial<FeishuAcpConfig>): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(configFilePath(storageDir), JSON.stringify(config, null, 2), "utf-8");
}

export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (!parts[0]) throw new Error("Agent command cannot be empty");
  return { command: parts[0], args: parts.slice(1) };
}

export function resolveAgent(
  agentSelection: string,
  registry = BUILT_IN_AGENTS,
): { id?: string; label?: string; command: string; args: string[]; env?: Record<string, string>; source: "preset" | "raw" } {
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

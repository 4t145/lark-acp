/** feishu-acp — public API */

export { FeishuAcpBridge } from "./bridge.js";
export type { FeishuAcpConfig, AgentPreset } from "./config.js";
export {
  BUILT_IN_AGENTS,
  defaultConfig,
  resolveAgent,
  parseAgentCommand,
} from "./config.js";

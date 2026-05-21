/**
 * `lark-acp` — bridge a Lark / Feishu bot to any ACP-compatible AI agent.
 *
 * Top-level exports:
 *
 * - {@link LarkBridge} — the orchestrator, instantiated once per process.
 * - {@link LarkLogger}, {@link createPinoLogger} — structured logging.
 * - {@link LarkPresenter}, {@link LarkCardPresenter} — pluggable UI surface.
 * - {@link SessionStore}, {@link FileSessionStore},
 *   {@link PostgresSessionStore} — persistent chat → session mapping.
 */

export { LarkBridge } from "./bridge/bridge.js";
export type {
  LarkBridgeOptions,
  LarkBridgeFeishuOptions,
  LarkBridgeAgentOptions,
  LarkBridgeSessionOptions,
} from "./bridge/bridge.js";

export type { LarkLogger } from "./logger/logger.js";
export { createPinoLogger } from "./logger/logger.js";

export type { LarkPresenter, ToolItem } from "./presenter/presenter.js";
export { LarkCardPresenter } from "./presenter/lark-presenter.js";
export type { LarkCardPresenterOptions } from "./presenter/lark-presenter.js";

export type { SessionStore, SessionRecord } from "./session-store/session-store.js";
export { FileSessionStore } from "./session-store/file-session-store.js";
export { PostgresSessionStore } from "./session-store/postgres-session-store.js";

export { LarkHttpClient } from "./lark/lark-http.js";
export type { LarkHttpOptions } from "./lark/lark-http.js";

export type { AgentPreset, ResolvedAgent } from "./config.js";
export { BUILT_IN_AGENTS, resolveAgent, parseAgentCommand } from "./config.js";
